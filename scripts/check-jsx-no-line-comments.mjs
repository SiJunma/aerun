// Regression test: a `//` line comment placed directly in JSX children.
//
// This is not a syntax error and not a lint error. Inside JSX children, `//` is
// ordinary text, so the compiler happily emits it and React renders it. A
// comment written to explain the code appears IN THE UI:
//
//     <td className="text-end">
//       // The create button here prefills NO group, and a category with
//       // no group is rejected and would be invisible on the forum. So
//       {hasPermission(...) && (...)}
//     </td>
//
// The admin board rendered those four lines as a phantom "category" row. Build
// and eslint both pass, because nothing about the file is malformed — the mistake
// is purely semantic, and only visible by looking at the screen.
//
// A regex cannot catch this: `//` appears in legitimate comments thousands of
// places. So this parses each file with the Babel parser that Vite already uses
// and reports JSXText nodes whose content contains a line comment. Only JSXText
// is inspected, which is exactly the node type that renders as visible text.
//
// Run: node scripts/check-jsx-no-line-comments.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.jsx')) out.push(p);
  }
  return out;
}

const offenders = [];

for (const file of walk(SRC)) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'importMeta'],
  });

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;

    // JSXText is the only node that becomes literal visible text in the output.
    if (node.type === 'JSXText' && /\/\//.test(node.value)) {
      offenders.push({
        file: path.relative(ROOT, file),
        line: node.loc.start.line,
        text: node.value.trim().replace(/\s+/g, ' ').slice(0, 90),
      });
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };

  visit(ast);
}

if (offenders.length > 0) {
  console.error(`JSX line comments rendered as text (${offenders.length}):\n`);
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}`);
    console.error(`      ${o.text}\n`);
  }
  console.error('Use {/* ... */} for a comment in JSX children, or move the //');
  console.error('outside the JSX expression entirely.');
  process.exit(1);
}

console.log('jsx line comments OK — no // text inside JSX children');