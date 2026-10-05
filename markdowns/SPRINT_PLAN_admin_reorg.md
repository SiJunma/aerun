# Sprint Plan: Admin View Reorganization

**Sprint Goal**: Transform the horizontal tab-based admin navigation into a scalable, responsive left sidebar layout with permission-based dynamic filtering.

**Target Files** (verified 2026-10-05):
- `src/pages/AdminPage.jsx` — main admin page (tab → sidebar)
- `src/navigation/adminNavigationConfig.js` — NEW (plain JS + JSDoc; repo has no TS, no `typecheck` script)
- `src/constants/permissions.js` — permission definitions (verify; `MANAGE_USERS` does NOT exist — do not invent it)
- `backend/internal/platform/pocketbase/catalog_roles.go` — role editor API (no structural changes)
- `src/api/admin.js` — admin API (verify; `fetchAdminRoles` already exists and is already wired in AdminPage)

> **Binding constraints from the concept (do not drop during implementation):**
> - **C1 — Preserve global Header/Topbar.** Do NOT modify it. The sidebar sits *underneath*
>   the header and spans the remaining viewport height (concept §1).
> - **C2 — Pure structural refactoring.** Do NOT alter styling (border-radius, cards,
>   typography, colors). Existing panels (`renderSettings/renderUsers/...`) stay untouched
>   inside their content containers (concept §2).

---
## 1. Navigation Config (`adminNavigationConfig.js`)

**Goal**: Define a declarative navigation tree that replaces the hardcoded `canAccessTab` switch.

> VERIFIED 2026-10-05: this repo is plain JS (`AdminPage.jsx`, no `src/navigation/`, no `typecheck`
> script in `package.json`, no TS test runner — `npm test` = `scripts/check-*.mjs` + `eslint`).
> So the config is `.js` with a JSDoc typedef, NOT `.ts`.

### 1.1 Create `src/navigation/adminNavigationConfig.js`

```js
// @ts-check — plain JS with JSDoc (repo has no TS, no typecheck script).
import { PERMISSIONS } from '../constants/permissions.js';

/**
 * @typedef {Object} NavItem
 * @property {string} title            // i18n key for sidebar label
 * @property {string} [path]           // admin page tab key (e.g., 'settings')
 * @property {string} [icon]           // lucide icon name
 * @property {string[]} [anyOf]        // visible if user has ANY of these (mirrors canAccessTab OR-logic)
 * @property {NavItem[]} [children]    // nested sub-menu items
 */

/** @type {NavItem[]} */
export const ADMIN_NAV_GROUPS = [
  {
    title: 'admin.nav.userManagement',
    icon: 'Users',
    // NOTE: no group-level permission — group visibility is DERIVED:
    // visible iff ≥1 child is visible (concept §4: empty parent hidden).
    // A group `permission` here would wrongly gate children
    // (e.g. MANAGE_FORUM hiding Categories from a categories-only admin).
    children: [
      // Users tab in AdminPage.jsx (L2124, L2155) is visible on
      // APPROVE_USERS || BAN_USERS || CHANGE_ROLES — keep all three here.
      { title: 'admin.nav.users', path: 'users', icon: 'User', anyOf: [PERMISSIONS.APPROVE_USERS, PERMISSIONS.BAN_USERS, PERMISSIONS.CHANGE_ROLES] },
      { title: 'admin.nav.roles', path: 'roles', icon: 'Shield', anyOf: [PERMISSIONS.MANAGE_ROLES] },
    ],
  },
  {
    title: 'admin.nav.forumContent',
    icon: 'Layers',
    children: [
      { title: 'admin.nav.categories', path: 'categories', icon: 'FolderTree', anyOf: [PERMISSIONS.MANAGE_CATEGORIES] },
      { title: 'admin.nav.designs', path: 'designs', icon: 'Palette', anyOf: [PERMISSIONS.MANAGE_DESIGNS] },
    ],
  },
  {
    title: 'admin.nav.systemConfig',
    icon: 'Settings',
    children: [
      { title: 'admin.nav.settings', path: 'settings', icon: 'Settings', anyOf: [PERMISSIONS.MANAGE_FORUM] },
      { title: 'admin.nav.auditLog', path: 'audit', icon: 'FileText', anyOf: [PERMISSIONS.VIEW_AUDIT_LOG] },
    ],
  },
];
```

