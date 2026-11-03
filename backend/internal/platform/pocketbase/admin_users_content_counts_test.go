package pocketbase

// admin_users_content_counts_test.go pins the read-only content preview the
// delete dialogs use: POST /admin/users/content-counts counts, per account,
// the owned topics and owned posts the "delete all their content" purge
// (purgeUserContent) would remove (§9.6 of SPEC_BULK_USER_MANAGEMENT.md).
// The route is admin-only — the same PermAdminAccess gate as the list.

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// TestAdminUsersContentCounts pins the gate and the counting.
func TestAdminUsersContentCounts(t *testing.T) {
	t.Run("counts the authored topics and posts of a named account", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:           "admin asks for the content counts of the player",
			Method:         http.MethodPost,
			URL:            "/api/aerun/admin/users/content-counts",
			Body:           strings.NewReader(`{"ids":["` + fixPlayerID + `","userbulkadmin01"]}`),
			TestAppFactory: newAerunTestApp,
			ExpectedStatus: http.StatusOK,
			// The player owns one seeded topic and one post in it; the peer
			// admin owns nothing — zeros come back too.
			ExpectedContent: []string{
				`"id":"` + fixPlayerID + `"`,
				`"topics":1`,
				`"posts":1`,
				`"id":"userbulkadmin01"`,
				`"topics":0`,
				`"posts":0`,
			},
		}
		scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			headers := map[string]string{}
			seedIdentityFixtures(t, app)
			headers["Authorization"] = createTestUser(t, app, fixAdminID, "admin@example.com", "AdminOne", auth.RoleAdmin, auth.StatusActive)
			createTestUser(t, app, "userbulkadmin01", "admin2@example.com", "AdminTwo", auth.RoleAdmin, auth.StatusActive)
			seedTopicAndPost(t, app, fixPlayerID)
			scenario.Headers = headers
		}
		scenario.Test(t)
	})

	t.Run("guest is unauthenticated", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:            "guest content counts",
			Method:          http.MethodPost,
			URL:             "/api/aerun/admin/users/content-counts",
			Body:            strings.NewReader(`{"ids":["` + fixPlayerID + `"]}`),
			TestAppFactory:  newAerunTestApp,
			ExpectedStatus:  http.StatusUnauthorized,
			ExpectedContent: []string{"Authentication is required"},
		}
		scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			seedIdentityFixtures(t, app)
			scenario.Headers = map[string]string{}
		}
		scenario.Test(t)
	})

	t.Run("player is forbidden", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:            "player content counts",
			Method:          http.MethodPost,
			URL:             "/api/aerun/admin/users/content-counts",
			Body:            strings.NewReader(`{"ids":["` + fixPlayerID + `"]}`),
			TestAppFactory:  newAerunTestApp,
			ExpectedStatus:  http.StatusForbidden,
			ExpectedContent: []string{"You are not allowed"},
		}
		scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			tokens := seedIdentityFixtures(t, app)
			scenario.Headers = map[string]string{"Authorization": tokens["player"]}
		}
		scenario.Test(t)
	})

	t.Run("empty ids is a validation error", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:            "empty ids content counts",
			Method:          http.MethodPost,
			URL:             "/api/aerun/admin/users/content-counts",
			Body:            strings.NewReader(`{"ids":[]}`),
			TestAppFactory:  newAerunTestApp,
			ExpectedStatus:  http.StatusBadRequest,
			ExpectedContent: []string{"Expected a non-empty ids array"},
		}
		scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			tokens := seedIdentityFixtures(t, app)
			headers := map[string]string{"Authorization": tokens["root"]}
			scenario.Headers = headers
		}
		scenario.Test(t)
	})

	// Silence the unused import of core if helpers ever change signature.
	_ = core.Record{}
}
