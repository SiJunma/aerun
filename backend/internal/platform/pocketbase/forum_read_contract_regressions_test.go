package pocketbase

// Regression tests for the defects reported from the browser after the forum
// read-model cutover. Each failed SILENTLY — the UI rendered a plausible page
// built from missing keys, so none surfaced as an error:
//
//   1. The "Post as…" mask never applied: posts had no author_character_id
//      column and neither create form accepted a character.
//   2. "Pin first post on all pages" was decorative: pinFirstPost lived in
//      component state and was never sent, and topics had no flag to receive it.
//   3. Every topic open logged 403s: the browser read the server-only
//      reputation_votes collection directly.
//   4. /new-replies was permanently empty: fetchSecuredMainPageData never
//      returned latestTopics.
//   5. /active-topics showed "—" with no link: subscribeToTopTopics handed raw
//      rows to a renderer that reads the normalised field names.
//   6. Category and forum counters read 0: toCategory dropped the counters the
//      server computes, and no stats endpoint existed.
//
// Issues 4, 5 and the client half of 6 are JavaScript; those are pinned by
// scripts/check-forum-read-contract.mjs. What is asserted here is the SERVER
// half: the columns exist, masks resolve and are ownership-checked, the pin is
// stored and served, and every key a renderer reads is actually present.

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// PocketBase record ids must be EXACTLY 15 characters (both a minimum and a
// maximum), so this is a fixed-width fixture rather than a readable one.
const fixRoughMaskID = "charrgh00000001"

// createTopicVia performs a real create so the assertions below read the
// response a browser receives, not one assembled by a fixture. `extra` carries
// the optional body fields (character_id, pin_first_post).
func createTopicVia(t *testing.T, serverURL, token, catID, idem, extra string) (string, map[string]any) {
	t.Helper()
	body := fmt.Sprintf(`{"category_id":%q,"title":"Masked","content":"Body"%s}`, catID, extra)
	status, payload := doJSON(t, serverURL, http.MethodPost, "/api/aerun/topics", token, idem, body)
	if status != http.StatusCreated {
		t.Fatalf("create topic: got %d, want 201 (%v)", status, payload)
	}
	topic, _ := payload["topic"].(map[string]any)
	id, _ := topic["id"].(string)
	if id == "" {
		t.Fatalf("create response carries no topic.id: %#v", payload)
	}
	return id, payload
}

// mustCreateTopic creates a plain topic and returns its id.
func mustCreateTopic(t *testing.T, serverURL, token, catID, idem string) string {
	t.Helper()
	id, _ := createTopicVia(t, serverURL, token, catID, idem, "")
	return id
}

// TestMaskIsAppliedToTheStoredPost is issue #1.
//
// The mask used to be a display-only fiction: the picker wrote
// users.last_selected_character_id and nothing read it back, so the post was
// stamped with the account and rendered under the account's name.
func TestMaskIsAppliedToTheStoredPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedRuntimeCharacter(t, app, fixRoughMaskID, fixPlayerID, "Rough")

	_, payload := createTopicVia(t, server.URL, tokens["player"], catID,
		"idem-mask-1", fmt.Sprintf(`,"character_id":%q`, fixRoughMaskID))

	firstPost, _ := payload["first_post"].(map[string]any)
	if firstPost == nil {
		t.Fatalf("create response carries no first_post: %#v", payload)
	}

	// The mask REPLACES the display identity...
	if got, _ := firstPost["author_name"].(string); got != "Rough" {
		t.Errorf("first_post.author_name = %q, want %q — the mask did not apply", got, "Rough")
	}
	if isChar, _ := firstPost["is_character"].(bool); !isChar {
		t.Errorf("first_post.is_character = %v, want true", isChar)
	}
	if got, _ := firstPost["author_character_id"].(string); got != fixRoughMaskID {
		t.Errorf("first_post.author_character_id = %q, want %q", got, fixRoughMaskID)
	}

	// ...but NOT ownership. A mask must never let somebody take credit, or
	// blame, for something the account did not write.
	if got, _ := firstPost["author_id"].(string); got != fixPlayerID {
		t.Errorf("first_post.author_id = %q, want %q — a mask must not change ownership", got, fixPlayerID)
	}
	if role, _ := firstPost["author_role_id"].(string); role == "" {
		t.Error("author_role_id was emptied by the mask; role and reputation belong to the account")
	}

	// The ROW must carry the reference, not just the response: the list
	// endpoints read it from storage, not from this create response.
	postID, _ := firstPost["id"].(string)
	stored, err := app.FindRecordById(postsCollectionName, postID)
	if err != nil || stored == nil {
		t.Fatalf("stored post %s not found: %v", postID, err)
	}
	if got := stored.GetString("author_character_id"); got != fixRoughMaskID {
		t.Errorf("posts.author_character_id = %q, want %q — the mask was never persisted", got, fixRoughMaskID)
	}
}

