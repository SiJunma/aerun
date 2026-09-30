// Command import-board writes the legacy board structure into the target:
// category groups, categories, topics, posts and drafts (levels L2, L3, L5 and
// L6 of POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md §5).
//
//	go run ./tools/migration/importer/cmd/import-board \
//	    -data pb_data -ledger migration-data/stage-1.json
//
// One command rather than four, because the levels are strictly ordered and each
// one needs the previous to have landed:
//
//	L2 category_groups ─► L3 categories ─► L5 topics ─► L6 posts + drafts
//
// It runs as one ordered pipeline and checks each precondition against the
// TARGET database (not against the plan), because "is this reference resolvable"
// is only authoritative once the referenced row exists. Running the levels in the
// wrong order would write a topic pointing at a category that is not there yet.
//
// The sequence of every topic's posts is reconstructed from created_at — the
// legacy documents carry none — so this command is the only place where a reply
// order can be rewritten. It is done in the planner (importer/forum.go) and
// validated here against UNIQUE(topic_id, sequence) before anything is written.
//
// Re-running converges: every row is keyed by its derived id, so a second run
// over the same export reports everything unchanged.
//
// -dry-run plans and reports without touching any database, so it is safe to
// point at a snapshot before the target database exists.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"sort"

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
		authPath   = flag.String("auth", "", "official Firebase Auth export JSON (optional)")
		dryRun     = flag.Bool("dry-run", false, "plan and report without writing")
		verbose    = flag.Bool("verbose", false, "print every planned row, not just the counts")
	)
	flag.Parse()

	if *ledgerPath == "" {
		fmt.Fprintln(os.Stderr,
			"usage: import-board -ledger <stage.json> [-auth <auth-export.json>] "+
				"[-data <pb_data dir>] [-dry-run] [-verbose]")
		os.Exit(2)
	}
	if *dataDir == "" && !*dryRun {
		fmt.Fprintln(os.Stderr, "usage: import-board -data <pb_data dir> -ledger <stage.json> [...] (or -dry-run)")
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
		// No database to ask, so every reference is assumed present and the report
		// says so: the checks belong to the real run, which is the only place the
		// answer is authoritative.
		runDryRun(plan, targetRoleIDs(nil), *verbose)
		fmt.Println("dry-run: no records written")
		return
	}

	pbApp, err := openApp(*dataDir)
	if err != nil {
		fail("open pocketbase data dir", err)
	}
	defer closeApp(pbApp)

	if err := runImport(pbApp, plan, *verbose); err != nil {
		fail("import board", err)
	}
}

// targetRoleIDs reads the role ids the target registry actually holds.
//
// The roles writer runs before this one, so the authoritative answer is a query.
// When app is nil (a dry run) the compiled matrix is used instead — the six
// system roles are seeded by migration 1766000000 on any target, so a dry run
// against a fresh database would produce exactly this list anyway.
//
// Reading the target rather than the compiled matrix matters for exactly one
// reason: the custom roles. A category that grants visibility to a custom role
// id is only importable if that role row exists, and only the target knows.
func targetRoleIDs(app *pocketbase.PocketBase) []string {
	if app == nil {
		ids := make([]string, 0, len(auth.SystemRoles()))
		for _, spec := range auth.SystemRoles() {
			ids = append(ids, string(spec.Role))
		}
		sort.Strings(ids)
		return ids
	}
	records, err := app.FindAllRecords("roles", nil)
	if err != nil {
		fail("read roles registry", err)
	}
	ids := make([]string, 0, len(records))
	for _, rec := range records {
		ids = append(ids, rec.GetString("role_id"))
	}
	sort.Strings(ids)
	return ids
}

// importedUIDs resolves which legacy Firebase UIDs reached the target, through
// the users.legacy_firebase_uid column the account writer fills.
//
// This is the same predicate import-characters uses, and for the same reason: the
// legacy uid is the only bridge between a Firestore document id and the derived
// PocketBase id, and deriving it again would be a second, driftable mapping.
func importedUIDs(app *pocketbase.PocketBase) (func(string) bool, error) {
	users, err := app.FindAllRecords("users", nil)
	if err != nil {
		return nil, err
	}
	byLegacy := make(map[string]bool, len(users))
	for _, rec := range users {
		if uid := rec.GetString("legacy_firebase_uid"); uid != "" {
			byLegacy[uid] = true
		}
	}
	return func(uid string) bool { return byLegacy[uid] }, nil
}

