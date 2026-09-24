package pocketbase

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/config"
	_ "github.com/SiJunma/aerun/backend/internal/migrations"
)

// testPassword satisfies the auth collection minimum (8 chars).
const testPassword = "CorrectHorse1!"

// Fixed 15-char [a-z0-9] record ids so scenario URLs can reference records
// created inside BeforeTestFunc.
const (
	fixPlayerID    = "userplayer00001"
	fixPendingID   = "userpending0001"
	fixBannedID    = "userbanned00001"
	fixModeratorID = "usermoder000001"
	fixRootID      = "userroot0000001"
)

// newAerunTestApp is the TestAppFactory for the scenarios below. The fresh
// empty data dir reproduces production: PocketBase system collections plus
// our migrations, without the module's demo fixtures.
func newAerunTestApp(t testing.TB) *tests.TestApp {
	t.Helper()

	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	// The scenario cleanup in tests.ApiScenario calls app.Cleanup().
	app.OnMailerSend().BindFunc(MailHardDisableGuard())
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		se.Router.BindFunc(assignRequestID)
		registerRoutes(se, testAerunConfig())
		return se.Next()
	})
	return app
}

func testAerunConfig() config.Config {
	return config.Config{
		Environment: "local",
		Listen:      "127.0.0.1:8090",
		DataDir:     "./pb_data",
		PublicURL:   "http://127.0.0.1:8090",
		Origins:     []string{"http://localhost:5173"},
	}
}

// seedIdentityFixtures creates the standard identity matrix and returns the
// auth tokens per actor ("player", "pending", "banned", "moderator", "root").
func seedIdentityFixtures(t testing.TB, app *tests.TestApp) map[string]string {
	t.Helper()
	return map[string]string{
		"player":    createTestUser(t, app, fixPlayerID, "player@example.com", "PlayerOne", auth.RolePlayer, auth.StatusActive),
		"pending":   createTestUser(t, app, fixPendingID, "pending@example.com", "PendingOne", auth.RolePlayer, auth.StatusPending),
		"banned":    createTestUser(t, app, fixBannedID, "banned@example.com", "BannedOne", auth.RolePlayer, auth.StatusBanned),
		"moderator": createTestUser(t, app, fixModeratorID, "mod@example.com", "ModOne", auth.RoleModerator, auth.StatusActive),
		"root":      createTestUser(t, app, fixRootID, "root@example.com", "RootOne", auth.RoleRoot, auth.StatusActive),
	}
}

// createTestUser persists a users record and returns a fresh auth token.
func createTestUser(t testing.TB, app *tests.TestApp, id, email, nickname string, role auth.Role, status auth.Status) string {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatalf("users collection missing: %v", err)
	}
	record := core.NewRecord(collection)
	record.Set("id", id)
	record.Set("email", email)
	record.SetVerified(status == auth.StatusActive)
	record.SetPassword(testPassword)
	record.Set("nickname", nickname)
	record.Set("nickname_normalized", auth.NormalizeNickname(nickname))
	record.Set("role", string(role))
	record.Set("status", string(status))
	record.Set("avatar_url", "")
	record.Set("settings", map[string]any{"signature": "signature of " + nickname})
	if err := app.Save(record); err != nil {
		t.Fatalf("failed to create user %s: %v", nickname, err)
	}
	token, err := record.NewAuthToken()
	if err != nil {
		t.Fatalf("failed to issue auth token for %s: %v", nickname, err)
	}
	return token
}

func authHeader(token string) map[string]string {
	if token == "" {
		return nil
	}
	return map[string]string{"Authorization": token}
}

func bodyReader(body string) io.Reader {
	if body == "" {
		return nil
	}
	return strings.NewReader(body)
}

