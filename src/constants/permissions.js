export const PERMISSIONS = {
  // Admin & System
  ADMIN_ACCESS: 'admin_access',
  MANAGE_FORUM: 'manage_forum',
  MANAGE_DESIGNS: 'manage_designs',
  APPROVE_USERS: 'approve_users',
  BAN_USERS: 'ban_users',
  CHANGE_ROLES: 'change_roles',
  EDIT_OTHERS_NICKNAMES: 'edit_others_nicknames',
  EDIT_OTHERS_AVATARS: 'edit_others_avatars',
  EDIT_OTHERS_STATUSES: 'edit_others_statuses',
  EDIT_OTHERS_SIGNATURES: 'edit_others_signatures',
  EDIT_SELF_NICKNAME: 'edit_self_nickname',
  EDIT_SELF_AVATAR: 'edit_self_avatar',
  EDIT_SELF_STATUS: 'edit_self_status',
  EDIT_SELF_SIGNATURE: 'edit_self_signature',
  MANAGE_ROLES: 'manage_roles',
  MANAGE_CATEGORIES: 'manage_categories',
  DELETE_USERS: 'delete_users',
  VIEW_AUDIT_LOG: 'view_audit_log',
  
  // Content Moderation
  MODERATE_CONTENT: 'moderate_content',
  MOVE_TOPICS: 'move_topics',
  CLOSE_TOPICS: 'close_topics',
  PIN_TOPICS: 'pin_topics',
  
  // General Usage
  VIEW_FORUM: 'view_forum',
  POST_REPLY: 'post_reply',
  CREATE_TOPIC: 'create_topic',
  
  // Specific Features
  USE_REPUTATION: 'use_reputation',
  DELETE_REPUTATION: 'delete_reputation',
  USE_MASKS: 'use_masks',
  CREATE_SELF_MASK: 'create_self_mask',
  DELETE_SELF_MASK: 'delete_self_mask',
  CREATE_OTHERS_MASK: 'create_others_mask',
  EDIT_OTHERS_MASK: 'edit_others_mask',
  DELETE_OTHERS_MASK: 'delete_others_mask',
  USE_DICE: 'use_dice',
  VIEW_MASTER_DICE: 'view_master_dice',
  USE_DIRECT_MESSAGES: 'use_direct_messages',
  BYPASS_HIDE_TAGS: 'bypass_hide_tags'
};

export const CHIEF_ADMIN_ID = 'root';

