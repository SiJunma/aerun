package pocketbase

// Email templates (Sprint 8).
//
// The design system here is not invented for Go: it is the one already shipped
// and already received by users in functions/email.js (Firebase era) —
// wrapEmailTemplate with the same slate palette, the same container, the same
// accent bar and the same .highlight-box. Reusing it is the whole point. A forum
// whose DM mail looked a certain way for two years should not greet the same
// member with a different design the moment the backend moved to PocketBase.
//
// The two templates PocketBase itself owns — verification and password reset —
// live in the users collection's authOptions, not in this package. They are
// installed by configureAuthTemplates on every startup for the same reason
// configureOAuth2 and configureSMTP reconcile on every startup: they are
// deployment content, and a schema migration would freeze whatever text existed
// the day it ran.
//
// WHAT THE STORED TEMPLATE HOLDS, AND WHY. The installed template is a contract
// with PocketBase's send-time resolver, not a rendered message:
//
//   - {APP_NAME} stays a placeholder in both subject and body. PocketBase
//     substitutes it from settings.Meta.AppName on every send, and
//     configureSMTP derives Meta.AppName from the admin-editable forum_name —
//     so renaming the forum in the admin panel changes the very next mail with
//     no restart and no re-install of the templates. Baking the brand in here
//     instead would freeze it at whatever the name was on boot day.
//   - {TOKEN} stays a placeholder for the same reason: PocketBase mints a fresh
//     token per message. (Rendering it through the Go template with an empty
//     Token — what this file did before — produced a link with NO token at all,
//     because {{ .Token }} collapses to "" at install time.)
//   - {NEW_EMAIL} is PocketBase-less: PB has no such placeholder, so
//     bindEmailChangePlaceholder substitutes it in the OnMailer hook right
//     before the send, HTML-escaped, from the event's own Meta payload.
//   - {{ .AppURL }} IS rendered at install time. The origin is environment
//     state (AERUN_PUBLIC_URL) that changes only with a restart, and the
//     restart re-runs this reconcile — the same no-churn property the link
//     tests pin down.

