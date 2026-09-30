package importer

// Legacy categories + category_groups -> target rows (Sprint 7 writers,
// levels L2 and L3 of the dependency map in POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md
// §5).
//
// L2 (category_groups) runs first because L3 references it: categories.group_id
// must point at a group that already exists.
//
// The three decisions that shape this translation, each of them visible in the
// report:
//
//  1. **allowed_roles follows ADR-1 exactly, and identically to migration
//     1767400000.** A legacy `permissions.view_forum` that names roles is copied
//     verbatim; an empty or missing map becomes the FULL sorted list of every
//     role_id the roles import produced. That second branch is what "empty map =
//     public" always meant, and writing the roles out explicitly is what makes
//     the new contract (empty = root-only, ADR-1) safe for imported rows. The
//     sort must match the migration's: two writers disagreeing on order would
//     produce two different byte sequences for the same category.
//
//  2. **A role id the roles import did not produce is a finding, not a silent
//     drop.** categories.allowed_roles is validated against roles.role_id by the
//     command layer, so an unknown id would make the whole category
//     unre-saveable. The offending ids are reported and the row still imports
//     with the resolvable ones, because dropping the category entirely would
//     lose a board section over one stale role reference.
//
//  3. **The legacy {en, ru} label maps collapse to a single string.** The target
//     `title`/`description` are plain text columns and the command layer accepts
//     one string (TASK-2). Russian is preferred, English is the fallback, and
//     every collapse is counted so a reviewer can see how much bilingual text
//     the target schema cannot hold.

import (
	"fmt"
	"sort"
	"strings"
)

// CategoryGroupRow is the target state of one category_groups record.
type CategoryGroupRow struct {
	// LegacyID is the Firestore document id — the DeriveID input.
	LegacyID string
	// TargetID is DeriveID(SpaceCategoryGroup, LegacyID).
	TargetID string
	// Title is the collapsed display title.
	Title     string
	SortOrder int
	CreatedAt string
	UpdatedAt string
	// TitleCode records WHY the title looks the way it does ("label_ru_only",
	// "label_collapsed_ru_wins", …), or "" when nothing was lost. It is kept out
	// of Findings on purpose: it is a decision, not a defect, and mixing the two
	// is what makes a report unreadable.
	TitleCode string
}

// CategoryRow is the target state of one categories record.
type CategoryRow struct {
	LegacyID string
	TargetID string
	// GroupID is the group's derived target id ("" when unassigned or when the
	// referenced group did not import).
	GroupID string
	// Title and Description are the collapsed legacy label maps.
	Title       string
	Description string
	// TitleCode / DescriptionCode / AllowedRolesCode explain each collapse.
	TitleCode        string
	DescriptionCode  string
	AllowedRolesCode string
	// Slug is UNIQUE. Derived from the title; a collision is resolved with a
	// deterministic suffix rather than a random value, so two runs over one
	// export produce the same slug.
	Slug      string
	SortOrder int
	// AllowedRoles is the ADR-1 translation. Never nil: an empty list is the
	// root-only case and must stay distinguishable from "not planned".
	AllowedRoles []string
	CreatedAt    string
	UpdatedAt    string
	// Findings holds only the real problems: an unresolved group reference, a
	// tombstone that lost its text, and so on.
	Findings map[string]string
}

// CategoryPlan is the full result of planning L2 + L3.
type CategoryPlan struct {
	GroupRows    []CategoryGroupRow
	CategoryRows []CategoryRow
	// Findings explains every non-trivial decision, aggregated per code.
	Findings map[string]*Finding
	// SkippedIDs are legacy documents that cannot become rows.
	SkippedGroupIDs    []string
	SkippedCategoryIDs []string
	// RoleIDs is the full set of role ids the roles import produced, sorted. It
	// is what the public-category list is built from and what allowed_roles is
	// validated against.
	RoleIDs []string
}

