// Syntax validation helpers for custom design HTML (headerHtml), CSS, and JS.
// Pure JS (no heavy parser bundles) so save-time validation runs synchronously
// while CodeMirror + js-beautify stay lazy-loaded inside CodeEditor.jsx.

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

function formatLineError(t, line, message) {
  if (line && line > 0) {
    return t('admin.designs.validation_line')
      .replace('{line}', String(line))
      .replace('{message}', message);
  }
  return message;
}

function findUnclosedJsTokenLine(code) {
  const stack = [];
  let line = 1;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let blockCommentLine = 1;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '\n') {
      line += 1;
      inLineComment = false;
      i += 1;
      continue;
    }

    if (inLineComment) {
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (inTemplate) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') {
        inTemplate = false;
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        stack.push({ char: '${', line });
        inTemplate = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      blockCommentLine = line;
      i += 2;
      continue;
    }

    if (ch === "'") { inSingle = true; i += 1; continue; }
    if (ch === '"') { inDouble = true; i += 1; continue; }
    if (ch === '`') { inTemplate = true; i += 1; continue; }

    if (ch === '{' || ch === '(' || ch === '[') {
      stack.push({ char: ch, line });
    } else if (ch === '}' || ch === ')' || ch === ']') {
      const top = stack[stack.length - 1];
      if (top && top.char === '${' && ch === '}') {
        stack.pop();
        inTemplate = true;
      } else if (
        top &&
        ((top.char === '{' && ch === '}') ||
          (top.char === '(' && ch === ')') ||
          (top.char === '[' && ch === ']'))
      ) {
        stack.pop();
      } else {
        return line;
      }
    }
    i += 1;
  }

  if (inBlockComment) return blockCommentLine;
  if (stack.length > 0) return stack[stack.length - 1].line;
  return line;
}

function findJsSyntaxLine(code, err) {
  if (typeof err?.lineNumber === 'number' && err.lineNumber > 2) {
    return err.lineNumber - 2;
  }

  const lines = code.split('\n');
  if (lines.length <= 1) return 1;

  if (/end of input|unterminated/i.test(err?.message || '')) {
    return findUnclosedJsTokenLine(code);
  }

  // Binary search the first prefix whose parse fails for a non-EOF reason.
  let lo = 1;
  let hi = lines.length;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const prefix = lines.slice(0, mid).join('\n');
    try {
      new Function(prefix);
      lo = mid + 1;
    } catch (prefixErr) {
      if (/end of input/i.test(prefixErr?.message || '')) {
        lo = mid + 1;
      } else {
        found = mid;
        hi = mid - 1;
      }
    }
  }
  return found ?? findUnclosedJsTokenLine(code);
}

export function validateJavaScript(code, t) {
  if (!code || !code.trim()) return null;
  try {
    new Function(code);
    return null;
  } catch (err) {
    const line = findJsSyntaxLine(code, err);
    const rawMsg = err?.message || 'SyntaxError';
    const msg = t('admin.designs.validation_js_syntax').replace('{message}', rawMsg);
    return {
      severity: 'error',
      line,
      message: formatLineError(t, line, msg),
    };
  }
}

