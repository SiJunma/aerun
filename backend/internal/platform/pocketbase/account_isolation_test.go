package pocketbase

// account_isolation_test.go — what a NON-ACTIVE account may still reach.
//
// The status column narrows the permission list (auth.NarrowForStatus): a
// banned account resolves to the empty set, a pending one keeps view_forum plus
// the four self-edit keys. Zero permissions is only as good as the checks that
// CONSUME it, and a check that never runs on a given route hands the capability
// back regardless of what the matrix says.
//
// Every permission-gated route is safe by construction (RequirePermission reads
// the narrowed set). The exposure is on routes with no route-level gate at all,
// which is what this file pins down — the draft routes are the sharpest case:
// they were bound with only enforceIdempotency, so nothing consulted the status.
//
// The assertions are the CORRECT behaviour, not the current one: a failure
// names the route that still lets a banned account write.

import (
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// draftIDFor returns the caller's own draft record id in the given topic.
func draftIDFor(t testing.TB, app *tests.TestApp, authorID, topicID string) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := app.FindFirstRecordByFilter(col,
		"author_id = {:a} && topic_id = {:t} && is_draft = true",
		dbx.Params{"a": authorID, "t": topicID})
	if err != nil || rec == nil {
		t.Fatalf("no draft for %s in %s: %v", authorID, topicID, err)
	}
	return rec.Id
}

// openingPostIDFor returns the topic's published opening post.
func openingPostIDFor(t testing.TB, app *tests.TestApp, authorID, topicID string) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := app.FindFirstRecordByFilter(col,
		"author_id = {:a} && topic_id = {:t} && is_draft = false",
		dbx.Params{"a": authorID, "t": topicID})
	if err != nil || rec == nil {
		t.Fatalf("no post for %s in %s: %v", authorID, topicID, err)
	}
	return rec.Id
}

func TestBannedAccountIsIsolated(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "Live topic")

	ts := newTestServer(t, app)
	defer ts.Close()

	// The identity itself is still served — the client needs it to show the
	// "you are banned" screen rather than being logged out blind.
	status, me := doJSON(t, ts.URL, http.MethodGet, "/api/aerun/me", tokens["banned"], "", "")
	if status != http.StatusOK {
		t.Fatalf("GET /me must still answer for a banned account, got %d: %v", status, me)
	}
	if me["status"] != string(auth.StatusBanned) {
		t.Fatalf("the status must be reported as banned, got %v", me["status"])
	}
	perms, _ := me["permissions"].([]any)
	if len(perms) != 0 {
		t.Fatalf("a banned account must hold no permissions, got %v", perms)
	}

	t.Run("cannot read the forum", func(t *testing.T) {
		// canViewCategory refuses a banned account outright, so the list is
		// empty rather than 403 — the caller is told nothing about what exists.
		status, payload := doJSON(t, ts.URL, http.MethodGet, "/api/aerun/categories",
			tokens["banned"], "", "")
		if status != http.StatusOK {
			t.Fatalf("GET /categories should answer 200 with an empty list, got %d: %v", status, payload)
		}
		if items, _ := payload["items"].([]any); len(items) != 0 {
			t.Fatalf("a banned account must see no categories, got %v", items)
		}
	})

	t.Run("cannot create content", func(t *testing.T) {
		status, payload := doJSON(t, ts.URL, http.MethodPost, "/api/aerun/topics",
			tokens["banned"], "banned-topic",
			`{"title":"t","content":"c","category_id":"`+getGeneralCategoryID(t, app)+`"}`)
		if status != http.StatusForbidden {
			t.Fatalf("a banned account must not create a topic, got %d: %v", status, payload)
		}

		status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/topics/"+topicID+"/posts",
			tokens["banned"], "banned-post", `{"content":"still here"}`)
		if status != http.StatusForbidden {
			t.Fatalf("a banned account must not reply, got %d: %v", status, payload)
		}
	})

	t.Run("cannot reach the admin surface", func(t *testing.T) {
		status, payload := doJSON(t, ts.URL, http.MethodGet, "/api/aerun/admin/users",
			tokens["banned"], "", "")
		if status != http.StatusForbidden {
			t.Fatalf("a banned account must not list users, got %d: %v", status, payload)
		}
	})

	t.Run("cannot save or publish a draft", func(t *testing.T) {
		// THE HOLE. PUT /topics/{id}/draft and POST /drafts/{id}/publish carry
		// no route-level gate, and the handlers check authorship but never the
		// account status. A banned account could therefore keep a draft and
		// then publish it into the forum.
		status, payload := doJSON(t, ts.URL, http.MethodPut, "/api/aerun/topics/"+topicID+"/draft",
			tokens["banned"], "banned-draft", `{"content":"written while banned"}`)
		if status == http.StatusOK {
			draftID := draftIDFor(t, app, fixBannedID, topicID)
			status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/drafts/"+draftID+"/publish",
				tokens["banned"], "banned-publish", "")
			if status != http.StatusForbidden {
				t.Fatalf("a banned account must not publish a draft, got %d: %v", status, payload)
			}
			return
		}
		if status != http.StatusForbidden {
			t.Fatalf("a banned account must not save a draft, got %d: %v", status, payload)
		}
	})
}

func TestPendingAccountCannotPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "Live topic")

	ts := newTestServer(t, app)
	defer ts.Close()

	status, me := doJSON(t, ts.URL, http.MethodGet, "/api/aerun/me", tokens["pending"], "", "")
	if status != http.StatusOK {
		t.Fatalf("GET /me must answer for a pending account, got %d: %v", status, me)
	}
	if me["status"] != string(auth.StatusPending) {
		t.Fatalf("the status must be reported as pending, got %v", me["status"])
	}
	// The pending ceiling is not "nothing" — view_forum plus the five self-edit
	// keys survive, which is what lets the account personalise itself while it
	// waits. Asserting the exact set is the point: a widening here would be
	// invisible in the UI, which only greys out buttons.
	want := map[string]bool{
		"view_forum": true, "edit_self_nickname": true, "edit_self_avatar": true,
		"edit_self_status": true, "edit_self_signature": true,
		"edit_self_profile": true,
	}
	got, _ := me["permissions"].([]any)
	if len(got) != len(want) {
		t.Fatalf("a pending account must hold exactly %d permissions, got %v", len(want), got)
	}
	for _, p := range got {
		if !want[p.(string)] {
			t.Fatalf("a pending account must not hold %q", p)
		}
	}

	t.Run("cannot create content", func(t *testing.T) {
		// Same hole as the banned case, and the same fix.
		status, payload := doJSON(t, ts.URL, http.MethodPost, "/api/aerun/topics",
			tokens["pending"], "pending-topic",
			`{"title":"t","content":"c","category_id":"`+getGeneralCategoryID(t, app)+`"}`)
		if status != http.StatusForbidden {
			t.Fatalf("a pending account must not create a topic, got %d: %v", status, payload)
		}

		status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/topics/"+topicID+"/posts",
			tokens["pending"], "pending-post", `{"content":"sneaking in"}`)
		if status != http.StatusForbidden {
			t.Fatalf("a pending account must not reply, got %d: %v", status, payload)
		}
	})

	t.Run("cannot save or publish a draft", func(t *testing.T) {
		status, payload := doJSON(t, ts.URL, http.MethodPut, "/api/aerun/topics/"+topicID+"/draft",
			tokens["pending"], "pending-draft", `{"content":"queued while pending"}`)
		if status == http.StatusOK {
			draftID := draftIDFor(t, app, fixPendingID, topicID)
			status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/drafts/"+draftID+"/publish",
				tokens["pending"], "pending-publish", "")
			if status != http.StatusForbidden {
				t.Fatalf("a pending account must not publish a draft, got %d: %v", status, payload)
			}
			return
		}
		if status != http.StatusForbidden {
			t.Fatalf("a pending account must not save a draft, got %d: %v", status, payload)
		}
	})
}

