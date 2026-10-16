package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// helper to get seeded category id (General)
func getGeneralCategoryID(t testing.TB, app *tests.TestApp) string {
	cat, err := app.FindFirstRecordByFilter(categoriesCollectionName, "slug = 'general'")
	if err != nil || cat == nil {
		t.Fatalf("general category missing: %v", err)
	}
	return cat.Id
}

func newTestServer(t testing.TB, app *tests.TestApp) *httptest.Server {
	t.Helper()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	se := &core.ServeEvent{
		App:    app,
		Router: router,
	}
	if err := app.OnServe().Trigger(se, func(e *core.ServeEvent) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(mux)
}

// ---------------------------------------------------------------------------
// POST /api/aerun/topics (Sprint 3 task 1: CreateTopic)
// ---------------------------------------------------------------------------

func TestCreateTopicAndFirstPost(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "player creates a new topic with initial post",
		Method:         http.MethodPost,
		URL:            "/api/aerun/topics",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusCreated,
		ExpectedContent: []string{
			`"title":"My First Topic"`,
			`"posts_count":1`,
			`"content":"This is the opening post of my first topic."`,
			`"request_id":"`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			tokens := seedIdentityFixtures(t, app)
			catID := getGeneralCategoryID(t, app)
			body := fmt.Sprintf(`{"category_id":"%s","title":"My First Topic","content":"This is the opening post of my first topic."}`, catID)
			scenario.Body = strings.NewReader(body)
			scenario.Headers = map[string]string{
				"Authorization":   tokens["player"],
				"Idempotency-Key": "idem-topic-create-1",
			}
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'My First Topic'")
			if err != nil || topic == nil {
				t.Fatalf("topic was not created: %v", err)
			}
			if topic.GetInt("posts_count") != 1 {
				t.Fatalf("expected posts_count=1, got %d", topic.GetInt("posts_count"))
			}
			if topic.GetString("last_post_id") == "" {
				t.Fatal("expected last_post_id to be set")
			}
			// The opening post is the earliest by `created`, and the topic
			// projection points at it as the last (only) post.
			post, err := app.FindRecordById(postsCollectionName, topic.GetString("last_post_id"))
			if err != nil || post == nil {
				t.Fatalf("initial post missing: %v", err)
			}
			if post.GetString("topic_id") != topic.Id || post.GetString("author_id") != fixPlayerID {
				t.Fatalf("opening post is wrong: topic=%s author=%s",
					post.GetString("topic_id"), post.GetString("author_id"))
			}
		},
	}
	scenario.Test(t)
}

func TestCreateTopicValidationAndPermissions(t *testing.T) {
	cases := []struct {
		name           string
		actor          string
		idemKey        string
		bodyFn         func(catID string) string
		expectedStatus int
		expectedMsg    string
	}{
		{
			name:    "guest cannot create topic",
			actor:   "",
			idemKey: "idem-guest-1",
			bodyFn: func(catID string) string {
				return fmt.Sprintf(`{"category_id":"%s","title":"Guest Topic","content":"Hello"}`, catID)
			},
			expectedStatus: http.StatusForbidden,
			expectedMsg:    "You cannot create topics in this category.",
		},
		{
			name:    "missing idempotency key is rejected",
			actor:   "player",
			idemKey: "",
			bodyFn: func(catID string) string {
				return fmt.Sprintf(`{"category_id":"%s","title":"No Key","content":"Hello"}`, catID)
			},
			expectedStatus: http.StatusBadRequest,
			expectedMsg:    "Idempotency-Key header is required for mutating requests.",
		},
		{
			name:    "missing title is rejected",
			actor:   "player",
			idemKey: "idem-title-1",
			bodyFn: func(catID string) string {
				return fmt.Sprintf(`{"category_id":"%s","title":"","content":"Hello"}`, catID)
			},
			expectedStatus: http.StatusBadRequest,
			expectedMsg:    "Topic title is required.",
		},
		{
			name:    "nonexistent category is rejected",
			actor:   "player",
			idemKey: "idem-cat-1",
			bodyFn: func(catID string) string {
				return `{"category_id":"nonexistentcat15","title":"Valid Title","content":"Hello"}`
			},
			expectedStatus: http.StatusNotFound,
			expectedMsg:    "Category not found.",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var scenario tests.ApiScenario
			scenario = tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPost,
				URL:             "/api/aerun/topics",
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.expectedStatus,
				ExpectedContent: []string{tc.expectedMsg},
				BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
					tokens := seedIdentityFixtures(t, app)
					catID := getGeneralCategoryID(t, app)
					scenario.Body = strings.NewReader(tc.bodyFn(catID))
					headers := map[string]string{}
					if tc.actor != "" {
						headers["Authorization"] = tokens[tc.actor]
					}
					if tc.idemKey != "" {
						headers["Idempotency-Key"] = tc.idemKey
					}
					scenario.Headers = headers
				},
			}
			scenario.Test(t)
		})
	}
}

