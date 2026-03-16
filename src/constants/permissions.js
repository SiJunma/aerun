export const PERMISSIONS = {
  // Admin & System
  ADMIN_ACCESS: 'admin_access',
  MANAGE_SETTINGS: 'manage_settings',
  APPROVE_USERS: 'approve_users',
  BAN_USERS: 'ban_users',
  CHANGE_ROLES: 'change_roles',
  EDIT_NICKNAMES: 'edit_nicknames',
  MANAGE_ROLES: 'manage_roles',
  MANAGE_CATEGORIES: 'manage_categories',
  
  // Content Moderation
  MODERATE_CONTENT: 'moderate_content',
  
  // General Usage
  VIEW_FORUM: 'view_forum',
  POST_REPLY: 'post_reply',
  CREATE_TOPIC: 'create_topic',
  
  // Specific Features
  USE_REPUTATION: 'use_reputation',
  USE_MASKS: 'use_masks',
  USE_DICE: 'use_dice'
};

export const CHIEF_ADMIN_ID = 'root';

export const PERMISSION_LABELS = {
  [PERMISSIONS.ADMIN_ACCESS]: { en: 'Admin Panel Access', ru: 'Доступ к админке' },
  [PERMISSIONS.MANAGE_SETTINGS]: { en: 'Manage Settings', ru: 'Управление настройками' },
  [PERMISSIONS.APPROVE_USERS]: { en: 'Approve Users', ru: 'Одобрение пользователей' },
  [PERMISSIONS.BAN_USERS]: { en: 'Ban Users', ru: 'Блокировка пользователей' },
  [PERMISSIONS.CHANGE_ROLES]: { en: 'Change Roles', ru: 'Изменение ролей' },
  [PERMISSIONS.EDIT_NICKNAMES]: { en: 'Edit Nicknames', ru: 'Изменение никнеймов' },
  [PERMISSIONS.MANAGE_ROLES]: { en: 'Manage Roles', ru: 'Управление ролями' },
  [PERMISSIONS.MANAGE_CATEGORIES]: { en: 'Manage Categories', ru: 'Управление категориями' },
  [PERMISSIONS.MODERATE_CONTENT]: { en: 'Moderate Content', ru: 'Модерация (правка/удаление)' },
  [PERMISSIONS.VIEW_FORUM]: { en: 'View Forum', ru: 'Просмотр форума' },
  [PERMISSIONS.POST_REPLY]: { en: 'Post Reply', ru: 'Отправка ответов' },
  [PERMISSIONS.CREATE_TOPIC]: { en: 'Create Topic', ru: 'Создание тем' },
  [PERMISSIONS.USE_REPUTATION]: { en: 'Use Reputation', ru: 'Использование репутации' },
  [PERMISSIONS.USE_MASKS]: { en: 'Use Masks (Characters)', ru: 'Использование масок (персонажей)' },
  [PERMISSIONS.USE_DICE]: { en: 'Use Dice', ru: 'Использование кубиков' }
};

export const getChiefAdminPermissions = () => Object.values(PERMISSIONS);

export const DEFAULT_ROLES = [
  {
    id: 'admin',
    name: 'Administrator',
    color: 'danger',
    is_system: true,
    permissions: [
      PERMISSIONS.ADMIN_ACCESS,
      PERMISSIONS.MANAGE_SETTINGS,
      PERMISSIONS.APPROVE_USERS,
      PERMISSIONS.BAN_USERS,
      PERMISSIONS.CHANGE_ROLES,
      PERMISSIONS.EDIT_NICKNAMES,
      PERMISSIONS.MANAGE_ROLES,
      PERMISSIONS.MANAGE_CATEGORIES,
      PERMISSIONS.MODERATE_CONTENT,
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.USE_DICE
    ]
  },
  {
    id: 'moderator',
    name: 'Moderator',
    color: 'info',
    is_system: true,
    permissions: [
      PERMISSIONS.MODERATE_CONTENT,
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.USE_DICE
    ]
  },
  {
    id: 'player',
    name: 'Player',
    color: 'primary',
    is_system: true,
    permissions: [
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.USE_DICE
    ]
  },
  {
    id: 'spectator',
    name: 'Spectator',
    color: 'secondary',
    is_system: true,
    permissions: [
      PERMISSIONS.VIEW_FORUM
    ]
  }
];

export const resolveUserRoleId = (userEmail, roleId) => {
  if (userEmail === import.meta.env.VITE_ADMIN_EMAIL) return CHIEF_ADMIN_ID;
  if (roleId === CHIEF_ADMIN_ID) return CHIEF_ADMIN_ID;
  return roleId || 'player';
};

export const isChiefAdmin = (userEmail, roleId) => {
  return userEmail === import.meta.env.VITE_ADMIN_EMAIL || roleId === CHIEF_ADMIN_ID;
};

export const getRoleVisuals = (roleId, roles = []) => {
  const targetId = roleId === CHIEF_ADMIN_ID ? 'admin' : roleId;
  const role = roles.find(r => r.id === targetId) || DEFAULT_ROLES.find(r => r.id === targetId) || DEFAULT_ROLES.find(r => r.id === 'player');
  
  const color = role?.color || 'primary';
  return {
    name: role?.name || 'Player',
    color: color,
    isLight: ['warning', 'light'].includes(color)
  };
};
export { subscribeToRoles } from '../api/admin';
