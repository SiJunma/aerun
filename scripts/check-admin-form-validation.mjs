// Regression test: an admin Save button that did NOTHING when clicked.
//
// Every save handler opened with a bare guard:
//
//     const handleSaveGroup = async () => {
//       if (!groupForm.title?.en && !groupForm.title?.ru) return;
//
// That returns without a request, without a toast, and — the actual bug —
// without disabling the button. Clicking Save on an empty modal therefore did
// nothing visible, and a broken button is indistinguishable from a rejected
// form. Nothing warns about it: the code is correct, lint and build pass.
//
// Three rules are enforced on the parsed AST of AdminPage.jsx:
//   1. a guard that returns early MUST be mirrored by a `disabled` condition on
//      the corresponding button, so the click can never be a silent no-op;
//   2. fields gating a guard carry `isInvalid`, so the user is told which input
//      is at fault rather than guessing from a dead button;
//   3. guards trim, so a whitespace-only value cannot pass and earn a 400.
//
// Run: node scripts/check-admin-form-validation.mjs [file]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.resolve(process.argv[2] ?? path.join(ROOT, 'src', 'pages', 'AdminPage.jsx'));
const code = fs.readFileSync(FILE, 'utf8');
const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'importMeta'] });

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

const all = [...walk(ast.program)];
const failures = [];
const src = (n) => code.slice(n.start, n.end);
const enclosingEl = (ancestors) =>
  [...ancestors].reverse().find((a) => a.type === 'JSXElement');

/**
 * The name a guard's handler is declared under.
 *
 * Read off the ANCESTOR chain rather than by scanning the file for the matching
 * declaration: the chain literally is
 *   VariableDeclaration < VariableDeclarator < ArrowFunctionExpression
 * so the declarator that owns this function is right there. Matching by identity
 * against a separate node list is equivalent but depends on the two traversals
 * sharing node objects.
 */
function handlerName(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'VariableDeclarator' && a.id?.name) return a.id.name;
    if (a.type === 'FunctionDeclaration' && a.id?.name) return a.id.name;
  }
  return null;
}

