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
