package pocketbase

// Tests for the category and forum writers.
//
// The properties that matter for an import writer are: it writes what it was
// asked to, a second run over its own output changes nothing, and a batch it
// cannot write cleanly is refused BEFORE any row is touched.

import (
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

// seedImportFixture writes the minimum the writers need: a real account, and the
// seeded "general" category from migration 1766100000.
func seedImportFixture(t testing.TB, app *tests.TestApp) (userID, categoryID string) {
	t.Helper()
	userID = fixPlayerID
	createTestUser(t, app, fixPlayerID, "player@example.com", "PlayerOne",
		"player", "active")
	return userID, getGeneralCategoryID(t, app)
}

func TestImportCategoryGroupsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	upserts := []CategoryGroupUpsert{
		{TargetID: "grp000000000001", Title: "Лор", SortOrder: 3,
			CreatedAt: "2023-11-14 22:13:20.000Z"},
	}

	first, err := ImportCategoryGroups(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.GroupsCreated) != 1 {
		t.Fatalf("expected one created group, got %+v", first)
	}
	if !first.Changed() {
		t.Fatal("a first run must report a change")
	}

	second, err := ImportCategoryGroups(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Fatalf("a re-run over its own output must be a no-op, got %+v", second)
	}
	if len(second.GroupsUnchanged) != 1 {
		t.Fatalf("the row must be reported unchanged, got %+v", second)
	}

	rec, err := app.FindRecordById(categoryGroupsCollectionName, "grp000000000001")
	if err != nil || rec == nil {
		t.Fatalf("group not written: %v", err)
	}
	if rec.GetString("title") != "Лор" {
		t.Fatalf("title must be written verbatim, got %q", rec.GetString("title"))
	}
	if rec.GetInt("sort_order") != 3 {
		t.Fatalf("sort_order must be written, got %d", rec.GetInt("sort_order"))
	}
	// The historical date has to survive: this is why the column is a plain
	// datetime field rather than an autodate.
	if got := rec.GetDateTime("created_at").String(); got != "2023-11-14 22:13:20.000Z" {
		t.Fatalf("created_at must be preserved, got %q", got)
	}
}

func TestImportCategoriesWritesAllowedRolesAndGroup(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedImportFixture(t, app)

	if _, err := ImportCategoryGroups(app, []CategoryGroupUpsert{
		{TargetID: "grp000000000002", Title: "Group", SortOrder: 0},
	}); err != nil {
		t.Fatal(err)
	}

	upserts := []CategoryUpsert{{
		TargetID:     "cat000000000001",
		GroupID:      "grp000000000002",
		Name:         "Скрытые игры",
		Slug:         "skrytye-igry",
		Description:  "desc",
		SortOrder:    2,
		AllowedRoles: []string{"admin", "PYaDjGY5XvWHNEjTswuz"},
	}}

	first, err := ImportCategories(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.CategoriesCreated) != 1 {
		t.Fatalf("expected one created category, got %+v", first)
	}

	rec, err := app.FindRecordById(categoriesCollectionName, "cat000000000001")
	if err != nil || rec == nil {
		t.Fatalf("category not written: %v", err)
	}
	roles := decodeRoleIDList(rec.Get("allowed_roles"))
	if len(roles) != 2 || roles[0] != "admin" || roles[1] != "PYaDjGY5XvWHNEjTswuz" {
		t.Fatalf("allowed_roles must be written verbatim, got %v", roles)
	}
	if rec.GetString("group_id") != "grp000000000002" {
		t.Fatalf("group_id must be written, got %q", rec.GetString("group_id"))
	}

	second, err := ImportCategories(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Fatalf("a re-run must be a no-op, got %+v", second)
	}
}

// TestImportCategoriesRefusesDanglingGroup is the case that would otherwise leave
// a category pointing at nothing: the group batch and the category batch are
// separate calls, and an operator can run them out of order.
func TestImportCategoriesRefusesDanglingGroup(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedImportFixture(t, app)

	_, err := ImportCategories(app, []CategoryUpsert{{
		TargetID: "cat000000000003",
		GroupID:  "grpmissing00001",
		Name:     "Orphan",
		Slug:     "orphan",
	}})
	if err == nil {
		t.Fatal("a dangling group_id must be refused")
	}

	if _, err := app.FindRecordById(categoriesCollectionName, "cat000000000003"); err == nil {
		t.Fatal("the refused batch must not have written a row")
	}
}

