package pocketbase

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// Helper to seed a target player
func seedTargetUser(t testing.TB, app *tests.TestApp) (string, string) {
	t.Helper()
	id := "usertarget00001"
	token := createTestUser(t, app, id, "target@example.com", "TargetUser", auth.RolePlayer, auth.StatusActive)
	return id, token
}

// seedTopicInCategory seeds a topic and its opening post in the given category.
func seedTopicInCategory(t testing.TB, app *tests.TestApp, categoryID, authorID string) (string, string) {
	t.Helper()

	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", categoryID)
	topic.Set("author_id", authorID)
	topic.Set("title", "Test Topic")
	topic.Set("posts_count", 1)
	topic.Set("locked", false)
	topic.Set("pinned", false)
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	post := core.NewRecord(postsCol)
	post.Set("topic_id", topic.Id)
	post.Set("author_id", authorID)
	post.Set("content", "Initial post content")
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}

	topic.Set("last_post_id", post.Id)
	topic.Set("last_post_created", post.GetDateTime("created"))
	topic.Set("last_post_author_id", authorID)
	_ = app.Save(topic)

	return topic.Id, post.Id
}

// Helper to seed a topic and initial post in General category
func seedTopicAndPost(t testing.TB, app *tests.TestApp, authorID string) (string, string) {
	t.Helper()
	catID := getGeneralCategoryID(t, app)

	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", authorID)
	topic.Set("title", "Test Topic")
	topic.Set("posts_count", 1)
	topic.Set("locked", false)
	topic.Set("pinned", false)
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	post := core.NewRecord(postsCol)
	post.Set("topic_id", topic.Id)
	post.Set("author_id", authorID)
	post.Set("content", "Initial post content")
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}

	topic.Set("last_post_id", post.Id)
	topic.Set("last_post_created", post.GetDateTime("created"))
	topic.Set("last_post_author_id", authorID)
	_ = app.Save(topic)

	return topic.Id, post.Id
}

// ---------------------------------------------------------------------------
// 1. Transactional vote creation/removal & score updates
// ---------------------------------------------------------------------------

