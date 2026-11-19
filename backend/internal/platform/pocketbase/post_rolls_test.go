package pocketbase

// End-to-end coverage for the dice pipeline, the profile posts feed and the
// mask-owner tooltip: all three were reported as "the feature is simply off"
// when in fact the data was being produced and then dropped on the way out.
//
//	THE DICE. processDiceRolls rewrites `[dice=N]` into a `[roll=<id>]` reference
//	PLUS a companion map, and the tag carries no number of its own. Nothing
//	carried the map: the posts collection had no column for it, the read model
//	had no key for it, and the browser destructured it away before the request
//	was sent. So the throw rendered in the optimistic card and every reader
//	after a reload — guest included — got the raw `[roll=…]` text back.
//
//	THE PROFILE POSTS. The Posts tab read the posts collection through the
//	browser SDK, which lockBrowserRules answers with 403 for every non-superuser.
//	The catch turned that refusal into an empty list, so the tab claimed the
//	member had written nothing.
//
//	THE BADGE TOOLTIP. The "Player: …" tooltip read `post.owner_name`, a
//	Firestore field the Go read model never emitted, so it only ever worked for
//	the viewer's own posts.
//
// These go through the real router so the migration, the handler, the column and
// the wire shape are exercised together — a unit test on the validator alone
// would pass while the column was still missing.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// rollIDForTests is the id shape processDiceRolls mints.
const rollIDForTests = "roll_1791050763756_1"

// ── Dice: create → store → read back ────────────────────────────────────────

// TestPostRollsSurviveAReload: creating a post with [dice=N] mints the roll
// on the server (SEC-08) and returns it in the response.
func TestPostRollsSurviveAReload(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "a stored dice is returned with the post",
		Method:         http.MethodPost,
		URL:            "/api/aerun/topics",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusCreated,
		ExpectedContent: []string{
			`"rolls":{`,
			`"sides":20`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			tokens := seedIdentityFixtures(t, app)
			catID := getGeneralCategoryID(t, app)
			body := fmt.Sprintf(
				`{"category_id":%q,"title":"Dice topic","content":"dice\n[dice=20]"}`,
				catID)
			scenario.Body = strings.NewReader(body)
			scenario.Headers = map[string]string{
				"Authorization":   tokens["player"],
				"Idempotency-Key": "idem-dice-1",
			}
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			// The COLUMN really holds the map, not just the response.
			post, err := app.FindFirstRecordByFilter(postsCollectionName, "id != ''")
			if err != nil || post == nil {
				t.Fatalf("no post row to inspect: %v", err)
			}
			stored, derr := decodeRolls(post.Get("rolls"))
			if derr != nil {
				t.Fatalf("stored rolls did not decode: %v", derr)
			}
			if len(stored) == 0 {
				t.Fatalf("the throw was not stored, got %#v", stored)
			}
		},
	}
	scenario.Test(t)
}

// TestPostRollsAreReadableByAnotherMember is the guest half of the report: the
// AUTHOR sees their own throw in the optimistic card, so the only way to
// reproduce the bug is to read it back as somebody else.
func TestPostRollsAreReadableByAnotherMember(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	topicID := createTopicWithDice(t, server, tokens["player"], catID,
		"Readable dice", "кубик\n[dice=20]", "")

	for _, who := range []struct {
		name  string
		token string
	}{
		{"another member", tokens["moderator"]},
		{"a guest", ""},
	} {
		t.Run(who.name, func(t *testing.T) {
			value := readRollValue(t, server, topicID, who.token)
			if value == nil {
				t.Errorf("%s got no number for the throw; the [roll=…] tag renders raw", who.name)
			}
		})
	}
}