// TestImportCategoriesRefusesSlugCollision pins the UNIQUE business key: two
// categories cannot share a slug, and the refusal has to name both sides.
func TestImportCategoriesRefusesSlugCollision(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedImportFixture(t, app)

	// The seeded "general" category already holds that slug.
	_, err := ImportCategories(app, []CategoryUpsert{{
		TargetID: "cat000000000004",
		Name:     "General",
		Slug:     "general",
	}})
	if err == nil {
		t.Fatal("a duplicate slug must be refused")
	}
}

// TestImportCategoriesReportsExtraRows pins the "report, never delete" rule.
func TestImportCategoriesReportsExtraRows(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedImportFixture(t, app)

	report, err := ImportCategories(app, []CategoryUpsert{{
		TargetID: "cat000000000005",
		Name:     "Kept",
		Slug:     "kept",
	}})
	if err != nil {
		t.Fatal(err)
	}
	// The seeded General row is in the target but not in this batch.
	if len(report.ExtraTargetIDs) != 1 {
		t.Fatalf("the unlisted row must be reported, got %v", report.ExtraTargetIDs)
	}
	if _, err := app.FindFirstRecordByFilter(categoriesCollectionName, "slug = 'general'", nil); err != nil {
		t.Fatalf("an unlisted row must NOT be deleted: %v", err)
	}
}

// TestImportCategoryGroupsRejectsInvalidBatchBeforeWriting pins that validation
// happens before the transaction opens: a rejected batch must leave the
// collection exactly as it was.
func TestImportCategoryGroupsRejectsInvalidBatchBeforeWriting(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	cases := []struct {
		name   string
		upsert CategoryGroupUpsert
	}{
		{name: "no id", upsert: CategoryGroupUpsert{Title: "x"}},
		{name: "no title", upsert: CategoryGroupUpsert{TargetID: "grp000000000009"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ImportCategoryGroups(app, []CategoryGroupUpsert{tc.upsert}); err == nil {
				t.Fatal("expected a validation error before any write")
			}
		})
	}

	count, err := app.CountRecords(categoryGroupsCollectionName, nil)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("a rejected batch must write nothing, got %d rows", count)
	}
}

// TestImportCategoriesPreservesHistoricalDate is the regression test for a bug
// this writer shipped with and the rehearsal caught.
//
// `categories` has AutodateField columns named created/updated; it has NO
// created_at/updated_at. Writing the legacy date to the column name the other
// collections use (category_groups, characters) succeeds silently and stores
// nothing — no error, no validation failure — and then every subsequent run
// compares a wanted date against an empty stored one, reports "updated" forever,
// and the imported board shows every category as created at the zero time.
//
// So this asserts the DATE, not just the idempotency: an empty stored value and
// a wrong stored value are equally wrong here, and only the first assertion on a
// real value would have caught it earlier.
func TestImportCategoriesPreservesHistoricalDate(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedImportFixture(t, app)

	const created = "2026-04-15 12:34:56.000Z"
	const updated = "2026-05-16 07:08:09.000Z"
	upserts := []CategoryUpsert{{
		TargetID:  "cat000000000010",
		Name:      "Dated",
		Slug:      "dated",
		CreatedAt: created,
		UpdatedAt: updated,
	}}

	if _, err := ImportCategories(app, upserts); err != nil {
		t.Fatal(err)
	}

	rec, err := app.FindRecordById(categoriesCollectionName, "cat000000000010")
	if err != nil || rec == nil {
		t.Fatalf("category not written: %v", err)
	}
	if got := rec.GetDateTime("created").String(); got != created {
		t.Fatalf("the legacy creation date must be preserved, got %q want %q", got, created)
	}
	if got := rec.GetDateTime("updated").String(); got != updated {
		t.Fatalf("the legacy update date must be preserved, got %q want %q", got, updated)
	}

	// And now the idempotency it buys: a second run has to report no change.
	second, err := ImportCategories(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Fatalf("a re-run over its own output must be a no-op, got %+v", second)
	}
}
