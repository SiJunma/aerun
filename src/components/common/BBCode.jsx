import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Copy, Dices, EyeOff, Reply } from 'lucide-react';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import { ALL_SMILES_MAP } from '../../config/smiles';

/**
 * BBCode Component
 * 
 * A highly robust, single-pass stack-based BBCode parser.
 * Handles nested tags, custom parameters, and flexible tag syntax.
 * 
 * BBCode Rendering & Spacing Rules:
 * --------------------------------
 * 1. White-space: 'pre-wrap'
 *    The entire content is rendered with pre-wrap to preserve user formatting and line breaks.
 * 
 * 2. Block Tag Absorption (preprocessNodes)
 *    Tags like [quote], [list], [spoiler], [columns], etc. are "Block Tags".
 *    To prevent double spacing in the editor (where users hit Enter before/after 
 *    a block), we "absorb" ONE newline (\n) appearing immediately before or 
 *    after a Block Tag.
 * 
 * 3. Indentation & Red Lines (preserved)
 *    Only actual line breaks (\n) are absorbed. Horizontal whitespace (spaces/tabs) 
 *    is PRESERVED to allow for manual paragraph indentation (красные строки).
 * 
 * 4. Nested Blocks
 *    Spacing absorption is applied recursively. A block tag inside another block 
 *    tag will also have its surrounding newlines absorbed to maintain flush alignment.
 * 
 * 5. Alignment Tags
 *    [left], [center], [right], [justify] are block-level wrappers that use 
 *    standard Bootstrap text-alignment classes.
 */

const BBCodeSpoiler = ({ title, children, t }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={`bbcode-spoiler my-2 ${isOpen ? 'is-open' : ''}`}>
      <div
        className="bbcode-spoiler-header d-flex align-items-center justify-content-between gap-2"
        onClick={() => setIsOpen(!isOpen)}
        style={{ cursor: 'pointer' }}
      >
        <span className="spoiler-title fw-bold small">
          {title || t('bbcode.spoiler_default')}
        </span>
        <span className="spoiler-icon opacity-50">
          {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </span>
      </div>
      {isOpen && (
        <div className="bbcode-spoiler-content p-2">
          {children}
        </div>
      )}
    </div>
  );
};

const ColumnsStacker = ({ children, stackAt }) => {
  const [isStacked, setIsStacked] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const val = parseInt(stackAt, 10);
    if (!val || isNaN(val)) {
      setTimeout(() => setIsStacked(false), 0);
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // IMPORTANT: Avoid stacking if width is 0 (initial/hidden state)
        if (entry.contentRect.width > 0) {
          setIsStacked(entry.contentRect.width < val);
        }
      }
    });

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [stackAt]);

  return (
    <div
      ref={containerRef}
      className={`bbcode-columns ${isStacked ? 'stacked-forced' : ''}`}
      style={{
        display: 'flex',
        flexDirection: isStacked ? 'column' : 'row',
        gap: '1rem',
        width: '100%'
      }}
    >
      {children}
    </div>
  );
};

/**
 * isTrustedAdminRole — is this role id entitled to raw `[html]` execution
 * (SEC-02, owner-approved role model)?
 *
 * This is the ONLY allowlist: `root` and `admin` — the trusted roles.
 * Custom roles are deliberately NOT included: a granted permission is
 * revocable state, while the role id here is who the account was authored
 * as. The earlier implementation compared against the VIEWER's own role
 * (profile) rather than the AUTHOR's, so any member who could view a post
 * could also see its raw script execution.
 */
const isTrustedAdminRole = (roleId) => {
  return roleId === 'root' || roleId === 'admin';
};

// --- SEC-02: strict, whitelist-based sanitisation of `[html]` content ---
//
// The old walk trusted arbitrary tags from anyone: it only skipped `script`
// and `noscript`, and it passed through `on*` handlers after stripping the
// `javascript:` prefix from a handful of URL attributes. A player could
// inject `<style>` to redraw the forum layout, `<iframe src="...">` to
// embed an arbitrary page, or `<img onerror>` routed through a `data:` URL.
// DOMParser makes the traversal total, so the correct shape is a WHITELIST:
// a tag or attribute that is not listed is dropped, never evaluated.
//
//   - ALLOWED_TAGS: presentational tags a role-play forum legitimately
//     needs. Everything raw-active (script, style, iframe, object, embed,
//     meta, link, form, input, button, textarea, select, base, audio, video,
//     source, track, svg, math, template) is simply not in the list.
//   - ALLOWED_ATTRS: the presentation surface only (class, id, href, src,
//     alt, title, width, height, style, colspan, rowspan, type). No event
//     handler, no `srcdoc`, no `formaction`, no `xlink:href`.
//   - URL attributes (href/src) go through isSafeUrl: a non-allowlisted
//     scheme is dropped (javascript:, vbscript:, data:text/html, blob:,
//     file:, ftp:, mailto:, tel: …). `data:image/*` is allowed for inline
//     images ONLY because the avatar pipeline stores them.
//   - `style` values are parsed by parseStyleString AND filtered: a value
//     containing expression(), a bare url(, or a javascript: token is
//     dropped, so the CSS parser never sees an execution attempt.
const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'small', 'sub', 'sup',
  'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'q', 'cite',
  'section', 'article', 'header', 'footer', 'main', 'figure', 'figcaption'
]);
const ALLOWED_ATTRS = new Set([
  'class', 'id', 'href', 'src', 'alt', 'title', 'width', 'height',
  'colspan', 'rowspan', 'type', 'style'
]);
const URL_ATTRS = new Set(['href', 'src']);

