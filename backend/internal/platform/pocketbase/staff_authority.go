package pocketbase

// staff_authority.go — the owner's authority matrix for a staff action
// aimed at ANOTHER account.
//
// The matrix is the owner's, restated from the role spec:
//
//	moderator → strictly lower only (a peer moderator is out)
//	admin     → admins and everyone below (equal rank is allowed)
//	root      → anyone
//
// It lives in ONE place because every command that answers "may this staff
// account act on that one?" — renaming, editing a profile, managing a mask —
// must answer it the same way. Two copies of the matrix are two rules, and the
// second one is the one that drifts.
//
// The PERMISSION is a separate question and is asked by the caller: a
// permission says WHICH action may be aimed at somebody else, and this says
// WHOM.

import (
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// staffRankMessages carries the three refusals of the authority matrix.
//
// Each caller words them for its own action ("change the nickname of",
// "manage the masks of") so the message names what was actually refused, while
// the MATRIX that decides it stays single-sourced.
type staffRankMessages struct {
	// targetAbove refuses an action aimed at a higher-ranked account.
	targetAbove string
	// notLower refuses an action aimed at a peer: strictly lower is required.
	notLower string
	// notStaff refuses an actor that holds no staff rank at all.
	notStaff string
}

// checkStaffRank applies the authority matrix to a staff action against
// another account.
//
// The target's ROLE decides the comparison, and it is read through rankFor —
// which resolves a custom role from the roles collection — so a custom role is
// ranked by the row it carries, not by a guess.
func checkStaffRank(txApp core.App, actor auth.Role, target auth.Role, msgs staffRankMessages) error {
	actorRank, targetRank := rankFor(txApp, actor), rankFor(txApp, target)
	switch actor {
	case auth.RoleRoot:
		return nil
	case auth.RoleAdmin:
		if targetRank > actorRank {
			return forbiddenError(msgs.targetAbove)
		}
		return nil
	case auth.RoleModerator:
		if targetRank >= actorRank {
			return forbiddenError(msgs.notLower)
		}
		return nil
	default:
		return forbiddenError(msgs.notStaff)
	}
}
