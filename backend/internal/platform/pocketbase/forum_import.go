package pocketbase

// Forum import (Sprint 7 writers, levels L5 and L6).
//
// Topics and posts are written together, in one transaction, because the target
// cannot represent them apart:
//
//   - `topics.posts_count` and the `last_post_*` projection are denormalised from
//     the post rows (1766100000), and the runtime treats them as authoritative.
//     Writing a topic first and its posts afterwards would leave a window where
//     the topic claims replies that do not exist yet.
//   - `posts.sequence` participates in UNIQUE(topic_id, sequence). The caller
//     assigns the numbers (see importer/forum.go, which reconstructs them from
//     the legacy timestamps); this writer only checks that the assignment is
//     internally consistent before it opens the transaction.
//
// Two properties are enforced here rather than trusted:
//
//   - **A duplicate (topic, sequence) is refused before the transaction opens.**
//     The UNIQUE index would catch it too, but as a SQLite error in the middle of
//     a 3000-row batch, which tells an operator nothing about which two documents
//     collided.
//   - **Every reference is verified to exist** (category, author, the posts'
//     topic). A topic whose category never imported is a board section that would
//     render with no breadcrumb; catching it here names the row.
//
// A row present in the target but absent from the batch is reported, never
// deleted.

import (
	"fmt"
	"sort"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// TopicUpsert is the desired state of one topics row.
type TopicUpsert struct {
	TargetID   string
	CategoryID string
	AuthorID   string
	Title      string
	Locked     bool
	Pinned     bool
	Deleted    bool
	// PostsCount and the last_post_* projection are RECOMPUTED by the importer and
	// written here as-is. They are never copied from the legacy cached values.
	PostsCount       int
	LastPostID       string
	LastPostCreated  string
	LastPostAuthorID string
	// CreatedAt / UpdatedAt override the Autodate columns. The topics collection
	// uses AutodateField, so a historical date has to be written through SetRaw.
	CreatedAt string
	UpdatedAt string
}

// PostUpsert is the desired state of one posts row.
type PostUpsert struct {
	TargetID string
	TopicID  string
	AuthorID string
	// Sequence is the per-topic ordinal, 1..n. A draft carries 0: the unique
	// index is partial on sequence > 0, so any number of drafts can coexist in one
	// topic (1766700000).
	Sequence   int
	IsDraft    bool
	Deleted    bool
	Content    string
	Reputation int
	EditedAt   string
	// AuthorCharacter references the frozen mask identity (ADR-5). It is only
	// written when the posts collection carries the column, so the writer works
	// against the schema the target actually has.
	AuthorCharacter string
	CreatedAt       string
	UpdatedAt       string
}

// ForumImportReport states what the import changed.
type ForumImportReport struct {
	TopicsCreated []string
	TopicsUpdated []string
	PostsCreated  []string
	PostsUpdated  []string
	ExtraTopicIDs []string
	ExtraPostIDs  []string
}

// Changed reports whether the import modified anything.
func (r ForumImportReport) Changed() bool {
	return len(r.TopicsCreated) > 0 || len(r.TopicsUpdated) > 0 ||
		len(r.PostsCreated) > 0 || len(r.PostsUpdated) > 0
}

// ImportForum makes the topics and posts collections match the upserts.
//
// Topics are written before posts so a post's topic_id resolves the moment it is
// saved; the projections were already computed by the caller from the same rows,
// so the pair lands consistent inside one commit.
func ImportForum(app core.App, topics []TopicUpsert, posts []PostUpsert) (ForumImportReport, error) {
	report := ForumImportReport{}
	if err := validateForumUpserts(topics, posts); err != nil {
		return report, err
	}
	if len(topics) == 0 && len(posts) == 0 {
		return report, nil
	}

	topicCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		return report, fmt.Errorf("topics collection unavailable: %w", err)
	}
	postCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		return report, fmt.Errorf("posts collection unavailable: %w", err)
	}
	// author_character_id arrives with a later migration; asking the schema keeps
	// this writer working on a database that predates it.
	postsCarryCharacter := postCol.Fields.GetByName("author_character_id") != nil

	err = app.RunInTransaction(func(txApp core.App) error {
		categories := map[string]bool{}
		if col, cerr := txApp.FindCollectionByNameOrId(categoriesCollectionName); cerr == nil {
			rows, err := txApp.FindAllRecords(col, nil)
			if err != nil {
				return fmt.Errorf("read categories: %w", err)
			}
			for _, rec := range rows {
				categories[rec.Id] = true
			}
		}
		users := map[string]bool{}
		if col, uerr := txApp.FindCollectionByNameOrId(usersCollectionName); uerr == nil {
			rows, err := txApp.FindAllRecords(col, nil)
			if err != nil {
				return fmt.Errorf("read users: %w", err)
			}
			for _, rec := range rows {
				users[rec.Id] = true
			}
		}

		existingTopics := map[string]*core.Record{}
		rows, err := txApp.FindAllRecords(topicCol, nil)
		if err != nil {
			return fmt.Errorf("read topics: %w", err)
		}
		for _, rec := range rows {
			existingTopics[rec.Id] = rec
		}

		wanted := make(map[string]TopicUpsert, len(topics))
		topicIDs := make([]string, 0, len(topics))
		for _, u := range topics {
			wanted[u.TargetID] = u
			topicIDs = append(topicIDs, u.TargetID)
		}
		sort.Strings(topicIDs)

		for _, id := range topicIDs {
			u := wanted[id]
			if !categories[u.CategoryID] {
				return fmt.Errorf("topic %s: category %q has no row; import the categories first", id, u.CategoryID)
			}
			if !users[u.AuthorID] {
				return fmt.Errorf("topic %s: author %q has no users row; import the accounts first", id, u.AuthorID)
			}

			rec, ok := existingTopics[id]
			if !ok {
				rec = core.NewRecord(topicCol)
				rec.Set("id", id)
				applyTopicUpsert(rec, u)
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create topic %s: %w", id, err)
				}
				existingTopics[id] = rec
				report.TopicsCreated = append(report.TopicsCreated, id)
				continue
			}
			if topicMatches(rec, u) {
				continue
			}
			applyTopicUpsert(rec, u)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update topic %s: %w", id, err)
			}
			report.TopicsUpdated = append(report.TopicsUpdated, id)
		}

		if err := writeForumPosts(txApp, postCol, posts, existingTopics, users, postsCarryCharacter, &report); err != nil {
			return err
		}

		for id := range existingTopics {
			if _, ok := wanted[id]; !ok {
				report.ExtraTopicIDs = append(report.ExtraTopicIDs, id)
			}
		}
		return nil
	})
	if err != nil {
		return ForumImportReport{}, err
	}

	sort.Strings(report.TopicsCreated)
	sort.Strings(report.TopicsUpdated)
	sort.Strings(report.PostsCreated)
	sort.Strings(report.PostsUpdated)
	sort.Strings(report.ExtraTopicIDs)
	sort.Strings(report.ExtraPostIDs)
	return report, nil
}

