// check-account-status-axis.mjs — role and status are DIFFERENT axes and must
// not be confused.
//
// The legacy app stored account state inside role_id ("pending", "banned", with
// the real role parked in previous_role_id). The target contract split them
// (internal/auth/status.go); the importer translates the pseudo-roles on the way
// in (importer/compat.go MapUserRole). The frontend still spoke the old
// dialect, which failed in two directions:
//
//   - WRITES: banUser sent role:'banned', and the role column validates against
//     the roles registry (requireKnownRole), where no such row exists — every
//     ban came back 400 "invalid role value".
//   - READS: the panel and the route guard judged a ban by role_id === 'banned',
//     so a banned account rendered "Active" and was routed as a full member
//     while the server had already stripped its permissions.
//
// Both halves are pinned here: no mutation may name a pseudo-role, and no
// decision about account state may read it off the role.

import { readFileSync } from 'node:fs';

const api = readFileSync('src/api/admin.js', 'utf8');
const page = readFileSync('src/pages/AdminPage.jsx', 'utf8');
const guard = readFileSync('src/components/common/ProtectedRoute.jsx', 'utf8');

const failures = [];
const PSEUDO_ROLES = ['banned', 'pending'];

const bodyOf = (src, name) => {
  const start = src.indexOf(`export const ${name} = async`);
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport const /);
  return next === -1 ? rest : rest.slice(0, next);
};

// --- 1. A mutation must never name a pseudo-role as the role -----------------
for (const name of ['banUser', 'unbanUser', 'approveUser', 'updateUserRole']) {
  const body = bodyOf(api, name);
  if (body === null) {
    failures.push(`src/api/admin.js: ${name} is missing`);
    continue;
  }
  // Only the role field matters; a status may legitimately be "banned".
  for (const pseudo of PSEUDO_ROLES) {
    if (new RegExp(`role:\\s*['"\`]${pseudo}['"\`]`).test(body)) {
      failures.push(
        `src/api/admin.js: ${name} sends role:'${pseudo}' — ${pseudo} is an account ` +
        'status, not a role, so the server rejects it with 400 "invalid role value"'
      );
    }
  }
}

// --- 2. A role change must not smuggle in a status --------------------------
// Assigning a role says nothing about whether the account is banned. Flipping
// the status as a side effect silently unbans (or bans) whoever was picked.
const roleBody = bodyOf(api, 'updateUserRole');
if (roleBody !== null && /status\s*:/.test(roleBody)) {
  failures.push(
    'src/api/admin.js: updateUserRole writes a status alongside the role — ' +
    'changing a role must not unban or ban the account'
  );
}

// --- 3. Account-state decisions must read `status` ---------------------------
const roleStateReads = [];
const scan = (src, label) => {
  for (const pseudo of PSEUDO_ROLES) {
    const re = new RegExp(`\\.?role_id\\s*[!=]==?\\s*['"\`]${pseudo}['"\`]`, 'g');
    const hits = src.match(re);
    if (hits) roleStateReads.push(`${label}: ${hits.length} check(s) on role_id === '${pseudo}'`);
  }
};
scan(page, 'src/pages/AdminPage.jsx');
scan(guard, 'src/components/common/ProtectedRoute.jsx');
for (const r of roleStateReads) {
  failures.push(
    `${r} — account state lives in the status column, so these checks never fire ` +
    'and the UI shows a banned or pending account as ordinary'
  );
}

if (failures.length > 0) {
  console.error('FAIL  account status axis:');
  for (const f of failures) console.error(`      ${f}`);
  process.exit(1);
}

console.log('OK  account status axis: no mutation names a pseudo-role as the role');
console.log('OK  account status axis: ban/pending are read from the status column');