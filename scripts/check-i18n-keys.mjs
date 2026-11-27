// Every translation key the frontend renders must exist in dictionary.js
// in both EN and RU.
//
// Reported as a console full of "[i18n] missing translation key
// admin.settings.smtp_port ..." — the whole Secrets & Integrations page
// (AdminSecretsSettings.jsx, added with the visits dashboard) was never
// added to the dictionary at all: 37 keys missing in EN and RU. The UI
// silently fell back to the hardcoded English strings in the t() calls,
// so the page looked fine in English while Russian admins saw English
// labels and the console filled with warnings. The same drift hit the
// admin navigation titles (admin.settings.sections.*), which are bare
// string literals resolved through t() later, not t('...') calls.
//
// The check extracts every statically used key from src/ — t('...') /
// t?.('...') calls and bare dotted literals in config objects — and
// requires each one in both languages. It also requires the EN and RU
// key sets to be identical, as the dictionary header demands.
//
// Dynamic lookups (t(`error.${kind}_title`), t('common.language_' + lang),
// t('admin.audit.actions.' + type)) cannot be verified statically and are
// counted, not checked. A few dotted-string patterns are not translation
// keys at all and are excluded: filenames (avatar.png), realtime signal
// topics (dm.post — the bare-literal scan skips src/api, which never
// renders UI), and key-prefix fragments (common.language_).
//
// Run: node scripts/check-i18n-keys.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translations } from '../src/i18n/dictionary.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

// --- dictionary key sets (dotted leaf paths) ---
const leafKeys = (obj, prefix = '') => {
  const out = new Set();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // Arrays are values, not nested objects: t('admin.visits.charts.month_names')
    // returns the whole array, so month_names itself is the leaf key.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const sub of leafKeys(value, path)) out.add(sub);
    } else {
      out.add(path);
    }
  }
  return out;
};

const enKeys = leafKeys(translations.en);
const ruKeys = leafKeys(translations.ru);
const namespaces = new Set(Object.keys(translations.en));

// --- scan src for used keys ---
const walkJs = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (/\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
};

// Static t('key', ...) / t('key') / t?.('key', ...) — the quote must be
// followed by , or ), so a concatenated first argument like
// t('admin.audit.actions.' + type) does not match as a key.
const STATIC_T = /(?<![\w$.])t\s*\??\.?\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g;
const ANY_T = /(?<![\w$.])t\s*\??\.?\s*\(/g;
const BARE = /['"]([a-z][a-z0-9_.]*\.[a-z0-9_.]+)['"]/g;
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|js|mjs|cjs|css|json|html|md)$/;

const used = new Map(); // key -> Set(files)
let dynamicCalls = 0;

for (const file of walkJs(srcDir)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  const staticMatches = [...text.matchAll(STATIC_T)];
  for (const m of staticMatches) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(rel);
  }
  dynamicCalls += [...text.matchAll(ANY_T)].length - staticMatches.length;
  // Bare literals: config-stored keys resolved through t() later
  // (admin navigation titles, language labelKeys, ternary branches
  // inside t()). The API layer never renders UI, and its dotted strings
  // are signal topics and field paths, not translation keys.
  if (!rel.startsWith(`src${sep}api${sep}`)) {
    const stripped = text.replace(/t\s*\??\.?\s*\(\s*['"][^'"]+['"]\s*[,)]/g, 't()');
    for (const m of stripped.matchAll(BARE)) {
      const key = m[1];
      if (!namespaces.has(key.split('.')[0])) continue;
      if (key.endsWith('_')) continue; // key-prefix fragment, e.g. common.language_
      if (FILE_EXT.test(key)) continue; // filename, e.g. avatar.png
      if (!used.has(key)) used.set(key, new Set());
      used.get(key).add(rel);
    }
  }
}

const failures = [];
// Keys only reachable through dynamic lookups (t(`admin.tabs.${activeTab}`))
// — the static scan cannot see them, so they are asserted here by hand.
// AdminPage builds the title/breadcrumb key from the hyphenated tab id;
// the nav configs use the underscore spellings, so both must exist.
const REQUIRED_KEYS = [
  'admin.tabs.designs-defaults',
  'admin.tabs.designs-custom',
  'admin.tabs.designs-builtin',
];
for (const key of REQUIRED_KEYS) {
  if (!enKeys.has(key)) failures.push(`EN: no ${key} — required dynamic key (see REQUIRED_KEYS)`);
  if (!ruKeys.has(key)) failures.push(`RU: no ${key} — required dynamic key (see REQUIRED_KEYS)`);
}
for (const key of [...used.keys()].sort()) {
  if (!enKeys.has(key)) {
    failures.push(`EN: no ${key} — used in ${[...used.get(key)].sort().join(', ')}`);
  }
  if (!ruKeys.has(key)) {
    failures.push(`RU: no ${key} — used in ${[...used.get(key)].sort().join(', ')}`);
  }
}
for (const key of [...enKeys].sort()) {
  if (!ruKeys.has(key)) failures.push(`SYNC: ${key} exists in EN but not in RU`);
}
for (const key of [...ruKeys].sort()) {
  if (!enKeys.has(key)) failures.push(`SYNC: ${key} exists in RU but not in EN`);
}

if (failures.length > 0) {
  console.error(`i18n keys (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`OK  i18n keys: all ${used.size} used keys exist in EN and RU`);
console.log(`OK  i18n keys: EN and RU key sets are identical (${enKeys.size} keys)`);
console.log(`OK  i18n keys: ${dynamicCalls} dynamic lookups skipped (verified by hand, not by this check)`);
// Keys nothing references statically are usually dynamic lookups
// (error.*_title, admin.audit.actions.*, common.language_*), not dead
// weight — listed for a human to glance at, not failed on.
const unused = [...enKeys].filter((k) => !used.has(k)).sort();
if (unused.length > 0) {
  const shown = unused.slice(0, 15);
  console.log(`note: ${unused.length} dictionary keys are not statically referenced: ${shown.join(', ')}${unused.length > 15 ? ` (+${unused.length - 15} more)` : ''}`);
}
