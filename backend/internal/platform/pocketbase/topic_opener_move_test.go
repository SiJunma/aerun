package pocketbase

// TestMovingTheOpeningPostRefilesTheOpener pins the owner ruling of
// 2026-11-01: moving a topic's opening post does NOT delete the topic — the
// next earliest post becomes the opener, and the opener AuthorRef (a
// projection of the post row) must be re-filed in the same transaction. The
// old UI copy claimed "moving this will delete the source topic"; the server
// never did that, and the ruling keeps the softer behaviour official.
//
// Also pinned: a topic whose EVERY post is moved away survives as an emptied
// row whose opener projection is cleared — it must not keep naming an author
// whose post is gone.
import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestMovingTheOpeningPostRefilesTheOpener(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatalf("topics collection: %v", err)
	}
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatalf("posts collection: %v", err)
	}

	// pB1 is created FIRST: after the move it must stay Topic B's earliest
	// post, so B's opener must survive unchanged (the moved post arrives
	// later by `created`). This is the idempotence half of the contract.
	topicB := core.NewRecord(topicsCol)
	topicB.Set("category_id", catID)
	topicB.Set("title", "Topic B")
	setAccountAuthorRef(topicB, fixPlayerID)
	topicB.Set("posts_count", 1)
	if err := app.Save(topicB); err != nil {
		t.Fatalf("topic B: %v", err)
	}

	topicA := core.NewRecord(topicsCol)
	topicA.Set("category_id", catID)
	topicA.Set("title", "Topic A")
	setAccountAuthorRef(topicA, fixPlayerID)
	topicA.Set("posts_count", 2)
	if err := app.Save(topicA); err != nil {
		t.Fatalf("topic A: %v", err)
	}

	// The opener (player) and the follower (moderator) have DIFFERENT
	// authors, so a stale opener would be observable: if the projection is
	// not re-filed, the topic still names the player after their post left.
	pA1 := core.NewRecord(postsCol)
	pA1.Set("topic_id", topicA.Id)
	setAccountAuthorRef(pA1, fixPlayerID)
	pA1.Set("content", "opening post")
	if err := app.Save(pA1); err != nil {
		t.Fatalf("pA1: %v", err)
	}

	pA2 := core.NewRecord(postsCol)
	pA2.Set("topic_id", topicA.Id)
	setAccountAuthorRef(pA2, fixModeratorID)
	pA2.Set("content", "the follower")
	if err := app.Save(pA2); err != nil {
		t.Fatalf("pA2: %v", err)
	}

	pB1 := core.NewRecord(postsCol)
	pB1.Set("topic_id", topicB.Id)
	setAccountAuthorRef(pB1, fixPlayerID)
	pB1.Set("content", "B's opener")
	if err := app.Save(pB1); err != nil {
		t.Fatalf("pB1: %v", err)
	}

	// Topic C holds a SINGLE post: moving it empties the topic — the row
	// survives with a cleared opener, never a deletion.
	topicC := core.NewRecord(topicsCol)
	topicC.Set("category_id", catID)
	topicC.Set("title", "Topic C")
	setAccountAuthorRef(topicC, fixPlayerID)
	topicC.Set("posts_count", 1)
	if err := app.Save(topicC); err != nil {
		t.Fatalf("topic C: %v", err)
	}
	pC1 := core.NewRecord(postsCol)
	pC1.Set("topic_id", topicC.Id)
	setAccountAuthorRef(pC1, fixPlayerID)
	pC1.Set("content", "C's only post")
	if err := app.Save(pC1); err != nil {
		t.Fatalf("pC1: %v", err)
	}

	server := newTestServer(t, app)
	defer server.Close()

	// Moderator moves Topic A's OPENER to Topic B.
	status, payload := doJSON(t, server.URL, http.MethodPost,
		"/api/aerun/topics/"+topicA.Id+"/posts/move", tokens["moderator"], "move-opener-1",
		`{"target_topic_id":"`+topicB.Id+`","post_ids":["`+pA1.Id+`"]}`)
	if status != http.StatusOK {
		t.Fatalf("move opener: got %d, want 200 (%v)", status, payload)
	}

	afterA, err := app.FindRecordById(topicsCollectionName, topicA.Id)
	if err != nil || afterA == nil {
		t.Fatalf("topic A not found after the move: %v — moving the opener must NOT delete the topic", err)
	}
	if got := afterA.GetInt("posts_count"); got != 1 {
		t.Errorf("topic A posts_count = %d, want 1", got)
	}
	if got := afterA.GetString("author_id"); got != fixModeratorID {
		t.Errorf("topic A opener = %q, want the follower's author %q — the opener projection must be re-filed to the next earliest post", got, fixModeratorID)
	}
	if got := afterA.GetString(authorKindField); got != authorKindAccount {
		t.Errorf("topic A opener kind = %q, want %q", got, authorKindAccount)
	}

	afterB, err := app.FindRecordById(topicsCollectionName, topicB.Id)
	if err != nil || afterB == nil {
		t.Fatalf("topic B not found after the move: %v", err)
	}
	if got := afterB.GetInt("posts_count"); got != 2 {
		t.Errorf("topic B posts_count = %d, want 2", got)
	}
	// pB1 is still the earliest post in B (`created` travels with the row),
	// so the re-file must have rewritten identical values, not moved the
	// opener onto the arrived post.
	if got := afterB.GetString("author_id"); got != fixPlayerID {
		t.Errorf("topic B opener = %q, want %q — a move that did not touch the earliest post must not re-file the opener", got, fixPlayerID)
	}

	// Emptied topic: moving C's ONLY post clears the opener projection and
	// leaves the row alive.
	status, payload = doJSON(t, server.URL, http.MethodPost,
		"/api/aerun/topics/"+topicC.Id+"/posts/move", tokens["moderator"], "move-opener-2",
		`{"target_topic_id":"`+topicB.Id+`","post_ids":["`+pC1.Id+`"]}`)
	if status != http.StatusOK {
		t.Fatalf("move C's only post: got %d, want 200 (%v)", status, payload)
	}

	afterC, err := app.FindRecordById(topicsCollectionName, topicC.Id)
	if err != nil || afterC == nil {
		t.Fatalf("topic C not found after its only post left: %v — an emptied topic must survive as a husk", err)
	}
	if got := afterC.GetInt("posts_count"); got != 0 {
		t.Errorf("topic C posts_count = %d, want 0", got)
	}
	if got := afterC.GetString("author_id"); got != "" {
		t.Errorf("topic C opener = %q, want empty — a husk must not keep naming an author whose post is gone", got)
	}
}
