// The category page's "Manage" button must explain what happens next.
//
// Reported as "the Manage button doesn't open a menu, it only changes to Done".
// It was never a menu: it is a toggle for bulk-select mode, and the action bar
// (Pin / Lock / Move / Delete) is FIXED to the bottom of the viewport. The bar
// was gated on `selectedTopicIds.length > 0`, so pressing Manage changed the
// button label and nothing else appeared — the one element on screen that would
// have said "tick some topics first" was the very element the gate suppressed.
//
// This is a silent no-op rather than an error, which is why it needs a shape
// gate: nothing throws, nothing logs, the console stays clean and the page looks
// healthy, so only the source shape reveals the missing affordance.
//
// Run: node scripts/check-manage-mode-affordance.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// Comments quote the old condition constantly while explaining why it went, so a
// gate that failed on its own documentation would be deleted rather than obeyed.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const categoryPage = stripComments(read('../src/pages/CategoryPage.jsx'));
const forumViewCss = read('../src/styles/forum-view.css');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

check(
  /\{isManaging && \(/.test(categoryPage),
  'the management toolbar must render for the WHOLE manage mode — gating it on ' +
    'selectedTopicIds.length > 0 removes the only on-screen hint that topics must be ' +
    'ticked, so pressing Manage looks like a button that does nothing'
);
check(
  /management-toolbar-hint/.test(categoryPage),
  'the toolbar must carry an explicit instruction while nothing is selected'
);
check(
  /selectedTopicIds\.length === 0 && \(\s*<div className="management-toolbar-hint"/.test(categoryPage),
  'the hint must be conditional on nothing being selected, so it disappears once the ' +
    'member starts ticking topics instead of competing with the counter'
);
check(
  (categoryPage.match(/disabled=\{selectedTopicIds\.length === 0\}/g) || []).length >= 6,
  'every action button must be disabled while nothing is selected — an enabled Pin or ' +
    'Delete that silently no-ops is the same dead end the hint exists to prevent'
);
check(
  /\.management-toolbar-hint\s*\{/.test(forumViewCss),
  'the hint needs its own CSS rule: without it the text wraps badly inside the fixed bar'
);

if (failures.length > 0) {
  console.error(`manage-mode affordance regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  manage mode: the action bar appears immediately, not only after a tick');
console.log('OK  manage mode: it says out loud that topics must be selected first');
console.log('OK  manage mode: the actions stay disabled until there is something to act on');