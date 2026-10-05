// Regression test: the admin Categories tab rendered a table with NO rows.
//
// A Bootstrap <Table> paints its header row unconditionally, so
//   groups.length === 0 && categories.length === 0
// produced a bare dark bar over an empty body — a populated-looking table whose
// content failed to load. The same branch fell through to the "unassigned"
// pseudo-group block, which painted a "General" heading for a category that does
// not exist. Nothing throws and nothing warns: the module compiles, lint passes,
// the build passes, and the API legitimately returns empty lists. This is purely
// a render-shape defect, so only inspecting the JSX tree catches it.
//
// Asserts, on the parsed AST of AdminPage.jsx:
//   1. every <Table> inside renderCategories() is one branch of a ternary whose
//      sibling branch renders .admin-empty-state, so it is unreachable with zero
//      rows;
//   2. the unassigned pseudo-group heading sits behind a `cond && (...)` guard,
//      so it cannot appear unless such legacy rows exist;
//   3. the phantom copy is gone from the page and lives in the dictionary.
//
// Run: node scripts/check-admin-empty-state.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// An optional path argument lets the check run against a fixture, which is how
// it is proven to FAIL on the old shape (see npm run test:admin-empty-state -- <file>).
const FILE = path.resolve(process.argv[2] ?? path.join(ROOT, 'src', 'pages', 'AdminPage.jsx'));
const code = fs.readFileSync(FILE, 'utf8');
const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'importMeta'] });

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

/**
 * Does this branch render a NON-TABLE fallback in place of the table?
 *
 * There is more than one legitimate fallback, and the check must accept any of
 * them rather than one hardcoded class:
 *   - `.admin-empty-state`    — nothing exists at all (no groups, no categories);
 *   - `.admin-group-scaffold` — groups exist but no category does, so the
 *     category columns would hold no rows.
 *
 * What all of them share is the property being enforced: the <Table> is not
 * reachable in the state where its header would describe an empty list.
 */
const FALLBACKS = ['admin-empty-state', 'admin-group-scaffold'];

const rendersFallback = (branch) => {
  for (const [n] of walk(branch)) {
    if (
      n.type === 'JSXAttribute' &&
      n.name?.name === 'className' &&
      FALLBACKS.some((cls) => String(n.value?.value ?? '').includes(cls))
    ) {
      return true;
    }
  }
  return false;
};

const isString = (n, needle) =>
  (n.type === 'StringLiteral' || n.type === 'JSXText') && String(n.value).includes(needle);

/** Does this subtree render a non-table fallback? */
const rendersEmptyState = (branch) => rendersFallback(branch);

let fnNode = null;
for (const [n] of walk(ast.program)) {
  if (n.type === 'VariableDeclarator' && n.id?.name === 'renderCategories') fnNode = n.init;
}
if (!fnNode) {
  console.error('renderCategories() not found in AdminPage.jsx — the check no longer applies.');
  process.exit(1);
}

const nodes = [...walk(fnNode)];
const failures = [];

// ── 1. no <Table> can render with zero rows ──────────────────────────────────
const tables = nodes.filter(
  ([n]) => n.type === 'JSXElement' && n.openingElement?.name?.name === 'Table'
);
if (tables.length === 0) failures.push('renderCategories() renders no <Table> — layout was rewritten?');

for (const [table, ancestors] of tables) {
  // The table must be the consequent or alternate of a ternary whose other
  // branch renders a non-table fallback. Without that it is reachable with 0
  // rows, and its header row is painted over an empty body.
  const guarded = ancestors.some((anc) => {
    if (anc.type !== 'ConditionalExpression') return false;
    if (anc.consequent === table) return rendersFallback(anc.alternate);
    if (anc.alternate === table) return rendersFallback(anc.consequent);
    return false;
  });
  if (!guarded) {
    failures.push(
      `<Table> at line ${table.loc.start.line} has no non-table fallback sibling branch — ` +
      'with zero rows it still paints its header row'
    );
  }
}

// ── 1b. the "groups but no categories" scaffold must exist ────────────────────
//
// Groups without a single category are the case where the category COLUMNS
// (Order / Title / Stats / Actions) describe nothing at all: the only rows on
// offer are group separators. A table there reads as a populated list whose
// data failed to load, so the scaffold replaces it — and its absence would
// silently reintroduce that exact screen.
const hasScaffold = nodes.some(
  ([n]) =>
    n.type === 'JSXAttribute' &&
    n.name?.name === 'className' &&
    String(n.value?.value ?? '').includes('admin-group-scaffold')
);
if (!hasScaffold) {
  failures.push(
    'no .admin-group-scaffold branch — with groups but no categories the table ' +
    'header names columns that hold no rows'
  );
}

// ── 2. the unassigned pseudo-group must be conditional ──────────────────────
const heading = nodes.find(([n]) => isString(n, 'admin.categories.group_unassigned'));
if (!heading) {
  failures.push('the unassigned pseudo-group heading is gone — legacy categories become unreachable.');
} else {
  const guarded = heading[1].some(
    (anc) =>
      anc.type === 'JSXExpressionContainer' &&
      anc.expression?.type === 'LogicalExpression' &&
      anc.expression.operator === '&&'
  );
  if (!guarded) {
    failures.push(
      'the unassigned pseudo-group heading is unconditional — it renders a category ' +
      'heading even when no such category exists'
    );
  }
}

// ── 3. no leftover phantom copy ─────────────────────────────────────────────
for (const phantom of ['No unassigned forums', 'Нет нераспределенных форумов', 'No forums in this category']) {
  if (code.includes(phantom)) {
    failures.push(`phantom copy still inlined in AdminPage.jsx: "${phantom}" — belongs in the dictionary`);
  }
}

if (failures.length > 0) {
  console.error(`admin empty-state regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`admin empty state OK — ${tables.length} table(s) guarded, unassigned section conditional`);