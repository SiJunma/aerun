// Command import-roles writes the role registry of a local PocketBase database
// from the compiled specs, after reconciling it against the legacy snapshot.
//
//	go run ./tools/migration/importer/cmd/import-roles \
//	    -data migration-data/roles-rehearsal-pb_data \
//	    -ledger migration-data/stage-1.json
//
// The write is an idempotent upsert keyed by the unique `role_id` index, so
// running it twice leaves the registry untouched the second time — the
// rehearsal prints `changed=false` and the ledger-derived reconciliation in
// both passes. It refuses to run against a directory that is not a PocketBase
// data dir, and it never deletes a role row it did not create.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
	_ "github.com/SiJunma/aerun/backend/internal/migrations"
	pb "github.com/SiJunma/aerun/backend/internal/platform/pocketbase"
	"github.com/SiJunma/aerun/backend/tools/migration/importer"
)

func main() {
	var (
		dataDir    = flag.String("data", "", "PocketBase data directory to write into")
		ledgerPath = flag.String("ledger", "", "staging ledger JSON (optional; enables reconciliation)")
		dryRun     = flag.Bool("dry-run", false, "reconcile and report without writing")
	)
	flag.Parse()

	// A dry run writes nothing, so it needs no database at all — that is what
	// makes it safe to point at a snapshot before a rehearsal db exists. Only a
	// real run requires a data dir, and it must already contain a migrated
	// database: this tool never creates production state from nothing.
	if *dataDir == "" && !*dryRun {
		fmt.Fprintln(os.Stderr, "usage: import-roles -data <pb_data dir> [-ledger <stage.json>] [-dry-run]")
		os.Exit(2)
	}
	if !*dryRun {
		if _, err := os.Stat(*dataDir); err != nil {
			fail(fmt.Sprintf("data dir %q must already exist (create a clean rehearsal database first; "+
				"never point this at production)", *dataDir), err)
		}
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	// The compiled matrix is the authority for what gets written; the ledger
	// only supplies the reconciliation report.
	upserts := pb.SystemRoleUpserts()

	// Without a ledger the compiled matrix is the only input: the system
	// registry is reconciled and nothing is imported. With a ledger the
	// planned custom roles are appended verbatim — since migration
	// 1766500000 they are first-class target data.
	if *ledgerPath != "" {
		ledger, err := importer.LoadStagingLedger(*ledgerPath)
		if err != nil {
			fail("load staging ledger", err)
		}
		plan, err := importer.BuildPlan(ledger, nil, logger)
		if err != nil {
			fail("build import plan", err)
		}
		rolePlan, err := importer.BuildRolePlan(plan, importer.RoleRowsFrom(upserts), auth.AllPermissionValues())
		if err != nil {
			fail("build role plan", err)
		}
		reportRoles(rolePlan)
		upserts = rolePlan.Upserts()
	}

	if *dryRun {
		fmt.Println("dry-run: no records written")
		return
	}

	pbApp, err := openApp(*dataDir)
	if err != nil {
		fail("open pocketbase", err)
	}

	defer closeApp(pbApp)
	report, err := pb.ImportRoleRegistry(pbApp, upserts)
	if err != nil {
		fail("import role registry", err)
	}

	fmt.Printf("created=%d updated=%d unchanged=%d changed=%t\n",
		len(report.Created), len(report.Updated), len(report.Unchanged), report.Changed())
	for _, id := range report.Created {
		fmt.Printf("  created %s\n", id)
	}
	for _, id := range report.Updated {
		fmt.Printf("  updated %s\n", id)
	}
	for _, id := range report.ExtraRoleIDs {
		fmt.Printf("  EXTRA (not in compiled specs, left alone) %s\n", id)
	}
}

// openApp bootstraps a headless PocketBase against dataDir and applies the
// Aerun migrations, so the registry writer sees the real target schema.
func openApp(dataDir string) (*pocketbase.PocketBase, error) {
	pbApp := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:       dataDir,
		DefaultEncryptionEnv: "AERUN_ENCRYPTION_KEY",
	})
	if err := pbApp.Bootstrap(); err != nil {
		return nil, fmt.Errorf("bootstrap: %w", err)
	}
	if err := pbApp.RunAllMigrations(); err != nil {
		return nil, fmt.Errorf("migrations: %w", err)
	}
	return pbApp, nil
}

// closeApp shuts the headless app down through PocketBase's terminate hook,
// mirroring the production path in internal/platform/pocketbase/run.go. The
// migrate/writer CLI never binds an HTTP server, so there is no apis.Serve
// shutdown to wait for; ClearBootstrap is what releases the SQLite handles and
// lets the rehearsal database be inspected or re-opened afterwards.
func closeApp(pbApp *pocketbase.PocketBase) {
	if err := pbApp.OnTerminate().Trigger(&core.TerminateEvent{App: pbApp},
		func(e *core.TerminateEvent) error {
			return e.App.ClearBootstrap()
		}); err != nil {
		fmt.Fprintf(os.Stderr, "shutdown: %v\n", err)
	}
}

// reportRoles prints the legacy-vs-compiled reconciliation and the custom
// roles the import writes verbatim.
func reportRoles(rp *importer.RolePlan) {
	fmt.Printf("roles: target=%d legacy_system=%d legacy_custom=%d\n",
		len(rp.Rows), len(rp.LegacySystem), len(rp.LegacyCustom))
	for _, line := range rp.SortedFindingLines() {
		fmt.Printf("  finding %s\n", line)
	}
	for _, row := range rp.CustomRows {
		fmt.Printf("  custom role %s (base %s) imported verbatim, users=%d\n",
			row.RoleID, row.BaseRoleID, rp.CustomRoleUsers[row.RoleID])
	}
}

func fail(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}
