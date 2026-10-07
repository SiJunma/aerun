package pocketbase

// Category import (Sprint 7 writers, levels L2 and L3).
//
// The fourth writer of the migration, after the role registry, the accounts and
// the characters. It lives in the platform adapter for the same reason: it is the
// only package allowed to import PocketBase, and the rules it encodes are
// properties of the target schema.
//
// Decisions, each of them visible to the caller:
//
//   - **The upsert key is the derived id.** Every write is keyed by
//     DeriveID(SpaceCategory|CategoryGroup, legacyDocID), which the caller already
//     computed. A re-run against a fresher dump converges on the same rows, so a
//     category id referenced by an already-imported topic keeps pointing at the
//     right record.
//   - **Groups are written before categories** inside one transaction, because
//     categories.group_id must resolve the moment it is saved.
//   - **allowed_roles is written as a JSON array, never as the legacy map.** The
//     column is the sole visibility input (ADR-1) and the command layer
//     validates it against the roles registry, so an unknown id there would make
//     the row un-saveable later.
//   - **The cached `last_post_*` / `posts_count` values are not copied.** They are
//     rebuilt by the forum writer from the rows it actually wrote.
//   - A row present in the target but absent from the batch is reported, never
//     deleted: deletion is a separate, human-approved decision.

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// CategoryGroupUpsert is the desired state of one category_groups row.
type CategoryGroupUpsert struct {
	TargetID string
	Title    string
	// SortOrder is the legacy `order`; the target column is sort_order.
	SortOrder int
	CreatedAt string
	UpdatedAt string
}

// CategoryUpsert is the desired state of one categories row.
type CategoryUpsert struct {
	TargetID string
	// GroupID is the referenced group's derived target id, "" for unassigned.
	GroupID      string
	Name         string
	Slug         string
	Description  string
	SortOrder    int
	AllowedRoles []string
	CreatedAt    string
	UpdatedAt    string
}

// CategoryImportReport states what the import changed, so a rehearsal can prove
// idempotency by comparing two reports.
type CategoryImportReport struct {
	GroupsCreated       []string
	GroupsUpdated       []string
	GroupsUnchanged     []string
	CategoriesCreated   []string
	CategoriesUpdated   []string
	CategoriesUnchanged []string
	// ExtraTargetIDs are rows present in the target but absent from this batch.
	// They are never deleted here; they are reported.
	ExtraTargetIDs []string
}

// Changed reports whether the import modified anything.
func (r CategoryImportReport) Changed() bool {
	return len(r.GroupsCreated) > 0 || len(r.GroupsUpdated) > 0 ||
		len(r.CategoriesCreated) > 0 || len(r.CategoriesUpdated) > 0
}

// ImportCategoryGroups makes the category_groups collection match upserts.
func ImportCategoryGroups(app core.App, upserts []CategoryGroupUpsert) (CategoryImportReport, error) {
	report := CategoryImportReport{}
	if len(upserts) == 0 {
		return report, nil
	}
	for _, u := range upserts {
		if u.TargetID == "" {
			return report, fmt.Errorf("category group upsert without a target id")
		}
		if u.Title == "" {
			return report, fmt.Errorf("category group %s: title is required", u.TargetID)
		}
	}

	col, err := app.FindCollectionByNameOrId(categoryGroupsCollectionName)
	if err != nil {
		return report, fmt.Errorf("category_groups collection unavailable: %w", err)
	}

	wanted := make(map[string]CategoryGroupUpsert, len(upserts))
	ids := make([]string, 0, len(upserts))
	for _, u := range upserts {
		wanted[u.TargetID] = u
		ids = append(ids, u.TargetID)
	}
	sort.Strings(ids)

	err = app.RunInTransaction(func(txApp core.App) error {
		rows, err := txApp.FindAllRecords(col, nil)
		if err != nil {
			return fmt.Errorf("read category_groups: %w", err)
		}
		existing := make(map[string]*core.Record, len(rows))
		for _, rec := range rows {
			existing[rec.Id] = rec
		}

		for _, id := range ids {
			u := wanted[id]
			rec, ok := existing[id]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", id)
				applyGroupLabelImport(rec, u.Title)
				rec.Set("sort_order", u.SortOrder)
				setHistoricalDate(rec, "created_at", u.CreatedAt)
				setHistoricalDate(rec, "updated_at", u.UpdatedAt)
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create category group %s: %w", id, err)
				}
				report.GroupsCreated = append(report.GroupsCreated, id)
				continue
			}
			if categoryGroupMatches(rec, u) {
				report.GroupsUnchanged = append(report.GroupsUnchanged, id)
				continue
			}
			applyGroupLabelImport(rec, u.Title)
			rec.Set("sort_order", u.SortOrder)
			setHistoricalDate(rec, "created_at", u.CreatedAt)
			setHistoricalDate(rec, "updated_at", u.UpdatedAt)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update category group %s: %w", id, err)
			}
			report.GroupsUpdated = append(report.GroupsUpdated, id)
		}

		for id := range existing {
			if _, ok := wanted[id]; !ok {
				report.ExtraTargetIDs = append(report.ExtraTargetIDs, id)
			}
		}
		return nil
	})
	if err != nil {
		return CategoryImportReport{}, err
	}

	sort.Strings(report.GroupsCreated)
	sort.Strings(report.GroupsUpdated)
	sort.Strings(report.GroupsUnchanged)
	sort.Strings(report.ExtraTargetIDs)
	return report, nil
}

