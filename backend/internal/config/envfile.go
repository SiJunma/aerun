package config

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

// dotenvCandidates are the local credential files probed at startup in order:
// the process working directory first, then its parent so a server started
// from backend/ finds the repository-root .env.local. The first existing file
// wins; a missing file is not an error (production ships none — gitignored).
var dotenvCandidates = []string{".env.local", "../.env.local"}

// SeedDotEnv stores the KEY=VALUE pairs of the first existing local dotenv
// file in the process environment, skipping keys that are already set — a real
// environment variable (systemd, CI, the shell) always wins. It returns the
// seeded file path ("" when no candidate exists) for startup logging; values
// themselves are never logged or otherwise exposed.
//
// This exists for local development convenience: the backend itself reads only
// the process environment, so without seeding a .env.local pair such as the
// Google OAuth credentials would never reach config.Load.
func SeedDotEnv() (string, error) {
	return seedDotEnv(dotenvCandidates, os.LookupEnv, os.Setenv)
}

// seedDotEnv implements SeedDotEnv against injected accessors so tests do not
// mutate the real process environment.
func seedDotEnv(candidates []string, lookup func(string) (string, bool), set func(string, string) error) (string, error) {
	for _, path := range candidates {
		file, err := os.Open(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", fmt.Errorf("open %s: %w", path, err)
		}
		values, parseErr := parseDotEnv(file)
		closeErr := file.Close()
		if parseErr != nil {
			return "", fmt.Errorf("%s: %w", path, parseErr)
		}
		if closeErr != nil {
			return "", fmt.Errorf("close %s: %w", path, closeErr)
		}
		for key, val := range values {
			if _, exists := lookup(key); exists {
				continue
			}
			if err := set(key, val); err != nil {
				return "", fmt.Errorf("set %s: %w", key, err)
			}
		}
		return path, nil
	}
	return "", nil
}

// validEnvKey mirrors what os.Setenv accepts: a letter or underscore followed
// by letters, digits and underscores. A quoted or empty key means the line was
// not written as KEY=VALUE, and importing it would create a variable the
// backend never reads.
func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
		case i > 0 && r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return true
}

// parseDotEnv reads simple KEY=VALUE lines: blank lines and # comments are
// ignored, the value may be wrapped in matching single or double quotes (no
// escape processing), and anything else fails the load loudly — a silently
// skipped credential line would surface much later as a missing provider.
func parseDotEnv(r io.Reader) (map[string]string, error) {
	values := make(map[string]string)
	scanner := bufio.NewScanner(r)
	for lineNo := 1; scanner.Scan(); lineNo++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: expected KEY=VALUE", lineNo)
		}
		key = strings.TrimSpace(key)
		if !validEnvKey(key) {
			return nil, fmt.Errorf("line %d: invalid key %q", lineNo, key)
		}
		val = strings.TrimSpace(val)
		if len(val) > 1 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
			val = val[1 : len(val)-1]
		}
		values[key] = val
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return values, nil
}
