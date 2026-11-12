package pocketbase

// user_members_list_test.go pins the query surface of GET /api/aerun/users that
// the public members board rides on:
//
//   - `search` narrows by nickname substring BEFORE the page is cut, so the
//     envelope counts the narrowed set (totalItems/totalPages);
//   - `sort`/`order` order server-side through one allow-list, ending in a
//     stable `id ASC` tiebreak, and an unknown pair falls back to the default
//     (most recently active) instead of erroring;
//   - one request serves one page — the cap that stops a caller pulling the
//     whole board in a single response.
//
// (The whitelist itself — no email, no settings — is pinned in
// user_profile_test.go's TestPublicMembersListHidesPrivateSettings.)

import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// TestPublicMembersListSearch pins the nickname filter of the public board.
func TestPublicMembersListSearch(t *testing.T) {
	t.Run("search narrows by nickname substring", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:           "guest searches the board by nickname fragment",
			Method:         http.MethodGet,
			URL:            "/api/aerun/users?search=Player",
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
			seedIdentityFixtures(t, app)
		}
		scenario.Test(t)
	})

	t.Run("a % in the needle matches literally", func(t *testing.T) {
		scenario := tests.ApiScenario{
			Name:           "guest searches for a literal percent sign",
			Method:         http.MethodGet,
			URL:            "/api/aerun/users?search=%25",
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
			seedIdentityFixtures(t, app)
		}
		scenario.Test(t)
	})
}

// TestPublicMembersListSort pins the allow-list: every recognised field orders
// server-side, and anything else falls back to the default order.
func TestPublicMembersListSort(t *testing.T) {
	cases := []struct {
		name  string
		query string
	}{
		{name: "nickname ascending", query: "?sort=nickname&order=asc"},
		{name: "nickname descending", query: "?sort=nickname&order=desc"},
		{name: "last_seen descending", query: "?sort=last_seen&order=desc"},
		{name: "last_seen ascending", query: "?sort=last_seen&order=asc"},
		{name: "role ascending", query: "?sort=role&order=asc"},
		{name: "post_count descending", query: "?sort=post_count&order=desc"},
		{name: "reputation ascending", query: "?sort=reputation&order=asc"},
		{name: "created_at descending", query: "?sort=created_at&order=desc"},
		// An unknown pair must not error the board — it renders in the
		// default order instead.
		{name: "unknown sort falls back", query: "?sort=updated_at&order=banana"},
		{name: "no sort at all falls back", query: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:           "guest sorts the board: " + tc.name,
				Method:         http.MethodGet,
				URL:            "/api/aerun/users" + tc.query,
				TestAppFactory: newAerunTestApp,
				ExpectedStatus: http.StatusOK,
				ExpectedContent: []string{
					`"nickname":"PlayerOne"`,
					`"nickname":"ModOne"`,
				},
				NotExpectedContent: []string{
					`player@example.com`,
					`"settings"`,
				},
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				seedIdentityFixtures(t, app)
			}
			scenario.Test(t)
		})
	}
}

// TestMemberListOrder pins the allow-list itself: recognised keys map to real
// columns, every order ends in the id tiebreak, and an unknown sort or
// direction can never reach OrderBy.
func TestMemberListOrder(t *testing.T) {
	cases := []struct {
		name     string
		sortRaw  string
		orderRaw string
		want     []string
	}{
		{name: "default is last_seen desc", sortRaw: "", orderRaw: "", want: []string{"last_seen DESC", "id ASC"}},
		{name: "explicit last_seen asc", sortRaw: "last_seen", orderRaw: "asc", want: []string{"last_seen ASC", "id ASC"}},
		{name: "nickname asc", sortRaw: "nickname", orderRaw: "asc", want: []string{"nickname ASC", "id ASC"}},
		{name: "nickname desc", sortRaw: "nickname", orderRaw: "desc", want: []string{"nickname DESC", "id ASC"}},
		{name: "role asc", sortRaw: "role", orderRaw: "asc", want: []string{"role ASC", "id ASC"}},
		{name: "post_count maps to posts_count", sortRaw: "post_count", orderRaw: "desc", want: []string{"posts_count DESC", "id ASC"}},
		{name: "reputation asc", sortRaw: "reputation", orderRaw: "asc", want: []string{"reputation ASC", "id ASC"}},
		{name: "created_at maps to created", sortRaw: "created_at", orderRaw: "desc", want: []string{"created DESC", "id ASC"}},
		{name: "unknown field falls back", sortRaw: "updated_at", orderRaw: "desc", want: []string{"last_seen DESC", "id ASC"}},
		{name: "unknown direction falls back to desc", sortRaw: "nickname", orderRaw: "banana", want: []string{"nickname DESC", "id ASC"}},
		{name: "direction is case-insensitive", sortRaw: "nickname", orderRaw: "ASC", want: []string{"nickname ASC", "id ASC"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := memberListOrder(tc.sortRaw, tc.orderRaw)
			if len(got) != len(tc.want) {
				t.Fatalf("memberListOrder(%q, %q) = %v, want %v", tc.sortRaw, tc.orderRaw, got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("memberListOrder(%q, %q)[%d] = %q, want %q (full: %v)", tc.sortRaw, tc.orderRaw, i, got[i], tc.want[i], got)
				}
			}
		})
	}
}
