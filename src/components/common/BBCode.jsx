import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Dices, EyeOff, Reply } from 'lucide-react';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { ALL_SMILES_MAP } from '../../config/smiles';

/**
 * BBCode Component
 * 
 * A highly robust, single-pass stack-based BBCode parser.
 * Handles nested tags, custom parameters, and flexible tag syntax.
 */

const BBCodeSpoiler = ({ title, children }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={`bbcode-spoiler my-2 ${isOpen ? 'is-open' : ''}`}>
      <div
        className="bbcode-spoiler-header d-flex align-items-center justify-content-between gap-2"
        onClick={() => setIsOpen(!isOpen)}
        style={{ cursor: 'pointer' }}
      >
        <span className="spoiler-title fw-bold small">
          {title || (localStorage.getItem('i18nextLng') === 'ru' ? 'Спойлер' : 'Spoiler')}
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

const BBCode = ({ children, rolls = {}, isDM = false, authorId }) => {
  const { user, profile, hasPermission, PERMISSIONS, settings } = useAuth() || {};
  const { t, lang } = useI18n();
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
  const tokenRegex = /\[(\/?)([a-zA-Z*]+)(?:[\s=]([^\]]*))?\]/g;
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
  const supportedTags = ['b', 'i', 'u', 's', 'quote', 'list', '*', 'url', 'img', 'color', 'size', 'columns', 'col', 'dice', 'roll', 'spoiler', 'video', 'youtube', 'media', 'hide', 'hr', 'smile'];

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
        const newNode = { type: 'tag', name: token.name, rawParams: token.rawParams, children: [] };
        parent.children.push(newNode);
        // Dice, Roll, and HR are self-closing tags (they don't have [/dice] or [/roll] or [/hr])
        if (token.name !== 'dice' && token.name !== 'roll' && token.name !== 'hr') {
          stack.push(newNode);
        }
      }
    }
  });

  // 3. Spacing Optimization (Absorption of newlines around block tags)
  const blockTags = ['quote', 'list', '*', 'columns', 'col', 'spoiler', 'dice', 'roll', 'video', 'youtube', 'media', 'hr'];
  function preprocessNodes(nodes) {
    const result = [...nodes];
    for (let i = 0; i < result.length; i++) {
      const node = result[i];
      if (typeof node !== 'string' && blockTags.includes(node.name)) {
        // Absorption: remove ONE newline before and after if they are whitespace-only
        if (i > 0 && typeof result[i - 1] === 'string') {
          const prev = result[i - 1];
          if (!prev.trim() || prev.endsWith('\n')) {
            // If it's pure whitespace or ends with newline, trip the last newline
            if (prev.endsWith('\n')) {
              result[i - 1] = prev.substring(0, prev.length - 1);
            } else if (prev.endsWith('\r\n')) {
              result[i - 1] = prev.substring(0, prev.length - 2);
            }
          }
        }
        if (i < result.length - 1 && typeof result[i + 1] === 'string') {
          const next = result[i + 1];
          if (!next.trim() || next.startsWith('\n')) {
            if (next.startsWith('\n')) {
              result[i + 1] = next.substring(1);
            } else if (next.startsWith('\r\n')) {
              result[i + 1] = next.substring(2);
            }
          }
        }
      }
      // Recursively preprocess children of tags
      if (typeof node !== 'string' && node.children) {
        if (blockTags.includes(node.name)) {
          // Remove all leading whitespace from first child
          if (node.children.length > 0 && typeof node.children[0] === 'string') {
            node.children[0] = node.children[0].replace(/^\s+/, '');
          }
          // Remove all trailing whitespace from last child
          if (node.children.length > 0 && typeof node.children[node.children.length - 1] === 'string') {
            const lastIdx = node.children.length - 1;
            node.children[lastIdx] = node.children[lastIdx].replace(/\s+$/, '');
          }
        }
        node.children = preprocessNodes(node.children);
      }
    }
    // Filter out empty strings to prevent "phantom" spans
    return result.filter(n => typeof n !== 'string' || n.length > 0);
  }

  const processedTree = preprocessNodes(root.children);

  // 4. Render the tree to React elements
  function getTextContent(node) {
    if (typeof node === 'string') return node;
    return (node.children || []).map(getTextContent).join('');
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
      case 's': return <del key={index}>{content}</del>;
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
                    <Link
                    to={topicId ? `/topic/${topicId}?post=${postId}` : `?post=${postId}`}
                    preventScrollReset={true}
                    className="text-decoration-none d-flex align-items-center gap-1"
                    style={{ color: 'inherit' }}
                    title={lang === 'ru' ? 'Перейти к сообщению' : 'Go to message'}
                  >
                    {authorName ? `${authorName} ${t('forum.wrote')}:` : `${t('forum.quote')}:`}
                    <Reply size={14} className="opacity-50" />
                  </Link>
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
        const url = (params.default || getTextContent(node)).trim();
        return <a key={index} href={url} target="_blank" rel="noopener noreferrer">{content}</a>;
      }
      case 'img': {
        const imgUrl = getTextContent(node).trim();
        const isGif = imgUrl.toLowerCase().split('?')[0].endsWith('.gif');

        if (isGif && settings?.allowGifInPosts === false) {
          return <a key={index} href={imgUrl} target="_blank" rel="noopener noreferrer" className="small text-muted italic">[{lang === 'ru' ? 'GIF-изображение' : 'GIF Image'}: {imgUrl}]</a>;
        }

        return <img
          key={index}
          src={imgUrl}
          className="img-fluid rounded my-2 shadow-sm"
          style={{ maxHeight: '500px' }}
          alt={params.default || "user post"}
          onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100" fill="%23f8f9fa" /><text x="50" y="50" font-family="Arial" font-size="12" fill="%23dc3545" text-anchor="middle" dominant-baseline="central">Image Not Found</text></svg>'; }}
        />;
      }
      case 'color': return <span key={index} style={{ color: params.default || params.color }}>{content}</span>;
      case 'size': {
        const sz = params.default || params.size;
        const sizeVal = (!sz || isNaN(sz)) ? sz : `${sz}%`;
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
                {lang === 'ru' ? `Бросок d${sides} (в ожидании...)` : `d${sides} Roll (pending...)`}
              </div>
            </div>
          </div>
        );
      }
      case 'roll': {
        const rollId = params.default;
        // Use baked-in values if available (for quotes/permanence if original post is deleted)
        const roll = rolls[rollId] || (params.value ? {
          value: params.value,
          sides: params.sides,
          type: params.type
        } : null);
        if (!roll) return <span key={index}>[roll={rollId}]</span>;

        const isMaster = roll.type === 'master';
        const canSee = !isMaster || (hasPermission && hasPermission(PERMISSIONS.VIEW_MASTER_DICE));

        if (!canSee) {
          return (
            <div key={index} className="bbcode-dice my-2 d-inline-block p-2 rounded shadow-sm" style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
              <div className="d-flex align-items-center gap-2">
                <EyeOff size={18} style={{ color: 'var(--secondary-color)' }} />
                <div className="small fw-bold" style={{ color: 'var(--input-text)', opacity: 0.8 }}>
                  {lang === 'ru' ? 'Мастерский бросок (скрыто)' : 'Master Roll (hidden)'}
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
                  {lang === 'ru' ? `из ${roll.sides}` : `of ${roll.sides}`}
                  {isMaster && (lang === 'ru' ? ' • Мастерский' : ' • Master')}
                </span>
              </div>
            </div>
          </div>
        );
      }
      case 'spoiler': {
        return <BBCodeSpoiler key={index} title={params.default}>{content}</BBCodeSpoiler>;
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
          } else {
            thresholdNum = parseInt(threshold, 10);
            if (!isNaN(thresholdNum)) {
              isVisible = userPosts >= thresholdNum;
            } else {
              isVisible = true; // Fallback if param is garbage
            }
          }
        }

        if (isVisible) {
          return (
            <div key={index} className="bbcode-hide-container">
              <div className="bbcode-hide-header">
                <EyeOff size={14} /> {t('forum.hidden_content')} {isVisible && user && user.uid !== authorId && (hasPermission && hasPermission(PERMISSIONS.BYPASS_HIDE_TAGS)) && <span className="opacity-50 ms-1">(Admin View)</span>}
                {user && user.uid === authorId && <span className="opacity-50 ms-1">({lang === 'ru' ? 'Автор' : 'Author'})</span>}
              </div>
              <div className="bbcode-hide-content">
                {node.children.map(renderNode)}
              </div>
            </div>
          );
        } else {
          const remainingPosts = thresholdNum - userPosts;
          return (
            <div key={index} className="bbcode-hide-placeholder shadow-sm">
              <div className="bbcode-hide-placeholder-icon">
                <EyeOff size={24} />
              </div>
              <div className="bbcode-hide-placeholder-info">
                <div className="bbcode-hide-placeholder-title">{t('forum.hidden_content')}</div>
                <div className="bbcode-hide-placeholder-hint">
                  {threshold === 'hidden' 
                    ? t('forum.hide_moderator_only') 
                    : (remainingPosts > 0 
                        ? t('forum.hide_posts_remaining', { n: remainingPosts }) 
                        : t('forum.hide_posts_needed', { n: thresholdNum }))
                  }
                </div>
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
      default: return <span key={index}>{content}</span>;
    }
  }

  return (
    <div className="bbcode-content" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', width: '100%' }}>
      {processedTree.map((node, i) => renderNode(node, i))}
    </div>
  );
};

export default BBCode;
