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

// TestImportForumWritesTombstoneWithoutContent pins the soft-delete shape.
func TestImportForumWritesTombstoneWithoutContent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	_, categoryID := seedImportFixture(t, app)

	_, err := ImportForum(app,
		[]TopicUpsert{{
			TargetID: "top000000000006", CategoryID: categoryID, AuthorID: fixPlayerID,
			Title: "T", PostsCount: 1, LastPostCreated: "2026-01-01 00:00:00.000Z",
			LastPostID: "pos000000000042",
		}},
		[]PostUpsert{
			{TargetID: "pos000000000041", TopicID: "top000000000006", AuthorID: fixPlayerID,
				Sequence: 1, Content: "gone", Deleted: true},
			{TargetID: "pos000000000042", TopicID: "top000000000006", AuthorID: fixPlayerID,
				Sequence: 2, Content: "still here"},
		})
	if err != nil {
		t.Fatal(err)
	}

	tombstone, err := app.FindRecordById(postsCollectionName, "pos000000000041")
	if err != nil || tombstone == nil {
		t.Fatalf("tombstone not written: %v", err)
	}
	if !tombstone.GetBool("deleted") {
		t.Fatal("the tombstone flag must be stored")
	}
	if tombstone.GetString("content") != "" {
		t.Fatalf("a tombstone must carry no text, got %q", tombstone.GetString("content"))
	}
	// It keeps its slot, which is the whole point of the rule.
	if tombstone.GetInt("sequence") != 1 {
		t.Fatalf("a tombstone must keep its sequence, got %d", tombstone.GetInt("sequence"))
	}
}
