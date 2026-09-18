package pocketbase

import (
	"regexp"
	"strings"
	"testing"
)

// requestIDAssertPattern mirrors the middleware pattern; keeping a local copy
// makes a broken production pattern show up as a failing test.
var requestIDAssertPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

func TestResolveRequestIDGeneratesForInvalidInput(t *testing.T) {
	cases := map[string]string{
		"empty":          "",
		"whitespace":     "   ",
		"forbidden char": "bad id!",
		"too long":       strings.Repeat("a", requestIDMaxLen+1),
		"control chars":  "id\r\ninjected",
	}
	for name, in := range cases {
		id := resolveRequestID(in)
		if !requestIDAssertPattern.MatchString(id) {
			t.Fatalf("%s: generated id %q must match the allowed pattern", name, id)
		}
		if len(id) != 16 {
			t.Fatalf("%s: generated id must be 16 chars, got %d", name, len(id))
		}
		if id == strings.TrimSpace(in) {
			t.Fatalf("%s: unsafe input %q must not be echoed", name, in)
		}
	}
}

func TestResolveRequestIDEchoesValidInput(t *testing.T) {
	valid := "frontend-42_1.2:corr"
	if got := resolveRequestID(valid); got != valid {
		t.Fatalf("valid incoming id must be echoed, got %q", got)
	}
}

func TestResolveRequestIDTrimsSurroundingSpace(t *testing.T) {
	in := " corr-1 "
	if got := resolveRequestID(in); got != "corr-1" {
		t.Fatalf("surrounding whitespace must be trimmed, got %q", got)
	}
}
