// Command import-users writes the accounts of a local PocketBase database from
// the staging ledger plus the official Firebase Auth export.
//
//	go run ./tools/migration/importer/cmd/import-users \
//	    -data migration-data/users-rehearsal-pb_data \
//	    -ledger migration-data/stage-1.json \
//	    -auth migration-data/auth-official-2026-09-18.json
//
// It is the second writer of the migration, after import-roles: the roles
// registry must be imported first, because every row's role is validated
// against it inside the writing transaction.
//
// The write is an idempotent upsert keyed by legacy_firebase_uid, so running
// it twice leaves the accounts untouched the second time (the report prints
// `unchanged=N` and `changed=false`). Nothing is ever deleted: an account that
// is already imported but absent from this batch is reported as `extra`.
//
// Selection flags:
//
//	-root-only   import only the account the export marks with legacy
//	             role_id "root" (the cutover bootstrap); fails when the
//	             export identifies none or several, because "who owns the
//	             forum" must not be guessed
//	-uid a,b     import only these legacy uids
//	-password x  password for rows THIS run creates — it never rewrites an
//	             existing password; falls back to AERUN_IMPORT_PASSWORD,
//	             then to PocketBase's random unusable password, which is
//	             printed once (mail delivery is disabled in the cutover)
//
// -dry-run plans and reports without touching any database, so it is safe to
// point at a snapshot before a rehearsal database exists.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"

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
		ledgerPath = flag.String("ledger", "", "staging ledger JSON (from cli.mjs stage)")
		authPath   = flag.String("auth", "", "official Firebase Auth export JSON (optional; authority for email and verified)")
		dryRun     = flag.Bool("dry-run", false, "plan and report without writing")
		rootOnly   = flag.Bool("root-only", false, "import only the root account (cutover bootstrap)")
		uidList    = flag.String("uid", "", "comma-separated legacy uids to import")
		password   = flag.String("password", "", "password for rows this run creates (or env AERUN_IMPORT_PASSWORD)")
	)
	flag.Parse()

	if *ledgerPath == "" {
		fmt.Fprintln(os.Stderr, "usage: import-users -ledger <stage.json> [-auth <auth-export.json>] "+
			"[-data <pb_data dir>] [-root-only | -uid a,b] [-password x] [-dry-run]")
		os.Exit(2)
	}
	if *rootOnly && strings.TrimSpace(*uidList) != "" {
		fmt.Fprintln(os.Stderr, "-root-only and -uid select different sets; pass exactly one of them")
		os.Exit(2)
	}
	// A dry run writes nothing, so it needs no database at all — that is what
	// makes it safe to run before a rehearsal db exists. A real run requires an
	// existing, migrated data dir: this tool never creates production state.
	if *dataDir == "" && !*dryRun {
		fmt.Fprintln(os.Stderr, "usage: import-users -data <pb_data dir> -ledger <stage.json> [...] (or -dry-run)")
		os.Exit(2)
	}
	if !*dryRun {
		if _, err := os.Stat(*dataDir); err != nil {
			fail(fmt.Sprintf("data dir %q must already exist (create a clean rehearsal database first; "+
				"never point this at production)", *dataDir), err)
		}
	}
	if *password == "" {
		// Reading the bootstrap password from the environment keeps it out of
		// the shell history; the flag exists for automation that has no env.
		*password = os.Getenv("AERUN_IMPORT_PASSWORD")
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
	} else {
		// Without the export the Firestore document is the only source: the
		// accounts import unverified, which is reported per row as
		// user_without_auth_record. Warn loudly, do not fail — the export may
		// legitimately be unavailable during a first dry run.
		fmt.Fprintln(os.Stderr, "warning: no -auth export given; email verified flags fall back to unverified")
	}

	plan, err := importer.BuildPlan(ledger, authExport, logger)
	if err != nil {
		fail("build import plan", err)
	}

	full := importer.BuildUserPlan(plan, auth.IsReservedNickname)
	selected, err := selectAccounts(full, *rootOnly, *uidList)
	if err != nil {
		fail("select accounts", err)
	}
	// The password applies only to rows this run creates: ImportUsers never
	// rewrites an existing password, so a re-run cannot invalidate a password
	// the owner has already set.
	for i := range selected.Rows {
		selected.Rows[i].Password = *password
	}

	reportPlan(full, selected)
	if *dryRun {
		fmt.Println("dry-run: no records written")
		return
	}

	pbApp, err := openApp(*dataDir)
	if err != nil {
		fail("open pocketbase", err)
	}
	defer closeApp(pbApp)

	report, err := pb.ImportUsers(pbApp, selected.Upserts())
	if err != nil {
		fail("import users", err)
	}

	fmt.Printf("created=%d updated=%d unchanged=%d extra=%d changed=%t\n",
		len(report.Created), len(report.Updated), len(report.Unchanged),
		len(report.ExtraLegacyUIDs), report.Changed())
	for _, uid := range report.Created {
		fmt.Printf("  created %s\n", uid)
	}
	for _, uid := range report.Updated {
		fmt.Printf("  updated %s\n", uid)
	}
	for _, uid := range report.ExtraLegacyUIDs {
		fmt.Printf("  extra (already imported, not in this batch, left alone) %s\n", uid)
	}
	if len(report.GeneratedPasswords) > 0 {
		// AERUN_MAIL_MODE=disabled means these values cannot be delivered by
		// email: printing them is the only handover channel there is.
		fmt.Println("one-time generated passwords (mail delivery is disabled; record them now, they are never shown again):")
		uids := make([]string, 0, len(report.GeneratedPasswords))
		for uid := range report.GeneratedPasswords {
			uids = append(uids, uid)
		}
		sort.Strings(uids)
		for _, uid := range uids {
			fmt.Printf("  %s %s\n", uid, report.GeneratedPasswords[uid])
		}
	}
}

