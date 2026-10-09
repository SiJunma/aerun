/**
 * Brevo Transactional Email Service — DEPRECATED (read-only reference).
 *
 * Email delivery is now owned centrally by the PocketBase backend
 * (outbox_events + pocketBaseMailSender with the global wrapper from
 * forum_settings.email_templates). The two call sites in index.js
 * (topic-reply + DM notifications) are disabled to avoid duplicate sends.
 * This module is kept only as the design reference ported to Go
 * (backend/internal/platform/pocketbase/email_templates.go).
 * Uses native fetch (Node 18+) to communicate with Brevo REST API v3.
 */
const logger = require("firebase-functions/logger");

// Delivery credentials must only exist in the Functions/VPS secret store.
// Never add fallback API keys here: source control is not a secret manager.
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "";
const SENDER_NAME = process.env.FORUM_NAME || "Aerun Forum";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sends a transactional email using Brevo v3 API
 */
async function sendBrevoEmail({ toEmail, toName, subject, htmlContent, textContent, senderName }) {
  if (!toEmail) return { success: false, reason: "No recipient email provided" };
  if (!BREVO_API_KEY || !SENDER_EMAIL) {
    // Email delivery is deliberately best-effort. Callers must never make a
    // forum mutation depend on an SMTP/provider configuration being present.
    logger.warn("[Email delivery disabled] BREVO_API_KEY or BREVO_SENDER_EMAIL is not configured");
    return { success: false, reason: "email_delivery_not_configured" };
  }

  try {
    const plainText = (textContent && textContent.trim())
      ? textContent.trim()
      : (subject || "Notification from Aerun Forum");

    const fromName = (senderName && senderName.trim()) ? senderName.trim() : SENDER_NAME;

    const payload = {
      sender: {
        name: fromName,
        email: SENDER_EMAIL
      },
      to: [
        {
          email: toEmail,
          name: toName || toEmail.split("@")[0]
        }
      ],
      subject: subject,
      htmlContent: htmlContent,
      textContent: plainText
    };

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      logger.error(`[Brevo API Error] status=${response.status}`);
      return { success: false, reason: "provider_rejected_request", status: response.status };
    }

    const result = await response.json();
    logger.info(`[Brevo Email Sent] messageId=${result.messageId}`);
    return { success: true, messageId: result.messageId };
  } catch (err) {
    logger.error("[Brevo API Exception]", err);
    return { success: false, reason: "provider_unavailable" };
  }
}

/**
 * Base email layout wrapper with modern clean light styling
 */
function wrapEmailTemplate({ title, content, ctaText, ctaUrl, forumName = "Aerun Forum" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
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
        <h1 class="brand-title">${forumName}</h1>
      </div>
      <div class="body-content">
        ${content}
        ${ctaText && ctaUrl ? `
          <div class="btn-container">
            <a href="${ctaUrl}" class="btn" target="_blank">${ctaText}</a>
          </div>
        ` : ""}
      </div>
      <div class="footer">
        <p style="margin: 0 0 4px;">You received this automated notification from ${forumName}.</p>
        <p style="margin: 0;">You can adjust your notification preferences in your forum profile.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderDmNotificationEmail({ recipientName, senderName, messageSnippet, forumUrl = "https://aerun-forum.web.app", forumName = "Aerun Forum" }) {
  const safeRecipientName = escapeHtml(recipientName || "Traveler");
  const safeSenderName = escapeHtml(senderName || "Someone");
  const safeForumName = escapeHtml(forumName);
  const safeSnippet = escapeHtml(messageSnippet || "...");
  const content = `
    <h2 style="color: #0f172a; margin: 0 0 16px; font-size: 17px; font-weight: 600;">New Personal Message</h2>
    <p>Hello <strong>${safeRecipientName}</strong>,</p>
    <p><strong>${safeSenderName}</strong> has sent you a direct message on ${safeForumName}:</p>
    <div class="highlight-box">
      "${safeSnippet}"
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 18px;">
      There may be additional unread messages in this conversation, but you will not receive further email notifications until you open your messages.
    </p>
  `;
  return wrapEmailTemplate({
    title: `New Direct Message from ${safeSenderName}`,
    content,
    ctaText: "Open Messages",
    ctaUrl: `${forumUrl}/messages`,
    forumName: safeForumName
  });
}

function renderTopicReplyEmail({ recipientName, authorName, topicTitle, postSnippet, topicUrl, forumName = "Aerun Forum" }) {
  const safeRecipientName = escapeHtml(recipientName || "Traveler");
  const safeAuthorName = escapeHtml(authorName || "Someone");
  const safeTopicTitle = escapeHtml(topicTitle || "Discussion");
  const safeForumName = escapeHtml(forumName);
  const safeSnippet = escapeHtml(postSnippet || "New post submitted.");
  const content = `
    <h2 style="color: #0f172a; margin: 0 0 16px; font-size: 17px; font-weight: 600;">New Reply in Subscribed Topic</h2>
    <p>Hello <strong>${safeRecipientName}</strong>,</p>
    <p><strong>${safeAuthorName}</strong> has posted a new reply in <strong>"${safeTopicTitle}"</strong>:</p>
    <div class="highlight-box">
      "${safeSnippet}"
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 18px;">
      There may be other new replies in this topic, but you will not receive further email notifications until you visit the topic.
    </p>
  `;
  return wrapEmailTemplate({
    title: `New reply in ${safeTopicTitle}`,
    content,
    ctaText: "View Discussion",
    ctaUrl: topicUrl,
    forumName: safeForumName
  });
}

module.exports = {
  sendBrevoEmail,
  renderDmNotificationEmail,
  renderTopicReplyEmail
};