// TestMaskCannotBeBorrowed is the security half of issue #1: ownership is
// checked server-side, so a hand-crafted request cannot post as somebody else's
// mask. Without that check this endpoint is impersonation.
func TestMaskCannotBeBorrowed(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedRuntimeCharacter(t, app, fixRoughMaskID, fixPlayerID, "Rough")

	body := fmt.Sprintf(`{"category_id":%q,"title":"Borrowed","content":"Body","character_id":%q}`,
		catID, fixRoughMaskID)
	status, _ := doJSON(t, server.URL, http.MethodPost, "/api/aerun/topics",
		tokens["moderator"], "idem-mask-borrow", body)
	if status != http.StatusForbidden {
		t.Fatalf("posting as another member's mask: got %d, want 403", status)
	}
}

// TestStoredMaskIsUsedWhenTheRequestNamesNone covers the reply form, which sends
// no character id at all and relies on the profile's selection — the path the
// topic form's own `updateUser` call sets up.
func TestStoredMaskIsUsedWhenTheRequestNamesNone(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedRuntimeCharacter(t, app, fixRoughMaskID, fixPlayerID, "Rough")

	owner, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || owner == nil {
		t.Fatalf("owner %s not found: %v", fixPlayerID, err)
	}
	owner.Set("last_selected_character_id", fixRoughMaskID)
	if err := app.Save(owner); err != nil {
		t.Fatalf("failed to set the stored mask: %v", err)
	}

	topicID := mustCreateTopic(t, server.URL, tokens["player"], catID, "idem-mask-stored")
	status, payload := doJSON(t, server.URL, http.MethodPost,
		fmt.Sprintf("/api/aerun/topics/%s/posts", topicID),
		tokens["player"], "idem-mask-stored-1", `{"content":"a reply"}`)
	if status != http.StatusCreated {
		t.Fatalf("reply: got %d, want 201 (%v)", status, payload)
	}
	post, _ := payload["post"].(map[string]any)
	if got, _ := post["author_name"].(string); got != "Rough" {
		t.Errorf("reply author_name = %q, want %q — the stored mask was ignored", got, "Rough")
	}
}

// mustFindPostRecord re-reads a post row. Callers must use it after every
// command instead of holding a record across one: `*core.Record` is a snapshot,
// so a cached copy keeps reporting the values the last command replaced.
func mustFindPostRecord(t *testing.T, app core.App, postID string) *core.Record {
	t.Helper()
	rec, err := app.FindRecordById(postsCollectionName, postID)
	if err != nil || rec == nil {
		t.Fatalf("stored post %s not found: %v", postID, err)
	}
	return rec
}

