// Client half of the forum read contract.
//
// The Go side is pinned by forum_read_contract_test.go: it asserts the keys the
// server sends. This asserts the keys the browser READS, because the bug that
// emptied the forum was never in the server — it answered correctly and was
// read incorrectly:
//
//   fetchSecuredTopics read `res.topics` / `res.pinned` while the route answers
//     `items`, so every category rendered as empty;
//   fetchSecuredPosts read `res.posts` while the route answers `items`, so an
//     existing topic rendered with no messages;
//   createTopic returned `id` while the form read `topicId`, so the member was
//     navigated to /topic/undefined and told the topic they had just created did
//     not exist;
//   createPost returned a post object while the reply path read `postId`, which
//     no route has ever sent, so a posted reply was never scrolled to.
//
// Optional chaining is what let all four survive review: `res?.posts || []` on
// an absent key is an empty list, not a crash. So these are literal-source
// assertions, not runtime ones — the shape has to stay visible in review.
//
// Run: node scripts/check-forum-read-contract.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '../src/constants/permissions.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const forum = read('../src/api/forum.js');
const resources = read('../src/api/auth-resources.js');
const categories = read('../src/api/categories.js');
const authProvider = read('../src/contexts/AuthProvider.jsx');
const reputation = read('../src/api/reputation.js');
const subscriptions = read('../src/api/subscriptions.js');
const adminPage = read('../src/pages/AdminPage.jsx');

// The `forbid` gates below match executable source, so the COMMENTS that explain
// each past bug must be stripped first. The old `pb.collection('reputation_votes')`
// call is quoted verbatim in the comment above its replacement — a gate that
// failed on its own documentation would be deleted rather than obeyed, which is
// exactly what happened the first time this was written.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments (JSDoc)
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, but not the `//` in 'https://'

const forumCode = stripComments(forum);
const reputationCode = stripComments(reputation);
const topicForm = read('../src/pages/TopicFormPage.jsx');
const topicPage = read('../src/pages/TopicPage.jsx');

const failures = [];
// `why` is what the failure MEANS. A bare "must not match /…/" sends the next
// reader to the regex instead of the decision, and these gates exist precisely
// because the change they forbid looks harmless in review.
const forbid = (source, label, pattern, why = '') => {
  if (pattern.test(source)) {
    failures.push(`${label} must not match ${pattern}${why ? ` — ${why}` : ''}`);
  }
};

