package pocketbase

// TestMarkTopicReadColdVisitRace pins the cold-visit read race.
//
// The first time a topic is opened there is no topic_read_states row yet, and
// a page fires more than one concurrent POST /read (double-fired effects,
// mark + visit paths). Both writers used to look the row up, both saw
// "absent", both inserted, and the loser hit the unique (user_id, topic_id)
// violation — which PocketBase v0.40 wraps into a validation error whose
// field codes never appear in err.Error(), so the handler's string-match
// guard missed it and the very first visit answered 500
// "failed to save read state". Every later visit took the update path and
// never reproduced.
//
// The contract this test pins: every concurrent cold mark succeeds with 200,
// and the surviving state is exactly one read row.
import (
	"database/sql"
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// staleLookupApp forces the first N FindFirstRecordByFilter calls to report
// "no row" even when the row exists — the exact stale read a loser of the
// insert race performs: its lookup ran before the concurrent commit, its
// INSERT ran after it.
type staleLookupApp struct {
	core.App
	pendingMisses int
}

func (a *staleLookupApp) FindFirstRecordByFilter(
	collectionModelOrIdentifier any,
	filter string,
	params ...dbx.Params,
) (*core.Record, error) {
	if a.pendingMisses > 0 {
		a.pendingMisses--
		return nil, sql.ErrNoRows
	}
	return a.App.FindFirstRecordByFilter(collectionModelOrIdentifier, filter, params...)
}

// TestUpsertTopicReadStateLosesInsertRaceGracefully reproduces the cold-visit
// race deterministically at the level the bug lives: the loser's lookup saw
// "absent", so its INSERT collides with the committed winner's row. PocketBase
// v0.40 normalizes that SQLite violation into validation.Errors whose Error()
// text is "topic_id: Value must be unique.; user_id: Value must be unique." —
// it carries neither the "validation_not_unique" field code nor the raw
// "UNIQUE constraint failed" message, so the old string-match guard missed it
// and the handler answered 500 "failed to save read state" on the very first
// visit to a topic. The loser must degrade into the same forward-only update
// a warm visit performs.
func TestUpsertTopicReadStateLosesInsertRaceGracefully(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	topicID := seedDraftTopic(t, app, fixPlayerID, "Race topic")
	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil {
		t.Fatalf("find seeded topic: %v", err)
	}
	postID := topic.GetString("last_post_id")
	if postID == "" {
		t.Fatalf("seeded topic carries no last_post_id")
	}
	created := topic.GetDateTime("last_post_created").String()

	// The winner: the concurrent writer that committed the row first.
	if err := upsertTopicReadState(app, fixPlayerID, topicID, postID, created, postID); err != nil {
		t.Fatalf("winner insert: %v", err)
	}

	// The loser: stale "absent" lookup, then the real unique violation.
	loser := &staleLookupApp{App: app, pendingMisses: 1}
	if err := upsertTopicReadState(loser, fixPlayerID, topicID, postID, created, postID); err != nil {
		t.Fatalf("loser of the insert race surfaced an error to the client: %v", err)
	}

	// Exactly one row must survive, pinned to the post the screen rendered.
	rows, err := app.FindRecordsByFilter(
		topicReadStatesCollectionName,
		"user_id = {:user} && topic_id = {:topic}",
		"", 10, 0,
		dbx.Params{"user": fixPlayerID, "topic": topicID},
	)
	if err != nil {
		t.Fatalf("read states lookup: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("topic_read_states rows = %d, want exactly 1", len(rows))
	}
	if id := rows[0].GetString("last_read_post_id"); id != postID {
		t.Errorf("last_read_post_id = %q, want %q (the cursor pins to the rendered post)", id, postID)
	}
}

func TestMarkTopicReadColdVisitRace(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// A real topic through the real endpoint, so the opening post id the
	// client pins to is the one the server validates against.
	status, payload := doJSON(t, server.URL, http.MethodPost,
		"/api/aerun/topics",
		tokens["player"], "idem-read-race-1",
		fmt.Sprintf(`{"category_id":"%s","title":"Race Topic","content":"Body"}`, catID))
	if status != http.StatusCreated {
		t.Fatalf("create topic: got %d, want 201 (%v)", status, payload)
	}
	topicID, _ := payload["topic_id"].(string)
	if topicID == "" {
		t.Fatalf("create response carries no `topic_id`: %#v", payload)
	}
	firstPost, _ := payload["first_post"].(map[string]any)
	if firstPost == nil {
		t.Fatalf("create response carries no `first_post`: %#v", payload)
	}
	firstPostID, _ := firstPost["id"].(string)
	if firstPostID == "" {
		t.Fatalf("first_post.id is empty: %#v", firstPost)
	}

	// The cold-visit race: many concurrent marks for a topic with no read
	// row. All must succeed — a member who opened a topic must never see
	// the badge fail behind a 500.
	const writers = 12
	statuses := make([]int, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			st, _ := doJSON(t, server.URL, http.MethodPost,
				fmt.Sprintf("/api/aerun/topics/%s/read", topicID),
				tokens["player"], "",
				fmt.Sprintf(`{"last_visible_post_id":%q}`, firstPostID))
			statuses[i] = st
		}(i)
	}
	wg.Wait()

	for i, st := range statuses {
		if st != http.StatusOK {
			t.Errorf("cold mark #%d: got %d, want 200 — the cold-visit race surfaced an error to the client", i, st)
		}
	}

	// Exactly one row must survive: the upsert degrades to a forward-only
	// update, never to parallel inserts.
	rows, err := app.FindRecordsByFilter(
		"topic_read_states",
		"user_id = {:user} && topic_id = {:topic}",
		"", 10, 0,
		dbx.Params{"user": fixPlayerID, "topic": topicID},
	)
	if err != nil {
		t.Fatalf("read states lookup: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("topic_read_states rows = %d, want exactly 1", len(rows))
	}
	if len(rows) == 1 {
		if id := rows[0].GetString("last_read_post_id"); id != firstPostID {
			t.Errorf("last_read_post_id = %q, want %q (the cursor pins to the post the screen rendered)",
				id, firstPostID)
		}
	}
}