// TestMasterDiceIsWithheldFromReadersWithoutThePermission is the security case
// the new column made possible. Before it existed nothing was stored, so nothing
// could leak; storing values made server-side withholding mandatory.
func TestMasterDiceIsWithheldFromReadersWithoutThePermission(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	topicID := createTopicWithDice(t, server, tokens["player"], catID,
		"Master dice", "тайный бросок\n[dice=100 type=master]", "")

	// The compiled matrix gives `player` view_master_dice (internal/auth role.go:
	// "compiled-only" for the player role — see migration-data/idmap/report.json),
	// so a player legitimately SEES a master throw. The roles that must NOT see
	// one are spectator and guest — and spectator is the sharper case here,
	// because unlike a guest it is a real account with a stored role.
	if v := readRollValue(t, server, topicID, ""); v != nil {
		t.Errorf("a guest received the master value %v — it is not a guest permission", v)
	}
	if v := readRollValue(t, server, topicID, tokens["spectator"]); v != nil {
		t.Errorf("a spectator received the master value %v — spectator carries only view_forum", v)
	}
	// A PLAYER no longer sees it either. `view_master_dice` used to sit in the
	// player row, which made a GM's private throw readable by every ordinary
	// member — so the withholding this test exists to prove was not withholding
	// from the people it mattered for. Player now joins spectator and guest as a
	// reader who must not receive the value, and moderator becomes the boundary,
	// so the assertion inverts.
	if v := readRollValue(t, server, topicID, tokens["player"]); v != nil {
		t.Errorf("a player received the master value %v — view_master_dice is moderator-and-above", v)
	}
	if v := readRollValue(t, server, topicID, tokens["moderator"]); v == nil {
		t.Errorf("a moderator holds view_master_dice and must see the value, got %v", v)
	}
	if v := readRollValue(t, server, topicID, tokens["root"]); v == nil {
		t.Errorf("root must see the master value, got %v", v)
	}
}

// TestRollsAreValidatedOnTheWayIn: an edit attempting to forge/change a frozen roll is refused.
func TestRollsAreValidatedOnTheWayIn(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	_, postID := createTopicWithDiceAndID(t, server, tokens["player"], catID,
		"Liar", "кубик\n[dice=20]", "")

	postRecord, err := app.FindRecordById(postsCollectionName, postID)
	if err != nil {
		t.Fatal(err)
	}
	storedMap, _ := decodeRolls(postRecord.Get("rolls"))
	var rollID string
	for id := range storedMap {
		rollID = id
		break
	}

	// Try to edit and overwrite with a different value (forgery)
	edit := requestJSON(t, server, http.MethodPatch, "/api/aerun/posts/"+postID,
		fmt.Sprintf(`{"content":"кубик\n[roll=%s]","rolls":{"%s":{"sides":20,"value":99,"type":"normal"}}}`, rollID, rollID),
		map[string]string{
			"Authorization":   tokens["player"],
			"Idempotency-Key": "idem-liar-1",
		})
	if edit.StatusCode != http.StatusBadRequest {
		t.Fatalf("edit forging roll = %d, want 400 validation error, body %s", edit.StatusCode, readBody(t, edit))
	}
}

// TestEditingAPostWithoutRollsKeepsThem: the edit form sends only the text when
// the dice were not touched, and an absent key must mean "leave them alone" —
// otherwise every edit wipes the throws of the post it rewrites.
func TestEditingAPostWithoutRollsKeepsThem(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	_, postID := createTopicWithDiceAndID(t, server, tokens["player"], catID,
		"Edited dice", "кубик\n[dice=20]", "")

	postRecord, err := app.FindRecordById(postsCollectionName, postID)
	if err != nil {
		t.Fatal(err)
	}
	storedMap, _ := decodeRolls(postRecord.Get("rolls"))
	var rollID string
	for id := range storedMap {
		rollID = id
		break
	}

	// An edit that sends NO rolls key at all.
	edit := requestJSON(t, server, http.MethodPatch, "/api/aerun/posts/"+postID,
		fmt.Sprintf(`{"content":"кубик, переписал текст\n[roll=%s]"}`, rollID),
		map[string]string{
			"Authorization":   tokens["player"],
			"Idempotency-Key": "idem-edit-dice-2",
		})
	if edit.StatusCode != http.StatusOK {
		t.Fatalf("edit = %d, body %s", edit.StatusCode, readBody(t, edit))
	}
	var edited struct {
		Post map[string]any `json:"post"`
	}
	decodeJSON(t, edit, &edited)
	rolls, ok := edited.Post["rolls"].(map[string]any)
	if !ok {
		t.Fatalf("an unrelated edit wiped the stored throws: %#v", edited.Post)
	}
	if _, ok := rolls[rollID].(map[string]any); !ok {
		t.Fatalf("the stored throw %q disappeared after edit: %#v", rollID, rolls)
	}
}

