import { PERMISSIONS } from '../constants/permissions.js';

export const ADMIN_NAV_GROUPS = [
  {
    id: 'userAndAccess',
    title: 'admin.nav.userAndAccess',
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
          PERMISSIONS.CHANGE_ROLES
        ]
      },
      {
        id: 'roles',
        path: 'roles',
        title: 'admin.tabs.roles',
        icon: 'Shield',
        anyOf: [PERMISSIONS.MANAGE_ROLES]
      }
    ]
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
        anyOf: [PERMISSIONS.MANAGE_CATEGORIES]
      },
      {
        id: 'designs-defaults',
        path: 'designs-defaults',
        title: 'admin.tabs.designs_defaults',
        icon: 'Sliders',
        anyOf: [PERMISSIONS.MANAGE_DESIGNS]
      },
      {
        id: 'designs-custom',
        path: 'designs-custom',
        title: 'admin.tabs.designs_custom',
        icon: 'Palette',
        anyOf: [PERMISSIONS.MANAGE_DESIGNS]
      },
      {
        id: 'designs-builtin',
        path: 'designs-builtin',
        title: 'admin.tabs.designs_builtin',
        icon: 'Layers',
        anyOf: [PERMISSIONS.MANAGE_DESIGNS]
      }
    ]
  },
  {
    id: 'system',
    title: 'admin.nav.system',
    icon: 'Settings',
    children: [
      {
        id: 'settings',
        path: 'settings',
        title: 'admin.tabs.settings',
        icon: 'Sliders',
        anyOf: [PERMISSIONS.MANAGE_FORUM],
        subSections: [
          { id: 'general', title: 'admin.settings.sections.general' },
          { id: 'limits', title: 'admin.settings.sections.limits' },
          { id: 'features', title: 'admin.settings.sections.features' },
          { id: 'identity', title: 'admin.settings.sections.identity' },
          { id: 'email', title: 'admin.settings.sections.email' }
        ]
      },
      {
        id: 'visits',
        path: 'visits',
        title: 'admin.tabs.visits',
        icon: 'BarChart3',
        anyOf: [PERMISSIONS.VIEW_VISITS_DASHBOARD]
      },
      {
        id: 'audit',
        path: 'audit',
        title: 'admin.tabs.audit',
        icon: 'FileText',
        anyOf: [PERMISSIONS.VIEW_AUDIT_LOG]
      }
    ]
  }
];

/**
 * Checks whether the current user has permission to view a nav item.
 * @param {object} item
 * @param {Function} hasPermission
 * @returns {boolean}
 */
export const canAccessNavItem = (item, hasPermission) => {
  if (!item) return false;
  if (!item.anyOf || item.anyOf.length === 0) return true;
  if (typeof hasPermission !== 'function') return false;
  return item.anyOf.some((perm) => hasPermission(perm));
};

/**
 * Returns groups filtered to only items the user can access.
 * Empty groups are excluded.
 * @param {Function} hasPermission
 * @returns {Array}
 */
export const getFilteredNavGroups = (hasPermission) => {
  return ADMIN_NAV_GROUPS.map((group) => {
    const visibleChildren = group.children.filter((child) =>
      canAccessNavItem(child, hasPermission)
    );
    return {
      ...group,
      children: visibleChildren
    };
  }).filter((group) => group.children.length > 0);
};

/**
 * Finds the first tab id accessible by the user.
 * @param {Function} hasPermission
 * @returns {string|null}
 */
export const findFirstAccessibleTab = (hasPermission) => {
  for (const group of ADMIN_NAV_GROUPS) {
    for (const child of group.children) {
      if (canAccessNavItem(child, hasPermission)) {
        return child.id;
      }
    }
  }
  return null;
};

/**
 * Finds a navigation item definition by tab id.
 * @param {string} tabId
 * @returns {object|null}
 */
export const findTabById = (tabId) => {
  for (const group of ADMIN_NAV_GROUPS) {
    const item = group.children.find((c) => c.id === tabId);
    if (item) return item;
  }
  return null;
};

