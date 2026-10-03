import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The forum is read PER IDENTITY, not once.
//
// /api/aerun/categories is filtered by canViewCategory on the server, and
// /api/aerun/forum-stats counts whoever the caller may see. So the same URL
// answers different questions depending on who is asking — and the browser kept
// one answer from mount, forever.
//
// That produced the whole class of symptoms at once: after signing out the stats
// panel still named members who had been online, and an admin-only category
// stayed on the index because the guest was being shown the admin's list. The
// request was never wrong; the client simply stopped asking.
//
// These are source-shape gates because the failure is structural: an effect
// whose dependency array omits the identity renders correctly in review and
// behaves as if it did not exist.
//
// Run: node scripts/check-identity-refresh.mjs
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const authProvider = read('../src/contexts/AuthProvider.jsx');
const app = read('../src/App.jsx');
const presence = read('../src/api/rtdb-presence.js');
const presenceGo = read('../backend/internal/platform/pocketbase/presence.go');
const runGo = read('../backend/internal/platform/pocketbase/run.go');
const forumStats = read('../src/components/layout/ForumStats.jsx');
const adminPage = read('../src/pages/AdminPage.jsx');
const transferModal = read('../src/components/modals/TransferRootModal.jsx');
const rootTransferGo = read('../backend/internal/platform/pocketbase/root_transfer.go');
const oauthRecentGo = read('../backend/internal/platform/pocketbase/oauth_signin_recent.go');
const categoryAccessGo = read('../backend/internal/platform/pocketbase/category_access.go');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ── The forum re-reads when the identity changes ────────────────────────────
// A role or status change alters what the server will return WITHOUT changing
// who is asking, so the key must carry all three parts.
check(
  /const identityKey = `\$\{user\?\.uid \|\| ''\}\|\$\{profile\?\.role_id \|\| ''\}\|\$\{profile\?\.status \|\| ''\}`/.test(authProvider),
  'AuthProvider must key the forum refresh on uid AND role AND status — a role change ' +
    'changes what /categories returns without changing who is asking'
);
check(
  /\[identityKey, refreshForumState\]/.test(authProvider),
  'the refresh effect must depend on identityKey, or it runs on mount only and the forum ' +
    'state is frozen at whichever identity was signed in when the provider mounted'
);
check(
  /refreshForumState\(true\)/.test(authProvider),
  'the identity refresh must be forced past the cooldown — a stale answer is exactly wrong ' +
    'at the moment a role changes or a session ends'
);

// ── The online list is not part of fetchSecuredMainPageData ─────────────────
// It arrives through the presence snapshot, so re-reading the forum state does
// not clear it, and the previous account lingers until the presence TTL expires.
check(
  /if \(user\?\.uid\) return;\s*setActiveUsers\(\[\]\);/.test(authProvider),
  'AuthProvider must clear activeUsers on sign-out — the heartbeat stops immediately, so the ' +
    'previous account otherwise stays in the stats panel until the presence TTL expires'
);

// ── Signing out of a page you may no longer read lands you home ────────────
// ProtectedRoute only guards the routes it wraps; a topic page keeps rendering
// as a guest until its post request is refused.
check(
  /const IdentityRedirect = \(\) =>/.test(app),
  'App.jsx must define IdentityRedirect — a session ending under a topic page leaves the ' +
    'member on a page whose content the server now refuses'
);
check(
  /previousIdentityRef\.current = identity/.test(app),
  'IdentityRedirect must compare against the PREVIOUS identity, not just react to the current ' +
    'one — otherwise every render looks like a transition and a direct link to a topic is lost'
);
check(
  /navigate\('\/', \{ replace: true \}\)/.test(app),
  'IdentityRedirect must redirect to "/" with replace, so Back does not return to a closed page'
);
check(
  /<IdentityRedirect \/>/.test(app),
  'IdentityRedirect must be mounted, not merely defined'
);

// ── The last action is recorded, and the departure is REAL ─────────────────
// A final HEARTBEAT was the wrong fix and had to be undone: the heartbeat
// handler writes onlineMembers[id] with LastSeen=now, so signing out
// re-registered the account and it stayed in "Online now" for a full TTL.
// Members now leave through the same call guests already had.
check(
  /export const setRtdbOffline = async \(uid, isLogout = false\)/.test(presence),
  'setRtdbOffline must accept uid and isLogout — the idle path and the sign-out path are ' +
    'different events and cannot share one behaviour'
);
// The two calls below are scoped to the BODY of setRtdbOffline. Tested against
// the whole file they would be meaningless: `[\s\S]*?` runs on past the closing
// brace into recordActivity, which legitimately calls sendHeartbeat, and the
// "logout must not beat" rule would then fail on correct code.
const offlineFn = presence.match(
  /export const setRtdbOffline = async \(uid, isLogout = false\) => \{[\s\S]*?\n\};/
);
check(Boolean(offlineFn), 'setRtdbOffline must be extractable so its logout branch can be inspected');
const offlineBody = offlineFn ? offlineFn[0] : '';

