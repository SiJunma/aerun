package pocketbase

// SMTP wiring (AERUN_MAIL_MODE).
//
// The state of this file before Sprint 8 is the thing worth recording: the
// process accepted AERUN_MAIL_MODE=smtp in config, and then did nothing with it.
// Run's OnBootstrap reset settings.SMTP.Enabled=false on every boot, the
// OnMailerSend guard returned 503 for every message, and the outbox cron skipped
// each tick on the same flag. Email was therefore unreachable by construction —
// not misconfigured, but architecturally switched off, and the only symptom a
// user would see is that no verification mail ever arrives.
//
// Both existing boundaries are now conditional on the mode rather than permanent:
//
//   - MailHardDisableGuard is bound only when the mode is "disabled". It stays
//     the second line of defence (a sendmail exec, a PocketBase auth alert and a
//     background job all still hit it) but it must not veto a deployment that
//     deliberately configured a relay.
//   - The OnBootstrap reset of SMTP.Enabled stays as the enforcement of the
//     disabled mode, so an operator who enables SMTP in the dashboard while the
//     mode is "disabled" still gets it switched back off.
//
// The reconcile lives in OnServe rather than in a migration for exactly the
// reason configureOAuth2 documents: credentials are environment state, and a
// migration runs once — a relay rotated after the first boot would otherwise be
// stranded in pb_data until the next schema change.

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// MailModeSMTP is the MailMode value that enables real delivery. Mirrors the
// config package's accepted values without importing a second constant.
const MailModeSMTP = "smtp"

// configureSMTP reconciles PocketBase's SMTP settings and mail metadata with
// the deployment environment on every startup.
//
// Everything it owns is environment state: the relay host/port/credentials, the
// TLS and AUTH choices, and the From identity. None of it belongs in a
// migration, and all of it would otherwise be reachable only through the admin
// dashboard — a second configuration surface that drifts from the environment
// and, on a VPS restart, from the systemd unit that actually defines the
// deployment.
//
// The disabled mode is handled here too rather than only in OnBootstrap: it
// clears the host and credentials as well as the flag, so switching a deployment
// from "smtp" to "disabled" does not leave a live relay password in pb_data.
func configureSMTP(app core.App, cfg config.Config) error {
	settings := app.Settings()

	// Sender identity first: verification, password reset and the outbox worker
	// all read Meta.SenderAddress, and a wrong value there is the difference
	// between a mail that is delivered and one rejected by SPF.
	//
	// AppName is the brand every auth template shows through {APP_NAME} at send
	// time, so it is read from forum_settings.forum_name — the row the admin
	// panel edits — rather than from any literal here. Renaming the forum
	// updates Meta on the next settings write (see updateGlobalSettingsHandler)
	// and the very next mail carries the new name, no restart involved.
	settings.Meta.AppName = forumName(app, "en")
	settings.Meta.AppURL = cfg.PublicURL
	settings.Meta.SenderName = mailSenderName(cfg, settings.Meta.AppName)
	settings.Meta.SenderAddress = mailSenderAddress(cfg)

	if cfg.MailMode != MailModeSMTP {
		settings.SMTP.Enabled = false
		settings.SMTP.Host = ""
		settings.SMTP.Port = 0
		settings.SMTP.Username = ""
		settings.SMTP.Password = ""
		if err := app.Save(settings); err != nil {
			return fmt.Errorf("save mail settings: %w", err)
		}
		app.Logger().Info("outgoing email is disabled",
			"mode", cfg.MailMode,
			"reason", "AERUN_MAIL_MODE is not smtp; verification, reset and outbox mail are queued, not sent")
		return nil
	}

	settings.SMTP.Enabled = true
	settings.SMTP.Host = cfg.SMTPHost
	settings.SMTP.Port = cfg.SMTPPort
	settings.SMTP.Username = cfg.SMTPUsername
	settings.SMTP.Password = cfg.SMTPPassword
	settings.SMTP.TLS = cfg.SMTPTLS
	settings.SMTP.AuthMethod = strings.ToUpper(cfg.SMTPAuthMethod)
	// LocalName is the EHLO/HELO name. Leaving it empty makes PocketBase send
	// "localhost", which several relays (Gmail among them) refuse outright; the
	// deployment's public host is the correct value in every real case.
	settings.SMTP.LocalName = smtpLocalName(cfg)

	if err := app.Save(settings); err != nil {
		return fmt.Errorf("save mail settings: %w", err)
	}

	// Only non-secret facts are logged. The password never appears: it exists in
	// the environment and in the settings row, and nowhere else.
	app.Logger().Info("outgoing email enabled",
		"host", cfg.SMTPHost,
		"port", cfg.SMTPPort,
		"auth", strings.ToUpper(cfg.SMTPAuthMethod),
		"tls", cfg.SMTPTLS,
		"username", cfg.SMTPUsername,
		"sender", mailSenderAddress(cfg))
	return nil
}

// mailSenderAddress returns the From address.
//
// The .invalid fallback (RFC 2606 reserved TLD) is deliberate and unchanged for
// the disabled mode: it is undeliverable by construction, so an accidental send
// that bypassed both boundaries fails loudly instead of reaching a real mailbox.
func mailSenderAddress(cfg config.Config) string {
	if cfg.MailSenderAddress != "" {
		return cfg.MailSenderAddress
	}
	return "no-reply@aerun.invalid"
}

// mailSenderName prefers the explicit AERUN_MAIL_SENDER_NAME and falls back to
// the forum's own name — never to a literal.
//
// The From header and the body of the mail are read by the same recipient in the
// same glance; a member seeing one brand as the sender and another in the
// signature has been handed two names for one letter. The fallback argument is
// settings.Meta.AppName, which configureSMTP derives from
// settings.forum_name, so an unset env var keeps the two in step automatically.
func mailSenderName(cfg config.Config, forum string) string {
	if cfg.MailSenderName != "" {
		return cfg.MailSenderName
	}
	if forum != "" {
		return forum
	}
	// Last resort only: no env override and an unreadable settings row. The
	// templates' own fallback chain ends the same way (forumName's "Forum").
	return "Forum"
}

// smtpLocalName derives the EHLO/HELO identity from the public URL, falling back
// to the relay host. PocketBase leaves it empty by default, which sends
// "localhost"; deriving it from the deployment's own public host removes one
// common class of relay rejection without adding another required variable.
func smtpLocalName(cfg config.Config) string {
	if host := hostFromURL(cfg.PublicURL); host != "" {
		return host
	}
	return cfg.SMTPHost
}

// hostFromURL extracts a bare hostname from an origin. config.Validate already
// proved AERUN_PUBLIC_URL is a scheme + host with no path, so this only strips
// the scheme and an optional port; the fallback path handles a value that was
// never validated rather than trusting it blindly.
func hostFromURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, "https://")
	trimmed = strings.TrimPrefix(trimmed, "http://")
	if idx := strings.IndexAny(trimmed, "/?#"); idx != -1 {
		trimmed = trimmed[:idx]
	}
	if idx := strings.LastIndex(trimmed, ":"); idx != -1 && !strings.Contains(trimmed[idx:], "]") {
		trimmed = trimmed[:idx]
	}
	return trimmed
}
