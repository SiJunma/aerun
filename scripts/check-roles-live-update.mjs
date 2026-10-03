#!/usr/bin/env node
// check-roles-live-update.mjs — the roles table must repaint on its own after a
// mutation.
//
// The bug this pins down: the registry lives in ONE place (AuthProvider's
// `roles`), fed by subscribeToRoles. Each of addRole/updateRole/deleteRole used
// to call invalidateRolesCache(), which only nulled the module-level cache.
// Nothing re-read it, so the table kept painting the pre-mutation list until a
// full page reload. Clearing a cache that nobody reads is not a refresh.
//
// It also pins the second half: the mutations swallowed their errors into
// console.warn and resolved normally, so a rejected request produced a SUCCESS
// toast and a stale table at the same time — the two failures masked each other.

import { readFileSync } from 'node:fs';

const api = readFileSync('src/api/admin.js', 'utf8');
const page = readFileSync('src/pages/AdminPage.jsx', 'utf8');

const failures = [];

// --- 1. A mutation must re-read and notify, not just drop the cache ---------
for (const name of ['addRole', 'updateRole', 'deleteRole']) {
  const start = api.indexOf(`export const ${name} = async`);
  if (start === -1) {
    failures.push(`src/api/admin.js: ${name} is missing`);
    continue;
  }
  // Bound the slice at the next export so updateRole's body cannot be read as
  // deleteRole's, and vice versa.
  const rest = api.slice(start + 1);
  const next = rest.search(/\nexport const /);
  const body = next === -1 ? rest : rest.slice(0, next);

  if (!/await refreshRoles\(\)/.test(body)) {
    failures.push(
      `src/api/admin.js: ${name} does not call refreshRoles() — clearing the cache ` +
      'leaves the roles table showing the pre-mutation list'
    );
  }
  if (!/throw err/.test(body)) {
    failures.push(
      `src/api/admin.js: ${name} swallows the error — a refused mutation would ` +
      'still resolve and the admin would see a success toast over a failed write'
    );
  }
}

// --- 2. The cache must notify its subscribers ------------------------------
if (!/const _roleSubscribers = new Set\(\)/.test(api)) {
  failures.push(
    'src/api/admin.js: no subscriber registry — refreshRoles() has nobody to push ' +
    'the new list to, so AuthProvider never learns about the mutation'
  );
}

if (!/_roleSubscribers\.(add|delete)/.test(api)) {
  failures.push('src/api/admin.js: subscribers are never registered or removed');
}

if (!/refreshRoles[\s\S]{0,400}?cb\(snapshot\)|cb\(snapshot\)/.test(api)) {
  failures.push('src/api/admin.js: a re-read never notifies the subscribers');
}

// --- 3. The panel must not hold its own copy of the registry ---------------
if (/invalidateRolesCache/.test(page) || /invalidateRolesCache/.test(api)) {
  failures.push(
    'invalidateRolesCache still referenced — it nulled the cache without ' +
    're-reading it, which is the shape of the original bug'
  );
}

// --- 4. base_role_id has to survive the read --------------------------------
// The pre-fill for a derived role and the delete-revert both read it. Dropping
// it in the normalizer made both undefined for every role that had one.
const normalize = api.match(/const normalizeRole = [\s\S]*?\n\}\);/);
if (!normalize) {
  failures.push('src/api/admin.js: normalizeRole is missing');
} else if (!/base_role_id/.test(normalize[0])) {
  failures.push(
    'src/api/admin.js: normalizeRole drops base_role_id — the create-role ' +
    'pre-fill and the delete-revert would both read undefined'
  );
}

// --- 5. A refused delete must show why --------------------------------------
if (/showToast\(t\('admin\.roles\.error_delete'\)/.test(page) &&
    !/err\?\.message \|\| t\('admin\.roles\.error_delete'\)/.test(page)) {
  failures.push(
    'src/pages/AdminPage.jsx: a failed delete shows the generic toast instead of ' +
    "the server's reason (a category still grants the role, or no base to revert to)"
  );
}

if (failures.length > 0) {
  console.error('FAIL  roles live update:');
  for (const f of failures) console.error(`      ${f}`);
  process.exit(1);
}

console.log('OK  roles live update: add/update/delete re-read the registry and notify subscribers');
console.log('OK  roles live update: a refused mutation surfaces the server message');