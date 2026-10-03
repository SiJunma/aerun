package pocketbase

// Account credential commands (GET /me/auth, PUT /me/password, PATCH /me/email
// and the provider unlink).
//
// The load-bearing test is TestUnlinkRefusesToRemoveTheLastMethod: without that
// guard, "unlink Google" on an account that only ever signed in with Google
// locks the member out of their own forum, and mail delivery — the usual way
// back — is hard-disabled (mail_guard.go).

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// decodeAuthPayload reads the /me/auth response envelope.
//
// The payload is FLAT: the handler answers e.JSON with the map itself, not with an
// "auth" wrapper. Decoding through a nested struct silently yields zero values for
// every field, which turns these assertions into tautologies - has_password would
// read false for an account that certainly has one.
func decodeAuthPayload(t testing.TB, payload []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("cannot decode auth payload %s: %v", payload, err)
	}
	return out
}
func enableGoogle(t testing.TB, app *tests.TestApp) {
	t.Helper()
	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	users.OAuth2.Enabled = true
	users.OAuth2.Providers = []core.OAuth2ProviderConfig{{
		Name:         googleProviderName,
		ClientId:     "test-client",
		ClientSecret: "test-secret",
	}}
	if err := app.Save(users); err != nil {
		t.Fatal(err)
	}
}

// linkGoogle creates the _externalAuths row PocketBase makes on a provider
// sign-in.
func linkGoogle(t testing.TB, app *tests.TestApp, userID string) {
	t.Helper()
	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	ea := core.NewExternalAuth(app)
	ea.SetCollectionRef(users.Id)
	ea.SetRecordRef(userID)
	ea.SetProvider(googleProviderName)
	ea.SetProviderId("google-subject-" + userID)
	if err := app.Save(ea); err != nil {
		t.Fatalf("failed to link google for %s: %v", userID, err)
	}
}

// restorePassword writes a known password hash back WITHOUT rotating the token
// key, so a test can move an account from password-less to password-bearing
// while continuing to authenticate with the token it already holds.
func restorePassword(t testing.TB, app *tests.TestApp, userID, hash string) {
	t.Helper()
	record := mustRecord(t, app, userID)
	record.SetRaw(core.FieldNamePassword, &core.PasswordFieldValue{Hash: hash})
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	if !accountHasPassword(mustRecord(t, app, userID)) {
		t.Fatal("restorePassword failed: the record still reports no password")
	}
}

// clearPassword removes the stored hash, reproducing an account that has only
// ever signed in through a provider.
//
// SetPassword("") is NOT usable, and neither is SetRaw: the field validator
// rejects a blank password on save ("password cannot be blank") because
// PocketBase treats the password column as always-present for an auth record.
// The column is written directly instead, which is the only way to reproduce
// the password-less state oauth_signin_recent.go documents as real — "an
// account that has only ever signed in through Google is stored by PocketBase
// with NO password at all".
func clearPassword(t testing.TB, app *tests.TestApp, userID string) {
	t.Helper()
	_, err := app.DB().NewQuery("UPDATE users SET password = '' WHERE id = {:id}").
		Bind(dbx.Params{"id": userID}).
		Execute()
	if err != nil {
		t.Fatal(err)
	}
	if accountHasPassword(mustRecord(t, app, userID)) {
		t.Fatal("clearPassword failed: the record still reports a password")
	}
}

// there is none. As in the handler, GetString is NOT usable here - see
// accountHasPassword.
func passwordHashOf(record *core.Record) string {
	pv, _ := record.GetRaw(core.FieldNamePassword).(*core.PasswordFieldValue)
	if pv == nil {
		return ""
	}
	return pv.Hash
}

func mustRecord(t testing.TB, app *tests.TestApp, id string) *core.Record {
	t.Helper()
	record, err := app.FindRecordById(usersCollectionName, id)
	if err != nil {
		t.Fatalf("user %s not found: %v", id, err)
	}
	return record
}

// passwordHashOf reads the stored hash for the leak assertion. As in the
// handler, GetString is NOT usable here — see accountHasPassword.
// TestCountMethodsIsPostRemoval is the unit-level statement of the rule: the
// figure is what would be LEFT, so the provider being removed never counts and
// a password or any other provider does.
func TestCountMethodsIsPostRemoval(t *testing.T) {
	google := []linkedProvider{{Provider: "google"}}

	if got := countMethods(false, google, "google"); got != 0 {
		t.Fatalf("a google-only account has 0 methods left after unlinking google, got %d", got)
	}
	if got := countMethods(true, google, "google"); got != 1 {
		t.Fatalf("a password survives the unlink, expected 1, got %d", got)
	}
	if got := countMethods(true, nil, "google"); got != 1 {
		t.Fatalf("an account with only a password keeps 1, got %d", got)
	}
	if got := countMethods(false, []linkedProvider{{Provider: "google"}, {Provider: "gitlab"}}, "google"); got != 1 {
		t.Fatalf("another provider survives the unlink, expected 1, got %d", got)
	}
}