// ---------------------------------------------------------------------------
// POST /api/aerun/topics/:id/posts (Sprint 3 task 2 & DoD: CreatePost)
// ---------------------------------------------------------------------------

func TestCreatePostSequenceAndLockedTopic(t *testing.T) {
	var topicID string
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "player replies to existing topic",
		Method:         http.MethodPost,
		URL:            "/api/aerun/topics/topictest000001/posts",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusCreated,
		ExpectedContent: []string{
			`"content":"Reply number 1"`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			tokens := seedIdentityFixtures(t, app)
			catID := getGeneralCategoryID(t, app)

			// Seed topic
			topicsCol, _ := app.FindCollectionByNameOrId(topicsCollectionName)
			topic := core.NewRecord(topicsCol)
			topic.Set("id", "topictest000001")
			topic.Set("category_id", catID)
			topic.Set("author_id", fixPlayerID)
			topic.Set("title", "Existing Topic")
			topic.Set("posts_count", 1)
			topic.Set("locked", false)
			topic.Set("pinned", false)
			_ = app.Save(topic)
			topicID = topic.Id

			// Seed initial post
			postsCol, _ := app.FindCollectionByNameOrId(postsCollectionName)
			p1 := core.NewRecord(postsCol)
			p1.Set("topic_id", topicID)
			p1.Set("author_id", fixPlayerID)
			p1.Set("content", "First post")
			_ = app.Save(p1)

			scenario.Body = strings.NewReader(`{"content":"Reply number 1"}`)
			scenario.Headers = map[string]string{
				"Authorization":   tokens["player"],
				"Idempotency-Key": "idem-reply-1",
			}
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			topic, _ := app.FindRecordById(topicsCollectionName, topicID)
			if topic.GetInt("posts_count") != 2 {
				t.Fatalf("expected posts_count=2, got %d", topic.GetInt("posts_count"))
			}
		},
	}
	scenario.Test(t)
}

// ---------------------------------------------------------------------------
// DoD: 100 concurrent post attempts produce contiguous unique sequence,
// correct count/latest metadata, and no duplicate post after replaying an
// idempotency key.
// ---------------------------------------------------------------------------

