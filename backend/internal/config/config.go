package config

import (
	"fmt"
	"net"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
)

// Config contains deployment configuration only, never PocketBase types.
type Config struct {
	Environment string
	Listen      string
	DataDir     string
	PublicURL   string
	Origins     []string
	// EncryptionKeySet reports that a 32-byte AERUN_ENCRYPTION_KEY was provided.
	// The value itself never leaves config; Validate re-checks via the getter.
	EncryptionKeySet bool
	// MailMode defines email delivery mode: "dashboard" (default; the relay is
	// configured in the PocketBase admin UI and survives restarts), "smtp"
	// (relay forced from the environment, validated at startup) or "disabled"
	// (explicit no-SMTP hard off).
	MailMode string
	// SMTPHost, SMTPPort, SMTPUsername, SMTPPassword and SMTPAuthMethod are the
	// relay credentials. They are only read when MailMode is "smtp", and the
	// password is never logged or returned by any accessor — like the Google
	// secret it lives in the settings JSON inside pb_data (gitignored).
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	// SMTPAuthMethod is the SMTP AUTH mechanism: "PLAIN" (default) or "LOGIN".
	// A few relays — Gmail among them — reject PLAIN and require LOGIN.
	SMTPAuthMethod string
	// SMTPTLS requests a TLS connection to the relay. Almost every provider
	// needs it; disabling it sends credentials in the clear.
	SMTPTLS bool
	// MailSenderName and MailSenderAddress set the From header for every
	// outgoing message. The address must be one the relay is allowed to send
	// from, otherwise SPF/DKIM alignment fails and the mail is rejected.
	MailSenderName    string
	MailSenderAddress string
	// GoogleClientID and GoogleClientSecret configure the optional Google login
	// on the users collection (both or neither, enforced by Validate). The
	// values are never logged; once the provider is enabled they end up in the
	// collection JSON inside pb_data (gitignored).
	GoogleClientID     string
	GoogleClientSecret string
}

// Validate re-checks a Config (optionally against the raw environment) without
// opening files or a database. It is used by Load and re-checked by the
// platform adapter so a misconfigured process never opens a listener.
func Validate(cfg Config, get func(string) string) error {
	if get == nil {
		get = func(string) string { return "" }
	}
	if cfg.Environment != "local" && cfg.Environment != "production" {
		return fmt.Errorf("AERUN_ENV must be local or production")
	}
	// "dashboard" is the DEFAULT so a fresh install never requires code or env
	// edits: the forum boots, and the operator turns email on in the PocketBase
	// admin UI (Settings > Mail settings). The dashboard is the source of truth
	// for both the Enabled flag and the relay credentials in this mode.
	mailMode := value("AERUN_MAIL_MODE", "dashboard", get)
	if mailMode != "disabled" && mailMode != "smtp" && mailMode != "dashboard" {
		return fmt.Errorf("AERUN_MAIL_MODE must be \"disabled\", \"dashboard\" or \"smtp\"")
	}
	// With the mode switch alone, "smtp" would start a relay-less mailer: the
	// process would report email as configured while every send failed, and the
	// failure surfaces only as a bounced verification link. The relay identity is
	// therefore mandatory in this mode — a half-configured relay is a startup
	// error, not a degraded feature.
	if mailMode == "smtp" {
		if err := validateSMTP(cfg); err != nil {
			return err
		}
	}
	if (cfg.GoogleClientID == "") != (cfg.GoogleClientSecret == "") {
		return fmt.Errorf("AERUN_GOOGLE_CLIENT_ID and AERUN_GOOGLE_CLIENT_SECRET must be provided together")
	}
	host, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return fmt.Errorf("AERUN_LISTEN must bind a loopback IP; use a TLS reverse proxy on VPS")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("AERUN_LISTEN requires a port from 1 to 65535")
	}
	httpsOnly := cfg.Environment == "production"
	if !validOrigin(cfg.PublicURL, httpsOnly) {
		return fmt.Errorf("AERUN_PUBLIC_URL must be an HTTP(S) origin (HTTPS in production)")
	}
	if len(cfg.Origins) == 0 {
		return fmt.Errorf("AERUN_ALLOWED_ORIGINS requires at least one explicit origin")
	}
	for _, origin := range cfg.Origins {
		if !validOrigin(origin, httpsOnly) {
			return fmt.Errorf("AERUN_ALLOWED_ORIGINS requires explicit HTTP(S) origins; wildcards are forbidden")
		}
	}
	key := get("AERUN_ENCRYPTION_KEY")
	if key != "" && len(key) != 32 {
		return fmt.Errorf("AERUN_ENCRYPTION_KEY must contain exactly 32 bytes")
	}
	if cfg.Environment == "production" {
		if key == "" && !cfg.EncryptionKeySet {
			return fmt.Errorf("AERUN_ENCRYPTION_KEY is required in production")
		}
		// The absolute pb_data path is enforced at deploy time (Sprint 8 docs);
		// filepath.IsAbs is OS-dependent and cannot validate a Unix path from
		// a Windows build host.
	}
	return nil
}

