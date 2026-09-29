package migrations

// Tests for the 1767400000 category visibility backfill.
//
// The backfill is the only place where the old "empty means public" meaning is
// translated into the new one. Getting it wrong is not a cosmetic mistake: the
// "copy the legacy map" branch is what keeps a restricted category restricted,
// and the "write the full list" branch is what keeps a public one public.

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"
)

// TestCategoryAllowedRolesBackfill proves both branches of the translation on a
// database that still carries the legacy map.
func TestCategoryAllowedRolesBackfill(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	// The migration chain is applied in full (PocketBase exposes only
	// RunAllMigrations), then the deprecated field is put back so this test can
	// reproduce the pre-backfill database state. The backfill is invoked
	// directly, which is what makes the two branches observable.
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	categories, err := app.FindCollectionByNameOrId("categories")
	if err != nil {
		t.Fatal(err)
	}

	// Re-add the deprecated field the migration removes, then seed rows that
	// look exactly like the legacy export.
	categories.Fields.Add(&core.JSONField{Name: "permissions", MaxSize: 65536})
	if err := app.Save(categories); err != nil {
		t.Fatal(err)
	}

	restricted := core.NewRecord(categories)
	restricted.Set("name", "Hidden")
	restricted.Set("slug", "hidden-games")
	restricted.Set("permissions", types.JSONRaw([]byte(`{"view_forum":["admin","player"]}`)))
	if err := app.Save(restricted); err != nil {
		t.Fatal(err)
	}

	publicCat := core.NewRecord(categories)
	publicCat.Set("name", "Offtopic")
	publicCat.Set("slug", "offtopic")
	publicCat.Set("permissions", types.JSONRaw([]byte(`{}`)))
	if err := app.Save(publicCat); err != nil {
		t.Fatal(err)
	}

	if err := backfillCategoryAllowedRoles(app); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	roles := decodeRoleIDList(mustReload(t, app, restricted.Id).Get("allowed_roles"))
	if len(roles) != 2 || roles[0] != "admin" || roles[1] != "player" {
		t.Fatalf("a restricted category must keep its exact legacy list, got %v", roles)
	}

	want := mustSortedRoleIDs(t, app)
	got := decodeRoleIDList(mustReload(t, app, publicCat.Id).Get("allowed_roles"))
	if len(got) != len(want) {
		t.Fatalf("an unmapped category must become the full public list, got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("the public list must be sorted ascending, got %v want %v", got, want)
		}
	}
	// guest must be part of it: an empty map meant "the whole forum", and a
	// public category that excludes guests would silently lock out every
	// anonymous reader.
	if !containsString(got, "guest") {
		t.Fatalf("the public list must include guest, got %v", got)
	}
}

// TestCategoryBackfillIsIdempotentAndDropsLegacyField pins the two properties the
// next run of the chain depends on.
func TestCategoryBackfillIsIdempotentAndDropsLegacyField(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	records, err := app.FindAllRecords("categories", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) == 0 {
		t.Fatal("the seeded General category must exist for this test to mean anything")
	}

	before := map[string][]string{}
	for _, rec := range records {
		before[rec.Id] = decodeRoleIDList(rec.Get("allowed_roles"))
	}

	// Re-running must not churn anything.
	if err := backfillCategoryAllowedRoles(app); err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	for _, rec := range mustReloadAll(t, app, "categories") {
		if !equalStrings(before[rec.Id], decodeRoleIDList(rec.Get("allowed_roles"))) {
			t.Fatalf("category %s changed on a second run: %v -> %v",
				rec.Id, before[rec.Id], decodeRoleIDList(rec.Get("allowed_roles")))
		}
	}

	if err := dropLegacyCategoryPermissions(app); err != nil {
		t.Fatalf("drop: %v", err)
	}
	categories, err := app.FindCollectionByNameOrId("categories")
	if err != nil {
		t.Fatal(err)
	}
	if categories.Fields.GetByName("permissions") != nil {
		t.Fatal("categories.permissions must be gone after the backfill")
	}
	if categories.Fields.GetByName("allowed_roles") == nil {
		t.Fatal("categories.allowed_roles must remain")
	}
}

func mustReload(t testing.TB, app core.App, id string) *core.Record {
	t.Helper()
	rec, err := app.FindRecordById("categories", id)
	if err != nil || rec == nil {
		t.Fatalf("failed to reload category %s: %v", id, err)
	}
	return rec
}

func mustReloadAll(t testing.TB, app core.App, collection string) []*core.Record {
	t.Helper()
	records, err := app.FindAllRecords(collection, nil)
	if err != nil {
		t.Fatal(err)
	}
	return records
}

func mustSortedRoleIDs(t testing.TB, app core.App) []string {
	t.Helper()
	ids, err := allRoleIDsSorted(app)
	if err != nil {
		t.Fatal(err)
	}
	return ids
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
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
