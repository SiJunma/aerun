package migrations

// This test pins the SYSTEM-ROLE half of migration 1768600000: after it runs,
// the spectator row must carry view_forum and nothing else, and the player row
// must carry the reputation self keys.
//
// WHY A TEST RATHER THAN A LOOK AT THE SEED. The seed and the reconciliation
// are different code paths. The seed (1766000000) writes the compiled specs, so
// on a FRESH database spectator is already correct without this migration
// running. The rows that actually needed fixing came from the Firestore import,
// which carries the legacy permission sets. So the assertion has to be made
// against a deliberately-corrupted row — otherwise it passes on a fresh app and
// proves nothing about the repair path.

import (
	"slices"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"github.com/pocketbase/pocketbase/tests"
)

func roleRow(t testing.TB, app *tests.TestApp, roleID string) []string {
	t.Helper()
	records, err := app.FindAllRecords("roles")
	if err != nil {
		t.Fatalf("read roles: %v", err)
	}
	for _, r := range records {
		if r.GetString("role_id") == roleID {
			return r.GetStringSlice("permissions")
		}
	}
	t.Fatalf("no %s role row", roleID)
	return nil
}

func setRolePermissions(t testing.TB, app *tests.TestApp, roleID string, perms []string) {
	t.Helper()
	records, err := app.FindAllRecords("roles")
	if err != nil {
		t.Fatalf("read roles: %v", err)
	}
	for _, r := range records {
		if r.GetString("role_id") == roleID {
			r.Set("permissions", perms)
			if err := app.Save(r); err != nil {
				t.Fatalf("seed %s permissions: %v", roleID, err)
			}
			return
		}
	}
	t.Fatalf("no %s role row", roleID)
}

// newRoleRecordForTest builds a minimal roles row for the custom-role test.
func newRoleRecordForTest(t testing.TB, app *tests.TestApp, col *core.Collection, roleID string, perms []string) *core.Record {
	t.Helper()
	r := core.NewRecord(col)
	r.Set("role_id", roleID)
	r.Set("name", roleID)
	r.Set("rank", 350)
	r.Set("color", "primary")
	r.Set("permissions", perms)
	if err := app.Save(r); err != nil {
		t.Fatalf("create role %s: %v", roleID, err)
	}
	return r
}

// The imported legacy set: a spectator who could talk, and who carried the dice
// and mask features. This is exactly what the admin panel was still rendering.
var legacySpectatorPermissions = []string{
	"view_forum", "post_reply", "create_topic",
	"use_dice", "use_masks", "use_reputation", "use_direct_messages",
}

func TestSpectatorRowIsNarrowedByTheReconciliation(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	// Reproduce the state the panel was actually showing.
	setRolePermissions(t, app, "spectator", legacySpectatorPermissions)
	if !slices.Contains(roleRow(t, app, "spectator"), "create_topic") {
		t.Fatal("setup did not take")
	}

	if err := applyReputationPermissionSplit(app); err != nil {
		t.Fatalf("apply migration: %v", err)
	}

	// Exactly view_forum. Not "contains view_forum" — the point is that the
	// authoring and feature keys are GONE.
	if got := roleRow(t, app, "spectator"); !slices.Equal(got, []string{"view_forum"}) {
		t.Fatalf("spectator must be reduced to view_forum, got %v", got)
	}
}

func TestPlayerRowGainsTheReputationSelfKeys(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	if err := applyReputationPermissionSplit(app); err != nil {
		t.Fatalf("apply migration: %v", err)
	}

	got := roleRow(t, app, "player")
	for _, want := range []string{"edit_self_reputation", "delete_self_reputation"} {
		if !slices.Contains(got, want) {
			t.Errorf("player must hold %q after the split, got %v", want, got)
		}
	}
	// And the master-dice removal from the previous commit has to survive too,
	// or this migration silently re-grants it on every deploy.
	if slices.Contains(got, "view_master_dice") {
		t.Errorf("player must not regain view_master_dice, got %v", got)
	}
}

// A custom role is the operator's own work. Reconciling it would restore
// authority somebody deliberately removed — the one failure no later edit can
// detect, because nothing would look wrong.
func TestCustomRolePermissionsAreLeftAlone(t *testing.T) {
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

	if err := applyReputationPermissionSplit(app); err != nil {
		t.Fatalf("apply migration: %v", err)
	}

	got := custom.GetStringSlice("permissions")
	if !slices.Contains(got, "create_topic") {
		t.Fatalf("a custom role was rewritten by the system reconciliation: %v", got)
	}
}
