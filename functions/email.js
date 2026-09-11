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
async function sendBrevoEmail({ toEmail, toName, subject, htmlContent, textContent, senderName }) {
  if (!toEmail) return { success: false, reason: "No recipient email provided" };

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
  const content = `
    <h2 style="color: #0f172a; margin: 0 0 16px; font-size: 17px; font-weight: 600;">New Personal Message</h2>
    <p>Hello <strong>${recipientName || "Traveler"}</strong>,</p>
    <p><strong>${senderName || "Someone"}</strong> has sent you a direct message on ${forumName}:</p>
    <div class="highlight-box">
      "${messageSnippet || "..."}"
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 18px;">
      There may be additional unread messages in this conversation, but you will not receive further email notifications until you open your messages.
    </p>
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
    <h2 style="color: #0f172a; margin: 0 0 16px; font-size: 17px; font-weight: 600;">New Reply in Subscribed Topic</h2>
    <p>Hello <strong>${recipientName || "Traveler"}</strong>,</p>
    <p><strong>${authorName || "Someone"}</strong> has posted a new reply in <strong>"${topicTitle}"</strong>:</p>
    <div class="highlight-box">
      ${postSnippet ? `"${postSnippet}"` : "New post submitted."}
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 18px;">
      There may be other new replies in this topic, but you will not receive further email notifications until you visit the topic.
    </p>
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
