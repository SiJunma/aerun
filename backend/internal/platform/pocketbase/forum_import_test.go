package pocketbase

// Tests for the forum writer (topics + posts).
//
// The sequence reaches the database here, which is the point: the planner's
// numbering is only worth anything if UNIQUE(topic_id, sequence) accepts it and
// if a re-run over its own output leaves it alone.

import (
	"testing"
)

func TestImportForumWritesSequenceAndProjections(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	_, categoryID := seedImportFixture(t, app)

	topics := []TopicUpsert{{
		TargetID:         "top000000000001",
		CategoryID:       categoryID,
		AuthorID:         fixPlayerID,
		Title:            "Imported topic",
		PostsCount:       2,
		LastPostID:       "pos000000000002",
		LastPostCreated:  "2026-01-02 03:04:05.000Z",
		LastPostAuthorID: fixPlayerID,
		CreatedAt:        "2026-01-01 00:00:00.000Z",
	}}
	posts := []PostUpsert{
		{
			TargetID:  "pos000000000001",
			TopicID:   "top000000000001",
			AuthorID:  fixPlayerID,
			Sequence:  1,
			Content:   "first",
			CreatedAt: "2026-01-01 01:00:00.000Z",
		},
		{
			TargetID:  "pos000000000002",
			TopicID:   "top000000000001",
			AuthorID:  fixPlayerID,
			Sequence:  2,
			Content:   "second",
			CreatedAt: "2026-01-02 03:04:05.000Z",
		},
	}

	first, err := ImportForum(app, topics, posts)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.TopicsCreated) != 1 || len(first.PostsCreated) != 2 {
		t.Fatalf("unexpected report: %+v", first)
	}

	topic, err := app.FindRecordById(topicsCollectionName, "top000000000001")
	if err != nil || topic == nil {
		t.Fatalf("topic not written: %v", err)
	}
	if topic.GetInt("posts_count") != 2 {
		t.Fatalf("posts_count must be written, got %d", topic.GetInt("posts_count"))
	}
	if topic.GetString("last_post_id") != "pos000000000002" {
		t.Fatalf("last_post_id must be written, got %q", topic.GetString("last_post_id"))
	}
	// The AutodateField has to carry the historical value: a typed Set would
	// rewrite it to "now" and the whole import would date-shift.
	if got := topic.GetDateTime("created").String(); got != "2026-01-01 00:00:00.000Z" {
		t.Fatalf("topics.created must be the historical date, got %q", got)
	}
	if got := topic.GetDateTime("last_post_created").String(); got != "2026-01-02 03:04:05.000Z" {
		t.Fatalf("last_post_created must be the historical date, got %q", got)
	}

	post, err := app.FindRecordById(postsCollectionName, "pos000000000002")
	if err != nil || post == nil {
		t.Fatalf("post not written: %v", err)
	}
	if post.GetInt("sequence") != 2 {
		t.Fatalf("sequence must be written, got %d", post.GetInt("sequence"))
	}
	if post.GetBool("is_draft") {
		t.Fatal("a published post must not be flagged as a draft")
	}

	second, err := ImportForum(app, topics, posts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Fatalf("a re-run must be a no-op, got %+v", second)
	}
}

// TestImportForumRefusesDuplicateSequence is the pre-transaction check. Without
// it, the UNIQUE index would abort the batch mid-way with an error that names a
// constraint rather than the two documents that collided.
func TestImportForumRefusesDuplicateSequence(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	_, categoryID := seedImportFixture(t, app)

	topics := []TopicUpsert{{
		TargetID: "top000000000002", CategoryID: categoryID, AuthorID: fixPlayerID,
		Title: "T", PostsCount: 2, LastPostCreated: "2026-01-01 00:00:00.000Z",
	}}
	posts := []PostUpsert{
		{TargetID: "pos000000000011", TopicID: "top000000000002", AuthorID: fixPlayerID,
			Sequence: 1, Content: "a"},
		{TargetID: "pos000000000012", TopicID: "top000000000002", AuthorID: fixPlayerID,
			Sequence: 1, Content: "b"},
	}

	_, err := ImportForum(app, topics, posts)
	if err == nil {
		t.Fatal("two posts claiming one sequence must be refused")
	}

	count, err := app.CountRecords(postsCollectionName, nil)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("a rejected batch must write nothing, got %d posts", count)
	}
	if _, err := app.FindRecordById(topicsCollectionName, "top000000000002"); err == nil {
		t.Fatal("a rejected batch must not leave its topic behind")
	}
}