> Why `anyOf[]` and not `permission: string` (concept §"Technical Implementation Plan"
> shows `permission?: string`)? Because the real `canAccessTab` (AdminPage.jsx L250-260)
> is OR-logic for Users. A single-string field cannot express it — fixed here.
> Why no `PERMISSIONS.MANAGE_USERS` (concept example implies it)? It does not exist
> in `src/constants/permissions.js` — verified 2026-10-05. Do not invent it.

### 1.2 Acceptance Criteria
- `node --check src/navigation/adminNavigationConfig.js` passes (repo is JS; there is
  NO `npm run typecheck` script — verified in `package.json` 2026-10-05, do not add one in this sprint)
- All 6 existing tabs (`settings`, `designs`, `users`, `roles`, `categories`, `audit`
  — AdminPage.jsx L250-260, L2113-2144) map to a `path` in the config
- Each item's `anyOf` keys exist in `PERMISSIONS` (`src/constants/permissions.js`);
  `MANAGE_USERS` must NOT appear (does not exist)
- The config is a single source of truth — no duplicate tab definitions in `AdminPage.jsx`
  (the `canAccessTab` switch L250-260 and the six `hasPermission(...)` guards L2114-2143
  are replaced by one `filterNavByPermissions` derived from this config)

---
--- 

## 2. Sidebar UI Implementation

### 2.1 Layout Structure

```
+---------------------------------------------+
� [Global Header / Topbar]                     �
+---------------------------------------------�
� Sidebar  �  Content Area                    �
� (fixed)  �  (main content)                  �
�          �                                  �
� ? Users  �                                  �
�   ? Roles�                                  �
�     ? Adm�                                  �
�     ? Mod�                                  �
� ? Forum  �                                  �
�   ? Cat  �                                  �
�   ? Des  �                                  �
� ? System �                                  �
�   ? Set  �                                  �
�   ? Aud  �                                  �
+---------------------------------------------+
```

### 2.2 Key Changes in `AdminPage.jsx`

> VERIFIED 2026-10-05: use the existing stack only — `react-bootstrap` + `lucide-react`
> (both already in `package.json`). No new libs. No styling redesign (concept §2):
> sidebar is layout + accordion grouping only, existing panels stay untouched.

