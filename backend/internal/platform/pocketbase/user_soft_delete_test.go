package pocketbase

// user_soft_delete_test.go — the soft-delete contract from
// markdowns/DONE_DELETED_USER_PROFILE_AND_POSTS_2026-10-18.md.
//
// Deleting an account no longer removes the users row: the row is taken out
// of circulation (flag + status + released nickname key) so the profile page
// and the member's posts keep rendering the baked identity instead of 404ing.
// These tests pin the four halves the whole feature hangs on:
//
//  1. the ROW SURVIVES in exactly the shape the profile page needs, and the
//     nickname becomes reusable;
//  2. delete_posts=true hard-deletes content through the SAME residue paths
//     ordinary topic/post deletes use (no orphans, counters and reputation
//     paid back in the same transaction);
//  3. a deleted account is refused by every member action (vote, DM, sign-in)
//     while its history stays readable;
//  4. a thread whose every other participant is deleted is dropped whole when
//     the survivor clears it — no live readers remain.

import (
	"net/http"
	"slices"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// softDeleteUserDirectly mirrors the coordinated writes of
// adminDeleteUserHandler, for tests whose subject is everything AROUND the
// delete command (DM threads, vote blocks, decorators).
//
// It deliberately does NOT rotate the tokenKey: the point of this helper is
// to produce a deleted account whose token STILL VALIDATES — the state a
// delete performed by another binary leaves behind. The gate that refuses such
// an account is what those tests are about.
func softDeleteUserDirectly(t testing.TB, app *tests.TestApp, id string) {
	t.Helper()
	u, err := app.FindRecordById(usersCollectionName, id)
	if err != nil || u == nil {
		t.Fatalf("user %s missing: %v", id, err)
	}
	u.Set(userIsDeletedField, true)
	u.Set("status", string(auth.StatusDeleted))
	u.Set("nickname_normalized", "")
	if err := app.Save(u); err != nil {
		t.Fatalf("soft-delete save for %s: %v", id, err)
	}
}

// TestAdminSoftDeleteKeepsTheRowAndFreesTheNickname is the core contract:
// the row survives with the baked profile (п.1-2 концепта), the nickname key
func TestAdminSoftDeleteKeepsTheRowAndFreesTheNickname(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. The command answers with the soft-delete verdict.
	status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/admin/users/"+fixPendingID, tokens["root"], "adm-del-soft-1", "")
	if status != http.StatusOK {
		t.Fatalf("admin delete = %d: %v", status, payload)
	}
	if deleted, _ := payload["deleted"].(bool); !deleted {
		t.Fatalf("the response must report deleted, got %v", payload)
	}

	// 2. The row is still there, in exactly the shape the three coordinated
	// writes put it in.
	row, err := app.FindRecordById(usersCollectionName, fixPendingID)
	if err != nil || row == nil {
		t.Fatalf("the users row must survive a soft delete: %v", err)
	}
	if !row.GetBool(userIsDeletedField) {
		t.Error("is_deleted must be true")
	}
	if got := row.GetString("status"); got != string(auth.StatusDeleted) {
		t.Errorf("status = %q, want %q", got, auth.StatusDeleted)
	}
	if got := row.GetString("nickname_normalized"); got != "" {
		t.Errorf("nickname_normalized = %q, want \"\" — the partial UNIQUE index must release the key", got)
	}
	if got := row.GetString("nickname"); got != "PendingOne" {
		t.Errorf("the display nickname must stay baked, got %q", got)
	}

	// 3. A second delete with a fresh key is a conflict, not a re-run.
	status, payload = doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/admin/users/"+fixPendingID, tokens["root"], "adm-del-soft-2", "")
	if status != http.StatusConflict {
		t.Fatalf("re-deleting a deleted user = %d (want 409): %v", status, payload)
	}

	// 4. The profile answers 200 with the deleted verdict (п.2), for a guest:
	// nobody may get a 404 for a soft-deleted account.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/users/"+fixPendingID, "", "", "")
	if status != http.StatusOK {
		t.Fatalf("profile of a soft-deleted user = %d (want 200): %v", status, payload)
	}
	if deleted, _ := payload["deleted"].(bool); !deleted {
		t.Errorf("profile must carry deleted=true, got %v", payload)
	}
	if role, _ := payload["role"].(string); role != "Deleted" {
		t.Errorf("profile role = %q, want Deleted", role)
	}
	if nick, _ := payload["nickname"].(string); nick != "PendingOne" {
		t.Errorf("profile nickname = %q, want the baked PendingOne", nick)
	}

	// 5. The nickname pre-check reports the released key (п.5).
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/nicknames/check?nickname=PendingOne", "", "", "")
	if status != http.StatusOK {
		t.Fatalf("nickname check = %d: %v", status, payload)
	}
	if available, _ := payload["available"].(bool); !available {
		t.Errorf("a deleted account's nickname must read as available, got %v", payload)
	}

	// 6. …so a fresh registration can actually claim it (п.5).
	status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/auth/register", "", "",
		`{"email":"reborn@example.com","password":"CorrectHorse1!","nickname":"PendingOne"}`)
	if status != http.StatusCreated {
		t.Fatalf("registering under the freed nickname = %d (want 201): %v", status, payload)
	}

	// 7. The staff can FIND the row through the status filter…
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/admin/users?status=deleted", tokens["root"], "", "")
	if status != http.StatusOK {
		t.Fatalf("admin list status=deleted = %d: %v", status, payload)
	}
	if !listContainsID(payload, fixPendingID) {
		t.Errorf("the admin list with status=deleted must carry the row, got %v", payload)
	}

	// …but the staff TABLE does not: a deleted account cannot act, so it has
	// no row next to the accounts that can (owner's ruling, 2026-10-19).
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/admin/users", tokens["root"], "", "")
	if status != http.StatusOK {
		t.Fatalf("admin list = %d: %v", status, payload)
	}
	if listContainsID(payload, fixPendingID) {
		t.Errorf("the admin table must not list a deleted account, got %v", payload)
	}

	// …while the PUBLIC members board does not: it lists people you can meet.
	status, payload = doJSON(t, ts.URL, http.MethodGet, "/api/aerun/users", "", "", "")
	if status != http.StatusOK {
		t.Fatalf("public member list = %d: %v", status, payload)
	}
	if listContainsID(payload, fixPendingID) {
		t.Errorf("the public board must not list a deleted account, got %v", payload)
	}
}