// Guards that bail out of a save handler without a request or a toast.
//
// Two shapes are accepted, because both mean the same thing and both occur here:
//     if (!form.title?.en && !form.title?.ru) return;          // one-liner
//     if (!trimmed(...)) { revealFirstInvalid(...); return; } // braced
//
// The body is matched with [^;]* rather than [^)]* because the fixed guards call
// a helper (`trimmed(...)`), so the first `)` is not the end of the test.
const GUARD_RE = /^if\s*\([^;]*\b(groupForm|catForm|roleForm)\b[^;]*\)\s*(\{|return;)/;
const guards = all
  .filter(([n]) => n.type === 'IfStatement' && GUARD_RE.test(src(n).trim()))
  .map(([guard, ancestors]) => ({ guard, name: handlerName(ancestors) }));

if (guards.length === 0) {
  // A gate that silently stops matching turns green while checking nothing —
  // the worst outcome a check can have, because it reads as a pass. Rewriting a
  // guard from `if (...) return;` into a braced block must not be able to do that.
  failures.push(
    'no save guards matched — the check is inspecting nothing, which reads as a pass. ' +
    'If the guard shape changed, update GUARD_RE.'
  );
}

// ── 1. an early-return guard needs a matching `disabled` button ──────────────
//
// The button is found by the handler name in its onClick, so a handler and its
// button are paired by what wires them, not by proximity in the file.
const VALIDITY = /groupForm|catForm|roleForm|FormValid|SaveDisabled|FormState/;

for (const { guard, name } of guards) {
  if (!name) {
    failures.push(`a guard at line ${guard.loc.start.line} is in an anonymous handler — it cannot be paired with a button`);
    continue;
  }

  const buttons = all.filter(
    ([n]) =>
      n.type === 'JSXAttribute' &&
      n.name?.name === 'onClick' &&
      (n.value?.value === name ||
        (n.value?.type === 'JSXExpressionContainer' && src(n.value).includes(name)))
  );

  if (buttons.length === 0) {
    failures.push(`${name}: nothing is wired to it — the early return at line ${guard.loc.start.line} is invisible to the user`);
    continue;
  }

  const guarded = buttons.some(([, ancestors]) => {
    const el = enclosingEl(ancestors);
    return (el?.openingElement?.attributes ?? []).some(
      (a) => a.type === 'JSXAttribute' && a.name?.name === 'disabled' && VALIDITY.test(src(a))
    );
  });

  if (!guarded) {
    failures.push(
      `${name}: the early return at line ${guard.loc.start.line} has no matching \`disabled\` ` +
      'condition on its Save button — clicking Save is a silent no-op'
    );
  }
}

// ── 2. fields gating a guard must be marked isInvalid ────────────────────────
//
// The group/category title pair legitimately shares one invalid state, so both
// language inputs are expected to carry isInvalid together. Each entry lists
// the EXACT expressions that gate the save: matching the whole `groupForm.`
// prefix would also catch `order`, which no guard constrains.
const GATED_FIELDS = [
  { paths: ['groupForm.title?.en', 'groupForm.title?.ru'], label: 'group title' },
  { paths: ['catForm.title?.en', 'catForm.title?.ru'], label: 'category title' },
  { paths: ['roleForm.name'], label: 'role name' },
  { paths: ['catForm.group_id'], label: 'category group select' },
];

for (const { paths, label } of GATED_FIELDS) {
  for (const p of paths) {
    const controls = all.filter(
      ([n]) => n.type === 'JSXAttribute' && n.name?.name === 'value' && src(n).includes(p)
    );

    if (controls.length === 0) {
      failures.push(`no form control binds ${p} — the ${label} guard cannot be surfaced to the user`);
      continue;
    }

    const marked = controls.every(([, ancestors]) => {
      const el = enclosingEl(ancestors);
      // The control's own isInvalid is inside the element; the explanatory
      // feedback sits in the same Form.Group right after it. One window covers
      // both without needing the parent chain.
      return el ? /isInvalid=/.test(code.slice(el.start, el.end + 400)) : false;
    });

    if (!marked) {
      failures.push(
        `${label} (${p}) gates a save but nothing marks it isInvalid — ` +
        'the user sees a dead button with no reason'
      );
    }
  }
}

// ── 3. guards must ignore whitespace-only values ────────────────────────────
// A field holding " " is not a title; comparing raw values let it through and
// turned into a 400 "title is required" from the server.
//
// Scoped to the free-text guards. A `<select>` value cannot arrive as whitespace,
// so demanding `trimmed()` of the group check would be demanding noise — and a
// check that demands the impossible gets deleted the first time it annoys
// someone.
for (const { guard, name } of guards) {
  const test = src(guard.test);
  if (!/\b(title|name)\b/.test(test)) continue;

  if (!/trimmed\(/.test(test)) {
    failures.push(
      `${name}: the guard at line ${guard.loc.start.line} does not trim — a whitespace-only value ` +
      'passes it and is rejected by the server as "title is required"'
    );
  }
}

// ── 4. errors must not appear before the admin has tried to submit ───────────
//
// Marking a field invalid the moment the modal opens condemns a form nobody has
// touched: two red inputs greet an admin who was only going to type a title.
//
// Errors must therefore be gated on an "attempted" flag that the save handler
// sets. This is also why the button may NOT be locked on validity alone: a
// disabled button is unclickable, so it could never surface the very errors it
// hides — the original silent no-op would come back wearing a disabled style.
//
// The flags are RESOLVED through their declarations rather than matched by name
// at the use site: `isInvalid={showGroupError}` says nothing on its own, and
// `showGroupError` only counts if its own definition reads an Attempted flag.
const ATTEMPT_SUFFIX = 'Attempted';

// Names of `const X = ...` declarations, with their source, for one-hop lookup.
const decls = new Map(
  all
    .filter(([n]) => n.type === 'VariableDeclarator' && n.id?.type === 'Identifier')
    .map(([n]) => [n.id.name, src(n)])
);

const mentions = (text, re) => re.test(text ?? '');

/** Does this expression text depend on an `*Attempted` flag, at most one hop? */
const reachesAttempted = (expr) => {
  for (const name of expr.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (new RegExp(`\\w${ATTEMPT_SUFFIX}\\b`).test(name)) return true;
    if (mentions(decls.get(name), new RegExp(`\\w${ATTEMPT_SUFFIX}\\b`))) return true;
  }
  return false;
};

/** Does this expression text depend on form validity, at most one hop? */
const reachesValidity = (expr) =>
  (expr.match(/[A-Za-z_$][\w$]*/g) ?? []).some(
    (name) => VALIDITY.test(name) || VALIDITY.test(decls.get(name) ?? '')
  );

// ── 4. errors must not appear before the admin has tried to submit ───────────
//
// Marking a field invalid the moment the modal opens condemns a form nobody has
// touched: two red inputs greet an admin who was only going to type a title.
//
// Errors must therefore be gated on an "attempted" flag the save handler sets.
// This is also why the button may NOT be locked on validity alone: a disabled
// button is unclickable, so it could never surface the very errors it hides —
// the original silent no-op would come back wearing a disabled style.
if (![...decls.keys()].some((name) => reachesAttempted(name))) {
  failures.push(
    'no "attempted" flag exists — validation would fire on open, showing red ' +
    'fields for a form nobody has touched yet'
  );
}

// Every `set<Name>Attempted` must be reset to false somewhere, so an abandoned
// form does not reopen already showing errors.
const setters = all.filter(
  ([n]) =>
    n.type === 'CallExpression' &&
    new RegExp(`^set\\w${ATTEMPT_SUFFIX}$`).test(n.callee?.name ?? '')
);

for (const [n] of setters) {
  const callee = n.callee.name;
  const resets = all.some(
    ([c]) =>
      c.type === 'CallExpression' &&
      c.callee?.name === callee &&
      c.arguments[0]?.type === 'BooleanLiteral' &&
      c.arguments[0].value === false
  );
  if (!resets) {
    failures.push(
      `${callee}() at line ${n.loc.start.line} is never reset to false — the errors leak ` +
      'into the next opening of the modal'
    );
  }
}

// Every isInvalid must trace back to an attempted flag.
for (const [n] of all) {
  if (n.type !== 'JSXAttribute' || n.name?.name !== 'isInvalid') continue;
  if (!reachesAttempted(src(n))) {
    failures.push(
      `isInvalid at line ${n.loc.start.line} (${src(n).replace(/\s+/g, ' ')}) is not gated on an ` +
      '"attempted" flag — the field turns red before the admin has done anything'
    );
  }
}

// And so must every disabled that locks on VALIDITY — but NOT the unrelated
// ones (`disabled={saving}`, `disabled={!hasPermission(...)}`), which lock for
// reasons no form validation can explain.
for (const [n] of all) {
  if (n.type !== 'JSXAttribute' || n.name?.name !== 'disabled') continue;
  const expr = src(n);
  if (!reachesValidity(expr)) continue;
  if (!reachesAttempted(expr)) {
    failures.push(
      `disabled at line ${n.loc.start.line} (${expr.replace(/\s+/g, ' ')}) locks on validity ` +
      'alone — the button would be unclickable and its errors could never appear'
    );
  }
}

// ── 5. invalid feedback must stay HIDDEN until the control is invalid ────────
//
// Bootstrap shows a hint only next to an invalid control:
//
//     .invalid-feedback              { display: none; }
//     .is-invalid ~ .invalid-feedback { display: block; }
//
// A display utility on the feedback defeats that. `d-block` resolves to
// `display: block !important`, which outranks the plain `display: none` above —
// so the hint renders on EVERY open, including a pristine form nobody has
// touched. The `isInvalid` gating then looks correct in the JSX while the text
// is permanently on screen.
//
// The utilities are only safe when the element is rendered conditionally (as in
// TransferRootModal, which shows `{submitted && ... && <div className="d-block">}`);
// a bare <Form.Control.Feedback type="invalid"> must carry none of them, because
// Bootstrap is already doing the showing.
const DISPLAY_UTILS = /\b(d-block|d-inline|d-inline-block|d-flex|d-grid|d-none)\b/;

for (const [n] of all) {
  if (n.type !== 'JSXElement') continue;
  if (n.openingElement?.name?.type !== 'JSXMemberExpression') continue;

  const rendered = src(n.openingElement.name);
  if (!/Feedback$/.test(rendered)) continue;

  const cls = (n.openingElement.attributes ?? []).find(
    (a) => a.type === 'JSXAttribute' && a.name?.name === 'className'
  );
  const text = cls ? src(cls.value) : '';
  if (DISPLAY_UTILS.test(text)) {
    failures.push(
      `${rendered} at line ${n.loc.start.line} carries ${text} — a display utility with ` +
      '!important outranks .invalid-feedback{display:none}, so the hint shows on an untouched form'
    );
  }
}

// ── 5. every ref used by revealFirstInvalid must be attached ────────────────
//
// `revealFirstInvalid([ref])` scrolls and focuses the first invalid control when
// Save is rejected. It reads `ref.current` and SKIPS a null, so a ref that is
// declared but never attached is not an error — it is a silent no-op: the
// button greys, the field turns red, and the modal never moves.
//
// That is exactly what all four of these were. The guards, the isInvalid
// markers and the disabled conditions were all present and correct, which is
// why the missing scroll survived review: nothing in the file was wrong, the
// ref simply pointed at nothing. So this checks the ATTACHMENT, which is the
// part a reader verifies least.
const REVEAL_TARGETS = [
  'catTitleRef',
  'catGroupRef',
  'groupTitleRef',
  'roleNameRef',
];

for (const name of REVEAL_TARGETS) {
  const attached = all.some(
    ([n]) =>
      n.type === 'JSXAttribute' &&
      n.name?.name === 'ref' &&
      src(n.value).includes(name)
  );
  if (!attached) {
    failures.push(
      `${name} is passed to revealFirstInvalid but never attached with ref={${name}} — ` +
      'ref.current stays null, so the helper skips it and the modal never scrolls to the empty field'
    );
  }
}

if (failures.length > 0) {
  console.error(`admin form-validation regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `admin form validation OK — ${guards.length} guard(s) mirrored by disabled buttons, invalid fields and trims`
);