// writeForumPosts writes the post rows inside the caller's transaction.
func writeForumPosts(
	txApp core.App,
	postCol *core.Collection,
	posts []PostUpsert,
	topics map[string]*core.Record,
	users map[string]bool,
	postsCarryCharacter bool,
	report *ForumImportReport,
) error {
	existing := map[string]*core.Record{}
	rows, err := txApp.FindAllRecords(postCol, nil)
	if err != nil {
		return fmt.Errorf("read posts: %w", err)
	}
	for _, rec := range rows {
		existing[rec.Id] = rec
	}

	wanted := make(map[string]PostUpsert, len(posts))
	ids := make([]string, 0, len(posts))
	for _, u := range posts {
		wanted[u.TargetID] = u
		ids = append(ids, u.TargetID)
	}
	sort.Strings(ids)

	for _, id := range ids {
		u := wanted[id]
		if _, ok := topics[u.TopicID]; !ok {
			return fmt.Errorf("post %s: topic %q has no row; import the topics first", id, u.TopicID)
		}
		if !users[u.AuthorID] {
			return fmt.Errorf("post %s: author %q has no users row; import the accounts first", id, u.AuthorID)
		}

		rec, ok := existing[id]
		if !ok {
			rec = core.NewRecord(postCol)
			rec.Set("id", id)
			applyPostUpsert(rec, u, postsCarryCharacter)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("create post %s: %w", id, err)
			}
			report.PostsCreated = append(report.PostsCreated, id)
			continue
		}
		if postMatches(rec, u, postsCarryCharacter) {
			continue
		}
		applyPostUpsert(rec, u, postsCarryCharacter)
		if err := txApp.Save(rec); err != nil {
			return fmt.Errorf("update post %s: %w", id, err)
		}
		report.PostsUpdated = append(report.PostsUpdated, id)
	}

	for id := range existing {
		if _, ok := wanted[id]; !ok {
			report.ExtraPostIDs = append(report.ExtraPostIDs, id)
		}
	}
	return nil
}

