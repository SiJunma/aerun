package importer

// Legacy topics + posts + drafts -> target rows (Sprint 7 writers, levels
// L5, L6 and the draft fold of the dependency map in
// POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md §5).
//
// The hard part of this level is `sequence`. The target schema carries
// UNIQUE(topic_id, sequence) with sequence > 0 and the keyset list endpoints
// order by it; the legacy documents have no sequence at all, only created_at. So
// it is reconstructed from time, and the reconstruction is where an import
// silently rewrites history if it is done carelessly:
//
//   - Posts are ordered by created_at ASCENDING, compared as the full nanosecond
//     timestamp the exporter preserved. Firestore wrote those with nanosecond
//     resolution and two posts in one topic can share a second, so comparing at
//     second precision (or letting a map iteration decide) would reorder replies
//     within that second. Verified against the 2026-09 export: zero duplicate
//     timestamps inside a topic, but the ordering still must not depend on that.
//   - Ties are broken by the legacy document id, so the result is total and
//     deterministic even if a future export does contain a collision.
//   - Deleted posts KEEP their sequence slot. A tombstone still occupies a
//     number: the target never reuses a sequence (see 1766100000), and
//     renumbering around a hole would let a later import shift every reply below
//     it.
//
// The cached `posts_count` and `last_post_*` projections in the legacy topic
// documents are NOT copied. They are recomputed from the rows actually written,
// because the rehearsal already proved those fields are stale, and a topic whose
// cached count disagrees with its own posts would otherwise import a counter that
// contradicts the data next to it. The disagreement itself is reported by
// Reconcile.

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// quoteTagRegex matches the opening tag of a post quote written in the legacy
// markup: [quote="#p<postId>,t<topicId>,<authorName>"]. Only the post id is
// significant; the topic id and author name are carried along verbatim. It is
// intentionally identical to post_notifications.quoteRegex so the migration
// rewrite and the runtime notification parser agree on what a quote looks like.
var quoteTagRegex = regexp.MustCompile(`\[quote\s*=\s*"?#p([a-zA-Z0-9_-]+)(?:,[^\]]*?)?"?\]`)

// quoteIDOnly matches a bare `#p<legacyId>` marker inside a matched quote tag.
var quoteIDOnly = regexp.MustCompile(`#p([a-zA-Z0-9_-]+)`)

// quoteTopicIDOnly matches the `,t<legacyTopicId><sep>` component inside a
// matched quote tag. Group 1 is the legacy topic id *without* its `t` prefix
// (the `t` is a markup marker, not part of the id); group 2 is the separator
// (comma, double-quote, or closing bracket) that follows it.
var quoteTopicIDOnly = regexp.MustCompile(`,t([a-zA-Z0-9_-]+)([,"\])])`)

// rewriteQuotePostIDs replaces every legacy post id and topic id referenced in
// a quote tag (`[quote="#p<legacyId>,t<topicId>,<name>"]`) with the derived
// target ids, so quotes in imported posts still point at the post and topic
// they quoted. The target ids are DeriveID(SpacePost/SpaceTopic, legacyId) —
// exactly the ids the quoted post's and topic's own rows carry — so a quote
// and its target agree after cutover. Anything outside a quote tag is left
// untouched.
func rewriteQuotePostIDs(content string) string {
	return quoteTagRegex.ReplaceAllStringFunc(content, func(match string) string {
		// Replace legacy post id #p<legacyId> with derived target id
		loc := quoteIDOnly.FindStringIndex(match)
		if loc != nil {
			legacyID := match[loc[0]+2 : loc[1]]
			match = match[:loc[0]] + "#p" + DeriveID(SpacePost, legacyID) + match[loc[1]:]
		}
		// Replace legacy topic id ,t<legacyTopicId><sep> with derived target id.
		// The `t` is a markup marker and is preserved; only the id part is rewritten.
		topicLoc := quoteTopicIDOnly.FindStringIndex(match)
		if topicLoc != nil {
			// match[topicLoc[0]] is the leading comma; topicLoc[1] is after the separator
			// captured group 1 (topic id without the `t` marker): match[topicLoc[0]+2 : topicLoc[1]-1]
			legacyTopicID := match[topicLoc[0]+2 : topicLoc[1]-1]
			separator := match[topicLoc[1]-1 : topicLoc[1]]
			match = match[:topicLoc[0]] + ",t" + DeriveID(SpaceTopic, legacyTopicID) + separator + match[topicLoc[1]:]
		}
		return match
	})
}