func TestSprint4ReputationVotingAndScoreUpdates(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	voterToken := tokens["player"]
	targetID, _ := seedTargetUser(t, app)
	_, postID := seedTopicAndPost(t, app, fixPlayerID)

	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. Self-voting rejected on post
	{
		body := `{"value":1,"comment":"great"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/posts/"+postID+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", voterToken)
		req.Header.Set("Idempotency-Key", "self-vote-test")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("expected 400 Bad Request for self-vote, got %d", res.StatusCode)
		}
	}

	// Create a post owned by TargetUser
	colPosts, _ := app.FindCollectionByNameOrId(postsCollectionName)
	targetPost := core.NewRecord(colPosts)
	targetPost.Set("topic_id", "some_topic")
	targetPost.Set("author_id", targetID)
	targetPost.Set("content", "Post by target user")
	// Bind to general topic. No deleted filter: every topic row is live, because a
	// deleted one no longer exists (1767700000).
	top, _ := app.FindFirstRecordByFilter(topicsCollectionName, "id != ''")
	targetPost.Set("topic_id", top.Id)
	if err := app.Save(targetPost); err != nil {
		t.Fatal(err)
	}

	// 2. Valid vote by Player on TargetUser's post
	{
		body := `{"value":1,"comment":"Helpful answer!"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/posts/"+targetPost.Id+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", voterToken)
		req.Header.Set("Idempotency-Key", "vote-post-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("expected 200 OK, got %d: %s", res.StatusCode, string(b))
		}
		res.Body.Close()

		// Verify target user reputation +1, post reputation +1
		u, _ := app.FindRecordById(usersCollectionName, targetID)
		if u.GetInt("reputation") != 1 {
			t.Fatalf("expected user reputation 1, got %d", u.GetInt("reputation"))
		}
		p, _ := app.FindRecordById(postsCollectionName, targetPost.Id)
		if p.GetInt("reputation") != 1 {
			t.Fatalf("expected post reputation 1, got %d", p.GetInt("reputation"))
		}
	}

	// 3. Controlled replacement: change vote from +1 to -1
	{
		body := `{"value":-1,"comment":"Changed my mind"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/posts/"+targetPost.Id+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", voterToken)
		req.Header.Set("Idempotency-Key", "vote-post-2")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// Delta was -2 (from +1 to -1), so user reputation is now -1, post is now -1
		u, _ := app.FindRecordById(usersCollectionName, targetID)
		if u.GetInt("reputation") != -1 {
			t.Fatalf("expected user reputation -1, got %d", u.GetInt("reputation"))
		}
		p, _ := app.FindRecordById(postsCollectionName, targetPost.Id)
		if p.GetInt("reputation") != -1 {
			t.Fatalf("expected post reputation -1, got %d", p.GetInt("reputation"))
		}
	}

	// 4. Voter removes their vote: DELETE /api/aerun/posts/{id}/vote
	{
		req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/aerun/posts/"+targetPost.Id+"/vote", nil)
		req.Header.Set("Authorization", voterToken)
		req.Header.Set("Idempotency-Key", "vote-post-del-1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// Scores reverted back to 0
		u, _ := app.FindRecordById(usersCollectionName, targetID)
		if u.GetInt("reputation") != 0 {
			t.Fatalf("expected user reputation 0, got %d", u.GetInt("reputation"))
		}
		p, _ := app.FindRecordById(postsCollectionName, targetPost.Id)
		if p.GetInt("reputation") != 0 {
			t.Fatalf("expected post reputation 0, got %d", p.GetInt("reputation"))
		}
	}

	// 5. Profile voting: POST /api/aerun/users/{id}/vote and DELETE
	{
		body := `{"value":1,"comment":"Great community member"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/users/"+targetID+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", voterToken)
		req.Header.Set("Idempotency-Key", "vote-profile-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		u, _ := app.FindRecordById(usersCollectionName, targetID)
		if u.GetInt("reputation") != 1 {
			t.Fatalf("expected user reputation 1, got %d", u.GetInt("reputation"))
		}

		// Delete profile vote
		delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/aerun/users/"+targetID+"/vote", nil)
		delReq.Header.Set("Authorization", voterToken)
		delReq.Header.Set("Idempotency-Key", "vote-profile-del-1")
		delRes, err := http.DefaultClient.Do(delReq)
		if err != nil {
			t.Fatal(err)
		}
		if delRes.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", delRes.StatusCode)
		}
		delRes.Body.Close()

		u, _ = app.FindRecordById(usersCollectionName, targetID)
		if u.GetInt("reputation") != 0 {
			t.Fatalf("expected user reputation 0 after profile vote removal, got %d", u.GetInt("reputation"))
		}
	}
}

// ---------------------------------------------------------------------------
// 2. Idempotent subscribe / unsubscribe commands
// ---------------------------------------------------------------------------

