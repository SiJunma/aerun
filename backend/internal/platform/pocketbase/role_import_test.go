package pocketbase

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/SiJunma/aerun/backend/internal/migrations"
)

// migratedApp boots a fresh data dir with the Aerun migrations applied, so the
// writer is exercised against the real target schema (and not a hand-built
// stand-in that could drift from it).
func migratedApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}
	return app
}

func roleRows(t *testing.T, app core.App) map[string]*core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := app.FindAllRecords(col.Id)
	if err != nil {
		t.Fatal(err)
	}
	out := make(map[string]*core.Record, len(rows))
	for _, rec := range rows {
		out[rec.GetString("role_id")] = rec
	}
	return out
}

func clearRoleRows(t *testing.T, app core.App) {
	t.Helper()
	for _, rec := range roleRows(t, app) {
		if err := app.Delete(rec); err != nil {
			t.Fatal(err)
		}
	}
}

// TestImportRoleRegistry_MatchesSeed proves the importer mirrors the migration
// seed exactly. If the two ever diverge, a rehearsal would rewrite the registry
// on every run and the reported "unchanged" verdict would be worthless.
func TestImportRoleRegistry_MatchesSeed(t *testing.T) {
	app := migratedApp(t)

	report, err := ImportRoleRegistry(app, SystemRoleUpserts())
	if err != nil {
		t.Fatal(err)
	}
	if report.Changed() {
		t.Errorf("import rewrote a freshly migrated registry: created=%v updated=%v",
			report.Created, report.Updated)
	}
	if len(report.Unchanged) != len(SystemRoleUpserts()) {
		t.Errorf("unchanged = %d, want %d", len(report.Unchanged), len(SystemRoleUpserts()))
	}
	if len(report.ExtraRoleIDs) != 0 {
		t.Errorf("seeded registry reported extras: %v", report.ExtraRoleIDs)
	}
}

// TestImportRoleRegistry_CreatesMissingRows proves the insert path. The seed
// pre-populates the registry, so without this the "unchanged" test above would
// pass even if creation were broken.
func TestImportRoleRegistry_CreatesMissingRows(t *testing.T) {
	app := migratedApp(t)
	clearRoleRows(t, app)

	report, err := ImportRoleRegistry(app, SystemRoleUpserts())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Created) != len(SystemRoleUpserts()) {
		t.Fatalf("created = %v, want %d rows", report.Created, len(SystemRoleUpserts()))
	}
	if len(report.Updated) != 0 {
		t.Errorf("updated = %v, want none on a clean registry", report.Updated)
	}

	// The written rows must be usable, not merely present: the runtime reads
	// permissions as a sorted set, so an empty slice would authorise nothing.
	rows := roleRows(t, app)
	if len(rows) != len(SystemRoleUpserts()) {
		t.Fatalf("rows in db = %d, want %d", len(rows), len(SystemRoleUpserts()))
	}
	for id, rec := range rows {
		if rec.GetStringSlice("permissions") == nil {
			t.Errorf("role %s was written with a null permissions list", id)
		}
	}
}

// TestImportRoleRegistry_IsIdempotent is the Sprint 7 DoD for this writer: a
// second import over its own output must report no change at all.
func TestImportRoleRegistry_IsIdempotent(t *testing.T) {
	app := migratedApp(t)

	if _, err := ImportRoleRegistry(app, SystemRoleUpserts()); err != nil {
		t.Fatal(err)
	}
	before := roleRows(t, app)

	report, err := ImportRoleRegistry(app, SystemRoleUpserts())
	if err != nil {
		t.Fatal(err)
	}
	if report.Changed() {
		t.Errorf("second import rewrote rows: created=%v updated=%v", report.Created, report.Updated)
	}

	after := roleRows(t, app)
	if len(before) != len(after) {
		t.Fatalf("row count changed on re-import: %d -> %d", len(before), len(after))
	}
	for id, rec := range before {
		next, ok := after[id]
		if !ok {
			t.Errorf("role %s disappeared on re-import", id)
			continue
		}
		if rec.Id != next.Id {
			t.Errorf("role %s was replaced (id %s -> %s), so the upsert key is not stable", id, rec.Id, next.Id)
		}
	}
}

