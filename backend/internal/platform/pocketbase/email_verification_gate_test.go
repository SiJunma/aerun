package pocketbase

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// TestUnverifiedPlayerCannotCreateTopic checks the unverified-write-rights
// architecture: an account whose email is not verified (verified=false) must
// not be able to create a topic in a category that does not open its override
// to `guest`. The refusal now comes from categoryWriteAllowed, not from
// requireVerified.
func TestUnverifiedPlayerCannotCreateTopic(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "unverified player cannot create a topic in a closed category",
		Method:         http.MethodPost,
		URL:            "/api/aerun/topics",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusForbidden,
		ExpectedContent: []string{
			`"message":"You cannot create topics in this category."`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			// Unverified but ACTIVE player: registration leaves verified=false.
			rec := core.NewRecord(mustCollection(t, app, usersCollectionName))
			rec.Set("id", "unver0001user01")
			rec.Set("email", "unverified@example.com")
			rec.SetVerified(false)
			rec.SetPassword(testPassword)
			rec.Set("nickname", "UnverifiedOne")
			rec.Set("nickname_normalized", auth.NormalizeNickname("UnverifiedOne"))
			rec.Set("role", string(auth.RolePlayer))
			rec.Set("status", string(auth.StatusActive))
			rec.Set("avatar_url", "")
			rec.Set("settings", map[string]any{})
			if err := app.Save(rec); err != nil {
				t.Fatalf("failed to create unverified user: %v", err)
			}
			token, err := rec.NewAuthToken()
			if err != nil {
				t.Fatalf("failed to issue auth token: %v", err)
			}

			catID := getGeneralCategoryID(t, app)
			body := fmt.Sprintf(`{"category_id":"%s","title":"Unverified Topic","content":"Should be refused."}`, catID)
			scenario.Body = strings.NewReader(body)
			scenario.Headers = map[string]string{
				"Authorization":   token,
				"Idempotency-Key": "idem-unverified-topic-1",
			}
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Unverified Topic'")
			if err != nil || topic == nil {
				return // correctly refused: nothing created
			}
			t.Fatalf("unverified player created a topic despite missing email verification")
		},
	}
	scenario.Test(t)
}

// TestUnverifiedPlayerCanCreateTopicInGuestZone checks that an unverified
// active player CAN create a topic in a category whose override names `guest`
// (the gostevaya / open guest zone).
func TestUnverifiedPlayerCanCreateTopicInGuestZone(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// Unverified but ACTIVE player.
	rec := core.NewRecord(mustCollection(t, app, usersCollectionName))
	rec.Set("id", "unver0002user02")
	rec.Set("email", "unverified2@example.com")
	rec.SetVerified(false)
	rec.SetPassword(testPassword)
	rec.Set("nickname", "UnverifiedTwo")
	rec.Set("nickname_normalized", auth.NormalizeNickname("UnverifiedTwo"))
	rec.Set("role", string(auth.RolePlayer))
	rec.Set("status", string(auth.StatusActive))
	rec.Set("avatar_url", "")
	rec.Set("settings", map[string]any{})
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to create unverified user: %v", err)
	}
	token, err := rec.NewAuthToken()
	if err != nil {
		t.Fatalf("failed to issue auth token: %v", err)
	}

	// Create a category that opens its create_topic override to `guest`.
	catCol, err := app.FindCollectionByNameOrId(categoriesCollectionName)
	if err != nil {
		t.Fatalf("categories collection missing: %v", err)
	}
	cat := core.NewRecord(catCol)
	cat.Set("name", "gostevaya")
	cat.Set("slug", "gostevaya")
	cat.Set("permissions", map[string]any{
		"create_topic": []string{"guest"},
	})
	if err := app.Save(cat); err != nil {
		t.Fatalf("failed to create guest category: %v", err)
	}

	body := fmt.Sprintf(`{"category_id":"%s","title":"Unverified Guest Topic","content":"Should be allowed."}`, cat.Id)

	ts := newTestServer(t, app)
	defer ts.Close()

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/topics", strings.NewReader(body))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("Idempotency-Key", "idem-unverified-guest-topic-1")
	req.Header.Set("Content-Type", "application/json")

	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if res == nil {
		t.Fatalf("no response from server")
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("expected 201 Created, got %d: %s", res.StatusCode, string(body))
	}

	// Verify the topic was actually created.
	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Unverified Guest Topic'")
	if err != nil || topic == nil {
		t.Fatalf("unverified player's topic was not created in the guest zone")
	}
}

// mustCollection returns the named collection, failing the test if absent.
func mustCollection(t testing.TB, app *tests.TestApp, name string) *core.Collection {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(name)
	if err != nil {
		t.Fatalf("collection %q missing: %v", name, err)
	}
	return col
}
