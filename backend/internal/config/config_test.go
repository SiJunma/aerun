package config

import "testing"

func TestLoadLocalDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("empty environment must boot in local mode: %v", err)
	}
	if cfg.Environment != "local" {
		t.Fatalf("expected local env, got %q", cfg.Environment)
	}
	if cfg.Listen != "127.0.0.1:8090" {
		t.Fatalf("unexpected default listen %q", cfg.Listen)
	}
	for _, origin := range cfg.Origins {
		if origin == "" || origin == "*" {
			t.Fatalf("wildcard origins must never survive loading: %q", origin)
		}
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"production without key", map[string]string{"AERUN_ENV": "production"}},
		{"non-loopback bind", map[string]string{"AERUN_LISTEN": "0.0.0.0:8090"}},
		{"wildcard origin", map[string]string{"AERUN_ALLOWED_ORIGINS": "*"}},
		{"non-origin value", map[string]string{"AERUN_ALLOWED_ORIGINS": "not-an-origin"}},
		{"short key", map[string]string{"AERUN_ENCRYPTION_KEY": "short"}},
		{"mail enabled", map[string]string{"AERUN_MAIL_MODE": "smtp"}},
	}
	for _, tc := range cases {
		if _, err := Load(envGetter(tc.env)); err == nil {
			t.Errorf("%s: expected error, got nil", tc.name)
		}
	}
}

func TestLoadProductionRequiresExplicitOriginsAndKey(t *testing.T) {
	env := map[string]string{
		"AERUN_ENV":              "production",
		"AERUN_ENCRYPTION_KEY":   "0123456789abcdef0123456789abcdef",
		"AERUN_DATA_DIR":         "/srv/aerun/pb_data",
		"AERUN_ALLOWED_ORIGINS":  "https://aerun.example.com",
		"AERUN_PUBLIC_URL":       "https://aerun.example.com",
		"AERUN_LISTEN":           "127.0.0.1:8090",
	}
	cfg, err := Load(envGetter(env))
	if err != nil {
		t.Fatalf("valid production config must load: %v", err)
	}
	if len(cfg.Origins) != 1 || cfg.Origins[0] != "https://aerun.example.com" {
		t.Fatalf("unexpected origins: %v", cfg.Origins)
	}
}

func envGetter(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}