// runMeScenario executes a single GET /api/aerun/me request against a fresh
// app seeded with the identity fixtures (raw-HTTP-client tests, plan §5).
//
// The actor name ("", "player", "pending", "banned", "moderator", "root") is
// turned into an Authorization header inside BeforeTestFunc: the fixtures —
// and therefore the auth tokens — only exist once the app has booted.
func runMeScenario(t *testing.T, name, actor string, expectStatus int, expect, notExpect []string) {
	t.Helper()
	scenario := tests.ApiScenario{
		Name:               name,
		Method:             http.MethodGet,
		URL:                "/api/aerun/me",
		TestAppFactory:     newAerunTestApp,
		ExpectedStatus:     expectStatus,
		ExpectedContent:    expect,
		NotExpectedContent: notExpect,
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		scenario.Headers = authHeader(seedIdentityFixtures(t, app)[actor])
	}
	scenario.Test(t)
}

// runUsersScenario executes a single request against the PocketBase record
// APIs (users/roles rules) with the identity fixtures in place. The actor is
// resolved to a bearer token the same way as in runMeScenario.
func runUsersScenario(t *testing.T, name, method, url, body, actor string, expectStatus int, expect, notExpect []string) {
	t.Helper()
	scenario := tests.ApiScenario{
		Name:               name,
		Method:             method,
		URL:                url,
		Body:               bodyReader(body),
		TestAppFactory:     newAerunTestApp,
		ExpectedStatus:     expectStatus,
		ExpectedContent:    expect,
		NotExpectedContent: notExpect,
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		scenario.Headers = authHeader(seedIdentityFixtures(t, app)[actor])
	}
	scenario.Test(t)
}

// TestMeMatrix walks the Sprint 2 DoD matrix: a guest, an active player, a
// pending user, a banned user, a moderator and the root receive exactly the
// intended public profile records — and email never appears in any response.
func TestMeMatrix(t *testing.T) {
	cases := []struct {
		name      string
		actor     string
		expect    []string
		notExpect []string
	}{
		{
			name:  "guest",
			actor: "",
			expect: []string{
				`"role":"guest"`,
				`"status":"active"`,
				`"permissions":["view_forum"]`,
				`"nickname":""`,
				`"verified":false`,
				`"request_id":"`,
			},
			notExpect: []string{`"email"`, `emailVisibility`},
		},
		{
			name:  "active player",
			actor: "player",
			expect: []string{
				`"role":"player"`,
				`"status":"active"`,
				`"nickname":"PlayerOne"`,
				`"verified":true`,
				`"use_reputation"`,
				`"use_direct_messages"`,
				`"settings":{"signature":"signature of PlayerOne"}`,
			},
			notExpect: []string{
				`player@example.com`,
				`emailVisibility`,
				`legacy_firebase_uid`,
				`"moderate_content"`,
			},
		},
		{
			name:  "pending user",
			actor: "pending",
			expect: []string{
				`"role":"player"`,
				`"status":"pending"`,
				`"view_forum"`,
				`"edit_self_nickname"`,
			},
			notExpect: []string{
				`"post_reply"`,
				`"use_reputation"`,
				`pending@example.com`,
			},
		},
		{
			name:  "banned user",
			actor: "banned",
			expect: []string{
				`"role":"player"`,
				`"status":"banned"`,
				`"permissions":[]`,
			},
			notExpect: []string{
				`"post_reply"`,
				`"view_forum"`,
				`banned@example.com`,
			},
		},
		{
			name:  "moderator",
			actor: "moderator",
			expect: []string{
				`"role":"moderator"`,
				`"status":"active"`,
				`"moderate_content"`,
				`"view_audit_log"`,
				`"bypass_hide_tags"`,
			},
			notExpect: []string{
				`"ban_users"`,
				`"change_roles"`,
				`mod@example.com`,
			},
		},
		{
			name:  "root",
			actor: "root",
			expect: []string{
				`"role":"root"`,
				`"status":"active"`,
				`"admin_access"`,
				`"change_roles"`,
				`"delete_users"`,
				`"bypass_hide_tags"`,
			},
			notExpect: []string{
				`root@example.com`,
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runMeScenario(t, tc.name, tc.actor, http.StatusOK, tc.expect, tc.notExpect)
		})
	}
}

