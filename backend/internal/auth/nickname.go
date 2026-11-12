package auth

import (
	"fmt"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// NormalizeNickname derives the uniqueness key for a nickname: Unicode NFKC
// normalisation, lowercasing and whitespace collapsing.
//
// It is applied by every writer of users.nickname_normalized (registration,
// profile commands, importer) so the UNIQUE index is stable regardless of how
// the display form is written. The display form itself is never modified.
func NormalizeNickname(nickname string) string {
	// NFKC folds presentation variants (fullwidth Latin, ligatures such as
	// "fi", non-breaking spaces) into their canonical forms; lowercasing
	// then makes the comparison case-insensitive for Latin and Cyrillic.
	folded := norm.NFKC.String(nickname)
	folded = strings.ToLower(folded)
	// strings.Fields splits on any Unicode whitespace and collapses runs,
	// so "  A\t B " and "a b" collide on purpose.
	return strings.Join(strings.Fields(folded), " ")
}

// ValidateNickname checks the DISPLAY form: length bounds and emptiness after
// trimming. It deliberately does not normalise — NormalizeNickname produces the
// storage key, this decides whether the human-readable form is acceptable.
//
// The 2..32 rune bounds are the legacy contract (src/pages/AdminPage.jsx and the
// registration form agree), and they are counted in RUNES, not bytes, so a
// nickname written in Cyrillic or CJK is not penalised for its encoding.
const (
	MinNicknameLen = 2
	MaxNicknameLen = 32
)

func ValidateNickname(nickname string) error {
	trimmed := strings.TrimSpace(nickname)
	if trimmed == "" {
		return fmt.Errorf("nickname must not be empty")
	}
	// SEC-07: nicknames reach a mail header (DM subject "New Direct Message
	// from {SENDER_NAME}"). A carriage return / line feed inside one would
	// inject a second header line, so it is refused here — strings.Fields
	// in NormalizeNickname would otherwise quietly collapse it away and
	// the display form would keep it.
	if strings.ContainsAny(trimmed, "\r\n") {
		return fmt.Errorf("nickname must not contain line breaks")
	}
	runes := []rune(trimmed)
	if len(runes) < MinNicknameLen || len(runes) > MaxNicknameLen {
		return fmt.Errorf("nickname must be %d..%d characters", MinNicknameLen, MaxNicknameLen)
	}
	// A nickname that folds to an empty uniqueness key would be unusable: the
	// partial UNIQUE index on nickname_normalized only constrains non-empty
	// values, so two accounts could both claim the same blank identity.
	if NormalizeNickname(trimmed) == "" {
		return fmt.Errorf("nickname must contain at least one letter or digit")
	}
	return nil
}
