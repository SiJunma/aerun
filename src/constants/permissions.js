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
  // The BIOGRAPHICAL block — bio, location, birthday, occupation, interests,
  // contacts. Separate from edit_self/others_statuses, which name the one-line
  // status under a nickname. edit_others_profile is admin-only by default:
  // moderators edit content, these are personal facts.
  EDIT_SELF_PROFILE: 'edit_self_profile',
  EDIT_OTHERS_PROFILE: 'edit_others_profile',
  MANAGE_ROLES: 'manage_roles',
  MANAGE_CATEGORIES: 'manage_categories',
  DELETE_USERS: 'delete_users',
  VIEW_AUDIT_LOG: 'view_audit_log',

  // Content Moderation
  MOVE_TOPICS: 'move_topics',
  CLOSE_TOPICS: 'close_topics',
  PIN_TOPICS: 'pin_topics',

  // Post and topic moderation, split by subject and by ownership (2026-10-02).
  EDIT_SELF_POST: 'edit_self_post',
  EDIT_OTHERS_POSTS: 'edit_others_posts',
  DELETE_SELF_POST: 'delete_self_post',
  DELETE_OTHERS_POSTS: 'delete_others_posts',
  EDIT_SELF_TOPIC: 'edit_self_topic',
  EDIT_OTHERS_TOPICS: 'edit_others_topics',
  DELETE_SELF_TOPIC: 'delete_self_topic',
  DELETE_OTHERS_TOPICS: 'delete_others_topics',
  // The MyBB-shaped right: delete your own topic AND every post under it,
  // including other people's replies. Granted to no built-in role on purpose —
  // it is handed out per custom role. Removing a topic that holds nothing but
  // your own opening post needs no permission at all.
  DELETE_OWN_TOPIC_WITH_REPLIES: 'delete_own_topic_with_replies',

  // General Usage
  VIEW_FORUM: 'view_forum',
  POST_REPLY: 'post_reply',
  CREATE_TOPIC: 'create_topic',

  // Specific Features
  USE_REPUTATION: 'use_reputation',
  // Reputation actions are split by action (edit/delete) and by subject (your
  // own entry vs somebody else's). `_self_` is the AUTHOR of the entry, not the
  // profile it sits on: "edit my own reputation comment" is the comment you
  // wrote on somebody else's profile.
  EDIT_SELF_REPUTATION: 'edit_self_reputation',
  DELETE_SELF_REPUTATION: 'delete_self_reputation',
  EDIT_OTHERS_REPUTATION: 'edit_others_reputation',
  DELETE_OTHERS_REPUTATION: 'delete_others_reputation',
  USE_MASKS: 'use_masks',
  CREATE_SELF_MASK: 'create_self_mask',
  DELETE_SELF_MASK: 'delete_self_mask',
  CREATE_OTHERS_MASK: 'create_others_mask',
  EDIT_OTHERS_MASK: 'edit_others_mask',
  DELETE_OTHERS_MASK: 'delete_others_mask',
  USE_DICE: 'use_dice',
  VIEW_MASTER_DICE: 'view_master_dice',
  USE_DIRECT_MESSAGES: 'use_direct_messages',
  BYPASS_HIDE_TAGS: 'bypass_hide_tags',
  MENTION_ALL: 'mention_all'
};

export const CHIEF_ADMIN_ID = 'root';

// The admin role id. Kept beside CHIEF_ADMIN_ID because the two are the ends
// of the role-change authority line: `checkRoleChange` on the server lets an
// admin act on strictly lower accounts and lets only the chief admin appoint
// another administrator, so the client needs both ids to mirror that rule.
export const ADMIN_ROLE_ID = 'admin';

// The compiled authority ranks of the system roles, mirroring
// backend/internal/auth/role.go.
//
// WHY THEY ARE HERE AND NOT ONLY IN THE REGISTRY. The server resolves a
// system's rank from the COMPILED matrix first and only falls back to the
// `roles` row for a custom role (rankFor in nickname_commands.go). A client
// that read the registry alone would therefore disagree with the server for
// exactly the roles it compares most often — admin against admin.
//
// The numbers are the ones the server uses: root 1000, admin 800,
// moderator 600, player 400, spectator 300, guest 200.
export const SYSTEM_ROLE_RANKS = {
  root: 1000,
  admin: 800,
  moderator: 600,
  player: 400,
  spectator: 300,
  guest: 200,
};