/**
 * isSafeUrl(value) — is this attribute value safe to render as href/src?
 *
 * The raw scheme is tested, never resolved against a base URI: trim,
 * case-fold, then allow http/https, a relative path, or a data:image/*
 * image. Everything else (javascript:, vbscript:, data:text/html, blob:,
 * file:, ftp:, mailto:, tel:, …) is dropped — the attribute is removed,
 * not the tag.
 */
const isSafeUrl = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:\/|\.\/|\.\.\/)/.test(trimmed)) return true;
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return true; // no scheme — a relative path or bare host
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') return true;
  if (scheme === 'data') {
    return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(trimmed);
  }
  return false;
};

/**
 * parseStyleString(styleStr) — parse a style attribute into a React style
 * object, dropping declarations whose VALUE would smuggle execution
 * (expression(, url(, javascript:) rather than passing the raw string to
 * React. The old version handed the whole value through unexamined, so
 * `style="x:expression(alert(1))"` reached the DOM.
 */
const parseStyleString = (styleStr) => {
  if (!styleStr) return {};
  const styleObj = {};
  const declarations = styleStr.split(';');
  declarations.forEach(decl => {
    const trimmed = decl.trim();
    if (!trimmed) return;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) return;
    const property = trimmed.substring(0, colonIdx).trim();
    const value = trimmed.substring(colonIdx + 1).trim();
    if (!property || !value) return;

    const lowerValue = value.toLowerCase();
    if (lowerValue.includes('expression(') || lowerValue.includes('url(') || lowerValue.includes('javascript:')) {
      return; // offending declaration — drop it, keep the rest of the style
    }

    const camelProperty = property.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    styleObj[camelProperty] = value;
  });
  return styleObj;
};

/**
 * safeHtmlToReact(htmlStr, index, isAdminAuthor) — render `[html]` content
 * through the whitelist sanitiser (SEC-02).
 *
 *   - `isAdminAuthor === true`: the AUTHOR's role is root/admin, so the post
 *     may embed script/style/iframe (media, widgets, custom styling). The
 *     whitelist still applies to attributes: even trusted JS must arrive as
 *     a tag, not as an `on*` handler or a javascript: URL trick.
 *   - otherwise: strict whitelist. A tag not in ALLOWED_TAGS drops its
 *     whole subtree — there is no safe way to grow content out of an
 *     unlisted wrapper, and the children of a removed node are never
 *     re-walked.
 *
 * Failure mode: if the parser throws, render NOTHING rather than the raw
 * string. Returning raw HTML on error was the old fallback and re-opened
 * the injection window precisely when the sanitiser was unavailable.
 */
const safeHtmlToReact = (htmlStr, index, isAdminAuthor) => {
  if (typeof htmlStr !== 'string') return null;
  if (typeof window === 'undefined') return null;

  const admin = isAdminAuthor === true;

  // [html] — сырой HTML. Переносы строк между тегами не имеют визуального
  // смысла (браузер их схлопывает), но при рендере в React они становятся
  // текстовыми узлами, которые могут быть прямыми детьми <tr>, <table>,
  // <ul> и т.д. — это ломает hydration. Удаляем все whitespace-only
  // текстовые узлы из дерева (кроме <pre>, <textarea>, <script>, <style>,
  // где переносы значимы).
  const stripWhitespaceTextNodes = (node) => {
    if (node.nodeType === 1) {
      const tagName = node.tagName.toLowerCase();
      const preserveWhitespace = ['pre', 'textarea', 'script', 'style'].includes(tagName);
      if (!preserveWhitespace) {
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
          const child = node.childNodes[i];
          if (child.nodeType === 3 && /^\s*$/.test(child.textContent)) {
            node.removeChild(child);
          } else {
            stripWhitespaceTextNodes(child);
          }
        }
      }
    }
    return node;
  };

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlStr, 'text/html');

    const domNodeToReact = (domNode, key) => {
      // Text Node
      if (domNode.nodeType === 3) {
        return domNode.textContent;
      }
      // Element Node
      if (domNode.nodeType === 1) {
        const tagName = domNode.tagName.toLowerCase();

        // Trusted roles: style/script/iframe pass through verbatim.
        if (admin && tagName === 'style') {
          return <style key={key} dangerouslySetInnerHTML={{ __html: domNode.textContent }} />;
        }
        if (admin && tagName === 'script') {
          return <script key={key} dangerouslySetInnerHTML={{ __html: domNode.textContent }} />;
        }
        if (admin && tagName === 'iframe') {
          const src = domNode.getAttribute('src') || '';
          if (!isSafeUrl(src)) return null;
          const title = domNode.getAttribute('title') || 'embedded media';
          return <iframe key={key} src={src} title={title} />;
        }

        // Everyone else (and the tags above when not admin):
        if (!ALLOWED_TAGS.has(tagName)) return null;

        const attribs = { key };
        for (let i = 0; i < domNode.attributes.length; i++) {
          const attr = domNode.attributes[i];
          const attrName = attr.name.toLowerCase();
          const attrValue = attr.value;

          if (attrName.startsWith('on')) continue;
          if (!ALLOWED_ATTRS.has(attrName)) continue;

          if (URL_ATTRS.has(attrName) && !isSafeUrl(attrValue)) continue;

          let reactAttrName = attrName;
          if (attrName === 'class') reactAttrName = 'className';
          else if (attrName === 'for') reactAttrName = 'htmlFor';
          else if (attrName === 'contenteditable') reactAttrName = 'contentEditable';

          if (attrName === 'style') {
            attribs.style = parseStyleString(attrValue);
            continue;
          }

          attribs[reactAttrName] = attrValue;
        }

        const childNodes = Array.from(domNode.childNodes);
        const reactChildren = childNodes.map((child, i) => domNodeToReact(child, `${key}-${i}`)).filter(Boolean);

        return React.createElement(tagName, attribs, ...reactChildren);
      }
      return null;
    };

    const bodyChildren = Array.from(doc.body.childNodes).map(node =>
      stripWhitespaceTextNodes(node)
    );
    const elements = bodyChildren.map((child, i) => domNodeToReact(child, `${index}-${i}`)).filter(Boolean);
    return <React.Fragment key={index}>{elements}</React.Fragment>;
  } catch (err) {
    console.error('HTML parse error:', err);
    return null;
  }
};

