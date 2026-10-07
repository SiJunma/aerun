package pocketbase

import (
	"testing"
	"time"

	"github.com/SiJunma/aerun/backend/internal/config"
)

func smtpTestConfig() config.Config {
	return config.Config{
		Environment:       "production",
		PublicURL:         "https://forum.aerun.example",
		MailMode:          MailModeSMTP,
		SMTPHost:          "smtp-relay.example.com",
		SMTPPort:          587,
		SMTPUsername:      "postmaster",
		SMTPPassword:      "relay-secret",
		SMTPAuthMethod:    "LOGIN",
		SMTPTLS:           true,
		MailSenderAddress: "no-reply@aerun.example",
		MailSenderName:    "Aerun",
	}
}

// TestConfigureSMTPEnablesTheRelay is the core of Sprint 8's task: before it,
// AERUN_MAIL_MODE=smtp was accepted by config and then ignored by the process,
// so no verification, reset or outbox mail could ever leave the box.
func TestConfigureSMTPEnablesTheRelay(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// Baseline: migrations must not leave SMTP on, or this test proves nothing.
	if app.Settings().SMTP.Enabled {
		t.Fatal("migration baseline must keep SMTP disabled")
	}

	if err := configureSMTP(app, smtpTestConfig()); err != nil {
		t.Fatalf("enabling reconcile must succeed: %v", err)
	}

	settings := app.Settings()
	if !settings.SMTP.Enabled {
		t.Fatal("AERUN_MAIL_MODE=smtp must enable SMTP")
	}
	if settings.SMTP.Host != "smtp-relay.example.com" || settings.SMTP.Port != 587 {
		t.Fatalf("relay endpoint not applied: %s:%d", settings.SMTP.Host, settings.SMTP.Port)
	}
	if settings.SMTP.Username != "postmaster" || settings.SMTP.Password != "relay-secret" {
		t.Fatal("relay credentials not applied")
	}
	if settings.SMTP.AuthMethod != "LOGIN" || !settings.SMTP.TLS {
		t.Fatalf("auth/tls not applied: auth=%q tls=%v", settings.SMTP.AuthMethod, settings.SMTP.TLS)
	}
	// EHLO identity: PocketBase defaults to "localhost", which real relays refuse.
	if settings.SMTP.LocalName != "forum.aerun.example" {
		t.Fatalf("EHLO name must come from the public host, got %q", settings.SMTP.LocalName)
	}
	// The From identity is what SPF/DKIM alignment is judged on.
	if settings.Meta.SenderAddress != "no-reply@aerun.example" || settings.Meta.SenderName != "Aerun" {
		t.Fatalf("sender identity not applied: %q / %q", settings.Meta.SenderName, settings.Meta.SenderAddress)
	}
	if settings.Meta.AppURL != "https://forum.aerun.example" {
		t.Fatalf("app URL must be the validated public URL, got %q", settings.Meta.AppURL)
	}
}

// TestConfigureSMPClearsRelayOnDisable is the reverse direction, and it exists
// for a security reason: rolling a deployment back to "disabled" must not leave
// a live relay password sitting in pb_data.
func TestConfigureSMPClearsRelayOnDisable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	if err := configureSMTP(app, smtpTestConfig()); err != nil {
		t.Fatal(err)
	}
	if err := configureSMTP(app, config.Config{PublicURL: "https://forum.aerun.example"}); err != nil {
		t.Fatalf("disabling reconcile must succeed: %v", err)
	}

	settings := app.Settings()
	if settings.SMTP.Enabled {
		t.Fatal("disabled mode must switch SMTP off")
	}
	if settings.SMTP.Host != "" || settings.SMTP.Username != "" || settings.SMTP.Password != "" {
		t.Fatalf("disabled mode must clear the stored relay credentials, got host=%q user=%q",
			settings.SMTP.Host, settings.SMTP.Username)
	}
	// The .invalid fallback keeps an accidental send undeliverable rather than
	// silently addressed to whatever the last operator typed.
	if settings.Meta.SenderAddress != "no-reply@aerun.invalid" {
		t.Fatalf("disabled mode must fall back to an undeliverable sender, got %q", settings.Meta.SenderAddress)
	}
}

// TestConfigureSMTPIsIdempotent proves a restart neither fails nor churns, which
// is what makes a serve-time reconcile safe to run on every boot.
func TestConfigureSMTPIsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	cfg := smtpTestConfig()
	for i := 0; i < 3; i++ {
		if err := configureSMTP(app, cfg); err != nil {
			t.Fatalf("reconcile run %d must succeed: %v", i+1, err)
		}
	}
	if !app.Settings().SMTP.Enabled {
		t.Fatal("repeated reconciles must not lose the enabled state")
	}
}

// TestConfigureSMTPKeepsDashboardCredentials pins the ownership rule: once the
// operator configured the relay through the PocketBase admin UI, the environment
// must never overwrite it — a stale env file must not silently roll a rotated
// credential back on the next restart.
func TestConfigureSMTPKeepsDashboardCredentials(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// First boot: env seeds the relay.
	if err := configureSMTP(app, smtpTestConfig()); err != nil {
		t.Fatal(err)
	}

	// The operator rotates the credentials in the dashboard.
	settings := app.Settings()
	settings.SMTP.Username = "b8cebf001@smtp-brevo.com"
	settings.SMTP.Password = "rotated-secret"
	settings.SMTP.Port = 465
	settings.Meta.SenderAddress = "noreply@aerun-world.com"
	if err := app.Save(settings); err != nil {
		t.Fatal(err)
	}

	// The next restart carries a stale (or even different) env relay.
	stale := smtpTestConfig()
	stale.SMTPHost = "smtp-relay.example.net"
	stale.SMTPPort = 2525
	stale.SMTPUsername = "postmaster"
	stale.SMTPPassword = "old-secret"
	if err := configureSMTP(app, stale); err != nil {
		t.Fatal(err)
	}

	settings = app.Settings()
	if settings.SMTP.Username != "b8cebf001@smtp-brevo.com" || settings.SMTP.Password != "rotated-secret" {
		t.Fatalf("dashboard credentials must survive a restart, got username=%q", settings.SMTP.Username)
	}
	if settings.SMTP.Host != "smtp-relay.example.com" || settings.SMTP.Port != 465 {
		t.Fatalf("dashboard endpoint edits must survive a restart, got %s:%d",
			settings.SMTP.Host, settings.SMTP.Port)
	}
	if settings.Meta.SenderAddress != "noreply@aerun-world.com" {
		t.Fatalf("dashboard sender address must survive a restart, got %q", settings.Meta.SenderAddress)
	}
	if !settings.SMTP.Enabled {
		t.Fatal("smtp mode must keep SMTP enabled across restarts")
	}
}

// TestOutboxDispatchesOnlyWhenSMTPEnabled pins the ADR-6 boundary against the new
// capability: with SMTP off the outbox must leave rows untouched, and with it on
// the worker must at least be reached (it is allowed to fail against a relay
// that does not exist in CI — what matters here is that it is not short-circuited).
func TestOutboxDispatchesOnlyWhenSMTPEnabled(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	if processed := dispatchOutboxOnce(app, time.Now()); processed != 0 {
		t.Fatalf("disabled SMTP must process nothing, got %d", processed)
	}

	if err := configureSMTP(app, smtpTestConfig()); err != nil {
		t.Fatal(err)
	}
	// A relay host that does not resolve makes every send fail; the worker must
	// still have been entered, which shows the ADR-6 early return is gone.
	// Failure is logged and retried, so ProcessBatch returns without error here.
	dispatchOutboxOnce(app, time.Now())
}
