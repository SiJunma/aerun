package migrations

import (
	"slices"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// TestGuestViewForumMigration covers 1766200000: the guest role must carry the
// global view_forum baseline, a database seeded under the pre-fix contract
// (empty guest permissions) must be repaired, and a database whose guest row
// is missing must get it back from the compiled spec.
func TestGuestViewForumMigration(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	// A fresh install satisfies the contract through the roles seed itself.
	records := guestRoleRecords(t, app)
	if len(records) != 1 {
		t.Fatalf("expected exactly one guest role row, got %d", len(records))
	}
	if got := records[0].GetStringSlice("permissions"); !slices.Equal(got, []string{"view_forum"}) {
		t.Fatalf("seeded guest permissions drifted: %v", got)
	}

	// A database created before the fix holds an empty guest set; the
	// migration must bring it onto the new contract.
	records[0].Set("permissions", []string{})
	if err := app.Save(records[0]); err != nil {
		t.Fatalf("simulate the pre-fix guest row: %v", err)
	}
	if err := setGuestPermissions(app, auth.DefaultPermissions(auth.RoleGuest)); err != nil {
		t.Fatalf("repair guest role: %v", err)
	}
	repaired := guestRoleRecords(t, app)
	if len(repaired) != 1 {
		t.Fatalf("guest row disappeared, got %d rows", len(repaired))
	}
	if got := repaired[0].GetStringSlice("permissions"); !slices.Equal(got, []string{"view_forum"}) {
		t.Fatalf("guest permissions were not repaired: %v", got)
	}

	// A database without the guest row at all gets it from the compiled spec.
	if err := app.Delete(repaired[0]); err != nil {
		t.Fatalf("drop the guest row: %v", err)
	}
	if err := setGuestPermissions(app, auth.DefaultPermissions(auth.RoleGuest)); err != nil {
		t.Fatalf("recreate guest role: %v", err)
	}
	recreated := guestRoleRecords(t, app)
	if len(recreated) != 1 {
		t.Fatalf("guest row was not recreated, got %d rows", len(recreated))
	}
	spec, ok := auth.SpecFor(auth.RoleGuest)
	if !ok {
		t.Fatal("guest role must exist in the compiled matrix")
	}
	if got := recreated[0].GetString("name"); got != spec.Name {
		t.Fatalf("recreated guest name drifted: %q", got)
	}
	if got := recreated[0].GetInt("rank"); got != spec.Rank {
		t.Fatalf("recreated guest rank drifted: %d", got)
	}
	if got := recreated[0].GetBool("is_system"); got != spec.IsSystem {
		t.Fatalf("recreated guest system flag drifted: %v", got)
	}
	if got := recreated[0].GetStringSlice("permissions"); !slices.Equal(got, []string{"view_forum"}) {
		t.Fatalf("recreated guest permissions drifted: %v", got)
	}

	// The down path restores the pre-fix contract.
	if err := setGuestPermissions(app, []auth.Permission{}); err != nil {
		t.Fatalf("rollback guest role: %v", err)
	}
	if got := guestRoleRecords(t, app)[0].GetStringSlice("permissions"); len(got) != 0 {
		t.Fatalf("rollback must clear guest permissions, got %v", got)
	}
}

// guestRoleRecords returns the roles rows of the guest role.
func guestRoleRecords(t *testing.T, app core.App) []*core.Record {
	t.Helper()
	collection, err := app.FindCachedCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		t.Fatalf("roles collection: %v", err)
	}
	records, err := app.FindAllRecords(collection, dbx.HashExp{"role_id": string(auth.RoleGuest)})
	if err != nil {
		t.Fatalf("guest role lookup: %v", err)
	}
	return records
}