// TestMeRejectsSuperusers ensures a superuser token is rejected instead of
// being silently presented as a forum guest.
func TestMeRejectsSuperusers(t *testing.T) {
	var superuserToken string
	scenario := tests.ApiScenario{
		Name:            "superuser tokens are rejected by /api/aerun/me",
		Method:          http.MethodGet,
		URL:             "/api/aerun/me",
		Headers:         map[string]string{"Authorization": "placeholder"},
		TestAppFactory:  newAerunTestApp,
		ExpectedStatus:  http.StatusForbidden,
		ExpectedContent: []string{`forum accounts only`},
	}
	// The token only exists once the app is up, and the closure cannot
	// reference `scenario` inside its own composite literal, so the hook is
	// attached afterwards; ApiScenario reads Headers after BeforeTestFunc.
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		seedIdentityFixtures(t, app)
		superusers, err := app.FindCachedCollectionByNameOrId(core.CollectionNameSuperusers)
		if err != nil {
			t.Fatal(err)
		}
		record := core.NewRecord(superusers)
		record.Set("email", "su@example.com")
		record.SetPassword(testPassword)
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
		token, err := record.NewAuthToken()
		if err != nil {
			t.Fatal(err)
		}
		superuserToken = token
		scenario.Headers = map[string]string{"Authorization": superuserToken}
	}
	scenario.Test(t)
}

// TestSecureReadRules verifies the public profile read contract of the users
// collection directly against the PocketBase record APIs.
func TestSecureReadRules(t *testing.T) {
	cases := []struct {
		name      string
		method    string
		url       string
		body      string
		actor     string
		status    int
		expect    []string
		notExpect []string
	}{
		{
			name:   "guest lists only active users",
			method: http.MethodGet,
			url:    "/api/collections/users/records",
			status: http.StatusOK,
			expect: []string{
				`"PlayerOne"`,
				`"emailVisibility":false`,
			},
			notExpect: []string{
				`"PendingOne"`,
				`"BannedOne"`,
				`player@example.com`,
				`legacy_firebase_uid`,
			},
		},
		{
			name:   "pending user lists active users and itself",
			method: http.MethodGet,
			url:    "/api/collections/users/records",
			actor:  "pending",
			status: http.StatusOK,
			expect: []string{
				`"PlayerOne"`,
				`"PendingOne"`,
			},
			notExpect: []string{
				`"BannedOne"`,
				// Listing never leaks email addresses of other accounts.
				`player@example.com`,
				`mod@example.com`,
				`root@example.com`,
			},
		},
		{
			name:      "guest cannot view a pending profile by id",
			method:    http.MethodGet,
			url:       "/api/collections/users/records/" + fixPendingID,
			status:    http.StatusNotFound,
			expect:    []string{`"status":404`},
			notExpect: []string{`"PendingOne"`},
		},
		{
			name:   "pending user views its own record",
			method: http.MethodGet,
			url:    "/api/collections/users/records/" + fixPendingID,
			actor:  "pending",
			status: http.StatusOK,
			expect: []string{
				`"PendingOne"`,
				`"status":"pending"`,
				// PocketBase always reveals the email to the record's own
				// author (apis/record_helpers.go calls IgnoreEmailVisibility
				// for e.Auth) — the profile owner needs it, and it is not a
				// public response. Anonymity is enforced for every *other*
				// account, which the notExpect list pins down.
				`pending@example.com`,
			},
			notExpect: []string{
				`player@example.com`,
				`mod@example.com`,
				`legacy_firebase_uid`,
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runUsersScenario(t, tc.name, tc.method, tc.url, tc.body, tc.actor, tc.status, tc.expect, tc.notExpect)
		})
	}
}

