// Command import-avatars moves the legacy Firebase avatars into PocketBase.
//
//	go run ./tools/migration/importer/cmd/import-avatars \
//	    -data migration-data/pb_data \
//	    -storage migration-data
//
// It is the storage half of the user import: import-users copies the legacy
// avatar *URL* into users.avatar_url, and this writer replaces it with a file
// the record owns plus a host-agnostic /api/files/... reference.
//
// Two collections are covered, because both carry a legacy avatar URL and both
// now have a real FileField (users.avatar from 1767000000, characters.avatar
// from 1767200000):
//
//   - -scope users (default): account avatars, reported by nickname.
//   - -scope characters: character avatars, reported by "owner / name". Note
//     that this only has rows to work on once the characters themselves are
//     imported; against an empty collection it reports nothing, which is the
//     correct outcome rather than an error.
//
// The bytes come from the verified Sprint 0 export by default
// (migration-data/storage, checked against storage-manifest.json md5s), so
// the run is offline and reproducible. -download re-fetches the live Firebase
// object instead, which is only needed for an avatar that changed after the
// snapshot; the md5 check then reports the difference instead of hiding it.
//
// The write is idempotent: a row that already has the file and a rewritten URL
// is reported as `unchanged=N` and not touched again. Nothing is ever deleted
// — including the stored files, which a schema downgrade must not destroy.
//
// The report prints nicknames and reasons, never email addresses, so the log
// can be pasted into the plan journal (same rule as tools/ops).
//
// -dry-run reports exactly what a real run would do and writes nothing, so it
// is safe to point at a snapshot before the target database exists.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	_ "github.com/SiJunma/aerun/backend/internal/migrations"
	pb "github.com/SiJunma/aerun/backend/internal/platform/pocketbase"
)

func main() {
	var (
		dataDir    = flag.String("data", "", "PocketBase data directory to write into")
		storageDir = flag.String("storage", "", "root of the verified legacy export (holds storage/ and storage-manifest.json)")
		scope      = flag.String("scope", "users", "which collection to migrate: users | characters | all")
		download   = flag.Bool("download", false, "re-fetch avatars from the live legacy bucket instead of the export")
		dryRun     = flag.Bool("dry-run", false, "report without writing")
	)
	flag.Parse()

	if *dataDir == "" {
		fmt.Fprintln(os.Stderr, "usage: import-avatars -data <pb_data dir> [-storage <export root>] [-scope users|characters|all] [-download] [-dry-run]")
		os.Exit(2)
	}
	if *storageDir == "" && !*download {
		fmt.Fprintln(os.Stderr, "import-avatars: -storage <export root> is required unless -download is set")
		os.Exit(2)
	}
	if *scope != "users" && *scope != "characters" && *scope != "all" {
		fmt.Fprintf(os.Stderr, "import-avatars: unknown -scope %q (want users, characters or all)\n", *scope)
		os.Exit(2)
	}

	pbApp, err := openApp(*dataDir)
	if err != nil {
		fail("open", err)
	}
	defer closeApp(pbApp)

	opts := pb.AvatarImportOptions{
		StorageDir: *storageDir,
		Download:   *download,
		DryRun:     *dryRun,
	}

	if *scope == "users" || *scope == "all" {
		report, err := pb.ImportUserAvatars(pbApp, opts)
		if err != nil {
			fail("import", err)
		}
		mode := "imported"
		if *dryRun {
			mode = "planned"
		}
		fmt.Printf("avatars: %s=%d unchanged=%d skipped=%d md5_verified=%d md5_mismatch=%d changed=%t\n",
			mode, len(report.Linked), len(report.Unchanged), len(report.Skipped),
			report.VerifiedMD5, len(report.MismatchMD5), report.Changed())
		for _, nickname := range report.Linked {
			fmt.Printf("  %s %s\n", mode, nickname)
		}
		for _, nickname := range report.Unchanged {
			fmt.Printf("  unchanged %s\n", nickname)
		}
		for _, skip := range report.Skipped {
			fmt.Printf("  skipped %s (%s)\n", skip.Nickname, skip.Reason)
		}
		for _, nickname := range report.MismatchMD5 {
			fmt.Printf("  md5 differs from the export manifest %s\n", nickname)
		}
	}

	if *scope == "characters" || *scope == "all" {
		report, err := pb.ImportCharacterAvatars(pbApp, opts)
		if err != nil {
			fail("import characters", err)
		}
		mode := "imported"
		if *dryRun {
			mode = "planned"
		}
		fmt.Printf("character_avatars: %s=%d unchanged=%d skipped=%d md5_verified=%d md5_mismatch=%d no_owner=%d changed=%t\n",
			mode, len(report.Linked), len(report.Unchanged), len(report.Skipped),
			report.VerifiedMD5, len(report.MismatchMD5), len(report.NoOwner), report.Changed())
		for _, label := range report.Linked {
			fmt.Printf("  %s %s\n", mode, label)
		}
		for _, label := range report.Unchanged {
			fmt.Printf("  unchanged %s\n", label)
		}
		for _, skip := range report.Skipped {
			fmt.Printf("  skipped %s (%s)\n", skip.Nickname, skip.Reason)
		}
		for _, label := range report.MismatchMD5 {
			fmt.Printf("  md5 differs from the export manifest %s\n", label)
		}
		for _, name := range report.NoOwner {
			fmt.Printf("  owner not found for character %q; reported without a nickname\n", name)
		}
	}

	if *dryRun {
		fmt.Println("dry run: nothing was written")
	}
}

// openApp bootstraps a headless PocketBase against dataDir and applies the
// Aerun migrations, so the writer sees the real target schema — identical to
// the other writers of the migration (import-roles, import-users).
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
// writer CLI never binds an HTTP server, so ClearBootstrap is what releases the
// SQLite handles and lets the database be re-opened afterwards.
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