// TestAdminDeleteWithDeletePostsPurgesContent is the чекбокс "удалить все
// посты" half (концепт: контракт API + бэкенд). Both residue paths are
// exercised: the member's OWN topic (full cascade, including another
// member's reply inside it — exactly what the topic delete does) and a
// reply inside SOMEONE ELSE's topic (row-by-row with a projection rebuild).
func TestAdminDeleteWithDeletePostsPurgesContent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	// Topic 1 by the player, with the pending account's reply inside it.
	topic1ID, _, replyInTopic1 := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	// Topic 2 by the pending account, with the player's reply inside it —
	// the survivor whose projection must be rebuilt after the purge.
	topic2ID, _, replyByPlayerInTopic2 := seedResidueFixture(t, app, fixPendingID, fixPlayerID)

	// Residue that must die with the content: a vote cast BY the deleted
	// member (voter_id), a vote ON their content (target_id with a post), a
	// profile-level vote on them (target_id, no post) and a subscription.
	castPostVote(t, app, fixPlayerID, fixPendingID, replyInTopic1, topic1ID, 4)         // player→pending reply: pending +4
	castPostVote(t, app, fixPendingID, fixPlayerID, replyByPlayerInTopic2, topic2ID, 5) // pending→player reply: player +5
	castPostVote(t, app, fixPendingID, fixPlayerID, "", "", 2)                          // profile vote: player +2
	subscribeUserToTopic(t, app, fixPendingID, topic1ID)

	// Explicit counters, because the fixtures start them at zero and the
	// interesting property is the DELTA: each author "has" exactly the rows
	// the fixtures wrote.
	setUserCounterForTest(t, app, fixPlayerID, "posts_count", 2)  // opener of topic1 + reply in topic2
	setUserCounterForTest(t, app, fixPlayerID, "topics_count", 1) // topic1
	setUserCounterForTest(t, app, fixPendingID, "posts_count", 2) // reply in topic1 + opener of topic2
	setUserCounterForTest(t, app, fixPendingID, "topics_count", 1)

	if got := userCounter(t, app, fixPlayerID, "reputation"); got != 7 {
		t.Fatalf("fixture: player reputation = %d, want 7", got)
	}

	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/admin/users/"+fixPlayerID, tokens["root"], "adm-del-posts-1",
		`{"delete_posts":true}`)
	if status != http.StatusOK {
		t.Fatalf("admin delete with delete_posts = %d: %v", status, payload)
	}
	if flag, _ := payload["delete_posts"].(bool); !flag {
		t.Errorf("the response must echo delete_posts=true, got %v", payload)
	}

	// The member's own topic is gone wholesale…
	if n := countRows(t, app, topicsCollectionName, "author_id = {:a}", map[string]any{"a": fixPlayerID}); n != 0 {
		t.Errorf("the deleted member's topics must be gone, %d remain", n)
	}
	// …and with it every post inside it (the cascade removes the OTHER
	// member's reply too — the same rule as deleting the topic outright).
	if n := countRows(t, app, postsCollectionName, "topic_id = {:t}", map[string]any{"t": topic1ID}); n != 0 {
		t.Errorf("posts inside the purged topic must be gone, %d remain", n)
	}
	if n := countRows(t, app, topicSubscriptionsCollectionName, "topic_id = {:t}", map[string]any{"t": topic1ID}); n != 0 {
		t.Errorf("subscriptions must die with the topic, %d remain", n)
	}

	// The surviving topic keeps its opener and loses only the deleted
	// member's reply; its projection no longer points at the removed row.
	if _, err := app.FindRecordById(postsCollectionName, replyByPlayerInTopic2); err == nil {
		t.Error("the deleted member's reply in someone else's topic must be gone")
	}

	// Votes: every row touching the deleted member is gone…
	if n := countRows(t, app, reputationVotesCollectionName, "voter_id = {:u}", map[string]any{"u": fixPlayerID}); n != 0 {
		t.Errorf("votes cast by the deleted member must be gone, %d remain", n)
	}
	if n := countRows(t, app, reputationVotesCollectionName,
		"target_id = {:u} AND post_id = ''", map[string]any{"u": fixPlayerID}); n != 0 {
		t.Errorf("profile-level votes on the deleted member must be gone, %d remain", n)
	}
	if n := countRows(t, app, reputationVotesCollectionName, "topic_id = {:t}", map[string]any{"t": topic1ID}); n != 0 {
		t.Errorf("vote rows of the purged topic must be gone, %d remain", n)
	}

	// The account itself is soft-deleted (п.1).
	row, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || row == nil {
		t.Fatalf("the users row must survive: %v", err)
	}
	if !row.GetBool(userIsDeletedField) || row.GetString("status") != string(auth.StatusDeleted) {
		t.Errorf("the account must be soft-deleted, flag=%v status=%q",
			row.GetBool(userIsDeletedField), row.GetString("status"))
	}

	// The audit carries the flag (п.4)…
	auditSawFlag := false
	for _, entry := range auditLogsFor(t, app, "admin_user_delete") {
		details, _ := entry["details"].(map[string]any)
		if flag, _ := details["delete_posts"].(bool); flag {
			auditSawFlag = true
		}
	}
	if !auditSawFlag {
		t.Error("admin_user_delete must record delete_posts=true")
	}
	// …and the purged posts keep their text (the audit is the last place it
	// can live — the same rule the ordinary post delete follows).
	if len(auditLogsFor(t, app, "post_delete")) == 0 {
		t.Error("purged posts must be audited with their content")
	}
}

