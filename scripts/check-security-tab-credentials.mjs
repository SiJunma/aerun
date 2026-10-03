// Regression test for the Security tab.
//
// It displayed two hardcoded constants as account facts:
//
//	const hasGoogle = false;
//	const hasPassword = true;
//
// so every member was told their Google account was unlinked and their
// password linked — the exact opposite of the truth for an account that has
// only ever signed in with Google (no password at all) or one whose password
// the importer generated and never showed anybody.
//
// The "add password" form underneath then saved through
// pb.collection('users').update(...), which this backend forbids by design:
// migration 1766000000 sets users.UpdateRule = nil, so browser writes are
// locked and every credential change is a server command. The form could never
// have succeeded.
//
// Run: node scripts/check-security-tab-credentials.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const tab = fs.readFileSync(new URL('../src/components/profile/SecurityTab.jsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../src/api/account-credentials.js', import.meta.url), 'utf8');
const dict = fs.readFileSync(new URL('../src/i18n/dictionary.js', import.meta.url), 'utf8');
const creds = fs.readFileSync(
  new URL('../backend/internal/platform/pocketbase/account_credentials.go', import.meta.url), 'utf8'
);
const credsTest = fs.readFileSync(
  new URL('../backend/internal/platform/pocketbase/account_credentials_test.go', import.meta.url), 'utf8'
);

// ── The display must come from the server, not from constants ───────────────
// The prose above the component quotes the old lines on purpose (that IS the
// bug being documented), so the scan runs against the code with comments
// stripped — otherwise this check would match its own explanation forever.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const tabCode = stripComments(tab);

assert.ok(
  !/const hasGoogle = false;/.test(tabCode) && !/const hasPassword = true;/.test(tabCode),
  'the tab must not hardcode the linked state of an account'
);
assert.match(tab, /fetchMyAuthState\(\)/, 'the tab must load the real state from the server');
assert.match(tab, /auth\?\.hasPassword \?/, 'the password row must render the fetched fact');
assert.match(tab, /auth\?\.googleLinked \?/, 'the google row must render the fetched fact');

// ── No browser-side write of a credential ───────────────────────────────────
// This is the regression that made the form dead on arrival: users.UpdateRule
// is nil, so this call can only ever answer with an error.
assert.ok(
  !/pb\.collection\('users'\)\.update\(/.test(tabCode),
  'the tab must not write credentials through the locked collection rule'
);
assert.match(
  api,
  /sendApi\('\/api\/aerun\/me\/password'/, 'password changes must go through the command layer'
);

// ── The three capabilities the tab is supposed to offer ─────────────────────
for (const [label, pattern] of [
  ['change password', /changeMyPassword/],
  ['change email', /changeMyEmail/],
  ['link google', /authWithOAuth2/],
  ['unlink google', /unlinkGoogle/]
]) {
  assert.match(tab, pattern, `the tab must offer ${label}`);
}

// ── Unlink must be impossible when it is the only way in ────────────────────
// Both halves matter: the button is disabled so the member is told why, and the
// server refuses with 409 so the guarantee does not depend on the UI shipping.
assert.match(
  tab,
  /!auth\?\.canUnlinkGoogle/,
  'the unlink button must be disabled when google is the only sign-in method'
);
assert.match(tab, /auth_only_method/, 'the member must be told why it is blocked');
assert.match(
  creds,
  /countMethods\(hasPassword, providers, provider\) == 0/,
  'the server must refuse removing the last sign-in method'
);
assert.match(
  creds,
  /conflictError\("set a password before unlinking/,
  'the refusal must be a conflict and must name the way out'
);
assert.match(
  creds,
  /"can_unlink_google":\s+googleLinked && countMethods/,
  'can_unlink_google must depend on the account being linked, not on the provider being enabled'
);

// ── Ownership is proven server-side, never asserted by the client ───────────
assert.match(
  creds,
  /func requireCredentialOwnership/,
  'credential changes must require proof of ownership'
);
assert.match(creds, /ValidatePassword\(password\)/, 'the current password must be verified, not trusted');
assert.match(
  creds,
  /recentlySignedInWithOAuth\(record\.Id\)/,
  'an account with no password must be able to prove ownership another way'
);

// ── The hash must never leave the server ────────────────────────────────────
assert.match(creds, /func accountHasPassword/, 'password presence must be read through the typed value');
assert.ok(
  !/record\.GetString\("password"\)/.test(creds),
  'GetString cannot read a PocketBase password hash — it is a *PasswordFieldValue'
);
assert.match(credsTest, /must never appear in the response/, 'the hash must be pinned as never leaving');

// ── The tab must exist in both languages ────────────────────────────────────
for (const key of [
  'auth_change_password', 'auth_current_password', 'auth_new_password',
  'auth_confirm_password', 'auth_change_email', 'auth_unlink_google',
  'auth_only_method', 'auth_password_hint',
  'auth_forgot_password', 'auth_reset_mail_disabled'
]) {
  const hits = (dict.match(new RegExp(`\\b${key}:`, 'g')) || []).length;
  assert.equal(hits, 2, `${key} must exist in both en and ru, found ${hits}`);
}

// ── "Forgot password" must not promise a mail this server cannot send ───────
//
// The reset flow is real and reachable from the login screen, but MailHardDisable
// Guard aborts every send while AERUN_MAIL_MODE=disabled, and run.go clears SMTP
// on every boot. So the Security tab's control is allowed to exist — a member who
// has forgotten their password needs somewhere to be told what is actually true —
// and it is NOT allowed to claim a link is on its way.
//
// This is the failure mode worth pinning: a control that returns 204 and says
// "check your inbox" teaches members that the forum's mail works, and it is the
// exact claim that sends someone away waiting for a message that can never exist.
assert.match(
  tab,
  /auth_reset_mail_disabled/,
  'the forgot-password disclosure must state that mail is not delivered'
);
assert.match(
  dict,
  /auth_reset_mail_disabled:[^\n]*(does not send mail|не отправляет письма)/,
  'the reset notice must say the server does not send mail — in both languages'
);
assert.ok(
  !/auth\.reset_link_sent/.test(tab),
  'SecurityTab must not reuse the login screen\'s "reset link sent!" string: that one is ' +
    'only truthful if mail actually leaves the server, and here it cannot'
);
// It must appear only where forgetting is possible: an account with no password
// has nothing to forget.
assert.match(
  tab,
  /\{auth\?\.hasPassword && \([\s\S]{0,400}?auth_forgot_password/,
  'the forgot-password control must be gated on the account actually having a password'
);

console.log('OK  security tab: real state, command-layer writes, unlink guard');
console.log('OK  forgot password: honest about mail, never claims an unsendable link');