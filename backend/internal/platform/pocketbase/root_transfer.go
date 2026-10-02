package pocketbase

// Root administration TRANSFER (2026-10-02).
//
// Route:
//
//	POST /api/aerun/admin/transfer-root
//
// Why this is a separate command and not a role write: the owner was asked
// about letting an admin appoint further root admins, decided that was a bad
// idea, and asked for a deliberate one-way handover instead. checkRoleChange
// therefore refuses `{"role":"root"}` for EVERY caller, so this is the only
// way the root role ever changes hands.
//
// IT IS ONE-WAY, and that is the point. After the transfer the giver is an
// ordinary admin: they cannot take the role back through this command (they no
// longer hold root), nor through a role write (checkRoleChange), and nobody
// else can appoint a root. Recovering requires a root to run this command
// again — deliberately, with a fresh confirmation, to a named person. There is
// no undo, no "cancel", and no path where a demoted ex-root quietly regains
// the role.
//
// THE CONFIRMATION IS SERVER-SIDE, NOT COSMETIC. The request carries the
// caller's password, checked against the stored hash. A stolen session token is
// therefore not sufficient to hand the forum over: the attacker also needs the
// password. A client that only renders a scary modal has changed nothing about
// who can actually do this.
//
// The whole exchange — both role writes and the audit row — is one
// transaction, so a forum can never be observed with two roots or with none.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const transferRootBodyBytes = 8 * 1024

type transferRootForm struct {
	// SuccessorID is the account receiving the root role.
	SuccessorID string `json:"successor_id"`
	// Password is the CURRENT root's password, re-entered for confirmation.
	Password string `json:"password"`
	// ConfirmPhrase must equal the constant below, so a client that never
	// asked the operator to type anything cannot drive this. It is a second
	// factor on intent, not a security boundary — the password is that — but
	// it makes an accidental POST impossible.
	ConfirmPhrase string `json:"confirm_phrase"`
}

// transferRootConfirmPhrase is the literal the operator must send.
const transferRootConfirmPhrase = "TRANSFER ROOT"

// transferRootAfterRole is what the giver becomes. Admin, not player: the
// outgoing root keeps every staff power except the ability to hand the role on,
// which would otherwise let a transfer be silently undone from the other side.
const transferRootAfterRole = auth.RoleAdmin

func transferRootHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	acc := AccessFrom(e)

	// Only the CURRENT root may transfer. Not "anyone with admin_access": the
	// point of the procedure is that handing over the forum is a distinct,
	// harder-to-fake act than ordinary administration.
	if acc.Role != auth.RoleRoot {
		return forbiddenError("only the chief admin may transfer this role")
	}

	raw, err := readBodyLimited(e, transferRootBodyBytes)
	if err != nil {
		return err
	}
	var form transferRootForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	form.SuccessorID = strings.TrimSpace(form.SuccessorID)
	if form.SuccessorID == "" {
		return validationError("successor_id is required")
	}
	if form.ConfirmPhrase != transferRootConfirmPhrase {
		return validationError("this action must be confirmed with the phrase " + transferRootConfirmPhrase)
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		giver, err := txApp.FindRecordById(usersCollectionName, e.Auth.Id)
		if err != nil || giver == nil {
			return 0, nil, notFoundError("current account not found")
		}
		// Re-read the role INSIDE the transaction. The middleware resolved the
		// role before the command opened, so a transfer racing another would
		// otherwise let a caller who has just been demoted finish the handover
		// as though they still held it.
		if giver.GetString("role") != string(auth.RoleRoot) {
			return 0, nil, forbiddenError("only the chief admin may transfer this role")
		}
		if !giver.ValidatePassword(form.Password) {
			// Deliberately vague: this endpoint should not confirm anything
			// about the account to a caller who failed the password.
			return 0, nil, forbiddenError("re-enter your password to confirm the transfer")
		}
		if form.SuccessorID == giver.Id {
			return 0, nil, validationError("the successor must be a different account")
		}

		successor, err := txApp.FindRecordById(usersCollectionName, form.SuccessorID)
		if err != nil || successor == nil {
			return 0, nil, notFoundError("successor account not found")
		}
		// A suspended or unapproved account is not a valid chief admin: the
		// forum would have an owner who cannot sign in to use it. The mirror
		// case for the giver is refused too — it means the forum has no chief
		// admin at all, which the operator must be told about rather than
		// discovering later.
		if successor.GetString("status") != string(auth.StatusActive) {
			return 0, nil, conflictError("the successor's account is not active")
		}
		if giver.GetString("status") != string(auth.StatusActive) {
			return 0, nil, conflictError("your own account must be active to transfer the role")
		}

		oldNickname := giver.GetString("nickname")
		newNickname := successor.GetString("nickname")

		successor.Set("role", string(auth.RoleRoot))
		if err := txApp.Save(successor); err != nil {
			return 0, nil, internalError("failed to grant the root role", err)
		}

		giver.Set("role", string(transferRootAfterRole))
		if err := txApp.Save(giver); err != nil {
			return 0, nil, internalError("failed to step down from the root role", err)
		}

		// The one record of who held the forum before, and when. A transfer is
		// irreversible in the product, so the ledger is the only place the
		// succession is recorded at all.
		if err := recordAuditLog(txApp, "root_transfer", giver.Id, map[string]any{
			"from_id":         giver.Id,
			"from_nickname":   oldNickname,
			"to_id":           successor.Id,
			"to_nickname":     newNickname,
			"from_role_after": string(transferRootAfterRole),
			"reversible":      false,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"transferred":       true,
			"reversible":        false,
			"new_root_id":       successor.Id,
			"new_root_nickname": newNickname,
			"your_new_role":     string(transferRootAfterRole),
			"request_id":        requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}