export const PERMISSION_LABELS = {
  [PERMISSIONS.ADMIN_ACCESS]: { en: 'Admin Panel Access', ru: 'Доступ к админке' },
  [PERMISSIONS.MANAGE_FORUM]: { en: 'Manage Forum Settings', ru: 'Настройки форума' },
  [PERMISSIONS.MANAGE_DESIGNS]: { en: 'Manage Custom Designs', ru: 'Управление дизайнами' },
  [PERMISSIONS.APPROVE_USERS]: { en: 'Approve Users', ru: 'Одобрение пользователей' },
  [PERMISSIONS.BAN_USERS]: { en: 'Ban Users', ru: 'Блокировка пользователей' },
  [PERMISSIONS.CHANGE_ROLES]: { en: 'Change Roles', ru: 'Изменение ролей' },
  [PERMISSIONS.EDIT_OTHERS_NICKNAMES]: { en: "Edit Others' Nicknames", ru: 'Правка чужих никнеймов' },
  [PERMISSIONS.EDIT_OTHERS_AVATARS]: { en: "Edit Others' Avatars", ru: 'Правка чужих аватаров' },
  [PERMISSIONS.EDIT_OTHERS_STATUSES]: { en: "Edit Others' Statuses", ru: 'Правка чужих статусов' },
  [PERMISSIONS.EDIT_OTHERS_SIGNATURES]: { en: "Edit Others' Signatures", ru: 'Правка чужих подписей' },
  [PERMISSIONS.EDIT_SELF_NICKNAME]: { en: 'Edit Own Nickname', ru: 'Смена своего никнейма' },
  [PERMISSIONS.EDIT_SELF_AVATAR]: { en: 'Edit Own Avatar', ru: 'Смена своего аватара' },
  [PERMISSIONS.EDIT_SELF_STATUS]: { en: 'Edit Own Status', ru: 'Смена своего статуса' },
  [PERMISSIONS.EDIT_SELF_SIGNATURE]: { en: 'Edit Own Signature', ru: 'Смена своей подписи' },
  [PERMISSIONS.MANAGE_ROLES]: { en: 'Manage Roles', ru: 'Управление ролями' },
  [PERMISSIONS.MANAGE_CATEGORIES]: { en: 'Manage Categories', ru: 'Управление категориями' },
  [PERMISSIONS.DELETE_USERS]: { en: 'Delete Users', ru: 'Удаление пользователей' },
  [PERMISSIONS.VIEW_AUDIT_LOG]: { en: 'View Audit Log', ru: 'Просмотр журнала' },
  [PERMISSIONS.MODERATE_CONTENT]: { en: 'Moderate Content', ru: 'Модерация (правка/удаление)' },
  [PERMISSIONS.MOVE_TOPICS]: { en: 'Move Topics', ru: 'Перемещение тем' },
  [PERMISSIONS.CLOSE_TOPICS]: { en: 'Close/Open Topics', ru: 'Закрытие/Открытие тем' },
  [PERMISSIONS.PIN_TOPICS]: { en: 'Pin Topics', ru: 'Закрепление тем' },
  [PERMISSIONS.VIEW_FORUM]: { en: 'View Forum', ru: 'Просмотр форума' },
  [PERMISSIONS.POST_REPLY]: { en: 'Post Reply', ru: 'Отправка ответов' },
  [PERMISSIONS.CREATE_TOPIC]: { en: 'Create Topic', ru: 'Создание тем' },
  [PERMISSIONS.USE_REPUTATION]: { en: 'Use Reputation', ru: 'Использование репутации' },
  [PERMISSIONS.DELETE_REPUTATION]: { en: 'Delete Reputation Entries', ru: 'Удаление выставленной репутации' },
  [PERMISSIONS.USE_MASKS]: { en: 'Use Masks (Characters)', ru: 'Использование масок (персонажей)' },
  [PERMISSIONS.CREATE_SELF_MASK]: { en: 'Create Own Masks', ru: 'Создание своих масок' },
  [PERMISSIONS.DELETE_SELF_MASK]: { en: 'Delete Own Masks', ru: 'Удаление своих масок' },
  [PERMISSIONS.CREATE_OTHERS_MASK]: { en: 'Create Masks for Others', ru: 'Создание масок другим' },
  [PERMISSIONS.EDIT_OTHERS_MASK]: { en: "Edit Others' Masks", ru: 'Правка чужих масок' },
  [PERMISSIONS.DELETE_OTHERS_MASK]: { en: "Delete Others' Masks", ru: 'Удаление чужих масок' },
  [PERMISSIONS.USE_DICE]: { en: 'Use Dice', ru: 'Использование кубиков' },
  [PERMISSIONS.VIEW_MASTER_DICE]: { en: 'View Master Dice', ru: 'Видеть мастерские кубики' },
  [PERMISSIONS.USE_DIRECT_MESSAGES]: { en: 'Use Direct Messages', ru: 'Личные сообщения' },
  [PERMISSIONS.BYPASS_HIDE_TAGS]: { en: 'Bypass [hide] Tags', ru: 'Видеть скрытый контент ([hide])' },
  
  // Legacy mappings for backward compatibility with Firestore data
  'manage_settings': { en: 'Forum Settings', ru: 'Настройки форума' },
  'edit_profiles': { en: 'Edit Profiles', ru: 'Правка профилей' },
  'moderate_content': { en: 'Moderate Posts', ru: 'Модерация постов' }
};

export const PERMISSION_GROUPS = [
  {
    id: 'admin',
    name: { en: 'Administrative Permissions', ru: 'Административные права' },
    permissions: [
      PERMISSIONS.ADMIN_ACCESS,
      PERMISSIONS.MANAGE_FORUM,
      PERMISSIONS.MANAGE_DESIGNS,
      PERMISSIONS.APPROVE_USERS,
      PERMISSIONS.BAN_USERS,
      PERMISSIONS.DELETE_USERS,
      PERMISSIONS.CHANGE_ROLES,
      PERMISSIONS.MANAGE_ROLES,
      PERMISSIONS.MANAGE_CATEGORIES,
      PERMISSIONS.VIEW_AUDIT_LOG
    ]
  },
  {
    id: 'profile',
    name: { en: 'Profile Editing', ru: 'Редактирование профилей' },
    permissions: [
      PERMISSIONS.EDIT_OTHERS_NICKNAMES,
      PERMISSIONS.EDIT_OTHERS_AVATARS,
      PERMISSIONS.EDIT_OTHERS_STATUSES,
      PERMISSIONS.EDIT_OTHERS_SIGNATURES,
      PERMISSIONS.EDIT_SELF_NICKNAME,
      PERMISSIONS.EDIT_SELF_AVATAR,
      PERMISSIONS.EDIT_SELF_STATUS,
      PERMISSIONS.EDIT_SELF_SIGNATURE
    ]
  },
  {
    id: 'content',
    name: { en: 'Content Management', ru: 'Управление контентом' },
    permissions: [
      PERMISSIONS.MODERATE_CONTENT,
      PERMISSIONS.MOVE_TOPICS,
      PERMISSIONS.CLOSE_TOPICS,
      PERMISSIONS.PIN_TOPICS
    ]
  },
  {
    id: 'general',
    name: { en: 'General Permissions', ru: 'Общие права' },
    permissions: [
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC
    ]
  },
  {
    id: 'features',
    name: { en: 'Feature-Specific', ru: 'Специальные возможности' },
    permissions: [
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.DELETE_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.CREATE_SELF_MASK,
      PERMISSIONS.DELETE_SELF_MASK,
      PERMISSIONS.CREATE_OTHERS_MASK,
      PERMISSIONS.EDIT_OTHERS_MASK,
      PERMISSIONS.DELETE_OTHERS_MASK,
      PERMISSIONS.USE_DICE,
      PERMISSIONS.VIEW_MASTER_DICE,
      PERMISSIONS.USE_DIRECT_MESSAGES,
      PERMISSIONS.BYPASS_HIDE_TAGS
    ]
  }
];