func TestSprint4SubscriptionsIdempotency(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	playerToken := tokens["player"]
	topicID, _ := seedTopicAndPost(t, app, fixPlayerID)

	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. Initial status: false
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/topics/"+topicID+"/subscription", nil)
		req.Header.Set("Authorization", playerToken)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Subscribed bool `json:"subscribed"`
		}
		_ = json.NewDecoder(res.Body).Decode(&payload)
		res.Body.Close()
		if payload.Subscribed {
			t.Fatal("expected initially not subscribed")
		}
	}

	// 2. Subscribe
	{
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/topics/"+topicID+"/subscribe", nil)
		req.Header.Set("Authorization", playerToken)
		req.Header.Set("Idempotency-Key", "sub-key-1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// Verify status is now true
		reqStatus, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/topics/"+topicID+"/subscription", nil)
		reqStatus.Header.Set("Authorization", playerToken)
		resStatus, _ := http.DefaultClient.Do(reqStatus)
		var p struct {
			Subscribed bool `json:"subscribed"`
		}
		_ = json.NewDecoder(resStatus.Body).Decode(&p)
		resStatus.Body.Close()
		if !p.Subscribed {
			t.Fatal("expected subscribed=true")
		}
	}

	// 3. Repeated subscribe with DIFFERENT idempotency key is an idempotent no-op (never toggles!)
	{
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/topics/"+topicID+"/subscribe", nil)
		req.Header.Set("Authorization", playerToken)
		req.Header.Set("Idempotency-Key", "sub-key-2")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// Ensure strictly 1 row in topic_subscriptions
		subs, err := app.FindAllRecords(topicSubscriptionsCollectionName, nil)
		if err != nil || len(subs) != 1 {
			t.Fatalf("expected exactly 1 subscription row, got %d", len(subs))
		}
	}

	// 4. Unsubscribe
	{
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/topics/"+topicID+"/unsubscribe", nil)
		req.Header.Set("Authorization", playerToken)
		req.Header.Set("Idempotency-Key", "unsub-key-1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		subs, _ := app.FindAllRecords(topicSubscriptionsCollectionName, nil)
		if len(subs) != 0 {
			t.Fatalf("expected 0 subscription rows, got %d", len(subs))
		}

		// Re-unsubscribing is clean no-op
		req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/topics/"+topicID+"/unsubscribe", nil)
		req2.Header.Set("Authorization", playerToken)
		req2.Header.Set("Idempotency-Key", "unsub-key-2")
		res2, _ := http.DefaultClient.Do(req2)
		if res2.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK on repeated unsubscribe, got %d", res2.StatusCode)
		}
		res2.Body.Close()
	}
}

// ---------------------------------------------------------------------------
// 3. Append-only audit inside administrative commands
// ---------------------------------------------------------------------------

