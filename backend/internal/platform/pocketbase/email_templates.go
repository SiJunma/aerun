package pocketbase

// The global email wrapper: one design, resolved per send.
//
// Every mail this backend sends — auth (verification, password reset, email
// change) and notifications (DMs and topic replies now; mentions/quotes when
// they arrive) — must
// resolve its subject and body through loadEmailTemplates rather than carrying
// its own HTML. That is the rule written into .clinerules, and it exists
// because the alternative is how the design drifted in the first place:
// functions/email.js owned a beautiful wrapEmailTemplate that the PocketBase
// deploy never used.
//
// Priority — the same scheme SMTP settings use:
//
//  1. A value stored in forum_settings.email_templates (the admin panel) is
//     authoritative, per mail type, and is NEVER overwritten on restart.
//  2. Anything the stored map does not override falls back to the built-in
//     defaults compiled into this file — the verbatim port of the design in
//     functions/email.js.
//  3. A half-written stored entry (empty subject or body) keeps its default,
//     so a partial save can never produce a blank mail; corrupt JSON falls
//     back wholesale and is logged.
//
// Templates are authored as strings with brace placeholders ({TITLE},
// {APP_NAME}, {CONTENT} ...) rather than rendered here, because the resolution
// moment differs per delivery path: PocketBase resolves {APP_NAME} for auth
// mails it sends itself, while the outbox worker fills every placeholder
// itself when it renders a notification. Resolving at install time — the
// mistake the old {{ .Token }} rendering made — would freeze per-send values.
//
// The stored body IS the wrapper (plan section 3.1): a delivery path takes
// the template for its type, folds in the per-send placeholders and sends.
// Auth delivery is the exception that proves the rule: its content arrives
// already rendered by PocketBase inside PB's own layout, so it extracts the
// inner content and re-dresses it in aerunWrap (step 4 of the plan).