// TopicRow is the target state of one topics record.
type TopicRow struct {
	LegacyID string
	TargetID string
	// CategoryID and AuthorID are derived target ids.
	CategoryID string
	AuthorID   string
	Title      string
	Locked     bool
	Pinned     bool
	// PostsCount is recomputed from the written posts, never copied.
	PostsCount int
	// LastPostID / LastPostCreated / LastPostAuthorID are rebuilt from the real
	// newest post. An empty LastPostID means the topic has no posts yet, which
	// the target allows (last_post_created then keeps a non-null tombstone
	// timestamp; the keyset index must never meet a NULL).
	LastPostID        string
	LastPostCreated   string
	LastPostAuthorID  string
	// LastPostAuthorKind / LastPostAuthorCharacterID / LastPostGuestDisplayName
	// are the last-post AuthorRef variant: they let the frontend resolve the
	// name/avatar of the last post's author without a second lookup.
	LastPostAuthorKind      string
	LastPostAuthorCharacterID string
	LastPostGuestDisplayName string
	CreatedAt         string
	UpdatedAt         string
	Reputation        int
	AuthorCharacterID string
	Findings          map[string]string
}

// PostRow is the target state of one posts record.
type PostRow struct {
	LegacyID string
	TargetID string
	TopicID  string
	AuthorID string
	// Sequence is 1..n within the topic, or 0 for a draft (the index is
	// partial on sequence > 0, and a draft carries no ordinal until published).
	Sequence int
	IsDraft  bool
	Content  string
	// Reputation is recomputed from the votes, never copied.
	Reputation      int
	EditedAt        string
	AuthorCharacter string
	// AuthorKind / GuestDisplayName are the post's AuthorRef variant: they
	// feed the topic's last-post projection so the frontend can resolve the
	// last speaker's name/avatar.
	AuthorKind      string
	GuestDisplayName string
	CreatedAt       string
	UpdatedAt       string
	Findings        map[string]string
}

// ForumPlan is the full result of planning L5 + L6 + drafts.
type ForumPlan struct {
	TopicRows []TopicRow
	PostRows  []PostRow
	Findings  map[string]*Finding
	// SkippedPostIDs are legacy posts that cannot become rows.
	SkippedPostIDs []string
	// SkippedTopicIDs are legacy topics that cannot become rows.
	SkippedTopicIDs []string
	// SequenceCount is how many sequence numbers were assigned in total.
	SequenceCount int
}

// pendingPost is one legacy document waiting for its sequence number. It is
// declared at package level because the sequence assignment is a method on
// ForumPlan, and a function-local type could not appear in its signature.
type pendingPost struct {
	legacyID string
	fields   map[string]any
	isDraft  bool
	deleted  bool
	created  time.Time
}