// ── The profile Posts tab ───────────────────────────────────────────────────

// TestProfilePostsAreReadable is the reported 403. It used to read the posts
// collection from the browser, which lockBrowserRules answers with "Only
// superusers can perform this action" — for guests too — and the client turned
// that into an empty list, so the tab claimed the member had written nothing.
func TestProfilePostsAreReadable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	createTopic(t, server, tokens["player"], catID, "Profile post", "написано в профиль", "")

	// The tab must work for a member AND for an anonymous visitor.
	for _, who := range []struct {
		name  string
		token string
	}{
		{"a member", tokens["moderator"]},
		{"a guest", ""},
	} {
		t.Run(who.name, func(t *testing.T) {
			list := requestJSON(t, server, http.MethodGet,
				"/api/aerun/users/"+fixPlayerID+"/posts?page=1&limit=20", "", authHeaders(who.token))
			if list.StatusCode != http.StatusOK {
				t.Fatalf("%s got %d (the browser SDK answered 403 here), body %s",
					who.name, list.StatusCode, readBody(t, list))
			}
			var page struct {
				Items []map[string]any `json:"items"`
				Total int              `json:"total"`
			}
			decodeJSON(t, list, &page)
			if len(page.Items) == 0 {
				t.Fatalf("%s: the profile rendered as empty", who.name)
			}
			// ProfilePage reads `total`; an undefined one paginates against NaN.
			if page.Total < 1 {
				t.Errorf("%s: total = %d, want >= 1 — the pager reads it", who.name, page.Total)
			}
			if authorDTO, ok := page.Items[0]["author"].(map[string]any); !ok {
				t.Errorf("%s: the post is undecorated, payload %#v", who.name, page.Items[0])
			} else if _, ok := authorDTO["display_name"]; !ok {
				t.Errorf("%s: the post author DTO has no display_name, payload %#v", who.name, page.Items[0])
			}
			// THE HEADLINE. ProfilePage renders `post.topic_title` and falls back
			// to the literal "..." when it is absent, so a missing key makes the
			// entire Posts tab read as a column of ellipses while the links
			// themselves still work. This is the exact reported symptom.
			title, _ := page.Items[0]["topic_title"].(string)
			if title == "" {
				t.Errorf("%s: topic_title is missing, so the row renders \"...\": %#v",
					who.name, page.Items[0])
			}
			if title != "Profile post" {
				t.Errorf("%s: topic_title = %q, want %q — a renamed topic must not "+
					"leave a stale headline behind", who.name, title, "Profile post")
			}
		})
	}
}

// TestProfilePostsAre404ForAnUnknownAccount keeps the route from becoming an
// existence oracle for ids that are not accounts.
func TestProfilePostsAre404ForAnUnknownAccount(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	seedIdentityFixtures(t, app)
	resp := requestJSON(t, server, http.MethodGet, "/api/aerun/users/usernobody0001/posts", "", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("= %d, want 404 (body %s)", resp.StatusCode, readBody(t, resp))
	}
}

// ── The Character badge tooltip ─────────────────────────────────────────────

