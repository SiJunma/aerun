// Every action_type the backend can write must have an EN and RU label.
//
// Reported as "нету ключей переводов admin.audit.actions.topic_delete,
// .post_delete, .topic_move". Those three were written by the backend but never
// added to dictionary.js, while the table renders `t('admin.audit.actions.' +
// action_type)`. Worse, the search filter LOWERCASES that same lookup to decide
// whether a row matches — so a missing key made those rows UNSEARCHABLE, not
// just untranslated.
//
// The list is extracted from the Go sources rather than hand-maintained: a hand
// list is exactly what drifted in the first place, and it fails silently the
// next time somebody adds an audit call.
//
// Run: node scripts/check-audit-action-labels.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const backendDir = join(root, 'backend', 'internal');

const walkGo = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkGo(full));
    else if (entry.endsWith('.go')) out.push(full);
  }
  return out;
};

// recordAuditLog(txApp, "topic_delete", ...) — the literal that follows the call.
// The app argument is an IDENTIFIER, and it is not always a bare name: several
// call sites pass `e.App` directly. `[\w.]+` rather than `\w+`, because the
// narrower pattern silently skipped those calls and reported "all translated"
// while missing exactly the actions written that way.
// The helper's own `actionType` parameter is not a call site and must not match.
const CALL = /recordAuditLog\(\s*[\w.]+\s*,\s*"([a-z_]+)"/g;

const backendActions = new Set();
for (const file of walkGo(backendDir)) {
  for (const m of readFileSync(file, 'utf8').matchAll(CALL)) backendActions.add(m[1]);
}

const dictionary = readFileSync(join(root, 'src', 'i18n', 'dictionary.js'), 'utf8');

// The EN and RU `actions:` blocks are structurally identical.
const blocks = [...dictionary.matchAll(/actions:\s*\{([\s\S]*?)\n\s{8}\},/g)].map((m) => m[1]);
if (blocks.length < 2) {
  console.error(`expected 2 audit action blocks in dictionary.js, found ${blocks.length}`);
  process.exit(1);
}

const keysOf = (block) => new Set([...block.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));

const failures = [];
['EN', 'RU'].forEach((lang, index) => {
  const keys = keysOf(blocks[index]);
  for (const action of [...backendActions].sort()) {
    if (!keys.has(action)) {
      failures.push(`${lang}: no admin.audit.actions.${action} — the backend writes it, so the ` +
        'audit row renders a raw key AND the search box cannot match it');
    }
  }
  // The other direction. A label the backend can never produce is not a
  // translation, it is residue: 22 of them survived the cutover under the
  // Firestore-era names (`topic_deleted` for `topic_delete`, and so on). They
  // read as coverage to whoever maintains the dictionary, so they are removed
  // and kept removed.
  for (const key of [...keys].sort()) {
    if (!backendActions.has(key)) {
      failures.push(`${lang}: orphaned admin.audit.actions.${key} — no backend action writes ` +
        'this name, so it is dead weight from the pre-PocketBase era');
    }
  }
});

if (failures.length > 0) {
  console.error(`audit action labels (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`OK  audit labels: all ${backendActions.size} backend action types are translated in EN and RU`);
console.log('OK  audit labels: the search box can match every row it renders');
console.log('OK  audit labels: no orphaned labels left behind by the pre-PocketBase era');