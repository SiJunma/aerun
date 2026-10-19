package pocketbase

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/mails"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// Sprint 2 command (plan §4 Sprint 2 task 2): POST /api/aerun/auth/register.
//
// The account is created in its safe state: verified=false (the legacy "pending"
// pseudo-role becomes an account status). Its `status` follows the admin's
// "require approval" switch — pending while staff approval is required, active
// when it is not — so a forum that turned the gate off does not trap new members
// behind /pending. Email verification stays a separate axis either way. The
// handler ALSO triggers the PocketBase verification mail (best-effort): when the
// mail stack is on (settings.SMTP.Enabled), the member receives the Aerun-branded
// verification template installed by configureAuthTemplates; when mail is off
// (disabled mode, or dashboard mode with no relay yet) the account still
// registers with 201 and the response reports mail_sent=false so the UI can be
// honest instead of claiming "a link was sent".
//
// The response never contains the email address, the password hash or the
// token key — the caller knows all public fields already, everything else
// stays server-side.
const (
	registerMaxBodyBytes = 64 * 1024
	minPasswordLen       = 8
	// bcrypt never hashes more than 72 input bytes; longer secrets are
	// truncated silently by bcrypt, so reject them up front.
	maxPasswordLen = 72
	maxNicknameLen = 64
)

var registerEmailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

type registerForm struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
	// Guest-side seeds for the fresh account. Whitelist-only: anything else
	// the client sends here is ignored, never stored.
	Theme    string `json:"theme"`
	Language string `json:"language"`
	// A note the newcomer leaves for the moderators ("who are you, where did
	// you hear about the forum"). It is never rendered on the public profile
	// (see 1766900000): it travels only inside the new_registration notice to
	// the staff. Whitelist-only like the seeds above.
	AdminMessage string `json:"admin_message"`
}

// seedSettingsFromRegistration builds the fresh account's initial settings
// from the guest-side values the registration form carries (what the forum
// shows right now). `language` is validated against the two locales the
// I18nProvider speaks; `theme` accepts any non-empty id up to 64 chars —
// it may be a builtin ('dark'/'light'/'neutral') or a custom design id the
// ThemeProvider renders via data-custom-design. An unknown id is harmless
// (no design matches, the base theme renders), so the only cap is length.
// An absent or invalid value simply leaves the key unset, exactly like the
// old `{}` seed, and the live ThemeProvider/I18nProvider fallbacks keep
// rendering.
func seedSettingsFromRegistration(form registerForm) map[string]any {
	seed := map[string]any{}
	theme := strings.TrimSpace(form.Theme)
	if theme != "" && len(theme) <= 64 {
		seed["theme"] = theme
	}
	language := strings.ToLower(strings.TrimSpace(form.Language))
	switch language {
	case "en", "ru":
		seed["language"] = language
	}
	return seed
}