export const normalizePermissions = (perms = []) => {
  const mapping = {
    'manage_settings': PERMISSIONS.MANAGE_FORUM,
    'edit_profiles': PERMISSIONS.EDIT_OTHERS_AVATARS,
    'edit_nicknames': PERMISSIONS.EDIT_OTHERS_NICKNAMES,
    'edit_avatars': PERMISSIONS.EDIT_OTHERS_AVATARS,
    'edit_statuses': PERMISSIONS.EDIT_OTHERS_STATUSES,
    'edit_signatures': PERMISSIONS.EDIT_OTHERS_SIGNATURES,
  };
  return [...new Set(perms.map(p => mapping[p] || p))];
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
      PERMISSIONS.MANAGE_FORUM,
      PERMISSIONS.MANAGE_DESIGNS,
      PERMISSIONS.APPROVE_USERS,
      PERMISSIONS.BAN_USERS,
      PERMISSIONS.CHANGE_ROLES,
      PERMISSIONS.EDIT_OTHERS_NICKNAMES,
      PERMISSIONS.EDIT_OTHERS_AVATARS,
      PERMISSIONS.EDIT_OTHERS_STATUSES,
      PERMISSIONS.EDIT_OTHERS_SIGNATURES,
      PERMISSIONS.EDIT_SELF_NICKNAME,
      PERMISSIONS.EDIT_SELF_AVATAR,
      PERMISSIONS.EDIT_SELF_STATUS,
      PERMISSIONS.EDIT_SELF_SIGNATURE,
      PERMISSIONS.MANAGE_ROLES,
      PERMISSIONS.MANAGE_CATEGORIES,
      PERMISSIONS.DELETE_USERS,
      PERMISSIONS.VIEW_AUDIT_LOG,
      PERMISSIONS.MODERATE_CONTENT,
      PERMISSIONS.MOVE_TOPICS,
      PERMISSIONS.CLOSE_TOPICS,
      PERMISSIONS.PIN_TOPICS,
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.DELETE_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.CREATE_SELF_MASK,
      PERMISSIONS.DELETE_SELF_MASK,
      PERMISSIONS.CREATE_OTHERS_MASK,
      PERMISSIONS.EDIT_OTHERS_MASK,
      PERMISSIONS.DELETE_OTHERS_MASK,
      PERMISSIONS.USE_DICE,
      PERMISSIONS.VIEW_MASTER_DICE,
      PERMISSIONS.USE_DIRECT_MESSAGES,
      PERMISSIONS.BYPASS_HIDE_TAGS
    ]
  },
  {
    id: 'moderator',
    name: 'Moderator',
    color: 'info',
    is_system: true,
    permissions: [
      PERMISSIONS.VIEW_AUDIT_LOG,
      PERMISSIONS.MODERATE_CONTENT,
      PERMISSIONS.MOVE_TOPICS,
      PERMISSIONS.CLOSE_TOPICS,
      PERMISSIONS.PIN_TOPICS,
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.CREATE_SELF_MASK,
      PERMISSIONS.DELETE_SELF_MASK,
      PERMISSIONS.CREATE_OTHERS_MASK,
      PERMISSIONS.EDIT_OTHERS_MASK,
      PERMISSIONS.DELETE_OTHERS_MASK,
      PERMISSIONS.USE_DICE,
      PERMISSIONS.VIEW_MASTER_DICE,
      PERMISSIONS.EDIT_SELF_NICKNAME,
      PERMISSIONS.EDIT_SELF_AVATAR,
      PERMISSIONS.EDIT_SELF_STATUS,
      PERMISSIONS.EDIT_SELF_SIGNATURE,
      PERMISSIONS.BYPASS_HIDE_TAGS
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
      PERMISSIONS.CREATE_SELF_MASK,
      PERMISSIONS.DELETE_SELF_MASK,
      PERMISSIONS.USE_DICE,
      PERMISSIONS.VIEW_MASTER_DICE,
      PERMISSIONS.USE_DIRECT_MESSAGES,
      PERMISSIONS.EDIT_SELF_NICKNAME,
      PERMISSIONS.EDIT_SELF_AVATAR,
      PERMISSIONS.EDIT_SELF_STATUS,
      PERMISSIONS.EDIT_SELF_SIGNATURE
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
  },
  {
    id: 'guest',
    name: 'Guest',
    color: 'light',
    is_system: true,
    permissions: []
    // Guests have no global permissions. Access to specific categories is granted
    // Guests have no global permissions. Access to specific categories is granted
    // via category-level VIEW_FORUM overrides that include the 'guest' role.
  }
];