// applyGroupLabelImport writes the group title and its i18n twin in one place.
// The importer collapses the legacy {en, ru} map to one value, so both languages
// receive it — identical to what the read path would serve from the fallback,
// but written explicitly so a later admin bilingual edit is never paired with a
// stale legacy string (or vice versa) by a re-run.
func applyGroupLabelImport(rec *core.Record, title string) {
	rec.Set("title", title)
	rec.Set("title_i18n", map[string]any{"en": title, "ru": title})
}

func categoryGroupMatches(rec *core.Record, u CategoryGroupUpsert) bool {
	return rec.GetString("title") == u.Title &&
		rec.GetInt("sort_order") == u.SortOrder &&
		historicalDateMatches(rec, "created_at", u.CreatedAt) &&
		historicalDateMatches(rec, "updated_at", u.UpdatedAt)
}

// ImportCategories makes the categories collection match upserts exactly.
//
// A group reference is validated inside the transaction, so a category pointing
// at a group this batch did not write is refused rather than saved with a
// reference to nothing.
func ImportCategories(app core.App, upserts []CategoryUpsert) (CategoryImportReport, error) {
	report := CategoryImportReport{}
	if len(upserts) == 0 {
		return report, nil
	}
	for _, u := range upserts {
		if u.TargetID == "" {
			return report, fmt.Errorf("category upsert without a target id")
		}
		if u.Name == "" {
			return report, fmt.Errorf("category %s: name is required", u.TargetID)
		}
		if u.Slug == "" {
			return report, fmt.Errorf("category %s: slug is required", u.TargetID)
		}
	}

	col, err := app.FindCollectionByNameOrId(categoriesCollectionName)
	if err != nil {
		return report, fmt.Errorf("categories collection unavailable: %w", err)
	}

	wanted := make(map[string]CategoryUpsert, len(upserts))
	ids := make([]string, 0, len(upserts))
	for _, u := range upserts {
		wanted[u.TargetID] = u
		ids = append(ids, u.TargetID)
	}
	sort.Strings(ids)

	err = app.RunInTransaction(func(txApp core.App) error {
		groups := map[string]bool{}
		if groupCol, gerr := txApp.FindCollectionByNameOrId(categoryGroupsCollectionName); gerr == nil {
			rows, err := txApp.FindAllRecords(groupCol, nil)
			if err != nil {
				return fmt.Errorf("read category_groups: %w", err)
			}
			for _, rec := range rows {
				groups[rec.Id] = true
			}
		}

		rows, err := txApp.FindAllRecords(col, nil)
		if err != nil {
			return fmt.Errorf("read categories: %w", err)
		}
		existing := make(map[string]*core.Record, len(rows))
		slugs := make(map[string]string, len(rows))
		for _, rec := range rows {
			existing[rec.Id] = rec
			if s := rec.GetString("slug"); s != "" {
				slugs[s] = rec.Id
			}
		}

		for _, id := range ids {
			u := wanted[id]
			if u.GroupID != "" && !groups[u.GroupID] {
				return fmt.Errorf(
					"category %s: group %q has no row; import the groups first", id, u.GroupID)
			}
			if owner, taken := slugs[u.Slug]; taken && owner != id {
				return fmt.Errorf("category %s: slug %q is already held by %s", id, u.Slug, owner)
			}

			rec, ok := existing[id]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", id)
				applyCategoryUpsert(rec, u)
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create category %s: %w", id, err)
				}
				slugs[u.Slug] = id
				report.CategoriesCreated = append(report.CategoriesCreated, id)
				continue
			}
			if categoryMatches(rec, u) {
				report.CategoriesUnchanged = append(report.CategoriesUnchanged, id)
				continue
			}
			applyCategoryUpsert(rec, u)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update category %s: %w", id, err)
			}
			slugs[u.Slug] = id
			report.CategoriesUpdated = append(report.CategoriesUpdated, id)
		}

		for id := range existing {
			if _, ok := wanted[id]; !ok {
				report.ExtraTargetIDs = append(report.ExtraTargetIDs, id)
			}
		}
		return nil
	})
	if err != nil {
		return CategoryImportReport{}, err
	}

	sort.Strings(report.CategoriesCreated)
	sort.Strings(report.CategoriesUpdated)
	sort.Strings(report.CategoriesUnchanged)
	sort.Strings(report.ExtraTargetIDs)
	return report, nil
}

