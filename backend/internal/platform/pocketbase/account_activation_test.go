package pocketbase

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// setRequireApproval flips the "require approval" switch the way an admin would
// from the panel, so the sign-in hook and initialAccountStatus observe the value
// a real deployment would carry. It writes the singleton forum_settings row.
func setRequireApproval(t testing.TB, app *tests.TestApp, required bool) {
	t.Helper()
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		t.Fatalf("forum_settings row missing: %v", err)
	}
	record.Set("require_approval", required)
	if err := app.Save(record); err != nil {
		t.Fatalf("set require_approval=%t: %v", required, err)
	}
}

func statusOf(t testing.TB, app *tests.TestApp, id string) string {
	t.Helper()
	record, err := app.FindRecordById(usersCollectionName, id)
	if err != nil || record == nil {
		t.Fatalf("user %s missing: %v", id, err)
	}
	return record.GetString("status")
}

// TestInitialAccountStatusFollowsRequireApproval pins the creation-time half of
// the fix: a new email/password account is born active when the gate is off and
// pending when it is on. This is what stops a forum that turned approval OFF
// from burying every new member behind /pending from the very first row.
func TestInitialAccountStatusFollowsRequireApproval(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	setRequireApproval(t, app, false)
	if got := initialAccountStatus(app); got != auth.StatusActive {
		t.Fatalf("require_approval=false must create an active account, got %q", got)
	}

	setRequireApproval(t, app, true)
	if got := initialAccountStatus(app); got != auth.StatusPending {
		t.Fatalf("require_approval=true must create a pending account, got %q", got)
	}
}

// TestRegisterCreatesActiveWhenApprovalDisabled pins that the register command
// honours the switch: with approval OFF the response and the stored row both
// carry status=active, so the member is usable immediately rather than waiting
// for a staff approval the forum has said it does not want.
func TestRegisterCreatesActiveWhenApprovalDisabled(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "register creates an active account when approval is disabled",
		Method:         http.MethodPost,
		URL:            "/api/aerun/auth/register",
		Body:           strings.NewReader(`{"email":"AutoActive@Example.com","password":"CorrectHorse1!","nickname":"AutoActive"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusCreated,
		ExpectedContent: []string{
			`"nickname":"AutoActive"`,
			`"role":"player"`,
			`"status":"active"`,
			`"verified":false`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			setRequireApproval(t, app, false)
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			record, err := app.FindAuthRecordByEmail("users", "autoactive@example.com")
			if err != nil || record == nil {
				t.Fatalf("registered account is missing: %v", err)
			}
			if record.GetString("status") != string(auth.StatusActive) {
				t.Fatalf("approval disabled must store status=active, got %q", record.GetString("status"))
			}
			// Email verification stays a separate axis: an active account may
			// still be unverified and nudged by the banner.
			if record.Verified() {
				t.Fatal("a freshly registered account must stay unverified")
			}
		},
	}
	scenario.Test(t)
}

// TestRegisterStaysPendingWhenApprovalRequired guards the other side of the
// switch: with approval ON nothing changed — a new account is still pending and
// waits for a staff member, exactly as before the fix.
func TestRegisterStaysPendingWhenApprovalRequired(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "register keeps a pending account when approval is required",
		Method:         http.MethodPost,
		URL:            "/api/aerun/auth/register",
		Body:           strings.NewReader(`{"email":"StillWaits@Example.com","password":"CorrectHorse1!","nickname":"StillWaits"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusCreated,
		ExpectedContent: []string{
			`"status":"pending"`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			setRequireApproval(t, app, true)
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			record, err := app.FindAuthRecordByEmail("users", "stillwaits@example.com")
			if err != nil || record == nil {
				t.Fatalf("registered account is missing: %v", err)
			}
			if record.GetString("status") != string(auth.StatusPending) {
				t.Fatalf("approval required must store status=pending, got %q", record.GetString("status"))
			}
		},
	}
	scenario.Test(t)
}

// TestSignInActivatesPendingAccountWhenApprovalDisabled pins the sign-in half of
// the fix (approach B) — the self-heal for an account that was created pending
// (before the switch was turned off, or through a provider) and is now stuck.
// Signing in with approval OFF must promote it to active; the reported account
// (Test2) is exactly this shape. Driven through PocketBase's native
// auth-with-password route so the real OnRecordAuthRequest chain fires.
func TestSignInActivatesPendingAccountWhenApprovalDisabled(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "sign-in activates a pending account when approval is disabled",
		Method:         http.MethodPost,
		URL:            "/api/collections/users/auth-with-password",
		Body:           strings.NewReader(`{"identity":"pending@example.com","password":"` + testPassword + `"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"status":"active"`,
			`"token":"`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			// The sign-in activation hook is bound from run.go in production;
			// bind it here so the scenario exercises the real chain.
			registerAccountActivationHook(app)
			seedIdentityFixtures(t, app) // pending account: unverified + pending
			setRequireApproval(t, app, false)
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			if got := statusOf(t, app, fixPendingID); got != string(auth.StatusActive) {
				t.Fatalf("sign-in with approval off must promote pending→active, got %q", got)
			}
		},
	}
	scenario.Test(t)
}

// TestSignInKeepsPendingWhenApprovalRequired is the guard rail: the hook must be
// a no-op when approval is ON, so staff keep full control of who is admitted.
func TestSignInKeepsPendingWhenApprovalRequired(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "sign-in leaves a pending account pending when approval is required",
		Method:         http.MethodPost,
		URL:            "/api/collections/users/auth-with-password",
		Body:           strings.NewReader(`{"identity":"pending@example.com","password":"` + testPassword + `"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"status":"pending"`,
			`"token":"`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			registerAccountActivationHook(app)
			seedIdentityFixtures(t, app)
			setRequireApproval(t, app, true)
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			if got := statusOf(t, app, fixPendingID); got != string(auth.StatusPending) {
				t.Fatalf("approval required must keep the account pending, got %q", got)
			}
		},
	}
	scenario.Test(t)
}

// TestSignInNeverResurrectsBannedAccount pins the one activation the hook must
// refuse: a banned account signs in (a token still validates) but must not be
// silently promoted back to active — a ban is a staff decision a login cannot
// undo. Kept explicit because the hook keys off status and a future edit could
// widen the eligible set by accident.
func TestSignInNeverResurrectsBannedAccount(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "sign-in must not resurrect a banned account",
		Method:         http.MethodPost,
		URL:            "/api/collections/users/auth-with-password",
		Body:           strings.NewReader(`{"identity":"banned@example.com","password":"` + testPassword + `"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"status":"banned"`,
			`"token":"`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			registerAccountActivationHook(app)
			seedIdentityFixtures(t, app)
			setRequireApproval(t, app, false)
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			if got := statusOf(t, app, fixBannedID); got != string(auth.StatusBanned) {
				t.Fatalf("a banned account must stay banned after sign-in, got %q", got)
			}
		},
	}
	scenario.Test(t)
}