// BuildCategoryPlan translates the legacy category_groups and categories
// collections into target rows.
//
// roleIDs is the set the roles writer produced (system + custom).
func BuildCategoryPlan(plan *ImportPlan, roleIDs []string) *CategoryPlan {
	cp := &CategoryPlan{
		Findings: map[string]*Finding{},
		RoleIDs:  append([]string(nil), roleIDs...),
	}
	sort.Strings(cp.RoleIDs)

	knownRoles := make(map[string]bool, len(cp.RoleIDs))
	for _, id := range cp.RoleIDs {
		knownRoles[id] = true
	}

	groupExists := map[string]bool{}

	// L2 first: categories reference groups.
	for _, id := range sortedKeys(plan.CategoryGroups) {
		fields := plan.CategoryGroups[id]
		row := CategoryGroupRow{
			LegacyID:  id,
			TargetID:  DeriveID(SpaceCategoryGroup, id),
			CreatedAt: TimestampToISO(timeField(fields, "created_at")),
			UpdatedAt: TimestampToISO(timeField(fields, "updated_at")),
		}
		raw := collapseLabelMap(fields["title"])
		row.Title, row.TitleCode = raw.value, raw.code
		row.SortOrder = numberField(fields, "order")

		if row.Title == "" {
			cp.SkippedGroupIDs = append(cp.SkippedGroupIDs, id)
			cp.note("category_group_title_missing", id)
			continue
		}
		groupExists[id] = true
		cp.GroupRows = append(cp.GroupRows, row)
	}
	sort.Strings(cp.SkippedGroupIDs)

	// Slug collisions are resolved here, over the whole set, because the second
	// category to claim a slug cannot know it until the first is planned.
	usedSlugs := map[string]bool{}
	for _, id := range sortedKeys(plan.Categories) {
		fields := plan.Categories[id]
		row := CategoryRow{
			LegacyID:     id,
			TargetID:     DeriveID(SpaceCategory, id),
			Findings:     map[string]string{},
			AllowedRoles: []string{},
			CreatedAt:    TimestampToISO(timeField(fields, "created_at")),
			UpdatedAt:    TimestampToISO(timeField(fields, "updated_at")),
		}

		title := collapseLabelMap(fields["title"])
		row.Title, row.TitleCode = title.value, title.code
		desc := collapseLabelMap(fields["description"])
		row.Description, row.DescriptionCode = desc.value, desc.code

		if row.Title == "" {
			// categories.name is Required, so a nameless category cannot be
			// written. Reported rather than defaulted to the doc id.
			cp.SkippedCategoryIDs = append(cp.SkippedCategoryIDs, id)
			cp.note("category_title_missing", id)
			continue
		}

		row.SortOrder = numberField(fields, "order")

		groupRef := strings.TrimSpace(stringField(fields, "group_id"))
		switch {
		case groupRef == "":
		case !groupExists[groupRef]:
			// A dangling group_id would render the category "unassigned" while
			// carrying a reference to nothing; the admin board filters by it.
			row.Findings["group_id_unresolved"] = groupRef
			cp.note("category_group_reference_unresolved", id+"->"+groupRef)
		default:
			row.GroupID = DeriveID(SpaceCategoryGroup, groupRef)
		}

		row.Slug = uniqueSlug(slugify(row.Title, id), usedSlugs)
		if raw := fields["permissions"]; raw != nil {
			row.AllowedRoles, row.AllowedRolesCode = translateAllowedRoles(
				raw, cp.RoleIDs, knownRoles, id, cp)
		} else {
			row.AllowedRoles = append([]string(nil), cp.RoleIDs...)
			row.AllowedRolesCode = "public_no_permissions_map"
		}
		if len(row.AllowedRoles) == 0 {
			// A category whose only named role did not import ends up
			// root-only. That is the fail-closed direction, but it is a silent
			// visibility change, so it is reported.
			cp.note("category_imported_root_only", id)
		}

		cp.CategoryRows = append(cp.CategoryRows, row)
	}
	sort.Strings(cp.SkippedCategoryIDs)

	cp.summarizeRows()
	return cp
}

// translateAllowedRoles applies the ADR-1 mapping: a named list is copied
// verbatim, an empty map means the full public list.
//
// The returned code describes the branch in the per-row findings, so a reviewer
// can tell "public because the legacy map was empty" apart from "restricted to
// the roles the legacy map named".
func translateAllowedRoles(raw any, allRoles []string, knownRoles map[string]bool, categoryID string, cp *CategoryPlan) ([]string, string) {
	named := legacyViewForumRoles(raw)
	if len(named) == 0 {
		return append([]string(nil), allRoles...), "public_empty_or_missing_map"
	}

	resolved := make([]string, 0, len(named))
	var unknown []string
	for _, roleID := range named {
		if knownRoles[roleID] {
			resolved = append(resolved, roleID)
			continue
		}
		unknown = append(unknown, roleID)
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		cp.note("category_allowed_role_unknown", categoryID+"="+strings.Join(unknown, ","))
	}
	return resolved, "restricted_verbatim"
}

// legacyViewForumRoles reads permissions.view_forum out of the legacy map. The
// exporter decodes nested maps into map[string]any, and the value arrives as
// []any.
func legacyViewForumRoles(raw any) []string {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	return stringSliceField(m, "view_forum")
}

// collapsedLabel is the result of collapsing a legacy {en, ru} label map.
type collapsedLabel struct {
	value string
	// code is the finding code when something was lost, "" otherwise.
	code string
}

