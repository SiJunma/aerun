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
// WHO OWNS THE RELAY CREDENTIALS. The PocketBase settings row does — the admin
// dashboard is the operator's surface, and env values only SEED the fields a
// first boot finds empty. Rotation therefore never touches code or env files:
// change the credentials in the dashboard (and in the relay provider), restart
// nothing. The reverse is also true — stale credentials in the environment
// cannot clobber what the dashboard holds.
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
const (
	MailModeSMTP     = "smtp"
	// MailModeDashboard leaves the Enabled flag and the relay credentials to
	// the PocketBase admin UI: the default install mode, where email works as
	// soon as the operator fills Settings > Mail settings — no env, no code.
	MailModeDashboard = "dashboard"
	// MailModeDisabled is the explicit hard-off. Only this mode binds the
	// MailHardDisableGuard and wipes the relay from pb_data.
	MailModeDisabled  = "disabled"
)

// configureSMTP reconciles PocketBase's SMTP settings and mail metadata with
// the deployment environment on every startup.
//
// It owns two different things in two different ways:
//
//   - The MODE is environmental: "disabled" always wins and wipes the relay
//     (no live relay password may linger in pb_data while mail is off), "smtp"
//     always turns the Enabled flag on.
//   - The relay credentials themselves are POCKETBASE state. The environment
//     only seeds fields the stored settings leave empty — a first boot, or the
//     wipe a disabled stretch performed. The admin dashboard is the operator's
//     surface for them afterwards, and its values survive every restart.
//
// Nothing here belongs in a migration: both the mode and a first relay seed are
// environment state, and a migration runs once — a relay supplied after the
// initial boot would otherwise be stranded in pb_data until the next schema
// change.
func configureSMTP(app core.App, cfg config.Config) error {
	settings := app.Settings()

	// AppName is the brand every auth template shows through {APP_NAME} at send
	// time, so it is read from forum_settings.forum_name — the row the admin
	// panel edits — rather than from any literal here. Renaming the forum
	// updates Meta on the next settings write (see updateGlobalSettingsHandler)
	// and the very next mail carries the new name, no restart involved.
	// The sender identity is seeded below, per mode: in smtp mode it follows the
	// same dashboard-is-truth rule as the relay credentials.
	settings.Meta.AppName = forumName(app, "en")
	settings.Meta.AppURL = cfg.PublicURL

	if cfg.MailMode == MailModeDisabled || cfg.MailMode == "" {
		settings.SMTP.Enabled = false
		settings.SMTP.Host = ""
		settings.SMTP.Port = 0
		settings.SMTP.Username = ""
		settings.SMTP.Password = ""
		// The .invalid sender is what keeps a disabled deployment undeliverable
		// even if something ever bypassed the MailHardDisableGuard.
		settings.Meta.SenderAddress = "no-reply@aerun.invalid"
		if settings.Meta.SenderName == "" {
			settings.Meta.SenderName = mailSenderName(cfg, settings.Meta.AppName)
		}
		if err := app.Save(settings); err != nil {
			return fmt.Errorf("save mail settings: %w", err)
		}
		app.Logger().Info("outgoing email is disabled",
			"mode", cfg.MailMode,
			"reason", "AERUN_MAIL_MODE is disabled; verification, reset and outbox mail are queued, not sent")
		return nil
	}

	// Dashboard mode: the operator turns email on in the PocketBase admin UI.
	// The environment does NOT touch the stored settings at all — not even as a
	// seed — because the whole point of the mode is that Settings > Mail
	// settings is the single owner of both the Enabled flag and the relay
	// credentials. A relay that is not configured yet simply fails at the
	// connection when a send is attempted, which the senders report; it is a
	// dashboard concern, never a boot error and never a veto from here.
	if cfg.MailMode == MailModeDashboard {
		app.Logger().Info("outgoing email is dashboard-managed",
			"mode", cfg.MailMode,
			"enabled", settings.SMTP.Enabled,
			"reason", "configure the relay in Settings > Mail settings; the environment never edits mail settings in this mode")
		return nil
	}

	settings.SMTP.Enabled = true
	seedRelayFromEnv(app, cfg, settings)

	// Only non-secret facts are logged, and they come from the EFFECTIVE
	// settings row rather than from the env, because env values may be stale
	// once the dashboard owns the credentials. The password never appears.
	app.Logger().Info("outgoing email enabled",
		"host", settings.SMTP.Host,
		"port", settings.SMTP.Port,
		"auth", settings.SMTP.AuthMethod,
		"tls", settings.SMTP.TLS,
		"username", settings.SMTP.Username,
		"sender", settings.Meta.SenderAddress)
	return nil
}

