package pocketbase

// root_transfer_test.go pins the one-way handover of the root role.
//
// The property that matters is IRREVERSIBILITY, and it is asserted by trying
// to get the role back, not by reading the handler: the owner asked for
// something that feels final and cannot be taken back. So after a successful
// transfer this file attempts recovery by the outgoing root, and each attempt
// must fail.
//
// It also pins the two guards that make the ceremony mean anything: a wrong
// password and a missing confirmation phrase must both refuse BEFORE anything
// is written, so a failed confirmation leaves the forum exactly as it was.

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// transferRoot posts to /admin/transfer-root as `token`.
func transferRoot(t *testing.T, serverURL, token, successorID, password, phrase, key string) int {
	t.Helper()
	body := fmt.Sprintf(
		`{"successor_id":%q,"password":%q,"confirm_phrase":%q}`,
		successorID, password, phrase,
	)
	req, _ := http.NewRequest(http.MethodPost, serverURL+"/api/aerun/admin/transfer-root", strings.NewReader(body))
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode
}

func TestRootTransferIsOneWay(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// 1. A wrong password must refuse, and change nothing.
	if got := transferRoot(t, server.URL, tokens["root"], fixPlayerID, "WrongPassword1", transferRootConfirmPhrase, "xfer-wrong-pass"); got != http.StatusForbidden {
		t.Fatalf("wrong password = %d, want 403", got)
	}
	if role := roleOf(t, app, fixRootID); role != string(auth.RoleRoot) {
		t.Fatalf("a refused transfer changed the root's role to %q", role)
	}

	// 2. A missing confirmation phrase must refuse too. 400, because
	//    validationError in this codebase is a 400 — asserted against the real
	//    status rather than the 422 one might assume.
	if got := transferRoot(t, server.URL, tokens["root"], fixPlayerID, testPassword, "", "xfer-no-phrase"); got != http.StatusBadRequest {
		t.Fatalf("missing phrase = %d, want 400", got)
	}
	if role := roleOf(t, app, fixRootID); role != string(auth.RoleRoot) {
		t.Fatalf("a refused transfer changed the root's role to %q", role)
	}

	// 3. The real thing.
	if got := transferRoot(t, server.URL, tokens["root"], fixPlayerID, testPassword, transferRootConfirmPhrase, "xfer-real"); got != http.StatusOK {
		t.Fatalf("transfer = %d, want 200", got)
	}
	if role := roleOf(t, app, fixPlayerID); role != string(auth.RoleRoot) {
		t.Fatalf("successor role = %q, want root", role)
	}
	if role := roleOf(t, app, fixRootID); role != string(transferRootAfterRole) {
		t.Fatalf("giver role = %q, want %q", role, transferRootAfterRole)
	}

	// 4. ONE-WAY: the outgoing root cannot take it back, by either route that
	//    could have undone it.
	if got := transferRoot(t, server.URL, tokens["root"], fixRootID, testPassword, transferRootConfirmPhrase, "xfer-again"); got != http.StatusForbidden {
		t.Errorf("outgoing root re-transferring = %d, want 403", got)
	}
	if got := setRole(t, server.URL, tokens["root"], fixRootID, string(auth.RoleRoot), "xfer-rolewrite"); got != http.StatusForbidden {
		t.Errorf("outgoing root writing the root role = %d, want 403", got)
	}
	if role := roleOf(t, app, fixRootID); role != string(transferRootAfterRole) {
		t.Errorf("the outgoing root recovered the role: now %q", role)
	}

	// 5. The new root can transfer onward — the role is not frozen, only
	//    handed over deliberately each time.
	if got := transferRoot(t, server.URL, tokens["player"], fixModeratorID, testPassword, transferRootConfirmPhrase, "xfer-onward"); got != http.StatusOK {
		t.Errorf("new root transferring onward = %d, want 200", got)
	}
	if role := roleOf(t, app, fixModeratorID); role != string(auth.RoleRoot) {
		t.Errorf("onward successor role = %q, want root", role)
	}
}

// TestRootTransferRefusesInactiveSuccessor: handing the forum to an account
// that cannot sign in would leave it ownerless in practice.
func TestRootTransferRefusesInactiveSuccessor(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	if got := transferRoot(t, server.URL, tokens["root"], fixBannedID, testPassword, transferRootConfirmPhrase, "xfer-banned"); got != http.StatusConflict {
		t.Fatalf("banned successor = %d, want 409", got)
	}
	if role := roleOf(t, app, fixRootID); role != string(auth.RoleRoot) {
		t.Fatalf("a refused transfer changed the root's role to %q", role)
	}
}

// TestRootTransferIsAudited: a succession that cannot be undone leaves the
// ledger as the only record that it happened.
func TestRootTransferIsAudited(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	if got := transferRoot(t, server.URL, tokens["root"], fixPlayerID, testPassword, transferRootConfirmPhrase, "xfer-audit"); got != http.StatusOK {
		t.Fatalf("transfer = %d, want 200", got)
	}

	for _, entry := range auditLogsFor(t, app, "root_transfer") {
		details, _ := entry["details"].(map[string]any)
		if details == nil {
			continue
		}
		if to, _ := details["to_id"].(string); to == fixPlayerID {
			if from, _ := details["from_id"].(string); from != fixRootID {
				t.Errorf("audit recorded from_id=%q, want %q", from, fixRootID)
			}
			return
		}
	}

	t.Error("a root transfer must be audited naming both accounts")
}

// roleOf reads an account's current role straight from the database, so these
// assertions do not depend on any API echoing the state back.
func roleOf(t *testing.T, app core.App, id string) string {
	t.Helper()
	record, err := app.FindRecordById(usersCollectionName, id)
	if err != nil || record == nil {
		t.Fatalf("account %s missing: %v", id, err)
	}
	return record.GetString("role")
}
