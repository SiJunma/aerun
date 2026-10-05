package pocketbase

// Sign-in credentials and linked identity providers.
//
// Routes:
//
//	GET    /api/aerun/me/auth
//	PUT    /api/aerun/me/password
//	PATCH  /api/aerun/me/email
//	DELETE /api/aerun/me/auth/{provider}
//
// WHY THIS EXISTS. The legacy "Security" tab hardcoded its own state:
//
//	const hasGoogle = false;
//	const hasPassword = true;
//
// so it told every member their Google account was unlinked and their password
// was linked, and the "add password" form below it called
// pb.collection('users').update(...). Against this backend that write can never
// succeed: migration 1766000000 sets users.UpdateRule = nil, so every profile
// change is a server command by design. The tab was a display of two
// constants over a form with no working save path.
//
// THE RULE THAT MATTERS HERE. An account may not be left with no way to sign
// in. Every mutation below refuses to remove the LAST remaining method, so
// "unlink Google" on a Google-only account is a 409 rather than a locked-out
// member with no recovery path.
//
// OWNERSHIP IS PROVEN SERVER-SIDE. Changing a password, changing the login email
// and unlinking a provider all take the caller's current password, or a
// provider sign-in completed moments ago (oauth_signin_recent.go) — the same
// two proofs confirmTransferIdentity accepts, for the same reason: a session
// token alone must never be enough to re-point someone's credentials, and an
// attacker holding one would satisfy any client-asserted proof by definition.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

const (
	credentialsBodyBytes = 8 * 1024
	// googleProviderName is the only identity provider this deployment
	// configures (see oauth2.go). Named here so the unlink route can refuse a
	// provider it has never heard of instead of silently matching nothing.
	googleProviderName = "google"
)

// linkedProvider is one entry of the account's identity-provider list.
type linkedProvider struct {
	Provider string `json:"provider"`
	LinkedAt string `json:"linked_at"`
}

// credentialsPayload is the /me/auth response. `can_unlink_google` is computed
// on the server rather than left to the client so the guard is one rule: the UI
// reflects it, and so would any other caller.
func credentialsPayload(e *core.RequestEvent, record *core.Record, hasPassword bool, providers []linkedProvider) map[string]any {
	users, err := e.App.FindCollectionByNameOrId(usersCollectionName)
	googleEnabled := err == nil && users.OAuth2.Enabled && oauthProviderConfigured(users, googleProviderName)

	methods := make([]string, 0, len(providers)+1)
	if hasPassword {
		methods = append(methods, "password")
	}
	for _, p := range providers {
		methods = append(methods, p.Provider)
	}

	// googleLinked is separate from googleEnabled: the provider being CONFIGURED
	// says nothing about whether THIS account has linked it. Reporting
	// can_unlink_google off the enabled flag alone offered an "unlink" action on
	// an account that never linked Google in the first place.
	googleLinked := false
	for _, p := range providers {
		if p.Provider == googleProviderName {
			googleLinked = true
			break
		}
	}

	return map[string]any{
		"email":            record.Email(),
		"email_verified":   record.Verified(),
		"has_password":     hasPassword,
		"google_enabled":   googleEnabled,
		"google_linked":    googleLinked,
		"linked_providers": providers,
		"methods":          methods,
		// Unlinkable only when google is actually linked AND something else
		// would survive the removal.
		"can_unlink_google":   googleLinked && countMethods(hasPassword, providers, googleProviderName) > 0,
		"min_password_length": minPasswordLen,
		"request_id":          requestIDFrom(e),
	}
}

// oauthProviderConfigured reports whether the users collection really offers the
// named provider. The link button must not be offered for a provider the
// deployment has not enabled — a member who presses it gets a provider list
// that does not contain it.
func oauthProviderConfigured(users *core.Collection, name string) bool {
	for _, p := range users.OAuth2.Providers {
		if p.Name == name {
			return true
		}
	}
	return false
}

// accountHasPassword reports whether the record has a usable stored password.
//
// It MUST go through GetRaw: PocketBase stores the hash as a typed
// *PasswordFieldValue, so the obvious `GetString("password")` returns "" for
// EVERY record — including one that has a password. Reading it that way made
// this endpoint claim no account had a password, which in turn made
// can_unlink_google true for a password-only account and would have let the
// unlink guard pass on the one account it exists to protect.
func accountHasPassword(record *core.Record) bool {
	pv, ok := record.GetRaw(core.FieldNamePassword).(*core.PasswordFieldValue)
	return ok && pv.Hash != ""
}

// accountAuthState reads the two facts every handler here needs: whether the
// record has a usable password, and which providers are linked to it.
func accountAuthState(app core.App, record *core.Record) (bool, []linkedProvider, error) {
	auths, err := app.FindAllExternalAuthsByRecord(record)
	if err != nil {
		return false, nil, internalError("failed to read the linked providers", err)
	}
	providers := make([]linkedProvider, 0, len(auths))
	for _, a := range auths {
		providers = append(providers, linkedProvider{
			Provider: a.Provider(),
			LinkedAt: a.Created().String(),
		})
	}
	return accountHasPassword(record), providers, nil
}