import (
	"encoding/json"
	"html/template"
	"regexp"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

const (
	// Wrapper-level placeholders. They live in defaultEmailWrapper and are
	// filled by whichever path delivers the mail — PB's own resolver for
	// auth mails, the outbox renderer for notifications.
	phTitle   = "{TITLE}"
	phContent = "{CONTENT}"

	// Content-level placeholders used by the default notification bodies.
	// Callers substitute them with escaped per-send values before sending.
	phRecipientName = "{RECIPIENT_NAME}"
	phSenderName    = "{SENDER_NAME}"
	phSnippet       = "{SNIPPET}"
	phMessagesURL   = "{MESSAGES_URL}"
	phTopicTitle    = "{TOPIC_TITLE}"
	phTopicURL      = "{TOPIC_URL}"
)

// emailTemplate is one mail type: its subject line and its HTML body — the
// design wrapper with the type's content and placeholders folded in.
type emailTemplate struct {
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

// emailTemplates is the whole map stored as forum_settings.email_templates.
// Keying by type (rather than one row per type) means a new kind of mail —
// mentions, quotes, topic replies — is a new JSON key, not a schema change.
type emailTemplates map[string]emailTemplate

// Notification template types. Auth types are deliberately absent: their
// content is rendered by PocketBase at send time and re-dressed by the
// OnMailerSend hook (step 5 of the plan), so a stored copy here would go
// stale. When a type stops being PB-rendered, it earns a key here.
const (
	emailTemplateWrapper    = "wrapper"
	emailTemplateDM         = "dm"
	emailTemplateTopicReply = "topic_reply"
)

// defaultEmailWrapper is the Go port of wrapEmailTemplate from
// functions/email.js — the same slate palette, the same 560px container, the
// same top-accent gradient, and the same .btn and .highlight-box the
// community already receives. Two deliberate differences from the JS:
//
//   - The JS injects title/forumName/content as call arguments; this is a
//     template string with {TITLE}/{APP_NAME}/{CONTENT} placeholders, because
//     nothing renders it at install time — the delivery path fills them per
//     send (see the file header).
//   - The JS appends a CTA block between content and footer when asked. A
//     static string cannot branch, so each type's content folds its own
//     <a class="btn"> in; the stylesheet defines .btn either way, which is
//     also what lets PB-rendered auth content keep its buttons when it is
//     re-dressed in this wrapper.
const defaultEmailWrapper = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>` + phTitle + `</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #334155;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #f1f5f9;
      padding: 40px 15px;
      box-sizing: border-box;
    }
    .container {
      max-width: 560px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 16px -2px rgba(15, 23, 42, 0.05);
    }
    .top-accent {
      height: 4px;
      background: linear-gradient(90deg, #4f46e5 0%, #38bdf8 100%);
    }
    .header {
      padding: 24px 32px 20px;
      background-color: #ffffff;
      border-bottom: 1px solid #f1f5f9;
      text-align: center;
    }
    .brand-title {
      color: #0f172a;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.2px;
      margin: 0;
    }
    .body-content {
      padding: 28px 32px;
      line-height: 1.6;
      font-size: 14px;
      color: #334155;
    }
    .body-content p {
      margin: 0 0 14px;
    }
    .highlight-box {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-left: 4px solid #4f46e5;
      padding: 14px 18px;
      border-radius: 6px;
      margin: 18px 0;
      color: #475569;
      font-size: 14px;
      font-style: italic;
      line-height: 1.5;
    }
    .btn-container {
      text-align: center;
      margin: 28px 0 8px;
    }
    .btn {
      display: inline-block;
      background-color: #4f46e5;
      color: #ffffff !important;
      font-weight: 600;
      font-size: 14px;
      padding: 11px 28px;
      text-decoration: none;
      border-radius: 8px;
      box-shadow: 0 2px 6px rgba(79, 70, 229, 0.25);
    }
    .footer {
      padding: 20px 32px;
      background-color: #f8fafc;
      text-align: center;
      font-size: 12px;
      color: #94a3b8;
      border-top: 1px solid #f1f5f9;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="top-accent"></div>
      <div class="header">
        <h1 class="brand-title">` + phAppName + `</h1>
      </div>
      <div class="body-content">
        ` + phContent + `
      </div>
      <div class="footer">
        <p style="margin: 0 0 4px;">You received this automated notification from ` + phAppName + `.</p>
        <p style="margin: 0;">You can adjust your notification preferences in your forum profile.</p>
      </div>
    </div>
  </div>
</body>
</html>`

// wrapWithWrapper folds inner content into a wrapper string.
func wrapWithWrapper(wrapper, inner string) string {
	return strings.Replace(wrapper, phContent, inner, 1)
}

// aerunWrap folds inner content into the default wrapper. The title and forum
// name stay as placeholders: who fills them depends on the delivery path (see
// the file header).
func aerunWrap(inner string) string {
	return wrapWithWrapper(defaultEmailWrapper, inner)
}

// defaultDMContent is the content block of renderDmNotificationEmail from
// functions/email.js, ported verbatim — same heading, same highlight-box, same
// "you will not get more mail until you read this" notice. The CTA that the
// JS wrapper appended conditionally is folded in here instead (the wrapper is
// a static string), pointing at the inbox via {MESSAGES_URL}.
const defaultDMContent = `
    <h2 style="color: #0f172a; margin: 0 0 16px; font-size: 17px; font-weight: 600;">New Personal Message</h2>
    <p>Hello <strong>` + phRecipientName + `</strong>,</p>
    <p><strong>` + phSenderName + `</strong> has sent you a direct message on ` + phAppName + `:</p>
    <div class="highlight-box">
      "` + phSnippet + `"
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 18px;">
      There may be additional unread messages in this conversation, but you will not receive further email notifications until you open your messages.
    </p>
    <div class="btn-container">
      <a href="` + phMessagesURL + `" class="btn" target="_blank" rel="noopener">Open Messages</a>
    </div>
  `

// defaultTopicReplyContent is the content block of renderTopicReplyEmail from
// functions/email.js, ported verbatim — same heading, same highlight-box, same
// "you will not get more mail until you visit the topic" notice, same
// "View Discussion" CTA (folded in here because the wrapper is a static
// string), pointing at the reply via {TOPIC_URL}.
const defaultTopicReplyContent = `
    <h2 style="color: #0f172a; margin: 0 0 16px; font-size: 17px; font-weight: 600;">New Reply in Subscribed Topic</h2>
    <p>Hello <strong>` + phRecipientName + `</strong>,</p>
    <p><strong>` + phSenderName + `</strong> has posted a new reply in <strong>"` + phTopicTitle + `"</strong>:</p>
    <div class="highlight-box">
      "` + phSnippet + `"
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 18px;">
      There may be other new replies in this topic, but you will not receive further email notifications until you visit the topic.
    </p>
    <div class="btn-container">
      <a href="` + phTopicURL + `" class="btn" target="_blank" rel="noopener">View Discussion</a>
    </div>
  `

// defaultEmailTemplatesWithWrapper builds default notification templates with
// the given HTML wrapper layout.
func defaultEmailTemplatesWithWrapper(wrapper string) emailTemplates {
	return emailTemplates{
		emailTemplateDM: {
			Subject: "New Direct Message from " + phSenderName,
			Body:    wrapWithWrapper(wrapper, defaultDMContent),
		},
		emailTemplateTopicReply: {
			Subject: "New reply in: " + phTopicTitle,
			Body:    wrapWithWrapper(wrapper, defaultTopicReplyContent),
		},
	}
}

// defaultEmailTemplates is what an untouched forum sends: the design from
// functions/email.js, out of the box, with no row in forum_settings yet.
func defaultEmailTemplates() emailTemplates {
	return defaultEmailTemplatesWithWrapper(defaultEmailWrapper)
}

// renderEmailFromTemplate folds the per-send values into one resolved
// template and returns the subject plus the wrapped HTML body.
//
// Escaping happens HERE, in one place, and asymmetrically on purpose: the
// body is HTML, so every value is escaped for it, while the subject is a
// header line where an escape like &amp; would be noise. Callers therefore
// pass RAW values — nicknames, titles, snippets — and never pre-escape.
//
// title feeds {TITLE} (the wrapper's <title>); appName feeds {APP_NAME},
// which the notification path must fill itself because PocketBase only
// resolves it for the auth mails it sends on its own. values are the
// content-level placeholders of the type ({RECIPIENT_NAME}, {SNIPPET}, ...).
func renderEmailFromTemplate(tpl emailTemplate, appName, title string, values map[string]string) (subject, bodyHTML string) {
	esc := template.HTMLEscapeString

	subjectPairs := []string{phTitle, title, phAppName, appName}
	bodyPairs := []string{phTitle, esc(title), phAppName, esc(appName)}
	for ph, val := range values {
		subjectPairs = append(subjectPairs, ph, val)
		bodyPairs = append(bodyPairs, ph, esc(val))
	}

	subject = strings.NewReplacer(subjectPairs...).Replace(tpl.Subject)
	bodyHTML = strings.NewReplacer(bodyPairs...).Replace(tpl.Body)
	return subject, bodyHTML
}

// loadEmailTemplates resolves the effective templates for this send.
//
// Priority (the plan's "global > default", the same scheme SMTP settings use):
//
//  1. forum_settings.email_templates, when present and parseable — per type,
//     and never written back by the server, so an admin's edit survives every
//     restart.
//  2. The built-in defaults from defaultEmailTemplates for anything the
//     stored map does not override.
//
// The overlay is per type rather than whole-map: a stored value that mentions
// only one type still gets the defaults for every other type, and an entry
// with an empty subject or body (a half-saved form) keeps its default instead
// of blanking the mail. Corrupt JSON falls back wholesale and is logged — a
// bad row must never stop delivery.
//
// The returned map is a fresh value per call; callers may fill its
// placeholders without coordinating with anyone else.
func loadEmailTemplates(app core.App) emailTemplates {
	wrapper := loadEmailWrapper(app)
	resolved := defaultEmailTemplatesWithWrapper(wrapper)

	if app == nil {
		return resolved
	}
	raw := strings.TrimSpace(loadForumSettings(app).EmailTemplates)
	if raw == "" || raw == "null" {
		// Fresh install: migration 1769300000 seeds "{}" and an untouched
		// forum must send exactly the design in functions/email.js.
		return resolved
	}
	var stored emailTemplates
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		app.Logger().Warn("forum_settings.email_templates is not valid JSON; using built-in defaults", "error", err)
		return resolved
	}
	for typ, tpl := range stored {
		if typ == emailTemplateWrapper {
			continue
		}
		if tpl.Subject == "" || tpl.Body == "" {
			// A half-saved entry would otherwise blank the type entirely.
			// Nothing stored means "keep the default", never "send nothing".
			continue
		}
		resolved[typ] = tpl
	}
	return resolved
}

// loadEmailWrapper resolves the effective global HTML email wrapper.
//
// Priority:
//  1. forum_settings.email_templates["wrapper"].Body when present, non-empty,
//     and containing the required {CONTENT} placeholder.
//  2. defaultEmailWrapper (the built-in design ported from functions/email.js).
func loadEmailWrapper(app core.App) string {
	if app == nil {
		return defaultEmailWrapper
	}
	raw := strings.TrimSpace(loadForumSettings(app).EmailTemplates)
	if raw == "" || raw == "null" {
		return defaultEmailWrapper
	}
	var stored emailTemplates
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return defaultEmailWrapper
	}
	if w, ok := stored[emailTemplateWrapper]; ok {
		body := strings.TrimSpace(w.Body)
		if body != "" && strings.Contains(body, phContent) {
			return body
		}
	}
	return defaultEmailWrapper
}

var bodyContentRegex = regexp.MustCompile(`(?is)<body[^>]*>(.*?)</body>`)

// extractBodyContent extracts the HTML between <body> and </body>.
// If no <body> tag is present, it returns the trimmed input as-is.
func extractBodyContent(htmlStr string) string {
	m := bodyContentRegex.FindStringSubmatch(htmlStr)
	if len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	return strings.TrimSpace(htmlStr)
}

// wrapWithGlobalLayout wraps inner HTML content into the effective global email
// wrapper, resolving {TITLE} and {APP_NAME}.
//
// Idempotency guard: if innerHTML is already dressed in the Aerun layout (contains
// the top accent bar or brand title marker), it is returned untouched to avoid
// recursive wrapping.
func wrapWithGlobalLayout(app core.App, subject, innerHTML string) string {
	if strings.Contains(innerHTML, "top-accent") {
		return innerHTML
	}
	wrapper := loadEmailWrapper(app)
	appName := effectiveAppName(app)

	esc := template.HTMLEscapeString
	replacer := strings.NewReplacer(
		phTitle, esc(subject),
		phAppName, esc(appName),
		phContent, innerHTML,
	)
	return replacer.Replace(wrapper)
}

// effectiveAppName returns the forum's brand name for mail headers.
func effectiveAppName(app core.App) string {
	if app == nil {
		return "Aerun"
	}
	if name := strings.TrimSpace(app.Settings().Meta.AppName); name != "" {
		return name
	}
	if name := forumName(app, "ru"); name != "" {
		return name
	}
	return "Aerun"
}
