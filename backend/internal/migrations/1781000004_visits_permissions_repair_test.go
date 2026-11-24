package migrations

import (
	"slices"
	"testing"

	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func stripKeysFromSlice(perms []string, keys ...string) []string {
	out := make([]string, 0, len(perms))
	for _, p := range perms {
		if !slices.Contains(keys, p) {
			out = append(out, p)
		}
	}
	return out
}

func TestVisitsPermissionRepairRestoresDictionaryAndSystemRoles(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	visitsKeys := []string{
		string(auth.PermViewVisitsDashboard),
		string(auth.PermViewRawIP),
		string(auth.PermManageIPBans),
	}

	// Simulate an older database: remove the three keys from root and admin
	// rows first, then strip them from the roles.permissions SelectField
	// vocabulary, and also create a custom role that must stay untouched.
	for _, roleID := range []string{string(auth.RoleRoot), string(auth.RoleAdmin)} {
		rec := adminRole(t, app, roleID)
		stripped := stripKeysFromSlice(rec.GetStringSlice("permissions"), visitsKeys...)
		setRolePermissions(t, app, roleID, stripped)
	}
	stripFromDictionary(t, app, visitsKeys...)

	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		t.Fatalf("find roles collection: %v", err)
	}
	customPerms := []string{"view_forum", "create_topic"}
	custom := newRoleRecordForTest(t, app, col, "custom_visits_curator", customPerms)
	custom.Set("is_system", false)
	if err := app.Save(custom); err != nil {
		t.Fatalf("save custom role: %v", err)
	}

	// Guard against false-positive test setup: ensure stale state is real.
	dictBefore := permissionDictionary(t, app)
	for _, k := range visitsKeys {
		if slices.Contains(dictBefore, k) {
			t.Fatalf("setup failed: dictionary still contains %q", k)
		}
		if slices.Contains(roleRow(t, app, string(auth.RoleRoot)), k) {
			t.Fatalf("setup failed: root still contains %q", k)
		}
		if slices.Contains(roleRow(t, app, string(auth.RoleAdmin)), k) {
			t.Fatalf("setup failed: admin still contains %q", k)
		}
	}

	// Apply repair migration.
	if err := applyVisitsPermissionRepair(app); err != nil {
		t.Fatalf("applyVisitsPermissionRepair failed: %v", err)
	}

	// 1. Dictionary must hold the FULL compiled permission set.
	dictAfter := permissionDictionary(t, app)
	for _, wantKey := range auth.AllPermissionValues() {
		if !slices.Contains(dictAfter, wantKey) {
			t.Errorf("dictionary missing compiled permission %q after repair", wantKey)
		}
	}

	// 2. Root matches compiled spec and holds all 3 new keys (including view_raw_ip).
	wantRoot := auth.PermissionValues(compiledRolePermissions()[string(auth.RoleRoot)])
	gotRoot := roleRow(t, app, string(auth.RoleRoot))
	if !slices.Equal(gotRoot, wantRoot) {
		t.Errorf("root permissions = %v, want %v", gotRoot, wantRoot)
	}
	for _, k := range visitsKeys {
		if !slices.Contains(gotRoot, k) {
			t.Errorf("root missing %q after repair", k)
		}
	}

	// 3. Admin matches compiled spec: has view_visits_dashboard & manage_ip_bans, NOT view_raw_ip.
	wantAdmin := auth.PermissionValues(compiledRolePermissions()[string(auth.RoleAdmin)])
	gotAdmin := roleRow(t, app, string(auth.RoleAdmin))
	if !slices.Equal(gotAdmin, wantAdmin) {
		t.Errorf("admin permissions = %v, want %v", gotAdmin, wantAdmin)
	}
	if !slices.Contains(gotAdmin, string(auth.PermViewVisitsDashboard)) {
		t.Errorf("admin missing %q after repair", auth.PermViewVisitsDashboard)
	}
	if !slices.Contains(gotAdmin, string(auth.PermManageIPBans)) {
		t.Errorf("admin missing %q after repair", auth.PermManageIPBans)
	}
	if slices.Contains(gotAdmin, string(auth.PermViewRawIP)) {
		t.Errorf("admin must NOT receive %q", auth.PermViewRawIP)
	}

	// 4. Custom role must never be touched (reload from DB).
	reloadedCustom, err := app.FindRecordById("roles", custom.Id)
	if err != nil {
		t.Fatalf("reload custom role: %v", err)
	}
	if gotCustom := reloadedCustom.GetStringSlice("permissions"); !slices.Equal(gotCustom, customPerms) {
		t.Errorf("custom role modified by repair: got %v, want %v", gotCustom, customPerms)
	}

	// 5. Idempotency: second run writes nothing.
	beforeRows, beforeDict := snapshotRoles(t, app)
	if err := applyVisitsPermissionRepair(app); err != nil {
		t.Fatalf("second run failed: %v", err)
	}
	afterRows, afterDict := snapshotRoles(t, app)
	if !slices.Equal(beforeDict, afterDict) {
		t.Errorf("second run changed dictionary (not idempotent)")
	}
	for id, b := range beforeRows {
		if a := afterRows[id]; !slices.Equal(b, a) {
			t.Errorf("second run changed role %q (not idempotent)", id)
		}
	}
}