// TestMaskedPostCarriesTheAccountNickname is the badge-tooltip report. The
// tooltip names the ACCOUNT behind a mask and read `post.owner_name` — a
// Firestore field the Go read model never emitted. The badge therefore showed a
// tooltip on your own posts (the page had `profile.nickname`) and on nobody
// else's, which for a guest meant never.
func TestMaskedPostCarriesTheAccountNickname(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// A mask owned by the posting member, so applyMask must accept it.
	collection, err := app.FindCollectionByNameOrId(charactersCollectionName)
	if err != nil {
		t.Fatalf("characters collection missing: %v", err)
	}
	character := core.NewRecord(collection)
	// Exactly 15 chars: PocketBase ids are fixed-width, and a short one is
	// refused on save — which would read as a product failure, not a typo.
	character.Set("id", "charmask0000001")
	character.Set("owner_id", fixPlayerID)
	character.Set("name", "Пич")
	character.Set("is_active", true)
	if err := app.Save(character); err != nil {
		t.Fatalf("failed to create character: %v", err)
	}

	topicID := createTopic(t, server, tokens["player"], catID, "Masked", "под маской", "charmask0000001")

	// A GUEST reads it — the tooltip has to work there too.
	list := requestJSON(t, server, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/posts?limit=10", "", nil)
	if list.StatusCode != http.StatusOK {
		t.Fatalf("list = %d, body %s", list.StatusCode, readBody(t, list))
	}
	var page struct {
		Items []map[string]any `json:"items"`
	}
	decodeJSON(t, list, &page)
	if len(page.Items) == 0 {
		t.Fatal("no posts returned")
	}
	post := page.Items[0]

	if post["is_character"] != true {
		t.Fatalf("the post is not masked, payload %#v", post)
	}
	authorDTO, _ := post["author"].(map[string]any)
	if authorDTO["display_name"] != "Пич" {
		t.Errorf("author.display_name = %v, want the mask name", authorDTO["display_name"])
	}
	// THE fix: the account nickname rides along in the DTO under its own key,
	// which is what ForumCharacterBadge's "Player: …" tooltip reads.
	if got := authorDTO["owner_name"]; got != "PlayerOne" {
		t.Errorf("author.owner_name = %v, want the account nickname \"PlayerOne\" — without it the badge "+
			"tooltip has nothing to show a guest", got)
	}
}

// TestProfilePostsFilterNarrowsTheList is the reported filter. The Posts tab
// offers "All messages" / "Account only" / one entry per mask, and every one of
// them answered with the SAME full list.
//
// The parameter existed only in the browser: fetchUserPosts declared it as
// `_postFilter` — the underscore prefix is the codebase's own convention for
// "accepted and deliberately unused" — and never put it on the wire, while the
// Go handler had no filter at all. So the dropdown relabelled the identical rows
// and nothing on screen indicated that it had done nothing.
//
// This drives the real router, because the failure was in the seam between the
// two halves: a unit test on the parser alone would pass while the query
// parameter was still dropped on the client.
func TestProfilePostsFilterNarrowsTheList(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// Two masks and one unmasked post, so each axis of the dropdown has
	// something to select and something to exclude.
	const (
		firstMaskID  = "filtermask00001"
		secondMaskID = "filtermask00002"
	)
	for _, mask := range []struct {
		id   string
		name string
	}{
		{firstMaskID, "Rough"},
		{secondMaskID, "Kyle Haze"},
	} {
		collection, err := app.FindCollectionByNameOrId(charactersCollectionName)
		if err != nil {
			t.Fatalf("characters collection missing: %v", err)
		}
		character := core.NewRecord(collection)
		character.Set("id", mask.id)
		character.Set("owner_id", fixPlayerID)
		character.Set("name", mask.name)
		if err := app.Save(character); err != nil {
			t.Fatalf("failed to create character %s: %v", mask.id, err)
		}
	}

	// The unmasked post is written FIRST and deliberately carries no mask id.
	createTopic(t, server, tokens["player"], catID, "As the account", "без маски", "")
	createTopic(t, server, tokens["player"], catID, "As Rough", "первая маска", firstMaskID)
	createTopic(t, server, tokens["player"], catID, "As Kyle Haze", "вторая маска", secondMaskID)

	type expectation struct {
		query      string
		wantTitles []string
		wantTotal  int64
	}
	for _, tc := range []expectation{
		// The default is unchanged: every post, newest first.
		{"", []string{"As Kyle Haze", "As Rough", "As the account"}, 3},
		{"&filter=all", []string{"As Kyle Haze", "As Rough", "As the account"}, 3},
		// The mask axis returns ONE mask's posts, not a relabelled list.
		{"&filter=char_" + firstMaskID, []string{"As Rough"}, 1},
		{"&filter=char_" + secondMaskID, []string{"As Kyle Haze"}, 1},
		// And the account axis returns only the unmasked one.
		{"&filter=account", []string{"As the account"}, 1},
	} {
		t.Run(tc.query, func(t *testing.T) {
			resp := requestJSON(t, server, http.MethodGet,
				"/api/aerun/users/"+fixPlayerID+"/posts?page=1&limit=20"+tc.query,
				"", nil)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("= %d, body %s", resp.StatusCode, readBody(t, resp))
			}
			var page struct {
				Items []map[string]any `json:"items"`
				Total int64            `json:"total"`
			}
			decodeJSON(t, resp, &page)

			if len(page.Items) != len(tc.wantTitles) {
				t.Fatalf("got %d posts, want %d — the filter did not narrow anything: %#v",
					len(page.Items), len(tc.wantTitles), page.Items)
			}
			for i, want := range tc.wantTitles {
				if got, _ := page.Items[i]["topic_title"].(string); got != want {
					t.Errorf("post %d is %q, want %q", i, got, want)
				}
			}

			// THE TOTAL, which is the number the pager divides by. It used to be
			// counted with a separate, unfiltered expression, so a filtered view
			// would offer pages that do not exist once the mask ran out.
			if page.Total != tc.wantTotal {
				t.Errorf("total = %d, want %d — the pager paginates against this",
					page.Total, tc.wantTotal)
			}
		})
	}
}

