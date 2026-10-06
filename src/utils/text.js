/**
 * Resolves a multilingual field based on the current language.
 * Falls back to the alternative language if the preferred one is empty or missing.
 * @param {string|object} field - The field to resolve (either a string or an object {ru, en})
 * @param {string} lang - Current language code ('ru' or 'en')
 * @returns {string} - The resolved text
 */
export const resolveField = (field, lang) => {
  if (typeof field !== 'object' || field === null) {
    return field || '';
  }

  const { ru, en } = field;
  const preferred = lang === 'ru' ? ru : en;
  const fallback = lang === 'ru' ? en : ru;

  // Use the preferred language if it exists and is not just whitespace
  if (preferred && preferred.trim() !== '') {
    return preferred;
  }

  // Fallback to the alternative language
  return fallback || '';
};

/**
 * Strips scripts and inline event handlers from admin-supplied HTML
 * (welcome banners, maintenance messages). Returns '' for non-strings.
 */
export const sanitizeHtml = (rawHtml) => {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  let html = rawHtml;
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  html = html.replace(/\bon\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');
  return html;
};
