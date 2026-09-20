package auth

import (
	"slices"
	"testing"
)

func TestNormalizeNicknameCanonicalisesVariants(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"already canonical", "aerun", "aerun"},
		{"mixed case", "Aerun", "aerun"},
		{"leading and trailing spaces", "  Aerun  ", "aerun"},
		{"inner whitespace runs collapse", "Aerun   Forum", "aerun forum"},
		{"tabs and newlines are whitespace", "Aerun\t\nForum", "aerun forum"},
		{"non-breaking space folds via NFKC", "Aerun\u00a0Forum", "aerun forum"},
		{"fullwidth latin folds via NFKC", "Ａｅｒｕｎ", "aerun"},
		{"ligature folds via NFKC", "Di\ufb01na", "difina"},
		{"canonical composition of combining marks", "cafe\u0301", "café"},
		{"cyrillic is lowercased too", "Аэрун", "аэрун"},
		{"empty stays empty", "", ""},
		{"whitespace only becomes empty", " \t\n ", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NormalizeNickname(tt.raw); got != tt.want {
				t.Fatalf("NormalizeNickname(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestNormalizeNicknameGroupsLookalikesUnderOneKey(t *testing.T) {
	// Every variant below must land on the same uniqueness key, otherwise the
	// UNIQUE index on users.nickname_normalized could be bypassed by spelling.
	groups := [][]string{
		{"Aerun", "aerun", " AERUN ", "Ａｅｒｕｎ"},
		{"Difina", "difina", "di\ufb01na", "DIFINA "},
		{"Аэрун", "аэрун", " АЭРУН\t"},
	}

	for _, variants := range groups {
		keys := make([]string, 0, len(variants))
		for _, variant := range variants {
			keys = append(keys, NormalizeNickname(variant))
		}
		slices.Sort(keys)
		if keys[0] != keys[len(keys)-1] {
			t.Fatalf("variants %q produced different keys %v", variants, keys)
		}
		if keys[0] == "" {
			t.Fatalf("variants %q must not normalise to the empty key", variants)
		}
	}
}

func TestNormalizeNicknameKeepsDistinctNamesDistinct(t *testing.T) {
	pairs := [][2]string{
		{"aerun", "aerun1"},
		{"aerun forum", "aerunforum"},
		{"аэрун", "aerun"},
	}

	for _, pair := range pairs {
		if NormalizeNickname(pair[0]) == NormalizeNickname(pair[1]) {
			t.Fatalf("NormalizeNickname collapsed distinct names %q and %q", pair[0], pair[1])
		}
	}
}

func TestNormalizeNicknameIsIdempotent(t *testing.T) {
	// Go strings are immutable values, so purity is guaranteed by the type;
	// what needs pinning is that a stored key never changes when re-normalised
	// (a second pass must be a no-op, otherwise the UNIQUE index could drift).
	samples := []string{
		"", "  ", "Aerun", "  Aerun   Forum ", "Ａｅｒｕｎ", "Аэрун", "cafe\u0301",
	}

	for _, sample := range samples {
		once := NormalizeNickname(sample)
		if twice := NormalizeNickname(once); twice != once {
			t.Fatalf("NormalizeNickname is not idempotent for %q: %q then %q", sample, once, twice)
		}
	}
}