// registerHandler creates a new forum account. Guests only: an
// already-authenticated caller must not mint a second identity silently.
func registerHandler(e *core.RequestEvent) error {
	if e.Auth != nil {
		return router.NewForbiddenError("you are already signed in; sign out before registering a new account", nil)
	}

	raw, err := readBodyLimited(e, registerMaxBodyBytes)
	if err != nil {
		return err
	}

	var form registerForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return e.BadRequestError("invalid JSON body", nil)
	}

	email := strings.ToLower(strings.TrimSpace(form.Email))
	nickname := strings.TrimSpace(form.Nickname)
	adminMessage := strings.TrimSpace(form.AdminMessage)
	// A note, not a novel: cap the moderator message so it cannot bloat the
	// notice payload. The client already hints at a short intro; the server
	// enforces the ceiling.
	if len([]rune(adminMessage)) > 2000 {
		return router.NewApiError(http.StatusBadRequest, "the message to the moderator is too long", nil)
	}
	if err := validateRegistration(email, form.Password, nickname); err != nil {
		return err
	}

	users, err := e.App.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return router.NewInternalServerError("users collection is unavailable", err)
	}

	// Pre-checks turn the common conflict cases into stable messages; the
	// UNIQUE indexes stay the real enforcement (see the Save error mapping
	// below) so a concurrent registration can never create a duplicate.
	if _, err := e.App.FindAuthRecordByEmail(users, email); err == nil {
		return router.NewApiError(http.StatusConflict, "an account with this email already exists", nil)
	}
	// A soft-deleted account's nickname is reusable: its nickname_normalized
	// was cleared to "" at deletion (the partial UNIQUE index only constrains
	// non-empty keys), and the belt-and-braces filter below ignores any row
	// that still reads as deleted.
	//
	// RecordQuery, not FindFirstRecordByFilter: the PocketBase filter language
	// has no IS NULL, so the string form cannot express "no flag yet" for a
	// row written before the is_deleted column existed.
	var nickConflict []*core.Record
	if err := e.App.RecordQuery(usersCollectionName).
		AndWhere(dbx.HashExp{"nickname_normalized": auth.NormalizeNickname(nickname)}).
		AndWhere(notDeletedUsersExpr()).
		Limit(1).
		All(&nickConflict); err != nil {
		return router.NewInternalServerError("nickname check failed", err)
	}
	if len(nickConflict) > 0 {
		return router.NewApiError(http.StatusConflict, "nickname is already taken", nil)
	}

	// The account's initial lifecycle state follows the admin's "require
	// approval" switch, so a forum that turned approval OFF does not bury every
	// new email/password member behind /pending. When approval is required the
	// account starts pending and waits for staff; when it is not, the account is
	// active from birth. Email verification is a SEPARATE axis (the `verified`
	// flag, still false here): an active member may still be unverified and be
	// nudged by the verification banner — approval and verification are
	// independent, which is exactly why the OAuth path (where the provider
	// vouches for the address) can skip the latter. See account_activation.go.
	status := initialAccountStatus(e.App)

	record := core.NewRecord(users)
	record.SetEmail(email)
	record.SetVerified(false)
	record.SetPassword(form.Password)
	record.Set("nickname", nickname)
	record.Set("nickname_normalized", auth.NormalizeNickname(nickname))
	record.Set("role", string(auth.RolePlayer))
	record.Set("status", string(status))
	record.Set("avatar_url", "")
	record.Set("settings", seedSettingsFromRegistration(form))
	// Registering is real activity, and it is the one moment we know for certain
	// that the account was here. Seeding last_seen from the server clock makes
	// the never-empty contract hold from the very first row: without this, an
	// account that registered and never returned would sit at the zero time
	// until its first heartbeat.
	record.Set(userLastSeenField, time.Now())
	// emailVisibility stays false (the PB default): the public profile rule
	// hides email until a future explicit command opts in.

	if err := e.App.Save(record); err != nil {
		message := err.Error()
		if strings.Contains(message, "UNIQUE constraint failed") {
			if strings.Contains(message, "nickname_normalized") {
				return router.NewApiError(http.StatusConflict, "nickname is already taken", nil)
			}
			return router.NewApiError(http.StatusConflict, "an account with this email already exists", nil)
		}
		return e.BadRequestError("registration failed", err)
	}

	// Tell the staff a newcomer arrived — the Firebase onUserCreated parity
	// (functions/index.js). Best-effort: the account already exists, so a
	// failed notice is logged and the 201 still goes out.
	notifyStaffOfRegistration(e.App, record, adminMessage)

	// Trigger the verification mail through PocketBase's own sender, so it
	// goes through the same stack as every other auth mail: the Aerun
	// template from configureAuthTemplates, the global wrapper from
	// registerAuthMailHooks, the SMTP relay from configureSMTP. Best-effort:
	// when mail is off (disabled mode, or dashboard mode with no relay yet)
	// the send fails and the account still registers — the response says so.
	mailEnabled := e.App.Settings().SMTP.Enabled
	mailSent := false
	mailError := ""
	if mailEnabled {
		if err := mails.SendRecordVerification(e.App, record); err != nil {
			mailError = err.Error()
			e.App.Logger().Warn("registration verification mail failed",
				"error", err, "userId", record.Id)
		} else {
			mailSent = true
		}
	} else {
		mailError = "email delivery is disabled on this server"
		e.App.Logger().Info("registration verification mail skipped",
			"reason", "SMTP is disabled; account created without a verification mail",
			"userId", record.Id)
	}

	return e.JSON(http.StatusCreated, map[string]any{
		"id":         record.Id,
		"nickname":   record.GetString("nickname"),
		"role":       string(auth.RolePlayer),
		"status":     string(status),
		"verified":   false,
		"mail_sent":  mailSent,
		"mail_error": mailError,
		"request_id": requestIDFrom(e),
	})
}