// TestImportForumRefusesUnresolvedReferences pins the FK guard for both a topic
// and a post.
func TestImportForumRefusesUnresolvedReferences(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	_, categoryID := seedImportFixture(t, app)

	t.Run("topic with unknown category", func(t *testing.T) {
		_, err := ImportForum(app, []TopicUpsert{{
			TargetID: "top000000000003", CategoryID: "catnope000000001", AuthorID: fixPlayerID,
			Title: "T", LastPostCreated: "2026-01-01 00:00:00.000Z",
		}}, nil)
		if err == nil {
			t.Fatal("an unknown category must be refused")
		}
	})

	t.Run("post with unknown topic", func(t *testing.T) {
		_, err := ImportForum(app,
			[]TopicUpsert{{
				TargetID: "top000000000004", CategoryID: categoryID, AuthorID: fixPlayerID,
				Title: "T", LastPostCreated: "2026-01-01 00:00:00.000Z",
			}},
			[]PostUpsert{{
				TargetID: "pos000000000021", TopicID: "topnope000000001",
				AuthorID: fixPlayerID, Sequence: 1, Content: "x",
			}})
		if err == nil {
			t.Fatal("an unknown topic must be refused")
		}
	})
}

// TestImportForumWritesDraftWithoutSequence pins the draft contract at the
// storage layer: is_draft=true, sequence 0, and its text preserved.
func TestImportForumWritesDraftWithoutSequence(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	_, categoryID := seedImportFixture(t, app)

	_, err := ImportForum(app,
		[]TopicUpsert{{
			TargetID: "top000000000005", CategoryID: categoryID, AuthorID: fixPlayerID,
			Title: "T", PostsCount: 1, LastPostCreated: "2026-01-01 00:00:00.000Z",
			LastPostID: "pos000000000031",
		}},
		[]PostUpsert{
			{TargetID: "pos000000000031", TopicID: "top000000000005", AuthorID: fixPlayerID,
				Sequence: 1, Content: "live"},
			{TargetID: "pos000000000032", TopicID: "top000000000005", AuthorID: fixPlayerID,
				IsDraft: true, Sequence: 0, Content: "unsent"},
		})
	if err != nil {
		t.Fatal(err)
	}

	draft, err := app.FindRecordById(postsCollectionName, "pos000000000032")
	if err != nil || draft == nil {
		t.Fatalf("draft not written: %v", err)
	}
	if !draft.GetBool("is_draft") {
		t.Fatal("the draft flag must be stored")
	}
	if draft.GetInt("sequence") != 0 {
		t.Fatalf("a draft must carry sequence 0, got %d", draft.GetInt("sequence"))
	}
	if draft.GetString("content") != "unsent" {
		t.Fatal("a draft keeps its text: it is authored content that must survive")
	}
}

// TestImportForumKeepsEveryPostsText pins that the import no longer produces a
// tombstone. This test used to assert the opposite — that a Deleted post is
// written with an empty body and keeps its sequence slot — which was the
// soft-delete shape.
//
// Deletion is now a hard delete (1767700000 dropped the `deleted` column), so
// there is no such state: the importer SKIPS a legacy deleted post entirely and
// renumbers the survivors without leaving a hole. What this test now pins is
// that Content is written verbatim, so a real post can never be imported empty
// — the failure the tombstone path made indistinguishable from correct.
func TestImportForumKeepsEveryPostsText(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	_, categoryID := seedImportFixture(t, app)

	if _, err := ImportForum(app,
		[]TopicUpsert{{
			TargetID: "top000000000006", CategoryID: categoryID, AuthorID: fixPlayerID,
			Title: "T", PostsCount: 2, LastPostCreated: "2026-01-01 00:00:00.000Z",
			LastPostID: "pos000000000042",
		}},
		[]PostUpsert{
			{TargetID: "pos000000000041", TopicID: "top000000000006", AuthorID: fixPlayerID,
				Sequence: 1, Content: "opening"},
			{TargetID: "pos000000000042", TopicID: "top000000000006", AuthorID: fixPlayerID,
				Sequence: 2, Content: "still here"},
		}); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ id, want string }{
		{"pos000000000041", "opening"},
		{"pos000000000042", "still here"},
	} {
		post, err := app.FindRecordById(postsCollectionName, tc.id)
		if err != nil || post == nil {
			t.Fatalf("post %s missing: %v", tc.id, err)
		}
		if post.GetString("content") != tc.want {
			t.Errorf("post %s content = %q, want %q", tc.id, post.GetString("content"), tc.want)
		}
	}

	// The collection has no `deleted` column at all any more. Setting a field
	// that does not exist is a silent no-op that reads as a successful import,
	// so the assertion is that the SCHEMA lacks it.
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	if postsCol.Fields.GetByName("deleted") != nil {
		t.Error("posts must have no `deleted` column: deletion is a hard delete")
	}
}