// Ownership must not be a licence that outlives a ban.
//
// updateTopic/deleteTopic/editPost/deletePost all read `isAuthor || permission`.
// That means the author branch grants the action with NO permission consulted at
// all — so an account narrowed to nothing could still rewrite its own topic and
// delete its own posts after being banned. A ban that leaves the banned author
// able to edit what the moderation staff are looking at is not a ban.
func TestBannedAccountCannotTouchItsOwnContent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixBannedID, "Written before the ban")

	ts := newTestServer(t, app)
	defer ts.Close()

	// seedDraftTopic opens the topic with a real post, not a draft — that is the
	// row the edit/delete checks have to act on.
	postID := openingPostIDFor(t, app, fixBannedID, topicID)
	col, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindRecordById(col, postID); err != nil {
		t.Fatal(err)
	}

	// A second post, so the delete case is not answered by the unrelated
	// "first post belongs to the topic" rule and actually exercises the
	// authorisation branch.
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	reply := core.NewRecord(postsCol)
	reply.Set("topic_id", topicID)
	reply.Set("author_id", fixBannedID)
	reply.Set("content", "a reply written before the ban")
	if err := app.Save(reply); err != nil {
		t.Fatal(err)
	}

	t.Run("cannot edit its own topic", func(t *testing.T) {
		status, payload := doJSON(t, ts.URL, http.MethodPatch, "/api/aerun/topics/"+topicID,
			tokens["banned"], "banned-topic-edit", `{"title":"rewritten while banned"}`)
		if status != http.StatusForbidden {
			t.Fatalf("a banned account must not edit its own topic, got %d: %v", status, payload)
		}
	})

	t.Run("cannot edit its own post", func(t *testing.T) {
		status, payload := doJSON(t, ts.URL, http.MethodPatch, "/api/aerun/posts/"+postID,
			tokens["banned"], "banned-post-edit", `{"content":"rewritten while banned"}`)
		if status != http.StatusForbidden {
			t.Fatalf("a banned account must not edit its own post, got %d: %v", status, payload)
		}
	})

	t.Run("cannot delete its own reply", func(t *testing.T) {
		status, payload := doJSON(t, ts.URL, http.MethodDelete, "/api/aerun/posts/"+reply.Id,
			tokens["banned"], "banned-reply-delete", "")
		if status != http.StatusForbidden {
			t.Fatalf("a banned account must not delete its own post, got %d: %v", status, payload)
		}
	})
}

// The routes that stay open on purpose, pinned so a later reader can tell the
// difference between a decision and an oversight.
//
//   - GET /roles and GET /designs need NO gate: AuthProvider calls
//     subscribeToRoles unconditionally so a signed-OUT visitor can still render
//     role badges, and the theme must load before there is a session at all.
//     Gating them behind a permission would blank the badge and the palette on
//     every public page. The registry is not secret — it is displayed on the
//     members page.
//   - GET /users/{id}/characters and GET /characters/{id} go through
//     canReadCharactersOf, which already refuses a non-active owner unless the
//     caller IS that owner. A suspended account may still tidy its own masks.
func TestPublicRoutesStayReachable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	for _, path := range []string{"/api/aerun/roles", "/api/aerun/designs"} {
		status, payload := doJSON(t, ts.URL, http.MethodGet, path, "", "", "")
		if status != http.StatusOK {
			t.Fatalf("GET %s must stay reachable without a session, got %d: %v", path, status, payload)
		}
	}
}

// A banned account is refused the subscription route too, but not by a
// permission — by canViewCategory, which refuses it before the role is even
// consulted. Worth pinning: it is the reason no explicit guard is needed there.
func TestBannedAccountCannotSubscribe(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "Subscribable topic")

	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload := doJSON(t, ts.URL, http.MethodPost, "/api/aerun/topics/"+topicID+"/subscribe",
		tokens["banned"], "banned-subscribe", "")
	if status == http.StatusOK {
		t.Fatalf("a banned account must not subscribe, got %d: %v", status, payload)
	}
}

