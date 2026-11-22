// @ts-check
import { PERMISSIONS } from '../constants/permissions.js';

/**
 * The declarative shape of the admin navigation.
 *
 * WHY THIS FILE IS PLAIN DATA (no React, no JSX).
 *
 * The navigation tree is the ONE place that knows which admin sections exist
 * and who may see them. It is read by the sidebar component (to render) and by
 * the admin page (to decide which section is actually openable), and it is
 * executed by `scripts/check-admin-nav-config.mjs` in plain Node. Keeping it
 * free of React is what lets the check script import it directly instead of
 * asserting on a copy of the rules — the script therefore proves the REAL
 * tree, not a paraphrase of it.
 *
 * WHY `anyOf` AND NOT `permission`.
 *
 * A section is not always guarded by a single right. The users section is
 * reachable by an approver, by a banner or by a role changer, and each of
 * those is a different right. A single `permission` key could only ever
 * express one of them, so the tab would have to be hidden from the two
 * admins who hold the other rights — and, worse, the section would stop
 * matching the page that actually renders it. `anyOf` means "ANY of these",
 * which is exactly the OR the old inline tab markup used.
 *
 * The permission keys are the real ones from `src/constants/permissions.js`:
 * there is no `PERMISSIONS.MANAGE_USERS` in this codebase, and a key that
 * does not exist is a key the server will refuse.
 *
 * @typedef {Object} AdminNavItem
 * @property {string} id          Stable identifier, also used as the React key.
 * @property {string} path        Value of the `?tab=` search parameter.
 * @property {string} title       i18n key of the label.
 * @property {string} icon        Name of the lucide-react icon.
 * @property {string[]} [anyOf]   Visible when the viewer holds ANY of these.
 *
 * @typedef {Object} AdminNavGroup
 * @property {string} id          Stable identifier of the group.
 * @property {string} title       i18n key of the group title.
 * @property {string} icon        Name of the lucide-react icon.
 * @property {AdminNavItem[]} children
 */

/** @type {AdminNavGroup[]} */
export const ADMIN_NAV_GROUPS = [
  {
    id: 'userManagement',
    title: 'admin.nav.userManagement',
    icon: 'Users',
    children: [
      {
        id: 'users',
        path: 'users',
        title: 'admin.tabs.users',
        icon: 'User',
        anyOf: [
          PERMISSIONS.APPROVE_USERS,
          PERMISSIONS.BAN_USERS,
          PERMISSIONS.CHANGE_ROLES,
        ],
      },
      {
        id: 'roles',
        path: 'roles',
        title: 'admin.tabs.roles',
        icon: 'Shield',
        anyOf: [PERMISSIONS.MANAGE_ROLES],
      },
    ],
  },
  {
    id: 'forumContent',
    title: 'admin.nav.forumContent',
    icon: 'Layers',
    children: [
      {
        id: 'categories',
        path: 'categories',
        title: 'admin.tabs.categories',
        icon: 'FolderTree',
        anyOf: [PERMISSIONS.MANAGE_CATEGORIES],
      },
      {
        id: 'designs',
        path: 'designs',
        title: 'admin.tabs.designs',
        icon: 'Palette',
        anyOf: [PERMISSIONS.MANAGE_DESIGNS],
      },
    ],
  },
  {
    id: 'systemConfig',
    title: 'admin.nav.systemConfig',
    icon: 'Settings',
    children: [
      {
        id: 'settings',
        path: 'settings',
        title: 'admin.tabs.settings',
        icon: 'Sliders',
        anyOf: [PERMISSIONS.MANAGE_FORUM],
      },
      {
        id: 'audit',
        path: 'audit',
        title: 'admin.tabs.audit',
        icon: 'FileText',
        anyOf: [PERMISSIONS.VIEW_AUDIT_LOG],
      },
    ],
  },
];

/**
 * Drop every section the viewer may not open, and every group that is left
 * without a section.
 *
 * A group whose children are all hidden is hidden too: an empty accordion
 * header that opens onto nothing is noise, and it leaks the existence of a
 * section the viewer is not allowed to reach.
 *
 * @param {AdminNavGroup[]} groups
 * @param {(permission: string) => boolean} hasPerm
 * @returns {AdminNavGroup[]}
 */
export const filterNavByPermissions = (groups, hasPerm) => {
  if (!Array.isArray(groups) || typeof hasPerm !== 'function') return [];

  return groups
    .map((group) => ({
      ...group,
      children: (group.children || []).filter((child) => {
        if (!child.anyOf || child.anyOf.length === 0) return true;
        return child.anyOf.some((permission) => hasPerm(permission));
      }),
    }))
    .filter((group) => group.children.length > 0);
};

/**
 * The id of the group that holds a given section, or null when the section
 * is not in the tree (unknown path, or hidden by the permission filter).
 *
 * @param {AdminNavGroup[]} groups
 * @param {string} path
 * @returns {string | null}
 */
export const findGroupForTab = (groups, path) => {
  for (const group of groups) {
    if ((group.children || []).some((child) => child.path === path)) {
      return group.id;
    }
  }
  return null;
};

/**
 * Every section path of a (already filtered) tree, in display order.
 *
 * The admin page uses this to answer "can the requested `?tab=` be opened at
 * all?" — a bookmarked or hand-typed `?tab=audit` must not leave the panel
 * blank for someone without the audit right.
 *
 * @param {AdminNavGroup[]} groups
 * @returns {string[]}
 */
export const collectVisibleTabPaths = (groups) =>
  (groups || []).flatMap((group) => (group.children || []).map((child) => child.path));
