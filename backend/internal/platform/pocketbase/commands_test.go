package pocketbase

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// ---------------------------------------------------------------------------
// POST /api/aerun/auth/register (Sprint 2 task 2: email/password registration)
// ---------------------------------------------------------------------------

// TestRegisterCreatesPendingAccount pins the registration contract: a guest
// gets a pending, unverified account, the normalised nickname is stored for
// the unique index, and the response never contains the email address or any
// private auth column.
func TestRegisterCreatesPendingAccount(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "guest registers a pending account without email in the response",
		Method:         http.MethodPost,
		URL:            "/api/aerun/auth/register",
		Body:           strings.NewReader(`{"email":"Newbie@Example.com","password":"CorrectHorse1!","nickname":"Newbie"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusCreated,
		ExpectedContent: []string{
			`"nickname":"Newbie"`,
			`"role":"player"`,
			`"status":"pending"`,
			`"verified":false`,
			`"request_id":"`,
		},
		NotExpectedContent: []string{
			`Newbie@Example.com`,
			`newbie@example.com`,
			`tokenKey`,
			`token_key`,
			`legacy_firebase_uid`,
			`emailVisibility`,
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			record, err := app.FindAuthRecordByEmail("users", "newbie@example.com")
			if err != nil {
				t.Fatalf("registered account is missing: %v", err)
			}
			if record.GetString("nickname_normalized") != "newbie" {
				t.Fatalf("nickname_normalized drifted: %q", record.GetString("nickname_normalized"))
			}
			if record.GetBool("verified") {
				t.Fatal("a freshly registered account must be unverified")
			}
			if record.GetString("status") != string(auth.StatusPending) {
				t.Fatalf("a freshly registered account must be pending, got %q", record.GetString("status"))
			}
			settings, err := decodeSettings(record)
			if err != nil {
				t.Fatalf("stored settings must decode: %v", err)
			}
			if len(settings) != 0 {
				t.Fatalf("a freshly registered account must start with empty settings, got %v", settings)
			}
		},
	}
	scenario.Test(t)
}

// TestRegisterConflicts covers the two UNIQUE indexes behind registration:
// the auth email and the partial unique index on nickname_normalized.
func TestRegisterConflicts(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		message string
	}{
		{
			name:    "duplicate email is rejected",
			body:    `{"email":"player@example.com","password":"CorrectHorse1!","nickname":"Fresh"}`,
			message: "An account with this email already exists.",
		},
		{
			name:    "case- and whitespace-variant of an existing nickname is rejected",
			body:    `{"email":"fresh@example.com","password":"CorrectHorse1!","nickname":"  PLAYERONE "}`,
			message: "Nickname is already taken.",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPost,
				URL:             "/api/aerun/auth/register",
				Body:            strings.NewReader(tc.body),
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  http.StatusConflict,
				ExpectedContent: []string{tc.message},
				BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
					seedIdentityFixtures(t, app)
				},
			}
			scenario.Test(t)
		})
	}
}

// TestRegisterValidation walks the input contract: missing/malformed email,
// password length bounds (8..72), nickname presence, length and reservation.
func TestRegisterValidation(t *testing.T) {
	longPassword := strings.Repeat("p", maxPasswordLen+1)
	longNickname := strings.Repeat("n", maxNicknameLen+1)

	cases := []struct {
		name    string
		body    string
		message string
	}{
		{
			name:    "missing email",
			body:    `{"password":"CorrectHorse1!","nickname":"Fresh"}`,
			message: "Email is required.",
		},
		{
			name:    "malformed email",
			body:    `{"email":"not-an-email","password":"CorrectHorse1!","nickname":"Fresh"}`,
			message: "Email is not a valid address.",
		},
		{
			name:    "too short password",
			body:    `{"email":"fresh@example.com","password":"sH0rt!","nickname":"Fresh"}`,
			message: "Password must be at least 8 characters long.",
		},
		{
			name:    "too long password",
			body:    `{"email":"fresh@example.com","password":"` + longPassword + `","nickname":"Fresh"}`,
			message: "Password must not exceed 72 characters.",
		},
		{
			name:    "missing nickname",
			body:    `{"email":"fresh@example.com","password":"CorrectHorse1!"}`,
			message: "Nickname is required.",
		},
		{
			name:    "whitespace-only nickname",
			body:    `{"email":"fresh@example.com","password":"CorrectHorse1!","nickname":"   "}`,
			message: "Nickname is required.",
		},
		{
			name:    "reserved nickname",
			body:    `{"email":"fresh@example.com","password":"CorrectHorse1!","nickname":"Admin"}`,
			message: "Nickname is reserved.",
		},
		{
			name:    "oversized nickname",
			body:    `{"email":"fresh@example.com","password":"CorrectHorse1!","nickname":"` + longNickname + `"}`,
			message: "Nickname must not exceed 64 characters.",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPost,
				URL:             "/api/aerun/auth/register",
				Body:            strings.NewReader(tc.body),
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  http.StatusBadRequest,
				ExpectedContent: []string{tc.message},
				BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
					seedIdentityFixtures(t, app)
				},
			}
			scenario.Test(t)
		})
	}
}

