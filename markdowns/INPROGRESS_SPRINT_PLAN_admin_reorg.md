# Sprint Plan: Admin View Reorganization & Themeable Preparation

**Status**: IN PROGRESS — implemented on branch `feature/admin-reorg`, verified, not yet merged to `main`.

**Goal**: Replace the horizontal tab navigation in `AdminPage.jsx` with a responsive vertical sidebar: grouped, collapsible sections, filtered by the viewer's permissions, an off-canvas drawer on narrow screens, and a stable DOM contract for custom themes (`TODO_THEMEABLE_SPRINT_PLAN.md`).

---

## 0. What was built

| File | Action | Purpose |
|---|---|---|
| `src/config/adminNavigation.js` | **NEW** | The declarative navigation tree: groups, sections, the permission each section needs, and the pure helpers that filter it. No React, so the check script can execute it in plain Node. |
| `src/components/admin/AdminSidebar.jsx` | **NEW** | The sidebar: collapsible groups, the responsive drawer, the themeable DOM contract. |
| `src/components/admin/AdminSidebar.css` | **NEW** | Every rule hangs on the semantic class, never on a Bootstrap class. Colours come from the forum's own theme variables, so all three built-in themes are covered without a rule per theme. |
| `src/i18n/dictionary.js` | **MODIFY** | Added `admin.nav.*` (group titles, drawer title, toggle label) in EN and RU. Section labels keep the existing `admin.tabs.*` keys. |
| `src/pages/AdminPage.jsx` | **MODIFY** | The tab strip is gone; the page renders the sidebar and the content in a two-column grid. The content panels are untouched. |
| `scripts/check-admin-nav-config.mjs` | **NEW** | Executes the real navigation tree and checks the permission, i18n and DOM contracts. |
| `package.json` | **MODIFY** | Added `test:admin-nav-config` and chained it into `npm test`. |

---

## 1. The navigation tree (`src/config/adminNavigation.js`)

### 1.1 Invariants

1. **Plain JS + JSDoc.** The repo has no TypeScript toolchain (`package.json` carries no `tsc` and no `typecheck` script), so a `.ts` file would be a file nothing compiles.
2. **`anyOf: string[]`, not `permission: string`.** The users section is reachable through three different rights — an approver, a banner and a role changer each open it with their own permission. One key could only ever express one of them, so the section would have been hidden from the other two kinds of staff, and the page that renders it (which checks all three) would have disagreed with the navigation.
3. **No phantom permissions.** Every key must exist in `src/constants/permissions.js`; there is no `PERMISSIONS.MANAGE_USERS` in this codebase, and a key that does not exist is a key the server refuses.
4. **i18n key separation.** Sections keep the existing `admin.tabs.<path>` labels; groups get the new `admin.nav.<groupId>` titles.
5. **Dynamic parent visibility.** A group is rendered **if and only if** at least one of its sections survives the permission filter. An empty group header is a signpost pointing at a section the viewer may not open.
6. **One tree, two readers.** The sidebar and the page read the SAME filtered tree, so a section can never be offered in the navigation and missing from the page.

### 1.2 The three groups

| Group | Sections | Opens with |
|---|---|---|
| `userManagement` — User & Access | `users`, `roles` | `approve_users` / `ban_users` / `change_roles` (any of), `manage_roles` |
| `forumContent` — Forum Content | `categories`, `designs` | `manage_categories`, `manage_designs` |
| `systemConfig` — System | `settings`, `audit` | `manage_forum`, `view_audit_log` |

### 1.3 The helpers

- `filterNavByPermissions(groups, hasPerm)` — drops the sections the viewer may not open, and then the groups left empty.
- `findGroupForTab(groups, path)` — the group a section belongs to, so the sidebar can expand the group holding the open section.
- `collectVisibleTabPaths(groups)` — every reachable section path, in display order. The page uses it to answer "may this `?tab=` be opened at all?".

---

## 2. The sidebar (`src/components/admin/AdminSidebar.jsx`)

### 2.1 One copy of the navigation

A desktop sidebar and a mobile drawer are usually two copies of the same markup, which means two sets of `data-tab` hooks for a theme to trip over and two focusable copies of every link. Here the navigation is ONE Bootstrap `Offcanvas` with the `responsive` prop: from `lg` up Bootstrap renders it in the flow as a static block, and below that as a drawer that slides in from the edge. Exactly one copy of the markup exists at any moment, and the drawer brings the focus handling, the Escape key, the backdrop and the scroll lock with it.