// BuildForumPlan translates the legacy topics, posts and drafts collections.
//
// userExists / categoryExists report whether the referenced account or category
// was imported; a row whose reference is missing is reported and skipped rather
// than written with a dangling id, because the command layer validates the same
// references and would refuse it later.
func BuildForumPlan(plan *ImportPlan, userExists, categoryExists func(string) bool) *ForumPlan {
	fp := &ForumPlan{Findings: map[string]*Finding{}}

	// --- posts, grouped by topic -------------------------------------------
	// The grouping happens over the raw documents because the sequence has to be
	// assigned across the whole topic before any row is built.
	byTopic := map[string][]pendingPost{}
	for _, id := range sortedKeys(plan.Posts) {
		fields := plan.Posts[id]
		topicRef := strings.TrimSpace(stringField(fields, "topic_id"))
		if topicRef == "" {
			fp.SkippedPostIDs = append(fp.SkippedPostIDs, id)
			fp.note("post_topic_id_missing", id)
			continue
		}
		// The legacy is_draft flag is false on every real post in the 2026-09
		// export, but honouring it keeps a future export honest: a post marked as
		// a draft gets sequence 0 and no effect on any projection.
		byTopic[topicRef] = append(byTopic[topicRef], pendingPost{
			legacyID: id,
			fields:   fields,
			isDraft:  legacyBoolField(fields, "is_draft"),
			deleted:  legacyBoolField(fields, "is_deleted"),
			created:  timeField(fields, "created_at"),
		})
	}

	// Drafts live under users/{uid}/drafts/{topicId} and are keyed by that
	// composite path. They join the same topic bucket but never take a sequence.
	for _, key := range sortedKeys(plan.Drafts) {
		_, topicRef, ok := splitDraftKey(key)
		if !ok {
			fp.note("draft_key_malformed", key)
			continue
		}
		fields := plan.Drafts[key]
		byTopic[topicRef] = append(byTopic[topicRef], pendingPost{
			legacyID: key,
			fields:   fields,
			isDraft:  true,
			created:  timeField(fields, "created_at"),
		})
	}

	// --- topics ------------------------------------------------------------
	topicExists := map[string]bool{}
	for _, id := range sortedKeys(plan.Topics) {
		fields := plan.Topics[id]
		row := TopicRow{
			LegacyID: id,
			TargetID: DeriveID(SpaceTopic, id),
			Findings: map[string]string{},
			Title:    strings.TrimSpace(stringField(fields, "title")),
			Locked:   legacyBoolField(fields, "is_locked"),
			Pinned:   legacyBoolField(fields, "is_pinned"),
			// topics has no `reputation` column at all (see 1766100000), so the
			// legacy value has nowhere to go. It is not carried into
			// TopicUpsert any more: the field was being written into a record
			// that had no such field, which is a silent no-op that only read as
			// "the topic's reputation was imported".
			CreatedAt: TimestampToISO(timeField(fields, "created_at")),
			UpdatedAt: TimestampToISO(timeField(fields, "updated_at")),
		}

		if row.Title == "" {
			// topics.title is Required, so a titleless topic cannot be written.
			fp.SkippedTopicIDs = append(fp.SkippedTopicIDs, id)
			fp.note("topic_title_missing", id)
			continue
		}

		// A legacy deleted TOPIC is not imported, and neither are its posts: the
		// target has no tombstone state (1767700000 dropped the `deleted`
		// column), so importing it would resurrect a thread the forum had already
		// removed. Reported rather than silently dropped — on the 2026-09-18
		// snapshot no topic carries is_deleted, so this is currently a no-op.
		if legacyBoolField(fields, "is_deleted") {
			fp.SkippedTopicIDs = append(fp.SkippedTopicIDs, id)
			fp.note("topic_skipped_deleted", id)
			continue
		}

		catRef := strings.TrimSpace(stringField(fields, "category_id"))
		if catRef == "" || !categoryExists(catRef) {
			// topics.category_id is Required and NOT NULL; a topic with no
			// resolvable category has nowhere to live in the board.
			fp.SkippedTopicIDs = append(fp.SkippedTopicIDs, id)
			fp.note("topic_category_unresolved", id+"->"+catRef)
			continue
		}
		row.CategoryID = DeriveID(SpaceCategory, catRef)

		authorRef := strings.TrimSpace(stringField(fields, "author_id"))
		if authorRef == "" || !userExists(authorRef) {
			// topics.author_id is Required too. The reference is reported rather
			// than replaced: the command layer would refuse a row with an unknown
			// author, and silently re-parenting a topic would rewrite history.
			fp.SkippedTopicIDs = append(fp.SkippedTopicIDs, id)
			fp.note("topic_author_unresolved", id+"->"+authorRef)
			continue
		}
		row.AuthorID = DeriveID(SpaceUser, authorRef)

		if ref := strings.TrimSpace(stringField(fields, "author_character_id")); ref != "" {
			row.AuthorCharacterID = DeriveID(SpaceCharacter, authorRef+"/characters/"+ref)
		}

		topicExists[id] = true
		fp.assignTopicPosts(&row, byTopic[id], userExists)
		fp.TopicRows = append(fp.TopicRows, row)
	}
	sort.Strings(fp.SkippedTopicIDs)
	sort.Strings(fp.SkippedPostIDs)

	// Posts whose topic document does not exist at all have no topic_id that can
	// be written; they are reported here rather than silently left in the plan.
	for _, id := range sortedKeys(plan.Posts) {
		topicRef := strings.TrimSpace(stringField(plan.Posts[id], "topic_id"))
		if topicRef != "" && !topicExists[topicRef] {
			fp.note("post_topic_unknown", id+"->"+topicRef)
		}
	}

	// Stable ordering for the report: two runs must produce identical bytes.
	sort.Slice(fp.PostRows, func(i, j int) bool { return fp.PostRows[i].TargetID < fp.PostRows[j].TargetID })
	fp.summarizeRows()
	return fp
}

