// Temporary audit: compares every frontend sendApi() URL against the routes
// registered in run.go. Run with: node scripts/audit-endpoints.mjs
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'g:/Stacionar/WEB/My Web Sites/forum-Aerun';

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(e)) out.push(p);
  }
  return out;
}

// `${id}` -> `:p` so frontend params match PocketBase's `:p` wildcard.
const norm = (u) => u.replace(/\$\{[^}]*\}/g, ':p').split('?')[0].replace(/\/+$/, '');

// Frontend calls, with the method each is invoked with.
//
// The method is read from INSIDE the sendApi(...) call only. Scanning a fixed
// window past the URL is wrong: a bare `sendApi(url)` on one line picks up the
// `method:` of the NEXT statement and reports a method that was never used.
// So walk forward to the matching close paren and look there.
const calls = new Map(); // "METHOD url" -> "file:line"
for (const f of walk(join(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8');
  const re = /sendApi\(\s*([`'"])(.*?)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const url = m[2];

    // Matching close paren of this sendApi call, skipping string literals.
    let depth = 1, i = m.index + m[0].length, quote = null;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote && src[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '`' || ch === "'" || ch === '"') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const args = src.slice(m.index, i);
    const method = (args.match(/method:\s*['"](\w+)['"]/) || [, 'GET'])[1].toUpperCase();

    const key = `${method} ${norm(url)}`;
    if (!calls.has(key)) {
      const line = src.slice(0, m.index).split('\n').length;
      calls.set(key, `${f.replace(ROOT + '/', '')}:${line}`);
    }
  }
}

// Backend routes.
const runSrc = readFileSync(join(ROOT, 'backend/internal/platform/pocketbase/run.go'), 'utf8');
const routes = new Set();
const re2 = /group\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"\s*,/g;
let r;
while ((r = re2.exec(runSrc)) !== null) {
  routes.add(`${r[1]} /api/aerun${r[2]}`.replace(/\{[a-zA-Z]+\}/g, ':p').replace(/\/+$/, ''));
}

const missing = [];
for (const [key, where] of [...calls].sort()) {
  // A concrete segment MAY satisfy a `{param}` placeholder, because the
  // backend registers the pattern and the client spells one instance of it.
  // `/me/auth/google` is served by `/me/auth/{provider}`.
  //
  // Without this the audit reports a permanent false positive, and a signal that
  // is always wrong is a signal people stop reading — which is how a REAL
  // missing route (a Go route added while the server ran an older binary, 404 in
  // the browser) hides in the same report as this one.
  const segs = key.split(' ');
  const path = segs[1].split('/');
  const [method] = segs;
  const matches = [...routes].some((r) => {
    const [rm, rp] = r.split(' ');
    if (rm !== method) return false;
    const rs = rp.split('/');
    if (rs.length !== path.length) return false;
    return rs.every((s, i) => s === ':p' || s === path[i]);
  });
  if (!matches) missing.push({ key, where });
}

console.log(`frontend call shapes: ${calls.size}`);
console.log(`backend routes registered: ${routes.size}`);
console.log(`\nFRONTEND CALLS WITH NO MATCHING BACKEND ROUTE (${missing.length}):`);
for (const m of missing) console.log(`  ${m.key}\n      ${m.where}`);