check(
  /if \(isLogout && uid\)[\s\S]*?await sendApi\('\/api\/aerun\/presence\/leave'/.test(offlineBody),
  'setRtdbOffline must call POST /api/aerun/presence/leave on an explicit logout, while the ' +
    'token is still valid — a heartbeat there RE-ADDS the account to the online list'
);
check(
  !/if \(isLogout && uid\)[\s\S]*?await sendHeartbeat\(/.test(offlineBody),
  'setRtdbOffline must not send a heartbeat on logout: the heartbeat handler re-registers the ' +
    'member as online, which is precisely the bug this call exists to fix'
);
check(
  /setRtdbOffline\(user\.uid, false\)/.test(authProvider),
  'the idle-timeout caller must pass isLogout=false — idling is not a departure, and leaving ' +
    'there would drop a present member out of the online list and stamp their last_seen'
);
check(
  /group\.POST\("\/presence\/leave", memberLeaveHandler\)/.test(runGo),
  'run.go must register POST /api/aerun/presence/leave — without the route the client call 404s ' +
    'and the member lingers in the online list until the TTL expires'
);
check(
  /func memberLeaveHandler[\s\S]*?delete\(onlineMembers, e\.Auth\.Id\)/.test(presenceGo),
  'memberLeaveHandler must DELETE the presence row; refreshing it instead is what kept ' +
    'signed-out members online'
);
check(
  /func memberLeaveHandler[\s\S]*?writeMemberLastSeen\(e\.App, e\.Auth, now\)/.test(presenceGo),
  'memberLeaveHandler must write users.last_seen unthrottled — the 5-minute heartbeat throttle ' +
    'is wrong for a departure, whose exact moment is the value the members table renders'
);
check(
  /if e\.Auth == nil \{[\s\S]*?return forbiddenError\(/.test(presenceGo),
  'memberLeaveHandler must refuse an anonymous caller — identity comes from the auth record, ' +
    'never the body, so there is nothing to remove without one'
);

// ── One guest per browser, not one per tab ──────────────────────────────────
// guest_id is a PER-BROWSER identity in shared localStorage, but tabs run
// independent JavaScript: a get-then-set there is a race, so a simultaneous
// logout in two tabs minted two ids and counted one person as two guests.
// The re-read after the write is what makes both tabs converge on one value.
check(
  /localStorage\.setItem\('guest_id', candidate\);[\s\S]{0,120}return localStorage\.getItem\('guest_id'\)/.test(authProvider),
  'getOrCreateGuestId must re-read guest_id after writing it — a plain get-then-set races ' +
    'between tabs and one browser ends up counted as several guests'
);
check(
  !/removeRtdbGuestPresence\(guestId\);\s*\n\s*localStorage\.removeItem\('guest_id'\)/.test(authProvider),
  'signing in must NOT delete the stored guest_id: the id is per-browser, and every open tab ' +
    'mints a fresh one on its next logout, which is how two tabs became two guests'
);

// ── "Visited today" is a different clock from "Online now" ──────────────────
// The daily row used to subscribe to the online list, so it restated the
// connected-now members under a second label and could never show somebody who
// had already left. It is a 24h window over users.last_seen, served by
// /forum-stats, and presence cannot answer it: the map is windowed to 75s and
// is empty after a restart.
// Comments must be stripped first. Both files still NAME the old export while
// explaining why it is gone, and a gate that failed on its own documentation
// would be deleted rather than obeyed — which is exactly what happened the
// first time this check was written elsewhere in this repo.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

check(
  !/subscribeToDailyActiveUsers/.test(stripComments(forumStats)) &&
    !/export const subscribeToDailyActiveUsers/.test(stripComments(presence)),
  'the "Visited today" row must not be served by the online-users subscription — it would print ' +
    'the connected-now list under a second label and never show a member who already left'
);
check(
  /forumStats\?\.dailyActiveUsers/.test(forumStats),
  'ForumStats must read the daily list from forumStats.dailyActiveUsers, the server-side 24h ' +
    'window over users.last_seen'
);
check(
  /forumStats\?\.dailyActiveUserCount \?\?/.test(forumStats),
  'the headline number must come from dailyActiveUserCount, which stays exact even when the name ' +
    'list is capped for rendering'
);
check(
  /dailyActiveWindow = 24 \* time\.Hour/.test(categoryAccessGo),
  'the daily window must be 24h on the server — a shorter one would silently answer a different ' +
    'question than the label states'
);

// ── Every rendered icon is imported ─────────────────────────────────────────
// ShieldAlert was rendered in the users table and never imported, so an
// uncaught ReferenceError took the whole admin users tab down on every render.
const lucideImport = adminPage.match(/from 'lucide-react'/) ? adminPage.slice(0, adminPage.indexOf("from 'lucide-react'")) : '';
for (const icon of ['ShieldAlert']) {
  check(
    new RegExp(`\\b${icon}\\b`).test(lucideImport),
    `AdminPage renders <${icon} /> but does not import it from lucide-react — a missing icon ` +
      'reference throws during render and unmounts the entire page'
  );
}

// ── The chief-admin handover must be completable ────────────────────────────
// Two defects in one dialog, both reported from the same screenshot.
//
// The candidate list filtered on `is_self`, a field nothing in the codebase
// ever set, so the chief admin appeared as a candidate for their own
// succession — and the server refuses that, making the offer impossible to
// complete. The filter must key on the id it is given.
//
// The dialog demanded the account password. An account that only ever signs in
// through Google has no password, and one imported from the legacy backend was
// given a generated one nobody was shown — so for both the box was a wall, and
// an irreversible handover with no way through it.
check(
  // Comments are stripped first: the dialog still NAMES the old flag while
  // explaining why it went away, and a gate that failed on its own
  // documentation would be deleted rather than obeyed.
  !/is_self/.test(stripComments(transferModal)),
  'the transfer dialog must not filter on `is_self`: no candidate row ever carries it, so the ' +
    'chief admin appeared in their own successor list and could only fail at submit'
);
check(
  /c\.id !== currentUserId/.test(transferModal),
  'the successor list must exclude the current account by id — the server refuses a self-transfer'
);
check(
  /currentUserId=\{user\?\.uid/.test(adminPage),
  'AdminPage must pass the caller id to the transfer dialog, or the self-filter cannot key on it'
);
check(
  /c\.status === 'active'/.test(transferModal),
  'the successor list must exclude non-active accounts — the server rejects them, so offering ' +
    'them is a dialog that cannot succeed'
);
check(
  /onReauthWithGoogle/.test(transferModal) && /handleReauthForTransfer/.test(adminPage),
  'the handover needs a route through an account that has no password: the dialog must offer the ' +
    'Google confirmation and AdminPage must implement it'
);
check(
  /confirmTransferIdentity\(giver, form\.Password\)/.test(rootTransferGo),
  'the server must route the handover confirmation through confirmTransferIdentity, which is ' +
    'where the password-or-sign-in decision lives'
);
check(
  /recentlySignedInWithOAuth\(giver\.Id\)/.test(rootTransferGo),
  'the server must accept a recent provider sign-in as proof of identity — otherwise an account ' +
    'with no password can never hand the role over, and the role is stuck forever'
);

// The proof must be server-observed. Accepting a bearer token would be
// circular: a stolen session token is exactly what the confirmation exists to
// defeat, so a "fresh" token submitted by the browser proves nothing.
check(
  /OnRecordAuthWithOAuth2Request\(\)/.test(oauthRecentGo),
  'the OAuth confirmation must come from the PocketBase OAuth hook — a client-supplied token ' +
    'would be replayable by whoever stole the session'
);
check(
  /age > reauthWindow/.test(oauthRecentGo),
  'a provider sign-in must expire: without the age bound the alternative degenerates into "any ' +
    'session token ever"'
);

if (failures.length > 0) {
  console.error(`identity-refresh regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  identity refresh: the forum re-reads on uid, role and status change');
console.log('OK  identity refresh: the online list is cleared on sign-out');
console.log('OK  identity refresh: a closed page lands on / with replace');
console.log('OK  identity refresh: logout records a departure, idling does not');
console.log('OK  identity refresh: one guest per browser, not one per tab');
console.log('OK  identity refresh: "Visited today" is a 24h window, not the online list');
console.log('OK  identity refresh: every rendered icon is imported');
console.log('OK  identity refresh: the root handover excludes you, and works without a password');