// runImport runs the whole chain in dependency order against the target.
//
// The order is the point of the command, and each level re-reads what the
// previous one wrote rather than assuming its own plan:
//
//	L2 category_groups -> L3 categories -> L5 topics -> L6 posts + drafts
//
// A category's allowed_roles comes from the roles registry, so the roles writer
// (import-roles) must have run first. A topic's category must exist, so L3 must
// have run first. Both are checked against the TARGET, which is the only place
// the answer is authoritative — a planner can only guess.
func runImport(app *pocketbase.PocketBase, plan *importer.ImportPlan, verbose bool) error {
	roleIDs := targetRoleIDs(app)
	fmt.Printf("roles in target: %d\n", len(roleIDs))

	// --- L2 + L3 ---------------------------------------------------------
	cp := importer.BuildCategoryPlan(plan, roleIDs)
	reportCategoryPlan(cp, verbose)

	groupReport, err := pb.ImportCategoryGroups(app, categoryGroupUpserts(cp))
	if err != nil {
		return fmt.Errorf("category groups: %w", err)
	}
	fmt.Printf("L2 category_groups: created=%d updated=%d unchanged=%d extra=%d\n",
		len(groupReport.GroupsCreated), len(groupReport.GroupsUpdated),
		len(groupReport.GroupsUnchanged), len(groupReport.ExtraTargetIDs))

	categoryReport, err := pb.ImportCategories(app, categoryUpserts(cp))
	if err != nil {
		return fmt.Errorf("categories: %w", err)
	}
	fmt.Printf("L3 categories: created=%d updated=%d unchanged=%d extra=%d\n",
		len(categoryReport.CategoriesCreated), len(categoryReport.CategoriesUpdated),
		len(categoryReport.CategoriesUnchanged), len(categoryReport.ExtraTargetIDs))
	for _, id := range categoryReport.ExtraTargetIDs {
		fmt.Printf("  extra (already imported, not in this batch, left alone) %s\n", id)
	}

	// --- L5 + L6 ---------------------------------------------------------
	// The category predicate asks the TARGET whether a derived row exists, not
	// what this run happened to write. The difference is not academic: reading
	// it off the report's `created` list would make a second run skip every
	// topic, because on a converged database nothing is "created" any more.
	// A row imported by an earlier run of this very command has to count too, or
	// the pipeline is not idempotent — which is the property the whole importer
	// rests on.
	present := presentCategories(app)

	userExists, err := importedUIDs(app)
	if err != nil {
		return fmt.Errorf("read users: %w", err)
	}

	fp := importer.BuildForumPlan(plan, userExists, present)
	reportForumPlan(fp, verbose)

	forumReport, err := pb.ImportForum(app, topicUpserts(fp), postUpserts(fp))
	if err != nil {
		return fmt.Errorf("forum: %w", err)
	}
	fmt.Printf("L5 topics: created=%d updated=%d extra=%d\n",
		len(forumReport.TopicsCreated), len(forumReport.TopicsUpdated),
		len(forumReport.ExtraTopicIDs))
	fmt.Printf("L6 posts:  created=%d updated=%d extra=%d (drafts included, sequence 0)\n",
		len(forumReport.PostsCreated), len(forumReport.PostsUpdated),
		len(forumReport.ExtraPostIDs))
	fmt.Printf("sequences assigned: %d\n", fp.SequenceCount)
	return nil
}

// presentCategories reports whether a LEGACY category id resolves to a row in
// the target.
//
// It asks the database rather than the report because "is this reference
// resolvable" is a question about the target, and only the target answers it.
// Matching on the derived id is what makes it correct: the writer keys every row
// by DeriveID(SpaceCategory, legacyID), so reproducing that function on the
// legacy id finds exactly the row that import would have written — including
// one written by an earlier run.
func presentCategories(app *pocketbase.PocketBase) func(string) bool {
	rows, err := app.FindAllRecords("categories", nil)
	if err != nil {
		fail("read categories", err)
	}
	present := make(map[string]bool, len(rows))
	for _, rec := range rows {
		present[rec.Id] = true
	}
	return func(legacyID string) bool {
		return present[importer.DeriveID(importer.SpaceCategory, legacyID)]
	}
}

func categoryGroupUpserts(cp *importer.CategoryPlan) []pb.CategoryGroupUpsert {
	out := make([]pb.CategoryGroupUpsert, 0, len(cp.GroupRows))
	for _, row := range cp.GroupRows {
		out = append(out, pb.CategoryGroupUpsert{
			TargetID:  row.TargetID,
			Title:     row.Title,
			SortOrder: row.SortOrder,
			CreatedAt: row.CreatedAt,
			UpdatedAt: row.UpdatedAt,
		})
	}
	return out
}

func categoryUpserts(cp *importer.CategoryPlan) []pb.CategoryUpsert {
	out := make([]pb.CategoryUpsert, 0, len(cp.CategoryRows))
	for _, row := range cp.CategoryRows {
		out = append(out, pb.CategoryUpsert{
			TargetID:     row.TargetID,
			GroupID:      row.GroupID,
			Name:         row.Title,
			Slug:         row.Slug,
			Description:  row.Description,
			SortOrder:    row.SortOrder,
			AllowedRoles: row.AllowedRoles,
			CreatedAt:    row.CreatedAt,
			UpdatedAt:    row.UpdatedAt,
		})
	}
	return out
}

