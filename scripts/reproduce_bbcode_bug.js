
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Mock current BBCode logic for testing
const ColumnStacker = ({ children }) => <div className="columns">{children}</div>;

const BBCodeRenderer = (text) => {
  const tokenRegex = /\[(\/?)([a-zA-Z*]+)(?:[\s=]([^\]]*))?\]/g;
  const tokens = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', content: text.substring(lastIndex, match.index) });
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
  if (lastIndex < text.length) {
    tokens.push({ type: 'text', content: text.substring(lastIndex) });
  }

  const root = { type: 'root', children: [] };
  const stack = [root];
  const supportedTags = ['b', 'i', 'u', 's', 'quote', 'list', '*', 'url', 'img', 'color', 'size', 'columns', 'col'];

  tokens.forEach(token => {
    const parent = stack[stack.length - 1];
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
        // ORIGINAL LOGIC
        if (token.name === '*' && parent.name === '*') stack.pop();
        const newNode = { type: 'tag', name: token.name, rawParams: token.rawParams, children: [] };
        parent.children.push(newNode);
        stack.push(newNode);
      }
    }
  });

  function renderNode(node, index) {
    if (typeof node === 'string') return <span key={index}>{node}</span>;
    const { name, children } = node;
    const content = children.map((child, i) => renderNode(child, i));
    switch (name) {
      case 'b': return <strong key={index}>{content}</strong>;
      case 'list': return <ul key={index}>{content}</ul>;
      case '*': return <li key={index}>{content}</li>;
      default: return <span key={index}>{content}</span>;
    }
  }

  return <div>{root.children.map((node, i) => renderNode(node, i))}</div>;
};

const testText = "[list][*][b]item 1[*]item 2[/b][/list]";
const html = renderToStaticMarkup(BBCodeRenderer(testText));
console.log(html);
