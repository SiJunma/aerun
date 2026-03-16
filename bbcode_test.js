/* eslint-env node */
const applyFormatting = (text, offset = 0) => {
  if (!text) return '';

  const tagRegex = /\[(b|i|u|s|quote|list|\*|url|img|color|size)(?:=([^\]]+))?\]/gi;
  const match = tagRegex.exec(text);

  if (!match) return `|TEXT:${text}|`;

  const fullTag = match[0];
  const tagName = match[1].toLowerCase();
  const startIndex = match.index;
  const absoluteIndex = startIndex + offset;

  let closingTag = `[/${tagName}]`;
  let endIndex = -1;

  if (tagName === '*') {
    const nextItem = text.indexOf('[*]', startIndex + fullTag.length);
    const listEnd = text.indexOf('[/list]', startIndex + fullTag.length);

    if (nextItem !== -1 && (listEnd === -1 || nextItem < listEnd)) {
      endIndex = nextItem;
      closingTag = '';
    } else if (listEnd !== -1) {
      endIndex = listEnd;
      closingTag = '';
    } else {
      endIndex = text.length;
      closingTag = '';
    }
  } else {
    let depth = 1;
    const tagPattern = new RegExp(`\\[${tagName}(?:=[^\\]]+)?\\]|\\[\\/${tagName}\\]`, 'gi');
    tagPattern.lastIndex = startIndex + fullTag.length;

    let loops = 0;
    while (depth > 0) {
      loops++;
      if (loops > 100) {
        console.log("INFINITE LOOP DETECTED in while(depth > 0)");
        // eslint-disable-next-line no-undef
        process.exit(1);
      }
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
    console.log("Fallback branch logic string length", text.substring(0, startIndex + fullTag.length).length, text.substring(startIndex + fullTag.length).length);
    // The recursive call here might infinite loop if text doesn't shorten
    return [
      `|TEXT:${text.substring(0, startIndex + fullTag.length)}|`,
      ...applyFormatting(text.substring(startIndex + fullTag.length), absoluteIndex + fullTag.length)
    ];
  }

  const content = text.substring(startIndex + fullTag.length, endIndex);
  const before = text.substring(0, startIndex);
  const after = text.substring(endIndex + closingTag.length);

  let parsedBefore = before;
  let parsedAfter = after;

  const elements = [];
  if (parsedBefore) {
    elements.push(`|TEXT:${parsedBefore}|`);
  }

  // push tag element representation
  elements.push(`|TAG_${tagName.toUpperCase()}:(${applyFormatting(content, 0)})|`);

  if (parsedAfter) {
    const remainingOffset = absoluteIndex + (endIndex - startIndex) + closingTag.length;
    const remaining = applyFormatting(parsedAfter, remainingOffset);
    if (Array.isArray(remaining)) {
      elements.push(...remaining);
    } else {
      elements.push(`|TEXT:${remaining}|`);
    }
  }

  return elements;
};

try {
  console.log("Testing normal image:")
  console.dir(applyFormatting("hello [img]https://example.com/a.png[/img] world"), { depth: null });
  console.log("Testing image with alt:")
  console.dir(applyFormatting("hello [img=alt]https://example.com/a.png[/img] world"), { depth: null });
} catch (e) {
  console.error(e);
}
