package pocketbase

// Server-side record of recent identity-provider sign-ins.
//
// WHY THIS EXISTS. The chief-admin handover asks the operator to re-enter their
// password, and for a good part of this forum's population that field cannot be
// filled in by anybody:
//
//   - an account that has only ever signed in through Google is stored by
//     PocketBase with NO password at all, and
//   - an account imported from the legacy backend was given a GENERATED
//     password by the importer, and nobody was ever shown it (see
//     user_import.go / its tests).
//
// The handover is irreversible, so "you cannot confirm" is not a soft failure —
// the root role is simply stuck.
//
// WHY IT IS NOT "THE CLIENT SAYS SO". The obvious shortcut is to have the
// browser complete an OAuth sign-in and then send something proving it. That
// proof would have to be the new bearer token, and a bearer token is precisely
// what the whole confirmation exists to defeat: an attacker holding a stolen
// session token would satisfy it by definition. The check would be circular.
//
// So the evidence has to be something only THIS process can know, and that is
// what the PocketBase OAuth hook provides. It fires inside the provider round
// trip, after Google has returned an identity that matched an account here, and
// it is not reachable by replaying a stored token. What it yields is a
// timestamp — "this account completed a provider sign-in at T" — and
// reauthWindow decides whether T is recent enough.
//
// SCOPE AND LIMITS, stated rather than implied:
//
//   - Process-local, like the presence map. A restart forgets recent sign-ins,
//     which costs the operator one extra Google round trip and nothing else.
//   - Single-instance. Behind a load balancer the OAuth round trip and the
//     handover can land on different processes and the stamp will be missing;
//     the operator sees "sign in with Google again" and tries once more. A
//     shared store is the fix if this ever runs multi-instance.
//   - Entries are pruned on read, so the map is bounded by the accounts that
//     signed in within the window, not by every account that ever did.

import (
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

var (
	oauthSignInMu sync.Mutex
	// oauthSignIns maps an account id to when it last completed a provider
	// sign-in. Entries older than reauthWindow are pruned on access, so this
	// holds recent activity rather than history.
	oauthSignIns = make(map[string]time.Time)
)

// registerOAuthSignInHook records every successful identity-provider sign-in.
//
// It is bound from the OnServe hook in Run, alongside the cron registrations.
// The hook runs for both halves of PocketBase's OAuth flow — a brand new
// account and a returning one — and both are recorded: an operator who has
// never held a password signs in for the first time, which is precisely the
// case that needs this.
func registerOAuthSignInHook(app core.App) {
	app.OnRecordAuthWithOAuth2Request().BindFunc(func(e *core.RecordAuthWithOAuth2RequestEvent) error {
		if e.Record == nil {
			// A nil record here would mean the provider matched nothing, which
			// PocketBase reports as a failed authentication rather than a
			// success. There is no identity to stamp.
			return e.Next()
		}
		recordOAuthSignIn(e.Record.Id)
		return e.Next()
	})
}

// recordOAuthSignIn stamps an account as having signed in through a provider.
func recordOAuthSignIn(userID string) {
	now := time.Now()
	oauthSignInMu.Lock()
	defer oauthSignInMu.Unlock()
	oauthSignIns[userID] = now
}

// recentlySignedInWithOAuth reports whether this account completed a provider
// sign-in inside reauthWindow.
func recentlySignedInWithOAuth(userID string) bool {
	now := time.Now()
	oauthSignInMu.Lock()
	defer oauthSignInMu.Unlock()

	signedInAt, ok := oauthSignIns[userID]
	if !ok {
		return false
	}
	// Prune while the lock is held: a stale entry is never worth keeping, and
	// this is the only reader.
	if age := now.Sub(signedInAt); age > reauthWindow || age < 0 {
		delete(oauthSignIns, userID)
		return false
	}
	return true
}

// resetOAuthSignInsForTest clears the process-local map so tests do not leak
// state into one another.
func resetOAuthSignInsForTest() {
	oauthSignInMu.Lock()
	defer oauthSignInMu.Unlock()
	oauthSignIns = make(map[string]time.Time)
}
