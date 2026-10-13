package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	"slices"
	"testing"

	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// adminRole returns the roles row whose role_id matches roleID.
func adminRole(t testing.TB, app *tests.TestApp, roleID string) *core.Record {
	t.Helper()
	records, err := app.FindAllRecords("roles")
	if err != nil {
		t.Fatalf("read roles: %v", err)
	}
	for _, r := range records {
		if r.GetString("role_id") == roleID {
			return r
		}
	}
	t.Fatalf("no role row for %q", roleID)
	return nil
}
func TestMentionAllPermissionRepairRestoresTheDictionaryAndSystemRoles(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	// Deliberately strip mention_all to simulate a pre-migration database
	stripFromDictionary(t, app, string(auth.PermMentionAll))
	if slices.Contains(permissionDictionary(t, app), string(auth.PermMentionAll)) {
		t.Fatal("setup failed: dictionary still has mention_all")
	}

	// Remove mention_all from admin row
	adminRecord := adminRole(t, app, string(auth.RoleAdmin))
	if err != nil {
		t.Fatalf("find admin role: %v", err)
	}
	adminPerms := adminRecord.GetStringSlice("permissions")
	strippedPerms := make([]string, 0, len(adminPerms))
	for _, p := range adminPerms {
		if p != string(auth.PermMentionAll) {
			strippedPerms = append(strippedPerms, p)
		}
	}
	adminRecord.Set("permissions", strippedPerms)
	if err := app.Save(adminRecord); err != nil {
		t.Fatalf("save admin role without mention_all: %v", err)
	}

	// Apply migration repair
	if err := applyMentionAllPermissionRepair(app); err != nil {
		t.Fatalf("applyMentionAllPermissionRepair failed: %v", err)
	}

	// Verify dictionary has mention_all restored
	if !slices.Contains(permissionDictionary(t, app), string(auth.PermMentionAll)) {
		t.Fatal("repair did not restore mention_all to dictionary")
	}

	// Verify admin role has mention_all
	reloadedAdmin := adminRole(t, app, string(auth.RoleAdmin))
	if err != nil {
		t.Fatalf("reload admin role: %v", err)
	}
	if !slices.Contains(reloadedAdmin.GetStringSlice("permissions"), string(auth.PermMentionAll)) {
		t.Fatal("admin role still missing mention_all after repair")
	}

	// Second run must be idempotent
	beforePerms, beforeDict := snapshotRoles(t, app)
	if err := applyMentionAllPermissionRepair(app); err != nil {
		t.Fatalf("second run failed: %v", err)
	}
	afterPerms, afterDict := snapshotRoles(t, app)

	if !slices.Equal(beforeDict, afterDict) {
		t.Fatal("second run modified the dictionary (not idempotent)")
	}
	for id, b := range beforePerms {
		a := afterPerms[id]
		if !slices.Equal(b, a) {
			t.Fatalf("second run modified role %q (not idempotent)", id)
		}
	}
}
