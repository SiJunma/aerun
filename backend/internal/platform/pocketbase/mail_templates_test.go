package pocketbase

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/mails"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// TestConfigureAuthTemplatesInstallsTheAerunDesign is the point of the file:
// PocketBase ships English defaults, and the design the community already
// receives lives in functions/email.js. This pins that the Go templates carry
// the same visual vocabulary rather than a new one invented for the backend.
func TestConfigureAuthTemplatesInstallsTheAerunDesign(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	cfg := config.Config{PublicURL: "https://forum.aerun.example"}
	if err := configureAuthTemplates(app, cfg); err != nil {
		t.Fatalf("template reconcile must succeed: %v", err)
	}

	users := reloadUsers(t, app)

	for _, tc := range []struct {
		name string
		tpl  core.EmailTemplate
	}{
		{"verification", users.VerificationTemplate},
		{"password reset", users.ResetPasswordTemplate},
		{"email change", users.ConfirmEmailChangeTemplate},
	} {
		if tc.tpl.Subject == "" || tc.tpl.Body == "" {
			t.Fatalf("%s: template must not be empty, got %+v", tc.name, tc.tpl)
		}
		// The template carries {APP_NAME} for send-time resolution.
		if !strings.Contains(tc.tpl.Subject, phAppName) {
			t.Fatalf("%s: subject must contain placeholder %s, got %q", tc.name, phAppName, tc.tpl.Subject)
		}
		// The design vocabulary from functions/email.js.
		for _, marker := range []string{`class="btn"`, "#0f172a", "#64748b"} {
			if !strings.Contains(tc.tpl.Body, marker) {
				t.Fatalf("%s: body must keep the Aerun design marker %q", tc.name, marker)
			}
		}
	}

	// The email-change template is the only one that shows an address, and it
	// must use the same .highlight-box the DM/topic mails use for a snippet.
	if !strings.Contains(users.ConfirmEmailChangeTemplate.Body, "highlight-box") {
		t.Fatal("the email-change template must use .highlight-box, as functions/email.js does")
	}
}

// TestConfigureAuthTemplatesUsesTheDeploymentURL is the part that would silently
// break verification on the VPS: a link built from the wrong origin sends members
// to a domain they did not request.
func TestConfigureAuthTemplatesUsesTheDeploymentURL(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// A trailing slash would produce "//_/#/auth/..." in every delivered link.
	if err := configureAuthTemplates(app, config.Config{PublicURL: "https://forum.aerun.example/"}); err != nil {
		t.Fatal(err)
	}
	users := reloadUsers(t, app)

	want := "https://forum.aerun.example/_/#/auth/confirm-verification/"
	if !strings.Contains(users.VerificationTemplate.Body, want) {
		t.Fatalf("verification link must be %q, got body:\n%s", want, users.VerificationTemplate.Body)
	}
	if strings.Contains(users.VerificationTemplate.Body, "example.com//") {
		t.Fatal("a double slash in the verification link must never be written")
	}

	// The routes must be PocketBase's own, not a guess.
	if !strings.Contains(users.ResetPasswordTemplate.Body, "/auth/confirm-password-reset/") {
		t.Fatal("the reset link must point at PocketBase's confirm-password-reset route")
	}
	if !strings.Contains(users.ConfirmEmailChangeTemplate.Body, "/auth/confirm-email-change/") {
		t.Fatal("the email-change link must point at PocketBase's confirm-email-change route")
	}
}

// TestConfigureAuthTemplatesEscapesUntrustedValues is the security property.
// NewEmail arrives from a request, not from configuration, and it is rendered
// into the body — so the template must not be able to carry attacker HTML into
// a mailbox.
func TestConfigureAuthTemplatesEscapesUntrustedValues(t *testing.T) {
	substituted := substituteNewEmail(confirmEmailChangeTemplate.Body, `<script>alert(1)</script>`)
	if strings.Contains(substituted, "<script>") {
		t.Fatalf("an untrusted value reached the body unescaped:\n%s", substituted)
	}
	if !strings.Contains(substituted, "&lt;script&gt;") {
		t.Fatalf("the value must appear escaped, got:\n%s", substituted)
	}
}