// TestRegisterRejectsAuthenticatedCaller keeps registration guest-only: an
// already-authenticated account must not mint a second identity silently.
func TestRegisterRejectsAuthenticatedCaller(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "authenticated player cannot register a new account",
		Method:         http.MethodPost,
		URL:            "/api/aerun/auth/register",
		Body:           strings.NewReader(`{"email":"fresh@example.com","password":"CorrectHorse1!","nickname":"Fresh"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusForbidden,
		ExpectedContent: []string{
			"You are already signed in",
		},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		scenario.Headers = authHeader(seedIdentityFixtures(t, app)["player"])
	}
	scenario.Test(t)
}

// TestRegisterOversizedBody pins the hard request size cap: bodies beyond
// 64 KiB are rejected with 413 before any parsing.
func TestRegisterOversizedBody(t *testing.T) {
	oversized := `{"email":"fresh@example.com","password":"CorrectHorse1!","nickname":"` +
		strings.Repeat("a", registerMaxBodyBytes) + `"}`
	scenario := tests.ApiScenario{
		Name:            "oversized registration body is rejected",
		Method:          http.MethodPost,
		URL:             "/api/aerun/auth/register",
		Body:            strings.NewReader(oversized),
		TestAppFactory:  newAerunTestApp,
		ExpectedStatus:  http.StatusRequestEntityTooLarge,
		ExpectedContent: []string{"Request body is too large."},
	}
	scenario.Test(t)
}

// ---------------------------------------------------------------------------
// PUT /api/aerun/me/settings (Sprint 2 task 5: owner-only settings access)
// ---------------------------------------------------------------------------

// TestSettingsUpdateAccessMatrix walks the owner-only rule: guests are
// unauthenticated (401), banned accounts are denied (403), while active and
// pending accounts may edit their own settings.
func TestSettingsUpdateAccessMatrix(t *testing.T) {
	cases := []struct {
		name         string
		actor        string
		expectStatus int
		expect       []string
	}{
		{
			name:         "guest is unauthenticated",
			actor:        "",
			expectStatus: http.StatusUnauthorized,
			expect:       []string{"Authentication is required"},
		},
		{
			name:         "banned account is denied",
			actor:        "banned",
			expectStatus: http.StatusForbidden,
			expect:       []string{"Banned accounts cannot change their settings"},
		},
		{
			name:         "active player updates own settings",
			actor:        "player",
			expectStatus: http.StatusOK,
			expect:       []string{`"settings":{"theme":"dark"}`, `"request_id":"`},
		},
		{
			name:         "pending account keeps its self-service rights",
			actor:        "pending",
			expectStatus: http.StatusOK,
			expect:       []string{`"settings":{"theme":"dark"}`},
		},
		{
			name:         "moderator updates own settings",
			actor:        "moderator",
			expectStatus: http.StatusOK,
			expect:       []string{`"settings":{"theme":"dark"}`},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPut,
				URL:             "/api/aerun/me/settings",
				Body:            strings.NewReader(`{"theme":"dark"}`),
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.expectStatus,
				ExpectedContent: tc.expect,
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				scenario.Headers = authHeader(seedIdentityFixtures(t, app)[tc.actor])
			}
			scenario.AfterTestFunc = func(t testing.TB, app *tests.TestApp, res *http.Response) {
				if tc.expectStatus != http.StatusOK {
					return
				}
				email := tc.actor + "@example.com"
				if tc.actor == "moderator" {
					email = "mod@example.com"
				}
				record, err := app.FindFirstRecordByFilter("users", "email = {:email}", map[string]any{"email": email})
				if err != nil {
					t.Fatalf("account row is missing: %v", err)
				}
				settings, err := decodeSettings(record)
				if err != nil {
					t.Fatalf("stored settings must decode: %v", err)
				}
				if settings["theme"] != "dark" {
					t.Fatalf("settings were not persisted, got %v", settings)
				}
			}
			scenario.Test(t)
		})
	}
}

// nestedSettingsJSON builds {"a":{"a":...}} with the given nesting depth
// (depth 1 is a bare value, depth 2 is one wrapped object, ...).
func nestedSettingsJSON(depth int) string {
	if depth == 1 {
		return `1`
	}
	return `{"a":` + nestedSettingsJSON(depth-1) + `}`
}