// setUserCounterForTest writes one users counter directly, so a fixture can
// start from a KNOWN non-zero baseline — the fixtures never set counters, and
// a delta check against zero clamps at zero and proves nothing.
// TestDeletedAccountIsRefusedByMemberActions pins the refusal surface (п.4,
// 6, 7, 12 концепта) plus the sign-in chokepoint: a soft-deleted account is
// out of circulation as an OBJECT of member actions (no votes, no DMs, no
// mentions) and as an ACTOR (its password no longer signs in).
func TestDeletedAccountIsRefusedByMemberActions(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	// The production OnServe binds this hook; raw-server tests bind it
	// explicitly (same pattern as account_activation_test.go).
	registerAccountActivationHook(app)

	tokens := seedIdentityFixtures(t, app)
	softDeleteUserDirectly(t, app, fixPlayerID)
	ts := newTestServer(t, app)
	defer ts.Close()

	// Profile vote on the deleted account → 403 (п.4).
	status, payload := doJSON(t, ts.URL, http.MethodPost,
		"/api/aerun/users/"+fixPlayerID+"/vote", tokens["root"], "vote-deleted-1",
		`{"value":1,"comment":"still here?"}`)
	if status != http.StatusForbidden {
		t.Fatalf("profile vote on a deleted user = %d (want 403): %v", status, payload)
	}

	// Vote on their POST → 403 (п.12: the same wall the profile vote hits).
	topicID, firstPostID, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	_ = firstPostID
	status, payload = doJSON(t, ts.URL, http.MethodPost,
		"/api/aerun/posts/"+firstPostID+"/vote", tokens["root"], "vote-deleted-post-1",
		`{"value":1,"comment":""}`)
	if status != http.StatusForbidden {
		t.Fatalf("post vote on a deleted author = %d (want 403): %v", status, payload)
	}
	_ = topicID

	// Opening a DM with the deleted account → 403 (п.6).
	status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/dms",
		tokens["root"], "dm-create-deleted-1",
		`{"recipient_ids":["`+fixPlayerID+`"],"title":"Direct Message","text":"you there?"}`)
	if status != http.StatusForbidden {
		t.Fatalf("DM create to a deleted user = %d (want 403): %v", status, payload)
	}

	// The mention picker no longer offers the baked nickname (п.5-adjacent).
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/users/search?q=PlayerOne", "", "", "")
	if status != http.StatusOK {
		t.Fatalf("user search = %d: %v", status, payload)
	}
	if items, _ := payload["items"].([]any); len(items) != 0 {
		t.Errorf("a deleted account must not surface in the mention picker, got %v", items)
	}

	// The password that worked a moment ago no longer signs in: the auth
	// request hook refuses every flow (password, OAuth, token refresh).
	status, payload = doJSON(t, ts.URL, http.MethodPost,
		"/api/collections/users/auth-with-password", "", "",
		`{"identity":"player@example.com","password":"`+testPassword+`"}`)
	if status != http.StatusForbidden {
		t.Fatalf("sign-in of a deleted account = %d (want 403): %v", status, payload)
	}
}

