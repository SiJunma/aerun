package config

import (
	"fmt"
	"net"
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
	if value("AERUN_MAIL_MODE", "disabled", get) != "disabled" {
		return fmt.Errorf("AERUN_MAIL_MODE must be disabled until email delivery is implemented")
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
	}
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
