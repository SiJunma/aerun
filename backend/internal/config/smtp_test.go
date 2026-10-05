package config

import "testing"

func TestLoadSMTPModeRequiresARelay(t *testing.T) {
	// "smtp" with nothing else is the misconfiguration that would otherwise
	// only surface as a permanently bounced verification link: the process would
	// happily report email as configured and PocketBase would refuse the
	// settings write (or accept a zero port) at runtime.
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"nothing at all", map[string]string{"AERUN_MAIL_MODE": "smtp"}},
		{"host but no port", map[string]string{
			"AERUN_MAIL_MODE": "smtp",
			"AERUN_SMTP_HOST": "smtp-relay.example.com",
			// AERUN_MAIL_SENDER_ADDRESS is missing too, so this case exercises
			// the port check first — the order matters only for the message.
		}},
		{"no sender address", map[string]string{
			"AERUN_MAIL_MODE": "smtp",
			"AERUN_SMTP_HOST": "smtp-relay.example.com",
			"AERUN_SMTP_PORT": "587",
		}},
		{"malformed sender address", map[string]string{
			"AERUN_MAIL_MODE":           "smtp",
			"AERUN_SMTP_HOST":           "smtp-relay.example.com",
			"AERUN_SMTP_PORT":           "587",
			"AERUN_MAIL_SENDER_ADDRESS": "not-an-address",
		}},
		{"non-numeric port", map[string]string{
			"AERUN_MAIL_MODE":           "smtp",
			"AERUN_SMTP_HOST":           "smtp-relay.example.com",
			"AERUN_SMTP_PORT":           "not-a-port",
			"AERUN_MAIL_SENDER_ADDRESS": "no-reply@aerun.example",
		}},
		{"port out of range", map[string]string{
			"AERUN_MAIL_MODE":           "smtp",
			"AERUN_SMTP_HOST":           "smtp-relay.example.com",
			"AERUN_SMTP_PORT":           "70000",
			"AERUN_MAIL_SENDER_ADDRESS": "no-reply@aerun.example",
		}},
		{"username without password", map[string]string{
			"AERUN_MAIL_MODE":           "smtp",
			"AERUN_SMTP_HOST":           "smtp-relay.example.com",
			"AERUN_SMTP_PORT":           "587",
			"AERUN_SMTP_USERNAME":       "postmaster",
			"AERUN_MAIL_SENDER_ADDRESS": "no-reply@aerun.example",
		}},
		{"unknown auth method", map[string]string{
			"AERUN_MAIL_MODE":           "smtp",
			"AERUN_SMTP_HOST":           "smtp-relay.example.com",
			"AERUN_SMTP_PORT":           "587",
			"AERUN_SMTP_AUTH_METHOD":    "CRAM-MD5",
			"AERUN_MAIL_SENDER_ADDRESS": "no-reply@aerun.example",
		}},
	}
	for _, tc := range cases {
		if _, err := Load(envGetter(tc.env)); err == nil {
			t.Errorf("%s: expected an error, got nil", tc.name)
		}
	}
}

func TestLoadSMTPModeAcceptsACompleteRelay(t *testing.T) {
	env := map[string]string{
		"AERUN_MAIL_MODE":           "smtp",
		"AERUN_SMTP_HOST":           "smtp-relay.example.com",
		"AERUN_SMTP_PORT":           "587",
		"AERUN_SMTP_USERNAME":       "postmaster",
		"AERUN_SMTP_PASSWORD":       "relay-secret",
		"AERUN_SMTP_TLS":            "true",
		"AERUN_MAIL_SENDER_ADDRESS": "no-reply@aerun.example",
		"AERUN_MAIL_SENDER_NAME":    "Aerun",
	}
	cfg, err := Load(envGetter(env))
	if err != nil {
		t.Fatalf("a complete relay must load: %v", err)
	}
	if cfg.SMTPHost != env["AERUN_SMTP_HOST"] || cfg.SMTPPort != 587 {
		t.Fatalf("relay endpoint not loaded: %s:%d", cfg.SMTPHost, cfg.SMTPPort)
	}
	if cfg.SMTPPassword != "relay-secret" {
		t.Fatal("the relay password must survive loading verbatim for the settings write")
	}
	if !cfg.SMTPTLS {
		t.Fatal("AERUN_SMTP_TLS=true must set TLS")
	}
	// PocketBase falls back to PLAIN internally for an empty field, so an unset
	// AERUN_SMTP_AUTH_METHOD must arrive as a value its validator accepts.
	if cfg.SMTPAuthMethod != "PLAIN" {
		t.Fatalf("expected the PLAIN default, got %q", cfg.SMTPAuthMethod)
	}
	if cfg.MailSenderAddress != "no-reply@aerun.example" || cfg.MailSenderName != "Aerun" {
		t.Fatalf("sender identity not loaded: %q / %q", cfg.MailSenderName, cfg.MailSenderAddress)
	}
}

func TestLoadDisabledModeIgnoresRelayValues(t *testing.T) {
	// Leftover relay variables must not silently turn mail on: the mode is the
	// single switch. This is what keeps a deployment that was rolled back to
	// "disabled" honest even though its unit file still carries the secrets.
	env := map[string]string{
		"AERUN_MAIL_MODE":           "disabled",
		"AERUN_SMTP_HOST":           "smtp-relay.example.com",
		"AERUN_SMTP_PORT":           "587",
		"AERUN_MAIL_SENDER_ADDRESS": "no-reply@aerun.example",
	}
	cfg, err := Load(envGetter(env))
	if err != nil {
		t.Fatalf("disabled mode must not require a relay: %v", err)
	}
	if cfg.MailMode != "disabled" {
		t.Fatalf("expected disabled, got %q", cfg.MailMode)
	}
}