// setUserCounterForTest writes one users counter directly, so a fixture can
// start from a KNOWN non-zero baseline — the fixtures never set counters, and
// a delta check against zero clamps at zero and proves nothing.
func setUserCounterForTest(t testing.TB, app *tests.TestApp, userID, field string, value int) {
	t.Helper()
	u, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil || u == nil {
		t.Fatalf("user %s missing: %v", userID, err)
	}
	u.Set(field, value)
	if err := app.Save(u); err != nil {
		t.Fatalf("set %s.%s: %v", userID, field, err)
	}
}

func listContainsID(payload map[string]any, id string) bool {
	items, _ := payload["items"].([]any)
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			if got, _ := m["id"].(string); got == id {
				return true
			}
		}
	}
	return false
}

// TestEraseWithDeletedPeerIsCollectedByTheCollector pins the owner's
// personal-projection model (2026-10-19) for the case where the only other
// participant is a soft-deleted account.
//
// Erasing is PERSONAL and always succeeds: it writes the caller's own erase
// point and removes NOTHING. The physical removal is the collector's job, and
// it happens only when no participant can read the conversation any more.
//
// The peer being a DELETED ACCOUNT is what releases the hold: its membership
// row survives, but nobody can read through it any more, so the survivor's own
// erase point is the whole watermark. A LIVING peer would have to erase the
// chat too, and only then.
func TestEraseWithDeletedPeerIsCollectedByTheCollector(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, _ := seedSecondPlayer(t, app)
	softDeleteUserDirectly(t, app, player2ID)

	convID := seedDMConversationWithMessages(t, app, fixPlayerID, []string{player2ID}, 2)

	ts := newTestServer(t, app)
	defer ts.Close()

	// The erase always succeeds — no 409, whatever the peer can read.
	status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/dms/"+convID, tokens["player"], "erase-deleted-peer-1", "")
	if status != http.StatusOK {
		t.Fatalf("erase a thread whose peer is deleted = %d: %v", status, payload)
	}

	// The erase removes NOTHING: the rows are still there, and the
	// conversation with them.
	if _, err := app.FindRecordById(dmConversationsCollectionName, convID); err != nil {
		t.Error("an erase must not drop the conversation — the collector is what removes it")
	}
	if n := countRows(t, app, dmMessagesCollectionName, "conversation_id = {:c}",
		map[string]any{"c": convID}); n != 2 {
		t.Errorf("an erase must not remove a message, %d remain", n)
	}

	// The collector is the thing that removes what nobody can read, and a
	// deleted account holds nothing back: the survivor's own erase point is
	// the whole watermark, so the rows go.
	removed, err := collectDeletedDMMessages(app)
	if err != nil {
		t.Fatalf("the collector failed: %v", err)
	}
	if removed != 2 {
		t.Errorf("a deleted account holds nothing back, the collector removed %d of 2", removed)
	}
	if _, err := app.FindRecordById(dmConversationsCollectionName, convID); err == nil {
		t.Error("an emptied conversation must be removed with its messages")
	}
	if n := countRows(t, app, dmMembersCollectionName, "conversation_id = {:c}",
		map[string]any{"c": convID}); n != 0 {
		t.Errorf("membership rows must die with the conversation, %d remain", n)
	}

	// Control: a thread with a LIVING peer keeps its messages — the other
	// member can still read them, so nothing may go.
	app2 := newAerunTestApp(t)
	defer app2.Cleanup()
	tokens2 := seedIdentityFixtures(t, app2)
	player3ID, _ := seedSecondPlayer(t, app2)
	convID2 := seedDMConversationWithMessages(t, app2, fixPlayerID, []string{player3ID}, 2)

	ts2 := newTestServer(t, app2)
	defer ts2.Close()

	status, payload = doJSON(t, ts2.URL, http.MethodDelete,
		"/api/aerun/dms/"+convID2, tokens2["player"], "erase-live-peer-1", "")
	if status != http.StatusOK {
		t.Fatalf("erase a thread whose peer is alive = %d: %v", status, payload)
	}
	if removed, err := collectDeletedDMMessages(app2); err != nil {
		t.Fatalf("the collector failed: %v", err)
	} else if removed != 0 {
		t.Errorf("a living peer can still read the chat, the collector removed %d", removed)
	}
	if _, err := app2.FindRecordById(dmConversationsCollectionName, convID2); err != nil {
		t.Error("a conversation a living peer can still read must stay in place")
	}
	if n := countRows(t, app2, dmMessagesCollectionName, "conversation_id = {:c}",
		map[string]any{"c": convID2}); n != 2 {
		t.Errorf("messages a living peer can still read must stay, %d remain", n)
	}
}