// applyCategoryUpsert writes the desired state onto a record.
func applyCategoryUpsert(rec *core.Record, u CategoryUpsert) {
	rec.Set("name", u.Name)
	rec.Set("slug", u.Slug)
	rec.Set("description", u.Description)
	// The i18n pair travels WITH the legacy string: the importer collapses the
	// legacy {en, ru} map to one value (collapseLabelMap), and writing both
	// languages here keeps the read path from pairing a freshly imported legacy
	// string with a stale i18n payload an admin had edited earlier. When the
	// match check says "unchanged" this writer is skipped and those admin
	// edits survive untouched.
	rec.Set("name_i18n", map[string]any{"en": u.Name, "ru": u.Name})
	rec.Set("description_i18n", map[string]any{"en": u.Description, "ru": u.Description})
	rec.Set("group_id", u.GroupID)
	rec.Set("sort_order", u.SortOrder)
	// allowed_roles is stored as JSON because the column is a JSONField. The
	// empty list is meaningful (ADR-1: root-only), so it is written as `[]`
	// rather than omitted: a dump should show the row's intent explicitly.
	roles := u.AllowedRoles
	if roles == nil {
		roles = []string{}
	}
	raw, err := json.Marshal(roles)
	if err != nil {
		// A []string always marshals; a failure would be a programming error, and
		// the empty list is the safe direction (root-only).
		raw = []byte("[]")
	}
	rec.Set("allowed_roles", types.JSONRaw(raw))
	// `categories` carries AutodateField columns named created/updated — NOT the
	// plain created_at/updated_at that category_groups and characters use. The
	// legacy documents date a category too, and this is the only place that date
	// can live, so it is written here through SetRaw: an autodate field ignores a
	// typed Set (core/field_autodate.go overwrites it with "now" on create).
	//
	// Verified against v0.40.4 while building this: Set() AND SetRaw() on a
	// non-existent created_at column both leave the value empty, while SetRaw()
	// on `created` survives the Save. Writing to the wrong column name is
	// therefore silent, not loud — which is exactly why the writer names it here.
	setAutodateIfGiven(rec, "created", u.CreatedAt)
	setAutodateIfGiven(rec, "updated", u.UpdatedAt)
}

// categoryMatches compares a stored row with the desired state. The comparison
// happens on the untouched record: applying the upsert first would overwrite the
// very values being compared and every run would report a change.
func categoryMatches(rec *core.Record, u CategoryUpsert) bool {
	roles := decodeRoleIDList(rec.Get("allowed_roles"))
	if len(roles) == 0 {
		roles = nil
	}
	want := u.AllowedRoles
	if len(want) == 0 {
		want = nil
	}
	return rec.GetString("name") == u.Name &&
		rec.GetString("slug") == u.Slug &&
		rec.GetString("description") == u.Description &&
		rec.GetString("group_id") == u.GroupID &&
		rec.GetInt("sort_order") == u.SortOrder &&
		equalStringSlices(roles, want) &&
		autodateMatches(rec, "created", u.CreatedAt) &&
		autodateMatches(rec, "updated", u.UpdatedAt)
}

// setHistoricalDate writes a legacy date onto a plain datetime field.
//
// SetRaw, not Set: these are historical dates the import must be able to write,
// and a typed Set is what PocketBase's date handling rewrites. An empty value
// leaves the field alone, so a row the legacy never dated keeps PocketBase's own
// timestamp instead of being zeroed.
func setHistoricalDate(rec *core.Record, field, value string) {
	if value == "" {
		return
	}
	parsed, err := types.ParseDateTime(value)
	if err != nil {
		return
	}
	rec.SetRaw(field, parsed)
}

// historicalDateMatches compares a stored date with a wanted value, treating an
// empty wanted value as a wildcard for the same reason setHistoricalDate does.
func historicalDateMatches(rec *core.Record, field, want string) bool {
	if want == "" {
		return true
	}
	return rec.GetDateTime(field).String() == want
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