// rankOfRole answers the authority rank of a role id the way the server does.
//
// System roles come from the compiled matrix above; a CUSTOM role is ranked by
// its own registry row, and the public `GET /roles` publishes that `rank`.
//
// `null` means "unknown" — a custom role whose registry row has not loaded
// (or carries no rank). It is deliberately NOT zero: an unknown rank must not
// read as "below everybody", because the one thing the caller does with this
// answer is decide whether a LOWER-ranked account may be edited, and an
// unknown rank may well be above.
export const rankOfRole = (roleId, roles = []) => {
  if (!roleId) return null;
  if (SYSTEM_ROLE_RANKS[roleId] !== undefined) return SYSTEM_ROLE_RANKS[roleId];
  const row = (roles || []).find((r) => r.id === roleId);
  return typeof row?.rank === 'number' ? row.rank : null;
};

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
  [PERMISSIONS.EDIT_SELF_PROFILE]: { en: 'Edit Own Profile Fields', ru: 'Смена своих данных профиля' },
  [PERMISSIONS.EDIT_OTHERS_PROFILE]: { en: "Edit Others' Profile Fields", ru: 'Правка чужих данных профиля' },
  [PERMISSIONS.MANAGE_ROLES]: { en: 'Manage Roles', ru: 'Управление ролями' },
  [PERMISSIONS.MANAGE_CATEGORIES]: { en: 'Manage Categories', ru: 'Управление категориями' },
  [PERMISSIONS.DELETE_USERS]: { en: 'Delete Users', ru: 'Удаление пользователей' },
  [PERMISSIONS.VIEW_AUDIT_LOG]: { en: 'View Audit Log', ru: 'Просмотр журнала' },
  [PERMISSIONS.MOVE_TOPICS]: { en: 'Move Topics', ru: 'Перемещение тем' },
  [PERMISSIONS.CLOSE_TOPICS]: { en: 'Close/Open Topics', ru: 'Закрытие/Открытие тем' },
  [PERMISSIONS.PIN_TOPICS]: { en: 'Pin Topics', ru: 'Закрепление тем' },
  [PERMISSIONS.EDIT_SELF_POST]: { en: 'Edit Own Post', ru: 'Правка своего поста' },
  [PERMISSIONS.EDIT_OTHERS_POSTS]: { en: "Edit Others' Posts", ru: 'Правка чужих постов' },
  [PERMISSIONS.DELETE_SELF_POST]: { en: 'Delete Own Post', ru: 'Удаление своего поста' },
  [PERMISSIONS.DELETE_OTHERS_POSTS]: { en: "Delete Others' Posts", ru: 'Удаление чужих постов' },
  [PERMISSIONS.EDIT_SELF_TOPIC]: { en: 'Edit Own Topic', ru: 'Правка своей темы' },
  [PERMISSIONS.EDIT_OTHERS_TOPICS]: { en: "Edit Others' Topics", ru: 'Правка чужих тем' },
  [PERMISSIONS.DELETE_SELF_TOPIC]: { en: 'Delete Own Topic', ru: 'Удаление своей темы' },
  [PERMISSIONS.DELETE_OTHERS_TOPICS]: { en: "Delete Others' Topics", ru: 'Удаление чужих тем' },
  [PERMISSIONS.DELETE_OWN_TOPIC_WITH_REPLIES]: {
    en: 'Delete Own Topic With Replies',
    ru: 'Удаление своей темы вместе с ответами',
  },
  [PERMISSIONS.VIEW_FORUM]: { en: 'View Forum', ru: 'Просмотр форума' },
  [PERMISSIONS.POST_REPLY]: { en: 'Post Reply', ru: 'Отправка ответов' },
  [PERMISSIONS.CREATE_TOPIC]: { en: 'Create Topic', ru: 'Создание тем' },
  [PERMISSIONS.USE_REPUTATION]: { en: 'Use Reputation', ru: 'Использование репутации' },
  [PERMISSIONS.EDIT_SELF_REPUTATION]: {
    en: 'Edit Own Reputation Comments',
    ru: 'Редактирование своих комментариев репутации',
  },
  [PERMISSIONS.DELETE_SELF_REPUTATION]: {
    en: 'Delete Own Reputation Comments',
    ru: 'Удаление своих комментариев репутации',
  },
  [PERMISSIONS.EDIT_OTHERS_REPUTATION]: {
    en: "Edit Others' Reputation Comments",
    ru: 'Редактирование чужих комментариев репутации',
  },
  [PERMISSIONS.DELETE_OTHERS_REPUTATION]: {
    en: "Delete Others' Reputation Comments",
    ru: 'Удаление чужих комментариев репутации',
  },
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
  [PERMISSIONS.MENTION_ALL]: { en: 'Broadcast @All Mentions', ru: 'Уведомление всех (@All)' },

  // Legacy mappings for backward compatibility with Firestore data
  'manage_settings': { en: 'Forum Settings', ru: 'Настройки форума' },
  'edit_profiles': { en: 'Edit Profiles', ru: 'Правка профилей' },
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
      // Bio, location, birthday, occupation, interests, contacts. Moderators
      // edit content; these are personal facts, so `_others_` is admin-only.
      PERMISSIONS.EDIT_OTHERS_PROFILE,
      PERMISSIONS.EDIT_SELF_NICKNAME,
      PERMISSIONS.EDIT_SELF_AVATAR,
      PERMISSIONS.EDIT_SELF_STATUS,
      PERMISSIONS.EDIT_SELF_SIGNATURE,
      PERMISSIONS.EDIT_SELF_PROFILE
    ]
  },
  {
    id: 'content',
    name: { en: 'Content Management', ru: 'Управление контентом' },
    permissions: [
      PERMISSIONS.MOVE_TOPICS,
      PERMISSIONS.CLOSE_TOPICS,
      PERMISSIONS.PIN_TOPICS,
      PERMISSIONS.EDIT_SELF_POST,
      PERMISSIONS.EDIT_OTHERS_POSTS,
      PERMISSIONS.DELETE_SELF_POST,
      PERMISSIONS.DELETE_OTHERS_POSTS,
      PERMISSIONS.EDIT_SELF_TOPIC,
      PERMISSIONS.EDIT_OTHERS_TOPICS,
      PERMISSIONS.DELETE_SELF_TOPIC,
      PERMISSIONS.DELETE_OTHERS_TOPICS,
      PERMISSIONS.DELETE_OWN_TOPIC_WITH_REPLIES
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
      // Reputation actions in the order a reader meets them: my own entry
      // first, then somebody else's. The `_self_` pair is what an ordinary
      // member holds; the `_others_` pair is staff.
      PERMISSIONS.EDIT_SELF_REPUTATION,
      PERMISSIONS.DELETE_SELF_REPUTATION,
      PERMISSIONS.EDIT_OTHERS_REPUTATION,
      PERMISSIONS.DELETE_OTHERS_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.CREATE_SELF_MASK,
      PERMISSIONS.DELETE_SELF_MASK,
      PERMISSIONS.CREATE_OTHERS_MASK,
      PERMISSIONS.EDIT_OTHERS_MASK,
      PERMISSIONS.DELETE_OTHERS_MASK,
      PERMISSIONS.USE_DICE,
      PERMISSIONS.VIEW_MASTER_DICE,
      PERMISSIONS.USE_DIRECT_MESSAGES,
      PERMISSIONS.BYPASS_HIDE_TAGS,
      // Broadcast @All — grantable from player upward; default off for everyone
      // except admin/root (who hold AllPermissions). See Part 9 of the plan.
      PERMISSIONS.MENTION_ALL
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
      PERMISSIONS.MOVE_TOPICS,
      PERMISSIONS.CLOSE_TOPICS,
      PERMISSIONS.PIN_TOPICS,
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.EDIT_SELF_REPUTATION,
      PERMISSIONS.DELETE_SELF_REPUTATION,
      PERMISSIONS.EDIT_OTHERS_REPUTATION,
      PERMISSIONS.DELETE_OTHERS_REPUTATION,
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
      PERMISSIONS.MOVE_TOPICS,
      PERMISSIONS.CLOSE_TOPICS,
      PERMISSIONS.PIN_TOPICS,
      PERMISSIONS.EDIT_OTHERS_POSTS,
      PERMISSIONS.DELETE_OTHERS_POSTS,
      PERMISSIONS.EDIT_OTHERS_TOPICS,
      PERMISSIONS.DELETE_OTHERS_TOPICS,
      PERMISSIONS.EDIT_SELF_POST,
      PERMISSIONS.DELETE_SELF_POST,
      PERMISSIONS.EDIT_SELF_TOPIC,
      PERMISSIONS.DELETE_SELF_TOPIC,
      PERMISSIONS.VIEW_FORUM,
      PERMISSIONS.POST_REPLY,
      PERMISSIONS.CREATE_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.EDIT_SELF_REPUTATION,
      PERMISSIONS.DELETE_SELF_REPUTATION,
      PERMISSIONS.DELETE_OTHERS_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.CREATE_SELF_MASK,
      PERMISSIONS.DELETE_SELF_MASK,
      PERMISSIONS.CREATE_OTHERS_MASK,
      PERMISSIONS.EDIT_OTHERS_MASK,
      PERMISSIONS.DELETE_OTHERS_MASK,
      PERMISSIONS.USE_DICE,
      PERMISSIONS.VIEW_MASTER_DICE,
      PERMISSIONS.USE_DIRECT_MESSAGES,
      PERMISSIONS.EDIT_SELF_NICKNAME,
      PERMISSIONS.EDIT_SELF_AVATAR,
      PERMISSIONS.EDIT_SELF_STATUS,
      PERMISSIONS.EDIT_SELF_PROFILE,
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
      PERMISSIONS.EDIT_SELF_POST,
      PERMISSIONS.DELETE_SELF_POST,
      PERMISSIONS.EDIT_SELF_TOPIC,
      PERMISSIONS.DELETE_SELF_TOPIC,
      PERMISSIONS.USE_REPUTATION,
      PERMISSIONS.EDIT_SELF_REPUTATION,
      PERMISSIONS.DELETE_SELF_REPUTATION,
      PERMISSIONS.USE_MASKS,
      PERMISSIONS.CREATE_SELF_MASK,
      PERMISSIONS.DELETE_SELF_MASK,
      PERMISSIONS.USE_DICE,
      PERMISSIONS.USE_DIRECT_MESSAGES,
      PERMISSIONS.EDIT_SELF_NICKNAME,
      PERMISSIONS.EDIT_SELF_AVATAR,
      PERMISSIONS.EDIT_SELF_STATUS,
      PERMISSIONS.EDIT_SELF_PROFILE,
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
    PERMISSIONS.EDIT_SELF_SIGNATURE,
    // Mirrors pendingAllowedPermissions in backend/internal/auth/status.go:
    // PATCH /me/profile gates the WHOLE bio block on this one key, so without
    // it the client ceiling and the server allowlist disagree and every
    // pending save 403s.
    PERMISSIONS.EDIT_SELF_PROFILE
  ],
  // A spectator is a viewer. `create_topic` and `post_reply` are gone so the
  // system role means exactly what its name says, and masks and dice went with
  // them: a role that can watch but not speak has no business carrying the
  // authoring features.
  //
  // `use_reputation` and `use_direct_messages` are deliberately LEFT in — they
  // are receiving capabilities, not authoring ones, and removing them was not
  // part of the ask. Say the word if a spectator should be fully inert.
  spectator: [
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.USE_REPUTATION,
    PERMISSIONS.USE_DIRECT_MESSAGES,
    PERMISSIONS.EDIT_SELF_NICKNAME,
    PERMISSIONS.EDIT_SELF_AVATAR,
    PERMISSIONS.EDIT_SELF_STATUS,
    PERMISSIONS.EDIT_SELF_SIGNATURE
  ],
  // A master roll is the GM's private number. It is NOT offered to a player at
  // all: a checkbox an ordinary member can tick is a checkbox an ordinary
  // member will tick, and the withholding this key drives stops being a
  // decision. Moderator and above keep it.
  //
  // The `_self_` content keys ARE offered — editing or deleting your own post
  // or topic is ordinary authorship hygiene, and the server still compares the
  // author on every one of them. `delete_own_topic_with_replies` is listed so
  // an admin can grant it explicitly; it is not part of the player's own
  // default set (see internal/auth/role.go), because it takes other people's
  // replies with it.
  player: [
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.POST_REPLY,
    PERMISSIONS.CREATE_TOPIC,
    PERMISSIONS.EDIT_SELF_POST,
    PERMISSIONS.DELETE_SELF_POST,
    PERMISSIONS.EDIT_SELF_TOPIC,
    PERMISSIONS.DELETE_SELF_TOPIC,
    PERMISSIONS.DELETE_OWN_TOPIC_WITH_REPLIES,
    PERMISSIONS.USE_DICE,
    PERMISSIONS.USE_MASKS,
    PERMISSIONS.CREATE_SELF_MASK,
    PERMISSIONS.DELETE_SELF_MASK,
    PERMISSIONS.USE_REPUTATION,
    PERMISSIONS.EDIT_SELF_REPUTATION,
    PERMISSIONS.DELETE_SELF_REPUTATION,
    PERMISSIONS.USE_DIRECT_MESSAGES,
    PERMISSIONS.EDIT_SELF_NICKNAME,
    PERMISSIONS.EDIT_SELF_AVATAR,
    PERMISSIONS.EDIT_SELF_STATUS,
    PERMISSIONS.EDIT_SELF_PROFILE,
    PERMISSIONS.EDIT_SELF_SIGNATURE,
    // @All broadcast mention — ceiling for player upward (Part 9 owner ruling).
    // Not in the player's DEFAULT set; must be granted explicitly in the role editor.
    PERMISSIONS.MENTION_ALL
  ],
  moderator: [
    PERMISSIONS.ADMIN_ACCESS,
    PERMISSIONS.VIEW_AUDIT_LOG,
    PERMISSIONS.APPROVE_USERS,
    PERMISSIONS.BAN_USERS,
    PERMISSIONS.MOVE_TOPICS,
    PERMISSIONS.CLOSE_TOPICS,
    PERMISSIONS.PIN_TOPICS,
    PERMISSIONS.EDIT_OTHERS_NICKNAMES,
    PERMISSIONS.EDIT_OTHERS_AVATARS,
    PERMISSIONS.EDIT_OTHERS_STATUSES,
    PERMISSIONS.EDIT_OTHERS_SIGNATURES,
    PERMISSIONS.DELETE_OTHERS_REPUTATION,
    PERMISSIONS.EDIT_OTHERS_REPUTATION,
    PERMISSIONS.EDIT_OTHERS_MASK,
    PERMISSIONS.CREATE_OTHERS_MASK,
    PERMISSIONS.DELETE_OTHERS_MASK,
    PERMISSIONS.EDIT_SELF_NICKNAME,
    PERMISSIONS.EDIT_SELF_AVATAR,
    PERMISSIONS.EDIT_SELF_STATUS,
    PERMISSIONS.EDIT_SELF_PROFILE,
    PERMISSIONS.EDIT_SELF_SIGNATURE,
    PERMISSIONS.VIEW_FORUM,
    PERMISSIONS.POST_REPLY,
    PERMISSIONS.CREATE_TOPIC,
    PERMISSIONS.EDIT_SELF_POST,
    PERMISSIONS.DELETE_SELF_POST,
    PERMISSIONS.EDIT_SELF_TOPIC,
    PERMISSIONS.DELETE_SELF_TOPIC,
    PERMISSIONS.DELETE_OWN_TOPIC_WITH_REPLIES,
    PERMISSIONS.USE_DICE,
    PERMISSIONS.VIEW_MASTER_DICE,
    PERMISSIONS.USE_MASKS,
    PERMISSIONS.CREATE_SELF_MASK,
    PERMISSIONS.DELETE_SELF_MASK,
    PERMISSIONS.USE_REPUTATION,
    PERMISSIONS.EDIT_SELF_REPUTATION,
    PERMISSIONS.DELETE_SELF_REPUTATION,
    PERMISSIONS.USE_DIRECT_MESSAGES,
    PERMISSIONS.BYPASS_HIDE_TAGS,
    PERMISSIONS.MENTION_ALL
  ],
  admin: Object.values(PERMISSIONS)
};