// TestEditedPostKeepsItsMaskUnlessTheAuthorChangedIt is the edit half of the
// mask contract.
//
// The edit form's picker built a `metadata` object that src/api/forum.js named
// `_metadata` and never read, and `editPostForm` had no character field at all
// — so changing the mask repainted the card optimistically and then reverted on
// the next load. It is the same silent failure as a draft published without its
// mask, on a path the picker invites people to use.
func TestEditedPostKeepsItsMaskUnlessTheAuthorChangedIt(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedRuntimeCharacter(t, app, fixRoughMaskID, fixPlayerID, "Rough")
	seedRuntimeCharacter(t, app, "charsecondmask1", fixPlayerID, "Second")

	server := newTestServer(t, app)
	defer server.Close()

	_, payload := createTopicVia(t, server.URL, tokens["player"], catID,
		"idem-edit-mask-1", fmt.Sprintf(`,"character_id":%q`, fixRoughMaskID))
	firstPost, _ := payload["first_post"].(map[string]any)
	postID, _ := firstPost["id"].(string)

	// 1. A plain text edit must NOT touch the stored mask.
	status, _ := doJSON(t, server.URL, http.MethodPatch, "/api/aerun/posts/"+postID,
		tokens["player"], "idem-edit-mask-2", `{"content":"edited text only"}`)
	if status != http.StatusOK {
		t.Fatalf("text-only edit: got %d, want 200", status)
	}
	// Re-read after EVERY command: `stored` is a snapshot, and asserting on a
	// stale one would pass or fail on a value the handler had already replaced.
	stored := mustFindPostRecord(t, app, postID)
	if got := stored.GetString("author_character_id"); got != fixRoughMaskID {
		t.Fatalf("author_character_id after a text-only edit = %q, want %q — an edit that "+
			"never touched the picker stripped the mask", got, fixRoughMaskID)
	}

	// 2. An explicit "post as my account" must clear it rather than read the
	// profile's stored mask back. The stored mask is deliberately SET here, so a
	// fallback to last_selected_character_id would be visible.
	owner, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || owner == nil {
		t.Fatalf("owner not found: %v", err)
	}
	owner.Set("last_selected_character_id", fixRoughMaskID)
	if err := app.Save(owner); err != nil {
		t.Fatalf("failed to store a mask on the profile: %v", err)
	}
	status, payload = doJSON(t, server.URL, http.MethodPatch, "/api/aerun/posts/"+postID,
		tokens["player"], "idem-edit-mask-3", `{"content":"now under my account","character_id":""}`)
	if status != http.StatusOK {
		t.Fatalf("clearing the mask: got %d, want 200 (%v)", status, payload)
	}
	if got := mustFindPostRecord(t, app, postID).GetString("author_character_id"); got != "" {
		t.Errorf("author_character_id after clearing = %q, want empty — the stored profile "+
			"mask was read back and the author's own choice ignored", got)
	}

	// 3. Naming another of the author's own masks re-files the post.
	status, payload = doJSON(t, server.URL, http.MethodPatch, "/api/aerun/posts/"+postID,
		tokens["player"], "idem-edit-mask-4",
		`{"content":"under the second mask","character_id":"charsecondmask1"}`)
	if status != http.StatusOK {
		t.Fatalf("switching masks: got %d, want 200 (%v)", status, payload)
	}
	edited, _ := payload["post"].(map[string]any)
	if got, _ := edited["author_name"].(string); got != "Second" {
		t.Errorf("edited author_name = %q, want %q — the answer was not decorated", got, "Second")
	}
	if got := mustFindPostRecord(t, app, postID).GetString("author_character_id"); got != "charsecondmask1" {
		t.Errorf("author_character_id after switching = %q, want %q", got, "charsecondmask1")
	}
	// The topic's last-post projection has to follow, or a topic list row keeps
	// naming the previous speaker.
	topicID, _ := firstPost["topic_id"].(string)
	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil {
		t.Fatalf("topic not found: %v", err)
	}
	if got := topic.GetString("last_post_author_character_id"); got != "charsecondmask1" {
		t.Errorf("topics.last_post_author_character_id = %q, want %q", got, "charsecondmask1")
	}
}

// TestEditCannotRefileUnderABorrowedMask is the security half of the edit path:
// `edit_others_posts` widens WHO may rewrite the text, never the identity. A
// moderator may correct a post's wording, but must not be able to move it onto
// their own mask — the post would then credit them for text they did not write.
func TestEditCannotRefileUnderABorrowedMask(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	// The moderator owns a real mask of their own, so a missing ownership gate
	// would have somewhere to move the post TO.
	seedRuntimeCharacter(t, app, "charmodmask0001", fixModeratorID, "Moderator Mask")

	server := newTestServer(t, app)
	defer server.Close()

	_, payload := createTopicVia(t, server.URL, tokens["player"], catID, "idem-edit-borrow-1", "")
	firstPost, _ := payload["first_post"].(map[string]any)
	postID, _ := firstPost["id"].(string)

	// Two shapes are unacceptable: a 403 (explicit refusal), or 200 with the
	// moderator's mask written onto the author's post. The mask must not move.
	status, body := doJSON(t, server.URL, http.MethodPatch, "/api/aerun/posts/"+postID,
		tokens["moderator"], "idem-edit-borrow-2",
		`{"content":"moderated rewrite","character_id":"charmodmask0001"}`)
	if status != http.StatusForbidden && status != http.StatusOK {
		t.Fatalf("moderator edit: got %d, want 403 or 200 (%v)", status, body)
	}
	stored := mustFindPostRecord(t, app, postID)
	if got := stored.GetString("author_character_id"); got == "charmodmask0001" {
		t.Error("a moderator moved somebody else's post onto their own mask — ownership of " +
			"the display identity is the author's alone")
	}
	if got := stored.GetString("author_id"); got != fixPlayerID {
		t.Errorf("author_id = %q, want %q — a moderated edit must not reassign the post",
			got, fixPlayerID)
	}
}

