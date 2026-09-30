package importer

// Tests for the L2/L3 category plan.
//
// The rule under test is the ADR-1 translation, because getting it wrong does not
// crash: it publishes a board section. "Empty map = public" has to become an
// explicit full role list, and a named map has to be copied verbatim or the
// section loses its audience.

import (
	"testing"
	"time"
)

func categoryPlanFixture() (*ImportPlan, []string) {
	plan := &ImportPlan{
		CategoryGroups: map[string]map[string]any{},
		Categories:     map[string]map[string]any{},
	}
	plan.CategoryGroups["grp1"] = map[string]any{
		"title":      map[string]any{"en": "Lore", "ru": "Лор"},
		"order":      float64(3),
		"created_at": time.Unix(1700000000, 0).UTC(),
	}
	plan.CategoryGroups["grp2"] = map[string]any{
		"title": map[string]any{"en": "English only"},
		"order": float64(1),
	}
	return plan, []string{"admin", "guest", "moderator", "player", "root"}
}

func findCategoryRow(t *testing.T, cp *CategoryPlan, legacyID string) CategoryRow {
	t.Helper()
	for _, row := range cp.CategoryRows {
		if row.LegacyID == legacyID {
			return row
		}
	}
	t.Fatalf("category %s was not planned", legacyID)
	return CategoryRow{}
}

// TestCategoryAllowedRolesTranslation pins both branches of the ADR-1 mapping.
func TestCategoryAllowedRolesTranslation(t *testing.T) {
	plan, roleIDs := categoryPlanFixture()
	plan.Categories["restricted"] = map[string]any{
		"title":       map[string]any{"ru": "Скрытые игры"},
		"description": map[string]any{"en": "Hidden games"},
		"order":       float64(2),
		"permissions": map[string]any{"view_forum": []any{"admin", "PYaDjGY5XvWHNEjTswuz"}},
	}
	plan.Categories["public"] = map[string]any{
		"title":       map[string]any{"ru": "Общий"},
		"permissions": map[string]any{"view_forum": []any{}},
	}
	plan.Categories["nomap"] = map[string]any{
		"title": map[string]any{"ru": "Без карты"},
	}

	cp := BuildCategoryPlan(plan, roleIDs)

	restricted := findCategoryRow(t, cp, "restricted")
	// The custom role id is NOT in this fixture's registry, so it must be
	// reported and dropped: leaving it in would make the row un-saveable, because
	// the command layer validates every id against roles.role_id.
	if len(restricted.AllowedRoles) != 1 || restricted.AllowedRoles[0] != "admin" {
		t.Fatalf("a named list must be copied verbatim minus unknown ids, got %v", restricted.AllowedRoles)
	}
	if _, ok := cp.Findings["category_allowed_role_unknown"]; !ok {
		t.Fatal("an unknown role id must be reported")
	}

	publicRow := findCategoryRow(t, cp, "public")
	if len(publicRow.AllowedRoles) != len(roleIDs) {
		t.Fatalf("an empty view_forum list means public, got %v", publicRow.AllowedRoles)
	}

	nomap := findCategoryRow(t, cp, "nomap")
	if len(nomap.AllowedRoles) != len(roleIDs) {
		t.Fatalf("a missing map means public, got %v", nomap.AllowedRoles)
	}
}

// TestCategoryPublicListMatchesBackfillSort pins the sort order, because the
// migration 1767400000 backfill writes the same list and the two writers must
// produce byte-identical output for the same category.
func TestCategoryPublicListMatchesBackfillSort(t *testing.T) {
	plan, roleIDs := categoryPlanFixture()
	plan.Categories["c1"] = map[string]any{"title": "Public"}

	cp := BuildCategoryPlan(plan, roleIDs)
	row := findCategoryRow(t, cp, "c1")

	want := []string{"admin", "guest", "moderator", "player", "root"}
	if len(row.AllowedRoles) != len(want) {
		t.Fatalf("unexpected list length: %v", row.AllowedRoles)
	}
	for i := range want {
		if row.AllowedRoles[i] != want[i] {
			t.Fatalf("the public list must be ascending, got %v want %v", row.AllowedRoles, want)
		}
	}
	// guest is what makes "public" mean public for anonymous readers.
	found := false
	for _, id := range row.AllowedRoles {
		if id == "guest" {
			found = true
		}
	}
	if !found {
		t.Fatal("guest must be part of the public list")
	}
}