// TestConfigureAuthTemplatesIsIdempotent proves a restart neither fails nor
// churns — a serve-time reconcile that rewrote the collection on every boot
// would touch the users table on every deploy.
func TestConfigureAuthTemplatesIsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	cfg := config.Config{PublicURL: "https://forum.aerun.example"}
	for i := 0; i < 3; i++ {
		if err := configureAuthTemplates(app, cfg); err != nil {
			t.Fatalf("reconcile run %d must succeed: %v", i+1, err)
		}
	}
	first := reloadUsers(t, app)
	if first.VerificationTemplate.Body == "" {
		t.Fatal("repeated reconciles must not lose the templates")
	}

	// Changing the deployment origin must rewrite the links, not be ignored: this
	// is what makes a moved domain recoverable without a migration.
	if err := configureAuthTemplates(app, config.Config{PublicURL: "https://new.aerun.example"}); err != nil {
		t.Fatal(err)
	}
	second := reloadUsers(t, app)
	if !strings.Contains(second.VerificationTemplate.Body, "https://new.aerun.example") {
		t.Fatal("a changed public URL must be reflected in the installed templates")
	}
	if second.VerificationTemplate.Body == first.VerificationTemplate.Body {
		t.Fatal("the reconcile must actually rewrite when the origin changed")
	}
}

func newAerunMailTestApp(t testing.TB) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return app
}

// TestAuthMailHooksVerificationEmailUsesAerunDesign proves that PocketBase's
// verification email is re-dressed in the Aerun global wrapper on send.
func TestAuthMailHooksVerificationEmailUsesAerunDesign(t *testing.T) {
	app := newAerunMailTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	cfg := config.Config{PublicURL: "https://forum.aerun.example"}
	if err := configureAuthTemplates(app, cfg); err != nil {
		t.Fatal(err)
	}
	registerAuthMailHooks(app)

	user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || user == nil {
		t.Fatal("user not found")
	}

	app.TestMailer.Reset()
	if err := mails.SendRecordVerification(app, user); err != nil {
		t.Fatalf("SendRecordVerification failed: %v", err)
	}
	if app.TestMailer.TotalSend() != 1 {
		t.Fatalf("expected 1 email sent, got %d", app.TestMailer.TotalSend())
	}

	msg := app.TestMailer.LastMessage()
	html := msg.HTML

	// Must be wrapped in Aerun design
	for _, marker := range []string{
		"<!DOCTYPE html>",
		".top-accent",
		"brand-title",
		"Confirm your email address",
		"class=\"btn\"",
		"/auth/confirm-verification/",
		"You received this automated notification from",
	} {
		if !strings.Contains(html, marker) {
			t.Errorf("verification HTML missing expected marker %q:\n%s", marker, html)
		}
	}

	// Must NOT contain PB's generic layout font or inline body padding
	if strings.Contains(html, "Source Sans Pro") {
		t.Errorf("PB default layout font must not leak into Aerun wrapper:\n%s", html)
	}

	// No unreplaced braces
	for _, ph := range []string{phToken, phAppName, phTitle, phContent} {
		if strings.Contains(html, ph) {
			t.Errorf("placeholder %s remained unreplaced in HTML:\n%s", ph, html)
		}
	}
}

