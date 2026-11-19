package pocketbase

// The category index (the main page) and the topic lists must agree about WHO
// spoke last.
//
// They disagreed, and review missed it because the two sources differ by
// exactly one column. The topic lists load whole topic records, which carry
// last_post_author_character_id, so their rows rendered the MASK. The category
// index builds its last-post projection with a hand-written SELECT naming only
// last_post_author_id — and its decorator, decorateLastPostAuthor, had no mask
// branch at all. A member who replied under a mask therefore saw "Arin" on the
// main page and "Kyle Haze" in the category, for the same topic, same minute.
//
// Two things must hold, and a fix doing only one still renders the account:
//
//  1. the projection must READ the column out of the database, and
//  2. the decorator must RESOLVE it — through the shared rule, with the owner
//     check, so a payload can never borrow somebody else's mask.

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// seedLastPostTopic writes a topic whose newest post was written by authorID,
// optionally under characterID. The empty characterID is the "posted as the
// account" case, which is a real state and must keep rendering the account.
func seedLastPostTopic(t testing.TB, app *tests.TestApp, catID, authorID, characterID, title string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("category_id", catID)
	rec.Set("author_id", authorID)
	rec.Set("title", title)
	rec.Set("posts_count", 2)
	rec.Set("last_post_author_id", authorID)
	rec.Set("last_post_author_character_id", characterID)
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed topic %s: %v", title, err)
	}
	return rec
}

func TestCategoryIndexNamesTheMaskOfTheLastPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charlastpost001", fixPlayerID, "Kyle Haze")
	catID := getGeneralCategoryID(t, app)
	seedLastPostTopic(t, app, catID, fixPlayerID, "charlastpost001", "Test last post")

	projections, err := categoryForumProjections(app)
	if err != nil {
		t.Fatalf("categoryForumProjections: %v", err)
	}
	projection, ok := projections[catID]
	if !ok {
		t.Fatalf("no projection for category %s: %v", catID, projections)
	}

	// (1) The column must survive the projection, or (2) has nothing to read.
	if got, _ := projection["last_post_author_character_id"].(string); got != "charlastpost001" {
		t.Fatalf("the projection must carry the mask id, got %q — without it the "+
			"decorator can only ever name the account", got)
	}

	// (2) …and it must be resolved into the display name of the nested
	// last-post AuthorRef — the single source of truth for the last-post
	// author (F-18: the flat last_post_author_* keys are gone), so the
	// client never sees a divergent last-post author between the category
	// index and a topic list.
	ref, _ := projection["last_post_author_ref"].(map[string]any)
	if ref == nil {
		t.Fatal("last_post_author_ref must be set on the category projection")
	}
	if got, _ := ref["kind"].(string); got != "account" {
		t.Fatalf("last_post_author_ref.kind = %v, want account", got)
	}
	if got, _ := ref["user_id"].(string); got != fixPlayerID {
		t.Fatalf("last_post_author_ref.user_id = %v, want %s", got, fixPlayerID)
	}
	if got, _ := ref["display_name"].(string); got != "Kyle Haze" {
		t.Fatalf("last_post_author_ref.display_name = %v, want Kyle Haze", got)
	}
	if got, _ := ref["character_id"].(string); got != "charlastpost001" {
		t.Fatalf("last_post_author_ref.character_id = %v, want charlastpost001", got)
	}
	if got, _ := ref["is_character"].(bool); !got {
		t.Fatal("last_post_author_ref.is_character must be true when the last post carried a mask")
	}
}

// TestCategoryIndexLastPostRefGuest: a guest's last post in a category must
// expose a guest AuthorRef (kind, display_name) rather than an empty account id,
// so the index renders the guest's chosen name instead of falling through to
// the deleted-account placeholder.
func TestCategoryIndexLastPostRefGuest(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	catID := seedGuestCategory(t, app)

	col, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	topic := core.NewRecord(col)
	topic.Set("category_id", catID)
	topic.Set("author_id", "") // guest opener
	topic.Set("title", "Guest Last-Post Topic")
	topic.Set("posts_count", 1)
	topic.Set("last_post_id", "")
	topic.Set("last_post_author_id", "")
	topic.Set("last_post_guest_display_name", "Гость из категории")
	topic.Set("last_post_author_name", "Гость из категории")
	if err := app.Save(topic); err != nil {
		t.Fatalf("failed to seed topic: %v", err)
	}

	projections, err := categoryForumProjections(app)
	if err != nil {
		t.Fatalf("categoryForumProjections: %v", err)
	}
	projection, ok := projections[catID]
	if !ok {
		t.Fatalf("no projection for category %s: %v", catID, projections)
	}
	ref, _ := projection["last_post_author_ref"].(map[string]any)
	if ref == nil {
		t.Fatal("last_post_author_ref must be set for a guest last-poster")
	}
	if got, _ := ref["kind"].(string); got != "guest" {
		t.Fatalf("last_post_author_ref.kind = %v, want guest", got)
	}
	if got, _ := ref["user_id"].(string); got != "" {
		t.Fatalf("last_post_author_ref.user_id = %v, want empty for a guest", got)
	}
	if got, _ := ref["display_name"].(string); got != "Гость из категории" {
		t.Fatalf("last_post_author_ref.display_name = %v, want Гость из категории", got)
	}
	if got, _ := ref["character_id"].(string); got != "" {
		t.Fatalf("last_post_author_ref.character_id = %v, want empty for a guest", got)
	}
	if got, _ := projection["last_post_author_id"].(string); got != "" {
		t.Fatalf("last_post_author_id = %v, want empty for a guest last-poster", got)
	}
}