**Do NOT touch the global Header/Topbar** (concept §1). The sidebar sits UNDER it and
spans the remaining viewport height (`height: calc(100vh - <header-height>)` or flex
filler — measure, don't hardcode a second header).
**Do NOT restyle cards/buttons/typography** inside content panels.

**Before** (horizontal tabs):
```jsx
<Nav variant="tabs" activeKey={activeTab} onSelect={setActiveTab}>
  <Nav.Item><Nav.Link eventKey="settings">Settings</Nav.Link></Nav.Item>
  <Nav.Item><Nav.Link eventKey="designs">Designs</Nav.Link></Nav.Item>
  ...
</Nav>
```

**After** (sidebar with groups):
```jsx
<aside className="admin-sidebar">
  {ADMIN_NAV_GROUPS.map(group => (
    <NavItemGroup key={group.title} group={group} 
                  activeTab={activeTab} 
                  onSelect={setActiveTab}
                  canAccess={hasPermission} />
  ))}
</aside>
<main className="admin-content">
  {/* tab content */}
</main>
```

### 2.3 Permission-Based Filtering

Replace `canAccessTab` switch with a function that evaluates the nav config:

```js
// src/navigation/adminNavigationConfig.js
export const filterNavByPermissions = (items, hasPerm) => {
  return items
    .map(item => ({
      ...item,
      children: item.children?.filter(child => 
        !child.anyOf || child.anyOf.some(p => hasPerm(p))
      ),
    }))
    .filter(group => 
      !group.permission || hasPerm(group.permission) || 
      group.children && group.children.length > 0
    );
};
```

**Behavior**: If a user lacks permission for a section (e.g., `Audit Log`), that item **and its empty parent category are hidden completely**.

### 2.4 Acceptance Criteria
- Sidebar renders on all admin pages
- Groups collapse/expand independently
- Items without required permissions are hidden
- Empty parent categories (no visible children) are hidden
- Active tab is highlighted in the sidebar
- Clicking a sidebar item navigates to the corresponding tab

---
--- 

## 3. Role Editor Integration

**Goal**: Ensure the role editor works seamlessly with the new sidebar structure.

The existing `roleEditorPayload` and `listAdminRolesHandler` in `catalog_roles.go` already provide the correct data shape. No backend changes needed.

**Current payload structure** (`roleEditorPayload`):
```json
{
  "role_id": "...",
  "name": "...",
  "rank": ...,
  "color": "...",
  "id": "...",
  "is_system": true/false,
  "base_role_id": "...",
  "max_characters_limit": ...,
  "permissions": ["...", "..."]
}
```

In `AdminPage.jsx`, the roles tab must:
- Load from `GET /api/aerun/admin/roles` (via `fetchAdminRoles`)
- Display full role editor form with all fields
- Respect `canEditRole` logic (root/admin can edit all; others can only edit lower-level roles)

### 3.1 Acceptance Criteria
- Role editor loads and displays all fields correctly
- System roles ARE editable like custom ones (only `role_id`/`is_system` locked server-side, delete forbidden with 403 "system roles cannot be deleted"); verify 403-on-delete handled gracefully, NOT 403-on-edit
- Custom roles can be created with proper base role selection
- Permissions are saved correctly

---
--- 

## 4. Mobile Responsiveness

### 4.1 Responsive Behavior

| Screen Size | Layout |
|-------------|--------|
| Desktop (=992px) | Fixed left sidebar |
| Tablet/Mobile (<992px) | Off-canvas drawer toggled by hamburger |

### 4.2 Implementation

```jsx
const [sidebarOpen, setSidebarOpen] = useState(false);

// Hamburger button in topbar (or below global header)
<Button variant="outline" onClick={() => setSidebarOpen(true)}>
  <Menu size={24} />
</Button>

// Sidebar becomes a Drawer on mobile
<Sidebar 
  isOpen={sidebarOpen} 
  onClose={() => setSidebarOpen(false)}
  isMobile={isMobile}
/>
```

### 4.3 Acceptance Criteria
- Sidebar is fixed on desktop (=992px)
- Sidebar converts to drawer on mobile (<992px)
- Drawer opens on hamburger click
- Selecting a nav link on mobile closes the drawer
- Layout does not overflow or break on small screens

---
--- 

## 5. Testing & Validation

### 5.1 Unit Tests

1. **Navigation Config Tests** (`adminNavigationConfig.test.ts`):
   - All tabs are mapped to a path
   - No duplicate paths
   - All permission keys exist in `PERMISSIONS`

2. **Permission Filtering Tests**:
   - `filterNavByPermissions` returns only items the user can access
   - Empty parent groups are filtered out
   - Root admin sees all items

3. **AdminPage Integration Tests**:
   - Sidebar renders correctly for different permission sets
   - Tab switching works via sidebar clicks
   - Active tab is highlighted

### 5.2 Manual Testing Checklist

- [ ] All admin tabs accessible via sidebar
- [ ] Permission-based hiding works for different roles
- [ ] Sidebar collapses/expands on desktop
- [ ] Mobile drawer opens/closes correctly
- [ ] Role editor CRUD operations work
- [ ] No visual regressions in existing admin panels
- [ ] i18n keys are defined for all sidebar labels

---

## 6. Dependencies & Notes

- **Backend**: No changes required to `catalog_roles.go` � role editor API already implemented
- **i18n**: New sidebar labels need translations in `src/i18n/dictionary.js`
- **Permissions**: Verify all `PERMISSIONS` constants in nav config exist
- **Styling**: Use existing CSS classes; no new design tokens unless necessary

---

## 7. Sprint Timeline (Suggested)

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Create `adminNavigationConfig.ts` | Navigation config file |
| 2 | Implement sidebar UI in `AdminPage.jsx` | Sidebar layout |
| 3 | Add permission filtering & mobile drawer | Filtered nav + responsive |
| 4 | Verify role editor integration | Working role CRUD |
| 5 | Testing & bug fixes | All tests passing |

---

## 8. Definition of Done

- [ ] All tasks from �1��4 complete
- [ ] All acceptance criteria met
- [ ] Tests written and passing
- [ ] No visual regressions
- [ ] i18n keys added for all new labels
- [ ] Code reviewed and merged