// validateForumUpserts rejects a batch that cannot be written cleanly.
//
// This runs BEFORE the transaction opens. A duplicate (topic, sequence) or a
// missing required field would otherwise fail halfway through a 3000-row batch,
// and a half-imported topic is a state nobody can reason about — and the SQLite
// error names a constraint, not the two documents that collided.
func validateForumUpserts(topics []TopicUpsert, posts []PostUpsert) error {
	topicIDs := make(map[string]bool, len(topics))
	for _, t := range topics {
		if t.TargetID == "" {
			return fmt.Errorf("topic upsert without a target id")
		}
		if topicIDs[t.TargetID] {
			return fmt.Errorf("duplicate topic target id %q", t.TargetID)
		}
		topicIDs[t.TargetID] = true
		if t.Title == "" {
			return fmt.Errorf("topic %s: title is required", t.TargetID)
		}
		if t.CategoryID == "" {
			return fmt.Errorf("topic %s: category_id is required", t.TargetID)
		}
		if t.AuthorID == "" {
			return fmt.Errorf("topic %s: author_id is required", t.TargetID)
		}
	}

	postIDs := make(map[string]bool, len(posts))
	sequences := make(map[string]map[int]string, len(posts))
	for _, p := range posts {
		if p.TargetID == "" {
			return fmt.Errorf("post upsert without a target id")
		}
		if postIDs[p.TargetID] {
			return fmt.Errorf("duplicate post target id %q", p.TargetID)
		}
		postIDs[p.TargetID] = true
		if p.TopicID == "" {
			return fmt.Errorf("post %s: topic_id is required", p.TargetID)
		}
		if p.AuthorID == "" {
			return fmt.Errorf("post %s: author_id is required", p.TargetID)
		}
		// A draft carries sequence 0 and is excluded from the uniqueness check:
		// the index is partial on sequence > 0 precisely so drafts can coexist.
		if p.IsDraft {
			if p.Sequence != 0 {
				return fmt.Errorf("draft %s must carry sequence 0, got %d", p.TargetID, p.Sequence)
			}
			continue
		}
		if p.Sequence <= 0 {
			return fmt.Errorf("post %s: a published post needs a positive sequence, got %d",
				p.TargetID, p.Sequence)
		}
		if sequences[p.TopicID] == nil {
			sequences[p.TopicID] = map[int]string{}
		}
		if other, taken := sequences[p.TopicID][p.Sequence]; taken {
			return fmt.Errorf("posts %s and %s both claim sequence %d in topic %s",
				other, p.TargetID, p.Sequence, p.TopicID)
		}
		sequences[p.TopicID][p.Sequence] = p.TargetID
	}
	return nil
}

// applyTopicUpsert writes the desired state onto a topic record.
func applyTopicUpsert(rec *core.Record, u TopicUpsert) {
	rec.Set("category_id", u.CategoryID)
	rec.Set("author_id", u.AuthorID)
	rec.Set("title", u.Title)
	rec.Set("locked", u.Locked)
	rec.Set("pinned", u.Pinned)
	rec.Set("deleted", u.Deleted)
	rec.Set("posts_count", u.PostsCount)
	// No `reputation` write: the topics collection has no such column (1766100000),
	// so setting it was a silent no-op that read as a successful import. The
	// legacy topic reputation has no home in the target schema and is reported by
	// the rehearsal's counter reconciliation instead.

	rec.Set("last_post_id", u.LastPostID)
	rec.Set("last_post_author_id", u.LastPostAuthorID)
	// last_post_created must never be NULL: the topic list walks the index
	// (pinned, last_post_created, id) backwards, and a NULL would drop the row
	// from every list without an error. The importer guarantees a non-empty value
	// by falling back to the topic's own created_at.
	if u.LastPostCreated != "" {
		if parsed, err := types.ParseDateTime(u.LastPostCreated); err == nil {
			rec.SetRaw("last_post_created", parsed)
		}
	}

	// The topics collection uses AutodateField, so historical dates need SetRaw:
	// a typed Set is what PocketBase's date handling rewrites to "now".
	setAutodateIfGiven(rec, "created", u.CreatedAt)
	setAutodateIfGiven(rec, "updated", u.UpdatedAt)
}

