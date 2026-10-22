package pocketbase

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// Automatic account activation when the "require approval" gate is OFF.
//
// WHY THIS EXISTS. Registration (register.go) and the PocketBase OAuth sign-up
// both create an account, but neither consulted the admin's "Требовать одобрения
// регистрации" switch — and nothing on the login path did either. The switch was
// read and mirrored to the browser (global_settings.go) but was NEVER wired to
// the account lifecycle: the only route out of "pending" was a staff member
// approving by hand (admin_users.go). So a forum that had turned approval OFF
// still trapped every new member behind /pending, and the reported account
// (Test2) sat there forever after confirming its email — the setting had no
// server-side effect at all.
//
// The switch means exactly what its help text says: "если выключено — они
// становятся активными сразу после входа". So the moment a still-pending forum
// account authenticates — by password, by OAuth (where the provider already
// vouched for the address), or on a token refresh — it is promoted to active.
// When approval is ON the hook is a deliberate no-op and staff keep full control.
//
// The activation is intentionally method-independent: it keys off the account
// status alone, never off how the account was created or whether the address was
// verified through our own mail flow. An OAuth sign-up is verified by the
// provider, so it must not be gated on a confirmation email we never send it.
//
// Bound from run.go alongside the other identity hooks. OnRecordAuthRequest is
// the single choke point every PocketBase auth flow funnels through
// (recordAuthResponse), so one hook covers password, OAuth2 and auth-refresh.
func registerAccountActivationHook(app core.App) {
	app.OnRecordAuthRequest().BindFunc(func(e *core.RecordAuthRequestEvent) error {
		if e.Record != nil && e.Record.Collection().Name == usersCollectionName && isUserDeleted(e.Record) {
			return router.NewForbiddenError("this account has been deleted", nil)
		}
		activateAccountIfApprovalDisabled(e.App, e.Record)
		return e.Next()
	})
}

// registerOAuth2RejectedDeletedHook makes the Google OAuth2 flow treat a
// soft-deleted account as if it never existed, so a fresh registration
// creates an absolute new record instead of resurrecting the deleted one.
//
// PocketBase's oauth2Submit, triggered from OnRecordAuthWithOAuth2Request,
// finds an existing record by email or by ExternalAuth provider+providerId.
// If that record is soft-deleted, oauth2Submit would rewrite it (re-set the
// email, re-link the provider) before OnRecordAuthRequest ever gets to refuse
// it — exactly the O9 symptom: the deleted account's email gets "added back"
// and the 403 arrives only after the damage.
//
// This hook runs first. When it sees a deleted record, it:
//   - drops the ExternalAuth row so the provider id can be reclaimed,
//   - clears the email so the address is free for reuse,
//   - sets e.Record = nil so oauth2Submit creates a brand-new record.
//
// Registration via OAuth2 then proceeds exactly like a first-time sign-up.
func registerOAuth2RejectedDeletedHook(app core.App) {
	app.OnRecordAuthWithOAuth2Request().BindFunc(func(e *core.RecordAuthWithOAuth2RequestEvent) error {
		if e.Record != nil && e.Record.Collection().Name == usersCollectionName && isUserDeleted(e.Record) {
			if err := e.App.DeleteAllExternalAuthsByRecord(e.Record); err != nil {
				return err
			}
			if e.Record.Email() != "" {
				e.Record.SetEmail("")
			}
			e.Record = nil
		}
		return e.Next()
	})
}

// activateAccountIfApprovalDisabled flips a still-pending forum account to
// active when the "require approval" gate is off. It is a no-op for guests,
// non-forum auth collections, already-active/banned accounts and — crucially —
// when approval is required, so an admin who wants manual review keeps it.
//
// A failed save is logged and swallowed rather than aborting the login: a
// member has already proven who they are, and refusing the sign-in over a
// status write would lock them out over our own bookkeeping. The next login (or
// refresh) retries the promotion.
func activateAccountIfApprovalDisabled(app core.App, record *core.Record) {
	if record == nil {
		return
	}
	if record.Collection().Name != usersCollectionName {
		return
	}
	// Only a pending account is eligible. An active account has nothing to do
	// (and must not be rewritten on every request); a banned account must never
	// be resurrected by a login.
	if record.GetString("status") != string(auth.StatusPending) {
		return
	}
	// Approval required: the staff gate stays, so this account waits.
	if loadForumSettings(app).RequireApproval {
		return
	}

	record.Set("status", string(auth.StatusActive))
	if err := app.Save(record); err != nil {
		app.Logger().Warn("account activation failed; the account stays pending until the next sign-in",
			"error", err, "userId", record.Id)
	}
}

// initialAccountStatus reports the status a brand-new email/password account
// should be created with: pending while staff approval is required, active the
// moment it is not. It is the creation-time counterpart of the sign-in hook
// above — the hook self-heals accounts that were created before the switch was
// turned off (and OAuth sign-ups), this one makes new registrations correct from
// the first row so they never sit pending in a forum that does not gate them.
func initialAccountStatus(app core.App) auth.Status {
	if loadForumSettings(app).RequireApproval {
		return auth.StatusPending
	}
	return auth.StatusActive
}
