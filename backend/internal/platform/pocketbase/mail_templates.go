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
// HTML escaping: everything interpolated into a body goes through
// html/template with no functions registered, so the context is escaped for us.
// NewEmail is the one value that arrives from the request rather than from
// configuration, and leaving it out of this struct would make a future template
// that interpolates it into an injection bug.

import (
	"fmt"
	"html/template"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// authTemplateAppName is the brand line in every template.
//
// The JS version defaulted to "Aerun Forum" and read FORUM_NAME from the
// environment. The name is single-sourced here and matched to what
// configureSMTP writes into Meta.SenderName, so the From header, the admin
// dashboard and the visible brand agree instead of drifting apart.
const authTemplateAppName = "Aerun Forum"

// PocketBase's own template placeholders (core.EmailPlaceholder*). Spelled out
// as literals rather than imported so the templates below read exactly as they
// will be delivered, and a rename upstream is caught by the golden test instead
// of silently rendering an unreplaced brace.
const (
	phAppName = "{APP_NAME}"
	phAppURL  = "{APP_URL}"
	phToken   = "{TOKEN}"
)

// verificationTemplate and resetPasswordTemplate replace PocketBase's built-in
// English defaults with the Aerun design.
//
// The bodies are the content fragment only: PocketBase wraps whatever is here in
// its own layout and sends a multipart/alternative message, so these must NOT
// contain <html>/<head>/<body> the way the Firebase templates did — those were
// sent through Brevo's API as standalone documents. Keeping them fragments is
// what makes the two eras produce the same message.
var verificationTemplate = core.EmailTemplate{
	Subject: "Verify your " + phAppName + " email",
	Body: `
<h2 style="margin:0 0 16px;font-size:17px;font-weight:600;color:#0f172a;">Confirm your email address</h2>
<p>Welcome to {{ .Brand }}.</p>
<p>One click and your account is fully active — your profile becomes visible to the forum and you can take part in discussions and private messages.</p>
<p style="margin:24px 0;">
  <a class="btn" href="{{ .AppURL }}/_/#/auth/confirm-verification/{{ .Token }}" target="_blank" rel="noopener">Verify my email</a>
</p>
<p style="color:#64748b;font-size:13px;line-height:1.5;">
  If you did not create an account on {{ .Brand }}, you can safely ignore this message — nothing will happen without the button above.
</p>
<p style="margin-top:20px;">See you soon,<br/>The {{ .Brand }} team</p>
`,
}

var resetPasswordTemplate = core.EmailTemplate{
	Subject: "Reset your " + phAppName + " password",
	Body: `
<h2 style="margin:0 0 16px;font-size:17px;font-weight:600;color:#0f172a;">Password reset</h2>
<p>Hello,</p>
<p>We received a request to reset the password for your {{ .Brand }} account. Click the button below to choose a new one.</p>
<p style="margin:24px 0;">
  <a class="btn" href="{{ .AppURL }}/_/#/auth/confirm-password-reset/{{ .Token }}" target="_blank" rel="noopener">Choose a new password</a>
</p>
<p style="color:#64748b;font-size:13px;line-height:1.5;">
  The link is valid for a short time and can be used once. If you did not ask for this, ignore this email — your current password stays in place and nothing changes.
</p>
<p style="margin-top:20px;">Thanks,<br/>The {{ .Brand }} team</p>
`,
}

// confirmEmailChangeTemplate covers the third PocketBase-owned auth mail. It
// exists because leaving it in PocketBase's English default while the other two
// are Aerun-branded would look like a bug to the one member who changes email.
var confirmEmailChangeTemplate = core.EmailTemplate{
	Subject: "Confirm your new " + phAppName + " email address",
	Body: `
<h2 style="margin:0 0 16px;font-size:17px;font-weight:600;color:#0f172a;">Confirm your new email address</h2>
<p>Hello,</p>
<p>Someone asked to change the email address on this {{ .Brand }} account to:</p>
<div class="highlight-box">{{ .NewEmail }}</div>
<p style="margin:24px 0;">
  <a class="btn" href="{{ .AppURL }}/_/#/auth/confirm-email-change/{{ .Token }}" target="_blank" rel="noopener">Confirm new address</a>
</p>
<p style="color:#64748b;font-size:13px;line-height:1.5;">
  If you did not request this change, ignore this email — the address on your account stays as it is.
</p>
`,
}

// authTemplateData is the value set passed to every template.
//
// Token is deliberately empty when the template is installed: PocketBase
// substitutes {TOKEN} itself when it renders a per-message copy. Baking a token
// in here would ship one shared secret into every verification mail ever sent.
type authTemplateData struct {
	Brand    string
	AppURL   string
	Token    string
	NewEmail string
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
		Brand:  authTemplateAppName,
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
	// that they changed is what an operator is watching for.
	app.Logger().Info("users auth email templates reconciled",
		"app_url", data.AppURL, "brand", data.Brand)
	return nil
}

// renderAuthTemplate resolves one template.
//
// The stored template keeps the {TOKEN} placeholder for PocketBase to substitute
// per message; this helper exists to validate the markup before it is installed
// and to let the tests assert on the rendered result. The html/template context
// escapes Brand, AppURL and NewEmail, so a value that ever reaches them from a
// request cannot inject markup.
func renderAuthTemplate(t core.EmailTemplate, data authTemplateData) (core.EmailTemplate, error) {
	parsed, err := template.New("mail").Parse(t.Body)
	if err != nil {
		return core.EmailTemplate{}, err
	}
	var body strings.Builder
	if err := parsed.Execute(&body, data); err != nil {
		return core.EmailTemplate{}, err
	}
	subject := strings.NewReplacer(
		phAppName, data.Brand,
		phAppURL, data.AppURL,
		phToken, data.Token,
	).Replace(t.Subject)
	return core.EmailTemplate{Subject: subject, Body: body.String()}, nil
}
