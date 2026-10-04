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
const forbid = (source, label, pattern) => {
  if (pattern.test(source)) failures.push(`${label} must not match ${pattern}`);
};

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
for (const key of ['last_post_topic_id', 'last_post_topic_title', 'last_post_at', 'last_post_author']) {
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
assert.match(
  resources,
  /return \(res\?\.items \|\| \[\]\)\.map\(normalizeTopic\)/,
  'fetchLatestTopics must map through normalizeTopic — TopicRow reads the normalised field names'
);
assert.match(
  resources,
  /const topics = await fetchLatestTopics\(limitCount\)/,
  'subscribeToTopTopics must reuse fetchLatestTopics so the two lists cannot drift'
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

const pickTitle = (value) => (typeof value === 'string' ? value.trim() : '');
const toCategoryPayload = new Function(
  'pickTitle',
  'normalizeOrder',
  'VIEW_FORUM',
  'INHERIT_ROLES',
  `${payloadSource[0]}; return toCategoryPayload;`
)(
  pickTitle,
  (order) => {
    const value = Number.parseInt(order, 10);
    return Number.isFinite(value) ? value : null;
  },
  'view_forum',
  MARKER
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

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log('OK  forum read contract: every topic/post list is read under `items`');
console.log('OK  forum read contract: the topic form and reply path navigate with real ids');
console.log('OK  forum read contract: category paging reads `total`/`per_page`');
console.log('OK  forum read contract: category counters and last-post fields survive toCategory');
console.log('OK  forum read contract: the main page seeds categories, groups and stats — and no topic list');
console.log('OK  forum read contract: every topic list normalises before rendering');
console.log('OK  forum read contract: the subscriptions list normalises too — it renders TopicRow');
console.log('OK  forum read contract: reputation_votes is read server-side, never from the browser');
console.log('OK  forum read contract: the topic form transmits the mask and the pin');
console.log('OK  forum read contract: "override off" is stored as the live inherit marker, not a snapshot');