package pocketbase

// admin_users_list_test.go pins the query surface of GET /admin/users that
// the paginated admin table rides on:
//
//   - `search` narrows by nickname substring BEFORE the page is cut, so the
//     client pagination counts the narrowed set;
//   - a `%` in the needle is a literal character, never "every account";
//   - email never appears, whatever the query.
//
// (The caller's own role is NOT part of this endpoint's contract: it rides
// on the polled /me projection, which is the same answer `hasPermission`
// reads — see AdminPage's myRoleId.)

import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// TestAdminUsersListSearch pins the nickname filter of the staff list.
func TestAdminUsersListSearch(t *testing.T) {
	t.Run("search narrows by nickname substring", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:           "admin searches for the player by nickname fragment",
			Method:         http.MethodGet,
			URL:            "/api/aerun/admin/users?search=player",
			TestAppFactory: newAerunTestApp,
			ExpectedStatus: http.StatusOK,
			ExpectedContent: []string{
				`"nickname":"PlayerOne"`,
				`"totalItems":1`,
				`"totalPages":1`,
			},
			NotExpectedContent: []string{
				`"nickname":"ModOne"`,
				`"nickname":"RootOne"`,
				// The address is a credential; no filter may surface it.
				`player@example.com`,
			},
		}
		scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			tokens := seedIdentityFixtures(t, app)
			scenario.Headers = map[string]string{"Authorization": tokens["root"]}
		}
		scenario.Test(t)
	})

	t.Run("a % in the needle matches literally", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:           "admin searches for a literal percent sign",
			Method:         http.MethodGet,
			URL:            "/api/aerun/admin/users?search=%25",
			TestAppFactory: newAerunTestApp,
			ExpectedStatus: http.StatusOK,
			ExpectedContent: []string{
				// No fixture nickname contains a percent sign, so the
				// wildcard must widen to nothing.
				`"totalItems":0`,
				`"items":[]`,
			},
			NotExpectedContent: []string{
				`"nickname":"PlayerOne"`,
			},
		}
		scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			tokens := seedIdentityFixtures(t, app)
			scenario.Headers = map[string]string{"Authorization": tokens["root"]}
		}
		scenario.Test(t)
	})
}