func TestSprint4AdministrativeAuditLogging(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	modToken := tokens["moderator"]
	rootToken := tokens["root"]
	playerToken := tokens["player"]
	topicID, postID := seedTopicAndPost(t, app, fixPlayerID)

	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. Moderator pins topic -> audit log appended
	{
		body := `{"pinned":true}`
		req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/topics/"+topicID, strings.NewReader(body))
		req.Header.Set("Authorization", modToken)
		req.Header.Set("Idempotency-Key", "audit-pin-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		log, err := app.FindFirstRecordByFilter(auditLogsCollectionName, "action_type = 'topic_pin'")
		if err != nil || log == nil {
			t.Fatal("expected audit log for topic_pin")
		}
		if log.GetString("performer_id") != fixModeratorID {
			t.Fatalf("expected performer_id %s, got %s", fixModeratorID, log.GetString("performer_id"))
		}
	}

	// 2. Moderator locks topic -> audit log appended
	{
		body := `{"locked":true}`
		req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/topics/"+topicID, strings.NewReader(body))
		req.Header.Set("Authorization", modToken)
		req.Header.Set("Idempotency-Key", "audit-lock-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		log, err := app.FindFirstRecordByFilter(auditLogsCollectionName, "action_type = 'topic_lock'")
		if err != nil || log == nil {
			t.Fatal("expected audit log for topic_lock")
		}
	}

	// 3. Moderator edits post -> audit log appended
	{
		body := `{"content":"Edited by moderator for civility."}`
		req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/posts/"+postID, strings.NewReader(body))
		req.Header.Set("Authorization", modToken)
		req.Header.Set("Idempotency-Key", "audit-post-edit-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		log, err := app.FindFirstRecordByFilter(auditLogsCollectionName, "action_type = 'post_edit'")
		if err != nil || log == nil {
			t.Fatal("expected audit log for post_edit")
		}
	}

	// 4. Audit query endpoint: GET /api/aerun/admin/audit-logs
	{
		// Player should be denied (403)
		reqUser, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/admin/audit-logs", nil)
		reqUser.Header.Set("Authorization", playerToken)
		resUser, _ := http.DefaultClient.Do(reqUser)
		if resUser.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden for player, got %d", resUser.StatusCode)
		}
		resUser.Body.Close()

		// Root should succeed (200)
		reqRoot, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/admin/audit-logs", nil)
		reqRoot.Header.Set("Authorization", rootToken)
		resRoot, err := http.DefaultClient.Do(reqRoot)
		if err != nil {
			t.Fatal(err)
		}
		if resRoot.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK for root, got %d", resRoot.StatusCode)
		}

		var payload struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(resRoot.Body).Decode(&payload)
		resRoot.Body.Close()

		if len(payload.Items) < 3 {
			t.Fatalf("expected at least 3 audit entries, got %d", len(payload.Items))
		}
	}
}

// ---------------------------------------------------------------------------
// 4. Definition of Done: Hidden-category post never leaks through voter or profile endpoints
// ---------------------------------------------------------------------------

func TestSprint4DoDHiddenCategoryLeakPrevention(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	rootToken := tokens["root"]
	playerToken := tokens["player"]
	targetID, _ := seedTargetUser(t, app)

	// 1. Create a Secret Category restricted to staff only
	colCat, _ := app.FindCollectionByNameOrId(categoriesCollectionName)
	secretCat := core.NewRecord(colCat)
	secretCat.Set("name", "Staff Secret Chamber")
	secretCat.Set("slug", "staff-secret")
	secretCat.Set("permissions", map[string]any{
		"view_forum": []string{"root", "admin", "moderator"},
	})
	if err := app.Save(secretCat); err != nil {
		t.Fatal(err)
	}

	// 2. Create topic and post in Secret Category owned by TargetUser
	colTop, _ := app.FindCollectionByNameOrId(topicsCollectionName)
	secretTopic := core.NewRecord(colTop)
	secretTopic.Set("category_id", secretCat.Id)
	secretTopic.Set("author_id", targetID)
	secretTopic.Set("title", "Classified Intelligence")
	secretTopic.Set("posts_count", 1)
	if err := app.Save(secretTopic); err != nil {
		t.Fatal(err)
	}

	colPosts, _ := app.FindCollectionByNameOrId(postsCollectionName)
	secretPost := core.NewRecord(colPosts)
	secretPost.Set("topic_id", secretTopic.Id)
	secretPost.Set("author_id", targetID)
	secretPost.Set("content", "Top secret payload")
	if err := app.Save(secretPost); err != nil {
		t.Fatal(err)
	}

	ts := newTestServer(t, app)
	defer ts.Close()

	// 3. Root casts a vote on the secret post
	{
		body := `{"value":1,"comment":"Staff commendation"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/posts/"+secretPost.Id+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", rootToken)
		req.Header.Set("Idempotency-Key", "root-vote-secret-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("expected 200 OK for root vote, got %d: %s", res.StatusCode, string(b))
		}
		res.Body.Close()
	}

	// 4. Also seed a normal public post in General category and cast a vote on it
	genTopicID, genPostID := seedTopicAndPost(t, app, targetID)
	{
		body := `{"value":1,"comment":"Public commendation"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/posts/"+genPostID+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", rootToken)
		req.Header.Set("Idempotency-Key", "root-vote-public-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}

	// -----------------------------------------------------------------------
	// DoD Check A: GET /api/aerun/posts/{id}/voters for secret post
	// Regular player must get 403 Forbidden!
	// -----------------------------------------------------------------------
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/posts/"+secretPost.Id+"/voters", nil)
		req.Header.Set("Authorization", playerToken)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden when player requests voters of secret post, got %d", res.StatusCode)
		}
		res.Body.Close()
	}

	// -----------------------------------------------------------------------
	// DoD Check B: GET /api/aerun/users/{target_id}/reputation
	// Regular player must NOT see secret category post_id or topic_title!
	// -----------------------------------------------------------------------
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/users/"+targetID+"/reputation", nil)
		req.Header.Set("Authorization", playerToken)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}

		var payload struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(res.Body).Decode(&payload)
		res.Body.Close()

		if len(payload.Items) != 2 {
			t.Fatalf("expected 2 reputation items, got %d", len(payload.Items))
		}

		for _, item := range payload.Items {
			// If item represents the vote on secret post
			isAllowed := item["is_allowed"].(bool)
			if !isAllowed {
				// Must be stripped/masked!
				if item["post_id"] != nil {
					t.Fatalf("LEAK DETECTED: post_id of secret post leaked: %v", item["post_id"])
				}
				if title, _ := item["topic_title"].(string); title != "" {
					t.Fatalf("LEAK DETECTED: topic_title of secret category leaked: %v", title)
				}
			} else {
				// Public post is allowed
				if item["post_id"] != genPostID {
					t.Fatalf("expected public post_id %s, got %v", genPostID, item["post_id"])
				}
			}
		}
	}
	_ = genTopicID
}

