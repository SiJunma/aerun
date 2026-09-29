// Command import-characters writes the legacy characters into the target
// characters collection.
//
//	go run ./tools/migration/importer/cmd/import-characters \
//	    -data pb_data -ledger migration-data/stage-1.json
//
// It is level L4 of the dependency map and MUST run after import-users: a
// character points at its owner through owner_id, so an owner that is not in
// the target yet is a row that cannot be written. The command checks that
// precondition itself rather than failing halfway through.
//
// The write is an upsert keyed by DeriveID(SpaceCharacter, "uid/characters/cid"),
// so re-running it against a FRESHER dump converges on the same rows instead of
// duplicating them, and character ids referenced by already-imported posts keep
// resolving. A second run reports everything unchanged.
//
// The avatar is not fetched here: avatar_url carries the legacy URL, and
// import-avatars -scope characters is the step that turns it into a real file
// plus a host-agnostic /api/files path.
//
// -dry-run plans and reports without touching any database, so it is safe to
// point at a snapshot before the target database exists.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	_ "github.com/SiJunma/aerun/backend/internal/migrations"
	pb "github.com/SiJunma/aerun/backend/internal/platform/pocketbase"
	"github.com/SiJunma/aerun/backend/tools/migration/importer"
)

func main() {
	var (
		dataDir    = flag.String("data", "", "PocketBase data directory to write into")
		ledgerPath = flag.String("ledger", "", "staging ledger JSON (from cli.mjs stage)")
		authPath   = flag.String("auth", "", "official Firebase Auth export JSON (optional; owners resolve through the imported accounts)")
		dryRun     = flag.Bool("dry-run", false, "plan and report without writing")
	)
	flag.Parse()

	if *ledgerPath == "" {
		fmt.Fprintln(os.Stderr, "usage: import-characters -ledger <stage.json> [-auth <auth-export.json>] [-data <pb_data dir>] [-dry-run]")
		os.Exit(2)
	}
	if *dataDir == "" && !*dryRun {
		fmt.Fprintln(os.Stderr, "usage: import-characters -data <pb_data dir> -ledger <stage.json> [...] (or -dry-run)")
		os.Exit(2)
	}
	if !*dryRun {
		if _, err := os.Stat(*dataDir); err != nil {
			fail(fmt.Sprintf("data dir %q must already exist (create a clean rehearsal database first; "+
				"never point this at production)", *dataDir), err)
		}
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	ledger, err := importer.LoadStagingLedger(*ledgerPath)
	if err != nil {
		fail("load staging ledger", err)
	}
	var authExport *importer.AuthExport
	if *authPath != "" {
		authExport, err = importer.LoadAuthExport(*authPath)
		if err != nil {
			fail("load auth export", err)
		}
	}

	plan, err := importer.BuildPlan(ledger, authExport, logger)
	if err != nil {
		fail("build import plan", err)
	}

	if *dryRun {
		// No database to ask, so every owner is assumed present and the report
		// says so: the owner check belongs to the real run, which is the only
		// place the answer is authoritative.
		cp := importer.BuildCharacterPlan(plan, func(string) bool { return true })
		reportPlan(cp, "assumed (dry run: no database consulted)")
		fmt.Println("dry-run: no records written")
		return
	}

	pbApp, err := openApp(*dataDir)
	if err != nil {
		fail("open pocketbase", err)
	}
	defer closeApp(pbApp)

	// Owners resolve against the TARGET users rows, not the ledger: the
	// question is "will this character have a parent once written", and only
	// the target can answer it.
	ownerExists, err := targetOwnerPredicate(pbApp)
	if err != nil {
		fail("read imported accounts", err)
	}

	cp := importer.BuildCharacterPlan(plan, ownerExists)
	reportPlan(cp, "target users collection")
	if cp.Selected() == 0 {
		fmt.Println("nothing to import: no character in the ledger has an owner in the target")
		return
	}

	report, err := pb.ImportCharacters(pbApp, characterUpserts(cp))
	if err != nil {
		fail("import characters", err)
	}

	fmt.Printf("created=%d updated=%d unchanged=%d extra=%d changed=%t\n",
		len(report.Created), len(report.Updated), len(report.Unchanged),
		len(report.ExtraTargetIDs), report.Changed())
	for _, id := range report.Created {
		fmt.Printf("  created %s\n", id)
	}
	for _, id := range report.Updated {
		fmt.Printf("  updated %s\n", id)
	}
	for _, id := range report.ExtraTargetIDs {
		fmt.Printf("  extra (already imported, not in this batch, left alone) %s\n", id)
	}
}

// targetOwnerPredicate resolves an owner against the imported users rows.
func targetOwnerPredicate(app *pocketbase.PocketBase) (func(string) bool, error) {
	users, err := app.FindAllRecords("users", nil)
	if err != nil {
		return nil, err
	}
	byLegacy := make(map[string]bool, len(users))
	for _, rec := range users {
		if legacyUID := rec.GetString("legacy_firebase_uid"); legacyUID != "" {
			byLegacy[legacyUID] = true
		}
	}
	return func(uid string) bool { return byLegacy[uid] }, nil
}

// characterUpserts converts the planned rows into platform upserts.
func characterUpserts(cp *importer.CharacterPlan) []pb.CharacterUpsert {
	upserts := make([]pb.CharacterUpsert, 0, cp.Selected())
	for _, row := range cp.Rows {
		upserts = append(upserts, pb.CharacterUpsert{
			TargetID:   row.TargetID,
			OwnerID:    row.OwnerID,
			Name:       row.Name,
			StatusLine: row.StatusLine,
			Signature:  row.Signature,
			AvatarURL:  row.AvatarURL,
			CreatedAt:  row.CreatedAt,
			UpdatedAt:  row.UpdatedAt,
		})
	}
	return upserts
}

// reportPlan prints the planned write: how many characters, what was skipped
// and why, and every decision the plan took.
func reportPlan(cp *importer.CharacterPlan, ownerSource string) {
	fmt.Printf("characters: selected=%d skipped=%d owners_from=%s\n",
		cp.Selected(), len(cp.SkippedKeys), ownerSource)
	for _, line := range cp.SortedFindingLines() {
		fmt.Printf("  finding %s\n", line)
	}
	for _, key := range cp.SkippedKeys {
		fmt.Printf("  skipped %s (see the finding above; never written)\n", key)
	}
	for _, line := range cp.SortedRowLines() {
		fmt.Printf("  %s\n", line)
	}
}

func fail(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}

// openApp bootstraps a headless PocketBase against dataDir and applies the
// Aerun migrations, so the writer sees the real target schema — identical to
// the other writers (import-roles, import-users, import-avatars).
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
// writer CLI never binds an HTTP server, so ClearBootstrap is what releases
// the SQLite handles and lets the database be re-opened afterwards.
func closeApp(pbApp *pocketbase.PocketBase) {
	if err := pbApp.OnTerminate().Trigger(&core.TerminateEvent{App: pbApp},
		func(e *core.TerminateEvent) error {
			return e.App.ClearBootstrap()
		}); err != nil {
		fmt.Fprintf(os.Stderr, "shutdown: %v\n", err)
	}
}
