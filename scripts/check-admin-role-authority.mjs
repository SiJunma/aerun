#!/usr/bin/env node
// check-admin-role-authority.mjs — the admin panel must offer exactly what the
// server will accept, and must know who holds the chief-admin role from the
// ROLE rather than from the address.
//
// Four reported defects share one root: the panel and the server disagreed
// about authority.
//
//   A1  the chief admin's badge was a class apart from the administrator's
//       (wider padding, larger font) — it read as a different badge.
//   A2  after a root handover the ex-root kept the "Transfer role" button on
//       the NEW root's row, and the new root did not get one on their own.
//       The cause: "am I root?" was answered by the EMAIL.
//   A3  the delete confirmation did not name the account it was deleting.
//   A5  an admin could open their OWN role dialog and then be refused by the
//       server with "you can only change the role of an account ranked
//       strictly below yours".
//
// WHY A SOURCE-SHAPE CHECK. A2 and A5 are decisions — "who may do what" — and
// a decision that silently reverts reads as a pass. The assertions below pin
// the SHAPE of those decisions: the role is read from the profile/list rather
// than from the auth snapshot's email, the panel filters the role editor by
// the server's own matrix, and the confirmation names its subject.
//
// Run: node scripts/check-admin-role-authority.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// Comments are stripped before the code is inspected.
//
// The reason is specific and not theoretical: the code under test CARRIES the
// old shape in its comments — "it used to be `isChiefAdmin(user?.email,
// user?.role_id)`" — and a gate that matched its own documentation would have
// to be deleted rather than obeyed. Every assertion below therefore reads
// executable code, and the comments are read by a human.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const pageRaw = read('../src/pages/AdminPage.jsx');
const permsRaw = read('../src/constants/permissions.js');
const dict = read('../src/i18n/dictionary.js');
const css = read('../src/index.css');
const adminUsersGo = read('../backend/internal/platform/pocketbase/admin_users.go');

const page = stripComments(pageRaw);
const perms = stripComments(permsRaw);

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ── The server's matrix, quoted from where it lives ──────────────────────────
//
// The client mirror is only a mirror if the authority it mirrors is still the
// authority. These three lines ARE the rule (checkRoleChange in
// admin_users.go); if the server changes, this check fails and the client
// mirror is revisited instead of silently drifting.
check(
  /newAuthRole == auth\.RoleRoot/.test(adminUsersGo) &&
    /"only the chief admin may appoint an administrator"/.test(adminUsersGo) &&
    /"you can only change the role of an account ranked strictly below yours"/.test(adminUsersGo),
  'backend: checkRoleChange no longer reads as the authority matrix the client mirrors — ' +
    'the client mirror (root → anyone; admin → strictly lower; admin may not appoint admin) ' +
    'must be revisited'
);