// TestLockedMutations verifies deny-by-default: browser mutations of users
// and roles are locked, so every change must go through server commands.
func TestLockedMutations(t *testing.T) {
	cases := []struct {
		name   string
		method string
		url    string
		body   string
		actor  string
		expect []string
	}{
		{
			name:   "guest cannot create a users record",
			method: http.MethodPost,
			url:    "/api/collections/users/records",
			body:   `{"email":"new@example.com","password":"12345678","nickname":"Newcomer","nickname_normalized":"newcomer","role":"root","status":"active"}`,
			expect: []string{`Only superusers`},
		},
		{
			name:   "guest cannot update a users record",
			method: http.MethodPatch,
			url:    "/api/collections/users/records/" + fixPlayerID,
			body:   `{"role":"root"}`,
			expect: []string{`Only superusers`},
		},
		{
			name:   "guest cannot read the roles collection",
			method: http.MethodGet,
			url:    "/api/collections/roles/records",
			expect: []string{`Only superusers`},
		},
		{
			name:   "guest cannot create role rows",
			method: http.MethodPost,
			url:    "/api/collections/roles/records",
			body:   `{"role_id":"hacker","name":"Hacker","rank":9999}`,
			expect: []string{`Only superusers`},
		},
		{
			name:   "authenticated player cannot create role rows",
			method: http.MethodPost,
			url:    "/api/collections/roles/records",
			body:   `{"role_id":"hacker","name":"Hacker","rank":9999}`,
			actor:  "player",
			expect: []string{`Only superusers`},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runUsersScenario(t, tc.name, tc.method, tc.url, tc.body, tc.actor, http.StatusForbidden, tc.expect, nil)
		})
	}
}

// TestRolesRowsAreReadOnlyToPlayers pins deny-by-default on an existing roles
// row: even the seeded system role must not be editable through the browser
// API, so role changes can only happen inside server commands.
func TestRolesRowsAreReadOnlyToPlayers(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:            "authenticated player cannot update a seeded role row",
		Method:          http.MethodPatch,
		Body:            strings.NewReader(`{"name":"Owned"}`),
		TestAppFactory:  newAerunTestApp,
		ExpectedStatus:  http.StatusForbidden,
		ExpectedContent: []string{`Only superusers`},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		scenario.Headers = authHeader(seedIdentityFixtures(t, app)["player"])
		role, err := app.FindFirstRecordByFilter(rolesCollectionName, "role_id = {:role}", dbx.Params{"role": string(auth.RolePlayer)})
		if err != nil {
			t.Fatalf("seeded player role row is missing: %v", err)
		}
		scenario.URL = "/api/collections/roles/records/" + role.Id
	}
	scenario.Test(t)
}

// TestMailHardDisableGuard is the Sprint 2 guardrail check: PB's password
// reset and verification endpoints answer 204, but the mailer hook must stop
// every send before a connection is attempted — the test mailer must record
// zero messages.
func TestMailHardDisableGuard(t *testing.T) {
	cases := []struct {
		name string
		url  string
		body string
	}{
		{
			name: "password reset request sends no email",
			url:  "/api/collections/users/request-password-reset",
			body: `{"email":"player@example.com"}`,
		},
		{
			name: "verification request sends no email",
			url:  "/api/collections/users/request-verification",
			body: `{"email":"pending@example.com"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:           tc.name,
				Method:         http.MethodPost,
				URL:            tc.url,
				Body:           strings.NewReader(tc.body),
				Delay:          300 * time.Millisecond,
				TestAppFactory: newAerunTestApp,
				BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
					seedIdentityFixtures(t, app)
				},
				ExpectedStatus: http.StatusNoContent,
				AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
					if got := app.TestMailer.TotalSend(); got != 0 {
						t.Fatalf("expected the mail guard to block all sends, got %d", got)
					}
				},
			}
			scenario.Test(t)
		})
	}
}