// Load validates configuration without opening files, connecting to a database,
// or logging secret values. An injected lookup makes tests independent of secrets.
func Load(get func(string) string) (Config, error) {
	if get == nil {
		return Config{}, fmt.Errorf("configuration source is required")
	}
	value := func(key, fallback string) string {
		if v := strings.TrimSpace(get(key)); v != "" {
			return v
		}
		return fallback
	}
	cfg := Config{
		Environment: value("AERUN_ENV", "local"),
		Listen:      value("AERUN_LISTEN", "127.0.0.1:8090"),
		DataDir:     value("AERUN_DATA_DIR", "./pb_data"),
		PublicURL:   value("AERUN_PUBLIC_URL", "http://127.0.0.1:8090"),
		MailMode:    value("AERUN_MAIL_MODE", "dashboard"),
	}
	// SMTP relay settings. PLAIN is PocketBase's own default when the field is
	// empty (core.SMTPConfig.Validate documents the fallback), so an unset
	// AERUN_SMTP_AUTH_METHOD must still pass validateSMTP.
	cfg.SMTPHost = strings.TrimSpace(get("AERUN_SMTP_HOST"))
	cfg.SMTPAuthMethod = value("AERUN_SMTP_AUTH_METHOD", "PLAIN")
	cfg.MailSenderAddress = strings.TrimSpace(get("AERUN_MAIL_SENDER_ADDRESS"))
	cfg.MailSenderName = value("AERUN_MAIL_SENDER_NAME", "Aerun")
	if portRaw := strings.TrimSpace(get("AERUN_SMTP_PORT")); portRaw != "" {
		// A non-numeric port is a configuration error, not a default: silently
		// falling back would leave the process talking to port 0.
		p, convErr := strconv.Atoi(portRaw)
		if convErr != nil {
			return cfg, fmt.Errorf("AERUN_SMTP_PORT must be a number")
		}
		cfg.SMTPPort = p
	}
	if strings.EqualFold(strings.TrimSpace(get("AERUN_SMTP_TLS")), "true") {
		cfg.SMTPTLS = true
	}
	cfg.SMTPUsername = strings.TrimSpace(get("AERUN_SMTP_USERNAME"))
	cfg.SMTPPassword = get("AERUN_SMTP_PASSWORD")
	// Optional Google login credentials: an empty pair keeps the provider off
	// (password login unaffected); a half pair fails validation in Validate.
	cfg.GoogleClientID = strings.TrimSpace(get("AERUN_GOOGLE_CLIENT_ID"))
	cfg.GoogleClientSecret = strings.TrimSpace(get("AERUN_GOOGLE_CLIENT_SECRET"))
	if key := get("AERUN_ENCRYPTION_KEY"); key != "" {
		cfg.EncryptionKeySet = true
	}
	originsRaw := value("AERUN_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,"+cfg.PublicURL)
	for _, origin := range strings.Split(originsRaw, ",") {
		origin = strings.TrimSpace(origin)
		if !validOrigin(origin, cfg.Environment == "production") {
			return cfg, fmt.Errorf("AERUN_ALLOWED_ORIGINS requires explicit HTTP(S) origins; wildcards are forbidden")
		}
		cfg.Origins = append(cfg.Origins, origin)
	}
	if cfg.Environment == "production" && get("AERUN_ALLOWED_ORIGINS") == "" {
		return cfg, fmt.Errorf("AERUN_ALLOWED_ORIGINS is required in production")
	}
	if err := Validate(cfg, get); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// validateSMTP checks the relay configuration for MailMode="smtp".
//
// Every field here is one PocketBase itself refuses to accept as SMTP.Enabled
// (core.SMTPConfig.Validate) or one whose absence silently produces a broken
// message: an unset Host or a zero Port fails settings validation at save time,
// and a malformed sender address makes every message bounce. Checking them at
// startup turns a runtime misconfiguration into a refusal to boot.
func validateSMTP(cfg Config) error {
	if cfg.SMTPHost == "" {
		return fmt.Errorf("AERUN_SMTP_HOST is required when AERUN_MAIL_MODE=smtp")
	}
	if cfg.SMTPPort < 1 || cfg.SMTPPort > 65535 {
		return fmt.Errorf("AERUN_SMTP_PORT must be a port from 1 to 65535")
	}
	// A relay that needs no auth is unusual but legitimate (a local relay on the
	// same host, e.g. a smarthost on localhost), so only the half-pair is an
	// error — that is always a truncated secret rather than a deliberate choice.
	if (cfg.SMTPUsername == "") != (cfg.SMTPPassword == "") {
		return fmt.Errorf("AERUN_SMTP_USERNAME and AERUN_SMTP_PASSWORD must be provided together")
	}
	switch strings.ToUpper(cfg.SMTPAuthMethod) {
	case "PLAIN", "LOGIN":
	default:
		return fmt.Errorf("AERUN_SMTP_AUTH_METHOD must be \"PLAIN\" or \"LOGIN\"")
	}
	if cfg.MailSenderAddress == "" {
		return fmt.Errorf("AERUN_MAIL_SENDER_ADDRESS is required when AERUN_MAIL_MODE=smtp")
	}
	if _, err := mail.ParseAddress(cfg.MailSenderAddress); err != nil {
		return fmt.Errorf("AERUN_MAIL_SENDER_ADDRESS must be a valid email address")
	}
	return nil
}

func value(key, fallback string, get func(string) string) string {
	if v := strings.TrimSpace(get(key)); v != "" {
		return v
	}
	return fallback
}

func validOrigin(raw string, httpsOnly bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.Contains(raw, "*") {
		return false
	}
	return u.Scheme == "https" || (!httpsOnly && u.Scheme == "http")
}