// registrationStaffPerms are the keys that make a role a "user manager" in
// the Firebase onUserCreated parity: anyone holding one of these reads the
// new_registration notice. Root is always included on top (see below).
var registrationStaffPerms = []string{
	string(auth.PermApproveUsers),
	string(auth.PermBanUsers),
	string(auth.PermDeleteUsers),
}

// notifyStaffOfRegistration fans a new_registration notice out to the staff.
// It mirrors the legacy onUserCreated trigger (functions/index.js): roles
// holding a user-management permission plus root, one notice per active
// member, payload {uid, nickname, email, admin_message}. The caller skips
// themselves (an admin registering while signed in is impossible today, but
// the guard costs nothing), and members who switched the notice off are
// skipped the way the reputation gate does it. Any single failure is logged
// and skipped — the account registration already succeeded before this ran.
func notifyStaffOfRegistration(app core.App, newcomer *core.Record, adminMessage string) {
	roleRows, err := app.FindAllRecords(rolesCollectionName, nil)
	if err != nil {
		app.Logger().Warn("new registration notices skipped: roles unavailable",
			"error", err, "userId", newcomer.Id)
		return
	}

	eligible := map[string]bool{string(auth.RoleRoot): true}
	for _, row := range roleRows {
		perms := row.GetStringSlice("permissions")
		for _, p := range perms {
			for _, want := range registrationStaffPerms {
				if p == want {
					eligible[row.GetString("role_id")] = true
					break
				}
			}
			if eligible[row.GetString("role_id")] {
				break
			}
		}
	}

	params := dbx.Params{}
	placeholders := make([]string, 0, len(eligible))
	i := 0
	for id := range eligible {
		// dbx binds named placeholders ({:role0}); the key is positional
		// only, the role id travels as the bound value, so no id text ever
		// enters the SQL string.
		key := "role" + string(rune('0'+i))
		placeholders = append(placeholders, "{:"+key+"}")
		params[key] = id
		i++
	}
	staff, err := app.FindAllRecords(usersCollectionName,
		dbx.NewExp("role IN ("+strings.Join(placeholders, ", ")+")", params))
	if err != nil {
		app.Logger().Warn("new registration notices skipped: staff lookup failed",
			"error", err, "userId", newcomer.Id)
		return
	}

	payload := map[string]any{
		"uid":           newcomer.Id,
		"nickname":      newcomer.GetString("nickname"),
		"email":         newcomer.Email(),
		"admin_message": nil,
	}
	if adminMessage != "" {
		payload["admin_message"] = adminMessage
	}

	_ = app.RunInTransaction(func(txApp core.App) error {
		for _, member := range staff {
			if member.Id == newcomer.Id {
				continue
			}
			if member.GetString("status") != string(auth.StatusActive) {
				continue
			}
			// A staffer who switched the notice off keeps the quiet they
			// asked for — same contract as the reputation_change gate.
			if wants, ok := newRegistrationWanted(member); ok && !wants {
				continue
			}
			if _, err := createNotification(txApp, member.Id, newcomer.Id,
				"new_registration", "New registration", payload); err != nil {
				txApp.Logger().Warn("new registration notice failed for one staffer; continuing",
					"error", err, "recipientId", member.Id, "userId", newcomer.Id)
				continue
			}
		}
		return nil
	})
}

