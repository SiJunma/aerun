package pocketbase

// Category and category-group management commands.
//
// Why this file exists: the admin Categories tab has been dead since the
// backend cutover. `src/api/categories.js` still called
// `pb.collection('categories').create(...)` and the same for `category_groups`,
// and both collections are server-only — PocketBase refuses those writes with
// "Only superusers can..." before any field is looked at. `manage_categories`
// existed in the compiled permission matrix with no command implementing it.
//
// Everything here follows the same shape as catalog_roles.go: read the body
// with readBodyLimited, resolve the idempotency claim, do all work inside one
// runCommand transaction (domain write + audit row), and answer through
// writeCommandResult so a replayed key returns the stored bytes.
//
// Two contract decisions worth stating:
//
//   - slug is server-derived. The client cannot pick it: it is the UNIQUE
//     business key, and two admins creating "General Discussion" would otherwise
//     race on a shared name. The client may send one; it is ignored.
//   - allowed_roles is validated against the roles registry, not against the
//     compiled matrix. Custom roles are first-class rows (ADR-2, §3.2), and a
//     category may name one directly — that is exactly how "Скрытые игры" works
//     in the legacy data. An empty array is legal and means root-only (ADR-1).

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/pocketbase/pocketbase/tools/security"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const (
	categoryGroupBodyLimit    = 8 * 1024
	categoryBodyLimit         = 64 * 1024
	categoryNameMaxLen        = 128
	categoryDescriptionMaxLen = 1024
	categoryGroupTitleMaxLen  = 128
	// slugMaxLen mirrors the categories.slug column width (1766100000) so a
	// derived slug can never be rejected by the field validator after the
	// command already accepted the name.
	slugMaxLen = 128
	// recordIDAlphabet is the character set every PocketBase record id accepts
	// (`^[a-z0-9]{15}$` on the collection). security.RandomString defaults to a
	// mixed-case alphabet and its output is refused by the column, so any
	// hand-assigned id must spell the alphabet out.
	recordIDAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	// recordIDLength mirrors the id column's Min/Max (15).
	recordIDLength = 15
)

// categoryRecordPayload is the shape every category answer uses, so the list,
// the create response and the update response cannot drift apart.
func categoryRecordPayload(r *core.Record) map[string]any {
	roles := decodeRoleIDList(r.Get("allowed_roles"))
	if roles == nil {
		roles = []string{}
	}
	return map[string]any{
		"id":            r.Id,
		"name":          r.GetString("name"),
		"slug":          r.GetString("slug"),
		"description":   r.GetString("description"),
		"group_id":      r.GetString("group_id"),
		"sort_order":    r.GetInt("sort_order"),
		"allowed_roles": roles,
		"created":       r.GetDateTime("created").String(),
		"updated":       r.GetDateTime("updated").String(),
	}
}

func categoryGroupPayload(r *core.Record) map[string]any {
	return map[string]any{
		"id":         r.Id,
		"title":      r.GetString("title"),
		"sort_order": r.GetInt("sort_order"),
		"created":    r.GetDateTime("created").String(),
		"updated":    r.GetDateTime("updated").String(),
	}
}

// ---------------------------------------------------------------------------
// Category groups
// ---------------------------------------------------------------------------

type categoryGroupForm struct {
	Title     string `json:"title"`
	SortOrder *int   `json:"sort_order"`
}