### 2.2 Behaviour

- The groups arrive from the page already filtered, so the component renders what it is given.
- A group can be folded; the group holding the open section is expanded automatically, adjusted while rendering (the same "adjust state when a value changes" pattern `ThemeProvider` uses) rather than in an effect, so the navigation is never painted with the wrong group folded.
- Choosing a section closes the drawer — on a phone the navigation covers the page, so it must get out of the way.
- Widening the window past the breakpoint drops the drawer state; otherwise the page would stay locked from scrolling with nothing on screen to close it.

### 2.3 The themeable DOM contract

`#admin-sidebar`, `.admin-nav`, `.admin-sidebar-group`, `.admin-sidebar-group-header`, `.admin-sidebar-list`, `.admin-nav-item`, `.admin-nav-link`, the state classes `.is-open` / `.is-collapsed` / `.is-active`, and the data attributes `data-group` / `data-tab`. `markdowns/TODO_THEMEABLE_SPRINT_PLAN.md` (Sprint 12) was updated to this structure.

---

## 3. The page (`src/pages/AdminPage.jsx`)

### 3.1 Structure

The tab strip is replaced by a two-column grid: the sidebar in `col-lg-3`, the content in `col-lg-9` (`#admin-content`). The nested `<Container>` is gone — the global `<Layout>` already provides one, and two nested containers gave the admin panel a narrower measure than every other page for no reason.

The page now reads the filtered tree once and passes it down:

```jsx
const visibleNavGroups = useMemo(
  () => filterNavByPermissions(ADMIN_NAV_GROUPS, hasPermission),
  [hasPermission]
);
```

### 3.2 The open section can no longer be a section the viewer may not open

The old code read `?tab=` and fell back to `'settings'`. A viewer without `manage_forum` therefore landed on a section that rendered nothing — an empty page below a tab strip that did not contain the tab they were on.

Now the requested tab is honoured only if it is reachable, and otherwise the FIRST reachable section is shown:

```jsx
const requestedTab = searchParams.get('tab');
const activeTab = visibleTabPaths.includes(requestedTab)
  ? requestedTab
  : (visibleTabPaths[0] ?? null);
```

A bookmarked `?tab=audit` therefore opens the audit log for a viewer who may read it, and opens a section they may read for one who may not — never a blank page.

### 3.3 The content panels are untouched

`renderSettings`, `renderUsers`, `renderRoles`, `renderCategories`, `renderAuditLog` and `DesignsTab` are unchanged, so no closure over the page state broke. Each is still gated by its own `hasPermission` check as well as by the open section — the navigation filter decides what is *offered*, the panel gate decides what is *rendered*, and the two are now derived from the same tree.

---

## 4. The stylesheet (`src/components/admin/AdminSidebar.css`)

### 4.1 The rules hang on the semantic classes, never on Bootstrap's

A theme is written against `#admin-sidebar [data-tab="users"]` or `.admin-nav-link.is-active`. If the styling depended on `.nav-link` or `.offcanvas-body`, a theme would break the moment the markup changed — and the themeable plan forbids exactly that ("НЕ использовать Bootstrap-классы как Theme API"). So every rule below targets a class this component owns, and the Bootstrap classes are left to Bootstrap.

### 4.2 The colours come from the forum's theme variables

The forum themes itself through `--text-color`, `--card-bg`, `--border-color`, `--content-link-color` and `--block-bg` (see `src/index.css`). The sidebar uses the same variables, so light, dark and neutral all work without a single theme-specific rule. The original draft hard-coded `rgba(255, 255, 255, 0.07)` hovers and a `--bs-body-bg` fallback, which would have been invisible in the light theme.

### 4.3 The responsive placement

- Wide screens: the navigation is a sticky column that scrolls with the page, capped to the viewport height.
- Narrow screens: Bootstrap's own off-canvas drawer behaviour does the work (slide-in, dimming, scroll lock); the stylesheet only sets the drawer width.

---

## 5. The check script (`scripts/check-admin-nav-config.mjs`)