// ── A2 / A5: the role is read from the ROLE, not from the email ─────────────
//
// The auth-store snapshot (`user`) is { uid, email, displayName, ... } — it
// carries no role at all. So any "am I root?" question answered from it fell
// through to the email comparison, which is exactly the alias that made the
// ex-root look like a chief admin forever after the handover.
check(
  !/isChiefAdmin\(user\?\.email/.test(page),
  'src/pages/AdminPage.jsx: the panel must not decide "am I root?" from the auth snapshot email — ' +
    'the snapshot carries no role, so the answer came from the founder alias and survived a handover'
);
check(
  /profile\?\.role_id|users\.find\(/.test(page),
  'src/pages/AdminPage.jsx: the panel must read the viewer\'s role from the server ' +
    '(profile.role_id or the staff list), not from the auth snapshot'
);
check(
  /const isSelfRoot = myRoleId === CHIEF_ADMIN_ID/.test(page),
  'src/pages/AdminPage.jsx: the handover button must be gated on the viewer\'s actual role id'
);
check(
  /isChiefAdmin\(u\.email, u\.role_id\)|u\.role_id === CHIEF_ADMIN_ID/.test(page),
  'src/pages/AdminPage.jsx: the protected row must be recognised by the role column'
);

// The alias itself: the ROLE decides, and the email is only a fallback for a
// missing role. A role-first answer is what makes a handover stick.
check(
  /export const isChiefAdmin = \(userEmail, roleId\) => \{[\s\S]{0,400}?if \(roleId\) return roleId === CHIEF_ADMIN_ID;/.test(perms),
  'src/constants/permissions.js: isChiefAdmin must answer by the role first — the email may only ' +
    'stand in for a role that is not known'
);
check(
  /export const resolveUserRoleId = \(userEmail, roleId\) => \{[\s\S]{0,2000}?if \(roleId\) return roleId;/.test(perms),
  'src/constants/permissions.js: resolveUserRoleId must answer by the role first — otherwise the ' +
    'founder alias keeps rendering a Chief Admin badge for the account that handed the role over'
);

// The email fallback must still be guarded: `undefined === undefined` is true,
// and VITE_ADMIN_EMAIL is absent from some builds.
check(
  /adminEmail && userEmail && userEmail === adminEmail/.test(perms),
  'src/constants/permissions.js: the email fallback must check that both sides are real values — ' +
    'otherwise every account without an email is promoted to chief admin'
);

// ── A1: one chip for both roles, with a hook for the difference ──────────────
//
// The chief admin's badge used to be `px-3` / 0.85rem against the
// administrator's `px-2` / 0.8rem. The metrics must match; the distinction
// belongs to a class.
const chiefAdminBadge = page.match(/role-badge badge-root[^}]*}/);
check(
  Boolean(chiefAdminBadge),
  'src/pages/AdminPage.jsx: the chief admin\'s badge must carry the `badge-root` class'
);
// The metrics live on the NEXT line, in the `style` attribute — the className
// template ends before them, so the window has to reach past it.
const chiefAdminBadgeBlock = page.match(/role-badge badge-root[\s\S]{0,400}?style=\{\{ fontSize: '0\.8rem' \}\}/);
check(
  Boolean(chiefAdminBadgeBlock) && /px-2/.test(chiefAdminBadgeBlock[0]),
  'src/pages/AdminPage.jsx: the chief admin\'s badge must use the SAME metrics as the ' +
    'administrator\'s (px-2 / 0.8rem) — the difference belongs to the class, not to the size'
);
check(
  !/role-badge px-3[^`]*fontSize: '0\.85rem'/.test(page),
  'src/pages/AdminPage.jsx: the oversized chief-admin badge metrics (px-3 / 0.85rem) are back'
);
check(
  /\.role-badge\.badge-root\s*\{/.test(css),
  'src/index.css: `.badge-root` needs a rule — the class is the hook the admin panel uses to ' +
    'mark the office without changing the chip\'s size'
);

// ── A5: the panel offers only what the server accepts ───────────────────────
//
// The editor must be reachable only for accounts the viewer may re-role, and
// the role list must exclude the ones the viewer may not assign.
//
// The editor must be reachable only for accounts the viewer may re-role, and
// the role list must exclude the ones the viewer may not assign.
check(
  /const canChangeRoleOf = \(targetRoleId\)/.test(page) &&
    /canChangeRoleOf\(u\.role_id\)/.test(page),
  'src/pages/AdminPage.jsx: the role editor must be gated by canChangeRoleOf — the server refuses ' +
    'an admin\'s own role and an equal-ranked one'
);
check(
  /targetRank < myRank/.test(page),
  'src/pages/AdminPage.jsx: the target must rank STRICTLY below the viewer — the server compares ' +
    'the same way ("strictly below yours")'
);
check(
  /const assignableRoles = roles\.filter/.test(page) &&
    /assignableRoles\.map\(/.test(page),
  'src/pages/AdminPage.jsx: the role list must come from assignableRoles — `root` is transferred, ' +
    'never assigned, and only the chief admin may appoint an administrator'
);
check(
  /if \(!assignableRoles\.some\(\(r\) => r\.id === userForm\.role_id\)\)/.test(page),
  'src/pages/AdminPage.jsx: the save path must refuse a role the viewer may not assign — the guard ' +
    'belongs where the request is made, not only where the list is rendered'
);
check(
  /if \(!canChangeRoleOf\(editingUser\.role_id\)\)/.test(page),
  'src/pages/AdminPage.jsx: the save path must re-check the TARGET as well — the authority to ' +
    'edit is a property of both accounts, and either can change while the dialog is open'
);

// ── The role editor must not be locked for an admin, and must not erase ──────
//
// The role DEFINITION editor (the Roles tab) had its own authority check that
// the server does not have. The server binds PATCH/POST/DELETE /roles to
// `manage_roles` and adds no rank rule; the panel compared the viewer's rank
// against the target's, reading two fields that do not exist, so the check
// always failed and an admin could not edit any role.
//
// The second half is the dangerous one: the editor CLAMPED a role's permissions
// to MAX_ROLE_PERMISSIONS[role.id], and a CUSTOM role has no entry there — so
// the clamp was an empty list and saving the role wrote an empty permission
// set. Unlocking the button without fixing that would have turned "the buttons
// are greyed out" into "an admin can silently wipe a custom role's powers".
check(
  /const canEditRole = useCallback\([\s\S]{0,600}?hasPermission\(PERMISSIONS\.MANAGE_ROLES\)/.test(page),
  'src/pages/AdminPage.jsx: the role editor must be gated on manage_roles alone — the server binds ' +
    'PATCH/POST/DELETE /roles to that permission and adds no rank rule of its own'
);
check(
  !/ROLE_LEVELS/.test(page),
  'src/pages/AdminPage.jsx: ROLE_LEVELS is a second, local rank table that disagreed with the ' +
    "server's — the panel's authority checks must read the server's ranks, not a private copy"
);
check(
  !/MAX_ROLE_PERMISSIONS\[role\.id\]/.test(page),
  'src/pages/AdminPage.jsx: the role editor must not clamp a role\'s permissions to ' +
    'MAX_ROLE_PERMISSIONS[role.id] — a custom role has no entry there, so the clamp was empty and ' +
    'saving the role erased its permissions'
);
check(
  /KNOWN_PERMISSIONS\.has\(p\)/.test(page),
  'src/pages/AdminPage.jsx: the role editor must drop only the permission keys the server does not ' +
    'know — an unknown key makes the whole role unsaveable with a 400'
);
check(
  /storedPerms\.includes\(p\)/.test(page),
  'src/pages/AdminPage.jsx: a permission the role already holds must stay VISIBLE even when it sits ' +
    'above the role\'s ceiling — an invisible permission can never be taken away'
);

// ── A3: the confirmation names its subject ───────────────────────────────────
check(
  /confirm_delete_message_named/.test(page) && /\{ nickname \}/.test(page),
  'src/pages/AdminPage.jsx: the delete confirmation must name the account it is deleting'
);
// Both languages carry the key, and BOTH interpolate the nickname: the key is
// looked up per language, so a missing or placeholder-less translation in one
// language is a confirmation about nobody in that language.
const namedEntries = [...dict.matchAll(/confirm_delete_message_named:\s*"([^"]*)"/g)].map((m) => m[1]);
check(
  namedEntries.length >= 2,
  'src/i18n/dictionary.js: confirm_delete_message_named must exist in BOTH languages — ' +
    'the dictionary is looked up per language, so a missing translation is a confirmation about nobody'
);
for (const entry of namedEntries) {
  check(
    entry.includes('{nickname}'),
    'src/i18n/dictionary.js: every confirm_delete_message_named must interpolate {nickname}'
  );
}

// The checkbox for "delete their posts too" belongs INSIDE the dialog: as a
// sibling of the modal it sat behind the backdrop, reachable but not visible.
check(
  /confirmState\.kind === 'delete-user'/.test(page) &&
    /kind: 'delete-user'/.test(page),
  'src/pages/AdminPage.jsx: the delete dialog must be identified by an explicit kind — comparing the ' +
    'rendered title against a translated string drops the dialog\'s own options when the wording changes'
);

if (failures.length > 0) {
  console.error(`admin role authority regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  admin role authority: root is read from the role, not the address');
console.log('OK  admin role authority: the badge metrics match; `badge-root` is the hook');
console.log('OK  admin role authority: the role editor mirrors the server matrix');
console.log('OK  admin role authority: the delete confirmation names its subject');