// TestGetPostHidesAPostInARestrictedCategory pins SEC-01 for the deep-link
// route: a post id alone must not be a way around category visibility.
//
// The category is gated by allowed_roles (ADR-1), the store the readers
// consult — not by the legacy `permissions` map, which nothing reads any more.
// The check runs for a guest and for a signed-in player who is not listed, and
// both must get the same 404 a missing post gets: a 403 would confirm the
// post exists and turn the id space into a probe.
func TestGetPostHidesAPostInARestrictedCategory(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	targetID, _ := seedTargetUser(t, app)

	// A category readable only by moderation and above.
	colCat, _ := app.FindCollectionByNameOrId(categoriesCollectionName)
	secretCat := core.NewRecord(colCat)
	secretCat.Set("name", "Staff Secret Chamber")
	secretCat.Set("slug", "staff-secret-deep-link")
	secretCat.Set("allowed_roles", []string{"moderator", "admin", "root"})
	if err := app.Save(secretCat); err != nil {
		t.Fatal(err)
	}
	secretTopicID, secretPostID := seedTopicInCategory(t, app, secretCat.Id, targetID)

	// A post in General, which every role may read, so the route itself is
	// proven to answer 200 in the same test.
	_, publicPostID := seedTopicAndPost(t, app, targetID)

	ts := newTestServer(t, app)
	defer ts.Close()

	get := func(postID, token string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/posts/"+postID, nil)
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, body
	}

	// A guest cannot open the deep link, and the answer is indistinguishable
	// from a post that does not exist.
	if status, _ := get(secretPostID, ""); status != http.StatusNotFound {
		t.Fatalf("guest deep link into a restricted category: want 404, got %d", status)
	}
	// A signed-in player who is not listed gets the same answer.
	if status, _ := get(secretPostID, tokens["player"]); status != http.StatusNotFound {
		t.Fatalf("player deep link into a restricted category: want 404, got %d", status)
	}
	// A moderator, who is listed, reads it.
	if status, _ := get(secretPostID, tokens["moderator"]); status != http.StatusOK {
		t.Fatalf("moderator deep link into a listed category: want 200, got %d", status)
	}
	// And the public post is reachable by a guest, so the gate is the
	// category and not the route.
	status, body := get(publicPostID, "")
	if status != http.StatusOK {
		t.Fatalf("guest deep link into a public category: want 200, got %d (%s)", status, body)
	}
	if !strings.Contains(string(body), "Initial post content") {
		t.Fatalf("public deep link must carry the post content, got %s", body)
	}

	// A post in a category the caller cannot see must not move the author's
	// profile Posts tab either: neither the row nor its title nor a count.
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/users/"+targetID+"/posts", nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("profile posts: want 200, got %d", res.StatusCode)
		}
		var payload struct {
			Items []map[string]any `json:"items"`
			Total int64            `json:"total"`
		}
		if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload.Total != 1 {
			t.Fatalf("guest must see only the public post of the author, total=%d", payload.Total)
		}
		for _, item := range payload.Items {
			if item["id"] == secretPostID {
				t.Fatalf("LEAK: a post from a restricted category appeared in the profile tab: %v", item)
			}
			// The restricted topic carries the same seed title ("Test Topic")
			// as the public one, so a title check needs the topic id: the
			// secret topic's title must not reach a guest at all.
			if item["topic_id"] == secretTopicID {
				t.Fatalf("LEAK: a topic title from a restricted category appeared in the profile tab: %v", item)
			}
		}
	}
}