It IMPORTS the navigation tree and executes it, so the rules under test are the ones the application runs — not a paraphrase of them that can drift. It asserts:

1. every permission the tree names really exists in `PERMISSIONS`;
2. the filter hides the forbidden sections AND the groups left empty by that hiding;
3. the users section stays reachable for EACH of its three rights, and disappears for a viewer holding none of them;
4. the section names in the tree are exactly the sections the page renders;
5. every label exists in the dictionary, in BOTH languages;
6. the themeable DOM contract is really there, and the old tab strip is gone from the page.

Wired into `npm test` as `test:admin-nav-config`.

---

## 6. Deviations from the original draft

The draft plan was written before the code was re-read. Where the two disagreed, the code won — the draft is the intent, the code is the truth.

| Draft said | Built | Why |
|---|---|---|
| `src/navigation/adminNavigationConfig.js` | `src/config/adminNavigation.js` | The repo keeps declarative configuration in `src/config/` (`smiles.js` lives there). A new top-level `src/navigation/` folder for one file breaks that convention. |
| `adminNavigationConfig.ts`, TypeScript types | Plain JS + JSDoc | The repo has no TypeScript toolchain: no `tsc`, no `typecheck` script, no `.ts` file anywhere. A `.ts` file would be a file nothing compiles. |
| `permission?: string` | `anyOf: string[]` | The users section needs OR logic across three rights. One key could only express one of them. |
| `AdminSidebar` filters by `hasPermission` itself | The page filters, the sidebar renders | Both must agree on what is visible, or the navigation can offer a section the page does not open. Filtering once, in one place, and passing the result down removes the possibility of disagreement. |
| A desktop `<aside>` and a mobile `<Offcanvas>` as separate elements | ONE `<Offcanvas responsive="lg">` | Two copies of the navigation means two sets of `data-tab` hooks and two focusable copies of every link. `responsive` gives both layouts from one copy. |
| `propTypes` on the component | none | `prop-types` is not a dependency of this project (only `Skeleton.jsx` uses it, via a transitive install). The repository's own convention for component contracts is JSDoc, and the check script covers the contract that actually matters. |
| The sidebar CSS in a separate file | The same, but with the page rules in it | Unchanged, and it now covers the page layout as well, so the admin view's rules live in one place. |
| `admin.nav.toggleMenu` only | `admin.nav.toggleMenu` + `admin.nav.menuLabel` | The drawer needs a title of its own, and the navigation needs a label for screen readers; both are translated. |
| — | The active section falls back to the first reachable one | Not in the draft, and it fixes a real defect: a viewer without `manage_forum` used to land on an empty page. |

---

## 7. Verification

Run on 2026-10-21, branch `feature/admin-reorg`:

| Check | Result |
|---|---|
| `npm test` (the whole chain) | passed — including the new `test:admin-nav-config` |
| `npm run test:admin-nav-config` | `admin navigation OK - 3 groups, 6 sections, permissions, i18n and the themeable contract verified` |
| `npm run lint:js` | 0 errors; the 2 warnings are the pre-existing ones in `ProfilePage.jsx` (unchanged by this sprint) |
| `npm run build` | built in ~30 s; the "chunk larger than 500 kB" warning is pre-existing |

**Still to be done by hand**: open `/admin` as an admin and as a viewer with a narrow right, and check the drawer on a phone-sized viewport. The automated checks cannot see the layout.

---

## 8. Before this reaches `main`

- The branch is `feature/admin-reorg`; `main` is untouched.
- The owner merges it, and the VPS migration happens afterwards, as planned: this is a feature, not a bug fix, so it rides with the next release rather than going out as a hotfix.

---

## 9. Checkpoints & Theming Preparation Finalization (Brief: 2026-11-17)

**Goal**: Prepare and lock the admin panel layout and sidebar contract so Sprint 12 of `markdowns/TODO_THEMEABLE_SPRINT_PLAN.md` has a stable, clean, zero-inline-style, zero-bootstrap-utility DOM to theme without rework.

### Checkpoint Progress Tracker