export function validateHtml(code, t) {
  if (!code || !code.trim()) return null;

  const stack = [];
  let i = 0;
  let line = 1;
  const len = code.length;

  const advance = (toIndex) => {
    for (let k = i; k < toIndex; k += 1) {
      if (code[k] === '\n') line += 1;
    }
    i = toIndex;
  };

  while (i < len) {
    const lt = code.indexOf('<', i);
    if (lt === -1) break;
    advance(lt);

    // HTML comment: <!-- ... -->
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      if (end === -1) {
        return {
          severity: 'error',
          line,
          message: formatLineError(t, line, t('admin.designs.validation_html_malformed_tag')),
        };
      }
      advance(end + 3);
      continue;
    }

    // Doctype / declaration / processing instruction: <!...> or <?...>
    if (code[i + 1] === '!' || code[i + 1] === '?') {
      const gt = code.indexOf('>', i + 2);
      if (gt === -1) {
        return {
          severity: 'error',
          line,
          message: formatLineError(t, line, t('admin.designs.validation_html_malformed_tag')),
        };
      }
      advance(gt + 1);
      continue;
    }

    // Parse tag until matching '>' respecting quoted attribute values.
    const tagStartLine = line;
    let j = i + 1;
    let quote = null;
    while (j < len) {
      const ch = code[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }

    if (j >= len) {
      return {
        severity: 'error',
        line: tagStartLine,
        message: formatLineError(t, tagStartLine, t('admin.designs.validation_html_malformed_tag')),
      };
    }

    const rawInside = code.slice(i + 1, j).trim();
    advance(j + 1);

    if (!rawInside) continue;

    const isClosing = rawInside.startsWith('/');
    const isSelfClosing = !isClosing && rawInside.endsWith('/');
    const nameMatch = rawInside.match(/^\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!nameMatch) continue;

    const tagName = nameMatch[1].toLowerCase();

    if (isClosing) {
      if (VOID_HTML_TAGS.has(tagName)) continue;
      if (stack.length === 0) {
        const msg = t('admin.designs.validation_html_unexpected_close').replace('{tag}', tagName);
        return {
          severity: 'error',
          line: tagStartLine,
          message: formatLineError(t, tagStartLine, msg),
        };
      }
      const top = stack[stack.length - 1];
      if (top.tag !== tagName) {
        const msg = t('admin.designs.validation_html_mismatch')
          .replace('{found}', tagName)
          .replace('{expected}', top.tag);
        return {
          severity: 'error',
          line: tagStartLine,
          message: formatLineError(t, tagStartLine, msg),
        };
      }
      stack.pop();
      continue;
    }

    // Raw text elements (<script>, <style>): skip content until matching close tag.
    if (!isSelfClosing && (tagName === 'script' || tagName === 'style')) {
      const closeRe = new RegExp(`<\\/${tagName}\\s*>`, 'i');
      const rest = code.slice(i);
      const closeMatch = closeRe.exec(rest);
      if (!closeMatch) {
        const msg = t('admin.designs.validation_html_unclosed_tag').replace('{tag}', tagName);
        return {
          severity: 'error',
          line: tagStartLine,
          message: formatLineError(t, tagStartLine, msg),
        };
      }
      advance(i + closeMatch.index + closeMatch[0].length);
      continue;
    }

    if (!isSelfClosing && !VOID_HTML_TAGS.has(tagName)) {
      stack.push({ tag: tagName, line: tagStartLine });
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    const msg = t('admin.designs.validation_html_unclosed_tag').replace('{tag}', unclosed.tag);
    return {
      severity: 'error',
      line: unclosed.line,
      message: formatLineError(t, unclosed.line, msg),
    };
  }

  return null;
}

export function validateCss(code, t) {
  if (!code || !code.trim()) return null;

  const braceStack = [];
  let line = 1;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let commentLine = 1;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }

    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inComment = true;
      commentLine = line;
      i += 2;
      continue;
    }

    if (ch === "'") { inSingle = true; i += 1; continue; }
    if (ch === '"') { inDouble = true; i += 1; continue; }

    if (ch === '{') {
      braceStack.push(line);
    } else if (ch === '}') {
      if (braceStack.length === 0) {
        return {
          severity: 'warning',
          line,
          message: formatLineError(t, line, t('admin.designs.validation_css_unexpected_brace')),
        };
      }
      braceStack.pop();
    }
    i += 1;
  }

  if (inComment) {
    return {
      severity: 'warning',
      line: commentLine,
      message: formatLineError(t, commentLine, t('admin.designs.validation_css_unclosed_comment')),
    };
  }

  if (braceStack.length > 0) {
    const openLine = braceStack[braceStack.length - 1];
    return {
      severity: 'warning',
      line: openLine,
      message: formatLineError(t, openLine, t('admin.designs.validation_css_unclosed_brace')),
    };
  }

  if (typeof CSSStyleSheet !== 'undefined' && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(code);
    } catch (err) {
      const msg = t('admin.designs.validation_css_syntax').replace('{message}', err?.message || 'Invalid CSS');
      return {
        severity: 'warning',
        line: 1,
        message: formatLineError(t, 1, msg),
      };
    }
  }

  return null;
}

export function validateCode(language, code, t) {
  if (language === 'javascript') return validateJavaScript(code, t);
  if (language === 'html') return validateHtml(code, t);
  if (language === 'css') return validateCss(code, t);
  return null;
}