// TestPinFirstPostIsStoredAndServed is issue #2, end to end: the checkbox has to
// reach the server, survive in the topic row, and come back as BOTH
// `first_post_pinned` (what TopicPage gates on) and `pinned_post` (what it
// renders above page 2). Storing the flag without serving the post would make
// the checkbox do nothing visible, which is how it failed in the first place.
func TestPinFirstPostIsStoredAndServed(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	topicID, payload := createTopicVia(t, server.URL, tokens["player"], catID,
		"idem-pin-1", `,"pin_first_post":true`)
	topic, _ := payload["topic"].(map[string]any)
	if pinned, _ := topic["first_post_pinned"].(bool); !pinned {
		t.Fatalf("create response first_post_pinned = %v, want true — the checkbox was dropped", pinned)
	}

	stored, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil || stored == nil {
		t.Fatalf("stored topic %s not found: %v", topicID, err)
	}
	if !stored.GetBool("first_post_pinned") {
		t.Error("topics.first_post_pinned was not persisted")
	}

	// Page 1 must NOT echo the post back: it is already in `items`, so the page
	// would render the opening message twice.
	status, page1 := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?page=1&limit=20", topicID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("page 1: got %d, want 200 (%v)", status, page1)
	}
	if pinned, present := page1["pinned_post"]; present && pinned != nil {
		t.Error("page 1 carried a pinned_post that is already in items — it would render twice")
	}

	// Page 2+ must carry it, or the checkbox buys the reader nothing. The topic
	// needs enough posts to actually HAVE a page 2: with a single post the page
	// is empty and there is nothing for the banner to sit above, so the test
	// would be asserting against a page the reader can never reach.
	for i := 0; i < 21; i++ {
		status, reply := doJSON(t, server.URL, http.MethodPost,
			fmt.Sprintf("/api/aerun/topics/%s/posts", topicID),
			tokens["player"], fmt.Sprintf("idem-pin-fill-%d", i), `{"content":"filler"}`)
		if status != http.StatusCreated {
			t.Fatalf("filler reply %d: got %d, want 201 (%v)", i, status, reply)
		}
	}

	status, page2 := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?page=2&limit=20", topicID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("page 2: got %d, want 200 (%v)", status, page2)
	}
	pinned, _ := page2["pinned_post"].(map[string]any)
	if pinned == nil {
		t.Fatalf("page 2 carried no pinned_post for a pinned topic: %#v", page2)
	}
	if got, _ := pinned["content"].(string); got != "Body" {
		t.Errorf("pinned_post.content = %q, want the opening message %q", got, "Body")
	}
}

// TestUnpinnedTopicServesNoPinnedPost is the other half: the flag must not leak
// onto every topic, or the banner becomes decoration of a different kind.
func TestUnpinnedTopicServesNoPinnedPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	topicID := mustCreateTopic(t, server.URL, tokens["player"], catID, "idem-nopin-1")

	// Same reasoning as the pinned case: page 2 must exist for the assertion to
	// mean anything.
	for i := 0; i < 21; i++ {
		status, reply := doJSON(t, server.URL, http.MethodPost,
			fmt.Sprintf("/api/aerun/topics/%s/posts", topicID),
			tokens["player"], fmt.Sprintf("idem-nopin-fill-%d", i), `{"content":"filler"}`)
		if status != http.StatusCreated {
			t.Fatalf("filler reply %d: got %d, want 201 (%v)", i, status, reply)
		}
	}

	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?page=2&limit=20", topicID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("page 2: got %d, want 200 (%v)", status, payload)
	}
	if pinned, present := payload["pinned_post"]; present {
		t.Errorf("an unpinned topic served pinned_post = %#v; the key must be absent entirely", pinned)
	}
}

// TestMyVotesAreServable is issue #3. The browser used to read the server-only
// reputation_votes collection and got 403 on every topic open; the replacement
// route must work for a signed-in member and refuse a guest.
func TestMyVotesAreServable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	topicID := mustCreateTopic(t, server.URL, tokens["player"], catID, "idem-votes-1")

	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/me/votes?topic_id=%s", topicID), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("read my votes: got %d, want 200 (%v)", status, payload)
	}
	if _, present := payload["items"]; !present {
		t.Errorf("my-votes response has no `items` array: %#v", payload)
	}

	// A guest has no votes of their own, and must not receive anybody else's.
	status, _ = doJSON(t, server.URL, http.MethodGet, "/api/aerun/me/votes", "", "", "")
	if status != http.StatusUnauthorized {
		t.Errorf("anonymous my-votes: got %d, want 401", status)
	}
}

