// check-admin-shared-components.mjs — the shared-components principle, made unshippable.
//
// In 2026-11-27 the admin grew one themed CSS file per tab, each re-declaring
// the same button, switch, input, hint and error rules under its own prefix
// (designs-*, visits-*, push-*, favicon-uploader-*): twenty rule bodies were
// byte-identical across files, so one visual change meant editing four files,
// and the copies drifted. The shared primitives live once, in
// src/components/admin/admin.css — see .agent/rules/ui_standards.md §
// "Admin surfaces: shared components".
//
// Asserted here:
//   1. no react-bootstrap import in a covered file (AdminSidebar is exempt:
//      its Offcanvas / OverlayTrigger / Tooltip wait for the Sprint H
//      migration);
//   2. no inline style={{...}} in a covered file;
//   3. no Bootstrap utility class in a covered file's className values;
//   4. no duplicated CSS rule body across the covered CSS files (a body
//      counts when it has at least two declarations and at least one
//      non-colour declaration — a pure colour set, e.g. the success triple
//      on a badge and on a button hover, is a token application, not a
//      copied component);
//   5. none of the removed per-tab copies of a shared class is back
//      (denylist);
//   6. every admin-* class a covered file uses is defined where it belongs:
//      the shared families in admin.css, the rest in one of the covered
//      CSS files or src/index.css (admin-tab is the pure data-tab hook and
//      needs no rule);
//   7. admin.css is imported once, from AdminPage, and every tab renders
//      inside <div class="admin-tab" data-tab="...">.
//
// Run: node scripts/check-admin-shared-components.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// The themed surfaces. The older Bootstrap-based surfaces (AdminPage inline
// sections, AdminSecretsSettings, EmailTemplatesSettings) are exempt until
// their theming-branch migration.
const JSX_FILES = [
  '../src/components/admin/DesignsTab.jsx',
  '../src/components/admin/VisitsTab.jsx',
  '../src/components/admin/FaviconUploader.jsx',
  '../src/components/admin/PushSettingsTab.jsx',
  '../src/components/admin/CodeEditor.jsx',
  '../src/components/admin/CodeEditorField.jsx',
  '../src/components/admin/RecentVisitsTable.jsx',
  '../src/components/admin/SuspiciousActivitySection.jsx',
  '../src/components/admin/TopTopicsTable.jsx',
  '../src/components/admin/RankedBarList.jsx',
  '../src/components/admin/DailyVisitsChart.jsx',
  '../src/components/admin/HourlyDistributionChart.jsx',
  '../src/components/admin/WeeklyDistributionChart.jsx',
  '../src/components/admin/UserRecentIPsPanel.jsx',
  '../src/components/modals/AdminIPModal.jsx',
  '../src/components/modals/BanIPModal.jsx',
  // Sidebar: covered by checks 2-3, exempt from check 1 (Offcanvas/Tooltip).
  '../src/components/admin/AdminSidebar.jsx',
];
const REACT_BOOTSTRAP_EXEMPT = new Set(['../src/components/admin/AdminSidebar.jsx']);

const CSS_FILES = [
  '../src/components/admin/admin.css',
  '../src/components/admin/DesignsTab.css',
  '../src/components/admin/VisitsTab.css',
  '../src/components/admin/FaviconUploader.css',
  '../src/components/admin/AdminSidebar.css',
];
const INDEX_CSS = '../src/index.css';
const ADMIN_PAGE = '../src/pages/AdminPage.jsx';

const failures = [];
const fail = (message) => failures.push(message);

// ── 1-3. JSX hygiene ──────────────────────────────────────────────────────

