import React, { useState, useEffect, useRef } from 'react';

/**
 * BBCode Component
 * 
 * A highly robust, single-pass stack-based BBCode parser.
 * Handles nested tags, custom parameters, and flexible tag syntax.
 */

const ColumnsStacker = ({ children, stackAt }) => {
  const [isStacked, setIsStacked] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const val = parseInt(stackAt, 10);
    if (!val || isNaN(val)) {
      setIsStacked(false);
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

const BBCode = ({ children }) => {
  if (typeof children !== 'string') return children;

  // 1. Tokenize the text into text chunks and tags
  const tokenRegex = /\[(\/?)([a-zA-Z*]+)(?:[\s=]([^\]]*))?\]/g;
  const tokens = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(children)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', content: children.substring(lastIndex, match.index) });
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
  if (lastIndex < children.length) {
    tokens.push({ type: 'text', content: children.substring(lastIndex) });
  }

  // 2. Build a tree structure using a stack
  const root = { type: 'root', children: [] };
  const stack = [root];
  const supportedTags = ['b', 'i', 'u', 's', 'quote', 'list', '*', 'url', 'img', 'color', 'size', 'columns', 'col'];

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
        stack.push(newNode);
      }
    }
  });

  // 3. Spacing Optimization (Absorption of newlines around block tags)
  const blockTags = ['quote', 'list', '*', 'columns', 'col'];
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
          const next = result[i+1];
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

  function renderNode(node, index) {
    if (typeof node === 'string') return node;

    const { name, rawParams, children } = node;
    const content = children.map((child, i) => renderNode(child, i));

    // Parameter parsing
    const params = {};
    if (rawParams) {
      if (!rawParams.includes('=')) {
        params.default = rawParams;
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
            params.default = trimmed;
          }
        });
      }
    }

    switch (name) {
      case 'b': return <strong key={index}>{content}</strong>;
      case 'i': return <em key={index}>{content}</em>;
      case 'u': return <u key={index}>{content}</u>;
      case 's': return <del key={index}>{content}</del>;
      case 'quote':
        const author = params.default || params.author;
        return (
          <blockquote key={index} className="bbcode-quote">
            {author && <div className="fw-bold small mb-1">{author}:</div>}
            {content}
          </blockquote>
        );
      case 'list':
        const listClass = (params.default || params.type) === '1' ? 'ps-4 mb-2 list-decimal' : 'ps-4 mb-2';
        // Filter out whitespace-only nodes (spans or raw strings) between list items to avoid hydration errors
        const listContent = content.filter(c => {
          if (typeof c === 'string' && !c.trim()) return false;
          if (React.isValidElement(c) && c.type === 'span' && typeof c.props.children === 'string' && !c.props.children.trim()) return false;
          return true;
        });
        return <ul key={index} className={listClass}>{listContent}</ul>;
      case '*': return <li key={index}>{content}</li>;
      case 'url':
        const url = (params.default || getTextContent(node)).trim();
        return <a key={index} href={url} target="_blank" rel="noopener noreferrer">{content}</a>;
      case 'img':
        const imgUrl = getTextContent(node).trim();
        return <img
          key={index}
          src={imgUrl}
          className="img-fluid rounded my-2 shadow-sm"
          style={{ maxHeight: '500px' }}
          alt={params.default || "user post"}
          onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100" fill="%23f8f9fa" /><text x="50" y="50" font-family="Arial" font-size="12" fill="%23dc3545" text-anchor="middle" dominant-baseline="central">Image Not Found</text></svg>'; }}
        />;
      case 'color': return <span key={index} style={{ color: params.default || params.color }}>{content}</span>;
      case 'size':
        const sz = params.default || params.size;
        const sizeVal = (!sz || isNaN(sz)) ? sz : `${sz}%`;
        return <span key={index} style={{ fontSize: sizeVal }}>{content}</span>;
      case 'columns':
        const stackAtValue = params.stack;
        // Filter out whitespace-only nodes between columns to avoid double spacing in flex
        const filtered = content.filter(c => {
          if (typeof c === 'string' && !c.trim()) return false;
          if (React.isValidElement(c) && c.type === 'span' && typeof c.props.children === 'string' && !c.props.children.trim()) return false;
          return true;
        });
        return <ColumnsStacker key={index} stackAt={stackAtValue}>{filtered}</ColumnsStacker>;
      case 'col':
        const colStyle = { flex: '1', minWidth: '0' };
        const colSz = params.size || params.default;
        if (colSz) {
          const val = isNaN(colSz) ? colSz : `${colSz}%`;
          colStyle.flex = `0 0 ${val}`;
          colStyle.maxWidth = val;
        }
        return <div key={index} className="bbcode-col" style={colStyle}>{content}</div>;
      default: return <span key={index}>{content}</span>;
    }
  }

  return (
    <div className="bbcode-content" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {processedTree.map((node, i) => renderNode(node, i))}
    </div>
  );
};

export default BBCode;
