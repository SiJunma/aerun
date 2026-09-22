package auth

import "testing"

// TestIsReservedNickname pins the registration guard: role names, the forum
// identity and staff markers must never be owned by an interactive account,
// in any case or spacing variant that normalisation folds.
func TestIsReservedNickname(t *testing.T) {
	cases := []struct {
		nickname string
		reserved bool
	}{
		{"admin", true},
		{"  Admin ", true},
		{"ADMIN", true},
		{"root", true},
		{"Moderator", true},
		{"Aerun", true},
		{"chief admin", true},
		{"Chief  Admin", true}, // normalisation collapses inner whitespace
		{"Player", true},
		{"spectator", true},
		{"staff", true},
		{"", false},
		{"   ", false},
		{"administrator1", false},
		{"adminFan", false},
		{"root cause", false},
		{"Игрок", false},
		{"Aerun Player", false},
	}

	for _, tc := range cases {
		if got := IsReservedNickname(tc.nickname); got != tc.reserved {
			t.Errorf("IsReservedNickname(%q) = %v, want %v", tc.nickname, got, tc.reserved)
		}
	}
}
