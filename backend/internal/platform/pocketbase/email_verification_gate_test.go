package pocketbase

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// TestUnverifiedPlayerCannotCreateTopic checks the reported bug: an account
// whose email is not verified (verified=false) must not be able to create a
// topic even when its role holds create_topic.
func TestUnverifiedPlayerCannotCreateTopic(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "unverified player cannot create a topic",
		Method:         http.MethodPost,
		URL:            "/api/aerun/topics",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusForbidden,
		ExpectedContent: []string{
			`"message":"This account's email is not verified`,
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

// mustCollection returns the named collection, failing the test if absent.
func mustCollection(t testing.TB, app *tests.TestApp, name string) *core.Collection {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(name)
	if err != nil {
		t.Fatalf("collection %q missing: %v", name, err)
	}
	return col
}