// Staff must be able to open a suspended account's profile.
//
// canReadCharactersOf decides visibility from the OWNER's status alone:
// a non-active owner is visible only to themselves. That is right for the
// public — a banned account's masks are nobody else's business — and wrong for
// moderation, because the whole point of opening the profile after banning
// somebody is to see what they wrote. The admin panel rendered a 404 and an
// empty Characters tab, which reads as "the record is gone" rather than
// "this account is suspended".
// EVERYONE reads a suspended account's data.
//
// A restriction is a restriction ON THE ACCOUNT, not on what other people may
// see of it. The product rule is that a ban removes the account's ability to act
// and leaves its history readable — an operator bans somebody precisely so they
// can go on reading what they wrote.
//
// The implementation had it the other way round twice over: canReadCharactersOf
// narrowed on the owner's status, and the users ViewRule (1766000000) branched
// on it too. So banning somebody also unpublished their profile: 404 for the
// admin panel, and an empty Characters tab that read "no characters yet" rather
// than "suspended". An earlier version of this file asserted a staff-only
// exemption, which was the same mistake in a smaller disguise — staff are not
// special here, EVERY reader is entitled.
func TestEveryoneCanReadSuspendedAccountCharacters(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	for _, actor := range []string{"root", "moderator", "player", "pending", ""} {
		name := actor
		if name == "" {
			name = "guest"
		}
		t.Run(name, func(t *testing.T) {
			status, payload := doJSON(t, ts.URL, http.MethodGet,
				"/api/aerun/users/"+fixBannedID+"/characters", tokens[actor], "", "")
			if status != http.StatusOK {
				t.Fatalf("%s must be able to read a suspended account's characters, got %d: %v",
					name, status, payload)
			}
		})
	}
}

// The counterpart: a suspended account is out of circulation as an OBJECT of
// member actions. createDMHandler already refused to open a conversation; these
// pin the two rules that were missing.
//
//   - a conversation opened BEFORE the ban used to keep accepting messages
//     forever, because only conversation creation checked the status;
//   - voting on the account moved the reputation score that moderators read
//     when deciding whether to lift the suspension.
func TestSuspendedAccountIsOutOfCirculation(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("cannot be voted for", func(t *testing.T) {
		status, payload := doJSON(t, ts.URL, http.MethodPost,
			"/api/aerun/users/"+fixBannedID+"/vote", tokens["player"], "vote-banned", `{"value":1}`)
		if status != http.StatusForbidden {
			t.Fatalf("a suspended account must not be votable, got %d: %v", status, payload)
		}
	})

	t.Run("cannot be messaged in an existing conversation", func(t *testing.T) {
		// The conversation is seeded directly: creating one through the API is
		// already refused for a banned counterpart, so the API path can never
		// reach the case this guards.
		convCol, err := app.FindCollectionByNameOrId("dm_conversations")
		if err != nil {
			t.Fatal(err)
		}
		conv := core.NewRecord(convCol)
		conv.Set("title", "Before the ban")
		conv.Set("messages_count", 0)
		if err := app.Save(conv); err != nil {
			t.Fatal(err)
		}
		memCol, err := app.FindCollectionByNameOrId("dm_members")
		if err != nil {
			t.Fatal(err)
		}
		for _, uid := range []string{fixPlayerID, fixBannedID} {
			m := core.NewRecord(memCol)
			m.Set("conversation_id", conv.Id)
			m.Set("user_id", uid)
			if err := app.Save(m); err != nil {
				t.Fatal(err)
			}
		}

		status, payload := doJSON(t, ts.URL, http.MethodPost,
			"/api/aerun/dms/"+conv.Id+"/messages", tokens["player"], "dm-banned", `{"text":"still here?"}`)
		if status != http.StatusForbidden {
			t.Fatalf("a conversation with a suspended member must be unwritable, got %d: %v",
				status, payload)
		}
	})
}
