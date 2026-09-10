/**
 * Brevo Transactional Email Service
 * Uses native fetch (Node 18+) to communicate with Brevo REST API v3.
 */
const logger = require("firebase-functions/logger");

const BREVO_API_KEY = process.env.BREVO_API_KEY || "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";
const ROOT_ADMIN_EMAIL = process.env.ROOT_ADMIN_EMAIL || process.env.ADMIN_EMAIL || process.env.VITE_ADMIN_EMAIL || "sijunma116@gmail.com";
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || ROOT_ADMIN_EMAIL;
const SENDER_NAME = process.env.FORUM_NAME || "Aerun Forum";

/**
 * Sends a transactional email using Brevo v3 API
 */
async function sendBrevoEmail({ toEmail, toName, subject, htmlContent, textContent }) {
  if (!toEmail) return { success: false, reason: "No recipient email provided" };

  try {
    const payload = {
      sender: {
        name: SENDER_NAME,
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
      textContent: textContent || ""
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
      const errorData = await response.text();
      logger.error(`[Brevo API Error] ${response.status}: ${errorData}`);
      return { success: false, error: errorData };
    }

    const result = await response.json();
    logger.info(`[Brevo Email Sent] to=${toEmail} messageId=${result.messageId}`);
    return { success: true, messageId: result.messageId };
  } catch (err) {
    logger.error("[Brevo API Exception]", err);
    return { success: false, error: err.message };
  }
}

/**
 * Base email layout wrapper with modern Aerun dark styling
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
      background-color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
    }
    .wrapper {
      width: 100%;
      background-color: #0f172a;
      padding: 40px 0;
    }
    .container {
      max-width: 580px;
      margin: 0 auto;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }
    .header {
      padding: 28px 32px;
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%);
      border-bottom: 1px solid #4338ca;
      text-align: center;
    }
    .brand-title {
      color: #ffffff;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin: 0;
    }
    .body-content {
      padding: 32px;
      line-height: 1.6;
      font-size: 15px;
      color: #cbd5e1;
    }
    .highlight-box {
      background: #0f172a;
      border-left: 4px solid #6366f1;
      padding: 16px;
      border-radius: 6px;
      margin: 20px 0;
      color: #94a3b8;
      font-size: 14px;
      font-style: italic;
    }
    .btn-container {
      text-align: center;
      margin: 30px 0 10px;
    }
    .btn {
      display: inline-block;
      background: #4f46e5;
      color: #ffffff !important;
      font-weight: 600;
      font-size: 15px;
      padding: 12px 28px;
      text-decoration: none;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35);
    }
    .footer {
      padding: 20px 32px;
      background-color: #111827;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      border-top: 1px solid #1e293b;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
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
        <p style="margin: 0 0 6px;">You received this automated notification from ${forumName}.</p>
        <p style="margin: 0;">You can adjust your notification settings in your forum profile preferences.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderDmNotificationEmail({ recipientName, senderName, messageSnippet, forumUrl = "https://aerun-forum.web.app", forumName = "Aerun Forum" }) {
  const content = `
    <h2 style="color: #f8fafc; margin-top: 0; font-size: 18px;">New Personal Message</h2>
    <p>Hello <strong>${recipientName || "Traveler"}</strong>,</p>
    <p><strong>${senderName || "Someone"}</strong> has sent you a new direct message on ${forumName}:</p>
    <div class="highlight-box">
      "${messageSnippet || "..."}"
    </div>
    <p>Since you are currently offline, we wanted to ensure you do not miss this conversation.</p>
  `;
  return wrapEmailTemplate({
    title: `New Direct Message from ${senderName}`,
    content,
    ctaText: "Open Messages",
    ctaUrl: `${forumUrl}/messages`,
    forumName
  });
}

function renderTopicReplyEmail({ recipientName, authorName, topicTitle, postSnippet, topicUrl, forumName = "Aerun Forum" }) {
  const content = `
    <h2 style="color: #f8fafc; margin-top: 0; font-size: 18px;">New Reply in Subscribed Topic</h2>
    <p>Hello <strong>${recipientName || "Traveler"}</strong>,</p>
    <p><strong>${authorName || "Someone"}</strong> has posted a new reply in <strong>"${topicTitle}"</strong>:</p>
    <div class="highlight-box">
      ${postSnippet ? `"${postSnippet}"` : "New post submitted."}
    </div>
    <p>Click below to jump directly to the discussion.</p>
  `;
  return wrapEmailTemplate({
    title: `New reply in ${topicTitle}`,
    content,
    ctaText: "View Discussion",
    ctaUrl: topicUrl,
    forumName
  });
}

module.exports = {
  sendBrevoEmail,
  renderDmNotificationEmail,
  renderTopicReplyEmail
};