// TestCategoryIndexFallsBackToTheAccount covers the other branch. Without it,
// "always resolve a mask" would be indistinguishable from the fix.
func TestCategoryIndexFallsBackToTheAccount(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedLastPostTopic(t, app, catID, fixPlayerID, "", "Plain reply")

	projections, err := categoryForumProjections(app)
	if err != nil {
		t.Fatalf("categoryForumProjections: %v", err)
	}
	projection := projections[catID]

	ref, _ := projection["last_post_author_ref"].(map[string]any)
	if ref == nil {
		t.Fatal("last_post_author_ref must be set on the category projection")
	}
	if got, _ := ref["display_name"].(string); got != "PlayerOne" {
		t.Fatalf("a post written as the account must name the account, got %q", got)
	}
	if isChar, _ := ref["is_character"].(bool); isChar {
		t.Fatal("last_post_author_ref.is_character must be false when no mask was involved")
	}
}

// TestCategoryIndexRefusesAForeignMask is the security half: a mask id naming
// somebody else's row must not rename the speaker. The column is a stored
// reference, and this is what stops a stale or tampered row from making a
// member look like somebody else.
func TestCategoryIndexRefusesAForeignMask(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	// Kyle Haze belongs to the PLAYER; the topic's last post is by ROOT.
	seedRuntimeCharacter(t, app, "charlastpost001", fixPlayerID, "Kyle Haze")
	catID := getGeneralCategoryID(t, app)
	seedLastPostTopic(t, app, catID, fixRootID, "charlastpost001", "Borrowed mask")

	projections, err := categoryForumProjections(app)
	if err != nil {
		t.Fatalf("categoryForumProjections: %v", err)
	}
	projection := projections[catID]

	ref, _ := projection["last_post_author_ref"].(map[string]any)
	if ref == nil {
		t.Fatal("last_post_author_ref must be set on the category projection")
	}
	if got, _ := ref["display_name"].(string); got != "RootOne" {
		t.Fatalf("a mask owned by somebody else must be ignored, got %q", got)
	}
	if isChar, _ := ref["is_character"].(bool); isChar {
		t.Fatal("a foreign mask must not set last_post_author_ref.is_character")
	}
}

// TestApplyLastPostMaskRule pins the shared rule, so the topic lists and the
// category index cannot drift apart again by fixing one and not the other.
func TestApplyLastPostMaskRule(t *testing.T) {
	masks := map[string]characterDisplay{
		"charmask1": {Name: "Kyle Haze", AvatarURL: "/api/files/x", OwnerID: "owner1"},
	}
	fresh := func() map[string]any {
		return map[string]any{
			"last_post_author_ref": map[string]any{
				"kind":         authorKindAccount,
				"user_id":      "owner1",
				"display_name": "Arin",
				"avatar_url":   "/account.png",
				"character_id": "charmask1",
				"is_character": false,
			},
			"last_post_author_character_id": "charmask1",
			"last_post_author_id":           "owner1",
		}
	}

	t.Run("owned mask renames the speaker", func(t *testing.T) {
		payload := fresh()
		applyLastPostMask(payload, "owner1", masks)
		ref, _ := payload["last_post_author_ref"].(map[string]any)
		if got, _ := ref["display_name"].(string); got != "Kyle Haze" {
			t.Fatalf("got %q, want the mask name", got)
		}
		if isChar, _ := ref["is_character"].(bool); !isChar {
			t.Fatal("last_post_author_ref.is_character must be set")
		}
	})

	t.Run("foreign mask is ignored", func(t *testing.T) {
		payload := fresh()
		applyLastPostMask(payload, "somebody-else", masks)
		ref, _ := payload["last_post_author_ref"].(map[string]any)
		if got, _ := ref["display_name"].(string); got != "Arin" {
			t.Fatalf("got %q, want the account name preserved", got)
		}
		if isChar, _ := ref["is_character"].(bool); isChar {
			t.Fatal("a foreign mask must not set the flag")
		}
	})

	t.Run("a deleted mask falls back to the account", func(t *testing.T) {
		payload := fresh()
		applyLastPostMask(payload, "owner1", map[string]characterDisplay{})
		ref, _ := payload["last_post_author_ref"].(map[string]any)
		if got, _ := ref["display_name"].(string); got != "Arin" {
			t.Fatalf("got %q, want the account name preserved", got)
		}
	})
}

// The main page calls the endpoint, not the helper, so the assertion is made
// there too: a handler that stopped passing the masks through would still
// compile and still pass a unit test on the helper alone.
func TestCategoriesEndpointNamesTheMask(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charlastpost001", fixPlayerID, "Kyle Haze")
	catID := getGeneralCategoryID(t, app)
	seedLastPostTopic(t, app, catID, fixPlayerID, "charlastpost001", "Test last post")

	server := newTestServer(t, app)
	defer server.Close()

	status, body := getAerun(t, server.URL+"/api/aerun/categories")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	payload := string(body)
	if !strings.Contains(payload, "Kyle Haze") {
		t.Fatalf("the categories payload must name the mask of the last post: %s", payload)
	}
	// The mask name and the mask flag sit in the same nested last-post DTO
	// (map keys marshal alphabetically, so display_name is immediately
	// followed by is_character) — the flat last_post_is_character key is
	// gone (F-18).
	if !strings.Contains(payload, `"display_name":"Kyle Haze","is_character":true`) {
		t.Fatalf("the categories payload must flag the last post as a mask post: %s", payload)
	}
}
