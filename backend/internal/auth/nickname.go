package auth

import (
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
