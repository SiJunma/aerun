package pocketbase

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

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
		// PocketBase's English default must be gone.
		if tc.tpl.Subject == "Verify your "+phAppName+" email" {
			t.Fatalf("%s: PocketBase's default subject survived the reconcile", tc.name)
		}
		if !strings.Contains(tc.tpl.Subject, authTemplateAppName) {
			t.Fatalf("%s: subject must name the forum, got %q", tc.name, tc.tpl.Subject)
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
	data := authTemplateData{
		Brand:    authTemplateAppName,
		AppURL:   "https://forum.aerun.example",
		NewEmail: `<script>alert(1)</script>`,
	}

	rendered, err := renderAuthTemplate(confirmEmailChangeTemplate, data)
	if err != nil {
		t.Fatalf("render must succeed: %v", err)
	}
	if strings.Contains(rendered.Body, "<script>") {
		t.Fatalf("an untrusted value reached the body unescaped:\n%s", rendered.Body)
	}
	if !strings.Contains(rendered.Body, "&lt;script&gt;") {
		t.Fatalf("the value must appear escaped, got:\n%s", rendered.Body)
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
