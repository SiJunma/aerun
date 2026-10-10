package migrations

// This test pins migration 1769400000: the repair for databases whose
// `roles` data predates the `edit_self_profile` key (seeded by 1766000000,
// reconciled by 1768600000 which had already run by the time the key was
// added to internal/auth). A fresh test DB is seeded by CURRENT code, so the
// test must DELIBERATELY corrupt the dictionary and the rows first — asserting
// only on the fresh state would pass without the migration and prove nothing,
// exactly as 1768600000's test argues.

import (
	"slices"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// permissionDictionary returns the roles.permissions SelectField values, i.e.
// the vocabulary a row value must be in to survive validation.
func permissionDictionary(t testing.TB, app *tests.TestApp) []string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		t.Fatalf("roles collection: %v", err)
	}
	field, ok := col.Fields.GetByName("permissions").(*core.SelectField)
	if !ok {
		t.Fatal("roles.permissions is not a select field")
	}
	return slices.Clone(field.Values)
}

// stripFromDictionary removes keys from the SelectField vocabulary, saving the
// collection — reproducing a database created before those keys existed.
func stripFromDictionary(t testing.TB, app *tests.TestApp, keys ...string) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		t.Fatalf("roles collection: %v", err)
	}
	field, ok := col.Fields.GetByName("permissions").(*core.SelectField)
	if !ok {
		t.Fatal("roles.permissions is not a select field")
	}
	kept := make([]string, 0, len(field.Values))
	for _, v := range field.Values {
		if !slices.Contains(keys, v) {
			kept = append(kept, v)
		}
	}
	field.Values = kept
	field.MaxSelect = len(kept)
	if err := app.Save(col); err != nil {
		t.Fatalf("strip dictionary: %v", err)
	}
}

// stalePlayerPermissions is the player spec minus edit_self_profile — the row
// a pre-bce786d database actually holds.
func stalePlayerPermissions() []string {
	out := make([]string, 0)
	for _, v := range auth.PermissionValues(compiledRolePermissions()[string(auth.RolePlayer)]) {
		if v != string(auth.PermEditSelfProfile) {
			out = append(out, v)
		}
	}
	return out
}

// snapshotRoles captures every role row's permissions plus the dictionary, so
// a second run can be proven to write NOTHING (idempotency, not "converges").
func snapshotRoles(t testing.TB, app *tests.TestApp) (map[string][]string, []string) {
	t.Helper()
	rows, err := app.FindAllRecords("roles")
	if err != nil {
		t.Fatalf("read roles: %v", err)
	}
	out := make(map[string][]string, len(rows))
	for _, r := range rows {
		out[r.GetString("id")] = r.GetStringSlice("permissions")
	}
	return out, permissionDictionary(t, app)
}

// The dictionary on an old database lacked the keys added after its seed.
// A correct row value would still fail SelectField validation without them,
// so the vocabulary must be extended BEFORE any row is written.
func TestProfilePermissionRepairRestoresTheDictionary(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	stripFromDictionary(t, app, "edit_self_profile", "edit_others_profile")
	if slices.Contains(permissionDictionary(t, app), "edit_self_profile") {
		t.Fatal("setup did not take: dictionary still has the key")
	}

	if err := applyProfilePermissionRepair(app); err != nil {
		t.Fatalf("apply repair: %v", err)
	}

	got := permissionDictionary(t, app)
	// Asserting against the FULL compiled list, not just the known keys, so a
	// future permission added to internal/auth self-heals the same way.
	for _, want := range auth.AllPermissionValues() {
		if !slices.Contains(got, want) {
			t.Errorf("dictionary is missing compiled key %q", want)
		}
	}
}

// A stale system row (no edit_self_profile) must be rewritten to exactly the
// compiled spec — not merely "gain the key", or a later narrow could drift.
func TestProfilePermissionRepairReconcilesStaleSystemRows(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	stale := stalePlayerPermissions()
	if slices.Contains(stale, "edit_self_profile") {
		t.Fatal("setup did not take: stale set must lack the key")
	}
	setRolePermissions(t, app, "player", stale)

	if err := applyProfilePermissionRepair(app); err != nil {
		t.Fatalf("apply repair: %v", err)
	}

	want := auth.PermissionValues(compiledRolePermissions()[string(auth.RolePlayer)])
	got := roleRow(t, app, "player")
	if !slices.Equal(got, want) {
		t.Errorf("player row = %v, want exactly %v", got, want)
	}
	if !slices.Contains(got, "edit_self_profile") {
		t.Errorf("player row must hold edit_self_profile after the repair, got %v", got)
	}
}

// A custom role is the operator's own work — reconciling it would restore
// authority somebody deliberately removed (same argument as 1768600000).
func TestProfilePermissionRepairLeavesCustomRolesAlone(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		t.Fatalf("roles collection: %v", err)
	}
	custom := newRoleRecordForTest(t, app, col, "narrator", []string{"view_forum", "create_topic"})
	custom.Set("is_system", false)
	if err := app.Save(custom); err != nil {
		t.Fatalf("create custom role: %v", err)
	}

	if err := applyProfilePermissionRepair(app); err != nil {
		t.Fatalf("apply repair: %v", err)
	}

	got := custom.GetStringSlice("permissions")
	if !slices.Equal(got, []string{"view_forum", "create_topic"}) {
		t.Fatalf("a custom role was rewritten by the repair: %v", got)
	}
}

func TestProfilePermissionRepairIsIdempotent(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	// Start from the broken state so the first run really repairs something.
	stripFromDictionary(t, app, "edit_self_profile")
	setRolePermissions(t, app, "player", stalePlayerPermissions())

	if err := applyProfilePermissionRepair(app); err != nil {
		t.Fatalf("first run: %v", err)
	}
	firstRows, firstDict := snapshotRoles(t, app)

	if err := applyProfilePermissionRepair(app); err != nil {
		t.Fatalf("second run: %v", err)
	}
	secondRows, secondDict := snapshotRoles(t, app)

	if !slices.Equal(firstDict, secondDict) {
		t.Errorf("dictionary changed on the second run:\n first=%v\nsecond=%v", firstDict, secondDict)
	}
	for id, want := range firstRows {
		if got := secondRows[id]; !slices.Equal(got, want) {
			t.Errorf("role row %s changed on the second run:\n first=%v\nsecond=%v", id, want, got)
		}
	}
}
