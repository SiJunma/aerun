package pocketbase

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// MailHardDisableGuard is the Sprint 2 guardrail from
// BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md: while AERUN_MAIL_MODE=disabled
// (the only value config.Validate accepts today) no email may ever leave the
// process — not verification, not password resets, not OTP codes, not the
// PocketBase "login from a new device" auth alerts.
//
// It is bound on the app-level OnMailerSend hook, which every mail client
// passes through right before the real send (see BaseApp.NewMailClient in
// PocketBase v0.40.4). Returning an error here aborts the send before any
// SMTP connection or sendmail exec happens, and background senders only log
// the failure, so forum and auth requests keep succeeding.
//
// The guard will be lifted in Sprint 5 when the mail outbox worker arrives.
func MailHardDisableGuard() func(e *core.MailerEvent) error {
	return func(e *core.MailerEvent) error {
		return router.NewApiError(
			http.StatusServiceUnavailable,
			"email delivery is hard-disabled (AERUN_MAIL_MODE=disabled); no message was sent",
			nil,
		)
	}
}
