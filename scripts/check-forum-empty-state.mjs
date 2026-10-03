// Regression test: the "nothing here yet" state was reinvented on every page.
//
// NotificationsPage was the only page that styled its empty state (glass card,
// line icon, title, supporting line) — and it kept those rules in a page-local
// <style> element, so nothing else could reuse them. Every other page fell back
// to a bare `<div className="p-5 text-center text-muted">` with one muted
// sentence. That is not a rendering bug: it compiles, lints, builds, and the API
// genuinely returns an empty list. The pages simply looked broken — and on the
// topic lists the sentence sat directly on the background photo, where muted
// grey is close to invisible.
//
// Asserts, on the parsed AST of the list pages:
//   1. each one imports the shared <ForumEmptyState> and renders it on its
//      empty branch;
//   2. none of them keeps an inline `p-5 text-center text-muted` placeholder;
//   3. the empty state copy comes from the dictionary (no hardcoded fallback
//      standing in for a key that was never added);
//   4. index.css owns the shared panel styles, so the page-local <style> block
//      cannot drift away from them again.
//
// Run: node scripts/check-forum-empty-state.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

// Pages that render a list and therefore need a shared empty state.
const PAGES = [
  'pages/NotificationsPage.jsx',
  'pages/NewRepliesPage.jsx',
  'pages/ActiveTopicsPage.jsx',
  'pages/SubscriptionsPage.jsx',
  'pages/MainPage.jsx',
  'pages/ProfilePage.jsx',
];

const dictionary = fs.readFileSync(path.join(SRC, 'i18n', 'dictionary.js'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

const failures = [];

/** Depth-first walk yielding [node, ancestors]. */
function* walk(node, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child, ancestors);
    return;
  }
  if (typeof node.type === 'string') yield [node, ancestors];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    yield* walk(node[key], [...ancestors, node]);
  }
}

// ── shared panel styles live in index.css ────────────────────────────────────
for (const rule of ['.empty-state-card', '.empty-state-icon']) {
  if (!css.includes(`${rule} {`)) {
    failures.push(`index.css does not define ${rule} — the shared empty-state panel is unstyled`);
  }
}

// ── per page ──────────────────────────────────────────────────────────────────
for (const rel of PAGES) {
  const file = path.join(SRC, rel);
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'importMeta'] });

  const importsEmptyState = /import\s+ForumEmptyState\s+from/.test(code);
  if (!importsEmptyState) {
    failures.push(`${rel} does not import ForumEmptyState`);
  }

  // The shared panel must actually be rendered, not merely imported.
  const rendersEmptyState = /<ForumEmptyState[\s>]/.test(code);
  if (!rendersEmptyState) {
    failures.push(`${rel} imports ForumEmptyState but never renders it`);
  }

  // The ad-hoc placeholder this test exists to delete. Only the EMPTY branch
  // counts: the loading branch legitimately reuses this markup to hold a
  // spinner, and that is not an empty state.
  for (const [n] of walk(ast.program)) {
    if (n.type !== 'JSXElement') continue;
    const cls = n.openingElement?.attributes
      ?.find((a) => a.type === 'JSXAttribute' && a.name?.name === 'className')
      ?.value?.value;
    if (typeof cls !== 'string') continue;
    if (!cls.includes('p-5') || !cls.includes('text-muted')) continue;

    const hasSpinner = [...walk(n)].some(
      ([c]) => c.type === 'JSXAttribute' && String(c.value?.value ?? '').includes('spinner-border')
    );
    if (!hasSpinner) {
      failures.push(
        `${rel} still renders an inline "p-5 text-center text-muted" empty branch — ` +
        'use <ForumEmptyState> so every empty list looks the same'
      );
      break;
    }
  }

  // A hardcoded fallback means the dictionary key is missing or drifted: the
  // `t(key, 'text')` overload only shows that literal when the key is absent.
  for (const m of code.matchAll(/t\(\s*'([a-z_]+\.[a-z_]+)'[^)]*?,\s*'([^']+)'/g)) {
    const key = m[1];
    const literal = m[2];
    if (!dictionary.includes(`${key.split('.').pop()}:`)) {
      failures.push(`${rel}: t('${key}', '${literal}') — no such dictionary key, so the literal is what renders`);
    }
  }
}

// ── notifications page no longer owns the panel styles ────────────────────────
const notifications = fs.readFileSync(path.join(SRC, 'pages', 'NotificationsPage.jsx'), 'utf8');
if (/\.empty-state-card\s*\{/.test(notifications)) {
  failures.push(
    'NotificationsPage re-declares .empty-state-card in a local <style> — ' +
    'the copy there silently diverged from index.css'
  );
}

if (failures.length > 0) {
  console.error(`forum empty-state regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`forum empty state OK — ${PAGES.length} pages use the shared component`);