// TestCategoryLabelCollapse pins the {en, ru} decision per branch.
func TestCategoryLabelCollapse(t *testing.T) {
	plan, roleIDs := categoryPlanFixture()
	plan.Categories["both"] = map[string]any{
		"title":       map[string]any{"en": "Both", "ru": "Оба"},
		"description": map[string]any{"en": "English only"},
	}
	plan.Categories["ruonly"] = map[string]any{
		"title":       map[string]any{"ru": "Только RU"},
		"description": map[string]any{"en": "Only EN"},
	}

	cp := BuildCategoryPlan(plan, roleIDs)

	both := findCategoryRow(t, cp, "both")
	if both.Title != "Оба" {
		t.Fatalf("russian must win a two-language label, got %q", both.Title)
	}
	if both.Description != "English only" {
		t.Fatalf("an english-only description must survive, got %q", both.Description)
	}

	ruonly := findCategoryRow(t, cp, "ruonly")
	if ruonly.Title != "Только RU" || ruonly.Description != "Only EN" {
		t.Fatalf("single-language labels must survive intact: %+v", ruonly)
	}

	// Every collapse is accounted for, so the report can quantify what the
	// single-string schema cannot hold.
	if _, ok := cp.Findings["label_collapsed_ru_wins"]; !ok {
		t.Fatal("a two-language label must record the loss")
	}
}

// TestCategorySlugIsDeterministicAndUnique covers the two slug failure modes: a
// collision must not be resolved randomly (the importer re-runs against fresher
// dumps), and a title with no latin characters must still get a non-empty slug.
func TestCategorySlugIsDeterministicAndUnique(t *testing.T) {
	plan, roleIDs := categoryPlanFixture()
	plan.Categories["a"] = map[string]any{"title": map[string]any{"ru": "Лор"}}
	plan.Categories["b"] = map[string]any{"title": map[string]any{"ru": "Лор"}}
	plan.Categories["c"] = map[string]any{"title": map[string]any{"ru": "日本語"}}

	first := BuildCategoryPlan(plan, roleIDs)
	second := BuildCategoryPlan(plan, roleIDs)

	a := findCategoryRow(t, first, "a")
	b := findCategoryRow(t, first, "b")
	if a.Slug == b.Slug {
		t.Fatalf("a slug collision must be resolved, both are %q", a.Slug)
	}
	if a.Slug != findCategoryRow(t, second, "a").Slug ||
		b.Slug != findCategoryRow(t, second, "b").Slug {
		t.Fatal("slug assignment must be deterministic across runs")
	}

	c := findCategoryRow(t, first, "c")
	if c.Slug == "" {
		t.Fatal("a title with no latin characters must still get a slug: the column is NOT NULL")
	}
}

// TestCategoryGroupReferenceIsResolvedOrReported pins the dangling-group rule.
func TestCategoryGroupReferenceIsResolvedOrReported(t *testing.T) {
	plan, roleIDs := categoryPlanFixture()
	plan.Categories["ok"] = map[string]any{"title": "In group", "group_id": "grp1"}
	plan.Categories["dangling"] = map[string]any{"title": "No group", "group_id": "missing"}

	cp := BuildCategoryPlan(plan, roleIDs)

	ok := findCategoryRow(t, cp, "ok")
	if ok.GroupID != DeriveID(SpaceCategoryGroup, "grp1") {
		t.Fatalf("a resolvable group must be mapped, got %q", ok.GroupID)
	}

	dangling := findCategoryRow(t, cp, "dangling")
	if dangling.GroupID != "" {
		t.Fatalf("a dangling group must import as unassigned, got %q", dangling.GroupID)
	}
	if _, ok := cp.Findings["category_group_reference_unresolved"]; !ok {
		t.Fatal("a dangling group reference must be reported")
	}
}

// TestCategoryWithoutTitleIsSkipped pins the Required-field rule.
func TestCategoryWithoutTitleIsSkipped(t *testing.T) {
	plan, roleIDs := categoryPlanFixture()
	plan.Categories["blank"] = map[string]any{"title": map[string]any{}}

	cp := BuildCategoryPlan(plan, roleIDs)
	if len(cp.SkippedCategoryIDs) != 1 || cp.SkippedCategoryIDs[0] != "blank" {
		t.Fatalf("a nameless category must be skipped and reported, got %v", cp.SkippedCategoryIDs)
	}
	if _, ok := cp.Findings["category_title_missing"]; !ok {
		t.Fatal("the skip must be reported")
	}
}
