// Two date-handling defects that crash a whole page.
//
// REPORTED: "the audit log in the admin panel crashes" —
//   Uncaught TypeError: a.created_at?.toMillis is not a function
// which unmounted the entire AdminPage behind an error boundary.
//
// The audit payload carries an ISO string under `created` (auditLogPayload in
// backend/internal/platform/pocketbase/audit.go), and normalizePost hands pages
// a plain Date. Neither carries toMillis()/toDate() — those belonged to the
// Firestore Timestamp the migration removed.
//
// This gate pins only the two shapes that actually broke. A blanket ban on the
// accessors would be wrong: `x.toMillis ? x.toMillis() : new Date(x)` is a
// legitimate already-guarded read and appears throughout the tree.
//
//   1. THE OPTIONAL-CHAINING TRAP — x?.toMillis().
//      `?.` guards a null/undefined VALUE, not a TYPE. On a string or a Date it
//      calls the method and throws. That is the reported crash verbatim.
//
//   2. A PRE-CONVERTED <Timestamp> — <Timestamp date={x.toDate()} />.
//      Timestamp already accepts Firestore Timestamps, {seconds,nanoseconds}
//      caches, Dates and strings, so converting at the call site is redundant —
//      and on a string it throws, which is the same crash one render later. The
//      correct form is to pass the value straight through.
//
// Run: node scripts/check-date-accessors.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.jsx?$/.test(entry)) out.push(full);
  }
  return out;
};

// Comments quote the offending expressions verbatim while explaining why they
// went, so a gate that failed on its own documentation would be deleted rather
// than obeyed.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const failures = [];
const fail = (file, line, message) =>
  failures.push(`${file.replace(srcRoot, 'src')}:${line} — ${message}`);

const OPTIONAL_CHAIN_TRAP = /\?\.\s*to(?:Millis|Date)\s*\(/g;
const PRECONVERTED = /<Timestamp\b[^>]*date=\{[^}]*\.toDate\s*\(\s*\)/g;

for (const file of walk(srcRoot)) {
  const code = stripComments(readFileSync(file, 'utf8'));
  code.split(/\r?\n/).forEach((line, i) => {
    OPTIONAL_CHAIN_TRAP.lastIndex = 0;
    if (OPTIONAL_CHAIN_TRAP.test(line)) {
      fail(file, i + 1,
        'calls a date accessor behind `?.`, which guards a null value but not a wrong ' +
        'TYPE — on a string or Date this throws and unmounts the page');
    }
    PRECONVERTED.lastIndex = 0;
    if (PRECONVERTED.test(line)) {
      fail(file, i + 1,
        'passes an already-converted date to <Timestamp> — Timestamp handles Timestamps, ' +
        'Dates and strings itself, and toDate() throws on a string');
    }
  });
}

if (failures.length > 0) {
  console.error(`date-handling regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  dates: no `?.toDate()`/`?.toMillis()` — the type-unsafe optional-chain trap');
console.log('OK  dates: <Timestamp> receives raw values, so no render site converts them');