// TestProfilePostsFilterRejectsAnUnknownMask keeps the filter from becoming a
// way to ask the server about a mask that is not on this profile: the read is
// already scoped to the author, so a foreign id can only ever match nothing, and
// naming it must not turn into an answer about it either way.
func TestProfilePostsFilterRejectsAnUnknownMask(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	seedIdentityFixtures(t, app)

	for _, tc := range []struct {
		name  string
		query string
	}{
		{"an unrecognised axis", "&filter=nonsense"},
		{"a malformed id", "&filter=char_short"},
		{"a bare prefix", "&filter=char_"},
		// The injection attempt reaches neither the query nor a permissive
		// default: it is a 400, not an unfiltered list.
		{"an injection attempt", "&filter=char_' OR 1=1 --"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := requestJSON(t, server, http.MethodGet,
				"/api/aerun/users/"+fixPlayerID+"/posts?page=1&limit=20"+tc.query,
				"", nil)
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("= %d, want 400 — a filter this endpoint cannot honour must say so "+
					"rather than quietly answer with everything, body %s",
					resp.StatusCode, readBody(t, resp))
			}
		})
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

// idemKeyFor builds an Idempotency-Key from a title. The header is validated
// against [A-Za-z0-9_.:-], and several test titles contain spaces — a raw title
// would be refused with 400 and the failure would read as a product bug.
func idemKeyFor(title string) string {
	return "idem-" + strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, title)
}

// createTopic posts a topic and returns its id. `characterID` may be empty.
func createTopic(t testing.TB, server *httptest.Server, token, categoryID, title, content, characterID string) string {
	t.Helper()
	body := fmt.Sprintf(`{"category_id":%q,"title":%q,"content":%q,"character_id":%q}`,
		categoryID, title, content, characterID)
	res := requestJSON(t, server, http.MethodPost, "/api/aerun/topics", body,
		map[string]string{
			"Authorization":   token,
			"Idempotency-Key": idemKeyFor(title),
		})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create %q = %d, body %s", title, res.StatusCode, readBody(t, res))
	}
	var answer struct {
		Topic struct {
			ID string `json:"id"`
		} `json:"topic"`
	}
	decodeJSON(t, res, &answer)
	if answer.Topic.ID == "" {
		t.Fatalf("create %q returned no topic id", title)
	}
	return answer.Topic.ID
}

// createTopicWithDice creates a topic whose opening post carries one throw and
// returns the topic id.
func createTopicWithDice(t testing.TB, server *httptest.Server, token, categoryID, title, content, rollEntry string) string {
	t.Helper()
	// The TOPIC id is what the read helpers walk; returning the post id here
	// would send every caller to /topics/<post id>/posts and 404.
	topicID, _ := createTopicWithDiceAndID(t, server, token, categoryID, title, content, rollEntry)
	return topicID
}