// TestAuthMailHooksPasswordResetUsesAerunDesign proves that password reset
// emails are re-dressed in the Aerun design with valid links.
func TestAuthMailHooksPasswordResetUsesAerunDesign(t *testing.T) {
	app := newAerunMailTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	cfg := config.Config{PublicURL: "https://forum.aerun.example"}
	if err := configureAuthTemplates(app, cfg); err != nil {
		t.Fatal(err)
	}
	registerAuthMailHooks(app)

	user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || user == nil {
		t.Fatal("user not found")
	}

	app.TestMailer.Reset()
	if err := mails.SendRecordPasswordReset(app, user); err != nil {
		t.Fatalf("SendRecordPasswordReset failed: %v", err)
	}
	if app.TestMailer.TotalSend() != 1 {
		t.Fatalf("expected 1 email sent, got %d", app.TestMailer.TotalSend())
	}

	msg := app.TestMailer.LastMessage()
	html := msg.HTML

	for _, marker := range []string{
		".top-accent",
		"brand-title",
		"Password reset",
		"class=\"btn\"",
		"/auth/confirm-password-reset/",
		"You received this automated notification from",
	} {
		if !strings.Contains(html, marker) {
			t.Errorf("password reset HTML missing marker %q:\n%s", marker, html)
		}
	}
	if strings.Contains(html, phToken) || strings.Contains(html, phContent) {
		t.Errorf("placeholder survived into HTML:\n%s", html)
	}
}

// TestAuthMailHooksEmailChangeUsesAerunDesign proves that confirm-email-change
// mails show the new email in the .highlight-box and use the Aerun layout.
func TestAuthMailHooksEmailChangeUsesAerunDesign(t *testing.T) {
	app := newAerunMailTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	cfg := config.Config{PublicURL: "https://forum.aerun.example"}
	if err := configureAuthTemplates(app, cfg); err != nil {
		t.Fatal(err)
	}
	registerAuthMailHooks(app)

	user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || user == nil {
		t.Fatal("user not found")
	}

	app.TestMailer.Reset()
	const targetEmail = "new_address@aerun.example"
	if err := mails.SendRecordChangeEmail(app, user, targetEmail); err != nil {
		t.Fatalf("SendRecordChangeEmail failed: %v", err)
	}
	if app.TestMailer.TotalSend() != 1 {
		t.Fatalf("expected 1 email sent, got %d", app.TestMailer.TotalSend())
	}

	msg := app.TestMailer.LastMessage()
	html := msg.HTML

	for _, marker := range []string{
		".top-accent",
		"brand-title",
		"Confirm your new email address",
		targetEmail,
		"class=\"btn\"",
		"/auth/confirm-email-change/",
		"You received this automated notification from",
	} {
		if !strings.Contains(html, marker) {
			t.Errorf("email change HTML missing marker %q:\n%s", marker, html)
		}
	}
	if strings.Contains(html, phNewEmail) || strings.Contains(html, phContent) {
		t.Errorf("placeholder survived into HTML:\n%s", html)
	}
}

// TestAuthMailHooksUseCustomGlobalWrapperFromForumSettings proves that
// editing the global wrapper in forum_settings immediately re-dresses auth
// emails without a restart or modifying the users collection.
func TestAuthMailHooksUseCustomGlobalWrapperFromForumSettings(t *testing.T) {
	app := newAerunMailTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	cfg := config.Config{PublicURL: "https://forum.aerun.example"}
	if err := configureAuthTemplates(app, cfg); err != nil {
		t.Fatal(err)
	}
	registerAuthMailHooks(app)

	// Save custom global wrapper in forum_settings
	const customBanner = `<div class='custom-admin-banner'>Aerun Custom Identity</div>`
	storeEmailTemplates(t, app, `{"wrapper":{"body":"<!DOCTYPE html><html><body>`+customBanner+`<div>{CONTENT}</div></body></html>"}}`)

	user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || user == nil {
		t.Fatal("user not found")
	}

	app.TestMailer.Reset()
	if err := mails.SendRecordVerification(app, user); err != nil {
		t.Fatalf("SendRecordVerification failed: %v", err)
	}

	msg := app.TestMailer.LastMessage()
	if !strings.Contains(msg.HTML, customBanner) {
		t.Fatalf("verification mail must use custom wrapper from forum_settings, got:\n%s", msg.HTML)
	}
	if !strings.Contains(msg.HTML, "/auth/confirm-verification/") {
		t.Fatalf("verification link must remain inside custom wrapper, got:\n%s", msg.HTML)
	}
}