// seedRelayFromEnv fills ONLY the relay fields the stored settings leave
// unset — a first boot, or the wipe a disabled stretch performed — then saves.
// It is shared by the smtp and dashboard modes; the difference between them is
// who owns settings.SMTP.Enabled, decided by the callers.
//
// THE DASHBOARD IS THE SOURCE OF TRUTH, NOT THE ENVIRONMENT. Whatever the
// operator configured through the PocketBase admin UI survives every restart:
// credential rotation happens in the relay dashboard + this settings form,
// never in code or env files, and a redeploy can no longer silently roll it
// back. The env values are therefore a convenience for the very first boot
// only; once set, they are dead weight — and stale ones are harmless for
// exactly that reason.
//
// NOTE ON "EMPTY". A fresh PocketBase settings row is not empty: PB ships
// placeholder defaults (core/settings_model.go: SMTP.Host "smtp.example.com",
// Port 587). They are indistinguishable from an operator's choice by emptiness
// alone, so the PB-blessed placeholder host counts as unset too — nobody
// configures a real relay at smtp.example.com. Host and Port are seeded
// together for the same reason: 587 is PB's placeholder port, so port
// emptiness cannot be judged on its own.
func seedRelayFromEnv(app core.App, cfg config.Config, settings *core.Settings) error {
	hostUnset := settings.SMTP.Host == "" || settings.SMTP.Host == "smtp.example.com"
	if hostUnset {
		settings.SMTP.Host = cfg.SMTPHost
		settings.SMTP.Port = cfg.SMTPPort
	}
	if settings.SMTP.Username == "" {
		settings.SMTP.Username = cfg.SMTPUsername
	}
	if settings.SMTP.Password == "" {
		settings.SMTP.Password = cfg.SMTPPassword
	}
	if settings.SMTP.AuthMethod == "" {
		settings.SMTP.AuthMethod = strings.ToUpper(cfg.SMTPAuthMethod)
	}
	// TLS is a bool with no "unset" state, so it seeds one-way: the environment
	// may switch it ON, but never back off — the dashboard remains the only
	// place TLS can be disabled.
	if cfg.SMTPTLS {
		settings.SMTP.TLS = true
	}
	// LocalName is the EHLO/HELO name. Leaving it empty makes PocketBase send
	// "localhost", which several relays (Gmail among them) refuse outright; the
	// deployment's public host is the correct value in every real case.
	if settings.SMTP.LocalName == "" {
		settings.SMTP.LocalName = smtpLocalName(cfg)
	}
	// The From identity: the same dashboard-is-truth rule. A wrong SenderAddress
	// is the difference between a delivered mail and one rejected by SPF/DKIM,
	// so the operator fixes it where they fix everything else — the settings
	// form — and the environment only fills the gap of a first boot.
	// PocketBase's own defaults ("Support" / "support@example.com",
	// settings_model.go) count as unset here, for the same placeholder reason
	// as the SMTP host above.
	senderUnset := settings.Meta.SenderAddress == "" ||
		settings.Meta.SenderAddress == "no-reply@aerun.invalid" ||
		settings.Meta.SenderAddress == "support@example.com"
	if senderUnset {
		settings.Meta.SenderAddress = mailSenderAddress(cfg)
	}
	if settings.Meta.SenderName == "" || settings.Meta.SenderName == "Support" {
		settings.Meta.SenderName = mailSenderName(cfg, settings.Meta.AppName)
	}

	if err := app.Save(settings); err != nil {
		return fmt.Errorf("save mail settings: %w", err)
	}
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
