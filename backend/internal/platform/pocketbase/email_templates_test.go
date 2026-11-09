package pocketbase

import (
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// storeEmailTemplates writes raw JSON into the settings row the way the admin
// panel will — through the record API, which is also how the JSONField
// validates what a form can realistically submit.
func storeEmailTemplates(t *testing.T, app core.App, raw string) {
	t.Helper()
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil {
		t.Fatalf("find forum_settings row: %v", err)
	}
	record.Set("email_templates", raw)
	if err := app.Save(record); err != nil {
		t.Fatalf("save email_templates: %v", err)
	}
}

// corruptEmailTemplates writes invalid JSON straight past the field
// validation — a hand-edited row or a failed migration is exactly the state
// the resolver must survive, and the record API would (rightly) refuse it.
func corruptEmailTemplates(t *testing.T, app core.App) {
	t.Helper()
	if _, err := app.DB().NewQuery(
		"UPDATE " + forumSettingsCollectionName + " SET email_templates = {:raw} WHERE id = {:id}",
	).Bind(dbx.Params{"raw": "{not json", "id": forumSettingsID}).Execute(); err != nil {
		t.Fatalf("corrupt email_templates: %v", err)
	}
}

// storedEmailTemplatesRaw reads the column back untouched, for asserting that
// resolving never writes.
func storedEmailTemplatesRaw(t *testing.T, app core.App) string {
	t.Helper()
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil {
		t.Fatalf("find forum_settings row: %v", err)
	}
	return record.GetString("email_templates")
}

// TestLoadEmailTemplatesFallsBackToTheBuiltInDesign is the out-of-the-box
// promise: migration 1769300000 seeds "{}", so a forum nobody configured must
// still send the design from functions/email.js — wrapper, CTA, placeholders
// and all.
func TestLoadEmailTemplatesFallsBackToTheBuiltInDesign(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	got := loadEmailTemplates(app)
	dm, ok := got[emailTemplateDM]
	if !ok {
		t.Fatal("the built-in defaults must include the DM type")
	}
	if !strings.HasPrefix(dm.Subject, "New Direct Message from ") {
		t.Fatalf("unexpected default DM subject: %q", dm.Subject)
	}
	// The design vocabulary of wrapEmailTemplate.
	for _, marker := range []string{
		"<!DOCTYPE html>",
		".top-accent",
		".highlight-box",
		".btn-container",
		"#4f46e5",
		phAppName,
	} {
		if !strings.Contains(dm.Body, marker) {
			t.Fatalf("default DM body must carry the functions/email.js marker %q", marker)
		}
	}
	if strings.Contains(dm.Body, phContent) {
		t.Fatal("aerunWrap must fold the content in, not leave {CONTENT} behind")
	}
	// {TITLE} stays open for the delivery path; the content placeholders stay
	// open for the renderer that fills them per send.
	if !strings.Contains(dm.Body, phTitle) {
		t.Fatal("the wrapper must leave {TITLE} for the delivery path to fill")
	}
	for _, ph := range []string{phRecipientName, phSenderName, phSnippet, phMessagesURL} {
		if !strings.Contains(dm.Body, ph) {
			t.Fatalf("default DM body must carry the placeholder %s", ph)
		}
	}
}

// TestLoadEmailTemplatesPrefersTheStoredValue pins the resolver's whole
// contract with the admin panel: what is stored wins, and reading it back
// never rewrites the row — the property that makes an edit survive restarts,
// exactly like SMTP settings.
func TestLoadEmailTemplatesPrefersTheStoredValue(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	const stored = `{"dm":{"subject":"Stored subject","body":"<p>stored body</p>"}}`
	storeEmailTemplates(t, app, stored)

	got := loadEmailTemplates(app)
	if got[emailTemplateDM].Subject != "Stored subject" {
		t.Fatalf("stored subject must win, got %q", got[emailTemplateDM].Subject)
	}
	if got[emailTemplateDM].Body != "<p>stored body</p>" {
		t.Fatalf("stored body must win, got %q", got[emailTemplateDM].Body)
	}

	// Reading is read-only, and resolving is deterministic.
	if raw := storedEmailTemplatesRaw(t, app); raw != stored {
		t.Fatalf("the resolver must never rewrite the stored value, got %q", raw)
	}
	if again := loadEmailTemplates(app); again[emailTemplateDM].Subject != "Stored subject" {
		t.Fatal("repeated resolution must return the same stored value")
	}
}

// TestLoadEmailTemplatesKeepsDefaultsForTypesTheStoreOmits is the overlay
// rule: the admin editing one type must not blank the others, and a
// half-saved entry must keep the default rather than send an empty mail.
func TestLoadEmailTemplatesKeepsDefaultsForTypesTheStoreOmits(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	storeEmailTemplates(t, app, `{"quote":{"subject":"Quoted you","body":"<p>quote</p>"}}`)
	got := loadEmailTemplates(app)
	if got["quote"].Subject != "Quoted you" {
		t.Fatalf("a type stored by the admin must resolve, got %+v", got["quote"])
	}
	if _, ok := got[emailTemplateDM]; !ok {
		t.Fatal("types the store omits must fall back to the built-in defaults")
	}

	// Half-saved entry: empty fields keep the default rather than blanking.
	storeEmailTemplates(t, app, `{"dm":{"subject":"","body":""}}`)
	got = loadEmailTemplates(app)
	if got[emailTemplateDM].Subject == "" || got[emailTemplateDM].Body == "" {
		t.Fatal("an empty stored entry must keep the built-in default")
	}
}

// TestLoadEmailTemplatesSurvivesCorruptStorage is the delivery guarantee: a
// hand-edited or truncated row must degrade to the built-in design, never to
// a send failure or a blank mail.
func TestLoadEmailTemplatesSurvivesCorruptStorage(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	corruptEmailTemplates(t, app)

	got := loadEmailTemplates(app)
	dm, ok := got[emailTemplateDM]
	if !ok || dm.Body == "" {
		t.Fatalf("corrupt JSON must fall back to the built-in defaults, got %+v", got)
	}
	if !strings.Contains(dm.Body, ".top-accent") {
		t.Fatal("the fallback must still be the functions/email.js design")
	}
}

// TestAerunWrapFoldsContentIntoTheWrapper pins the primitive step 3
// (notification rendering) and step 4 (auth re-dressing) both stand on.
func TestAerunWrapFoldsContentIntoTheWrapper(t *testing.T) {
	wrapped := aerunWrap("<p>inner</p>")
	if strings.Count(wrapped, "<p>inner</p>") != 1 {
		t.Fatalf("the content must appear exactly once:\n%s", wrapped)
	}
	if strings.Contains(wrapped, phContent) {
		t.Fatalf("the content placeholder must be consumed:\n%s", wrapped)
	}
	if !strings.Contains(wrapped, phTitle) || !strings.Contains(wrapped, phAppName) {
		t.Fatal("title and forum name must remain placeholders for the delivery path")
	}
}

// TestDefaultTopicReplyTemplateExists is the out-of-the-box promise for the
// second notification type: the functions/email.js renderTopicReplyEmail
// design, wrapped, with its per-send placeholders open.
func TestDefaultTopicReplyTemplateExists(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tpl, ok := loadEmailTemplates(app)[emailTemplateTopicReply]
	if !ok {
		t.Fatal("the built-in defaults must include the topic_reply type")
	}
	if !strings.HasPrefix(tpl.Subject, "New reply in: ") {
		t.Fatalf("unexpected default topic_reply subject: %q", tpl.Subject)
	}
	for _, marker := range []string{
		".top-accent",
		"New Reply in Subscribed Topic",
		"View Discussion",
		phTopicTitle,
		phTopicURL,
		phRecipientName,
		phSenderName,
		phSnippet,
	} {
		if !strings.Contains(tpl.Body, marker) {
			t.Fatalf("default topic_reply body must carry %q", marker)
		}
	}
}

// TestRenderEmailFromTemplateEscapesBodyNotSubject pins the escaping
// contract: values arrive raw, the body pass escapes them (it is HTML), the
// subject pass does not (an &amp; in a subject line would be a lie).
func TestRenderEmailFromTemplateEscapesBodyNotSubject(t *testing.T) {
	tpl := emailTemplate{
		Subject: "About " + phTopicTitle,
		Body:    "<h1>" + phTopicTitle + "</h1><p>" + phSnippet + "</p><title>" + phTitle + "</title><b>" + phAppName + "</b>",
	}
	const nasty = `Tom & Jerry <b>vs</b> "them"`
	subject, body := renderEmailFromTemplate(tpl, "A & B", "About "+nasty, map[string]string{
		phTopicTitle: nasty,
		phSnippet:    nasty,
	})

	if subject != "About "+nasty {
		t.Errorf("the subject must stay raw, got %q", subject)
	}
	if strings.Contains(body, "<b>vs</b>") || strings.Contains(body, `"them"`) {
		t.Errorf("the body must escape the values, got %s", body)
	}
	for _, want := range []string{"Tom &amp; Jerry", "&lt;b&gt;vs&lt;/b&gt;", "&#34;them&#34;", "A &amp; B"} {
		if !strings.Contains(body, want) {
			t.Errorf("body must contain escaped form %q, got %s", want, body)
		}
	}
}

// TestRenderEmailFromTemplateStripsCRLFFromSubject pins SEC-07 at the
// template layer: a user value carrying a CRLF must not survive into the
// subject as a header line. The {TITLE} pair and the value maps are both
// sanitised, and the resolved template is sanitised as a whole, so a CRLF
// that arrives in ANY placeholder (including the title) is gone.
func TestRenderEmailFromTemplateStripsCRLFFromSubject(t *testing.T) {
	tpl := emailTemplate{
		Subject: "About " + phTopicTitle + " from " + phSenderName,
		Body:    "<h1>" + phTopicTitle + "</h1>",
	}
	const crlf = "Injected\r\nX-Injected: yes"
	subject, _ := renderEmailFromTemplate(tpl, "A & B", "About "+crlf, map[string]string{
		phTopicTitle: crlf,
		phSenderName: crlf,
	})
	if strings.ContainsAny(subject, "\r\n") {
		t.Errorf("the subject must not carry CRLF, got %q", subject)
	}
	for _, want := range []string{"About Injected X-Injected: yes", "from Injected X-Injected: yes"} {
		if !strings.Contains(subject, want) {
			t.Errorf("the CRLF must become a single space in %q, got %q", want, subject)
		}
	}
}

// TestSanitizeMailSubjectCollapsesCRLF pins the exact normalisation:
// "\r\n" becomes ONE space (not two), and a bare CR or LF becomes one.
func TestSanitizeMailSubjectCollapsesCRLF(t *testing.T) {
	cases := map[string]string{
		"a\r\nb":     "a b",
		"a\rb":       "a b",
		"a\nb":       "a b",
		"a\r\n\r\nb": "a  b",
	}
	for in, want := range cases {
		if got := sanitizeMailSubject(in); got != want {
			t.Errorf("sanitizeMailSubject(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestLoadEmailWrapperResolvesDefaultAndCustomWrapper pins the wrapper resolution:
// default wrapper out of the box, custom wrapper when stored in forum_settings,
// and graceful fallback if the custom wrapper omits {CONTENT}.
func TestLoadEmailWrapperResolvesDefaultAndCustomWrapper(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// 1. Fresh install returns default wrapper.
	got := loadEmailWrapper(app)
	if !strings.Contains(got, ".top-accent") || !strings.Contains(got, phContent) {
		t.Fatal("default wrapper must be returned out of the box")
	}

	// 2. Custom wrapper in forum_settings.email_templates["wrapper"].
	storeEmailTemplates(t, app, `{"wrapper":{"body":"<!DOCTYPE html><html><body><header>Custom Aerun</header><main>`+phContent+`</main></body></html>"}}`)
	if w := loadEmailWrapper(app); !strings.Contains(w, "Custom Aerun") {
		t.Fatalf("custom wrapper must win, got:\n%s", w)
	}

	// 3. Broken custom wrapper missing {CONTENT} falls back to default.
	storeEmailTemplates(t, app, `{"wrapper":{"body":"<p>no placeholder</p>"}}`)
	if w := loadEmailWrapper(app); !strings.Contains(w, ".top-accent") {
		t.Fatal("wrapper missing {CONTENT} must fall back to defaultEmailWrapper")
	}
}

// TestExtractBodyContentExtractsInnerHtml pins the extractor:
// extracts whatever is between <body> and </body>, tolerating attributes,
// newlines and falling back to raw string when no <body> tag is present.
func TestExtractBodyContent(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{
			input: `<!DOCTYPE html><html><head><title>Hi</title></head><body><p>Hello world</p></body></html>`,
			want:  `<p>Hello world</p>`,
		},
		{
			input: `<body style="background:#fff;" class="main"><div>Text</div></body>`,
			want:  `<div>Text</div>`,
		},
		{
			input: `  <p>plain fragment without body tags</p>  `,
			want:  `<p>plain fragment without body tags</p>`,
		},
	}
	for _, tc := range cases {
		if got := extractBodyContent(tc.input); got != tc.want {
			t.Errorf("extractBodyContent(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// TestWrapWithGlobalLayoutAppliesTitleAppNameAndContent tests that wrapWithGlobalLayout
// resolves all placeholders and does not double-wrap.
func TestWrapWithGlobalLayout(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	wrapped := wrapWithGlobalLayout(app, "Special & Urgent", "<p>inner content</p>")
	if !strings.Contains(wrapped, "Special &amp; Urgent") {
		t.Fatalf("subject in title must be HTML-escaped, got:\n%s", wrapped)
	}
	if !strings.Contains(wrapped, "<p>inner content</p>") {
		t.Fatalf("inner content must appear verbatim in body, got:\n%s", wrapped)
	}
	if strings.Contains(wrapped, phTitle) || strings.Contains(wrapped, phContent) {
		t.Fatalf("all placeholders must be resolved, got:\n%s", wrapped)
	}

	// Idempotency: wrapping an already wrapped string must return it untouched.
	again := wrapWithGlobalLayout(app, "Another", wrapped)
	if again != wrapped {
		t.Fatal("wrapWithGlobalLayout must be idempotent and avoid double-wrapping")
	}
}