// TestUnlinkRefusesToRemoveTheLastMethod is the end-to-end guard: a
// google-only account must be refused, and the refusal must delete nothing.
func TestUnlinkRefusesToRemoveTheLastMethod(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	enableGoogle(t, app)

	tokens := seedIdentityFixtures(t, app)
	// The hash is captured BEFORE it is cleared, so the later "now set a
	// password" step can restore the very same value without rotating tokens.
	seededPasswordHash := passwordHashOf(mustRecord(t, app, fixPlayerID))
	if seededPasswordHash == "" {
		t.Fatal("fixture precondition failed: the seeded account must have a password")
	}
	// A member who has never held a password — the importer gives one away
	// unseen, and a first Google sign-in does not create one at all.
	clearPassword(t, app, fixPlayerID)
	linkGoogle(t, app, fixPlayerID)

	server := newTestServer(t, app)
	defer server.Close()

	// Precondition: the account really has only one way in.
	status, payload, _ := categoryCall(t, http.MethodGet, server.URL+"/api/aerun/me/auth", "", tokens["player"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200 reading auth state, got %d: %s", status, payload)
	}
	state := decodeAuthPayload(t, payload)
	if state["has_password"].(bool) {
		t.Fatal("fixture precondition failed: the account must have no password")
	}

	status, payload, _ = categoryCall(t, http.MethodDelete,
		server.URL+"/api/aerun/me/auth/"+googleProviderName, "", tokens["player"], "test-idem-unlink-last")
	if status != http.StatusConflict {
		t.Fatalf("unlinking the only sign-in method must be refused with 409, got %d: %s", status, payload)
	}
	if !strings.Contains(string(payload), "only way to sign in") {
		t.Fatalf("the refusal must explain why, got %s", payload)
	}

	// Nothing was deleted.
	auths, err := app.FindAllExternalAuthsByRecord(mustRecord(t, app, fixPlayerID))
	if err != nil {
		t.Fatal(err)
	}
	if len(auths) != 1 {
		t.Fatalf("the linked provider must survive the refused unlink, found %d", len(auths))
	}

	// The same account may unlink once a password exists.
	//
	// The ORIGINAL seeded hash is copied back rather than a freshly generated
	// one, and never through SetPassword: that setter calls RefreshTokenKey(),
	// which invalidates the session token this test is still holding, so the
	// next request would fail as an anonymous caller instead of testing the
	// unlink. Reusing the seeded hash keeps both the password and the token.
	restorePassword(t, app, fixPlayerID, seededPasswordHash)

	status, payload, _ = categoryCall(t, http.MethodDelete,
		server.URL+"/api/aerun/me/auth/"+googleProviderName,
		`{"current_password":"`+testPassword+`"}`, tokens["player"], "test-idem-unlink-ok")
	if status != http.StatusOK {
		t.Fatalf("unlinking with a password set must succeed, got %d: %s", status, payload)
	}
	state = decodeAuthPayload(t, payload)
	if state["can_unlink_google"].(bool) {
		t.Fatal("can_unlink_google must be false once google is gone")
	}
	// `methods` decodes as []any, so it is read element-wise rather than
	// asserted to []string.
	methods, _ := state["methods"].([]any)
	if len(methods) != 1 || methods[0] != "password" {
		t.Fatalf("expected only the password method to remain, got %v", state["methods"])
	}
}

// TestChangePasswordRequiresOwnership proves a session token alone is not
// enough to take the account over, and that the happy path works.
func TestChangePasswordRequiresOwnership(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// A wrong current password is refused.
	status, payload, _ := categoryCall(t, http.MethodPut, server.URL+"/api/aerun/me/password",
		`{"current_password":"wrong","new_password":"BrandNewPass1!","new_password_confirm":"BrandNewPass1!"}`,
		tokens["player"], "test-idem-pw-wrong")
	if status != http.StatusForbidden {
		t.Fatalf("a wrong current password must be refused with 403, got %d: %s", status, payload)
	}
	// The stored password is untouched by the refused attempt.
	if !mustRecord(t, app, fixPlayerID).ValidatePassword(testPassword) {
		t.Fatal("the original password must survive a refused change")
	}

	// A correct one succeeds and takes effect.
	const next = "BrandNewPass1!"
	status, payload, _ = categoryCall(t, http.MethodPut, server.URL+"/api/aerun/me/password",
		`{"current_password":"`+testPassword+`","new_password":"`+next+`","new_password_confirm":"`+next+`"}`,
		tokens["player"], "test-idem-pw-ok")
	if status != http.StatusOK {
		t.Fatalf("expected 200 changing the password, got %d: %s", status, payload)
	}
	if !mustRecord(t, app, fixPlayerID).ValidatePassword(next) {
		t.Fatal("the new password must be the one that verifies")
	}
	if mustRecord(t, app, fixPlayerID).ValidatePassword(testPassword) {
		t.Fatal("the old password must no longer verify")
	}
}

// TestChangeEmailRules covers the validation and the conflict mapping.
func TestChangeEmailRules(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// A malformed address is a validation error, not a server fault.
	status, payload, _ := categoryCall(t, http.MethodPatch, server.URL+"/api/aerun/me/email",
		`{"email":"not-an-address","current_password":"`+testPassword+`"}`,
		tokens["player"], "test-idem-email-bad")
	if status != http.StatusBadRequest {
		t.Fatalf("a malformed email must be 400, got %d: %s", status, payload)
	}

	// Taking another member's address is a conflict.
	status, payload, _ = categoryCall(t, http.MethodPatch, server.URL+"/api/aerun/me/email",
		`{"email":"root@example.com","current_password":"`+testPassword+`"}`,
		tokens["player"], "test-idem-email-taken")
	if status != http.StatusConflict {
		t.Fatalf("an email already in use must be 409, got %d: %s", status, payload)
	}

	// Without the current password nothing changes.
	status, payload, _ = categoryCall(t, http.MethodPatch, server.URL+"/api/aerun/me/email",
		`{"email":"player-new@example.com"}`, tokens["player"], "test-idem-email-nopw")
	if status != http.StatusForbidden {
		t.Fatalf("changing the email without proof must be 403, got %d: %s", status, payload)
	}
	if mustRecord(t, app, fixPlayerID).Email() != "player@example.com" {
		t.Fatal("the refused email change must not have been applied")
	}

	// The happy path moves it and keeps the verified flag (mail is disabled, so
	// resetting it would strand the account unverified forever).
	status, payload, _ = categoryCall(t, http.MethodPatch, server.URL+"/api/aerun/me/email",
		`{"email":"Player-New@Example.com ","current_password":"`+testPassword+`"}`,
		tokens["player"], "test-idem-email-ok")
	if status != http.StatusOK {
		t.Fatalf("expected 200 changing the email, got %d: %s", status, payload)
	}
	record := mustRecord(t, app, fixPlayerID)
	if record.Email() != "player-new@example.com" {
		t.Fatalf("the email must be trimmed and lower-cased, got %q", record.Email())
	}
	if !record.Verified() {
		t.Fatal("the verified flag must survive an email change while mail is disabled")
	}
}

// TestAuthStateNeverLeaksTheHash pins the one thing this endpoint must not do.
func TestAuthStateNeverLeaksTheHash(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	status, payload, _ := categoryCall(t, http.MethodGet, server.URL+"/api/aerun/me/auth", "", tokens["player"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, payload)
	}
	hash := passwordHashOf(mustRecord(t, app, fixPlayerID))
	if hash == "" {
		t.Fatal("fixture precondition failed: the account must have a password hash")
	}
	if strings.Contains(string(payload), hash) || strings.Contains(string(payload), "$2a$") {
		t.Fatalf("the password hash must never appear in the response: %s", payload)
	}
	if !strings.Contains(string(payload), `"has_password":true`) {
		t.Fatalf("has_password must report the stored password as present: %s", payload)
	}
}

// TestAuthStateRequiresAuthentication keeps the endpoint off the guest path.
func TestAuthStateRequiresAuthentication(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	_ = seedIdentityFixtures(t, app)

	server := newTestServer(t, app)
	defer server.Close()

	status, payload, _ := categoryCall(t, http.MethodGet, server.URL+"/api/aerun/me/auth", "", "", "")
	if status == http.StatusOK {
		t.Fatalf("a guest must not read credential state, got 200: %s", payload)
	}
}