// selectAccounts narrows the full plan to the requested set. Both selectors
// recompute their findings for the selection, so a -root-only bootstrap
// reports the root account's decisions and nothing about the accounts it did
// not touch.
func selectAccounts(full *importer.UserPlan, rootOnly bool, uidList string) (*importer.UserPlan, error) {
	switch {
	case rootOnly:
		root, err := full.RootAdminRow()
		if err != nil {
			return nil, err
		}
		return full.Subset([]string{root.LegacyUID})
	case strings.TrimSpace(uidList) != "":
		uids := strings.Split(uidList, ",")
		for i := range uids {
			uids[i] = strings.TrimSpace(uids[i])
		}
		return full.Subset(uids)
	default:
		return full, nil
	}
}

// reportPlan prints the planned write: what is selected, what is skipped for
// good, and every decision the plan took per account.
func reportPlan(full, selected *importer.UserPlan) {
	root := full.RootUID
	if root == "" {
		root = "-"
	}
	fmt.Printf("users: selected=%d skipped=%d root=%s\n", len(selected.Rows), len(full.SkippedUIDs), root)
	for _, line := range importer.SortedFindings(selected.Findings) {
		fmt.Printf("  finding %s\n", line)
	}
	for _, uid := range full.SkippedUIDs {
		fmt.Printf("  skipped %s (no email in document or auth export; never written)\n", uid)
	}
	for _, line := range selected.SortedRowLines() {
		fmt.Printf("  %s\n", line)
	}
}

// openApp bootstraps a headless PocketBase against dataDir and applies the
// Aerun migrations, so the writer sees the real target schema — identical to
// import-roles, the first writer of the migration.
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
// the SQLite handles and lets the rehearsal database be inspected or
// re-opened afterwards.
func closeApp(pbApp *pocketbase.PocketBase) {
	if err := pbApp.OnTerminate().Trigger(&core.TerminateEvent{App: pbApp},
		func(e *core.TerminateEvent) error {
			return e.App.ClearBootstrap()
		}); err != nil {
		fmt.Fprintf(os.Stderr, "shutdown: %v\n", err)
	}
}

func fail(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}
