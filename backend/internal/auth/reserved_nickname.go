package auth

import "slices"

// reservedNicknames are the display-name keys no interactive account may own:
// the role names themselves plus the forum identity and staff markers. The
// comparison runs on the normalised nickname, so "Admin", "  ADMIN " and
// "a d m i n" variants without whitespace collapse all resolve to "admin"
// and are rejected before a user row can ever be created.
var reservedNicknames = []string{
	"aerun",
	"admin",
	"administrator",
	"chief admin",
	"guest",
	"mod",
	"moderator",
	"official",
	"player",
	"root",
	"spectator",
	"staff",
	"support",
	"system",
}

// IsReservedNickname reports whether the nickname collides with a reserved
// display name after normalisation. Registration and every future nickname
// change command must refuse such nicknames so impersonating staff or the
// forum identity through a display name is impossible.
func IsReservedNickname(nickname string) bool {
	normalized := NormalizeNickname(nickname)
	if normalized == "" {
		return false
	}
	return slices.Contains(reservedNicknames, normalized)
}
