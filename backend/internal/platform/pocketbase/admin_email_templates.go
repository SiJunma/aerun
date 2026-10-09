package pocketbase

// Admin email template management: GET/PUT/POST-test endpoints.
//
// The global email wrapper is the single design skin for every outgoing email
// the forum sends — auth (verification, password reset, email change) and
// notifications (DMs, topic replies). This file exposes it to the admin panel.
//
// Three endpoints under /api/aerun/admin/email-templates:
//
//   GET  — returns the effective wrapper, whether it is custom, and the
//          built-in default for "Reset to default" in the UI.
//   PUT  — validates and saves a new wrapper HTML into forum_settings.
//   POST /test — sends a test email to the requesting admin's own address
//          (not arbitrary recipients, preventing spam-relay misuse).
//
// All three are gated on PermAdminAccess and use enforceIdempotency for the
// mutating paths.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// getEmailTemplatesHandler returns the current effective email wrapper, a flag
// indicating whether it is a custom (admin-saved) one, and the built-in
// default wrapper for the "Reset to default" button.
func getEmailTemplatesHandler(e *core.RequestEvent) error {
	wrapper := loadEmailWrapper(e.App)
	isCustom := wrapper != defaultEmailWrapper

	return e.JSON(http.StatusOK, map[string]any{
		"wrapper":         wrapper,
		"is_custom":       isCustom,
		"default_wrapper": defaultEmailWrapper,
		"request_id":      requestIDFrom(e),
	})
}

// putEmailTemplatesHandler validates and saves a new global email wrapper.
//
// Validation:
//   - The wrapper must be a non-empty string.
//   - It MUST contain the {CONTENT} placeholder — without it, every email body
//     would be discarded.
//   - An empty string (or the exact text of the default) is treated as a reset:
//     the "wrapper" key is removed from the stored JSON, so loadEmailWrapper
//     falls back to defaultEmailWrapper.
func putEmailTemplatesHandler(e *core.RequestEvent) error {
	body := struct {
		Wrapper string `json:"wrapper"`
	}{}
	if err := e.BindBody(&body); err != nil {
		return validationError("invalid request body")
	}

	wrapper := strings.TrimSpace(body.Wrapper)

	// An empty wrapper or exact default means "reset": remove the custom
	// override so loadEmailWrapper returns defaultEmailWrapper.
	isReset := wrapper == "" || wrapper == defaultEmailWrapper

	if !isReset && !strings.Contains(wrapper, phContent) {
		return validationError("the wrapper must contain the {CONTENT} placeholder")
	}

	if err := e.App.RunInTransaction(func(txApp core.App) error {
		record, err := txApp.FindRecordById(forumSettingsCollectionName, forumSettingsID)
		if err != nil || record == nil {
			return internalError("forum settings row is missing", err)
		}

		// Read the existing email_templates JSON so we preserve any other
		// keys (dm, topic_reply) that may be stored there.
		raw := ""
		switch v := record.Get("email_templates").(type) {
		case string:
			raw = v
		case types.JSONRaw:
			raw = string(v)
		case []byte:
			raw = string(v)
		}

		var stored map[string]any
		if raw != "" && raw != "null" {
			if err := json.Unmarshal([]byte(raw), &stored); err != nil {
				stored = make(map[string]any)
			}
		}
		if stored == nil {
			stored = make(map[string]any)
		}

		if isReset {
			delete(stored, emailTemplateWrapper)
		} else {
			stored[emailTemplateWrapper] = map[string]any{
				"subject": "",
				"body":    wrapper,
			}
		}

		serialized, err := json.Marshal(stored)
		if err != nil {
			return internalError("failed to serialize email_templates", err)
		}
		record.Set("email_templates", types.JSONRaw(serialized))

		_ = recordAuditLog(txApp, "email_template_updated", e.Auth.Id, map[string]any{
			"action": map[bool]string{true: "reset", false: "custom"}[isReset],
		})

		return txApp.Save(record)
	}); err != nil {
		return internalError("failed to save email wrapper", err)
	}

	// Return the fresh effective state.
	newWrapper := loadEmailWrapper(e.App)
	return e.JSON(http.StatusOK, map[string]any{
		"wrapper":    newWrapper,
		"is_custom":  newWrapper != defaultEmailWrapper,
		"request_id": requestIDFrom(e),
	})
}

// testEmailTemplatesHandler sends a test email to the requesting admin's own
// email address, using the current effective wrapper.
//
// The recipient is ALWAYS the caller's email — never an arbitrary address.
// This prevents the endpoint from being used as a spam relay.
func testEmailTemplatesHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	adminEmail := e.Auth.Email()
	if adminEmail == "" {
		return validationError("your account has no email address")
	}

	wrapper := loadEmailWrapper(e.App)
	appName := effectiveAppName(e.App)

	subject := "Test email from " + appName
	testContent := `
    <h2 style="color: #0f172a; margin: 0 0 16px; font-size: 17px; font-weight: 600;">Test Email</h2>
    <p>Hello,</p>
    <p>This is a test email to verify your email template design. If you can see this message with the forum's styling (gradient accent bar, brand header, styled container), then your email wrapper is working correctly.</p>
    <div class="highlight-box">
      "This is a sample quoted text block, showing how highlights appear inside your email design."
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 18px;">
      This message was sent from the admin panel's email template editor. No action is required.
    </p>
    <div class="btn-container">
      <a href="#" class="btn" target="_blank" rel="noopener">Sample Button</a>
    </div>
  `

	replacer := strings.NewReplacer(
		phTitle, subject,
		phAppName, appName,
		phContent, testContent,
	)
	bodyHTML := replacer.Replace(wrapper)

	// Build a plain-text version.
	bodyText := "Test email from " + appName + "\n\n" +
		"This is a test email to verify your email template design.\n" +
		"If you received this, your email configuration is working correctly.\n"

	payload := MailPayload{
		RecipientID: e.Auth.Id,
		ToEmail:     adminEmail,
		Subject:     subject,
		BodyText:    bodyText,
		BodyHTML:    bodyHTML,
	}

	// Send directly via PocketBase's mail client rather than the outbox queue,
	// because the admin expects immediate feedback. The outbox is for
	// asynchronous notification delivery.
	sender := pocketBaseMailSender{app: e.App}
	if err := sender.Send(e.Request.Context(), payload); err != nil {
		// The mail infrastructure may be misconfigured (no SMTP relay, etc.).
		// Return a descriptive error so the admin knows what failed.
		return internalError("test email could not be sent — check SMTP configuration", err)
	}

	_ = recordAuditLog(e.App, "email_template_test_sent", e.Auth.Id, map[string]any{
		"to": adminEmail,
	})

	return e.JSON(http.StatusOK, map[string]any{
		"sent_to":    adminEmail,
		"request_id": requestIDFrom(e),
	})
}