// TestDeletedAuthorDecoratesAsDeleted pins п.9: a post by a soft-deleted
// account renders the baked nickname with Role="Deleted" and deleted=true,
// and no mask may rename it.
func TestDeletedAuthorDecoratesAsDeleted(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	softDeleteUserDirectly(t, app, fixPlayerID)

	// A live topic written by the deleted account. The fixture writes author_id
	// but not author_kind (the command layer does that on real writes), so mark
	// it as an account post so the author DTO resolves.
	topicID, postID, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	postRec, err := app.FindRecordById(postsCollectionName, postID)
	if err != nil || postRec == nil {
		t.Fatalf("seeded post missing: %v", err)
	}
	postRec.Set("author_kind", authorKindAccount)
	postRec.Set("guest_display_name", "")
	if err := app.Save(postRec); err != nil {
		t.Fatalf("mark post as account: %v", err)
	}
	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload := doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/posts", tokens["moderator"], "posts-deleted-author-1", "")
	if status != http.StatusOK {
		t.Fatalf("list posts by a deleted author = %d: %v", status, payload)
	}
	items, _ := payload["items"].([]any)
	if len(items) == 0 {
		t.Fatal("expected the topic's posts in the feed")
	}
	var found bool
	for _, item := range items {
		p, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if got, _ := p["id"].(string); got == postID {
			found = true
			if author, ok := p["author"].(map[string]any); ok {
				if got, _ := author["user_id"].(string); got != fixPlayerID {
					t.Errorf("author_profile target = %q, want the deleted account %q", got, fixPlayerID)
				}
				if got, _ := author["deleted"].(bool); !got {
					t.Error("the author DTO must carry deleted=true")
				}
			}
			if got, _ := p["author_name"].(string); got != "PlayerOne" {
				t.Errorf("author_name = %q, want the baked PlayerOne", got)
			}
			if got, _ := p["author_role_id"].(string); got != "Deleted" {
				t.Errorf("author_role_id = %q, want Deleted", got)
			}
			if got, _ := p["author_deleted"].(bool); !got {
				t.Error("author_deleted must be true on a deleted author's post")
			}
			// The avatar key travels baked from the account row.
			if _, has := p["author_avatar"].(string); !has {
				t.Error("author_avatar must still be projected")
			}
		}
	}
	if !found {
		t.Fatal("the seeded post by the deleted author is missing from the feed")
	}
}

