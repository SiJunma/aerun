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
 * Strips active content from admin-supplied HTML (welcome banners,
 * maintenance messages) and returns a safe HTML string.
 *
 * The old implementation was two regexes: one tried to remove a whole
 * `<script>…</script>` span and one tried to erase `on*=` attributes. Both
 * were bypassable in ways an auditor can enumerate in minutes:
 *   - `<scr<script>ipt>alert(1)</script>` — a nested open tag defeated the
 *     span regex and injected a live script element;
 *   - `<style>`/`iframe`/`object`/`embed` tags were never removed at all,
 *     so an admin (or a compromised admin session) could redraw the whole
 *     page or embed an arbitrary document;
 *   - `href`/`src` attributes were never checked, so a `javascript:`
 *     link survived untouched;
 *   - the `on*=` regex required whitespace before `on`, so
 *     `onerror=` in a tag with no space before it, a tab, or a mis-nested
 *     quote was left alone.
 * And the result was still handed to `dangerouslySetInnerHTML`: anything the
 * regex missed reached the DOM as raw HTML.
 *
 * This version walks the DOM like the `[html]` sanitiser in
 * `src/components/common/BBCode.jsx` (`safeHtmlToReact`), but returns a
 * STRING, because these two surfaces render with
 * `dangerouslySetInnerHTML` rather than with a React tree. Two allowlists
 * (independent, deliberately duplicated — a shared helper would need
 * DOMParser on both sides and risk drift):
 *
 *   - ALLOWED_HTML_TAGS: a banner/notice never legitimately needs
 *     script/style/iframe/object/embed/form/input — the list matches the
 *     `[html]` whitelist minus nothing, so the two surfaces agree on
 *     what "safe markup" is.
 *   - ALLOWED_HTML_ATTRS: class/id/href/src/alt/title/width/height/style.
 *   - URL attributes go through isSafeHtmlUrl: http/https, a relative
 *     path, or a data:image/* image only. javascript:, vbscript:,
 *     data:text/html, blob:, file: … are stripped (the attribute is
 *     removed, not the tag).
 *   - `style` values that contain expression(, url( or javascript:
 *     are dropped wholesale rather than parsed — a style attribute
 *     cannot smuggle execution through its value.
 *
 * A tag not on the allowlist drops its whole subtree (children are never
 * re-walked out of a removed wrapper), and `on*` attributes are removed
 * unconditionally. On a parse error the function returns '' — never the
 * input — because a fallback that returns the input is an XSS when the
 * sanitiser is unavailable.
 */
export const sanitizeHtml = (rawHtml) => {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  if (typeof window === 'undefined') return '';

  let doc;
  try {
    doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  } catch {
    // A sanitiser that fails must not hand back the input.
    return '';
  }

  const ALLOWED_HTML_TAGS = new Set([
    'div', 'span', 'p', 'br', 'hr',
    'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'small', 'sub', 'sup',
    'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'code', 'q', 'cite',
    'section', 'article', 'header', 'footer', 'main', 'figure', 'figcaption'
  ]);
  const ALLOWED_HTML_ATTRS = new Set([
    'class', 'id', 'href', 'src', 'alt', 'title', 'width', 'height',
    'colspan', 'rowspan', 'type', 'style'
  ]);
  const URL_HTML_ATTRS = new Set(['href', 'src']);

  const isSafeHtmlUrl = (value) => {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (/^(?:\/|\.\/|\.\.\/)/.test(trimmed)) return true;
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!schemeMatch) return true;
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return true;
    if (scheme === 'data') {
      return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(trimmed);
    }
    return false;
  };

  const isSafeStyle = (value) => {
    if (typeof value !== 'string') return false;
    const lower = value.toLowerCase();
    return !lower.includes('expression(') && !lower.includes('url(') && !lower.includes('javascript:');
  };

  const walk = (node) => {
    const children = Array.from(node.childNodes || []);
    children.forEach((child) => {
      if (child.nodeType === 3) return; // text — keep as-is
      if (child.nodeType !== 1) {
        child.remove();
        return;
      }
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_HTML_TAGS.has(tag)) {
        child.remove(); // active/unknown tag — subtree goes with it
        return;
      }
      Array.from(child.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          child.removeAttribute(attr.name);
          return;
        }
        if (!ALLOWED_HTML_ATTRS.has(name)) {
          child.removeAttribute(attr.name);
          return;
        }
        if (URL_HTML_ATTRS.has(name) && !isSafeHtmlUrl(attr.value)) {
          child.removeAttribute(attr.name);
          return;
        }
        if (name === 'style' && !isSafeStyle(attr.value)) {
          child.removeAttribute(attr.name);
        }
      });
      walk(child);
    });
  };

  walk(doc.body);
  return doc.body.innerHTML;
};
