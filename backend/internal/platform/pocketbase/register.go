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
	_, err = e.App.FindFirstRecordByFilter(
		users,
		"nickname_normalized = {:nickname}",
		dbx.Params{"nickname": auth.NormalizeNickname(nickname)},
	)
	if err == nil {
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