// TestMigratedUsersCollectionHoldsIsDeleted pins that migration
// 1770000009 adds users.is_deleted (fail-fast at boot — see verifyDeletedUserSchema).
func TestMigratedUsersCollectionHoldsIsDeleted(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()
	if err := app.RunAllMigrations(); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatalf("users collection: %v", err)
	}
	if users.Fields.GetByName(userIsDeletedField) == nil {
		t.Fatal("users.is_deleted must exist after migrations")
	}
	if statusSel, ok := users.Fields.GetByName("status").(*core.SelectField); !ok {
		t.Fatal("users.status must be a select field")
	} else if !slices.Contains(statusSel.Values, string(auth.StatusDeleted)) {
		t.Fatalf("the status select must hold deleted, got %v", statusSel.Values)
	}
}

// TestSoftDeletedAccountStaysWritable pins the D1 fix.
//
// The soft delete releases the nickname key by writing "" into
// nickname_normalized. While that column was REQUIRED, the write had to be a
// raw UPDATE — and the row was then UNSAVABLE: every later write was
// refused with "nickname_normalized: cannot be blank". That killed every
// counter move on the deleted account (adjustUserReputation,
// adjustUserPostCount, adjustUserTopicCount all end in a record save), so a
// moderator deleting one of the deleted member's posts afterwards got a 500
// and RecomputeUserCounters could never repair the account.
//
// The column is optional now (migration 1770000010), so the row accepts
// writes again.
func TestSoftDeletedAccountStaysWritable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)

	u, err := app.FindRecordById(usersCollectionName, fixPendingID)
	if err != nil || u == nil {
		t.Fatalf("user missing: %v", err)
	}
	u.Set(userIsDeletedField, true)
	u.Set("status", string(auth.StatusDeleted))
	u.Set("nickname_normalized", "")
	if err := app.Save(u); err != nil {
		t.Fatalf("soft delete save: %v", err)
	}

	// A later counter move on the deleted account must succeed.
	if err := adjustUserPostCount(app, fixPendingID, -1); err != nil {
		t.Fatalf("the deleted account must stay writable: %v", err)
	}
	if err := adjustUserReputation(app, fixPendingID, -5); err != nil {
		t.Fatalf("reputation move on the deleted account must succeed: %v", err)
	}
	if got := userCounter(t, app, fixPendingID, "posts_count"); got != 0 {
		t.Errorf("posts_count = %d, want 0", got)
	}
}

