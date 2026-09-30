// Command recompute-counters rebuilds the denormalised user counters from the
// rows that actually exist.
//
//	go run ./tools/migration/importer/cmd/recompute-counters -data migration-data/pb_data
//
// users.posts_count, users.topics_count and users.reputation are moved by the
// command layer when someone posts, deletes or votes — but only from the
// cutover onwards. A database populated by the import therefore has correct
// columns and zeros, which is exactly the state the members table shows as
// "0 posts" for everybody. This pass derives the same three numbers from the
// posts, topics and reputation_votes rows, so the values are the ones the
// forum's own data implies rather than a cached number carried over from
// Firestore (map §5: derived data is recomputed, never copied).
//
// It is idempotent and safe to re-run: every value is recomputed from the rows
// and a user whose counters are already correct is reported as unchanged
// instead of rewritten.
//
// -dry-run reports what would change and writes nothing.
//
// The report prints record ids and counters, never email addresses, so the log
// can be pasted into the plan journal (same rule as the other writers).
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	_ "github.com/SiJunma/aerun/backend/internal/migrations"
	pb "github.com/SiJunma/aerun/backend/internal/platform/pocketbase"
)

func main() {
	var (
		dataDir = flag.String("data", "", "PocketBase data directory to recompute")
		dryRun  = flag.Bool("dry-run", false, "report without writing")
	)
	flag.Parse()

	if *dataDir == "" {
		fmt.Fprintln(os.Stderr, "usage: recompute-counters -data <pb_data dir> [-dry-run]")
		os.Exit(2)
	}

	pbApp, err := openApp(*dataDir)
	if err != nil {
		fail("open", err)
	}
	defer closeApp(pbApp)

	report, err := pb.RecomputeUserCounters(pbApp, pb.UserCounterRecomputeOptions{
		DryRun: *dryRun,
	})
	if err != nil {
		fail("recompute", err)
	}

	verb := "updated"
	if *dryRun {
		verb = "would_update"
	}
	fmt.Printf("user_counters: %s=%d unchanged=%d changed=%t\n",
		verb, len(report.Updated), len(report.Unchanged), report.Changed())
	for _, id := range report.Updated {
		v := report.Values[id]
		fmt.Printf("  %s %s posts=%d topics=%d reputation=%d\n",
			verb, id, v.Posts, v.Topics, v.Rep)
	}

	// posts.reputation is a separate pass because it answers a different
	// question: not "how much has this member been voted" but "how much has this
	// one post been voted". It reads the same reputation_votes rows, restricted to
	// the votes that name a post.
	postReport, err := pb.RecomputePostReputation(pbApp, pb.PostReputationRecomputeOptions{
		DryRun: *dryRun,
	})
	if err != nil {
		fail("recompute post reputation", err)
	}
	fmt.Printf("post_reputation: %s=%d unchanged=%d changed=%t\n",
		verb, len(postReport.Updated), len(postReport.Unchanged), postReport.Changed())
	// Only the posts that actually carry votes are worth a log line; a post with
	// no votes going to 0 is the expected majority and 3000 identical lines would
	// bury the ones that changed.
	voted := make([]string, 0, 32)
	for id, score := range postReport.Values {
		if score != 0 {
			voted = append(voted, id)
		}
	}
	sort.Strings(voted)
	for _, id := range voted {
		fmt.Printf("  %s %s reputation=%d\n", verb, id, postReport.Values[id])
	}

	if *dryRun {
		fmt.Println("dry run: nothing was written")
	}
}

// openApp bootstraps a headless PocketBase against dataDir and applies the
// Aerun migrations, so the pass sees the real target schema — identical to the
// other writers (import-roles, import-users, import-avatars).
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

func fail(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}