import (
	"fmt"
	"html"
	"html/template"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// PocketBase's own template placeholders (core.EmailPlaceholder*). Spelled out
// as literals rather than imported so the templates below read exactly as they
// will be delivered, and a rename upstream is caught by the golden test instead
// of silently rendering an unreplaced brace.
const (
	phAppName = "{APP_NAME}"
	phAppURL  = "{APP_URL}"
	phToken   = "{TOKEN}"
	// phNewEmail is NOT a PocketBase placeholder — PB has none for the address
	// being confirmed. It is substituted by bindEmailChangePlaceholder at send
	// time, which is the only place the address exists (the event Meta).
	phNewEmail = "{NEW_EMAIL}"
)

// verificationTemplate and resetPasswordTemplate replace PocketBase's built-in
// English defaults with the Aerun design.
//
// The bodies are the content fragment only: PocketBase wraps whatever is here in
// its own layout and sends a multipart/alternative message, so these must NOT
// contain <html>/<head>/<body> the way the Firebase templates did — those were
// sent through Brevo's API as standalone documents. Keeping them fragments is
// what makes the two eras produce the same message.
//
// Brand trust: {APP_NAME} is replaced by PocketBase with the RAW settings value
// and no HTML escaping — exactly as PB's own default templates treat it. The
// value comes from forum_settings.forum_name, writable only by a manage_forum
// holder, which is the same trust boundary PocketBase draws around
// Meta.AppName in its dashboard.
var verificationTemplate = core.EmailTemplate{
	Subject: "Verify your " + phAppName + " email",
	Body: `
<h2 style="margin:0 0 16px;font-size:17px;font-weight:600;color:#0f172a;">Confirm your email address</h2>
<p>Welcome to ` + phAppName + `.</p>
<p>One click and your account is fully active — your profile becomes visible to the forum and you can take part in discussions and private messages.</p>
<p style="margin:24px 0;">
  <a class="btn" href="{{ .AppURL }}/_/#/auth/confirm-verification/` + phToken + `" target="_blank" rel="noopener">Verify my email</a>
</p>
<p style="color:#64748b;font-size:13px;line-height:1.5;">
  If you did not create an account on ` + phAppName + `, you can safely ignore this message — nothing will happen without the button above.
</p>
<p style="margin-top:20px;">See you soon,<br/>The ` + phAppName + ` team</p>
`,
}

var resetPasswordTemplate = core.EmailTemplate{
	Subject: "Reset your " + phAppName + " password",
	Body: `
<h2 style="margin:0 0 16px;font-size:17px;font-weight:600;color:#0f172a;">Password reset</h2>
<p>Hello,</p>
<p>We received a request to reset the password for your ` + phAppName + ` account. Click the button below to choose a new one.</p>
<p style="margin:24px 0;">
  <a class="btn" href="{{ .AppURL }}/_/#/auth/confirm-password-reset/` + phToken + `" target="_blank" rel="noopener">Choose a new password</a>
</p>
<p style="color:#64748b;font-size:13px;line-height:1.5;">
  The link is valid for 30 minutes and can be used once. If you did not ask for this, ignore this email — your current password stays in place and nothing changes.
</p>
<p style="margin-top:20px;">Thanks,<br/>The ` + phAppName + ` team</p>
`,
}

// confirmEmailChangeTemplate covers the third PocketBase-owned auth mail. It
// exists because leaving it in PocketBase's English default while the other two
// are Aerun-branded would look like a bug to the one member who changes email.
//
// The address box carries {NEW_EMAIL} — not a PB placeholder, but the literal
// our own OnMailer hook replaces at send time (see bindEmailChangePlaceholder).
// Installing it through the Go template with an empty NewEmail — what this file
// did before — shipped an empty .highlight-box to every recipient.
var confirmEmailChangeTemplate = core.EmailTemplate{
	Subject: "Confirm your new " + phAppName + " email address",
	Body: `
<h2 style="margin:0 0 16px;font-size:17px;font-weight:600;color:#0f172a;">Confirm your new email address</h2>
<p>Hello,</p>
<p>Someone asked to change the email address on this ` + phAppName + ` account to:</p>
<div class="highlight-box">` + phNewEmail + `</div>
<p style="margin:24px 0;">
  <a class="btn" href="{{ .AppURL }}/_/#/auth/confirm-email-change/` + phToken + `" target="_blank" rel="noopener">Confirm new address</a>
</p>
<p style="color:#64748b;font-size:13px;line-height:1.5;">
  If you did not request this change, ignore this email — the address on your account stays as it is.
</p>
`,
}

// authTemplateData is the value set passed to every template.
//
// Only AppURL is renderable at install time: it is environment state
// (AERUN_PUBLIC_URL) whose change implies a restart, and the restart re-runs
// configureAuthTemplates. Token is deliberately NOT here — PocketBase mints one
// per message and substitutes {TOKEN} itself; rendering it through this struct
// with an empty value is what previously produced tokenless confirmation links.
// Brand is not here either: {APP_NAME} resolves from settings.Meta.AppName at
// send time, which configureSMTP keeps pointed at forum_settings.forum_name.
type authTemplateData struct {
	AppURL string
}

// configureAuthTemplates installs the Aerun templates on the users collection.
//
// It reconciles on every startup rather than relying on a migration, for two
// reasons. Content is not schema: a wording fix must not require a new
// migration, and every deployment that skipped one would keep the old text
// forever. And a migration would be wrong in a second way too — it runs exactly
// once, so a database imported from production (which already carries whatever
// templates were live there) would keep those instead of the ones this
// repository ships.
//
// Only templates whose current value differs are written, so a steady state
// costs three reads and no write — the same no-churn property configureOAuth2
// documents.
func configureAuthTemplates(app core.App, cfg config.Config) error {
	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return fmt.Errorf("load users collection: %w", err)
	}

	data := authTemplateData{
		AppURL: strings.TrimSuffix(cfg.PublicURL, "/"),
	}

	templates := []struct {
		name   string
		target *core.EmailTemplate
		source core.EmailTemplate
	}{
		{"verification", &users.VerificationTemplate, verificationTemplate},
		{"password reset", &users.ResetPasswordTemplate, resetPasswordTemplate},
		{"email change", &users.ConfirmEmailChangeTemplate, confirmEmailChangeTemplate},
	}

	changed := false
	for _, t := range templates {
		rendered, err := renderAuthTemplate(t.source, data)
		if err != nil {
			// A broken template must not be installed: an empty or malformed Body
			// fails collection validation anyway, and writing a half-rendered one
			// would break verification for every member.
			return fmt.Errorf("render %s template: %w", t.name, err)
		}
		if *t.target == rendered {
			continue
		}
		*t.target = rendered
		changed = true
	}

	if !changed {
		return nil
	}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("save users auth templates: %w", err)
	}
	// Only the resulting state is logged. The bodies are public content; the fact
	// that they changed is what an operator is watching for. The brand is NOT
	// logged as a value because it is not rendered here — {APP_NAME} resolves
	// per send from Meta.AppName (see authTemplateData).
	app.Logger().Info("users auth email templates reconciled",
		"app_url", data.AppURL)
	return nil
}