const BOOTSTRAP_UTILITIES = new Set([
  'd-flex', 'd-inline-flex', 'd-block', 'd-inline-block', 'd-none', 'd-grid',
  'flex-row', 'flex-column', 'flex-wrap', 'flex-nowrap',
  'align-items-start', 'align-items-center', 'align-items-end',
  'justify-content-start', 'justify-content-center', 'justify-content-between', 'justify-content-end',
  'text-muted', 'text-center', 'text-start', 'text-end', 'text-danger', 'text-warning',
  'text-success', 'text-primary', 'text-secondary', 'text-nowrap', 'text-truncate', 'text-uppercase',
  'fw-bold', 'fw-normal', 'fw-light', 'small', 'lead',
  'w-100', 'w-50', 'h-100', 'rounded', 'rounded-circle', 'shadow', 'shadow-sm',
  'border', 'border-0', 'bg-light', 'bg-dark', 'bg-white', 'bg-transparent',
  'float-start', 'float-end', 'position-relative', 'position-absolute',
  'overflow-hidden', 'overflow-auto', 'sticky-top', 'fixed-top', 'visually-hidden',
  'list-unstyled', 'container', 'row', 'col',
  'btn', 'btn-primary', 'btn-secondary', 'btn-danger', 'btn-sm',
  'form-control', 'form-label', 'form-check', 'form-select', 'form-text',
  'alert', 'card', 'modal', 'table',
]);
const BOOTSTRAP_UTILITY_RE = /^(m|p)[btesxy]?-\d+$|^gap-\d+$|^col-\d+$|^fs-\d+$|^opacity-\d+$/;

const classNameValues = (source) => {
  const values = [];
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    values.push(raw.replace(/\$\{[^}]*\}/g, ' '));
  }
  return values;
};

const adminCss = read(CSS_FILES[0]);
const allCss = CSS_FILES.map(read).join('\n') + '\n' + read(INDEX_CSS);