// countMethods is how many ways the account can still sign in AFTER removing
// `provider`. A password counts as one, every other linked provider counts as
// one, and the named provider never counts — that is what makes this the
// post-removal figure the guard needs.
func countMethods(hasPassword bool, providers []linkedProvider, provider string) int {
	total := 0
	if hasPassword {
		total++
	}
	for _, p := range providers {
		if p.Provider != provider {
			total++
		}
	}
	return total
}

// requireCredentialOwnership proves the caller may change a credential.
//
// The two proofs and their rationale are confirmTransferIdentity's, reused
// deliberately: the password when the account has one, otherwise a provider
// sign-in the SERVER observed (an account that only ever signs in through Google
// has no password to type — that is a fact of this migration, not an excuse).
// The messages name the action so a member is told what to re-do.
func requireCredentialOwnership(record *core.Record, password, action string) error {
	if accountHasPassword(record) {
		if password == "" {
			return forbiddenError("re-enter your current password to " + action)
		}
		if !record.ValidatePassword(password) {
			// Uniform, and deliberately uninformative: a caller must not learn
			// whether the account has a password at all.
			return forbiddenError("the current password is not correct")
		}
		return nil
	}
	if recentlySignedInWithOAuth(record.Id) {
		return nil
	}
	return forbiddenError("sign in with Google again to confirm it is you, then " + action)
}

// requireForumAccount is the shared gate: this endpoint serves forum accounts
// only, and a token for some other auth collection must not be presented as a
// forum member (the same rule meHandler applies).
func requireForumAccount(e *core.RequestEvent) (*core.Record, error) {
	if e.Auth == nil {
		return nil, forbiddenError("authentication required for this action")
	}
	if e.Auth.Collection().Name != usersCollectionName {
		return nil, forbiddenError("this endpoint serves forum accounts only")
	}
	return e.Auth, nil
}

// listMyAuthMethodsHandler answers GET /api/aerun/me/auth.
//
// It reports only what the caller already knows about their own account. The
// password HASH is never part of the payload, and `has_password` is a boolean
// precisely so nothing downstream needs the column itself.
func listMyAuthMethodsHandler(e *core.RequestEvent) error {
	record, err := requireForumAccount(e)
	if err != nil {
		return err
	}
	hasPassword, providers, err := accountAuthState(e.App, record)
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, credentialsPayload(e, record, hasPassword, providers))
}

type changePasswordForm struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
	NewPasswordConf string `json:"new_password_confirm"`
}

// changeMyPasswordHandler sets or replaces the account password.
//
// An account WITHOUT a password is not asked for a current one: there is none,
// and the only proof available is the recent provider sign-in, which
// requireCredentialOwnership already insists on. An account WITH one must
// present it, so a stolen session token cannot take the account over.
func changeMyPasswordHandler(e *core.RequestEvent) error {
	record, err := requireForumAccount(e)
	if err != nil {
		return err
	}
	if err := requireNotBanned(AccessFrom(e), "change your password"); err != nil {
		return err
	}

	raw, err := readBodyLimited(e, credentialsBodyBytes)
	if err != nil {
		return err
	}
	var form changePasswordForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	if err := validateNewPassword(form.NewPassword, form.NewPasswordConf); err != nil {
		return err
	}
	if err := requireCredentialOwnership(record, form.CurrentPassword, "change your password"); err != nil {
		return err
	}

	hadPassword := accountHasPassword(record)
	record.SetPassword(form.NewPassword)
	if err := e.App.Save(record); err != nil {
		return internalError("failed to save the new password", err)
	}

	// One action name for both cases, with `added` in the payload carrying the
	// distinction. A separate password_set action would read better in a log
	// but would need its own filter entry, and the auditor searching
	// "password" should find both events either way. The value, old and new, is
	// never logged.
	if err := recordAuditLog(e.App, "password_change", record.Id, map[string]any{
		"target_id": record.Id,
		"added":     !hadPassword,
	}); err != nil {
		e.App.Logger().Warn("password change could not be audited", "error", err, "userId", record.Id)
	}

	hasPassword, providers, err := accountAuthState(e.App, record)
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, credentialsPayload(e, record, hasPassword, providers))
}

type changeEmailForm struct {
	Email           string `json:"email"`
	CurrentPassword string `json:"current_password"`
}

