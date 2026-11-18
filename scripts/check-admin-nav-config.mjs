// Regression test: the admin navigation must hide what the viewer may not open.
//
// The admin panel used to render a horizontal tab strip, and every tab was
// guarded by its own inline `hasPermission(...)` call. That arrangement fails
// in two ways, and neither of them throws:
//
//   1. The guards were duplicated. The strip decided which tabs to DRAW and
//      the panel below decided which panel to RENDER, from two separate
//      lists of the same permission keys. Adding a section meant editing
//      both, and forgetting one produced a tab that opened an empty page —
//      or a panel nobody could reach.
//   2. A group of tabs has nowhere to hide a section. With six sections
//      side by side there is no grouping, so the ONLY way to keep a
//      forbidden section out of the strip was to not render its tab, and the
//      viewer was left with a strip that could be shorter than the set of
//      sections the page knew about.
//
// The navigation is now ONE declarative tree (`src/config/adminNavigation.js`)
// that both the sidebar and the page read. This script imports that tree and
// EXECUTES it, so the rules under test are the ones the app runs — not a
// paraphrase of them that can drift.
//
// Asserted here:
//   1. every section of the tree names permissions that really exist, so a
//      typo cannot silently hide a section from everybody;
//   2. the permission filter hides the forbidden sections AND the groups
//      left empty by that hiding (an empty group header leaks the existence
//      of a section the viewer may not open);
//   3. the users section stays reachable for EACH of the three rights that
//      open it, and disappears for a viewer holding none of them;
//   4. the section names in the tree are the ones the page renders, so the
//      navigation cannot offer a section the page does not have;
//   5. every label the tree names exists in the dictionary, in BOTH
//      languages, because a missing key renders the raw key path;
//   6. the themeable DOM contract the sidebar promises is really there
//      (`#admin-sidebar`, `data-tab`, `data-group`, the state classes).
//
// Run: node scripts/check-admin-nav-config.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_NAV_GROUPS,
  filterNavByPermissions,
  findGroupForTab,
  collectVisibleTabPaths,
} from '../src/config/adminNavigation.js';
import { PERMISSIONS } from '../src/constants/permissions.js';
import { translations } from '../src/i18n/dictionary.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const sidebarSource = read('../src/components/admin/AdminSidebar.jsx');
const adminPageSource = read('../src/pages/AdminPage.jsx');

const failures = [];
const fail = (message) => failures.push(message);

const TABS = ['settings', 'designs', 'users', 'roles', 'categories', 'audit'];
const allPaths = collectVisibleTabPaths(ADMIN_NAV_GROUPS);

// -- 1. Every permission named by the tree really exists ---------------------
//
// A key that is not in PERMISSIONS can never be granted, so the section
// would be hidden from EVERY viewer, including the chief admin. Nothing
// reports that: the section simply never appears.

const knownPermissions = new Set(Object.values(PERMISSIONS));
for (const group of ADMIN_NAV_GROUPS) {
  for (const item of group.children) {
    for (const permission of item.anyOf || []) {
      if (!knownPermissions.has(permission)) {
        fail(
          `the "${item.id}" section names the permission "${permission}", which does not exist ` +
          'in src/constants/permissions.js - nobody could ever open it'
        );
      }
    }
  }
}

// -- 2. The filter hides forbidden sections AND the groups left empty --------

const everything = filterNavByPermissions(ADMIN_NAV_GROUPS, () => true);
if (everything.length !== ADMIN_NAV_GROUPS.length) {
  fail('a viewer holding every permission must see every group');
}
if (collectVisibleTabPaths(everything).length !== TABS.length) {
  fail('a viewer holding every permission must see every section');
}

if (filterNavByPermissions(ADMIN_NAV_GROUPS, () => false).length !== 0) {
  fail('a viewer holding no permission must see no group at all');
}

// A group whose every section is hidden must disappear with them: an empty
// group header is a signpost pointing at a section the viewer may not open.
const onlyCategories = filterNavByPermissions(
  ADMIN_NAV_GROUPS,
  (permission) => permission === PERMISSIONS.MANAGE_CATEGORIES
);
if (onlyCategories.length !== 1 || onlyCategories[0].id !== 'forumContent') {
  fail('a viewer who may only manage categories must see exactly the forum-content group');
}
if (collectVisibleTabPaths(onlyCategories).join() !== 'categories') {
  fail('a viewer who may only manage categories must see exactly the categories section');
}

// -- 3. The users section keeps its three rights, one at a time --------------
//
// The users section is the one place where a single right is not enough: an
// approver, a banner and a role changer each reach it through a different
// permission. Dropping any of the three would lock that kind of staff member
// out of the very list they have to work in.

for (const permission of [
  PERMISSIONS.APPROVE_USERS,
  PERMISSIONS.BAN_USERS,
  PERMISSIONS.CHANGE_ROLES,
]) {
  const visible = filterNavByPermissions(ADMIN_NAV_GROUPS, (p) => p === permission);
  if (!collectVisibleTabPaths(visible).includes('users')) {
    fail(`holding only "${permission}" must still open the users section`);
  }
}

const withoutUserRights = filterNavByPermissions(
  ADMIN_NAV_GROUPS,
  (permission) =>
    permission !== PERMISSIONS.APPROVE_USERS &&
    permission !== PERMISSIONS.BAN_USERS &&
    permission !== PERMISSIONS.CHANGE_ROLES
);
if (collectVisibleTabPaths(withoutUserRights).includes('users')) {
  fail('a viewer holding none of the three user rights must not see the users section');
}