// createTopicWithDiceAndID returns both ids, for the paths that then edit the
// post rather than read it back.
func createTopicWithDiceAndID(t testing.TB, server *httptest.Server, token, categoryID, title, content, rollEntry string) (string, string) {
	t.Helper()
	var body string
	if rollEntry != "" {
		body = fmt.Sprintf(`{"category_id":%q,"title":%q,"content":%q,"rolls":{"%s":%s}}`,
			categoryID, title, content, rollIDForTests, rollEntry)
	} else {
		body = fmt.Sprintf(`{"category_id":%q,"title":%q,"content":%q}`,
			categoryID, title, content)
	}
	res := requestJSON(t, server, http.MethodPost, "/api/aerun/topics", body,
		map[string]string{
			"Authorization":   token,
			"Idempotency-Key": idemKeyFor("cd-" + title),
		})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create %q = %d, body %s", title, res.StatusCode, readBody(t, res))
	}
	var answer struct {
		Topic struct {
			ID string `json:"id"`
		} `json:"topic"`
		FirstPost struct {
			ID string `json:"id"`
		} `json:"first_post"`
	}
	decodeJSON(t, res, &answer)
	if answer.Topic.ID == "" || answer.FirstPost.ID == "" {
		t.Fatalf("create %q returned no ids: %#v", title, answer)
	}
	return answer.Topic.ID, answer.FirstPost.ID
}

// readRollValue reads the topic feed AS `token` (empty for an anonymous caller)
// and returns the value the stored throw resolves to — nil meaning "the reader
// was not shown a number", which is either correct (master, no permission) or
// the bug (an ordinary roll nobody can see).
func readRollValue(t testing.TB, server *httptest.Server, topicID, token string) any {
	t.Helper()
	list := requestJSON(t, server, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/posts?limit=10", "", authHeaders(token))
	if list.StatusCode != http.StatusOK {
		t.Fatalf("list = %d, body %s", list.StatusCode, readBody(t, list))
	}
	var page struct {
		Items []map[string]any `json:"items"`
	}
	decodeJSON(t, list, &page)
	if len(page.Items) == 0 {
		t.Fatal("no posts returned")
	}
	rolls, ok := page.Items[0]["rolls"].(map[string]any)
	if !ok || len(rolls) == 0 {
		t.Fatalf("no `rolls` key in the payload, so the tag renders raw: %#v", page.Items[0])
	}
	var entry map[string]any
	if e, exists := rolls[rollIDForTests]; exists {
		entry, _ = e.(map[string]any)
	} else {
		for _, e := range rolls {
			if m, ok := e.(map[string]any); ok {
				entry = m
				break
			}
		}
	}
	if entry == nil {
		t.Fatalf("the throw is not in the map: %#v", rolls)
	}
	// The entry must still be DESCRIBED even when its value is withheld:
	// BBCode renders "Master Roll (hidden)" from a null value, and dropping the
	// entry would bring the raw-tag bug straight back.
	if entry["sides"] == nil {
		t.Errorf("the roll lost its sides, so it cannot render at all: %#v", entry)
	}
	return entry["value"]
}

func authHeaders(token string) map[string]string {
	if token == "" {
		return map[string]string{}
	}
	return map[string]string{"Authorization": token}
}

// requestJSON performs a JSON call and returns the RAW response. It is named
// apart from the package's existing doJSON (drafts_test.go), which has a
// different shape and its own purpose.
func requestJSON(t testing.TB, server *httptest.Server, method, path, body string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func decodeJSON(t testing.TB, res *http.Response, target any) {
	t.Helper()
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		t.Fatalf("failed to decode the answer: %v", err)
	}
}

// readBody consumes the response so a failure message can quote it. The
// response is closed either way, so a caller that only wants the text must not
// also decode it.
func readBody(t testing.TB, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	var out strings.Builder
	if _, err := io.Copy(&out, res.Body); err != nil {
		return "<unreadable body>"
	}
	return out.String()
}
