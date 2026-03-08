import React from 'react';

/**
 * BBCode Component
 * 
 * A simple BBCode parser that converts tags into React elements.
 * Supports: [b], [i], [u], [s], [url], [img], [quote], [color], [size], [list], [*]
 */
const BBCode = ({ children }) => {
  if (typeof children !== 'string') return children;

  const parseBBCode = (text) => {
    let result = text;

    // 1. Handle Newlines (pre-wrap handles this, but we can ensure standard behavior)
    // We'll use CSS white-space: pre-wrap for simplicity and performance.

    // 2. Escape HTML to prevent XSS (since we might use some string replacements)
    // Actually, by building React elements we avoid most XSS, 
    // but if we do any intermediate string work we must be careful.

    // Simple Regex-based parser that builds an array of React elements
    // This is more complex than simple string replace but much safer.

    // For now, let's implement a robust string-to-HTML-like conversion 
    // BUT we will use a library-like approach or a very careful regex set 
    // to avoid dangerouslySetInnerHTML if possible.

    // However, given the constraints and the need for nested tags, 
    // a recursive parser or a stack-based one is best.

    return renderBBCode(text);
  };

  const renderBBCode = (text) => {
    // Regex for all supported tags
    // [b]...[/b]
    // [i]...[/i]
    // [u]...[/u]
    // [s]...[/s]
    // [url=...].[/url] or [url]...[/url]
    // [img]...[/img]
    // [quote]...[/quote]
    // [color=...]...[/color]
    // [size=...]...[/size]

    const parts = [];
    let lastIndex = 0;

    // Simplified regex for the most common tags
    // This is a basic implementation. For production-grade nested BBCode, 
    // one might use a more sophisticated parser.

    // For this forum, we'll implement the major ones.

    let processedText = text;

    // We'll use a sequence of replacements for simple tags, 
    // but complex ones like [url] need more care.

    // Note: We'll use white-space: pre-wrap on the container.

    return (
      <div className="bbcode-content" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {applyFormatting(processedText)}
      </div>
    );
  };

  const applyFormatting = (text, offset = 0) => {
    if (!text) return '';

    // This is a recursive-ish approach to handle nesting
    // We search for the first occurrence of any opening tag
    const tagRegex = /\[(b|i|u|s|quote|list|\*|url|img|color|size)(?:=([^\]]+))?\]/gi;
    const match = tagRegex.exec(text);

    if (!match) return <span key={`txt-m-${offset}`}>{text}</span>;

    const fullTag = match[0];
    const tagName = match[1].toLowerCase();
    const tagParam = match[2];
    const startIndex = match.index;
    const absoluteIndex = startIndex + offset;

    // Find the closing tag
    let closingTag = `[/${tagName}]`;
    let endIndex = -1;

    // Special case for [*] which is often self-closing or implicitly closed by next [*] or [/list]
    if (tagName === '*') {
      // Find next [*] or [/list]
      const nextItem = text.indexOf('[*]', startIndex + fullTag.length);
      const listEnd = text.indexOf('[/list]', startIndex + fullTag.length);

      if (nextItem !== -1 && (listEnd === -1 || nextItem < listEnd)) {
        endIndex = nextItem;
        closingTag = ''; // Don't consume next [*]
      } else if (listEnd !== -1) {
        endIndex = listEnd;
        closingTag = ''; // Don't consume [/list]
      } else {
        endIndex = text.length;
        closingTag = '';
      }
    } else {
      let depth = 1;
      const tagPattern = new RegExp(`\\[${tagName}(?:=[^\\]]+)?\\]|\\[\\/${tagName}\\]`, 'gi');
      tagPattern.lastIndex = startIndex + fullTag.length;

      while (depth > 0) {
        const nextMatch = tagPattern.exec(text);

        if (!nextMatch) break;

        if (nextMatch[0].toLowerCase() === closingTag) {
          depth--;
          if (depth === 0) {
            endIndex = nextMatch.index;
            break;
          }
        } else {
          depth++;
        }
      }
    }

    if (endIndex === -1 && tagName !== '*') {
      // No closing tag found, treat as plain text and continue after the tag
      return [
        <span key={`txt-f-${absoluteIndex}`}>{text.substring(0, startIndex + fullTag.length)}</span>,
        ...applyFormatting(text.substring(startIndex + fullTag.length), absoluteIndex + fullTag.length)
      ];
    }

    const content = text.substring(startIndex + fullTag.length, endIndex);
    const before = text.substring(0, startIndex);
    const after = text.substring(endIndex + closingTag.length);

    let parsedBefore = before;
    let parsedAfter = after;

    // If it's a block tag, absorb surrounding newlines to prevent double-spacing under pre-wrap
    if (tagName === 'quote' || tagName === 'list') {
      parsedBefore = parsedBefore.replace(/\n$/, ''); // Remove one trailing newline before block
      parsedAfter = parsedAfter.replace(/^\n/, '');   // Remove one leading newline after block
    }

    const elements = [];
    if (parsedBefore) {
      elements.push(<span key={`txt-b-${offset}`}>{parsedBefore}</span>);
    }

    // Create the React element for this tag
    let element;
    const blockContent = (content || '').replace(/^\n+/, '').replace(/\n+$/, '');
    const contentOffset = absoluteIndex + fullTag.length;

    switch (tagName) {
      case 'b': element = <strong key={absoluteIndex}>{applyFormatting(content, contentOffset)}</strong>; break;
      case 'i': element = <em key={absoluteIndex}>{applyFormatting(content, contentOffset)}</em>; break;
      case 'u': element = <u key={absoluteIndex}>{applyFormatting(content, contentOffset)}</u>; break;
      case 's': element = <del key={absoluteIndex}>{applyFormatting(content, contentOffset)}</del>; break;
      case 'quote':
        element = (
          <blockquote key={absoluteIndex} className="bbcode-quote">
            {applyFormatting(blockContent, contentOffset)}
          </blockquote>
        );
        break;
      case 'list':
        element = <ul key={absoluteIndex} className="ps-4 mb-2">{applyFormatting(blockContent, contentOffset)}</ul>;
        break;
      case '*':
        element = <li key={absoluteIndex}>{applyFormatting(content, contentOffset)}</li>;
        break;
      case 'url':
        const url = tagParam || content;
        element = <a key={absoluteIndex} href={url} target="_blank" rel="noopener noreferrer">{applyFormatting(content, contentOffset)}</a>;
        break;
      case 'img':
        const altText = tagParam || 'user posted image';
        element = <img
          key={absoluteIndex}
          src={content}
          alt={altText}
          className="img-fluid rounded my-2 shadow-sm"
          style={{ maxHeight: '500px' }}
          onError={(e) => {
            e.target.onerror = null; // stop loop
            // Replace broken image with a small placeholder
            e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100" fill="%23f8f9fa" /><text x="50" y="50" font-family="Arial" font-size="12" fill="%23dc3545" text-anchor="middle" dominant-baseline="central">Image Not Found</text></svg>';
          }}
        />;
        break;
      case 'color':
        element = <span key={absoluteIndex} style={{ color: tagParam }}>{applyFormatting(content, contentOffset)}</span>;
        break;
      case 'size':
        // Size can be in % or px or just a number
        const size = isNaN(tagParam) ? tagParam : `${tagParam}%`;
        element = <span key={absoluteIndex} style={{ fontSize: size }}>{applyFormatting(content, contentOffset)}</span>;
        break;
      default:
        element = <span key={absoluteIndex}>{content}</span>;
    }

    elements.push(element);
    if (parsedAfter) {
      const remainingOffset = absoluteIndex + (endIndex - startIndex) + closingTag.length;
      const remaining = applyFormatting(parsedAfter, remainingOffset);
      if (Array.isArray(remaining)) {
        elements.push(...remaining);
      } else {
        elements.push(<span key={`txt-a-${remainingOffset}`}>{remaining}</span>);
      }
    }

    return elements;
  };

  return renderBBCode(children);
};

export default BBCode;