// TestGuestPrincipalCookieIsSecure pins SEC-06: the capability cookie is
// issued Secure even though the backend sits behind a TLS-terminating proxy
// and r.TLS is nil.
func TestGuestPrincipalCookieIsSecure(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// The test server runs the app's own router, so registerRoutes' middleware
	// stashes the configured public origin (an http loopback origin here, as in
	// every other test) — and the Secure decision therefore has to come from
	// the forwarded-proto header, which Caddy sets in production.
	ts := newTestServer(t, app)
	defer ts.Close()

	create := func(forwardedProto string) *http.Cookie {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/guest/principal", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "idem-guest-principal-secure-"+forwardedProto+"-"+strconv.FormatInt(time.Now().UnixNano(), 10))
		if forwardedProto != "" {
			req.Header.Set("X-Forwarded-Proto", forwardedProto)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			body, _ := io.ReadAll(res.Body)
			t.Fatalf("principal create: want 201, got %d (%s)", res.StatusCode, body)
		}
		for _, c := range res.Cookies() {
			if c.Name == guestPrincipalCookieName {
				return c
			}
		}
		t.Fatal("creation must set the capability cookie")
		return nil
	}

	// Over the plain loopback socket with no proxy header, the cookie is not
	// Secure: there is no TLS to hand it to.
	if c := create(""); c.Secure {
		t.Fatal("a plain loopback request must not get a Secure cookie")
	}
	// Behind the proxy the header says HTTPS, and the cookie is Secure.
	if c := create("https"); !c.Secure {
		t.Fatal("X-Forwarded-Proto: https must yield a Secure cookie")
	}
}

// ---------------------------------------------------------------------------
// 5. Privacy settings masking
// ---------------------------------------------------------------------------