// TestImportRoleRegistry_RepairsDrift proves the update path. Without this, a
// registry whose row was edited or truncated by hand would stay wrong forever,
// because every run would report it as "unchanged" only if comparison were
// broken — so both the repair and the report must be checked.
func TestImportRoleRegistry_RepairsDrift(t *testing.T) {
	app := migratedApp(t)
	rows := roleRows(t, app)

	victim, ok := rows["moderator"]
	if !ok {
		t.Skip("moderator role is not part of the compiled matrix")
	}
	victim.Set("name", "Tampered")
	victim.Set("rank", 99)
	victim.Set("permissions", []string{"view_forum"})
	if err := app.Save(victim); err != nil {
		t.Fatal(err)
	}

	report, err := ImportRoleRegistry(app, SystemRoleUpserts())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Updated) != 1 || report.Updated[0] != "moderator" {
		t.Fatalf("updated = %v, want exactly [moderator]", report.Updated)
	}
	if len(report.Unchanged) != len(SystemRoleUpserts())-1 {
		t.Errorf("unchanged = %v, want the other %d roles", report.Unchanged, len(SystemRoleUpserts())-1)
	}

	repaired, ok := roleRows(t, app)["moderator"]
	if !ok {
		t.Fatal("moderator role vanished")
	}
	if repaired.Id != victim.Id {
		t.Errorf("repair replaced the row (%s -> %s); drift must be fixed in place", victim.Id, repaired.Id)
	}
	if repaired.GetString("name") == "Tampered" || repaired.GetInt("rank") == 99 {
		t.Errorf("drift survived the import: name=%q rank=%d", repaired.GetString("name"), repaired.GetInt("rank"))
	}
}

// TestImportRoleRegistry_ReportsExtrasWithoutDeleting checks the two halves of
// the policy: an unexpected row is surfaced for review, but never destroyed —
// deletion is a separate, human-approved decision.
func TestImportRoleRegistry_ReportsExtrasWithoutDeleting(t *testing.T) {
	app := migratedApp(t)
	col, err := app.FindCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	stray := core.NewRecord(col)
	stray.Set("role_id", "legacy_custom")
	stray.Set("name", "Legacy Custom")
	stray.Set("rank", 1)
	stray.Set("is_system", false)
	stray.Set("permissions", []string{"view_forum"})
	if err := app.Save(stray); err != nil {
		t.Fatal(err)
	}

	report, err := ImportRoleRegistry(app, SystemRoleUpserts())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.ExtraRoleIDs) != 1 || report.ExtraRoleIDs[0] != "legacy_custom" {
		t.Errorf("extras = %v, want [legacy_custom]", report.ExtraRoleIDs)
	}
	if _, ok := roleRows(t, app)["legacy_custom"]; !ok {
		t.Error("the extra role was deleted; the importer must not remove rows")
	}
}

// TestImportRoleRegistry_RejectsBadInput proves the transaction guard rails.
func TestImportRoleRegistry_RejectsBadInput(t *testing.T) {
	app := migratedApp(t)

	if _, err := ImportRoleRegistry(app, []RoleUpsert{{Name: "no id"}}); err == nil {
		t.Error("an upsert without role_id must be rejected")
	}
	dup := []RoleUpsert{{RoleID: "player"}, {RoleID: "player"}}
	if _, err := ImportRoleRegistry(app, dup); err == nil {
		t.Error("duplicate role ids must be rejected")
	}

	// A rejected batch must not have written the valid part of it.
	for id, rec := range roleRows(t, app) {
		if rec.GetString("name") == "" {
			t.Errorf("role %s lost its name during a rejected import", id)
		}
	}
}