// createCategoryGroupHandler adds a group. sort_order defaults to max+1 so the
// admin UI does not have to know the current tail of the list.
func createCategoryGroupHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	raw, err := readBodyLimited(e, categoryGroupBodyLimit)
	if err != nil {
		return err
	}
	var form categoryGroupForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed category group payload")
	}

	title := strings.TrimSpace(form.Title)
	if title == "" || len(title) > categoryGroupTitleMaxLen {
		return validationError("category group title is required and must not exceed 128 characters")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		col, err := txApp.FindCollectionByNameOrId(categoryGroupsCollectionName)
		if err != nil {
			return 0, nil, internalError("category_groups collection unavailable", err)
		}

		rec := core.NewRecord(col)
		rec.Set("title", title)
		rec.Set("sort_order", nextGroupSortOrder(txApp, form.SortOrder))
		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to create category group", err)
		}

		if err := recordAuditLog(txApp, "category_group_created", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"title":     title,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusCreated, categoryGroupPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// updateCategoryGroupHandler applies a partial update (title and/or sort_order).
func updateCategoryGroupHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	if id == "" {
		return validationError("category group identifier is required")
	}

	raw, err := readBodyLimited(e, categoryGroupBodyLimit)
	if err != nil {
		return err
	}
	var form categoryGroupForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed category group payload")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(categoryGroupsCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("category group not found")
		}

		// A field absent from the payload is left alone: this is a PATCH, and
		// "title omitted" must not blank the title.
		if form.Title != "" {
			title := strings.TrimSpace(form.Title)
			if len(title) > categoryGroupTitleMaxLen {
				return 0, nil, validationError("category group title must not exceed 128 characters")
			}
			rec.Set("title", title)
		}
		if form.SortOrder != nil {
			rec.Set("sort_order", *form.SortOrder)
		}

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to update category group", err)
		}

		if err := recordAuditLog(txApp, "category_group_updated", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"title":     rec.GetString("title"),
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, categoryGroupPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// deleteCategoryGroupHandler refuses while categories still point at the group.
// Deleting it anyway would leave those rows with a dangling group_id that the
// admin board renders as "unassigned" — a silent regrouping, not an error.
func deleteCategoryGroupHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	if id == "" {
		return validationError("category group identifier is required")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(categoryGroupsCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("category group not found")
		}

		count, err := txApp.CountRecords(categoriesCollectionName, dbx.HashExp{"group_id": rec.Id})
		if err != nil {
			return 0, nil, internalError("failed to count categories in group", err)
		}
		if count > 0 {
			return 0, nil, conflictError("move the categories out of this group before deleting it")
		}

		targetID := rec.Id
		if err := txApp.Delete(rec); err != nil {
			return 0, nil, internalError("failed to delete category group", err)
		}

		if err := recordAuditLog(txApp, "category_group_deleted", e.Auth.Id, map[string]any{
			"target_id": targetID,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{"ok": true, "target_id": targetID}, nil
	})
	return writeCommandResult(e, outcome, err)
}

func nextGroupSortOrder(app core.App, provided *int) int {
	if provided != nil {
		return *provided
	}
	var result struct {
		MaxOrder int `db:"max_order"`
	}
	if err := app.DB().NewQuery(
		"SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_order FROM category_groups",
	).One(&result); err != nil {
		return 0
	}
	return result.MaxOrder
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

type categoryForm struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	GroupID      *string  `json:"group_id"`
	SortOrder    *int     `json:"sort_order"`
	AllowedRoles []string `json:"allowed_roles"`
}

func createCategoryHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	raw, err := readBodyLimited(e, categoryBodyLimit)
	if err != nil {
		return err
	}
	var form categoryForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed category payload")
	}

	name := strings.TrimSpace(form.Name)
	if name == "" || len(name) > categoryNameMaxLen {
		return validationError("category name is required and must not exceed 128 characters")
	}
	description := strings.TrimSpace(form.Description)
	if len(description) > categoryDescriptionMaxLen {
		return validationError("category description must not exceed 1024 characters")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		col, err := txApp.FindCollectionByNameOrId(categoriesCollectionName)
		if err != nil {
			return 0, nil, internalError("categories collection unavailable", err)
		}

		roles, err := validateAllowedRoles(txApp, form.AllowedRoles)
		if err != nil {
			return 0, nil, err
		}

		groupID, err := normalizeGroupReference(txApp, form.GroupID)
		if err != nil {
			return 0, nil, err
		}

		// A category with no group is INVISIBLE, not merely unstyled.
		//
		// The forum index renders categories strictly inside their group
		// (`groups.filter(g => cats.some(c => c.group_id === g.id))`), so a
		// group_id of "" matches no group and the row is never drawn. The
		// empty-state check counts categories, not rendered rows, so when EVERY
		// category is ungrouped the index shows neither the list nor the "no
		// categories" message — a blank page and no clue why.
		//
		// Creating one is therefore refused outright. The admin must create a
		// group first, then place the category inside it.
		if groupID == "" {
			return 0, nil, validationError("category must belong to a category group: create a group first, then pick it for this category")
		}

		rec := core.NewRecord(col)
		// The record id is assigned here rather than by PocketBase so the slug
		// can fall back to it for a name that has no latin equivalent at all
		// (the column is NOT NULL and UNIQUE, so an empty slug cannot save).
		//
		// The alphabet is explicit: categories.id is `^[a-z0-9]{15}$`, and
		// security.RandomString defaults to a mixed-case alphabet, which the
		// column rejects with "id: Invalid value format" — a 500 that reads like
		// a server fault while it is really a charset mismatch.
		rec.Set("id", security.RandomStringWithAlphabet(recordIDLength, recordIDAlphabet))
		rec.Set("name", name)
		rec.Set("description", description)
		rec.Set("group_id", groupID)
		if form.SortOrder != nil {
			rec.Set("sort_order", *form.SortOrder)
		}
		// The client slug is ignored on purpose: it is the UNIQUE key and the
		// server is the only party that can decide a collision answer.
		slug := slugifyCategoryName(name)
		if slug == "" {
			slug = rec.Id
		}
		rec.Set("slug", slug)
		rec.Set("allowed_roles", roles)

		if err := txApp.Save(rec); err != nil {
			return 0, nil, mapSlugConflict(err)
		}

		if err := recordAuditLog(txApp, "category_created", e.Auth.Id, map[string]any{
			"target_id":     rec.Id,
			"slug":          rec.GetString("slug"),
			"name":          name,
			"allowed_roles": roles,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusCreated, categoryRecordPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

func updateCategoryHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	if id == "" {
		return validationError("category identifier is required")
	}

	raw, err := readBodyLimited(e, categoryBodyLimit)
	if err != nil {
		return err
	}
	var form categoryForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed category payload")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(categoriesCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("category not found")
		}

		if form.Name != "" {
			name := strings.TrimSpace(form.Name)
			if len(name) > categoryNameMaxLen {
				return 0, nil, validationError("category name must not exceed 128 characters")
			}
			rec.Set("name", name)
			// slug is immutable after creation: it is part of the URL contract
			// the frontend resolves, so a rename must not move the category.
		}
		if form.Description != "" {
			description := strings.TrimSpace(form.Description)
			if len(description) > categoryDescriptionMaxLen {
				return 0, nil, validationError("category description must not exceed 1024 characters")
			}
			rec.Set("description", description)
		}
		if form.GroupID != nil {
			groupID, err := normalizeGroupReference(txApp, form.GroupID)
			if err != nil {
				return 0, nil, err
			}
			rec.Set("group_id", groupID)
		}
		if form.SortOrder != nil {
			rec.Set("sort_order", *form.SortOrder)
		}
		// AllowedRoles is a pointer-like distinction on purpose: `[]` is a real
		// instruction (root-only, ADR-1) while an absent key means "leave the
		// current list alone". json.Unmarshal leaves the field nil for absent and
		// non-nil for `[]`, so the check below separates them correctly.
		if form.AllowedRoles != nil {
			roles, err := validateAllowedRoles(txApp, form.AllowedRoles)
			if err != nil {
				return 0, nil, err
			}
			rec.Set("allowed_roles", roles)
		}

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to update category", err)
		}

		if err := recordAuditLog(txApp, "category_updated", e.Auth.Id, map[string]any{
			"target_id":     rec.Id,
			"name":          rec.GetString("name"),
			"allowed_roles": decodeRoleIDList(rec.Get("allowed_roles")),
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, categoryRecordPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// deleteCategoryHandler refuses while topics reference the category (ADR-7).
// The topics move command already exists, so the refusal is actionable: the
// operator moves them first.
func deleteCategoryHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	if id == "" {
		return validationError("category identifier is required")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(categoriesCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("category not found")
		}

		// Soft-deleted topics are excluded: they are tombstones kept for the
		// sequence space and never rendered, so they must not block an admin
		// from removing an empty section forever.
		count, err := txApp.CountRecords(topicsCollectionName, dbx.HashExp{
			"category_id": rec.Id,
		})
		if err != nil {
			return 0, nil, internalError("failed to count topics in category", err)
		}
		if count > 0 {
			return 0, nil, conflictError("move the topics out of this category before deleting it")
		}

		targetID := rec.Id
		slug := rec.GetString("slug")
		if err := txApp.Delete(rec); err != nil {
			return 0, nil, internalError("failed to delete category", err)
		}

		if err := recordAuditLog(txApp, "category_deleted", e.Auth.Id, map[string]any{
			"target_id": targetID,
			"slug":      slug,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{"ok": true, "target_id": targetID}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// validateAllowedRoles checks every element against the roles registry and
// removes duplicates. An unknown id is a 400 naming the offenders rather than a
// silently ignored entry: a category that quietly loses one role is a visibility
// bug nobody can see from the UI.
// The inherit marker is exempt from the registry check — it is not a role, it
// is a control value, and canViewCategory resolves it before any lookup. It
// must be the ONLY entry: a marker alongside real ids would mean "inherit AND
// restrict", which the reader cannot honour without silently dropping one of
// the two, so it is rejected as a 400 rather than resolved by guessing.
func validateAllowedRoles(app core.App, input []string) ([]string, error) {
	seen := make(map[string]bool, len(input))
	cleaned := make([]string, 0, len(input))
	for _, value := range input {
		roleID := strings.TrimSpace(value)
		if roleID == "" || seen[roleID] {
			continue
		}
		seen[roleID] = true
		cleaned = append(cleaned, roleID)
	}
	if len(cleaned) == 0 {
		return []string{}, nil
	}

	if slices.Contains(cleaned, auth.CategoryInheritMarker) {
		if len(cleaned) > 1 {
			return nil, validationError(
				"the inherit marker cannot be combined with explicit roles: a category either follows the global role settings or names the roles that may read it",
			)
		}
		return cleaned, nil
	}

	records, err := app.FindAllRecords(rolesCollectionName, nil)
	if err != nil {
		return nil, internalError("roles collection unavailable", err)
	}
	known := make(map[string]bool, len(records))
	for _, rec := range records {
		known[rec.GetString("role_id")] = true
	}

	var unknown []string
	for _, roleID := range cleaned {
		if !known[roleID] {
			unknown = append(unknown, roleID)
		}
	}
	if len(unknown) > 0 {
		return nil, validationError("unknown role_id(s): " + strings.Join(unknown, ", "))
	}
	return cleaned, nil
}

// normalizeGroupReference validates the optional group reference. "unassigned"
// is a UI sentinel from the admin board (the pseudo-group shown for rows with
// no group), not an id; accepting it verbatim would create a reference to
// nothing and the row would render as unassigned anyway, but through a dangling
// value instead of a clean empty one.
func normalizeGroupReference(app core.App, groupID *string) (string, error) {
	if groupID == nil {
		return "", nil
	}
	trimmed := strings.TrimSpace(*groupID)
	if trimmed == "" || trimmed == "unassigned" {
		return "", nil
	}
	if _, err := app.FindRecordById(categoryGroupsCollectionName, trimmed); err != nil {
		return "", validationError("group_id does not reference an existing category group")
	}
	return trimmed, nil
}

// slugifyCategoryName derives the UNIQUE slug from the display name. Cyrillic
// names transliterate, because a slug may only contain a-z0-9-; anything that
// survives no rule at all yields an empty string, and the create handler then
// falls back to the record id.
func slugifyCategoryName(name string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(name) {
		for _, c := range slugRunes(r) {
			if c == '-' {
				// Collapse runs and trim the edges: "--section--" is not a
				// different category from "section" as far as a reader is
				// concerned, and two spellings of one key is how a UNIQUE index
				// surprises people.
				if lastDash || b.Len() == 0 {
					continue
				}
				lastDash = true
			} else {
				lastDash = false
			}
			if b.Len() >= slugMaxLen {
				break
			}
			b.WriteRune(c)
		}
	}
	return strings.Trim(b.String(), "-")
}

// slugRunes maps one input rune onto its slug characters. The Cyrillic table is
// explicit rather than a positional string: a positional table is off by one the
// moment ё is special-cased, and it fails silently — a wrong slug, not a build
// error. Every letter a Russian category title can contain is listed; anything
// else becomes a separator, which is legal and readable.
func slugRunes(r rune) string {
	switch r {
	case 'a', 'b', 'v', 'g', 'd', 'e', 'z', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
		'r', 's', 't', 'u', 'f', 'h', 'c', 'w', 'y', 'q', 'x', '0', '1', '2', '3',
		'4', '5', '6', '7', '8', '9':
		return string(r)
	case 'а':
		return "a"
	case 'б':
		return "b"
	case 'в':
		return "v"
	case 'г':
		return "g"
	case 'д':
		return "d"
	case 'е', 'ё', 'э':
		return "e"
	case 'ж':
		return "zh"
	case 'з':
		return "z"
	case 'и', 'й':
		return "i"
	case 'к':
		return "k"
	case 'л':
		return "l"
	case 'м':
		return "m"
	case 'н':
		return "n"
	case 'о':
		return "o"
	case 'п':
		return "p"
	case 'р':
		return "r"
	case 'с':
		return "s"
	case 'т':
		return "t"
	case 'у':
		return "u"
	case 'ф':
		return "f"
	case 'х':
		return "h"
	case 'ц':
		return "c"
	case 'ч':
		return "ch"
	case 'ш':
		return "sh"
	case 'щ':
		return "sch"
	case 'ъ':
		return ""
	case 'ы':
		return "y"
	case 'ь':
		return ""
	case 'ю':
		return "yu"
	case 'я':
		return "ya"
	default:
		return "-"
	}
}

// mapSlugConflict turns the UNIQUE index violation on categories.slug into the
// contract's 409. Letting PocketBase surface it raw would answer 400 "must be
// unique", which tells the admin the NAME is wrong when the real answer is "a
// category with that slug already exists" — and the name is often legitimately
// reused with a different suffix.
func mapSlugConflict(err error) error {
	message := err.Error()
	if strings.Contains(message, "UNIQUE constraint failed") ||
		strings.Contains(message, "validation_not_unique") ||
		strings.Contains(message, "must be unique") {
		return conflictError("a category with this slug already exists")
	}
	return internalError("failed to create category", err)
}