func TestSprint4PrivacySettingsMasking(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	targetID, _ := seedTargetUser(t, app)
	playerToken := tokens["player"]
	rootToken := tokens["root"]

	// Set target user settings: rep_show_history = false
	u, _ := app.FindRecordById(usersCollectionName, targetID)
	u.Set("settings", map[string]any{
		"rep_show_history":  false,
		"rep_show_comments": false,
	})
	if err := app.Save(u); err != nil {
		t.Fatal(err)
	}

	_, postID := seedTopicAndPost(t, app, targetID)

	ts := newTestServer(t, app)
	defer ts.Close()

	// Player votes on target's post
	{
		body := `{"value":1,"comment":"Nice topic"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/posts/"+postID+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", playerToken)
		req.Header.Set("Idempotency-Key", "priv-vote-1")
		req.Header.Set("Content-Type", "application/json")
		res, _ := http.DefaultClient.Do(req)
		res.Body.Close()
	}

	// 1. Regular player querying target user's reputation: hidden = true, items empty
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/users/"+targetID+"/reputation", nil)
		req.Header.Set("Authorization", playerToken)
		res, _ := http.DefaultClient.Do(req)
		var p struct {
			Hidden bool             `json:"hidden"`
			Items  []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(res.Body).Decode(&p)
		res.Body.Close()
		if !p.Hidden || len(p.Items) != 0 {
			t.Fatalf("expected hidden=true and 0 items for private user, got hidden=%v, items=%d", p.Hidden, len(p.Items))
		}
	}

	// 2. Staff querying target user's reputation: hidden = false, visible
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/users/"+targetID+"/reputation", nil)
		req.Header.Set("Authorization", rootToken)
		res, _ := http.DefaultClient.Do(req)
		var p struct {
			Hidden bool             `json:"hidden"`
			Items  []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(res.Body).Decode(&p)
		res.Body.Close()
		if p.Hidden || len(p.Items) == 0 {
			t.Fatalf("expected staff to view private reputation, got hidden=%v, items=%d", p.Hidden, len(p.Items))
		}

		// The server must ship the voter's real nickname, not leave the field
		// absent — an absent voter_nickname made every history row render the
		// "User" placeholder, even for staff. The voter here is the seeded
		// player ("PlayerOne"), whose own rep_show_history defaults to true, so
		// staff see the resolved name and the voter id.
		item := p.Items[0]
		if nick, _ := item["voter_nickname"].(string); nick != "PlayerOne" {
			t.Fatalf("expected voter_nickname %q in reputation history, got %v", "PlayerOne", item["voter_nickname"])
		}
		if id, _ := item["voter_id"].(string); id != fixPlayerID {
			t.Fatalf("expected voter_id %q, got %v", fixPlayerID, item["voter_id"])
		}
	}
}

// ---------------------------------------------------------------------------
// 6. Concurrency DoD: 20 parallel votes & subscriptions cannot duplicate rows
// ---------------------------------------------------------------------------

func TestSprint4ConcurrentVotesAndSubscriptionsDoD(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	voterToken := tokens["player"]
	targetID, _ := seedTargetUser(t, app)
	topicID, postID := seedTopicAndPost(t, app, targetID)

	ts := newTestServer(t, app)
	defer ts.Close()

	// 20 concurrent identical vote requests
	const concurrency = 20
	var wg sync.WaitGroup
	wg.Add(concurrency)

	responses := make([]int, concurrency)
	responseBodies := make([]string, concurrency)
	replayFlags := make([]string, concurrency)

	for i := 0; i < concurrency; i++ {
		go func(idx int) {
			defer wg.Done()
			body := `{"value":1,"comment":"Concurrency test"}`
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/posts/"+postID+"/vote", strings.NewReader(body))
			req.Header.Set("Authorization", voterToken)
			req.Header.Set("Idempotency-Key", "concurrency-rep-key")
			req.Header.Set("Content-Type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			responses[idx] = res.StatusCode
			replayFlags[idx] = res.Header.Get("Idempotency-Replayed")
			b, _ := io.ReadAll(res.Body)
			responseBodies[idx] = string(b)
			res.Body.Close()
		}(i)
	}
	wg.Wait()

	// All must be 200 OK
	for i, status := range responses {
		if status != http.StatusOK {
			t.Fatalf("expected 200 OK on concurrent vote, got %d for req %d: body=%s", status, i, responseBodies[i])
		}
	}

	// Exactly 1 vote row in database
	votes, err := app.FindAllRecords(reputationVotesCollectionName, nil)
	if err != nil || len(votes) != 1 {
		t.Fatalf("expected exactly 1 vote in database, got %d", len(votes))
	}

	// Score is exactly 1, not inflated
	p, _ := app.FindRecordById(postsCollectionName, postID)
	if p.GetInt("reputation") != 1 {
		t.Fatalf("expected post reputation 1, got %d", p.GetInt("reputation"))
	}
	u, _ := app.FindRecordById(usersCollectionName, targetID)
	if u.GetInt("reputation") != 1 {
		t.Fatalf("expected user reputation 1, got %d", u.GetInt("reputation"))
	}

	// 20 concurrent subscribe requests
	var subWg sync.WaitGroup
	subWg.Add(concurrency)
	subStatuses := make([]int, concurrency)

	for i := 0; i < concurrency; i++ {
		go func(idx int) {
			defer subWg.Done()
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/topics/"+topicID+"/subscribe", nil)
			req.Header.Set("Authorization", voterToken)
			req.Header.Set("Idempotency-Key", fmt.Sprintf("concurrency-sub-key-%d", idx))
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			subStatuses[idx] = res.StatusCode
			res.Body.Close()
		}(i)
	}
	subWg.Wait()

	for i, st := range subStatuses {
		if st != http.StatusOK {
			t.Fatalf("expected 200 OK on concurrent subscribe, got %d for req %d", st, i)
		}
	}

	// Exactly 1 subscription row in database
	subs, err := app.FindAllRecords(topicSubscriptionsCollectionName, nil)
	if err != nil || len(subs) != 1 {
		t.Fatalf("expected exactly 1 subscription in database, got %d", len(subs))
	}
}
