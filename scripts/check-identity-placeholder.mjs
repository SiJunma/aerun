// The identity placeholder (plan I5/D2) has ONE source and ONE render path.
//
// A removed account and an anonymous guest are identities with no account of
// their own: forum_authors.go leaves a deleted author's payload UNDECORATED (no
// author_name), and the DM listing resolves a removed peer to an empty
// participantNames entry. Every surface that draws such an identity — posts,
// last-post thumbnails, the DM inbox and chat — must resolve its avatar through
// the single identity.js helper, so an admin-uploaded custom image and the
// neutral default can never drift between surfaces (bug M2).
//
// These are source-shape gates because the failure is structural: a render site
// that inlines its own ui-avatars URL, or forgets to pass the custom
// placeholder, renders correctly in review and behaves as if the setting did not
// exist — the admin uploads an image and the forum keeps showing the gray "U".
//
// Run: node scripts/check-identity-placeholder.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const identity = read('../src/utils/identity.js');
const forumAuthorAvatar = read('../src/components/common/ForumAuthorAvatar.jsx');
const directMessages = read('../src/components/dm/DirectMessages.jsx');
const adminApi = read('../src/api/admin.js');
const adminPage = read('../src/pages/AdminPage.jsx');
const dictionary = read('../src/i18n/dictionary.js');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ── The helper exposes the ONE resolver the render sites share ──────────────
check(
  /export function identityAvatar\(/.test(identity),
  'identity.js must export identityAvatar — the single avatar resolver every render site shares'
);
check(
  /customPlaceholder/.test(identity) && /resolveAvatarUrl\(customPlaceholder\)/.test(identity),
  'identityAvatar must honour customPlaceholder (the settings.deletedAvatar / guestAvatar reference) ' +
    'before falling back to the default — otherwise an admin upload is invisible'
);

// ── Posts / last-post thumbnails resolve through the helper ─────────────────
// The removed-author case is the empty-name branch; it must route through
// identityAvatar so the custom placeholder reaches posts and thumbnails too.
check(
  /identityAvatar\(\{/.test(forumAuthorAvatar),
  'ForumAuthorAvatar must resolve the placeholder through identityAvatar, not an inline ui-avatars URL'
);
check(
  /customPlaceholder:\s*settings\?\.deletedAvatar/.test(forumAuthorAvatar),
  'ForumAuthorAvatar must pass customPlaceholder: settings.deletedAvatar — a deleted author is the ' +
    'removed-identity case the custom image is for'
);

// ── The DM surfaces resolve through the helper too ──────────────────────────
check(
  /identityAvatar\(\{/.test(directMessages),
  'DirectMessages must resolve placeholder avatars through identityAvatar (inbox row, header, bubble)'
);
check(
  /customPlaceholder:\s*settings\?\.deletedAvatar/.test(directMessages),
  'DirectMessages must pass customPlaceholder: settings.deletedAvatar so a removed peer draws the ' +
    'admin image, not the gray "U"'
);

// ── No inline ui-avatars left in the surfaces the helper owns ────────────────
// identity.js builds the default; a render site that hardcodes its own
// ui-avatars URL would bypass both the custom placeholder and the one default.
const inlineUiAvatars = (src) => /ui-avatars\.com/.test(src);
check(
  !inlineUiAvatars(forumAuthorAvatar),
  'ForumAuthorAvatar must not inline a ui-avatars URL — it goes through identity.js'
);
check(
  !inlineUiAvatars(directMessages),
  'DirectMessages must not inline a ui-avatars URL — it goes through identity.js'
);

// ── The admin upload plumbing is present ─────────────────────────────────────
check(
  /export const uploadIdentityPlaceholder = async/.test(adminApi),
  'admin.js must export uploadIdentityPlaceholder — the multipart PUT the settings form calls'
);
check(
  /uploadIdentityPlaceholder/.test(adminPage) && /AvatarUploader/.test(adminPage),
  'AdminPage must wire the placeholder upload form (AvatarUploader + uploadIdentityPlaceholder)'
);

// ── The settings form is translated in BOTH languages ────────────────────────
for (const [lang, key] of [['EN', 'identity_placeholders'], ['RU', 'identity_placeholders']]) {
  check(
    dictionary.includes(`${key}:`),
    `dictionary.js (${lang}) must define admin.settings.${key}`
  );
}
check(
  /placeholder_deleted:/.test(dictionary) && /placeholder_guest:/.test(dictionary),
  'dictionary.js must label both placeholder images (deleted + guest)'
);

if (failures.length > 0) {
  console.error(`identity-placeholder regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  identity placeholder: one resolver (identityAvatar) shared by posts, thumbnails and DM');
console.log('OK  identity placeholder: the custom deleted/guest image reaches every render site');
console.log('OK  identity placeholder: no inline ui-avatars URL bypasses the helper');
console.log('OK  identity placeholder: the admin upload form and both translations are present');