// newRegistrationWanted reads the member's in-app switch for the
// new_registration notice. It returns (want, understood): understood is false
// when the settings carry nothing usable, and the caller treats that as
// "send". Only an explicit false suppresses the notice — the same default-on
// contract ProfilePage renders (`…in_app !== false`).
func newRegistrationWanted(member *core.Record) (bool, bool) {
	settings, err := decodeSettings(member)
	if err != nil {
		return true, false
	}
	notifications, ok := settings["notifications"].(map[string]any)
	if !ok {
		return true, false
	}
	entry, ok := notifications["new_registration"].(map[string]any)
	if !ok {
		return true, false
	}
	if inApp, ok := entry["in_app"].(bool); ok {
		return inApp, true
	}
	return true, false
}

// resendVerificationHandler re-sends the verification mail to the CALLER.
//
// WHY A SERVER ENDPOINT INSTEAD OF THE NATIVE ONE. PocketBase's own
// POST /api/collections/users/request-verification answers 204 even when the
// mail stack is off (the guard aborts the send AFTER the 204 is decided), so
// a UI built on it claims "a link was sent" while nothing left the server —
// the exact reported bug. This command checks settings.SMTP.Enabled FIRST and
// answers 503 with mail_sent=false when mail is off, 200 with mail_sent=true
// only after SendRecordVerification really succeeded. The address always comes
// from the caller's own auth record, never from a body field.
func resendVerificationHandler(e *core.RequestEvent) error {
	record, err := requireForumAccount(e)
	if err != nil {
		return err
	}
	if record.Verified() {
		return e.JSON(http.StatusOK, map[string]any{
			"mail_sent":  false,
			"verified":   true,
			"request_id": requestIDFrom(e),
		})
	}
	if !e.App.Settings().SMTP.Enabled {
		return e.JSON(http.StatusServiceUnavailable, map[string]any{
			"mail_sent":  false,
			"mail_error": "email delivery is disabled on this server — ask an administrator to enable mail or to confirm your address manually",
			"request_id": requestIDFrom(e),
		})
	}
	if err := mails.SendRecordVerification(e.App, record); err != nil {
		e.App.Logger().Warn("verification resend failed", "error", err, "userId", record.Id)
		return e.JSON(http.StatusBadGateway, map[string]any{
			"mail_sent":  false,
			"mail_error": err.Error(),
			"request_id": requestIDFrom(e),
		})
	}
	return e.JSON(http.StatusOK, map[string]any{
		"mail_sent":  true,
		"request_id": requestIDFrom(e),
	})
}

// validateRegistration applies the command-level input contract. Field
// validations repeat what PocketBase enforces on save, but with stable
// messages and before any database write happens.
func validateRegistration(email, password, nickname string) error {
	if email == "" {
		return e400("email is required")
	}
	if len(email) > 255 {
		return e400("email is too long")
	}
	if !registerEmailRe.MatchString(email) {
		return e400("email is not a valid address")
	}
	if len(password) < minPasswordLen {
		return e400("password must be at least 8 characters long")
	}
	if len(password) > maxPasswordLen {
		return e400("password must not exceed 72 characters")
	}
	if nickname == "" {
		return e400("nickname is required")
	}
	if len(nickname) > maxNicknameLen {
		return e400("nickname must not exceed 64 characters")
	}
	if auth.NormalizeNickname(nickname) == "" {
		return e400("nickname is required")
	}
	if auth.IsReservedNickname(nickname) {
		return e400("nickname is reserved")
	}
	return nil
}

func e400(message string) error {
	return router.NewApiError(http.StatusBadRequest, message, nil)
}

// readBodyLimited reads the request body with a hard size cap: oversized
// bodies are rejected with 413 before any parsing, so a caller cannot push
// unbounded payloads into the command layer.
func readBodyLimited(e *core.RequestEvent, limit int64) ([]byte, error) {
	if e.Request.ContentLength > limit {
		return nil, router.NewApiError(http.StatusRequestEntityTooLarge, "request body is too large", nil)
	}
	raw, err := io.ReadAll(http.MaxBytesReader(e.Response, e.Request.Body, limit+1))
	if err != nil {
		return nil, router.NewApiError(http.StatusRequestEntityTooLarge, "request body is too large or malformed", nil)
	}
	return raw, nil
}