// assignTopicPosts assigns the per-topic sequence and rebuilds the topic
// projections from the posts it actually wrote.
//
// The rules, in the order they matter:
//
//   - **Sequence counts every published post, deleted or not.** A tombstone keeps
//     its slot because the target never reuses a number (1766100000). Closing a
//     hole here would let a later import shift every reply below it, which is
//     exactly the kind of silent history rewrite this whole writer avoids.
//   - **posts_count counts only visible posts** (deleted = false), matching the
//     predicate the command layer uses at runtime (1767100000 documents the same
//     rule for users.posts_count).
//   - **The projection points at the newest VISIBLE post.** last_post_created is
//     never empty: when every post is deleted the keyset index (pinned,
//     last_post_created, id) would otherwise meet a NULL and drop the row from
//     the topic list, so the topic's own created_at is used as the tombstone
//     value instead.
//
// The cached legacy values are ignored entirely; Reconcile reports the
// disagreement instead.
func (fp *ForumPlan) assignTopicPosts(topic *TopicRow, posts []pendingPost, userExists func(string) bool) {
	published := make([]pendingPost, 0, len(posts))
	for _, p := range posts {
		if !p.isDraft {
			published = append(published, p)
		}
	}

	// The sort IS the reconstruction: ascending by the full-precision timestamp
	// the exporter preserved, then by legacy document id so the order is total
	// even if two posts share a nanosecond.
	sort.Slice(published, func(i, j int) bool {
		if !published[i].created.Equal(published[j].created) {
			return published[i].created.Before(published[j].created)
		}
		return published[i].legacyID < published[j].legacyID
	})

	var newestVisible string
	// written counts posts that actually get a row, and it is what `sequence`
	// comes from. Using the loop index instead would leave a permanent hole for
	// every post skipped below — a deleted one, or one whose author could not be
	// resolved. The unresolved-author case deliberately DOES burn a number (the
	// slot is preserved so a later import cannot renumber around it), which is
	// why the counter is advanced explicitly in each branch rather than derived
	// from the index.
	written := 0
	for i := range published {
		p := &published[i]

		// A legacy deleted post is NOT imported. Deletion is a hard delete on
		// this branch (1767700000 dropped the `deleted` column), so there is no
		// tombstone row to carry over — the post does not exist in the target,
		// and its number is NOT burned, because a permanent hole in the numbering
		// would point at a post that is gone from the source too. On the
		// 2026-09-18 snapshot no post carries is_deleted at all, so this branch is
		// currently a no-op.
		if p.deleted {
			fp.SkippedPostIDs = append(fp.SkippedPostIDs, p.legacyID)
			fp.note("post_skipped_deleted", p.legacyID)
			continue
		}

		// A post whose author did not import keeps its slot: the row is not
		// written, but the number is consumed so a re-import against a fresher
		// export cannot renumber everything below it. The hole is REPORTED.
		sequence := written + 1
		authorRef := strings.TrimSpace(stringField(p.fields, "author_id"))
		if authorRef == "" || !userExists(authorRef) {
			// posts.author_id is Required. Skipping a post mid-sequence would
			// leave a permanent hole, so the sequence is burned but the row is not
			// written — and the hole is reported rather than left as a mystery.
			fp.SkippedPostIDs = append(fp.SkippedPostIDs, p.legacyID)
			fp.note("post_author_unresolved", p.legacyID)
			written++
			continue
		}

		row := PostRow{
			LegacyID: p.legacyID,
			TargetID: DeriveID(SpacePost, p.legacyID),
			TopicID:  topic.TargetID,
			AuthorID: DeriveID(SpaceUser, authorRef),
			Sequence: sequence,
			IsDraft:  false,
			// Deliberately NOT intField(p.fields, "reputation"). The comment on
			// PostRow.Reputation says this is recomputed, and until now the code
			// contradicted its own comment by copying the legacy cache.
			// posts.reputation is rebuilt by RecomputePostReputation from the
			// reputation_votes rows this same import writes, so a stale cached
			// score cannot survive next to the votes that produced it.
			Reputation: 0,
			Content:    rewriteQuotePostIDs(stringField(p.fields, "content")),
			EditedAt:   TimestampToISO(timeField(p.fields, "edited_at")),
			CreatedAt:  TimestampToISO(p.created),
			UpdatedAt:  TimestampToISO(p.created),
			Findings:   map[string]string{},
			// AuthorRef variant of the post: feeds the topic's last-post
			// projection so the frontend can resolve the last speaker's
			// name/avatar.
			AuthorKind:      strings.TrimSpace(stringField(p.fields, "author_kind")),
			GuestDisplayName: strings.TrimSpace(stringField(p.fields, "guest_display_name")),
		}
		if ref := strings.TrimSpace(stringField(p.fields, "author_character_id")); ref != "" {
			row.AuthorCharacter = DeriveID(SpaceCharacter, authorRef+"/characters/"+ref)
		}

		fp.PostRows = append(fp.PostRows, row)
		fp.SequenceCount++
		written++

		topic.PostsCount++
		newestVisible = row.TargetID
		topic.LastPostID = row.TargetID
		topic.LastPostAuthorID = row.AuthorID
		topic.LastPostAuthorKind = row.AuthorKind
		topic.LastPostAuthorCharacterID = row.AuthorCharacter
		topic.LastPostGuestDisplayName = row.GuestDisplayName
		topic.LastPostCreated = row.CreatedAt
	}

	// Tombstone fallback: the keyset index must never meet a NULL, or the topic
	// silently disappears from every list.
	if topic.LastPostCreated == "" {
		fallback := topic.CreatedAt
		if fallback == "" {
			fallback = TimestampToISO(time.Time{})
		}
		topic.LastPostCreated = fallback
		if newestVisible == "" {
			fp.note("topic_without_visible_posts", topic.LegacyID)
		}
	}

	// Drafts: no sequence, no projection effect, but they are real authored
	// content and must survive the cutover.
	for _, p := range posts {
		if !p.isDraft {
			continue
		}
		authorRef := strings.TrimSpace(stringField(p.fields, "author_id"))
		if authorRef == "" || !userExists(authorRef) {
			fp.SkippedPostIDs = append(fp.SkippedPostIDs, p.legacyID)
			fp.note("draft_author_unresolved", p.legacyID)
			continue
		}
		fp.PostRows = append(fp.PostRows, PostRow{
			LegacyID:  p.legacyID,
			TargetID:  DeriveID(SpacePost, p.legacyID),
			TopicID:   topic.TargetID,
			AuthorID:  DeriveID(SpaceUser, authorRef),
			IsDraft:   true,
			Content:   rewriteQuotePostIDs(stringField(p.fields, "content")),
			CreatedAt: TimestampToISO(p.created),
			UpdatedAt: TimestampToISO(p.created),
			Findings:  map[string]string{"draft_no_sequence": p.legacyID},
		})
		fp.note("draft_imported_as_post", p.legacyID)
	}
}