func Test100ConcurrentPostsAndIdempotency(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// Create a topic
	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", fixPlayerID)
	topic.Set("title", "Concurrency Benchmark Topic")
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
	p1 := core.NewRecord(postsCol)
	p1.Set("topic_id", topic.Id)
	p1.Set("author_id", fixPlayerID)
	p1.Set("content", "Initial post")
	if err := app.Save(p1); err != nil {
		t.Fatal(err)
	}

	topic.Set("last_post_id", p1.Id)
	topic.Set("last_post_created", p1.GetDateTime("created"))
	topic.Set("last_post_author_id", p1.GetString("author_id"))
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	server := newTestServer(t, app)
	defer server.Close()

	client := server.Client()
	topicURL := fmt.Sprintf("%s/api/aerun/topics/%s/posts", server.URL, topic.Id)

	const concurrentN = 100
	var wg sync.WaitGroup
	wg.Add(concurrentN)

	type postResult struct {
		StatusCode int
		PostID     string
	}
	results := make([]postResult, concurrentN)

	for i := 0; i < concurrentN; i++ {
		idx := i
		go func() {
			defer wg.Done()
			idemKey := fmt.Sprintf("concurrent-post-key-%d", idx)
			body := fmt.Sprintf(`{"content":"Concurrent post #%d"}`, idx)
			req, err := http.NewRequest(http.MethodPost, topicURL, strings.NewReader(body))
			if err != nil {
				return
			}
			req.Header.Set("Authorization", tokens["player"])
			req.Header.Set("Idempotency-Key", idemKey)
			req.Header.Set("Content-Type", "application/json")

			resp, err := client.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()

			var parsed struct {
				Post struct {
					ID string `json:"id"`
				} `json:"post"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&parsed)

			results[idx] = postResult{
				StatusCode: resp.StatusCode,
				PostID:     parsed.Post.ID,
			}
		}()
	}

	wg.Wait()

	// Every concurrent request must have produced its OWN row. With `sequence`
	// gone there is no per-topic ordinal to collide, so the property under test
	// is the one that actually matters: 100 simultaneous posts yield 100
	// distinct rows, and the projection counts every one of them.
	//
	// The test keeps its original purpose — the write path is safe under
	// concurrency — but asserts it through ids and the counter rather than
	// through an ordinal that no longer exists.
	seen := make(map[string]bool, len(results))
	for i, r := range results {
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("request %d failed with status %d", i, r.StatusCode)
		}
		if r.PostID == "" {
			t.Fatalf("request %d returned no post id", i)
		}
		if seen[r.PostID] {
			t.Fatalf("duplicate post id returned: %s", r.PostID)
		}
		seen[r.PostID] = true
	}

	// The database must agree: 100 replies plus the opening post.
	var rowCount struct {
		Cnt int `db:"cnt"`
	}
	if err := app.DB().NewQuery(
		"SELECT COUNT(*) AS cnt FROM " + postsCollectionName +
			" WHERE topic_id = {:topic} AND (is_draft = false OR is_draft IS NULL)",
	).Bind(dbx.Params{"topic": topic.Id}).One(&rowCount); err != nil {
		t.Fatal(err)
	}
	if rowCount.Cnt != 101 {
		t.Fatalf("expected 101 persisted posts, got %d", rowCount.Cnt)
	}

	// Verify topic posts_count is exactly 101
	updatedTopic, err := app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil {
		t.Fatal(err)
	}
	if updatedTopic.GetInt("posts_count") != 101 {
		t.Fatalf("expected posts_count=101, got %d", updatedTopic.GetInt("posts_count"))
	}

	// Idempotency replay test: replay key 0 with identical payload
	replayReq, _ := http.NewRequest(http.MethodPost, topicURL, strings.NewReader(`{"content":"Concurrent post #0"}`))
	replayReq.Header.Set("Authorization", tokens["player"])
	replayReq.Header.Set("Idempotency-Key", "concurrent-post-key-0")
	replayReq.Header.Set("Content-Type", "application/json")

	replayResp, err := client.Do(replayReq)
	if err != nil {
		t.Fatal(err)
	}
	defer replayResp.Body.Close()

	if replayResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected replay status 201, got %d", replayResp.StatusCode)
	}
	if replayResp.Header.Get("Idempotency-Replayed") != "true" {
		t.Fatalf("expected Idempotency-Replayed: true, got %q", replayResp.Header.Get("Idempotency-Replayed"))
	}

	var replayBody struct {
		Post struct {
			ID string `json:"id"`
		} `json:"post"`
	}
	_ = json.NewDecoder(replayResp.Body).Decode(&replayBody)

	// A replay must return the ORIGINAL post, not a new one. Identity is the
	// post id, which is the whole point: the replay is the same row.
	if replayBody.Post.ID != results[0].PostID {
		t.Fatalf("replay returned a different post: expected ID=%s, got ID=%s",
			results[0].PostID, replayBody.Post.ID)
	}

	// Verify posts_count is STILL 101 after replay
	afterReplayTopic, _ := app.FindRecordById(topicsCollectionName, topic.Id)
	if afterReplayTopic.GetInt("posts_count") != 101 {
		t.Fatalf("posts_count increased after idempotency replay: %d", afterReplayTopic.GetInt("posts_count"))
	}

	// Idempotency conflict test: reuse key 0 with DIFFERENT payload -> 409
	conflictReq, _ := http.NewRequest(http.MethodPost, topicURL, strings.NewReader(`{"content":"TAMPERED CONTENT"}`))
	conflictReq.Header.Set("Authorization", tokens["player"])
	conflictReq.Header.Set("Idempotency-Key", "concurrent-post-key-0")
	conflictReq.Header.Set("Content-Type", "application/json")

	conflictResp, err := client.Do(conflictReq)
	if err != nil {
		t.Fatal(err)
	}
	defer conflictResp.Body.Close()

	if conflictResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected status 409 Conflict on payload mismatch, got %d", conflictResp.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// EditPost, DeletePost, MovePosts, Keyset Pagination, Deep Link Tests
// ---------------------------------------------------------------------------

func TestEditAndDeletePost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// Create topic with 2 posts
	topicsCol, _ := app.FindCollectionByNameOrId(topicsCollectionName)
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", fixPlayerID)
	topic.Set("title", "Edit Test Topic")
	topic.Set("posts_count", 2)
	_ = app.Save(topic)

	// Explicit `created` on both posts, an hour apart, so "Post 1 is the opening
	// post" is a property of the data rather than of how fast the loop ran.
	// SetRaw is required: `created` is an AutodateField, and a plain Set is
	// overwritten with "now" on save, which left both rows sharing a timestamp
	// and made the id tie-breaker decide which one the feed opens with.
	postsCol, _ := app.FindCollectionByNameOrId(postsCollectionName)
	p1 := core.NewRecord(postsCol)
	p1.Set("topic_id", topic.Id)
	p1.Set("author_id", fixPlayerID)
	p1.Set("content", "Post 1")
	p1.SetRaw("created", types.NowDateTime())
	_ = app.Save(p1)

	p2 := core.NewRecord(postsCol)
	p2.Set("topic_id", topic.Id)
	p2.Set("author_id", fixPlayerID)
	p2.Set("content", "Post 2")
	p2.SetRaw("created", types.NowDateTime().Add(time.Hour))
	_ = app.Save(p2)

	topic.Set("last_post_id", p2.Id)
	topic.Set("last_post_created", p2.GetDateTime("created"))
	topic.Set("last_post_author_id", p2.GetString("author_id"))
	_ = app.Save(topic)

	server := newTestServer(t, app)
	defer server.Close()
	client := server.Client()

	// 1. Moderator edits Post 2
	editReq, _ := http.NewRequest(http.MethodPatch, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, p2.Id),
		strings.NewReader(`{"content":"Moderated content"}`))
	editReq.Header.Set("Authorization", tokens["moderator"])
	editReq.Header.Set("Idempotency-Key", "edit-post-mod-1")
	editReq.Header.Set("Content-Type", "application/json")

	editResp, err := client.Do(editReq)
	if err != nil {
		t.Fatal(err)
	}
	defer editResp.Body.Close()

	if editResp.StatusCode != http.StatusOK {
		t.Fatalf("edit post failed with status %d", editResp.StatusCode)
	}

	p2Updated, _ := app.FindRecordById(postsCollectionName, p2.Id)
	if p2Updated.GetString("content") != "Moderated content" {
		t.Fatalf("content not updated: %q", p2Updated.GetString("content"))
	}
	if p2Updated.GetString("editor_id") != fixModeratorID {
		t.Fatalf("expected editor_id=%s, got %s", fixModeratorID, p2Updated.GetString("editor_id"))
	}

	// 2. Delete Post 2 -> topic projection should fallback to Post 1
	delReq, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, p2.Id), nil)
	delReq.Header.Set("Authorization", tokens["player"])
	delReq.Header.Set("Idempotency-Key", "del-post-p2")

	delResp, err := client.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	defer delResp.Body.Close()

	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("delete post failed with status %d", delResp.StatusCode)
	}

	topicAfterDel, _ := app.FindRecordById(topicsCollectionName, topic.Id)
	if topicAfterDel.GetInt("posts_count") != 1 {
		t.Fatalf("expected posts_count=1 after deletion, got %d", topicAfterDel.GetInt("posts_count"))
	}
	if topicAfterDel.GetString("last_post_id") != p1.Id {
		t.Fatalf("expected last_post_id to fallback to p1 (%s), got %s", p1.Id, topicAfterDel.GetString("last_post_id"))
	}

	// 3. Deep link lookup by sequence
	// Deep links address a post by its ID, the way the legacy client did.
	// There is no by-sequence route: `sequence` was an invented ordinal and a
	// link built from it would break the moment a post was deleted, because
	// deleting shifts every later ordinal.
	postRec, err := app.FindFirstRecordByFilter(
		postsCollectionName,
		"topic_id = {:topic} && is_draft = false",
		dbx.Params{"topic": topic.Id},
	)
	if err != nil || postRec == nil {
		t.Fatal("expected a post to deep-link to")
	}
	deepLinkReq, _ := http.NewRequest(http.MethodGet,
		fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, postRec.Id), nil)
	deepLinkResp, err := client.Do(deepLinkReq)
	if err != nil {
		t.Fatal(err)
	}
	defer deepLinkResp.Body.Close()

	if deepLinkResp.StatusCode != http.StatusOK {
		t.Fatalf("deep link lookup failed: %d", deepLinkResp.StatusCode)
	}
}

// TestDeletePostRefusesFirstPost guards the production incident where deleting
// a post on page 2+ destroyed the whole topic. The first post *is* the topic, so
// DELETE /posts/{id} must refuse it and force the caller through the explicit
// topic route; only the topic command may remove a topic.
func TestDeletePostRefusesFirstPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	topicsCol, _ := app.FindCollectionByNameOrId(topicsCollectionName)
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", fixPlayerID)
	topic.Set("title", "First Post Guard")
	topic.Set("posts_count", 2)
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	// Explicit `created`, an hour apart. The fixture used to declare which post
	// came first by writing a `sequence` ordinal; with that column gone, two
	// rows saved in the same millisecond tie and the id tie-breaker decides
	// which one the feed opens with — so "first" would be an accident of how
	// fast this loop ran. SetRaw is required for an AutodateField.
	postsCol, _ := app.FindCollectionByNameOrId(postsCollectionName)
	first := core.NewRecord(postsCol)
	first.Set("topic_id", topic.Id)
	first.Set("author_id", fixPlayerID)
	first.Set("content", "Opening post")
	first.SetRaw("created", types.NowDateTime())
	if err := app.Save(first); err != nil {
		t.Fatal(err)
	}

	reply := core.NewRecord(postsCol)
	reply.Set("topic_id", topic.Id)
	reply.Set("author_id", fixPlayerID)
	reply.Set("content", "A reply")
	reply.SetRaw("created", types.NowDateTime().Add(time.Hour))
	if err := app.Save(reply); err != nil {
		t.Fatal(err)
	}

	server := newTestServer(t, app)
	defer server.Close()
	client := server.Client()

	// The first post must be refused, even for a moderator.
	modReq, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, first.Id), nil)
	modReq.Header.Set("Authorization", tokens["moderator"])
	modReq.Header.Set("Idempotency-Key", "del-first-post-mod")
	modResp, err := client.Do(modReq)
	if err != nil {
		t.Fatal(err)
	}
	defer modResp.Body.Close()

	if modResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 when deleting a topic's first post, got %d", modResp.StatusCode)
	}

	// Neither the post nor the topic may have been touched. Under a hard
	// delete "untouched" means the row is still there — there is no flag to
	// check any more, so existence IS the assertion.
	afterMod, err := app.FindRecordById(postsCollectionName, first.Id)
	if err != nil || afterMod == nil {
		t.Fatalf("refusing a first post must not remove it: %v", err)
	}
	topicAfter, err := app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil || topicAfter == nil {
		t.Fatalf("refusing a first post must not remove the topic: %v", err)
	}

	// The same holds for the post's own author.
	authorReq, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, first.Id), nil)
	authorReq.Header.Set("Authorization", tokens["player"])
	authorReq.Header.Set("Idempotency-Key", "del-first-post-author")
	authorResp, err := client.Do(authorReq)
	if err != nil {
		t.Fatal(err)
	}
	defer authorResp.Body.Close()

	if authorResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 for the author deleting the first post, got %d", authorResp.StatusCode)
	}

	// A reply is still deletable, so the guard is not over-broad.
	replyReq, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, reply.Id), nil)
	replyReq.Header.Set("Authorization", tokens["player"])
	replyReq.Header.Set("Idempotency-Key", "del-reply-ok")
	replyResp, err := client.Do(replyReq)
	if err != nil {
		t.Fatal(err)
	}
	defer replyResp.Body.Close()

	if replyResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 deleting a reply, got %d", replyResp.StatusCode)
	}
	// The reply is really gone — that is the point of a hard delete.
	if after, err := app.FindRecordById(postsCollectionName, reply.Id); err == nil && after != nil {
		t.Fatal("a deleted reply must not survive as a row")
	}
	topicFinal, err := app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil || topicFinal == nil {
		t.Fatalf("deleting a reply must not take the topic with it: %v", err)
	}
}

func TestUpdateTopicAndMoveTopic(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// Create a second category for moving
	categoriesCol, _ := app.FindCollectionByNameOrId(categoriesCollectionName)
	cat2 := core.NewRecord(categoriesCol)
	cat2.Set("name", "Announcements")
	cat2.Set("slug", "announcements")
	cat2.Set("sort_order", 1)
	_ = app.Save(cat2)

	// Create a topic
	topicsCol, _ := app.FindCollectionByNameOrId(topicsCollectionName)
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", fixPlayerID)
	topic.Set("title", "Topic to Update")
	topic.Set("posts_count", 1)
	_ = app.Save(topic)

	server := newTestServer(t, app)
	defer server.Close()
	client := server.Client()

	// 1. Moderator pins and locks topic
	patchReq, _ := http.NewRequest(http.MethodPatch,
		fmt.Sprintf("%s/api/aerun/topics/%s", server.URL, topic.Id),
		strings.NewReader(`{"title":"Updated Title","locked":true,"pinned":true}`))
	patchReq.Header.Set("Authorization", tokens["moderator"])
	patchReq.Header.Set("Idempotency-Key", "patch-topic-mod-1")
	patchReq.Header.Set("Content-Type", "application/json")

	patchResp, err := client.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	defer patchResp.Body.Close()

	if patchResp.StatusCode != http.StatusOK {
		t.Fatalf("patch topic failed: %d", patchResp.StatusCode)
	}

	topicUpdated, _ := app.FindRecordById(topicsCollectionName, topic.Id)
	if topicUpdated.GetString("title") != "Updated Title" || !topicUpdated.GetBool("locked") || !topicUpdated.GetBool("pinned") {
		t.Fatalf("topic fields did not update properly: %+v", topicUpdated)
	}

	// 2. Moderator moves topic to cat2
	moveReq, _ := http.NewRequest(http.MethodPost,
		fmt.Sprintf("%s/api/aerun/topics/%s/move", server.URL, topic.Id),
		strings.NewReader(fmt.Sprintf(`{"category_id":"%s"}`, cat2.Id)))
	moveReq.Header.Set("Authorization", tokens["moderator"])
	moveReq.Header.Set("Idempotency-Key", "move-topic-mod-1")
	moveReq.Header.Set("Content-Type", "application/json")

	moveResp, err := client.Do(moveReq)
	if err != nil {
		t.Fatal(err)
	}
	defer moveResp.Body.Close()

	if moveResp.StatusCode != http.StatusOK {
		t.Fatalf("move topic failed: %d", moveResp.StatusCode)
	}

	topicMoved, _ := app.FindRecordById(topicsCollectionName, topic.Id)
	if topicMoved.GetString("category_id") != cat2.Id {
		t.Fatalf("expected category_id=%s, got %s", cat2.Id, topicMoved.GetString("category_id"))
	}
}

func TestMovePostsBetweenTopics(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// Create Topic A and Topic B
	topicsCol, _ := app.FindCollectionByNameOrId(topicsCollectionName)
	topicA := core.NewRecord(topicsCol)
	topicA.Set("category_id", catID)
	topicA.Set("author_id", fixPlayerID)
	topicA.Set("title", "Topic A")
	topicA.Set("posts_count", 2)
	_ = app.Save(topicA)

	topicB := core.NewRecord(topicsCol)
	topicB.Set("category_id", catID)
	topicB.Set("author_id", fixPlayerID)
	topicB.Set("title", "Topic B")
	topicB.Set("posts_count", 1)
	_ = app.Save(topicB)

	postsCol, _ := app.FindCollectionByNameOrId(postsCollectionName)
	pA1 := core.NewRecord(postsCol)
	pA1.Set("topic_id", topicA.Id)
	pA1.Set("author_id", fixPlayerID)
	pA1.Set("content", "Topic A Post 1")
	_ = app.Save(pA1)

	pA2 := core.NewRecord(postsCol)
	pA2.Set("topic_id", topicA.Id)
	pA2.Set("author_id", fixPlayerID)
	pA2.Set("content", "Topic A Post 2")
	_ = app.Save(pA2)

	pB1 := core.NewRecord(postsCol)
	pB1.Set("topic_id", topicB.Id)
	pB1.Set("author_id", fixPlayerID)
	pB1.Set("content", "Topic B Post 1")
	_ = app.Save(pB1)

	server := newTestServer(t, app)
	defer server.Close()
	client := server.Client()

	// Move pA2 from Topic A to Topic B
	moveBody := fmt.Sprintf(`{"target_topic_id":"%s","post_ids":["%s"]}`, topicB.Id, pA2.Id)
	moveReq, _ := http.NewRequest(http.MethodPost,
		fmt.Sprintf("%s/api/aerun/topics/%s/posts/move", server.URL, topicA.Id),
		strings.NewReader(moveBody))
	moveReq.Header.Set("Authorization", tokens["moderator"])
	moveReq.Header.Set("Idempotency-Key", "move-posts-mod-1")
	moveReq.Header.Set("Content-Type", "application/json")

	moveResp, err := client.Do(moveReq)
	if err != nil {
		t.Fatal(err)
	}
	defer moveResp.Body.Close()

	if moveResp.StatusCode != http.StatusOK {
		t.Fatalf("move posts failed: %d", moveResp.StatusCode)
	}

	// A moved post changes topic only. Its position follows `created`, which
	// travels with the row, so there is no ordinal to renumber.
	pA2Moved, _ := app.FindRecordById(postsCollectionName, pA2.Id)
	if pA2Moved.GetString("topic_id") != topicB.Id {
		t.Fatalf("pA2 topic not updated: topic=%s", pA2Moved.GetString("topic_id"))
	}

	// Verify Topic A posts_count is 1, Topic B posts_count is 2
	topicAUpdated, _ := app.FindRecordById(topicsCollectionName, topicA.Id)
	topicBUpdated, _ := app.FindRecordById(topicsCollectionName, topicB.Id)
	if topicAUpdated.GetInt("posts_count") != 1 {
		t.Fatalf("Topic A posts_count expected 1, got %d", topicAUpdated.GetInt("posts_count"))
	}
	if topicBUpdated.GetInt("posts_count") != 2 {
		t.Fatalf("Topic B posts_count expected 2, got %d", topicBUpdated.GetInt("posts_count"))
	}
}

func TestErrorContractEnvelope(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()
	client := server.Client()

	// Make invalid mutating request (missing body / missing category)
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/aerun/topics", server.URL),
		strings.NewReader(`{"title":""}`))
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Idempotency-Key", "test-error-contract-key")
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d", resp.StatusCode)
	}

	var errResp struct {
		Status  int    `json:"status"`
		Message string `json:"message"`
		Data    struct {
			Validation bool   `json:"validation"`
			Conflict   bool   `json:"conflict"`
			Forbidden  bool   `json:"forbidden"`
			Retryable  bool   `json:"retryable"`
			Kind       string `json:"kind"`
			RequestID  string `json:"request_id"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&errResp); err != nil {
		t.Fatalf("failed to decode error contract response: %v", err)
	}

	if !errResp.Data.Validation {
		t.Fatal("expected validation=true in error contract data")
	}
	if errResp.Data.Conflict || errResp.Data.Forbidden || errResp.Data.Retryable {
		t.Fatalf("expected other flags false, got: %+v", errResp.Data)
	}
	if errResp.Data.Kind != "validation" {
		t.Fatalf("expected kind=validation, got %q", errResp.Data.Kind)
	}
	if errResp.Data.RequestID == "" {
		t.Fatal("expected non-empty request_id in error contract data")
	}
}

// TestCategoryWritePermissionGranting checks that category-level permission
// overrides can GRANT create_topic / post_reply to roles that lack them
// globally (e.g. spectator holds only view_forum), while global rights still
// work when a category does not list the role.
func TestCategoryWritePermissionGranting(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	col, err := app.FindCollectionByNameOrId(categoriesCollectionName)
	if err != nil {
		t.Fatalf("categories collection missing: %v", err)
	}

	closedCat := core.NewRecord(col)
	closedCat.Set("name", "closed-topic-cat")
	closedCat.Set("slug", "closed-topic-cat")
	closedCat.Set("allowed_roles", []string{auth.CategoryInheritMarker})
	closedCat.Set("permissions", types.JSONRaw([]byte(`{"create_topic":["moderator"]}`)))
	if err := app.Save(closedCat); err != nil {
		t.Fatalf("save closed category: %v", err)
	}

	openCat := core.NewRecord(col)
	openCat.Set("name", "open-topic-cat")
	openCat.Set("slug", "open-topic-cat")
	openCat.Set("allowed_roles", []string{auth.CategoryInheritMarker})
	openCat.Set("permissions", types.JSONRaw([]byte(`{"create_topic":["spectator"]}`)))
	if err := app.Save(openCat); err != nil {
		t.Fatalf("save open category: %v", err)
	}

	// plainCat: NO permissions field at all → global rights apply as-is
	plainCat := core.NewRecord(col)
	plainCat.Set("name", "plain-topic-cat")
	plainCat.Set("slug", "plain-topic-cat")
	plainCat.Set("allowed_roles", []string{auth.CategoryInheritMarker})
	if err := app.Save(plainCat); err != nil {
		t.Fatalf("save plain category: %v", err)
	}

	noReplyCat := core.NewRecord(col)
	noReplyCat.Set("name", "no-reply-cat")
	noReplyCat.Set("slug", "no-reply-cat")
	noReplyCat.Set("allowed_roles", []string{auth.CategoryInheritMarker})
	noReplyCat.Set("permissions", types.JSONRaw([]byte(`{"post_reply":["moderator"]}`)))
	if err := app.Save(noReplyCat); err != nil {
		t.Fatalf("save no-reply category: %v", err)
	}

	replyCat := core.NewRecord(col)
	replyCat.Set("name", "reply-cat")
	replyCat.Set("slug", "reply-cat")
	replyCat.Set("allowed_roles", []string{auth.CategoryInheritMarker})
	replyCat.Set("permissions", types.JSONRaw([]byte(`{"post_reply":["spectator"]}`)))
	if err := app.Save(replyCat); err != nil {
		t.Fatalf("save reply category: %v", err)
	}

	// ── Create topic ──
	t.Run("spectator cannot create topic without category grant", func(t *testing.T) {
		body := fmt.Sprintf(`{"category_id":"%s","title":"No Grant","content":"Hello"}`, closedCat.Id)
		status, _ := doJSON(t, server.URL, http.MethodPost, "/api/aerun/topics", tokens["spectator"], "idem-closed-1", body)
		if status != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", status)
		}
	})

	t.Run("spectator can create topic with category grant", func(t *testing.T) {
		body := fmt.Sprintf(`{"category_id":"%s","title":"Granted","content":"Hello"}`, openCat.Id)
		status, _ := doJSON(t, server.URL, http.MethodPost, "/api/aerun/topics", tokens["spectator"], "idem-open-1", body)
		if status != http.StatusCreated {
			t.Fatalf("expected 201, got %d", status)
		}
	})

	t.Run("player can create topic in plain category via global right", func(t *testing.T) {
		body := fmt.Sprintf(`{"category_id":"%s","title":"Player Global","content":"Hello"}`, plainCat.Id)
		status, _ := doJSON(t, server.URL, http.MethodPost, "/api/aerun/topics", tokens["player"], "idem-player-1", body)
		if status != http.StatusCreated {
			t.Fatalf("expected 201, got %d", status)
		}
	})

	// Категория с явным списком ЗАПРЕЩАЕТ действие даже при наличии глобального права.
	t.Run("player cannot create topic in closedCat despite global right", func(t *testing.T) {
		body := fmt.Sprintf(`{"category_id":"%s","title":"Blocked","content":"Hello"}`, closedCat.Id)
		status, _ := doJSON(t, server.URL, http.MethodPost, "/api/aerun/topics", tokens["player"], "idem-player-blocked", body)
		if status != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", status)
		}
	})

	// Модератор с глобальным create_topic не в списке openCat → категория запрещает.
	t.Run("moderator cannot create topic in openCat despite global right", func(t *testing.T) {
		body := fmt.Sprintf(`{"category_id":"%s","title":"Mod Blocked","content":"Hello"}`, openCat.Id)
		status, _ := doJSON(t, server.URL, http.MethodPost, "/api/aerun/topics", tokens["moderator"], "idem-mod-blocked", body)
		if status != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", status)
		}
	})

	// ── Seed topics in noReplyCat and replyCat (moderator has post_reply globally) ──
	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}

	seedTopic := func(catID, title string) string {
		topic := core.NewRecord(topicsCol)
		topic.Set("category_id", catID)
		topic.Set("author_id", fixModeratorID)
		topic.Set("title", title)
		topic.Set("posts_count", 1)
		topic.Set("locked", false)
		topic.Set("pinned", false)
		if err := app.Save(topic); err != nil {
			t.Fatalf("seed topic: %v", err)
		}
		p := core.NewRecord(postsCol)
		p.Set("topic_id", topic.Id)
		p.Set("author_id", fixModeratorID)
		p.Set("content", "Opening")
		if err := app.Save(p); err != nil {
			t.Fatalf("seed post: %v", err)
		}
		topic.Set("last_post_id", p.Id)
		if err := app.Save(topic); err != nil {
			t.Fatalf("update topic projection: %v", err)
		}
		return topic.Id
	}

	noReplyTopicID := seedTopic(noReplyCat.Id, "No reply grant")
	replyTopicID := seedTopic(replyCat.Id, "Reply grant")

	// ── Create post (reply) ──
	t.Run("spectator cannot reply without category post_reply grant", func(t *testing.T) {
		body := `{"content":"No reply grant"}`
		status, _ := doJSON(t, server.URL, http.MethodPost, fmt.Sprintf("/api/aerun/topics/%s/posts", noReplyTopicID), tokens["spectator"], "idem-reply-no-grant", body)
		if status != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", status)
		}
	})

	t.Run("spectator can reply with category post_reply grant", func(t *testing.T) {
		body := `{"content":"With reply grant"}`
		status, _ := doJSON(t, server.URL, http.MethodPost, fmt.Sprintf("/api/aerun/topics/%s/posts", replyTopicID), tokens["spectator"], "idem-reply-grant", body)
		if status != http.StatusCreated {
			t.Fatalf("expected 201, got %d", status)
		}
	})

	t.Run("moderator can reply in noReplyCat (listed in category)", func(t *testing.T) {
		body := `{"content":"Moderator listed"}`
		status, _ := doJSON(t, server.URL, http.MethodPost, fmt.Sprintf("/api/aerun/topics/%s/posts", noReplyTopicID), tokens["moderator"], "idem-reply-mod-listed", body)
		if status != http.StatusCreated {
			t.Fatalf("expected 201, got %d", status)
		}
	})

	// Модератор с глобальным post_reply НЕ в списке replyCat → категория запрещает.
	t.Run("moderator cannot reply in replyCat despite global right", func(t *testing.T) {
		body := `{"content":"Moderator blocked"}`
		status, _ := doJSON(t, server.URL, http.MethodPost, fmt.Sprintf("/api/aerun/topics/%s/posts", replyTopicID), tokens["moderator"], "idem-reply-mod-blocked", body)
		if status != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", status)
		}
	})
}