export const resolveUserRoleId = (userEmail, roleId) => {
  // The ROLE decides. The email is a fallback for the case where the role is
  // not known at all (an old DTO, a row read before the role column was
  // populated) — NOT a way to override a role that IS known.
  //
  // WHY THE ORDER MATTERS. The chief-admin role is TRANSFERABLE: the server
  // hands it over one-way (root_transfer.go), and the giver becomes an
  // ordinary admin. If the email could outrank the role, the giver would keep
  // rendering as chief admin forever — the badge in the admin panel, the
  // "Transfer role" button, the ability to see other accounts' addresses. The
  // email identifies the FOUNDER of the forum; the role says who holds the
  // office now, and the office can move.
  //
  // Both sides must be real values before they can be equal. The staff DTO
  // deliberately does not serve email, so userEmail is undefined for every row
  // the members table renders, and VITE_ADMIN_EMAIL is only present in
  // .env.development / .env.production. If either is missing, the bare
  // comparison below is `undefined === undefined`, which is true -- and every
  // account on the forum would be promoted to Chief Admin and render an Admin
  // badge. It is a one-line guard against a silently total failure.
  if (roleId) return roleId;
  const adminEmail = import.meta.env.VITE_ADMIN_EMAIL;
  if (adminEmail && userEmail && userEmail === adminEmail) return CHIEF_ADMIN_ID;
  return 'player';
};

export const isChiefAdmin = (userEmail, roleId) => {
  // The role decides, and the email is only a fallback for a missing role —
  // the same reasoning as resolveUserRoleId above, and for the same reason:
  // the chief-admin role is transferable, so an address that used to hold it
  // must stop conferring it the moment the role moves.
  if (roleId) return roleId === CHIEF_ADMIN_ID;
  const adminEmail = import.meta.env.VITE_ADMIN_EMAIL;
  return Boolean(adminEmail) && userEmail === adminEmail;
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