// collapseLabelMap reduces the legacy bilingual label to the single string the
// target stores. Russian wins because the board renders Russian by default;
// English is the fallback so a label that only exists in one language is not
// lost. A two-language label records the loss so the report accounts for it.
func collapseLabelMap(raw any) collapsedLabel {
	switch v := raw.(type) {
	case nil:
		return collapsedLabel{}
	case string:
		if strings.TrimSpace(v) == "" {
			return collapsedLabel{}
		}
		return collapsedLabel{value: strings.TrimSpace(v)}
	case map[string]any:
		ru := strings.TrimSpace(asString(v["ru"]))
		en := strings.TrimSpace(asString(v["en"]))
		switch {
		case ru != "" && en != "":
			return collapsedLabel{value: ru, code: "label_collapsed_ru_wins"}
		case ru != "":
			return collapsedLabel{value: ru, code: "label_ru_only"}
		case en != "":
			return collapsedLabel{value: en, code: "label_en_only"}
		default:
			return collapsedLabel{}
		}
	default:
		return collapsedLabel{value: strings.TrimSpace(stringField(map[string]any{"v": v}, "v"))}
	}
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

// slugify reduces a title to the lowercase [a-z0-9-] alphabet the categories
// slug column accepts. Non-latin titles yield the derived record id, which is
// a stable key — slug is NOT NULL, so it can never be empty.
func slugify(title, fallback string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(title) {
		for _, c := range slugChars(r) {
			if c == '-' {
				if lastDash || b.Len() == 0 {
					continue
				}
				lastDash = true
			} else {
				lastDash = false
			}
			if b.Len() >= 100 {
				break
			}
			b.WriteRune(c)
		}
	}
	if slug := strings.Trim(b.String(), "-"); slug != "" {
		return slug
	}
	return DeriveID(SpaceCategory, fallback)
}

// slugChars maps one rune onto its slug characters. The Cyrillic table is
// explicit rather than positional: a positional table is off by one the moment
// ё is special-cased, and it fails silently — a wrong slug, not a build error.
func slugChars(r rune) string {
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
	case 'ъ', 'ь':
		return ""
	case 'ы':
		return "y"
	case 'ю':
		return "yu"
	case 'я':
		return "ya"
	default:
		return "-"
	}
}

// uniqueSlug claims a slug, appending a counter when it is already taken. The
// counter is deterministic: the importer is re-run against fresher dumps, and a
// random suffix would make every run produce a different slug for the same
// category.
func uniqueSlug(base string, used map[string]bool) string {
	if base == "" {
		return ""
	}
	if !used[base] {
		used[base] = true
		return base
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s-%d", base, n)
		if !used[candidate] {
			used[candidate] = true
			return candidate
		}
	}
}

func (cp *CategoryPlan) note(code, detail string) {
	if existing, ok := cp.Findings[code]; ok {
		existing.Count++
		return
	}
	cp.Findings[code] = &Finding{Code: code, Count: 1, Examples: []string{detail}}
}

// summarizeRows folds the per-row outcomes into the plan-level report.
//
// Both sources are counted: the *decisions* (which language won a collapsed
// label, which branch of the ADR-1 mapping applied) and the *findings* (a
// dangling reference, an unknown role). They share one report because the reader
// of a rehearsal wants one list of "what happened to my data", and separating a
// decision from a defect is what makes such a report unreadable — but the row
// keeps them apart, so a program can still tell them apart.
func (cp *CategoryPlan) summarizeRows() {
	for _, g := range cp.GroupRows {
		if g.TitleCode != "" {
			cp.note(g.TitleCode, g.LegacyID)
		}
	}
	for _, c := range cp.CategoryRows {
		if c.TitleCode != "" {
			cp.note(c.TitleCode, c.LegacyID)
		}
		if c.DescriptionCode != "" {
			cp.note(c.DescriptionCode, c.LegacyID)
		}
		if c.AllowedRolesCode != "" {
			cp.note(c.AllowedRolesCode, c.LegacyID)
		}
		for code, detail := range c.Findings {
			cp.note(code, detail)
		}
	}
}

// Selected is the number of rows this run would write.
func (cp *CategoryPlan) Selected() int { return len(cp.GroupRows) + len(cp.CategoryRows) }

// SortedFindingLines renders the plan findings as stable "code: count" lines.
func (cp *CategoryPlan) SortedFindingLines() []string {
	lines := make([]string, 0, len(cp.Findings))
	for code, f := range cp.Findings {
		line := fmt.Sprintf("%s: %d", code, f.Count)
		if len(f.Examples) > 0 {
			line += fmt.Sprintf(" [%s]", strings.Join(f.Examples, " "))
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return lines
}

// SortedRowLines renders the planned rows as stable one-line summaries. The
// allowed_roles list is printed in full: it is the one field whose content
// decides who can see a board section, so a reviewer must be able to read it.
func (cp *CategoryPlan) SortedRowLines() []string {
	lines := make([]string, 0, cp.Selected())
	for _, g := range cp.GroupRows {
		lines = append(lines, fmt.Sprintf(
			"category_group %s -> %s title=%q order=%d", g.LegacyID, g.TargetID, g.Title, g.SortOrder))
	}
	for _, c := range cp.CategoryRows {
		lines = append(lines, fmt.Sprintf(
			"category %s -> %s slug=%q group=%s order=%d allowed_roles=%s",
			c.LegacyID, c.TargetID, c.Slug, c.GroupID, c.SortOrder, strings.Join(c.AllowedRoles, ",")))
	}
	sort.Strings(lines)
	return lines
}