/**
 * Одиночный блок кода [code][/code] со своим состоянием копирования.
 * Каждый экземпляр имеет независимое состояние `copied`, поэтому нажатие
 * на одну кнопку не затрагивает остальные блоки кода в том же посте.
 */
const CodeBlock = ({ rawText, t, showToast }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      showToast(t('bbcode.code_copied', 'Код скопирован'), 'success');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast(t('bbcode.code_copy_failed', 'Не удалось скопировать'), 'error');
    }
  };

  return (
    <div className="bbcode-code-wrapper">
      <pre className="bbcode-code">
        {rawText}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="bbcode-copy-btn"
        aria-label={t('bbcode.code_copy', 'Копировать код')}
        title={copied ? t('bbcode.code_copied', 'Код скопирован') : t('bbcode.code_copy', 'Копировать код')}
      >
        {copied ? (
          <span className="bbcode-copy-check">✓</span>
        ) : (
          <Copy size={13} strokeWidth={1.8} />
        )}
      </button>
    </div>
  );
};

const BBCode = ({ children, rolls = {}, isDM = false, authorId, authorRole }) => {
  const navigate = useNavigate();
  const { user, profile, hasPermission, PERMISSIONS, settings } = useAuth() || {};
  const { t } = useI18n();
  const { showToast } = useToast();
  if (typeof children !== 'string') return children;

  // 0. Preprocess text to wrap smile shortcodes into [smile] tags
  // We use a single regex to avoid overlapping matches and multi-pass issues
  const sortedCodes = Object.keys(ALL_SMILES_MAP).sort((a, b) => b.length - a.length);
  const smileRegex = new RegExp(sortedCodes.map(code => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

  const textWithSmiles = children.replace(smileRegex, (match, offset, fullText) => {
    // Check if it's already wrapped in [smile] tags (user manually typed it)
    const before = fullText.substring(0, offset);
    const after = fullText.substring(offset + match.length);
    if (before.endsWith('[smile]') && after.startsWith('[/smile]')) {
      return match;
    }
    return `[smile]${match}[/smile]`;
  });

  // 1. Tokenize the text into text chunks and tags
  const tokenRegex = /\[(\/?)([a-zA-Z0-9_*]+)(?:[\s=]([^\]]*))?\]/g;
  const tokens = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(textWithSmiles)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', content: textWithSmiles.substring(lastIndex, match.index) });
    }
    tokens.push({
      type: 'tag',
      isClosing: match[1] === '/',
      name: match[2].toLowerCase(),
      rawParams: (match[3] || '').trim(),
      full: match[0]
    });
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < textWithSmiles.length) {
    tokens.push({ type: 'text', content: textWithSmiles.substring(lastIndex) });
  }

  // 2. Build a tree structure using a stack
  const root = { type: 'root', children: [] };
  const stack = [root];
  const supportedTags = ['b', 'i', 'u', 's', 'strike', 'del', 'quote', 'list', '*', 'url', 'img', 'color', 'size', 'columns', 'col', 'dice', 'roll', 'spoiler', 'video', 'youtube', 'media', 'hide', 'hide_secured', 'hr', 'smile', 'code', 'sup', 'sub', 'abbr', 'html', 'align', 'left', 'center', 'right', 'justify', 'table', 'tr', 'td'];

  tokens.forEach(token => {
    let parent = stack[stack.length - 1];
    if (token.type === 'text') {
      parent.children.push(token.content);
    } else {
      if (!supportedTags.includes(token.name)) {
        parent.children.push(token.full);
      } else if (token.isClosing) {
        let foundIdx = -1;
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === token.name) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx !== -1) {
          while (stack.length > foundIdx) stack.pop();
        } else {
          parent.children.push(token.full);
        }
      } else {
        if (token.name === '*') {
          // Robust list item handling: pop until we find the nearest 'list' parent
          let foundList = false;
          for (let i = stack.length - 1; i > 0; i--) {
            if (stack[i].name === 'list') {
              foundList = true;
              while (stack.length > i + 1) stack.pop();
              break;
            }
          }
          if (!foundList) {
            parent.children.push(token.full);
            return;
          }
          // Update parent after potential stack pop
          parent = stack[stack.length - 1];
        }
        const newNode = { type: 'tag', name: token.name, rawParams: token.rawParams, rawTag: token.full, children: [] };
        parent.children.push(newNode);
        // Dice, Roll, and HR are self-closing tags (they don't have [/dice] or [/roll] or [/hr])
        if (token.name !== 'dice' && token.name !== 'roll' && token.name !== 'hr') {
          stack.push(newNode);
        }
      }
    }
  });

  // 3. Spacing Optimization (Absorption of newlines around block tags)
  // `dice` and `roll` are DELIBERATELY ABSENT here: they are self-closing
  // inline-block chips, not block containers. Absorbing the newline after
  // them glued the following text to the chip (the "[dice=6]\nтекст" report):
  // with white-space:pre-wrap the break must survive, so a tag authored on
  // its own line keeps its own line.
  const blockTags = ['quote', 'list', '*', 'columns', 'col', 'spoiler', 'video', 'youtube', 'media', 'hr', 'align', 'left', 'center', 'right', 'justify', 'code', 'html', 'hide', 'hide_secured', 'table', 'tr'];
  // `insideCode` — когда мы внутри [code][/code], переносы строк и пустые
  // строки являются значимым содержимым и НЕ должны вырезаться.
  function preprocessNodes(nodes, insideCode = false) {
    const result = [...nodes];
    for (let i = 0; i < result.length; i++) {
      const node = result[i];
      if (typeof node !== 'string' && blockTags.includes(node.name)) {
        // Absorption: remove ONE newline after the block tag — never inside [code]
        // Never absorb the newline between two [code] blocks, otherwise text
        // sitting between them gets swallowed.
        if (!insideCode && i < result.length - 1 && typeof result[i + 1] === 'string') {
          const nextIsCodeBlock =
            i < result.length - 2 &&
            typeof result[i + 2] !== 'string' &&
            result[i + 2].name === 'code';
          if (!nextIsCodeBlock) {
            result[i + 1] = result[i + 1].replace(/^\r?\n/, '');
          }
        }
      }
      // Recursively preprocess children of tags
      if (typeof node !== 'string' && node.children) {
        const isBlockOrTd = blockTags.includes(node.name) || node.name === 'td';
        if (isBlockOrTd && !insideCode) {
          // Remove leading newlines only (preserving indent spaces)
          if (node.children.length > 0 && typeof node.children[0] === 'string') {
            node.children[0] = node.children[0].replace(/^[\r\n]+/, '');
          }
          // Remove trailing newlines only
          if (node.children.length > 0 && typeof node.children[node.children.length - 1] === 'string') {
            const lastIdx = node.children.length - 1;
            node.children[lastIdx] = node.children[lastIdx].replace(/[\r\n]+$/, '');
          }
        }
        node.children = preprocessNodes(node.children, insideCode || node.name === 'code');
      }
    }
    // Never drop empty strings on the top level: text between two [code]
    // blocks (including a bare newline) must survive to the renderer.
    return result;
  }

  const processedTree = preprocessNodes(root.children);

  // Extract text nodes that are direct children of <table> or <tr> (not inside <td>).
  // HTML does not allow text as a direct child of <tr>, so MyBB moves such text
  // before the table. We do the same here to avoid hydration errors and wrong placement.
  let orphanTexts = [];
  // Та же причина, что и в preprocessNodes: внутри [code] переносы и пустые
  //строки — значимое содержимое, а не «осиротевший» текст таблицы.
  function extractTableOrphanText(nodes, insideCode = false) {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      if (node.name === 'table') {
        const kept = [];
        for (const child of node.children) {
          if (typeof child === 'string') {
            if (insideCode) {
              kept.push(child);
            } else if (child.trim().length > 0) {
              orphanTexts.push(child);
            }
          } else if (child.name === 'tr') {
            const keptTd = [];
            for (const grandchild of child.children) {
              if (typeof grandchild === 'string') {
                if (insideCode) {
                  keptTd.push(grandchild);
                } else if (grandchild.trim().length > 0) {
                  orphanTexts.push(grandchild);
                }
              } else if (grandchild.name === 'td') {
                keptTd.push(grandchild);
              } else {
                keptTd.push(grandchild);
              }
            }
            child.children = keptTd;
            kept.push(child);
          } else {
            kept.push(child);
          }
        }
        node.children = kept;
      } else {
        extractTableOrphanText(node.children, insideCode || node.name === 'code');
      }
    }
  }
  extractTableOrphanText(processedTree);

  // 4. Render the tree to React elements
  function getTextContent(node) {
    if (typeof node === 'string') return node;
    return (node.children || []).map(getTextContent).join('');
  }

  function getRawContent(node) {
    if (typeof node === 'string') return node;
    const inner = (node.children || []).map(getRawContent).join('');
    const closing = node.name !== 'dice' && node.name !== 'roll' && node.name !== 'hr';
    // Alignment tags are always serialized in the new [align=<value>] format
    // (MyBB compatibility), regardless of the original syntax ([center] / [align=center]).
    const alignNames = { left: 'left', center: 'center', right: 'right', justify: 'justify' };
    if (node.name === 'align' || node.name in alignNames) {
      const value = node.name === 'align' ? (node.rawParams || 'left') : alignNames[node.name];
      const valid = ['left', 'center', 'right', 'justify'].includes(value) ? value : 'left';
      const openTag = `[align=${valid}]`;
      return `${openTag}${inner}${closing ? '[/align]' : ''}`;
    }
    const openTag = node.rawTag || `[${node.name}]`;
    return `${openTag}${inner}${closing ? `[/${node.name}]` : ''}`;
  }

  function renderNode(node, index, disableAutoEmbed = false) {
    if (typeof node === 'string') {
      if (disableAutoEmbed) return node;

      // Extract YouTube URLs from plain text for auto-embedding
      const ytRegex = /(https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}(?:[?&#][\w=.-]*)*)/g;

      if (!ytRegex.test(node)) return node;

      const parts = node.split(ytRegex);
      return parts.map((part, i) => {
        if (!part) return null;

        const match = part.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (match) {
          const videoId = match[1];
          return (
            <div key={`${index}-${i}`} className="ratio ratio-16x9 my-2 rounded overflow-hidden shadow-sm mx-auto bbcode-media-wrapper" style={{ maxWidth: '600px', width: '100%' }}>
              <iframe
                src={`https://www.youtube.com/embed/${videoId}`}
                title="YouTube auto-embed"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              ></iframe>
            </div>
          );
        }
        return <React.Fragment key={`${index}-${i}`}>{part}</React.Fragment>;
      });
    }

    const { name, rawParams, children } = node;
    const isInsideUrl = disableAutoEmbed || name === 'url';
    const content = children.map((child, i) => renderNode(child, i, isInsideUrl));

    // Parameter parsing
    const params = {};
    if (rawParams) {
      if (!rawParams.includes('=')) {
        let val = rawParams;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        params.default = val;
      } else {
        const parts = rawParams.split(/\s+(?=[a-zA-Z]+\s*=)/);
        parts.forEach(p => {
          const trimmed = p.trim();
          if (trimmed.includes('=')) {
            const [k, ...v] = trimmed.split('=');
            let val = v.join('=');
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.substring(1, val.length - 1);
            }
            params[k.toLowerCase()] = val;
          } else if (!params.default) {
            let val = trimmed;
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.substring(1, val.length - 1);
            }
            params.default = val;
          }
        });
      }
    }

    switch (name) {
      case 'b': return <strong key={index}>{content}</strong>;
      case 'i': return <em key={index}>{content}</em>;
      case 'u': return <u key={index}>{content}</u>;
      case 's':
      case 'strike':
      case 'del':
        return <del key={index} className="bbcode-strike">{content}</del>;
      case 'sup': return <sup key={index}>{content}</sup>;
      case 'sub': return <sub key={index}>{content}</sub>;
      case 'abbr': return <abbr key={index} title={params.default || ''}>{content}</abbr>;
      case 'quote': {
        let rawAuthor = params.default || params.author || '';
        let authorName = rawAuthor;
        let postId = null;
        let topicId = null;

        if (rawAuthor.startsWith('#p')) {
          const parts = rawAuthor.split(',');
          postId = parts[0].substring(2);

          // Check for topic ID (t456 format)
          if (parts[1] && parts[1].startsWith('t')) {
            topicId = parts[1].substring(1);
            authorName = parts.slice(2).join(',');
          } else {
            authorName = parts.slice(1).join(',');
          }
        }

        return (
          <blockquote key={index} className="bbcode-quote">
            {(authorName || postId) && (
              <div className="bbcode-quote-header fw-bold small mb-1 pb-2 border-bottom d-flex align-items-center" style={{ color: 'var(--primary-color)', lineHeight: '1.2' }}>
                {postId ? (
                  <a
                    href={topicId ? `/topic/${topicId}?post=${postId}` : `?post=${postId}`}
                    className="text-decoration-none d-flex align-items-center gap-1"
                    style={{ color: 'inherit', userSelect: 'text', cursor: 'pointer' }}
                    draggable="false"
                    title={t('bbcode.goto_message')}
                    onClick={(e) => {
                      e.preventDefault();
                      const el = document.getElementById(`post-${postId}`);
                      if (el) {
                        // Post is on this page — just scroll, no navigation
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        el.classList.add('highlight-new-post');
                        setTimeout(() => el.classList.remove('highlight-new-post'), 2000);
                      } else {
                        // Post is on another page — navigate via router
                        navigate(topicId ? `/topic/${topicId}?post=${postId}` : `?post=${postId}`);
                      }
                    }}
                  >
                    {authorName ? `${authorName} ${t('forum.wrote')}:` : `${t('forum.quote')}:`}
                    <Reply size={14} className="opacity-50 flex-shrink-0" />
                  </a>
                ) : (
                  <span>
                    {authorName ? `${authorName} ${t('forum.wrote')}:` : `${t('forum.quote')}:`}
                  </span>
                )}
              </div>
            )}
            {content}
          </blockquote>
        );
      }
      case 'list': {
        const listClass = (params.default || params.type) === '1' ? 'ps-4 mb-2 list-decimal' : 'ps-4 mb-2';
        // Filter out whitespace-only nodes (spans or raw strings) between list items to avoid hydration errors
        const listContent = content.filter(c => {
          if (typeof c === 'string' && !c.trim()) return false;
          if (React.isValidElement(c) && c.type === 'span' && typeof c.props.children === 'string' && !c.props.children.trim()) return false;
          return true;
        });
        return <ul key={index} className={listClass}>{listContent}</ul>;
      }
      case '*': return <li key={index}>{content}</li>;
      case 'url': {
        const rawUrl = (params.default || getTextContent(node)).trim();
        if (/^(?:javascript|data|vbscript):/i.test(rawUrl)) {
          return <span key={index}>{content}</span>;
        }
        let href = rawUrl;
        if (href && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('mailto:')) {
          href = `https://${href}`;
        }
        return <a key={index} href={href} target="_blank" rel="noopener noreferrer">{content}</a>;
      }
      case 'img': {
        const imgUrl = getTextContent(node).trim();
        const isGif = imgUrl.toLowerCase().split('?')[0].endsWith('.gif');

        if (isGif && settings?.allowGifInPosts === false) {
          return <a key={index} href={imgUrl} target="_blank" rel="noopener noreferrer" className="small text-muted italic">[{t('bbcode.gif_image')}: {imgUrl}]</a>;
        }

        const imgStyle = {};
        if (params.width) {
          imgStyle.maxWidth = params.width;
          imgStyle.width = '100%';
        }
        // Резервируем место под картинку до загрузки, чтобы разметка не ехала
        // и скролл к goLast не уходил в сторону. aspect-ratio 16/9 — типовый
        // формат вложенных скриншотов; при реальной загрузке картинка
        // растянется по max-width:100% (img-fluid), а высота подстроится.
        if (!imgStyle.aspectRatio) imgStyle.aspectRatio = '16 / 9';

        return <img
          key={index}
          src={imgUrl}
          loading="lazy"
          className="img-fluid rounded my-2 shadow-sm bbcode-img"
          style={imgStyle}
          alt={params.alt || params.default || "user post"}
          onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100" fill="%23f8f9fa" /><text x="50" y="50" font-family="Arial" font-size="12" fill="%23dc3545" text-anchor="middle" dominant-baseline="central">Image Not Found</text></svg>'; }}
        />;
      }
      case 'color': return <span key={index} style={{ color: params.default || params.color }}>{content}</span>;
      case 'size': {
        const sz = params.default || params.size;
        let sizeVal = sz;
        if (sz) {
          const trimmed = sz.trim();
          if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
            sizeVal = `${trimmed}px`;
          }
        }
        return <span key={index} style={{ fontSize: sizeVal }}>{content}</span>;
      }
      case 'columns': {
        const stackAtValue = params.stack;
        // Filter out whitespace-only nodes between columns to avoid double spacing in flex
        const filtered = content.filter(c => {
          if (typeof c === 'string' && !c.trim()) return false;
          if (React.isValidElement(c) && c.type === 'span' && typeof c.props.children === 'string' && !c.props.children.trim()) return false;
          return true;
        });
        return <ColumnsStacker key={index} stackAt={stackAtValue}>{filtered}</ColumnsStacker>;
      }
      case 'col': {
        const colStyle = { flex: '1', minWidth: '0' };
        const colSz = params.size || params.default;
        if (colSz) {
          const val = isNaN(colSz) ? colSz : `${colSz}%`;
          colStyle.flex = `0 0 ${val}`;
          colStyle.maxWidth = val;
        }
        return <div key={index} className="bbcode-col" style={colStyle}>{content}</div>;
      }
      case 'left': return <div key={index} className="text-start">{content}</div>;
      case 'center': return <div key={index} className="text-center">{content}</div>;
      case 'right': return <div key={index} className="text-end">{content}</div>;
      case 'justify': return <div key={index} style={{ textAlign: 'justify' }}>{content}</div>;
      case 'align': {
        const value = (params.default || 'left').toLowerCase();
        if (value === 'left') return <div key={index} className="text-start">{content}</div>;
        if (value === 'center') return <div key={index} className="text-center">{content}</div>;
        if (value === 'right') return <div key={index} className="text-end">{content}</div>;
        if (value === 'justify') return <div key={index} style={{ textAlign: 'justify' }}>{content}</div>;
        return <div key={index} className="text-start">{content}</div>;
      }
      case 'dice': {
        const sides = params.default || '20';
        return (
          <div
            key={index}
            className="bbcode-dice my-2 d-inline-block p-2 rounded shadow-sm"
            style={{
              backgroundColor: 'var(--input-bg)',
              border: '1px solid var(--input-border)'
            }}
          >
            <div className="d-flex align-items-center gap-2">
              <Dices size={18} style={{ color: 'var(--secondary-color)' }} />
              <div className="small fw-bold" style={{ color: 'var(--input-text)' }}>
                {t('bbcode.dice_roll_pending', { sides })}
              </div>
            </div>
          </div>
        );
      }
      case 'roll': {
        const rollId = params.default;
        // Use baked-in values if available (for quotes/permanence if original post is deleted)
        // rolls can legitimately be null (an optimistic row built before the
        // throws resolve) — the default {} parameter only covers undefined,
        // and a null access here crashed the whole page.
        const roll = (rolls && rolls[rollId]) || (params.value ? {
          value: params.value,
          sides: params.sides,
          type: params.type
        } : null);
        if (!roll) return <span key={index}>[roll={rollId}]</span>;

        const isMaster = roll.type === 'master';
        const canSee = !isMaster || roll.value !== null;

        if (!canSee) {
          return (
            <div key={index} className="bbcode-dice my-2 d-inline-block p-2 rounded shadow-sm" style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
              <div className="d-flex align-items-center gap-2">
                <EyeOff size={18} style={{ color: 'var(--secondary-color)' }} />
                <div className="small fw-bold" style={{ color: 'var(--input-text)', opacity: 0.8 }}>
                  {t('bbcode.master_roll_hidden')}
                </div>
              </div>
            </div>
          );
        }

        return (
          <div
            key={index}
            className="bbcode-dice my-2 d-inline-block p-2 rounded shadow-sm"
            style={{
              backgroundColor: 'var(--input-bg)',
              border: '1px solid var(--input-border)'
            }}
          >
            <div className="d-flex align-items-center gap-2">
              <Dices size={18} style={{ color: isMaster ? 'var(--primary-color)' : 'var(--secondary-color)' }} />
              <div className="d-flex flex-column" style={{ lineHeight: 1.2 }}>
                <span className="fw-bold" style={{ color: 'var(--input-text)', fontSize: '1.1rem' }}>
                  {roll.value}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--secondary-color)' }}>
                  {t('bbcode.of_sides', { sides: roll.sides })}
                  {isMaster && t('bbcode.master_badge')}
                </span>
              </div>
            </div>
          </div>
        );
      }
      case 'spoiler': {
        return <BBCodeSpoiler key={index} title={params.default} t={t}>{content}</BBCodeSpoiler>;
      }
      case 'video':
      case 'youtube':
      case 'media': {
        const urlRaw = getTextContent(node).trim();
        let videoId = null;
        const ytMatch = urlRaw.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (ytMatch) videoId = ytMatch[1];

        if (videoId) {
          return (
            <div key={index} className="ratio ratio-16x9 my-2 rounded overflow-hidden shadow-sm d-block mx-auto bbcode-media-wrapper" style={{ maxWidth: '600px', width: '100%' }}>
              <iframe
                src={`https://www.youtube.com/embed/${videoId}`}
                title="YouTube video player"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              ></iframe>
            </div>
          );
        } else if (urlRaw.endsWith('.mp4') || urlRaw.endsWith('.webm') || urlRaw.endsWith('.ogg')) {
          return (
            <div key={index} className="my-2 rounded overflow-hidden shadow-sm d-block mx-auto bbcode-media-wrapper" style={{ maxWidth: '600px', width: '100%' }}>
              <video controls className="w-100 h-100">
                <source src={urlRaw} />
              </video>
            </div>
          );
        }
        return <a key={index} href={urlRaw} target="_blank" rel="noopener noreferrer">{urlRaw}</a>;
      }
      case 'hide_secured': {
        const threshold = params.default || 'hidden';

        let hint = t('forum.hide_moderator_only');
        if (threshold.startsWith('@')) {
          const nickText = params.nick ? `: ${params.nick}` : '';
          hint = t('bbcode.hidden_for_addressee', { nickText });
        } else if (threshold !== 'hidden') {
          const thresholdNum = parseInt(threshold, 10);
          const userPosts = profile?.post_count || profile?.postCount || user?.post_count || user?.postCount || 0;
          if (!isNaN(thresholdNum)) {
            const remainingPosts = thresholdNum - userPosts;
            hint = remainingPosts > 0
              ? t('forum.hide_posts_remaining', { n: remainingPosts })
              : t('forum.hide_posts_needed', { n: thresholdNum });
          }
        }

        return (
          <div key={index} className="bbcode-hide-placeholder shadow-sm">
            <div className="bbcode-hide-placeholder-icon">
              <EyeOff size={24} />
            </div>
            <div className="bbcode-hide-placeholder-info">
              <div className="bbcode-hide-placeholder-title">{t('forum.hidden_content')}</div>
              <div className="bbcode-hide-placeholder-hint">{hint}</div>
            </div>
          </div>
        );
      }
      case 'hide': {
        if (isDM) return node.children.map(renderNode);

        const threshold = params.default || 'hidden';
        const canBypass = (hasPermission && hasPermission(PERMISSIONS.BYPASS_HIDE_TAGS)) || (user && user.uid === authorId);
        const userPosts = profile?.post_count || profile?.postCount || user?.post_count || user?.postCount || 0;

        let isVisible = canBypass;
        let thresholdNum = 0;

        if (!isVisible) {
          if (threshold === 'hidden') {
            isVisible = false;
          } else if (threshold.startsWith('@')) {
            const targetUid = threshold.substring(1).trim();
            if (user && user.uid === targetUid) isVisible = true;
          } else {
            thresholdNum = parseInt(threshold, 10);
            if (!isNaN(thresholdNum)) {
              isVisible = userPosts >= thresholdNum;
            } else {
              isVisible = true; // Fallback if param is garbage
            }
          }
        }

        // The server ALREADY strips hidden content. 
        // If this tag still has its content in a live post, it means the server deemed it visible to the current user.
        // However, we still do local checks just in case (e.g., local preview while editing).
        if (isVisible) {
          return (
            <div key={index} className="bbcode-hide-container">
              <div className="bbcode-hide-header">
                <EyeOff size={14} /> {t('forum.hidden_content')}
                {isVisible && user && user.uid !== authorId && (hasPermission && hasPermission(PERMISSIONS.BYPASS_HIDE_TAGS)) && <span className="opacity-50 ms-1">(Admin View)</span>}
                {threshold.startsWith('@') && <span className="opacity-50 ms-1 text-primary">({t('bbcode.addressed', { nick: params.nick ? `: ${params.nick}` : '' })})</span>}
              </div>
              <div className="bbcode-hide-content">
                {node.children.map(renderNode)}
              </div>
            </div>
          );
        } else {
          // If we fail the local check (e.g. previewing own post but not author yet?), fallback placeholder
          const remainingPosts = thresholdNum - userPosts;
          let hint = t('forum.hide_moderator_only');
          if (threshold.startsWith('@')) {
            const nickText = params.nick ? `: ${params.nick}` : '';
            hint = t('bbcode.hidden_for_addressee', { nickText });
          }
          else if (threshold !== 'hidden') {
            hint = remainingPosts > 0
              ? t('forum.hide_posts_remaining', { n: remainingPosts })
              : t('forum.hide_posts_needed', { n: thresholdNum });
          }

          return (
            <div key={index} className="bbcode-hide-placeholder shadow-sm">
              <div className="bbcode-hide-placeholder-icon">
                <EyeOff size={24} />
              </div>
              <div className="bbcode-hide-placeholder-info">
                <div className="bbcode-hide-placeholder-title">{t('forum.hidden_content')}</div>
                <div className="bbcode-hide-placeholder-hint">{hint}</div>
              </div>
            </div>
          );
        }
      }
      case 'hr': return <hr key={index} />;
      case 'smile': {
        const code = getTextContent(node);
        const url = ALL_SMILES_MAP[code];
        if (!url) return <span key={index}>{code}</span>;
        return (
          <img
            key={index}
            src={url}
            alt={code}
            title={code}
            className="bbcode-smile d-inline-block"
            style={{
              height: 'auto',
              width: 'auto',
              maxWidth: 'none',
              margin: '0 2px',
              verticalAlign: 'middle',
              border: 'none',
              boxShadow: 'none',
              outline: 'none',
              borderRadius: '0',
              padding: '0',
              background: 'transparent'
            }}
          />
        );
      }
      case 'code': {
        // Render code block content as raw text: nothing inside [code][/code]
        // is interpreted — neither nested BBCode tags, nor HTML markup.
        // Plain text chunks pass through verbatim, and nested tag nodes are
        // serialised back to their literal BBCode text (e.g. [b]…[/b]),
        // so the block shows exactly what was typed between [code] and [/code].
        // React escapes the resulting text when it hits the DOM, so any HTML
        // inside is displayed literally and never rendered as markup.
        const rawText = (node.children || []).map((child) =>
          typeof child === 'string' ? child : getRawContent(child)
        ).join('');

        return (
          <CodeBlock key={index} rawText={rawText} t={t} showToast={showToast} />
        );
      }
      case 'html': {
        const rawHtml = (node.children || []).map(getRawContent).join('');
        // The AUTHOR's role, not the viewer's: a member who happens to be
        // viewing must not get the author's script execution, and an
        // author's own post must not execute when a non-admin views it.
        const isAdminAuthor = isTrustedAdminRole(authorRole);
        return (
          <div key={index} className="custom-html-content">
            {safeHtmlToReact(rawHtml, index, isAdminAuthor)}
          </div>
        );
      }
      case 'table': {
        const layout = params.layout ? String(params.layout).trim() : 'auto';
        const width = params.width ? String(params.width).trim() : undefined;
        const border = params.border ? String(params.border).trim() : undefined;
        const cellspacing = params.cellspacing ? String(params.cellspacing).trim() : undefined;
        const noBorders = border === '0' || border === 'none' || border === 'false';
        const tableStyle = {
          width: width ? width : '100%',
          borderCollapse: 'collapse',
        };
        if (!noBorders && border) tableStyle.border = `1px solid ${border}`;
        if (cellspacing !== undefined) tableStyle.borderSpacing = cellspacing;
        // table-layout CSS property: fixed, auto, revert
        const validLayouts = ['fixed', 'auto', 'revert'];
        if (validLayouts.includes(layout)) {
          tableStyle.tableLayout = layout;
        }
        // Убираем whitespace-строки (переносы между BBCode-тегами), которые
        // не могут быть прямыми детьми <table>/<tbody> в HTML.
        const tableContent = content.filter(
          c => typeof c !== 'string' || c.trim().length > 0
        );
        const tableClass = noBorders ? 'bbcode-table bbcode-table-no-borders' : 'bbcode-table';
        return (
          <table key={index} className={tableClass} style={tableStyle}>
            <tbody>{tableContent}</tbody>
          </table>
        );
      }
      case 'tr': {
        // Убираем whitespace-строки между [td] — HTML не допускает текстовые
        // узлы как прямых детей <tr>.
        const trContent = content.filter(
          c => typeof c !== 'string' || c.trim().length > 0
        );
        return <tr key={index} className="bbcode-tr">{trContent}</tr>;
      }
      case 'td': {
        const bgcolor = params.bgcolor ? String(params.bgcolor).trim() : undefined;
        const width = params.width ? String(params.width).trim() : undefined;
        const height = params.height ? String(params.height).trim() : undefined;
        const valign = params.valign ? String(params.valign).trim() : undefined;
        const align = params.align ? String(params.align).trim() : undefined;
        const colspan = params.colspan ? parseInt(String(params.colspan), 10) : undefined;
        const rowspan = params.rowspan ? parseInt(String(params.rowspan), 10) : undefined;
        const tdStyle = {};
        if (bgcolor) tdStyle.backgroundColor = bgcolor;
        if (width) tdStyle.width = width;
        if (height) tdStyle.height = height;
        if (valign) tdStyle.verticalAlign = valign;
        if (align) tdStyle.textAlign = align;
        return (
          <td
            key={index}
            className="bbcode-td"
            style={tdStyle}
            colSpan={colspan}
            rowSpan={rowspan}
          >
            {content}
          </td>
        );
      }
      default: return <span key={index}>{content}</span>;
    }
  }

  return (
    <div className="bbcode-content" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', width: '100%' }}>
      {orphanTexts.map((text, i) => renderNode(text, i))}
      {processedTree.map((node, i) => renderNode(node, i))}
    </div>
  );
};

export default BBCode;