// changeMyEmailHandler re-points the login address.
//
// THE VERIFIED FLAG IS DELIBERATELY LEFT ALONE. Resetting it to false is what a
// hosted deployment would do, because it can then mail a confirmation. Mail
// delivery is hard-disabled here (mail_guard.go), so resetting it would mark
// the account unverified FOREVER with no way back — a strictly worse outcome
// than carrying a verified flag across an address the member proved ownership
// of with their current password or a provider sign-in just now. Revisit when
// the mail outbox worker lands.
func changeMyEmailHandler(e *core.RequestEvent) error {
	record, err := requireForumAccount(e)
	if err != nil {
		return err
	}
	if err := requireNotBanned(AccessFrom(e), "change your email"); err != nil {
		return err
	}

	raw, err := readBodyLimited(e, credentialsBodyBytes)
	if err != nil {
		return err
	}
	var form changeEmailForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	email := strings.ToLower(strings.TrimSpace(form.Email))
	if email == "" {
		return validationError("email is required")
	}
	if len(email) > 255 || !registerEmailRe.MatchString(email) {
		return validationError("email is not a valid address")
	}
	if email == record.Email() {
		return validationError("that is already your email")
	}
	if err := requireCredentialOwnership(record, form.CurrentPassword, "change your email"); err != nil {
		return err
	}

	// Pre-check for the stable message; the UNIQUE index stays the real
	// enforcement, so two members racing for the same address cannot both win.
	users, err := e.App.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return internalError("users collection is unavailable", err)
	}
	if _, err := e.App.FindAuthRecordByEmail(users, email); err == nil {
		return conflictError("an account with this email already exists")
	}

	oldEmail := record.Email()
	record.SetEmail(email)
	if err := e.App.Save(record); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return conflictError("an account with this email already exists")
		}
		return internalError("failed to save the new email", err)
	}

	if err := recordAuditLog(e.App, "email_change", record.Id, map[string]any{
		"target_id": record.Id,
		"from":      oldEmail,
		"to":        email,
	}); err != nil {
		e.App.Logger().Warn("email change could not be audited", "error", err, "userId", record.Id)
	}

	hasPassword, providers, err := accountAuthState(e.App, record)
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, credentialsPayload(e, record, hasPassword, providers))
}

type unlinkProviderForm struct {
	CurrentPassword string `json:"current_password"`
}

// unlinkMyAuthProviderHandler removes a linked identity provider.
//
// THE GUARD IS THE POINT. countMethods counts what would be left AFTER the
// removal, and a result of zero is refused. Without it, "unlink Google" on an
// account that only ever signed in with Google locks the member out of their
// own forum with no recovery path — and mail delivery, the usual way back, is
// hard-disabled.
func unlinkMyAuthProviderHandler(e *core.RequestEvent) error {
	record, err := requireForumAccount(e)
	if err != nil {
		return err
	}
	if err := requireNotBanned(AccessFrom(e), "unlink a sign-in provider"); err != nil {
		return err
	}
	provider := strings.TrimSpace(e.Request.PathValue("provider"))
	if provider == "" {
		return validationError("provider is required")
	}
	if provider != googleProviderName {
		// Refused rather than 404: this deployment configures exactly one
		// provider, and a silent "nothing matched" would read as success.
		return validationError("this sign-in method cannot be unlinked here")
	}

	raw, err := readBodyLimited(e, credentialsBodyBytes)
	if err != nil {
		return err
	}
	var form unlinkProviderForm
	// A DELETE body is unusual; an unparseable body is treated as "no password
	// supplied" so requireCredentialOwnership can answer with its own message.
	_ = json.Unmarshal(raw, &form)

	hasPassword, providers, err := accountAuthState(e.App, record)
	if err != nil {
		return err
	}

	var target *core.ExternalAuth
	for _, a := range mustExternalAuths(e, record) {
		if a.Provider() == provider {
			target = a
			break
		}
	}
	if target == nil {
		return notFoundError("that sign-in method is not linked to your account")
	}

	if countMethods(hasPassword, providers, provider) == 0 {
		return conflictError("set a password before unlinking Google — it is currently your only way to sign in")
	}
	if err := requireCredentialOwnership(record, form.CurrentPassword, "unlink Google"); err != nil {
		return err
	}

	if err := e.App.Delete(target); err != nil {
		return internalError("failed to unlink the sign-in provider", err)
	}
	if err := recordAuditLog(e.App, "provider_unlink", record.Id, map[string]any{
		"target_id": record.Id,
		"provider":  provider,
	}); err != nil {
		e.App.Logger().Warn("provider unlink could not be audited", "error", err, "userId", record.Id)
	}

	hasPassword, providers, err = accountAuthState(e.App, record)
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, credentialsPayload(e, record, hasPassword, providers))
}

// mustExternalAuths returns the linked providers as deletable models. It is
// separate from accountAuthState because that one already succeeded above: a
// failure here is a genuine 500 rather than a swallowed read error.
func mustExternalAuths(e *core.RequestEvent, record *core.Record) []*core.ExternalAuth {
	auths, err := e.App.FindAllExternalAuthsByRecord(record)
	if err != nil {
		e.App.Logger().Error("could not re-read linked providers", "error", err, "userId", record.Id)
		return nil
	}
	return auths
}

// validateNewPassword applies the same bounds registration does. They are
// repeated rather than delegated so the failure names the field the member
// typed into, and because PocketBase's own message for an over-long secret is a
// raw validation dump rather than something to show a person.
func validateNewPassword(password, confirm string) error {
	if len(password) < minPasswordLen {
		return validationError("password must be at least 8 characters long")
	}
	if len(password) > maxPasswordLen {
		return validationError("password must not exceed 72 characters")
	}
	if password != confirm {
		return validationError("the two passwords do not match")
	}
	return nil
}
