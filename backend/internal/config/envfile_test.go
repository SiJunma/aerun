package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDotEnv(t *testing.T) {
	input := "" +
		"# a comment\n" +
		"\n" +
		"PLAIN=1\n" +
		"SPACED = two words \n" +
		"QUOTED=\"double value\"\n" +
		"SINGLE='single value'\n" +
		"URL=https://example.com/callback?next=/a&x=1\n"

	got, err := parseDotEnv(strings.NewReader(input))
	if err != nil {
		t.Fatalf("valid dotenv must parse: %v", err)
	}
	want := map[string]string{
		"PLAIN":  "1",
		"SPACED": "two words",
		"QUOTED": "double value",
		"SINGLE": "single value",
		"URL":    "https://example.com/callback?next=/a&x=1",
	}
	for key, wantVal := range want {
		if got[key] != wantVal {
			t.Errorf("%s: want %q, got %q", key, wantVal, got[key])
		}
	}
	if len(got) != len(want) {
		t.Errorf("unexpected keys parsed: %v", got)
	}
}

func TestParseDotEnvRejectsMalformedLines(t *testing.T) {
	// A credential line that does not parse must fail startup loudly instead
	// of being skipped — otherwise the provider would silently stay disabled.
	for _, line := range []string{"JUST_A_WORD", "=no-key", "\"unclosed=1"} {
		if _, err := parseDotEnv(strings.NewReader(line)); err == nil {
			t.Errorf("%q: expected an error, got nil", line)
		}
	}
}

func TestSeedDotEnvFillsOnlyUnsetKeysAndStopsAtFirstFile(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, ".env.local")
	second := filepath.Join(dir, "second.env.local")
	if err := os.WriteFile(first, []byte("AERUN_GOOGLE_CLIENT_ID=file-id\nAERUN_GOOGLE_CLIENT_SECRET=file-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("AERUN_GOOGLE_CLIENT_SECRET=other-secret\nSECOND_ONLY=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	env := map[string]string{"AERUN_GOOGLE_CLIENT_ID": "process-id"}
	lookup := func(key string) (string, bool) {
		val, ok := env[key]
		return val, ok
	}
	set := func(key, val string) error {
		env[key] = val
		return nil
	}

	seeded, err := seedDotEnv([]string{first, second, filepath.Join(dir, "missing.env")}, lookup, set)
	if err != nil {
		t.Fatalf("seeding must succeed: %v", err)
	}
	if seeded != first {
		t.Fatalf("the first existing file must win, got %q", seeded)
	}
	if env["AERUN_GOOGLE_CLIENT_ID"] != "process-id" {
		t.Fatalf("an already set process variable must not be overwritten, got %q", env["AERUN_GOOGLE_CLIENT_ID"])
	}
	if env["AERUN_GOOGLE_CLIENT_SECRET"] != "file-secret" {
		t.Fatalf("unset keys must be seeded from the first file, got %q", env["AERUN_GOOGLE_CLIENT_SECRET"])
	}
	if _, ok := env["SECOND_ONLY"]; ok {
		t.Fatal("the second file must not be read once the first one exists")
	}
}

func TestSeedDotEnvWithoutAnyCandidate(t *testing.T) {
	seeded, err := seedDotEnv([]string{filepath.Join(t.TempDir(), "absent")}, func(string) (string, bool) {
		return "", false
	}, func(string, string) error { return nil })
	if err != nil {
		t.Fatalf("a missing file must not be an error: %v", err)
	}
	if seeded != "" {
		t.Fatalf("no file seeded, got %q", seeded)
	}
}