// ── The members page must not ask a route that refuses it ────────────────────
//
// THE FAILURE. `subscribeToAllUsers` tried `GET /api/aerun/admin/users` first and
// fell back to a direct collection read when it threw. That route is bound to
// `RequirePermission(auth.PermAdminAccess)` (run.go), so for a guest — and for
// every member without admin_access, which is every ordinary member — the call
// could never succeed under any circumstances. Opening /members as a guest logged
// a guaranteed 401 and then rendered the list from the fallback anyway.
//
// What made this survive review is that the fallback is perfectly correct code
// and the page renders: the 401 is one red line in a network tab nobody reads.
// Only a gate keeps it fixed.
//
// MembersPage is public and takes the public read. AdminPage is the single caller
// entitled to the staff DTO (`status` and `verified` are served there and nowhere
// else), and it must say so EXPLICITLY: a silent default would quietly empty the
// moderation columns the first time somebody tidied this signature.
//
// MembersPage reads one page per render through fetchMembers — the public
// paginated read. It must not take the subscription read (which always loads
// the WHOLE board, so sorting and filtering locally would need every page
// at once — the walk this migration removes), and it must not ask for the
// staff read it is not entitled to.
assert.match(
  stripComments(resources),
  /export const subscribeToAllUsers = \(callback, \{ staff = false \} = \{\}\)/,
  'subscribeToAllUsers must default to the PUBLIC read — the members page is a public page, and the staff route refuses every caller who is not staff'
);
assert.match(
  stripComments(resources),
  /if \(!staff\) \{/,
  'the non-staff branch must return BEFORE the staff call is issued; catching a 401 that was decided before the request was sent is not a fallback'
);
assert.match(
  stripComments(read('../src/pages/MembersPage.jsx')),
  /fetchMembers\(\{/,
  'MembersPage must take the paginated public member read — it is reachable by guests, who cannot use the staff route'
);
forbid(
  stripComments(read('../src/pages/MembersPage.jsx')),
  'MembersPage.jsx',
  /subscribeToAllUsers/,
  'MembersPage reads ONE page per render through fetchMembers (/api/aerun/users); the subscription read loads the whole board, which is the walk this page exists to remove'
);
forbid(
  stripComments(read('../src/pages/MembersPage.jsx')),
  'MembersPage.jsx',
  /staff:\s*true/,
  'only AdminPage is entitled to the staff DTO; asking for it from the public members page reintroduces the guaranteed 401'
);
assert.match(
  stripComments(adminPage),
  /fetchAdminUsers\(/,
  'AdminPage must request the staff read explicitly — status and verified are served by /admin/users and by no other route, so a silent default would empty those columns'
);
forbid(
  stripComments(adminPage),
  'AdminPage.jsx',
  /subscribeToAllUsers/,
  'AdminPage reads the paged staff list through fetchAdminUsers (/admin/users); the public walk would reintroduce a silent fallback to the member DTO, which serves neither status nor verified'
);

// ── The list routes answer `items` ───────────────────────────────────────────
// Each of these reads a topic list. `topics` and `pinned` are the retired
// Firestore callable's keys; they are absent from every response, and reading
// them yields an empty page rather than an error.
forbid(forum, 'forum.js subscribeToTopics', /res\?\.pinned\s*\|\|/);
forbid(forum, 'forum.js subscribeToTopics', /res\?\.topics\s*\|\|/);
forbid(forum, 'forum.js fetchSecuredTopics', /res\?\.pinned\s*\|\|\s*\[\]\)\.map/);
forbid(forum, 'forum.js fetchSecuredTopics', /pinned:\s*\(res\?\.topics/);
forbid(resources, 'auth-resources.js fetchLatestTopics', /return\s+res\?\.topics\s*\|\|\s*\[\]/);
forbid(resources, 'auth-resources.js subscribeToTopTopics', /callback\(res\?\.topics\s*\|\|\s*\[\]\)/);

// The post list answers `items` too (forum_posts.go listPostsHandler).
forbid(forum, 'forum.js subscribeToPosts', /callback\(\(res\?\.posts\s*\|\|\s*\[\]\)/);
forbid(forum, 'forum.js fetchSecuredPosts', /posts:\s*\(res\?\.posts\s*\|\|\s*\[\]\)/);

// ── The create responses carry the ids the pages navigate with ───────────────
// The topic form navigates to `/topic/${id}`. Reading a key the response never
// sends produces the literal URL /topic/undefined.
//
// The pattern is pinned to the ASSIGNMENT (`= newTopic.topicId`), not the bare
// member expression: the explanation of this very bug lives in a comment right
// above the fixed line, and a gate that failed on its own documentation would
// be deleted rather than obeyed.
forbid(topicForm, 'TopicFormPage.jsx', /=\s*newTopic(\?)?\.topicId/);
assert.match(
  topicForm,
  /const newTopicId = newTopic\.id/,
  'TopicFormPage must navigate with the id createTopic actually returns (`id`)'
);

// The reply path scrolls to the post it just wrote.
forbid(topicPage, 'TopicPage.jsx', /res\?\.postId/);
assert.match(
  forum,
  /postId: res\?\.post_id/,
  'createPost must expose `post_id` under the name the reply path reads'
);

// ── The category index reads counters that are now served ────────────────────
assert.match(
  forum,
  /total: res\?\.total \?\? items\.length/,
  'fetchSecuredTopics must report the server-side `total`, which the pager divides by'
);
assert.match(
  forum,
  /limit: res\?\.per_page/,
  'The server names the page size `per_page`; reading `limit` always fell back to the default'
);

// ── The category index reads counters that are now served ───────────────────
//
// The backend computed topics_count / posts_count / last_post_* correctly all
// along (categoryForumProjections). toCategory DROPPED them, so MainPage read
// `cat.topics_count || 0` on an object that no longer had the key and rendered
// 0/0 with "No posts yet" on a forum with a topic in it. The server was right
// and the page was empty, which is why this reads as a data bug and is not one.
assert.match(
  categories,
  /topics_count:\s*d\.topics_count/,
  'toCategory must carry topics_count through — MainPage renders `cat.topics_count`'
);
assert.match(
  categories,
  /posts_count:\s*d\.posts_count/,
  'toCategory must carry posts_count through — MainPage renders `cat.posts_count`'
);
for (const key of ['last_post_topic_id', 'last_post_topic_title', 'last_post_at', 'last_post_author_ref']) {
  assert.match(
    categories,
    new RegExp(`${key}: d\\.${key}`),
    `toCategory must carry ${key} through — the index renders the last-post column from it`
  );
}

// ── The main-page payload actually seeds the shell ──────────────────────────
//
// AuthProvider assigns categories / categoryGroups / stats from this return value,
// each behind an `if (data?.x)` guard, so a missing key is indistinguishable from
// "the server had none". The function used to return categories alone, and the
// stats panel fell back to summing counters that were themselves being dropped.
assert.match(
  categories,
  /\n\s*stats[,:]/,
  'fetchSecuredMainPageData must return stats — AuthProvider only assigns what it returns'
);
assert.match(
  categories,
  /fetchForumStats/,
  'fetchForumStats must exist: nothing else serves forumStats, and ForumStats.jsx reads it'
);

// latestTopics IS NOT IN THAT LIST ANY MORE, and this is the assertion that keeps
// it out. It used to be fetched here — fifty whole topic records — so every member
// on every page paid for them to render the navbar's unread badge, and the badge
// itself was computed from that capped list against a per-browser localStorage read
// map. The count is server state now (`unread_topics` on /me/unread-counts) and the
// list belongs to /new-replies.
//
// Forbidding it here matters because putting it back would LOOK like a fix: it is
// the obvious place to restore a broken /new-replies, and it would silently bring
// back a fifty-row payload on every page plus a count that cannot exceed the cap.
assert.doesNotMatch(
  stripComments(categories),
  /fetchLatestTopics/,
  'the main-page projection must not fetch a topic list — the unread badge is a count on /me/unread-counts, and /new-replies reads the rows itself'
);
assert.doesNotMatch(
  stripComments(categories),
  /\n\s*latestTopics[,:]/,
  'fetchSecuredMainPageData must not return latestTopics — AuthProvider used to hold it, and a topic list there costs every page a payload only /new-replies renders'
);

// The badge must be fed by the SERVER count, not derived from the local read map.
// `const [unreadTopicsCount] = useState(0)` — destructured with no setter — was
// permanently 0, which is why the navbar badge, the tab title and the "mark all
// read" button were all silently inert rather than broken.
assert.match(
  authProvider,
  /const \[unreadTopicsCount, setUnreadTopicsCount\] = useState/,
  'unreadTopicsCount needs a setter — without one the badge, the tab title and mark-all-read were permanently 0'
);
assert.match(
  authProvider,
  /setUnreadTopicsCount\(counts\.topics \|\| 0\)/,
  'the badge must come from the unread-counters response, so it agrees across devices and is not capped by a page size'
);

// ── The notification LIST is not a counter ────────────────────────────────────
//
// THE DEFECT. The navbar bell and the tab title both showed the unread
// NOTIFICATION count by subscribing to `subscribeToUserNotifications` and
// rendering `notifs.filter(n => !n.read).length`. That made every member pay
// `GET /me/notifications?limit=100` — a hundred whole notification records — on
// every page of the forum, to derive one integer, while
// `GET /me/unread-counts` returned that integer as `unread_notifications` on a
// request AuthProvider was already making. Two endpoints, one number.
//
// It was also wrong, not merely expensive: a member with 150 unread was told
// 100, because the badge could only see the newest hundred rows. The cap is the
// exact failure `latestTopics` had on the main-page projection.
//
// These assert the badge reads the SERVER COUNT. Restoring the list subscription
// would look harmless — it is a correct read of a real endpoint — which is why
// it has to be gated rather than left to review.
const navbar = read('../src/components/layout/Navbar.jsx');
const titleProvider = read('../src/contexts/TitleProvider.jsx');
const notificationsApi = read('../src/api/rtdb-notifications.js');

forbid(
  stripComments(navbar),
  'Navbar.jsx',
  /subscribeToUserNotifications/,
  'the bell is a number, and /me/unread-counts already returns it; reading the list here costs every page a capped hundred rows'
);
forbid(
  stripComments(titleProvider),
  'TitleProvider.jsx',
  /subscribeToUserNotifications/,
  'the tab title is a number, and this provider already reads the counters resource that carries it'
);

assert.match(
  stripComments(navbar),
  /const userUnread = unreadCounts\?\.notifications \|\| 0/,
  'the navbar bell must render the server-side notification count — counting a capped list is what made 150 unread report as 100'
);
assert.match(
  stripComments(titleProvider),
  /raw\.notifications \|\| 0/,
  'the tab title must render the server-side notification count for the same reason'
);

// The count has to actually be carried, or the badge above reads `undefined`
// and renders nothing — and it must survive a backend that predates the field.
assert.match(
  stripComments(read('../src/api/dms.js')),
  /notifications: Number\(res\?\.unread_notifications\) \|\| 0/,
  'subscribeToUnreadCounts must map unread_notifications — the badge reads this field'
);

// The LIST still has two legitimate consumers: the Notifications page and
// TopicPage's quote highlighting, both of which render rows. Pinning that keeps
// this fix honest — deleting the list read outright would break both screens.
for (const [label, src] of [
  ['NotificationsPage.jsx', read('../src/pages/NotificationsPage.jsx')],
  ['TopicPage.jsx', topicPage],
]) {
  // NotificationsPage keeps reading the list client-side (it renders rows);
  // TopicPage reads topic-scoped notifications through the
  // server-filtered subscribeToTopicNotifications instead.
  const expected = label === 'TopicPage.jsx'
    ? /subscribeToTopicNotifications/
    : /subscribeToUserNotifications/;
  assert.match(
    stripComments(src),
    expected,
    `${label} renders notification ROWS, so it must keep reading the list — the counts endpoint cannot replace it`
  );
}

// ── `markNotificationRead` takes the id, and only the id ──────────────────────
//
// The signature was `(uid, notifId, isAdmin)` with the first and third ignored
// (`/me/notifications/:id/read` is caller-scoped server-side), but NotificationsPage
// and TopicPage called it `(notifId, uid)` — following a comment that said "id
// first". So `notifId` received the ACCOUNT id and the PATCH addressed
// `me/notifications/<accountId>/read`, a 404: clicking a notification and
// scrolling a quoted post into view both marked nothing, while the UI updated
// the row optimistically. The member saw a read receipt the server never issued.
//
// One argument makes the swap unrepresentable, which is why the uid was removed
// rather than merely reordered at the call sites.
assert.match(
  stripComments(notificationsApi),
  /export const markNotificationRead = async \(notifId\)/,
  'markNotificationRead must take the notification id ALONE — a leading uid parameter is what two call sites passed in the wrong order, 404ing the read'
);
for (const [label, src] of [
  ['NotificationsPage.jsx', read('../src/pages/NotificationsPage.jsx')],
  ['TopicPage.jsx', topicPage],
]) {
  forbid(
    stripComments(src),
    `${label} markNotificationRead call`,
    /markNotificationRead\([^)]*,/,
    'markNotificationRead takes one argument; a second one is the account id landing in the notification slot'
  );
}

// ── The forum index is read ONCE, by the provider ─────────────────────────────
//
// MainPage used to mount subscribeToForumIndex while AuthProvider independently
// read the same category rows for its `categories` state. Two reads of one
// resource on two unrelated clocks, for a screen that renders the pairing of the
// two — so a category filed under a group the other read had not yet returned
// rendered in no section, silently. The index cannot paint from half of that
// pair, so the second request had to go rather than be deduplicated.
//
// This asserts the ABSENCE of the page-level read, because the failure mode is
// re-introducing it: the duplicate is invisible in review (both calls are
// correct in isolation) and only costs a request per forum visit.
assert.match(
  categories,
  /fetchForumIndex\(\)/,
  'fetchSecuredMainPageData must read the index through fetchForumIndex — it is the one read that carries groups with their categories'
);
assert.match(
  categories,
  /\n\s*categoryGroups:\s*index\.groups/,
  'fetchSecuredMainPageData must return the groups — the index renders a category inside its folder and cannot paint from categories alone'
);

// Stripped, because the comment above records the call by name — a gate that
// failed on its own explanation would be deleted rather than obeyed.
const mainPage = read('../src/pages/MainPage.jsx');
forbid(
  stripComments(mainPage),
  'MainPage',
  /subscribeToForumIndex/
);
assert.match(
  mainPage,
  /categories,\s*categoryGroups/,
  'MainPage must take both lists from useAuth — the provider already re-reads them when the identity changes'
);

// ── Mark-all-read sends the ids it can see ────────────────────────────────────
//
// It used to mark `latestTopicsRef` — the top fifty topics — written straight to
// localStorage. Two things were wrong and neither was visible: "read everything"
// meant "read the fifty newest", and the badge it was supposed to clear was
// counted on the server against a different set, so the number came straight back.
//
// The list is the caller's to pass because the server refuses an id in a category
// the caller may not read. Silently skipping such an id would let the button report
// success while leaving another category's state alone.
const newReplies = read('../src/pages/NewRepliesPage.jsx');
assert.match(
  newReplies,
  /markAllRead\(unreadTopics\.map/,
  'mark-all-read must send the ids actually on screen — the server cannot mark a page size it was never told about'
);
assert.doesNotMatch(
  newReplies,
  /disabled=\{[^}]*unreadTopicsCount === 0/,
  'mark-all-read must not be gated on the badge number: the badge counts the whole board while this list is one page of it, so requiring both made the button permanently disabled'
);

// The list must be read where it is rendered. It used to live in AuthProvider,
// which is mounted for the whole session, so the poll outlived every reader of it.
assert.match(
  newReplies,
  /subscribeToLatestTopics\(/,
  '/new-replies must read the topic list itself — it is the only screen that renders topic rows'
);
assert.match(
  newReplies,
  /unsubscribe\(\)/,
  '/new-replies must unsubscribe on unmount — the poll used to be owned by AuthProvider and outlived every reader'
);

// ── Topic lists normalise before rendering ──────────────────────────────────
//
// /active-topics rendered a literal "—" in its last-post column with no link,
// because subscribeToTopTopics handed raw `res.items` to TopicRow, which reads
// the normalised names (last_post_at, is_pinned, created_at). The row looked
// empty rather than wrong, so nothing failed.
// The shape changed — fetchLatestTopics now answers { topics, total, perPage }
// because the pager needs the server's count, not this page's length — but the
// obligation did not: rows still leave this function normalised. So the assertion
// targets the mapping, not the `return` keyword's position in it.
assert.match(
  resources,
  /\(res\?\.items \|\| \[\]\)\.map\(normalizeTopic\)/,
  'fetchLatestTopics must map through normalizeTopic — TopicRow reads the normalised field names'
);
assert.match(
  resources,
  /topics:\s*\(res\?\.items \|\| \[\]\)\.map\(normalizeTopic\)/,
  'fetchLatestTopics must carry the normalised rows as `topics`'
);
assert.match(
  resources,
  /total:\s*res\?\.total/,
  'fetchLatestTopics must return the server total — the pager divides by it, and ' +
  'falling back to this page length makes a truncated list look complete'
);
assert.match(
  resources,
  /subscribeToTopTopics[\s\S]{0,900}return subscribeToTopDiscussedTopics\(/,
  'subscribeToTopTopics must reuse the top-discussed (replies-sorted) feed so the two lists cannot drift'
);
assert.doesNotMatch(
  resources,
  /callback\(res\?\.items \|\| \[\]\)/,
  'subscribeToTopTopics must not pass raw items to a renderer'
);

// The subscriptions list is the THIRD topic list, and it is the one that reads
// `GET /topics/:id` per subscription. It handed `t?.topic` — the server's own
// payload — straight to TopicRow, so every row of /subscriptions rendered a
// literal "—" for the byline timestamp AND for the last-post column, and lost
// its pin icon, while the identical topic under /category/<id> rendered fine.
// Again the damage looked EMPTY rather than wrong.
assert.match(
  subscriptions,
  /normalizeTopic\(t\?\.topic\)/,
  'fetchUserSubscribedTopics must map through normalizeTopic — TopicRow reads the normalised field names'
);
assert.doesNotMatch(
  subscriptions,
  /return\s+t\?\.topic\b/,
  'fetchUserSubscribedTopics must not pass the raw server topic to a renderer'
);
assert.match(
  subscriptions,
  /import \{ normalizeTopic \} from '\.\/forum'/,
  'the subscriptions list must reuse the one mapping — a second copy is how these lists drifted apart'
);

// A bare normalizeTopic in the source says nothing about whether it produces
// the fields TopicRow reads, so the mapping is EXECUTED on the keys
// topicPayload (forum_topics.go) actually emits.
//
// The match starts at `const`, never at `export const`: `new Function` compiles
// a function BODY, not a module, and `export` in one is a SyntaxError pointing
// at the arrow function inside it. Same reason the toCategoryPayload extraction
// below starts at `const`.
const normalizeTopicSource = forum.match(/const normalizeTopic = [\s\S]*?\n};/);
assert.ok(normalizeTopicSource, 'normalizeTopic must be extractable for the behavioural check');
const normalizeTopic = new Function(`${normalizeTopicSource[0]}; return normalizeTopic;`)();

const rawTopic = {
  id: 'topic1',
  category_id: 'cat1',
  title: 'Тема',
  posts_count: 4,
  locked: false,
  pinned: true,
  last_post_created: '2026-03-02 10:00:00 +0000 UTC',
  created: '2026-02-01 09:00:00 +0000 UTC'
};
const row = normalizeTopic(rawTopic);
assert.equal(row.created_at, rawTopic.created, 'the byline timestamp must survive normalisation');
assert.equal(row.last_post_at, rawTopic.last_post_created, 'the last-post timestamp must survive normalisation');
assert.equal(row.is_pinned, true, 'a pinned topic must keep its pin icon');
assert.equal(row.posts_count, 4, 'the reply counter must read posts_count');
assert.ok(
  Number.isFinite(row.last_post_at_ms) && row.last_post_at_ms > 0,
  'the subscriptions sort key (last_post_at_ms) must be a number, not undefined'
);

// A topic whose last-post projection is empty must fall back to its own
// creation instead of rendering "—" — which is what a brand-new topic depends
// on, since its opening post IS its last post.
assert.equal(
  normalizeTopic({ ...rawTopic, last_post_created: '' }).last_post_at,
  rawTopic.created,
  'a topic with no last-post projection must fall back to its creation time'
);
assert.equal(
  normalizeTopic(null),
  null,
  'a subscription whose topic 404s must be dropped by the caller, not crash the list'
);

// ── reputation_votes is server-only ─────────────────────────────────────────
//
// The browser read it directly through the PocketBase SDK and got
// "403 Only superusers can perform this action" on every topic open. The catch
// block swallowed it, so the visible damage was a console full of errors and
// every upvote arrow rendering as un-voted.
assert.doesNotMatch(
  reputationCode,
  /pb\.collection\(['"]reputation_votes['"]\)/,
  'reputation_votes has nil browser rules — reads must go through /api/aerun/me/votes'
);
assert.match(
  reputation,
  /\/api\/aerun\/me\/votes/,
  'getVotesInTopic must read the caller\'s own votes from the server'
);
assert.doesNotMatch(
  reputation,
  /^import \{[^}]*\bpb\b[^}]*\} from '\.\/pocketbase'/m,
  'reputation.js must not import the PocketBase SDK — every route in it is server-only'
);

// ── users is read through the profile DTO, never from the collection ──────────
//
// The browser read `users` straight off the collection in two places. Both are
// gone, and the gate is here because the replacement looks like a downgrade in
// review: `pb.collection('users').getOne(uid)` is one short line that WORKS,
// while `/api/aerun/users/${uid}` is a round trip to a server route.
//
// What that short line actually shipped: the whole auth record. `settings` —
// every member's sound volume, muted notification types, mail preferences, theme
// and language — plus `email` and the PocketBase record scaffolding. Opening
// somebody else's profile as a signed-OUT VISITOR was enough to receive it.
//
// The author hydration in TopicPage is the N+1 this also removes: one full auth
// record per distinct poster in a thread, fetched only to draw a signature under
// a post that usually already carries one.
//
// Both are asserted against CODE, not source comments — the replacement is
// discussed at length in the comments above it, and a gate that matched its own
// documentation would be deleted rather than obeyed (see the note above
// stripComments).
const resourcesCode = stripComments(resources);
const topicPageCode = stripComments(topicPage);
const richEditorCode = stripComments(read('../src/components/common/RichEditor.jsx'));

// The FOUR reads that shipped auth records to the browser. They are grouped
// because they are one bug wearing four costumes: every one of them asked the
// collection for rows it did not need in full, and every one now asks the
// command layer for exactly the keys it renders.
for (const [source, label] of [
  [resourcesCode, 'auth-resources.js'],
  [topicPageCode, 'TopicPage.jsx'],
  [forumCode, 'forum.js'],
  [richEditorCode, 'RichEditor.jsx'],
]) {
  assert.doesNotMatch(
    source,
    /pb\.collection\(['"]users['"]\)\.(getOne|subscribe|getFullList|getList)/,
    `${label} must read accounts through /api/aerun/users — the collection hands out the ` +
      'entire auth record, private settings included'
  );
}

// …and the four routes they now call, so the gate cannot be satisfied by a file
// that merely stopped reading profiles.
for (const [source, route, label] of [
  [resourcesCode, '/api/aerun/users/${uid}', 'the profile DTO'],
  [resourcesCode, '/api/aerun/users?page=', 'the public member board'],
  [resourcesCode, '/api/aerun/admin/users?page=', 'the staff member board'],
  [forumCode, '/api/aerun/nicknames/check', 'the nickname availability check'],
  [richEditorCode, '/api/aerun/users/search', 'the mention picker'],
]) {
  assert.ok(source.includes(route), `${label} must be served by ${route}`);
}

// The two paginated boards are read ONE PAGE at a time by their own pages —
// fetchMembers for /members, fetchAdminUsers for the staff table. THE WALK
// IS GONE: fetching the whole board so a page can sort and filter it locally
// (one request per 30 rows, totalPages hops, to re-render all 32 rows of a
// 32-member forum) is precisely what server-side pagination replaces. A
// `collectEveryPage`-style loop reappearing here means a board grew its own
// walk back.
assert.equal(
  (resourcesCode.match(/collectEveryPage\(/g) || []).length,
  0,
  'the members/staff reads must fetch ONE page per render; a collect-every-page walk is the regression server-side pagination removed'
);
// …and each board fetches exactly one page object per render, never a
// `page=1..totalPages` loop over its own literal. The fetchMembers
// definition reads the public route through URLSearchParams (so the literal
// is `users?` rather than `users?page=`), and calling it with an object is
// what one-page-per-render means.
assert.match(
  resourcesCode,
  /export const fetchMembers = async \(\{ page = 1, search = '', sort = '', order = '' \} = \{\}\)/,
  'fetchMembers must be the ONE-page public read: page, search, sort and order on the server'
);
forbid(
  resourcesCode,
  'auth-resources.js',
  /for\s*\([^)]*page\s*\+\+|page \+= 1/,
  'no page-walking loop may reassemble the whole board for a client-side table'
);

// `users.ListRule` is still open, because /members and /profile have to keep
// working for signed-out visitors. Until it is closed, this gate is the only
// thing standing between that rule and the auth records it would expose — which
// is why it is enforced against every module rather than the two that first
// showed the symptom.
assert.doesNotMatch(
  richEditorCode,
  /nickname\s*~/,
  'the mention picker must not build its own filter — the search is a server route now'
);

// The DTO must actually be the thing being called, or the gate above would pass
// on a file that simply stopped reading profiles.
assert.match(
  resourcesCode,
  /sendApi\(`\/api\/aerun\/users\/\$\{uid\}`\)/,
  'fetchUserProfile must read the public profile DTO'
);

// The realtime hook is gone for a reason that is easy to undo by accident:
// `RealtimeRule` is unset on every collection, so the subscription completed its
// SSE handshake and never delivered an event — the dead `realtime` rows in a
// profile page's network log. Worse, an event delivers the WHOLE record, which
// would re-open this leak the moment a rule is added carelessly.
assert.doesNotMatch(
  resourcesCode,
  /collection\(['"]users['"]\)\.subscribe/,
  'the users realtime hook delivered nothing (no RealtimeRule) and would push whole auth records'
);

// The topic author hydration is GONE: every decorated post carries its
// author (posts_count/reputation/status_line/signature — post.author), so
// the page must not fire an /api/aerun/users/{uid} N+1 per distinct poster
// on every page load.
assert.doesNotMatch(
  topicPageCode,
  /await fetchUserProfile\(uid\)/,
  'the per-author hydration N+1 must not return — post.author carries the stats'
);

// ── The topic form sends the mask and the pin ───────────────────────────────
//
// Both lived in component state and were never transmitted, so every message
// came out under the account's name and the "Pin first post" checkbox was
// decorative. The form still assembles author_* for the optimistic first
// render, so the check is on the keys the request actually carries.
assert.match(
  forum,
  /character_id: topicData\.character_id/,
  'createTopic must send character_id — without it the mask cannot be stored'
);
assert.match(
  forum,
  /pin_first_post: !!topicData\.pin_first_post/,
  'createTopic must send pin_first_post — without it the checkbox is decorative'
);
assert.match(
  topicForm,
  /character_id: selectedCharacterId \|\| ''/,
  'TopicFormPage must pass the picked mask as character_id'
);
assert.match(
  topicForm,
  /pin_first_post: pinFirstPost/,
  'TopicFormPage must pass the pin checkbox state as pin_first_post'
);

// The reply composer has the same picker and the same obligation. buildPostData
// is what the submit path sends (TopicPage.jsx: `const postData = buildPostData()`
// → `createPost(postData, ...)`), so this is the key that reaches the wire.
assert.match(
  topicPage,
  /character_id: selectedCharacterId \|\| ''/,
  'TopicPage.buildPostData must pass the picked mask as character_id — a reply cannot be written under a mask otherwise'
);
assert.match(
  forum,
  /character_id: postData\.character_id/,
  'createPost must send character_id so a reply can be written under a mask'
);

// ── A category's visibility rule is always sent ─────────────────────────────
//
// `allowed_roles` is the ONLY input canViewCategory reads, and an empty list
// denies (ADR-1). "Override off" therefore cannot be expressed as "omit the
// key": on CREATE that stored [] and produced a category only the root admin
// could open, and on PATCH it kept whatever list was already there, so
// switching the override off silently did nothing.
//
// OFF is stored as the inherit MARKER, not as the list of roles that happen to
// hold view_forum right now. Naming them was tried first and is a snapshot: a
// role created tomorrow is absent from the array, so its members are refused a
// public category until every category is re-saved by hand. The marker is what
// makes "follow the global role settings" live.
const MARKER = '__aerun_inherit_roles__';
assert.match(
  categories,
  new RegExp(`const INHERIT_ROLES = '${MARKER}'`),
  'the client must send the same marker text the server resolves (auth.CategoryInheritMarker) — a mismatch silently restores the snapshot'
);
forbid(
  categories,
  'categories.js toCategoryPayload',
  /if \(Array\.isArray\(roles\)\) \{\s*body\.allowed_roles/
);
assert.match(
  categories,
  /body\.allowed_roles = Array\.isArray\(override\)\s*\?\s*\[\.\.\.new Set\(override\)\]\s*:\s*\[INHERIT_ROLES\]/,
  'toCategoryPayload must always send allowed_roles — an omitted key is root-only on create and a no-op on update'
);
forbid(
  categories,
  'categories.js toCategoryPayload',
  /defaultViewRoles/,
);
assert.match(
  categories,
  /allowedRoles\.includes\(INHERIT_ROLES\) \? null : allowedRoles/,
  'toCategory must read the marker back as "override off", or a category inheriting the global settings opens with the switch on and the marker listed as if it were a role'
);

// A new category must start with NO override. Seeding view_forum with the
// standard list made the form claim an override that is not one, and the badge
// counted it; an empty ARRAY would instead be root-only, which is the exact
// bug this section exists to prevent.
forbid(
  adminPage,
  'AdminPage new-category form',
  /permissions: \{\s*\[PERMISSIONS\.VIEW_FORUM\]: defaultViewRoles\s*\}/
);
assert.match(
  adminPage,
  /permissions: \{\}\s*\}\);/,
  'a new category must start with no overrides (permissions: {})'
);

// The three states are a DECISION, not just a shape, so they are executed rather
// than pattern-matched: extract the real function and call it. A regex cannot
// tell "override on with nobody ticked" apart from "override off" — both are
// absent-or-array, and only the emitted list distinguishes them.
const payloadSource = categories.match(
  /const toCategoryPayload = [\s\S]*?\n};/
);
assert.ok(payloadSource, 'toCategoryPayload must be extractable for the behavioural check');

// pickLabel is injected under the name the extracted function uses: it mirrors
// src/api/categories.js pickLabel, which sends BOTH languages ({en, ru}) so an
// EN-only or RU-only label survives the round trip.
const pickLabel = (value) => (typeof value === 'string'
  ? { en: value.trim(), ru: value.trim() }
  : { en: (value?.en || '').trim(), ru: (value?.ru || '').trim() });
const toCategoryPayload = new Function(
  'pickLabel',
  'normalizeOrder',
  'VIEW_FORUM',
  'INHERIT_ROLES',
  'PERMISSIONS',
  `${payloadSource[0]}; return toCategoryPayload;`
)(
  pickLabel,
  (order) => {
    const value = Number.parseInt(order, 10);
    return Number.isFinite(value) ? value : null;
  },
  'view_forum',
  MARKER,
  PERMISSIONS
);

const form = (permissions) => ({ title: 'X', description: '', order: 1, group_id: 'g', permissions });

// OFF: the admin disabled the override. The category must follow the global
// role settings LIVE. The marker is what does that — sending the list of roles
// that hold view_forum today would be a snapshot, and a role created tomorrow
// would be refused this category.
assert.deepEqual(
  toCategoryPayload(form({ view_forum: null })).allowed_roles,
  [MARKER],
  'override OFF must send the inherit marker, so a role created later is admitted without re-saving'
);

// OFF is also reached with the key absent entirely, which is what a new
// category starts from. It must not be mistaken for "restrict to nobody".
assert.deepEqual(
  toCategoryPayload(form({})).allowed_roles,
  [MARKER],
  'a category with no override configured must send the marker, not an empty list'
);

// ON with nobody ticked: a deliberate "nobody but root may read this". ADR-1
// reads an empty list as exactly that, so it must survive the round trip and
// must NOT be confused with OFF.
assert.deepEqual(
  toCategoryPayload(form({ view_forum: [] })).allowed_roles,
  [],
  'override ON with no roles ticked must stay an empty list (root-only)'
);

// ON with a subset: exactly what was ticked, de-duplicated.
assert.deepEqual(
  toCategoryPayload(form({ view_forum: ['player', 'player', 'guest'] })).allowed_roles,
  ['player', 'guest'],
  'an explicit override must be sent verbatim, de-duplicated'
);

console.log('OK  forum read contract: every topic/post list is read under `items`');
console.log('OK  forum read contract: the topic form and reply path navigate with real ids');
console.log('OK  forum read contract: category paging reads `total`/`per_page`');
console.log('OK  forum read contract: category counters and last-post fields survive toCategory');
console.log('OK  forum read contract: the main page seeds categories, groups and stats — and no topic list');
console.log('OK  forum read contract: every topic list normalises before rendering');
console.log('OK  forum read contract: the subscriptions list normalises too — it renders TopicRow');
console.log('OK  forum read contract: reputation_votes is read server-side, never from the browser');
console.log('OK  forum read contract: accounts are read through /api/aerun/users/{id}, never the collection');
console.log('OK  forum read contract: the topic form transmits the mask and the pin');
console.log('OK  forum read contract: "override off" is stored as the live inherit marker, not a snapshot');
// ── The members board must be refreshable ─────────────────────────────────────
//
// WHY THIS GATE. The board is polled on purpose (DONE_REALTIME_TRANSPORT_DESIGN.md:
// a realtime subscription over every account would stream the membership to
// every visitor), so the page cannot answer "is this list current?" by itself.
// The member's only options were reloading the tab or navigating away and back —
// which is why this was worth building at all.
//
// The wiring is four pieces that each look fine alone and are useless apart: the
// handler must BUMP the read, the loader effect must REACT to it, and a control
// must be bound to that handler. Delete any one and the button still renders,
// still takes the click, and does nothing — which looks exactly like "the
// list did not change".
{
  const membersPage = read('../src/pages/MembersPage.jsx');
  const membersApi = stripComments(resources);
  const membersUi = stripComments(membersPage);

  // 1. The handler bumps the nonce that the loader effect depends on. There is
  //    no subscription to hand over a loader: the board is read one page at a
  //    time by fetchMembers, and a hand-off ref was the shape of the whole-
  //    board walk this page removed.
  assert.match(
    membersUi,
    /setRefreshNonce\(n => n \+ 1\)/,
    'the refresh handler must bump the nonce the loader effect depends on'
  );
  assert.match(
    membersUi,
    /\}, \[page, search, sortParams, refreshNonce\]\);/,
    'the loader effect must depend on the refresh nonce, or the button cannot re-read the page'
  );

  // 2. A control is bound to that handler.
  assert.match(
    membersUi,
    /onClick=\{handleRefresh\}/,
    'MembersPage must bind a control to handleRefresh — otherwise the handler is written and never called'
  );

  // 3. The subscription is no longer the way to re-read. The loader is the
  //    fetchMembers effect: a refresh that went through subscribeToAllUsers
  //    would refetch the WHOLE board (the walk this migration removes).
  forbid(
    membersUi,
    'MembersPage.jsx',
    /subscribeToAllUsers/,
    'the refresh must re-read through the paginated fetchMembers effect, never the whole-board subscription'
  );

  // The refresh must REPORT. A spinner that stops proves the request returned,
  // not that it worked, and this list fails silently: a failed read arrives as
  // an empty page, so a network blip empties the board with nothing to see.
  assert.match(
    membersUi,
    /showToast\(/,
    'the refresh must report its outcome — a bare spinner is indistinguishable from a no-op'
  );
  assert.match(
    membersUi,
    /useToast/,
    'MembersPage must use the shared toast provider rather than inventing a second notification path'
  );

  // …and it must be LOCALISED. An inline language ternary is the pattern
  // this replaced: it hardcodes two languages, so every other one the
  // forum ships renders English, and adding a language means hunting
  // through JSX. The strings belong in the dictionary.
  const dict = read('../src/i18n/dictionary.js');
  // `members_refresh_failed` is no longer rendered: the loader effect reports
  // nothing on failure (the empty page IS the failure signal, and the refresh
  // toast confirms the action), so requiring the key pinned a render the page
  // stopped doing.
  const REFRESH_KEYS = ['refresh_members', 'members_refreshed'];

  for (const key of REFRESH_KEYS) {
    assert.match(
      membersUi,
      new RegExp("t\\('forum\\." + key + "'\\)"),
      'the refresh must render "forum.' + key + '" through t(), not an inline ternary'
    );

    // Both shipped languages. A key present in only one renders the other
    // by fallback, which a member reads as untranslated rather than as a bug.
    const occurrences = dict.split(new RegExp("\\b" + key + ":")).length - 1;
    assert.ok(
      occurrences >= 2,
      'dictionary.js must define "' + key + '" for BOTH en and ru (found ' + occurrences + ')'
    );
  }

  // The board is server-paginated, so no single count means "how current
  // is this". The toast used to report one, implying a certainty the page
  // does not have.
  assert.doesNotMatch(
    membersUi,
    /members_refreshed[^)]*\bcount\b/i,
    'the refreshed toast must not report a member count — the board is paginated'
  );
}
console.log('OK  forum read contract: the members board refreshes, says so, and is localised');
// ── The realtime client must stay a nudge reader, not a content reader ──────
//
// The entire safety argument for realtime on this backend is that the browser
// receives an ID and then re-reads through /api/aerun, where authorization
// already lives. That argument is one plausible-looking line away from being
// undone: rendering from the signal payload, or trusting it to decide whether an
// update is relevant.
//
// Nothing here may read a signal's record as data. Literal-source assertions on
// purpose — the failure mode is a reasonable line, not a typo.
{
  const signals = read('../src/api/realtime-signals.js');
  const notifications = read('../src/api/rtdb-notifications.js');
  const banner = read('../src/components/common/RealtimeStatusBanner.jsx');

  // The subscription hands over a topic and an id — two strings. Not the record:
  // a caller that had it would eventually use it.
  //
  // Written as "the BARE record", because `onEvent?.(record?.topic, …)` is the
  // intended call and an assertion written as "any mention of record" fires on
  // the correct code. Precision matters here: a gate that flags the right thing
  // gets deleted rather than obeyed.
  assert.doesNotMatch(
    signals,
    /onEvent\??\.\(\s*record\s*[,)]/,
    'the signal callback must not receive the raw record — an id is the whole contract, and a ' +
      'record in hand becomes content on screen'
  );
  // …and it may only lift SCALARS off it. A signal row is four fields; anything
  // beyond that is the leak returning through the front door.
  for (const field of ['title', 'payload', 'content', 'body', 'nickname', 'email', 'settings']) {
    assert.doesNotMatch(
      signals,
      new RegExp('record\\??\\.' + field),
      `the client must not read "${field}" off a signal — the stream carries ids, not content`
    );
  }

  // …and it subscribes to the signals table, never to forum content.
  //
  // Matched on the COLLECTION, not on the topic argument: the call reads
  // `collection('realtime_signals').subscribe('*', …)`, so looking for the name
  // inside the subscribe arguments would never match anything.
  assert.match(
    signals,
    /collection\('realtime_signals'\)\s*\n?\s*\.?subscribe\(/,
    "the client must subscribe to 'realtime_signals' — subscribing to topics/posts would " +
      'require opening their REST rules, which is the leak the design exists to prevent'
  );
  assert.doesNotMatch(
    signals,
    /collection\('(topics|posts|notifications|dm_messages|dm_conversations)'\)/,
    'no forum-content collection may be subscribed directly from the browser'
  );

  // The notification hook IGNORES the payload: an event means "re-read", and the
  // server decides what the member may see.
  assert.doesNotMatch(
    notifications,
    /record\?\.(title|payload|content|body)\b|event\.record\.(title|payload|content)\b/,
    'notifications must not read content out of a realtime event — the re-read through ' +
      '/me/notifications is what enforces access'
  );

  // Guests must not open the stream at all. The rule would refuse every event,
  // and the connection would sit there looking healthy — the exact ambiguity this
  // work set out to remove.
  assert.match(
    notifications,
    /realtime:\s*canReceiveSignals\(\)/,
    'the realtime hook must be gated on canReceiveSignals(), or every guest opens a stream that ' +
      'can never deliver'
  );

  // The fallback interval stays configured. shared-poll removes it when a signal
  // arrives, so a healthy member pays nothing and a degraded one is unchanged.
  assert.match(
    notifications,
    /intervalMs:\s*15000/,
    'the poll interval must remain as the fallback — removing it would break the degraded case'
  );

  // The banner renders only on an OBSERVED fallback, never on connection.
  assert.match(
    banner,
    /transport === 'polling'/,
    'the banner must key off the measured transport, not off "we opened a stream"'
  );
}
console.log('OK  realtime client: signals are nudges, and the fallback is observable');
// ── The topic page reads stats, not the heavy full topic (B1) ─────────────
// Opening and polling a topic used to read GET /topics/{id} — ~1.2 KB of author
// decoration TopicPage never reads — just to compare posts_count, last_post_id and
// last_post_at. /stats now delivers essential topic metadata (title, pins, counters)
// and freshness, eliminating the ~1.2 KB payload from topic open entirely.
//
// These pin that contract: stats handles freshness and metadata, and TopicPage
// never calls fetchTopic on open.
assert.match(
  forum,
  /export const fetchTopicStats = async \(topicId\)/,
  'fetchTopicStats must exist — it is the topic page freshness read'
);
assert.match(
  forum,
  /\/api\/aerun\/topics\/\$\{topicId\}\/stats/,
  'the freshness read must hit /topics/{id}/stats, not the full topic payload'
);
assert.match(
  forum,
  /export const subscribeToTopicStats = \(topicId, callback\)/,
  'subscribeToTopicStats must exist — it is the 15s freshness loop over the stats endpoint'
);
assert.match(
  forum,
  /sharedPoll\(`topic-stats:\$\{topicId\}`/,
  'the stats loop must be a shared resource keyed by topic, so two readers of one thread cost one loop'
);
assert.match(
  forum,
  /export const fetchTopic = async \(topicId\)/,
  'fetchTopic must exist — general full topic read for other callers'
);
assert.match(
  topicPageCode,
  /subscribeToTopicStats\(id,/,
  'TopicPage must drive its freshness loop and metadata from subscribeToTopicStats'
);
forbid(
  topicPageCode,
  'TopicPage.jsx',
  /\bfetchTopic\(id\)/,
  'TopicPage must not call fetchTopic on open — topic metadata and freshness are served by stats, shedding the ~1.2 KB author decoration payload'
);
forbid(
  topicPageCode,
  'TopicPage.jsx freshness loop',
  /const unsubTopic = subscribeToTopic\(id,/,
  'the full-topic loop must not live on TopicPage — freshness is subscribeToTopicStats, and a second loop bills ~1.2 KB per tick'
);
assert.match(
  forum,
  /realtime:\s*canReceiveSignals\(\)/,
  'the stats loop must ride realtime with polling as the fallback — a healthy member pays no polling, a degraded one is unchanged'
);
console.log('OK  topic freshness: /stats delivers topic metadata and freshness; full-topic read eliminated from topic open');

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
