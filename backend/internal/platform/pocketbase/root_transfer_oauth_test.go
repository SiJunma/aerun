package pocketbase

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// The alternative confirmation for the root handover.
//
// "Re-enter your password" assumes the account HAS a password its owner knows.
// Two real populations on this forum do not:
//
//   - an account that has only ever signed in through Google, which PocketBase
//     stores with no password at all; and
//   - an account imported from the legacy backend, which the importer gave a
//     GENERATED password that was never shown to anybody.
//
// For both, the password field is a wall rather than a hurdle, and because the
// handover is irreversible there is no "cancel and ask someone else" — the root
// role would simply be stuck. These tests pin the alternative: a provider sign-in
// the SERVER observed.

// transferRootNoPassword posts /admin/transfer-root with an EMPTY password,
// which is what an operator who has no usable one sends.
func transferRootNoPassword(t testing.TB, serverURL, token, successorID, key string) (int, string) {
	t.Helper()

	body := fmt.Sprintf(`{"successor_id":%q,"confirm_phrase":%q}`, successorID, transferRootConfirmPhrase)
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/aerun/admin/transfer-root", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	buf := make([]byte, 4096)
	n, _ := res.Body.Read(buf)
	return res.StatusCode, string(buf[:n])
}

// TestTransferAcceptsAnObservedOAuthSignIn is the case that used to be
// impossible: the root proves themselves with a provider sign-in instead of a
// password they never knew.
func TestTransferAcceptsAnObservedOAuthSignIn(t *testing.T) {
	resetOAuthSignInsForTest()
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// What the PocketBase OAuth hook does after Google returns an identity.
	recordOAuthSignIn(fixRootID)

	status, payload := transferRootNoPassword(t, server.URL, tokens["root"], fixPlayerID, "xfer-oauth-ok")
	if status != http.StatusOK {
		t.Fatalf("a recent provider sign-in must transfer the role, got %d: %s", status, payload)
	}
	if role := roleOf(t, app, fixRootID); role != string(auth.RoleAdmin) {
		t.Fatalf("the giver must step down to admin, got %q", role)
	}
	if role := roleOf(t, app, fixPlayerID); role != string(auth.RoleRoot) {
		t.Fatalf("the successor must become root, got %q", role)
	}
}

// TestTransferRefusesWithoutAnyProof is the failure this whole change had to
// avoid: treating "no password supplied" as "nothing to check". Before, a
// missing password was caught by ValidatePassword failing; now the alternative
// exists, and this asserts it did not become a way in.
func TestTransferRefusesWithoutAnyProof(t *testing.T) {
	resetOAuthSignInsForTest()
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	status, payload := transferRootNoPassword(t, server.URL, tokens["root"], fixPlayerID, "xfer-no-proof")
	if status != http.StatusForbidden {
		t.Fatalf("a transfer with no proof must be refused, got %d: %s", status, payload)
	}
	if role := roleOf(t, app, fixRootID); role != string(auth.RoleRoot) {
		t.Fatalf("a refused transfer changed the root's role to %q", role)
	}
}

// TestTransferIgnoresAnotherAccountsRecentSignIn: the stamp is per account. A
// colleague signing in with Google must not let a stolen root token through.
func TestTransferIgnoresAnotherAccountsRecentSignIn(t *testing.T) {
	resetOAuthSignInsForTest()
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// Somebody ELSE proves themselves. The caller does not.
	recordOAuthSignIn(fixModeratorID)

	status, payload := transferRootNoPassword(t, server.URL, tokens["root"], fixPlayerID, "xfer-foreign-oauth")
	if status != http.StatusForbidden {
		t.Fatalf("another account's sign-in must not confirm this transfer, got %d: %s", status, payload)
	}
	if role := roleOf(t, app, fixRootID); role != string(auth.RoleRoot) {
		t.Fatalf("a refused transfer changed the root's role to %q", role)
	}
}

// TestTransferRejectsAStaleOAuthSignIn is the security property that keeps the
// alternative from decaying into "any session token ever". A sign-in from
// yesterday proves nothing about who is at the keyboard today.
func TestTransferRejectsAStaleOAuthSignIn(t *testing.T) {
	resetOAuthSignInsForTest()
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	oauthSignInMu.Lock()
	oauthSignIns[fixRootID] = time.Now().Add(-reauthWindow - time.Minute)
	oauthSignInMu.Unlock()

	status, payload := transferRootNoPassword(t, server.URL, tokens["root"], fixPlayerID, "xfer-stale-oauth")
	if status != http.StatusForbidden {
		t.Fatalf("a sign-in older than %s must be refused, got %d: %s", reauthWindow, status, payload)
	}
	if role := roleOf(t, app, fixRootID); role != string(auth.RoleRoot) {
		t.Fatalf("a refused transfer changed the root's role to %q", role)
	}
}