export const MAX_ROLE_PERMISSIONS = {
  guest: [
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.POST_REPLY,
    PERMISSIONS.USE_DICE
  ],
  banned: [],
  pending: [
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.EDIT_SELF_NICKNAME,
    PERMISSIONS.EDIT_SELF_AVATAR,
    PERMISSIONS.EDIT_SELF_STATUS, // Optional but safe
    PERMISSIONS.EDIT_SELF_SIGNATURE
  ],
  spectator: [
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.POST_REPLY,
    PERMISSIONS.CREATE_TOPIC,
    PERMISSIONS.USE_DICE,
    PERMISSIONS.USE_MASKS,
    PERMISSIONS.USE_REPUTATION,
    PERMISSIONS.USE_DIRECT_MESSAGES,
    PERMISSIONS.EDIT_SELF_NICKNAME,
    PERMISSIONS.EDIT_SELF_AVATAR,
    PERMISSIONS.EDIT_SELF_STATUS,
    PERMISSIONS.EDIT_SELF_SIGNATURE
  ],
  player: [
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.POST_REPLY,
    PERMISSIONS.CREATE_TOPIC,
    PERMISSIONS.USE_DICE,
    PERMISSIONS.VIEW_MASTER_DICE,
    PERMISSIONS.USE_MASKS,
    PERMISSIONS.CREATE_SELF_MASK,
    PERMISSIONS.DELETE_SELF_MASK,
    PERMISSIONS.USE_REPUTATION,
    PERMISSIONS.USE_DIRECT_MESSAGES,
    PERMISSIONS.EDIT_SELF_NICKNAME,
    PERMISSIONS.EDIT_SELF_AVATAR,
    PERMISSIONS.EDIT_SELF_STATUS,
    PERMISSIONS.EDIT_SELF_SIGNATURE
  ],
  moderator: [
    PERMISSIONS.ADMIN_ACCESS,
    PERMISSIONS.VIEW_AUDIT_LOG,
    PERMISSIONS.APPROVE_USERS,
    PERMISSIONS.BAN_USERS,
    PERMISSIONS.MODERATE_CONTENT,
    PERMISSIONS.MOVE_TOPICS,
    PERMISSIONS.CLOSE_TOPICS,
    PERMISSIONS.PIN_TOPICS,
    PERMISSIONS.EDIT_OTHERS_NICKNAMES,
    PERMISSIONS.EDIT_OTHERS_AVATARS,
    PERMISSIONS.EDIT_OTHERS_STATUSES,
    PERMISSIONS.EDIT_OTHERS_SIGNATURES,
    PERMISSIONS.DELETE_REPUTATION,
    PERMISSIONS.EDIT_OTHERS_MASK,
    PERMISSIONS.CREATE_OTHERS_MASK,
    PERMISSIONS.DELETE_OTHERS_MASK,
    PERMISSIONS.EDIT_SELF_NICKNAME,
    PERMISSIONS.EDIT_SELF_AVATAR,
    PERMISSIONS.EDIT_SELF_STATUS,
    PERMISSIONS.EDIT_SELF_SIGNATURE,
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.POST_REPLY,
    PERMISSIONS.CREATE_TOPIC,
    PERMISSIONS.USE_DICE,
    PERMISSIONS.VIEW_MASTER_DICE,
    PERMISSIONS.USE_MASKS,
    PERMISSIONS.CREATE_SELF_MASK,
    PERMISSIONS.DELETE_SELF_MASK,
    PERMISSIONS.USE_REPUTATION,
    PERMISSIONS.USE_DIRECT_MESSAGES,
    PERMISSIONS.BYPASS_HIDE_TAGS
  ],
  admin: Object.values(PERMISSIONS)
};

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