// TestForumStatsAreCounted is issue #6 for the stats panel. ForumStats.jsx reads
// forumStats.totalTopics / totalPosts / totalUsers / newestUser, and nothing on
// the server ever sent them, so the panel fell back to summing counters that
// were themselves being dropped.
func TestForumStatsAreCounted(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	status, before := doJSON(t, server.URL, http.MethodGet, "/api/aerun/forum-stats",
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("forum stats: got %d, want 200 (%v)", status, before)
	}
	stats, _ := before["stats"].(map[string]any)
	if stats == nil {
		t.Fatalf("forum-stats response has no `stats` object: %#v", before)
	}
	for _, key := range []string{"totalTopics", "totalPosts", "totalUsers", "newestUser"} {
		if _, ok := stats[key]; !ok {
			t.Errorf("stats.%s is missing — ForumStats.jsx reads exactly this key", key)
		}
	}

	mustCreateTopic(t, server.URL, tokens["player"], catID, "idem-stats-1")

	status, after := doJSON(t, server.URL, http.MethodGet, "/api/aerun/forum-stats",
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("forum stats after create: got %d, want 200 (%v)", status, after)
	}
	stats, _ = after["stats"].(map[string]any)
	if topics, _ := stats["totalTopics"].(float64); topics < 1 {
		t.Errorf("stats.totalTopics = %v after creating a topic, want >= 1", stats["totalTopics"])
	}
	if posts, _ := stats["totalPosts"].(float64); posts < 1 {
		t.Errorf("stats.totalPosts = %v after creating a topic, want >= 1", stats["totalPosts"])
	}

	// Members counts EVERY account, status included. The exact number is not
	// asserted against a literal — seedIdentityFixtures creates several accounts
	// and the count must move with THEM. What is pinned is that NOTHING is
	// excluded: a banned account and an unapproved registration are still
	// accounts, with a nickname, a post history and a row in the members table.
	//
	// The previous version of this assertion was the opposite rule — it demanded
	// that a banned account NOT be counted, which is what made the headline
	// smaller than the forum people are looking at.
	totalUsers, _ := stats["totalUsers"].(float64)
	all, err := app.FindAllRecords(usersCollectionName)
	if err != nil {
		t.Fatalf("read users: %v", err)
	}
	byStatus := map[string]int{}
	for _, u := range all {
		byStatus[u.GetString("status")]++
	}
	t.Logf("seeded accounts by status: %v", byStatus)
	if want := len(all); float64(want) != totalUsers {
		t.Errorf("stats.totalUsers = %v, want %v — every account counts, status included, from %v",
			totalUsers, want, byStatus)
	}
}

// TestCategoryCountersReachTheClient is issue #6 for the index. The backend
// already computed these correctly; the CLIENT mapping dropped them, which is
// the half a Go test cannot see, so the response is asserted field by field.
func TestCategoryCountersReachTheClient(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	mustCreateTopic(t, server.URL, tokens["player"], catID, "idem-cat-1")

	status, payload := doJSON(t, server.URL, http.MethodGet, "/api/aerun/categories",
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list categories: got %d, want 200 (%v)", status, payload)
	}

	cats, _ := payload["items"].([]any)
	for _, raw := range cats {
		entry, _ := raw.(map[string]any)
		if entry["id"] != catID {
			continue
		}
		if topics, _ := entry["topics_count"].(float64); topics != 1 {
			t.Errorf("categories[].topics_count = %v, want 1", entry["topics_count"])
		}
		if posts, _ := entry["posts_count"].(float64); posts != 1 {
			t.Errorf("categories[].posts_count = %v, want 1", entry["posts_count"])
		}
		for _, key := range []string{
			"last_post_topic_id", "last_post_topic_title",
			"last_post_at", "last_post_author", "last_post_author_avatar",
		} {
			if _, ok := entry[key]; !ok {
				t.Errorf("categories[] is missing %q — MainPage renders it", key)
			}
		}
		return
	}
	t.Fatalf("category %s missing from the list", catID)
}