func topicUpserts(fp *importer.ForumPlan) []pb.TopicUpsert {
	out := make([]pb.TopicUpsert, 0, len(fp.TopicRows))
	for _, row := range fp.TopicRows {
		out = append(out, pb.TopicUpsert{
			TargetID:         row.TargetID,
			CategoryID:       row.CategoryID,
			AuthorID:         row.AuthorID,
			Title:            row.Title,
			Locked:           row.Locked,
			Pinned:           row.Pinned,
			Deleted:          row.Deleted,
			PostsCount:       row.PostsCount,
			LastPostID:       row.LastPostID,
			LastPostCreated:  row.LastPostCreated,
			LastPostAuthorID: row.LastPostAuthorID,
			Reputation:       row.Reputation,
			CreatedAt:        row.CreatedAt,
			UpdatedAt:        row.UpdatedAt,
		})
	}
	return out
}

func postUpserts(fp *importer.ForumPlan) []pb.PostUpsert {
	out := make([]pb.PostUpsert, 0, len(fp.PostRows))
	for _, row := range fp.PostRows {
		out = append(out, pb.PostUpsert{
			TargetID:        row.TargetID,
			TopicID:         row.TopicID,
			AuthorID:        row.AuthorID,
			Sequence:        row.Sequence,
			IsDraft:         row.IsDraft,
			Deleted:         row.Deleted,
			Content:         row.Content,
			Reputation:      row.Reputation,
			EditedAt:        row.EditedAt,
			AuthorCharacter: row.AuthorCharacter,
			CreatedAt:       row.CreatedAt,
			UpdatedAt:       row.UpdatedAt,
		})
	}
	return out
}

// runDryRun plans every level without a database. Every reference is assumed
// present, and the report says so, because the checks belong to the real run.
func runDryRun(plan *importer.ImportPlan, roleIDs []string, verbose bool) {
	cp := importer.BuildCategoryPlan(plan, roleIDs)
	reportCategoryPlan(cp, verbose)

	fp := importer.BuildForumPlan(plan,
		func(string) bool { return true },
		func(string) bool { return true })
	reportForumPlan(fp, verbose)

	fmt.Printf("planned: groups=%d categories=%d topics=%d posts=%d sequences=%d\n",
		len(cp.GroupRows), len(cp.CategoryRows), len(fp.TopicRows), len(fp.PostRows),
		fp.SequenceCount)
}

// reportCategoryPlan prints the planned categories. The allowed_roles list is
// printed per row on request, because it is the one field whose content decides
// who can see a board section.
func reportCategoryPlan(cp *importer.CategoryPlan, verbose bool) {
	fmt.Printf("L2+L3 planned: groups=%d categories=%d skipped_groups=%d skipped_categories=%d\n",
		len(cp.GroupRows), len(cp.CategoryRows),
		len(cp.SkippedGroupIDs), len(cp.SkippedCategoryIDs))
	for _, line := range cp.SortedFindingLines() {
		fmt.Printf("  finding %s\n", line)
	}
	for _, id := range cp.SkippedGroupIDs {
		fmt.Printf("  skipped group %s (see the finding above; never written)\n", id)
	}
	for _, id := range cp.SkippedCategoryIDs {
		fmt.Printf("  skipped category %s (see the finding above; never written)\n", id)
	}
	if !verbose {
		return
	}
	for _, line := range cp.SortedRowLines() {
		fmt.Printf("  %s\n", line)
	}
}

func reportForumPlan(fp *importer.ForumPlan, verbose bool) {
	fmt.Printf("L5+L6 planned: topics=%d posts=%d skipped_topics=%d skipped_posts=%d sequences=%d\n",
		len(fp.TopicRows), len(fp.PostRows),
		len(fp.SkippedTopicIDs), len(fp.SkippedPostIDs), fp.SequenceCount)
	for _, line := range fp.SortedFindingLines() {
		fmt.Printf("  finding %s\n", line)
	}
	for _, id := range fp.SkippedTopicIDs {
		fmt.Printf("  skipped topic %s (see the finding above; never written)\n", id)
	}
	for _, id := range fp.SkippedPostIDs {
		fmt.Printf("  skipped post %s (see the finding above; never written)\n", id)
	}
	if !verbose {
		return
	}
	for _, line := range fp.SortedRowLines() {
		fmt.Printf("  %s\n", line)
	}
}

func fail(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}

// openApp bootstraps a headless PocketBase against dataDir and applies the
// Aerun migrations, so the writer sees the real target schema — identical to the
// other writers (import-roles, import-users, import-characters).
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
// mirroring the production path in internal/platform/pocketbase/run.go.
func closeApp(pbApp *pocketbase.PocketBase) {
	if err := pbApp.OnTerminate().Trigger(&core.TerminateEvent{App: pbApp},
		func(e *core.TerminateEvent) error {
			return e.App.ClearBootstrap()
		}); err != nil {
		fmt.Fprintf(os.Stderr, "shutdown: %v\n", err)
	}
}