// splitDraftKey splits "uid/drafts/topic_id" into its halves. A draft is keyed
// by (author, topic) because the legacy document id IS the topic id, so one user
// could hold one draft per topic.
func splitDraftKey(key string) (uid, topicID string, ok bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[1] != "drafts" || parts[0] == "" || parts[2] == "" {
		return "", "", false
	}
	return parts[0], parts[2], true
}

func (fp *ForumPlan) note(code, detail string) {
	if existing, ok := fp.Findings[code]; ok {
		existing.Count++
		return
	}
	fp.Findings[code] = &Finding{Code: code, Count: 1, Examples: []string{detail}}
}

func (fp *ForumPlan) summarizeRows() {
	for _, t := range fp.TopicRows {
		for code, detail := range t.Findings {
			if code != "" {
				fp.note(code, detail)
			}
		}
	}
	for _, p := range fp.PostRows {
		for code, detail := range p.Findings {
			if code != "" {
				fp.note(code, detail)
			}
		}
	}
}

// Selected is the number of rows this run would write.
func (fp *ForumPlan) Selected() int { return len(fp.TopicRows) + len(fp.PostRows) }

// SortedFindingLines renders the plan findings as stable "code: count" lines.
func (fp *ForumPlan) SortedFindingLines() []string {
	lines := make([]string, 0, len(fp.Findings))
	for code, f := range fp.Findings {
		line := fmt.Sprintf("%s: %d", code, f.Count)
		if len(f.Examples) > 0 {
			line += fmt.Sprintf(" [%s]", strings.Join(f.Examples, " "))
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return lines
}

// SortedRowLines renders the planned rows as stable one-line summaries. Topics
// print their recomputed projection rather than the legacy cached one, because
// that is the number the target will actually hold.
func (fp *ForumPlan) SortedRowLines() []string {
	lines := make([]string, 0, fp.Selected())
	for _, t := range fp.TopicRows {
		lines = append(lines, fmt.Sprintf(
			"topic %s -> %s title=%q category=%s posts_count=%d last_post=%s locked=%t pinned=%t",
			t.LegacyID, t.TargetID, t.Title, t.CategoryID, t.PostsCount, t.LastPostID, t.Locked, t.Pinned))
	}
	for _, p := range fp.PostRows {
		lines = append(lines, fmt.Sprintf(
			"post %s -> %s topic=%s sequence=%d draft=%t author=%s",
			p.LegacyID, p.TargetID, p.TopicID, p.Sequence, p.IsDraft, p.AuthorID))
	}
	sort.Strings(lines)
	return lines
}