// TestSettingsUpdateValidation pins the settings payload contract: a single
// JSON object, bounded nesting depth and bounded size. JSON null normalises
// to an empty object so the column never stores null.
func TestSettingsUpdateValidation(t *testing.T) {
	cases := []struct {
		name         string
		body         string
		expectStatus int
		expect       string
	}{
		{
			name:         "eight levels of nesting are allowed",
			body:         nestedSettingsJSON(8),
			expectStatus: http.StatusOK,
			expect:       `"request_id":"`,
		},
		{
			name:         "deeper nesting is rejected",
			body:         nestedSettingsJSON(settingsMaxDepth + 4),
			expectStatus: http.StatusBadRequest,
			expect:       "nesting must not exceed 8 levels",
		},
		{
			name:         "arrays are not settings objects",
			body:         `[1,2,3]`,
			expectStatus: http.StatusBadRequest,
			expect:       "Settings must be a single JSON object.",
		},
		{
			name:         "malformed JSON is rejected",
			body:         `{"theme":`,
			expectStatus: http.StatusBadRequest,
			expect:       "Settings must be a single JSON object.",
		},
		{
			name:         "null normalises to an empty object",
			body:         `null`,
			expectStatus: http.StatusOK,
			expect:       `"settings":{}`,
		},
		{
			name:         "oversized payload is rejected",
			body:         `{"theme":"` + strings.Repeat("a", settingsMaxBytes) + `"}`,
			expectStatus: http.StatusRequestEntityTooLarge,
			expect:       "Request body is too large.",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPut,
				URL:             "/api/aerun/me/settings",
				Body:            strings.NewReader(tc.body),
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.expectStatus,
				ExpectedContent: []string{tc.expect},
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				scenario.Headers = authHeader(seedIdentityFixtures(t, app)["player"])
			}
			scenario.Test(t)
		})
	}
}

// ---------------------------------------------------------------------------
// GET /api/aerun/admin/users (Sprint 2 task 5: staff-only admin read model)
// ---------------------------------------------------------------------------

// TestAdminUsersListAccessMatrix pins the permission gate: admin_access is
// held by root and admin only, so every other actor — including moderators —
// gets 403, and guests get 401.
func TestAdminUsersListAccessMatrix(t *testing.T) {
	cases := []struct {
		name         string
		actor        string
		expectStatus int
		expect       []string
	}{
		{
			name:         "guest is unauthenticated",
			actor:        "",
			expectStatus: http.StatusUnauthorized,
			expect:       []string{"Authentication is required"},
		},
		{
			name:         "pending user is forbidden",
			actor:        "pending",
			expectStatus: http.StatusForbidden,
			expect:       []string{"You are not allowed"},
		},
		{
			name:         "banned user is forbidden",
			actor:        "banned",
			expectStatus: http.StatusForbidden,
			expect:       []string{"You are not allowed"},
		},
		{
			name:         "player is forbidden",
			actor:        "player",
			expectStatus: http.StatusForbidden,
			expect:       []string{"You are not allowed"},
		},
		{
			name:         "moderator has no admin_access",
			actor:        "moderator",
			expectStatus: http.StatusForbidden,
			expect:       []string{"You are not allowed"},
		},
		{
			name:         "root lists accounts",
			actor:        "root",
			expectStatus: http.StatusOK,
			expect:       []string{`"totalItems":5`},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodGet,
				URL:             "/api/aerun/admin/users",
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.expectStatus,
				ExpectedContent: tc.expect,
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				scenario.Headers = authHeader(seedIdentityFixtures(t, app)[tc.actor])
			}
			scenario.Test(t)
		})
	}
}

// TestAdminUsersListPayload pins the staff read model contract: status
// filtering works, pagination metadata is present, email is visible to staff
// (an admin read model is not a public response), while private auth columns
// (token key, password, legacy uid) can never leak into the payload.
func TestAdminUsersListPayload(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "root lists pending accounts only with private columns stripped",
		Method:         http.MethodGet,
		URL:            "/api/aerun/admin/users?status=pending&perPage=10",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"totalItems":1`,
			`"totalPages":1`,
			`"email":"pending@example.com"`,
			fixPendingID,
			`"status":"pending"`,
			`"request_id":"`,
		},
		NotExpectedContent: []string{
			`player@example.com`,
			`mod@example.com`,
			`tokenKey`,
			`token_key`,
			`legacy_firebase_uid`,
			`"password"`,
		},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		scenario.Headers = authHeader(seedIdentityFixtures(t, app)["root"])
	}
	scenario.Test(t)
}