| Checkpoint | Scope | Status | Verification |
|---|---|---|---|
| **CP-1**: DOM Contract & Component Cleanliness | Remove inline styles, replace Bootstrap utilities with component CSS, ensure semantic BEM hooks and theme variables. | **DONE** | Zero `style={}`, zero utilities (`d-none`, `d-lg-*`, `fw-bold`, `fs-5`, `p-0`), zero raw hex colors. |
| **CP-2**: Verification Suite & Automated Contract Guard | Strengthen `scripts/check-admin-nav-config.mjs` with BEM & utility assertions; run lint, build, test. | **DONE** | `npm run test:admin-nav-config` OK, `npm run lint:js` 0 errors, `npm run build` OK, `npm test` 100% green. |
| **CP-3**: Documentation Synchronization | Update Sprint 12 mini-specification in `markdowns/TODO_THEMEABLE_SPRINT_PLAN.md` with the real DOM structure. | **DONE** | Target DOM in Sprint 12 updated to match `admin-dashboard-layout` & `AdminSidebar`. |

### Detailed Checkpoint Breakdown

#### Checkpoint 1: Clean DOM & AdminSidebar Reorg
1. **Zero inline styles**:
   - `src/components/admin/AdminSidebar.jsx` and `src/pages/AdminPage.jsx` layout code contain no `style={...}`.
2. **Bootstrap utilities eradicated in new markup**:
   - In `AdminSidebar.jsx`: eliminated `d-none d-lg-flex`, `d-lg-none`, `fw-bold fs-5`, `p-0`. Responsive display is driven entirely by media queries in `AdminSidebar.css`. Typography and padding are delegated to `.admin-offcanvas__title` and `.admin-offcanvas__body`.
   - In `AdminPage.jsx`: eliminated `d-lg-none`, `me-2`, `text-muted small ms-auto fw-medium`, and `p-3 p-md-4` from the layout markup. Replaced with semantic `.admin-mobile-toggle-icon`, `.admin-mobile-toggle-current`, and layout padding in `AdminSidebar.css`.
3. **No new react-bootstrap imports**:
   - Only existing `Offcanvas`, `OverlayTrigger`, and `Tooltip` are used.
4. **Colours strictly via theme variables**:
   - In `AdminSidebar.css`, all colors reference `var(--card-bg)`, `var(--border-color)`, `var(--text-color)`, `var(--secondary-color)`, `var(--content-link-color)`, `var(--block-bg)`, `var(--primary-color)`. Zero hardcoded hex colors.
5. **Stable Themeable DOM Hooks preserved**:
   - Root layout: `#admin-page`, `.admin-dashboard-layout`, `.admin-dashboard-content`, `.admin-dashboard-body`, `.admin-mobile-toggle-bar`.
   - Desktop sidebar: `#admin-sidebar`, `.admin-sidebar`, `.admin-sidebar--collapsed`, `.admin-sidebar--expanded`, `.admin-sidebar__header`, `.admin-sidebar__title`, `.admin-sidebar__toggle-btn`, `.admin-sidebar__nav`, `.admin-sidebar__group`, `.admin-sidebar__group-header`, `.admin-sidebar__group-chevron`, `.admin-sidebar__group-chevron--collapsed`, `.admin-sidebar__group-items`.
   - Nav items: `.admin-nav-item`, `.admin-nav-item--active`, `.admin-nav-item__icon`, `.admin-nav-item__label`, `[data-group]`, `[data-tab]`, `.is-active`, `.is-collapsed`.
   - Mobile offcanvas: `.admin-offcanvas`, `.admin-offcanvas__header`, `.admin-offcanvas__title`, `.admin-offcanvas__body`.

#### Checkpoint 2: Validation & CI Guard
- `scripts/check-admin-nav-config.mjs` asserts:
  - Permission validity in `PERMISSIONS`.
  - Dynamic group & item filtering via `src/config/adminNavigation.js`.
  - Section correspondence between navigation tree and `AdminPage.jsx`.
  - Presence of dictionary keys in EN and RU.
  - Strict BEM class contract on `AdminSidebar.jsx` and `AdminPage.jsx`.
  - Negative assertion: prohibition of Bootstrap utility classes in `AdminSidebar.jsx`.

#### Checkpoint 3: Documentation Alignment
- `markdowns/TODO_THEMEABLE_SPRINT_PLAN.md`: Sprint 12 mini-spec replaced outdated `<nav class="admin-tabs">` with the actual `admin-dashboard-layout` and `AdminSidebar` DOM architecture. Fully environment-neutral.