// applyPostUpsert writes the desired state onto a post record.
func applyPostUpsert(rec *core.Record, u PostUpsert, carryCharacter bool) {
	rec.Set("topic_id", u.TopicID)
	rec.Set("author_id", u.AuthorID)
	rec.Set("sequence", u.Sequence)
	rec.Set("is_draft", u.IsDraft)
	rec.Set("deleted", u.Deleted)
	rec.Set("reputation", u.Reputation)

	if u.Deleted {
		// A tombstone keeps its sequence slot and its place in the topic, but not
		// its text — the same shape the runtime's soft delete produces.
		rec.Set("content", "")
	} else {
		rec.Set("content", u.Content)
	}

	if u.EditedAt != "" {
		if parsed, err := types.ParseDateTime(u.EditedAt); err == nil {
			rec.SetRaw("edited", parsed)
		}
	}

	if carryCharacter {
		// Written through Set rather than SetRaw: a post row is *rebuilt* by the
		// importer from the same legacy document on every run, so an unchanged
		// value must compare equal on the next pass.
		rec.Set("author_character_id", u.AuthorCharacter)
	}

	setAutodateIfGiven(rec, "created", u.CreatedAt)
	setAutodateIfGiven(rec, "updated", u.UpdatedAt)
}

// topicMatches compares a stored topic with the desired state.
func topicMatches(rec *core.Record, u TopicUpsert) bool {
	return rec.GetString("category_id") == u.CategoryID &&
		rec.GetString("author_id") == u.AuthorID &&
		rec.GetString("title") == u.Title &&
		rec.GetBool("locked") == u.Locked &&
		rec.GetBool("pinned") == u.Pinned &&
		rec.GetBool("deleted") == u.Deleted &&
		rec.GetInt("posts_count") == u.PostsCount &&
		// No `reputation` comparison: the column does not exist on topics, so
		// GetInt returned 0 while the upsert carried the legacy cached score.
		// Any topic with a non-zero cached reputation therefore never matched
		// and was rewritten on every single run — a real idempotency bug that hid
		// behind a comparison against a field that was never there.
		rec.GetString("last_post_id") == u.LastPostID &&
		rec.GetString("last_post_author_id") == u.LastPostAuthorID &&
		autodateMatches(rec, "last_post_created", u.LastPostCreated) &&
		autodateMatches(rec, "created", u.CreatedAt)
}

// postMatches compares a stored post with the desired state.
func postMatches(rec *core.Record, u PostUpsert, carryCharacter bool) bool {
	want := u.Content
	if u.Deleted {
		want = ""
	}
	match := rec.GetString("topic_id") == u.TopicID &&
		rec.GetString("author_id") == u.AuthorID &&
		rec.GetInt("sequence") == u.Sequence &&
		rec.GetBool("is_draft") == u.IsDraft &&
		rec.GetBool("deleted") == u.Deleted &&
		rec.GetInt("reputation") == u.Reputation &&
		rec.GetString("content") == want &&
		autodateMatches(rec, "edited", u.EditedAt) &&
		autodateMatches(rec, "created", u.CreatedAt)
	if !match {
		return false
	}
	if carryCharacter {
		return rec.GetString("author_character_id") == u.AuthorCharacter
	}
	return true
}

// setAutodateIfGiven overwrites an AutodateField with a historical value.
//
// An empty wanted value leaves the field alone: PocketBase stamps "now" on create,
// and writing a zero date over a row the legacy never dated would be worse than
// leaving the collection's own timestamp.
func setAutodateIfGiven(rec *core.Record, field, value string) {
	if value == "" {
		return
	}
	parsed, err := types.ParseDateTime(value)
	if err != nil {
		return
	}
	rec.SetRaw(field, parsed)
}

// autodateMatches compares a stored date with a wanted value, treating an empty
// wanted value as a wildcard for the same reason setAutodateIfGiven does.
func autodateMatches(rec *core.Record, field, want string) bool {
	if want == "" {
		return true
	}
	return rec.GetDateTime(field).String() == want
}