// -- 4. The tree and the page agree on the sections -------------------------
//
// The navigation is only worth anything if every section it offers is a
// section the page can actually open. A name in the tree that the page does
// not render is a link to an empty page.

for (const path of TABS) {
  if (!allPaths.includes(path)) {
    fail(`the section "${path}" is missing from the navigation tree`);
  }
}
for (const path of allPaths) {
  if (!TABS.includes(path)) {
    fail(`the navigation tree offers "${path}", which the page does not render`);
  }
  if (!adminPageSource.includes(`activeTab === '${path}'`)) {
    fail(`the page does not render the section "${path}" the navigation offers`);
  }
}

// The group a section belongs to must be findable, or the sidebar cannot
// expand the group that holds the open section.
for (const path of TABS) {
  if (!findGroupForTab(ADMIN_NAV_GROUPS, path)) {
    fail(`the section "${path}" belongs to no group`);
  }
}
if (findGroupForTab(ADMIN_NAV_GROUPS, 'nonexistent') !== null) {
  fail('an unknown section must not be attributed to a group');
}

// -- 5. Every label exists, in both languages --------------------------------
//
// A missing key renders the key path itself ("admin.nav.forumContent"), so
// the defect is visible but easy to miss in review - and the other language
// is only noticed by the readers who use it.

const labelPaths = [
  ...ADMIN_NAV_GROUPS.map((group) => group.title),
  ...ADMIN_NAV_GROUPS.flatMap((group) => group.children.map((item) => item.title)),
];
for (const key of labelPaths) {
  for (const language of ['en', 'ru']) {
    const value = key
      .split('.')
      .reduce((node, part) => (node ? node[part] : undefined), translations[language]);
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`the label "${key}" is missing in the "${language}" dictionary`);
    }
  }
}

// -- 6. The themeable DOM contract is really there ----------------------------
//
// A custom design is written against these names (see
// markdowns/TODO_THEMEABLE_SPRINT_PLAN.md). A theme that targets
// `#admin-sidebar [data-tab="users"]` must find the element.

for (const [snippet, what] of [
  ['id="admin-sidebar"', 'the sidebar must carry the id #admin-sidebar'],
  ['data-tab={item.path}', 'a section must be marked with its data-tab'],
  ['data-group={group.id}', 'a group must be marked with its data-group'],
  ['is-active', 'the open section must be marked with the is-active state class'],
  ['is-collapsed', 'a folded group must be marked with the is-collapsed state class'],
  ['admin-sidebar--collapsed', 'collapsed sidebar state class must be present'],
  ['admin-sidebar--expanded', 'expanded sidebar state class must be present'],
  ['admin-sidebar__header', 'sidebar header class must be present'],
  ['admin-sidebar__title', 'sidebar title class must be present'],
  ['admin-sidebar__toggle-btn', 'sidebar toggle button class must be present'],
  ['admin-sidebar__nav', 'sidebar nav class must be present'],
  ['admin-sidebar__group', 'sidebar group class must be present'],
  ['admin-sidebar__group-header', 'sidebar group header class must be present'],
  ['admin-sidebar__group-chevron', 'sidebar group chevron class must be present'],
  ['admin-sidebar__group-items', 'sidebar group items class must be present'],
  ['admin-nav-item', 'nav item class must be present'],
  ['admin-nav-item--active', 'nav item active modifier must be present'],
  ['admin-nav-item__icon', 'nav item icon container class must be present'],
  ['admin-nav-item__label', 'nav item label class must be present'],
  ['admin-offcanvas', 'mobile offcanvas class must be present'],
]) {
  if (!sidebarSource.includes(snippet)) {
    fail(`${what} (expected "${snippet}" in AdminSidebar.jsx)`);
  }
}

// Layout hooks on the page
for (const [snippet, what] of [
  ['id="admin-page"', 'the page layout must carry id="admin-page"'],
  ['admin-dashboard-layout', 'admin-dashboard-layout container class must be present'],
  ['admin-dashboard-content', 'admin-dashboard-content column class must be present'],
  ['admin-dashboard-body', 'admin-dashboard-body container class must be present'],
  ['admin-mobile-toggle-bar', 'admin-mobile-toggle-bar class must be present'],
]) {
  if (!adminPageSource.includes(snippet)) {
    fail(`${what} (expected "${snippet}" in AdminPage.jsx)`);
  }
}

// Prohibit forbidden bootstrap utilities in AdminSidebar.jsx
for (const utility of ['d-none', 'd-lg-flex', 'd-lg-none', 'fw-bold', 'fs-5', 'p-0']) {
  if (sidebarSource.includes(utility)) {
    fail(`AdminSidebar.jsx must not use bootstrap utility "${utility}" — replace with component CSS`);
  }
}

// The page must not keep the old tab strip: two navigations at once means
// two sets of hooks, and the strip is the one no theme knows about.
if (/<Nav\b/.test(adminPageSource)) {
  fail('the admin page must not render a tab strip any more - the sidebar is the navigation');
}

if (failures.length > 0) {
  console.error(`admin navigation contract broken (${failures.length}):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `admin navigation OK - ${ADMIN_NAV_GROUPS.length} groups, ${TABS.length} sections, ` +
  'permissions, i18n and the themeable contract verified'
);