for (const file of JSX_FILES) {
  const source = read(file);
  if (!REACT_BOOTSTRAP_EXEMPT.has(file) && /from\s*'react-bootstrap'/.test(source)) {
    fail(`${file}: imports from react-bootstrap — new admin code uses the shared classes in admin.css`);
  }
  if (/style=\{\{/.test(source)) {
    fail(`${file}: inline style={{...}} — put the rule in a CSS file`);
  }
  for (const value of classNameValues(source)) {
    for (const token of value.split(/\s+/).filter(Boolean)) {
      if (BOOTSTRAP_UTILITIES.has(token) || BOOTSTRAP_UTILITY_RE.test(token)) {
        fail(`${file}: Bootstrap utility class "${token}" in className — use a shared admin class or a per-tab class`);
      }
    }
  }
}

// ── 4-5. CSS duplication and the denylist ─────────────────────────────────

const COLOR_PROPS = new Set([
  'background', 'background-color', 'border-color', 'color', 'box-shadow',
]);

// Depth-tracking scan: skips @keyframes, recurses into @media.
const parseCss = (text) => {
  const rules = [];
  const scan = (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf('{', i);
      if (open === -1) break;
      const selector = chunk.slice(i, open).trim();
      let depth = 0;
      let j = open;
      while (j < chunk.length) {
        if (chunk[j] === '{') depth += 1;
        else if (chunk[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      const body = chunk.slice(open + 1, j);
      if (selector.startsWith('@keyframes')) {
        // Skip: identical keyframe bodies are not copied components.
      } else if (selector.startsWith('@media')) {
        scan(body);
      } else if (selector && !selector.startsWith('@')) {
        rules.push({ selector, body });
      }
      i = j + 1;
    }
  };
  scan(text.replace(/\/\*[\s\S]*?\*\//g, ''));
  return rules;
};

const normalizeBody = (body) =>
  body.split(';').map((d) => d.trim()).filter(Boolean).sort().join('; ');

const isColourOnly = (body) => {
  const decls = body.split(';').map((d) => d.trim()).filter(Boolean);
  return decls.length > 0 && decls.every((d) => COLOR_PROPS.has(d.split(':')[0].trim()));
};

const seenBodies = new Map();
for (const file of CSS_FILES) {
  for (const { selector, body } of parseCss(read(file))) {
    const normalized = normalizeBody(body);
    const declCount = normalized.split(';').filter(Boolean).length;
    if (declCount < 2 || normalized.length <= 40 || isColourOnly(normalized)) continue;
    const prev = seenBodies.get(normalized);
    if (prev && prev.file !== file) {
      fail(`${file}: rule "${selector}" duplicates ${prev.file} "${prev.selector}" — the rule lives once, in admin.css`);
    } else if (!prev) {
      seenBodies.set(normalized, { file, selector });
    }
  }
}

// Per-tab copies of a shared class that were removed and must not come back.
const DENYLIST = [
  '.designs-btn', '.designs-switch', '.designs-form__loading',
  '.designs-surface__title', '.designs-surface__desc',
  '.designs-bg-field__row', '.designs-bg-field__actions',
  '.designs-code-field__feedback', '.designs-switch--inline',
  '.visits-text-muted', '.visits-header-actions', '.visits-period-selector',
  '.visits-date-controls', '.visits-refresh-btn',
  '.visits-ranked-item', '.visits-ranked-name',
  '.favicon-uploader__btn', '.favicon-uploader__help', '.favicon-uploader__error',
  '.favicon-uploader__actions',
  '.push-',
];
const DENYLIST_EXCEPTIONS = new Set(['.designs-form__row']);
for (const file of CSS_FILES.slice(1)) {
  for (const { selector } of parseCss(read(file))) {
    for (const part of selector.split(',')) {
      const base = part.trim().split(/[\s:>+~]/)[0];
      if (DENYLIST_EXCEPTIONS.has(base)) continue;
      if (base === '.admin-card' || base.startsWith('.admin-card__') || base.startsWith('.admin-card-')) {
        fail(`${file}: "${base}" lives in admin.css, not here`);
      }
      for (const denied of DENYLIST) {
        if (base === denied || base.startsWith(denied)) {
          fail(`${file}: "${base}" is a removed per-tab copy of a shared class — use the admin-* class instead`);
        }
      }
      // .designs-form__* except the kept two-column row.
      if (base.startsWith('.designs-form__') && base !== '.designs-form__row') {
        fail(`${file}: "${base}" is a removed per-tab copy of .admin-form__* — use the shared class instead`);
      }
    }
  }
}

// ── 6. Shared classes must be defined where they belong ───────────────────

const SHARED_FAMILIES = [
  'admin-btn', 'admin-switch', 'admin-field', 'admin-form', 'admin-actions',
  'admin-card', 'admin-muted', 'admin-title', 'admin-subtitle', 'admin-notice',
  'admin-stack', 'admin-truncate',
];

for (const file of JSX_FILES) {
  const source = read(file);
  for (const value of classNameValues(source)) {
    for (const token of value.split(/\s+/).filter(Boolean)) {
      if (!token.startsWith('admin-')) continue;
      if (token === 'admin-tab') continue; // Pure data-tab hook, needs no rule.
      const family = SHARED_FAMILIES.find((f) => token === f || token.startsWith(`${f}__`) || token.startsWith(`${f}--`));
      const haystack = family ? adminCss : allCss;
      if (!haystack.includes(`.${token}`)) {
        fail(`${file}: class "${token}" is used but not defined in ${family ? 'admin.css' : 'the admin CSS files or index.css'}`);
      }
    }
  }
}

// ── 7. One import, one scope wrapper ───────────────────────────────────────

const adminPage = read(ADMIN_PAGE);
if (!adminPage.includes("import '../components/admin/admin.css';")) {
  fail(`${ADMIN_PAGE}: admin.css is not imported — the shared classes must load once, from here`);
}
if (!adminPage.includes('data-tab={activeTab}')) {
  fail(`${ADMIN_PAGE}: tabs are not wrapped in <div className="admin-tab" data-tab={activeTab}> — per-tab targeting needs that hook`);
}

if (failures.length > 0) {
  console.error(`check-admin-shared-components: ${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('check-admin-shared-components: ok');
