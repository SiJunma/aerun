package main

// Command verify-equivalence proves that importing one staging revision into two
// INDEPENDENT pb_data directories produces the same records.
//
//	verify-equivalence -a <pb_data A> -b <pb_data B>
//
// Why two databases and not two runs on one: two runs on one database prove
// idempotency — the second run changes nothing. They cannot prove determinism.
// A writer that derived an id from a map iteration order, or wrote a row only
// when another row happened to be present, produces identical results on the
// second run over its own leftovers and completely different results on a clean
// database. That is exactly the class of bug the board import is exposed to: the
// sequence reconstruction, the duplicate-collapse rules, the per-participant
// unread translation.
//
// The comparison excludes columns PocketBase owns. `created` and `updated` are
// AutodateFields: a re-saved row has its `updated` moved to the wall clock, and
// the two databases are written minutes apart by construction. Comparing them
// would report a difference on every row and hide a real one.
//
// Everything else is compared byte for byte, keyed by the derived id. Two ids
// that exist in A but not B are a difference, and so is a field that differs —
// the report names the row, the field and both values, so the difference is
// diagnosable without re-running.

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	_ "github.com/SiJunma/aerun/backend/internal/migrations"
)

// pbManagedFields are owned by PocketBase rather than by the import, so they
// cannot be expected to match across two databases written at different times.
var pbManagedFields = map[string]bool{
	"id":             true,
	"created":        true,
	"updated":        true,
	"expand":         true,
	"password":       true,
	"tokenKey":       true,
	"collectionId":   true,
	"collectionName": true,
}

func main() {
	var (
		dirA = flag.String("a", "", "first pb_data directory")
		dirB = flag.String("b", "", "second pb_data directory")
	)
	flag.Parse()

	if *dirA == "" || *dirB == "" {
		fmt.Fprintln(os.Stderr, "usage: verify-equivalence -a <pb_data A> -b <pb_data B>")
		os.Exit(2)
	}

	appA, err := openApp(*dirA)
	if err != nil {
		fail("open A", err)
	}
	defer closeApp(appA)
	appB, err := openApp(*dirB)
	if err != nil {
		fail("open B", err)
	}
	defer closeApp(appB)

	collections := append([]string(nil), importCollections...)
	sort.Strings(collections)

	totalDiffs, totalRows := 0, 0
	for _, name := range collections {
		rowsA, err := dumpCollection(appA, name)
		if err != nil {
			fail("dump "+name+" (A)", err)
		}
		rowsB, err := dumpCollection(appB, name)
		if err != nil {
			fail("dump "+name+" (B)", err)
		}
		diffs := diff(name, rowsA, rowsB)
		totalRows += len(rowsA)
		if len(diffs) == 0 {
			fmt.Printf("%-24s %6d rows  identical\n", name, len(rowsA))
			continue
		}
		totalDiffs += len(diffs)
		fmt.Printf("%-24s %6d rows  %d DIFFERENCE(S)\n", name, len(rowsA), len(diffs))
		for _, d := range diffs {
			fmt.Printf("    %s\n", d)
		}
	}

	fmt.Printf("\n%d rows compared across %d collections, %d differences\n",
		totalRows, len(collections), totalDiffs)
	if totalDiffs > 0 {
		os.Exit(1)
	}
	fmt.Println("EQUIVALENT: both databases hold the same records")
}

// importCollections are the collections the import owns, in the order the
// pipeline writes them.
//
// This is an explicit list rather than an enumeration of the database, and that
// is deliberate. An enumeration would compare whatever happens to exist — so a
// collection added by a later migration would be silently omitted from the proof
// until someone remembered, and a collection here that no longer exists would be
// reported as a difference. A named list makes the scope of the claim explicit,
// and a missing collection fails loudly below rather than being skipped.
var importCollections = []string{
	"roles",
	"users",
	"characters",
	"category_groups",
	"categories",
	"topics",
	"posts",
	"reputation_votes",
	"topic_subscriptions",
	"notifications",
	"dm_conversations",
	"dm_members",
	"dm_messages",
	"audit_logs",
}

// row is one record reduced to the columns the import owns.
type row map[string]string

// dumpCollection reads a collection into id -> row.
//
// The row is built from the record's own JSON representation rather than a
// hand-picked list of "interesting" columns: a difference in an unlisted column
// would otherwise pass silently, which is the one outcome this command exists to
// rule out. Going through the record's JSON also means a column the schema does
// not declare is still compared, so a writer that added one by accident shows up
// here instead of in production.
func dumpCollection(app core.App, name string) (map[string]row, error) {
	col, err := app.FindCollectionByNameOrId(name)
	if err != nil {
		return nil, fmt.Errorf("collection %s: %w", name, err)
	}
	recs, err := app.FindAllRecords(col, nil)
	if err != nil {
		return nil, err
	}
	out := make(map[string]row, len(recs))
	for _, rec := range recs {
		encoded, err := rec.MarshalJSON()
		if err != nil {
			return nil, fmt.Errorf("marshal %s/%s: %w", name, rec.Id, err)
		}
		var all map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &all); err != nil {
			return nil, fmt.Errorf("decode %s/%s: %w", name, rec.Id, err)
		}
		flat := make(map[string]string, len(all))
		for field, value := range all {
			if pbManagedFields[field] || strings.HasPrefix(field, "_") {
				continue
			}
			flat[field] = string(value)
		}
		out[rec.Id] = flat
	}
	return out, nil
}

// diff reports every way the two dumps disagree.
//
// The collection name is part of every message rather than only the caller's:
// a difference line is often the only artefact anyone reads, and "posts.sequence"
// is actionable while "sequence" is a puzzle.
func diff(collection string, a, b map[string]row) []string {
	prefix := collection + ": "
	var out []string
	for id, rowA := range a {
		rowB, ok := b[id]
		if !ok {
			out = append(out, fmt.Sprintf("%s%s present in A, absent in B", prefix, id))
			continue
		}
		fields := map[string]bool{}
		for f := range rowA {
			fields[f] = true
		}
		for f := range rowB {
			fields[f] = true
		}
		names := make([]string, 0, len(fields))
		for f := range fields {
			names = append(names, f)
		}
		sort.Strings(names)
		for _, f := range names {
			if rowA[f] != rowB[f] {
				out = append(out, fmt.Sprintf("%s%s.%s: A=%q B=%q", prefix, id, f, rowA[f], rowB[f]))
			}
		}
	}
	for id := range b {
		if _, ok := a[id]; !ok {
			out = append(out, fmt.Sprintf("%s%s present in B, absent in A", prefix, id))
		}
	}
	sort.Strings(out)
	return out
}

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
