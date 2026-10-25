// Command import-settings writes the legacy global forum settings from the
// staging ledger into the PocketBase `forum_settings` singleton row.
//
// The server reads every global setting from that row (loadForumSettings),
// but the importer never wrote the real values there — they were reported as
// PB_SETTINGS_* env vars instead. This command closes the gap.
//
// \tgo run ./tools/migration/importer/cmd/import-settings \\\n\t    -data pb_data -ledger migration-data/stage-2.json
//
// Re-running converges: every field is compared against the stored value
// before writing, so a second run reports no change.
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
		authPath   = flag.String("auth", "", "official Firebase Auth export JSON (optional)")
		dryRun     = flag.Bool("dry-run", false, "plan and report without writing")
	)
	flag.Parse()

	if *ledgerPath == "" {
		fmt.Fprintln(os.Stderr,
			"usage: import-settings -ledger <stage.json> [-auth <auth-export.json>] "+
				"[-data <pb_data dir>] [-dry-run] [-verbose]")
		os.Exit(2)
	}
	if *dataDir == "" && !*dryRun {
		fmt.Fprintln(os.Stderr, "usage: import-settings -data <pb_data dir> -ledger <stage.json> [...] (or -dry-run)")
		os.Exit(2)
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	ledger, err := importer.LoadStagingLedger(*ledgerPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load staging ledger: %v\n", err)
		os.Exit(1)
	}

	var authExport *importer.AuthExport
	if *authPath != "" {
		authExport, err = importer.LoadAuthExport(*authPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "load auth export: %v\n", err)
			os.Exit(1)
		}
	}

	plan, err := importer.BuildPlan(ledger, authExport, logger)
	if err != nil {
		fmt.Fprintf(os.Stderr, "build import plan: %v\n", err)
		os.Exit(1)
	}

	u := pb.SettingsFromLedger(plan.GlobalSettings)
	if u == nil {
		fmt.Println("settings/global: not found in ledger; nothing to import")
		os.Exit(0)
	}

	if *dryRun {
		keys := u.SortedKeys()
		fmt.Printf("settings: planned=%d fields\n", len(keys))
		for _, k := range keys {
			fmt.Printf("  %s\n", k)
		}
		fmt.Println("dry-run: no records written")
		return
	}

	pbApp, err := openApp(*dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open pocketbase data dir: %v\n", err)
		os.Exit(1)
	}
	defer closeApp(pbApp)

	report, err := pb.ImportSettings(pbApp, u)
	if err != nil {
		fmt.Fprintf(os.Stderr, "import settings: %v\n", err)
		os.Exit(1)
	}

	keys := u.SortedKeys()
	fmt.Printf("settings: fields=%d", len(keys))
	if report.Created {
		fmt.Print(" created")
	}
	if report.Updated {
		fmt.Print(" updated")
	}
	if report.Unchanged {
		fmt.Print(" unchanged")
	}
	fmt.Println()
	for _, k := range keys {
		fmt.Printf("  %s\n", k)
	}
	if !report.Changed {
		fmt.Println("  (no changes)")
	}
}

// openApp bootstraps a headless PocketBase against dataDir and applies the
// Aerun migrations, so the writer sees the real target schema.
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

// closeApp shuts the headless app down through PocketBase's terminate hook.
func closeApp(pbApp *pocketbase.PocketBase) {
	_ = pbApp.OnTerminate().Trigger(&core.TerminateEvent{App: pbApp},
		func(e *core.TerminateEvent) error {
			return e.App.ClearBootstrap()
		})
}