// renderAuthTemplate resolves the install-time part of one template.
//
// {{ .AppURL }} is the only Go-template action left in the sources: the origin
// is environment state and belongs to the reconcile. Everything a per-message or
// per-rename value needs — {TOKEN}, {APP_NAME}, {NEW_EMAIL} — stays a literal
// brace token in the stored text for the send-time layer (PocketBase's resolver
// and bindEmailChangePlaceholder). The html/template context escapes AppURL, so
// a malformed origin cannot inject markup into the href.
func renderAuthTemplate(t core.EmailTemplate, data authTemplateData) (core.EmailTemplate, error) {
	parsed, err := template.New("mail").Parse(t.Body)
	if err != nil {
		return core.EmailTemplate{}, err
	}
	var body strings.Builder
	if err := parsed.Execute(&body, data); err != nil {
		return core.EmailTemplate{}, err
	}
	return core.EmailTemplate{Subject: t.Subject, Body: body.String()}, nil
}

// bindEmailChangePlaceholder is the send-time half of {NEW_EMAIL}.
//
// PocketBase has no placeholder for the address a change-email request is
// confirming: SendRecordChangeEmail resolves only {TOKEN} and the system
// placeholders, and the address lives solely in the event Meta. The hook runs
// after that resolve and before the mailer, so the stored template can carry a
// stable literal while every other auth mail keeps working through PB alone.
//
// The substitution itself is a pure function so the escaping property has a
// test that does not have to construct a mailer event; the hook is the thinnest
// possible adapter over it. Messages without the literal pass through
// untouched, and rebinding on every serve is harmless — PB replaces the
// previous binding for the same event.
// registerAuthMailHooks attaches send hooks for PocketBase-managed auth emails
// (verification, password reset, confirm email change).
//
// PocketBase resolves per-send placeholders ({TOKEN}, system links) and wraps
// the collection fragment in its own generic layout before triggering these hooks.
// Each hook extracts the inner content and re-dresses it in the forum's global
// wrapper (loadEmailWrapper), ensuring consistent brand design and instant
// reactivity to admin panel changes without altering users collection rows.
func registerAuthMailHooks(app core.App) {
	app.OnMailerRecordVerificationSend().BindFunc(func(e *core.MailerRecordEvent) error {
		inner := extractBodyContent(e.Message.HTML)
		e.Message.HTML = wrapWithGlobalLayout(e.App, e.Message.Subject, inner)
		return e.Next()
	})

	app.OnMailerRecordPasswordResetSend().BindFunc(func(e *core.MailerRecordEvent) error {
		inner := extractBodyContent(e.Message.HTML)
		e.Message.HTML = wrapWithGlobalLayout(e.App, e.Message.Subject, inner)
		return e.Next()
	})

	app.OnMailerRecordEmailChangeSend().BindFunc(func(e *core.MailerRecordEvent) error {
		newEmail, _ := e.Meta["newEmail"].(string)
		e.Message.HTML = substituteNewEmail(e.Message.HTML, newEmail)
		e.Message.Subject = substituteNewEmail(e.Message.Subject, newEmail)
		inner := extractBodyContent(e.Message.HTML)
		e.Message.HTML = wrapWithGlobalLayout(e.App, e.Message.Subject, inner)
		return e.Next()
	})
}

// bindEmailChangePlaceholder is an alias for registerAuthMailHooks kept for backward compatibility.
func bindEmailChangePlaceholder(app core.App) {
	registerAuthMailHooks(app)
}

// substituteNewEmail replaces {NEW_EMAIL} with the address, HTML-escaped.
//
// The address originates from a user-supplied request, so it is the one
// request-derived value this package puts into a body — and it is escaped
// here, in one place, rather than trusted to every call site.
func substituteNewEmail(content, newEmail string) string {
	if newEmail == "" || !strings.Contains(content, phNewEmail) {
		return content
	}
	return strings.ReplaceAll(content, phNewEmail, html.EscapeString(newEmail))
}