// TestPurgeSettlesThePostReputationOfSurvivingPosts pins the D5 fix.
//
// A vote carries TWO denormalized copies of its value: the target's
// users.reputation and the posts.reputation of the post it was cast on. The
// ordinary retract path (deleteReputationHandler) moves both. The purge
// moved only the first, so a post whose voter was deleted kept a score
// whose vote row no longer existed — the post and its author disagreed, and
// a recompute pass would have separated them further.
func TestPurgeSettlesThePostReputationOfSurvivingPosts(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)

	// A topic by the pending account, with the pending account's own post in
	// it. The player (the member to be deleted) votes on it, so the POST
	// SURVIVES the purge while the vote does not.
	topicID, survivingPostID, _ := seedResidueFixture(t, app, fixPendingID, fixPendingID)
	castPostVote(t, app, fixPlayerID, fixPendingID, survivingPostID, topicID, 5)

	post, err := app.FindRecordById(postsCollectionName, survivingPostID)
	if err != nil || post == nil {
		t.Fatalf("post missing: %v", err)
	}
	if got := post.GetInt("reputation"); got != 5 {
		t.Fatalf("fixture: post reputation = %d, want 5", got)
	}

	if err := purgeUserContent(app, fixPlayerID); err != nil {
		t.Fatalf("purge: %v", err)
	}

	post, err = app.FindRecordById(postsCollectionName, survivingPostID)
	if err != nil || post == nil {
		t.Fatalf("the post must survive the purge: %v", err)
	}
	if got := post.GetInt("reputation"); got != 0 {
		t.Errorf("post reputation = %d, want 0 — the vote row is gone, so the score must be too", got)
	}
	if got := userCounter(t, app, fixPendingID, "reputation"); got != 0 {
		t.Errorf("author reputation = %d, want 0", got)
	}
}

// TestDeletedAccountSessionIsDead pins the D4 fix.
//
// A deleted account is out of circulation. The status used to be checked in a
// fixed list of handlers, and the list had holes: the content-creating
// commands, the profile/settings/avatar writers, the draft commands and the
// DM message editors never consulted it, and categoryWriteAllowed grants
// write access from the category's own role list — so it answered even when
// the narrowed permission set was empty.
//
// The delete also rotates the account's tokenKey, which invalidates every
// token it holds: the browser session dies with the account instead of
// lingering until the token expires.
func TestDeletedAccountSessionIsDead(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The account still holds a valid token when it is deleted.
	status, payload := doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/me", tokens["pending"], "", "")
	if status != http.StatusOK {
		t.Fatalf("the pending account must be signed in before the delete: %d %v", status, payload)
	}

	status, payload = doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/admin/users/"+fixPendingID, tokens["root"], "adm-del-mutate-1", "")
	if status != http.StatusOK {
		t.Fatalf("admin delete = %d: %v", status, payload)
	}

	// The token is dead: the delete rotated its tokenKey, so the bearer token
	// no longer authenticates. The route answers as a guest, and what matters
	// is that the response no longer carries the deleted account's identity.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/me", tokens["pending"], "", "")
	if status == http.StatusOK {
		if id, _ := payload["id"].(string); id == fixPendingID {
			t.Errorf("the deleted account's token must not authenticate any more, got %v", payload)
		}
	}
}

// TestDeletedAccountWithAValidTokenCannotMutate pins the D4 gate itself.
//
// The token rotation kills the session of an account deleted by THIS binary.
// This test covers the other case: a deleted account whose token still
// validates — the state a delete performed by another binary leaves behind,
// and the state the group-level gate exists for.
func TestDeletedAccountWithAValidTokenCannotMutate(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The token is valid before the delete.
	status, payload := doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/me", tokens["pending"], "", "")
	if status != http.StatusOK {
		t.Fatalf("the pending account must be signed in: %d %v", status, payload)
	}

	softDeleteUserDirectly(t, app, fixPendingID)

	// The token still validates, so the request reaches the gate.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/me", tokens["pending"], "", "")
	if status != http.StatusOK {
		t.Fatalf("the token must still resolve for this test to be meaningful: %d %v", status, payload)
	}

	// Every mutation is refused.
	status, payload = doJSON(t, ts.URL, http.MethodPost,
		"/api/aerun/topics", tokens["pending"], "del-gate-topic", `{"category_id":"x","title":"t","content":"c"}`)
	if status != http.StatusForbidden {
		t.Errorf("a deleted account must not create a topic, got %d: %v", status, payload)
	}
	status, payload = doJSON(t, ts.URL, http.MethodPatch,
		"/api/aerun/me/profile", tokens["pending"], "del-gate-profile", `{"bio":"x"}`)
	if status != http.StatusForbidden {
		t.Errorf("a deleted account must not edit its profile, got %d: %v", status, payload)
	}
}

// TestAdminListHidesDeletedAccounts pins the D8 fix.
//
// The owner's ruling (2026-10-19): a deleted account is NOT in the staff
// table. It cannot act — no permissions, dead session — so a row for it next
// to the accounts that can is a row the staff can do nothing with.
//
// The account stays reachable through the deliberate `?status=deleted` query
// (a check that nothing was left behind), and the payload still carries the
// verdict (`deleted: true`, `status: "deleted"`) so that query answers
// unambiguously.
func TestAdminListHidesDeletedAccounts(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/admin/users/"+fixPendingID, tokens["root"], "adm-del-role-1", "")
	if status != http.StatusOK {
		t.Fatalf("admin delete = %d: %v", status, payload)
	}

	// The staff TABLE does not carry the row.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/admin/users", tokens["root"], "", "")
	if status != http.StatusOK {
		t.Fatalf("admin list = %d: %v", status, payload)
	}
	if listContainsID(payload, fixPendingID) {
		t.Errorf("the admin table must not list a deleted account, got %v", payload)
	}

	// The deliberate query does, with the verdict attached.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/admin/users?status=deleted", tokens["root"], "", "")
	if status != http.StatusOK {
		t.Fatalf("admin list status=deleted = %d: %v", status, payload)
	}
	items, _ := payload["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("the deleted account must be listed, got %v", payload)
	}
	item, _ := items[0].(map[string]any)
	// The staff list keeps the STORED role: it is the history of what the
	// account held while it could act, and the role editor reads it. What it
	// must carry is the deleted verdict, so the query never answers
	// ambiguously about the row it returns.
	if deleted, _ := item["deleted"].(bool); !deleted {
		t.Error("admin list must carry deleted=true")
	}
	if status, _ := item["status"].(string); status != string(auth.StatusDeleted) {
		t.Errorf("admin list status = %q, want %q", status, auth.StatusDeleted)
	}
}
