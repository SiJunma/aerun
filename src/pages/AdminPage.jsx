import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Row, Col, Form, Button, Table, Badge, Dropdown, Spinner } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useSearchParams } from 'react-router-dom';
import {
  getGlobalSettings, updateGlobalSettings, uploadIdentityPlaceholder, approveUser, rejectUser, deleteUser, banUser, unbanUser,
  updateUserRole, addRole, updateRole, deleteRole, fetchAdminRoles, fetchAdminUsers, bulkUpdateUsers, bulkDeleteUsers, fetchUsersContentCounts
} from '../api/admin';
import { subscribeToAllCategories, addCategory, updateCategory, deleteCategory, subscribeToCategoryGroups, addCategoryGroup, updateCategoryGroup, deleteCategoryGroup, fetchAdminCategories, fetchSecuredCategoryGroups } from '../api/categories';
import { toMembersRow, withLegacyDates } from '../api/auth-resources';
import { resolveAvatarUrl } from '../api/avatars';
import { identityAvatar } from '../utils/identity';
import { getAuditLogs } from '../api/audit';
import { subscribeToDesigns } from '../api/designs';
import { MAX_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_LABELS, getRoleVisuals, isChiefAdmin, normalizePermissions, PERMISSION_GROUPS, CHIEF_ADMIN_ID, ADMIN_ROLE_ID, DEFAULT_ROLES, rankOfRole } from '../constants/permissions';
import TransferRootModal from '../components/modals/TransferRootModal';
import AuditDetailsModal from '../components/modals/AuditDetailsModal';
import { transferRoot } from '../api/admin';
import Timestamp from '../components/common/Timestamp';
import { InputGroup } from 'react-bootstrap';
import ForumModal from '../components/common/ForumModal';
import {
  UserCheck, UserMinus, UserX, PlusCircle, Edit2, Trash2,
  Search, Award, Pin, Lock, Settings, MessageSquareOff,
  Bell, BellOff, ArrowRightLeft, Send, FilePen, User, Palette, Copy, Eye, EyeOff,
  Layers, FolderTree, ShieldAlert, Menu, RefreshCw
} from 'lucide-react';
import AdminSidebar from '../components/admin/AdminSidebar';
import {
  ADMIN_NAV_GROUPS,
  filterNavByPermissions,
  collectVisibleTabPaths,
} from '../config/adminNavigation';
import { useAuth } from '../contexts/AuthProvider';
import ConfirmModal from '../components/common/ConfirmModal';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumPagination from '../components/common/ForumPagination';
import { useToast } from '../contexts/ToastProvider';
import { pb } from '../api/pocketbase';
import DesignsTab from '../components/admin/DesignsTab';
import EmailTemplatesSettings from '../components/admin/EmailTemplatesSettings';
import AvatarUploader from '../components/common/AvatarUploader';
import { usePageTitle } from '../contexts/TitleProvider';

// Every permission key the server knows about.
//
// The role editor sends the role's permission list back verbatim, and the
// server refuses an unknown key with a 400. So the set is also what the editor
// filters against when it seeds a role's form — a stale key from an import
// would otherwise make the form unsaveable.
const KNOWN_PERMISSIONS = new Set(Object.values(PERMISSIONS));

// adminBulkMaxIds mirrors the server cap (adminBulkMaxIDs = 100): one bulk
// request carries at most 100 ids, so a bigger selection must be trimmed
// before the confirmation button unlocks.
const adminBulkMaxIds = 100;

// Fixed Audit Action Registry (§3.3 of SPEC_REFACTOR_AUDIT_LOGS.md)
// Grouped, canonical, no duplicates and no lower-case fallback.
const AUDIT_ACTION_REGISTRY = [
  {
    groupKey: 'filter_group_identity',
    actions: [
      'password_change',
      'email_change',
      'provider_unlink',
      'nickname_change',
      'profile_edit',
    ],
  },
  {
    groupKey: 'filter_group_content',
    actions: [
      'post_edit',
      'post_delete',
      'topic_delete',
      'topic_title_edit',
      'topic_description_edit',
      'topic_lock',
      'topic_pin',
      'topic_move',
      'posts_move',
      'dm_message_delete',
      'reputation_edited',
      'reputation_deleted',
    ],
  },
  {
    groupKey: 'filter_group_structure',
    actions: [
      'role_created',
      'role_updated',
      'role_deleted',
      'category_created',
      'category_updated',
      'category_deleted',
      'category_group_created',
      'category_group_updated',
      'category_group_deleted',
      'design_created',
      'design_updated',
      'design_deleted',
      'settings_updated',
      'email_template_updated',
      'email_template_test_sent',
    ],
  },
  {
    groupKey: 'filter_group_users',
    actions: [
      'admin_user_update',
      'admin_user_delete',
      'admin_users_bulk_update',
      'admin_users_bulk_delete',
      'root_transfer',
    ],
  },
  {
    groupKey: 'filter_group_masks',
    actions: [
      'character_created',
      'character_updated',
      'character_deleted',
      'character_avatar_changed',
    ],
  },
  {
    groupKey: 'filter_group_legacy',
    actions: [
      'user banned',
      'user unbanned',
      'user registered',
    ],
  },
];

const AdminPage = () => {
  const { t, lang: currentLang } = useI18n();
  const { user, profile, meRole, hasPermission, roles, isRootAdmin, refreshForumState } = useAuth();
  const { showToast } = useToast();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();
  const visibleNavGroups = useMemo(
    () => filterNavByPermissions(ADMIN_NAV_GROUPS, hasPermission),
    [hasPermission]
  );
  const visibleTabPaths = useMemo(
    () => collectVisibleTabPaths(visibleNavGroups),
    [visibleNavGroups]
  );
  const requestedTab = searchParams.get('tab');
  const activeTab = visibleTabPaths.includes(requestedTab)
    ? requestedTab
    : (visibleTabPaths[0] ?? 'settings');
  const setActiveTab = useCallback((k) => setSearchParams({ tab: k }, { replace: true }), [setSearchParams]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState([]);
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  // The staff table reads ONE server page per render: `usersPage` is what the
  // pagination footer drives, `usersSearch` is the COMMITTED (debounced)
  // search string the server narrows by, and the totals come from the
  // response envelope. `usersLoading` covers a tab entry, a page switch and
  // the refetch after a mutation.
  const [usersPage, setUsersPage] = useState(1);
  const [usersSearch, setUsersSearch] = useState('');
  const [usersTotalItems, setUsersTotalItems] = useState(0);
  const [usersTotalPages, setUsersTotalPages] = useState(1);
  const [usersLoading, setUsersLoading] = useState(false);
  // Bumped after every successful mutation so the loader effect re-reads the
  // page from the server instead of trusting the optimistic patch to keep
  // counts and ordering honest.
  const [usersRefreshNonce, setUsersRefreshNonce] = useState(0);
  const reloadUsers = useCallback(() => setUsersRefreshNonce(n => n + 1), []);
  // Bulk (multi-user) actions. Selection is keyed by user id and persists across
  // pages of the staff list — an account picked on page one stays selected when
  // the admin turns to page two and back.
  const [selectedUserIds, setSelectedUserIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  // ids the viewer removed from the selection while the confirmation modal was open
  const [bulkModalExcluded, setBulkModalExcluded] = useState(new Set());
  // Snapshot of every picked account, keyed by id: {nickname, avatar_url,
  // role, status}. The `users` state holds only the CURRENT server page,
  // but the selection persists across pages, so the confirmation modal reads
  // the snapshot for every picked account — including rows on pages that are
  // not rendered right now.
  const [bulkSelectionSnap, setBulkSelectionSnap] = useState({});
  const [bulkRoleId, setBulkRoleId] = useState('');
  const [bulkRoleNotifyChange, setBulkRoleNotifyChange] = useState(true);
  const [bulkDeletePosts, setBulkDeletePosts] = useState(false);
  // The role EDITOR's rows, from GET /admin/roles.
  //
  // `roles` from useAuth is the PUBLIC badge registry — role_id, name, rank,
  // color — because that route is ungated so a signed-out visitor can still render
  // badges. The editor additionally needs permissions, is_system, base_role_id,
  // max_characters_limit and the record id, and those are deliberately not
  // published to everyone. Loaded only when the roles tab is open AND this
  // account may manage roles.
  const [adminRoles, setAdminRoles] = useState([]);
  // Root handover. Only the account that IS the chief admin sees the button,
  // and the candidates exclude yourself — the server refuses you as your own
  // successor, so offering the choice would be a dialog that cannot succeed.
  const [showTransferRoot, setShowTransferRoot] = useState(false);
  const [transferring, setTransferring] = useState(false);
  // Candidates for the handover dialog. The staff table itself holds one
  // server page now, so the dialog loads its own list when it opens — the
  // successor may sit on any page, and this is a rare root-only action that
  // can afford the bounded walk the old table paid on every mount.
  const [transferCandidates, setTransferCandidates] = useState([]);
  const [transferLoading, setTransferLoading] = useState(false);
  // Whether THIS account holds the chief-admin role, as the SERVER says.
  //
  // It used to be `isChiefAdmin(user?.email, user?.role_id)`, and both halves
  // of that were wrong. `user` is the auth-store snapshot — { uid, email,
  // displayName, ... } — and it carries NO role_id at all, so the answer came
  // from the email branch: "am I the founder's address?". After a handover
  // that answer stays true forever, and the ex-root kept the "Transfer role"
  // button on the NEW root's row — the exact symptom the owner reported.
  //
  // The role of THIS account, as the SERVER says — read from the same /me
  // projection that feeds `hasPermission` (one 30s poll carries both the
  // permission set and the role, so the rank gates below and the permission
  // gates can never disagree about who is asking). The fallbacks cover the
  // window before the first /me answer lands: `profile` is the server row
  // AuthProvider re-reads at boot (a rename on another device converges
  // through it), then the staff page itself, then the auth-store snapshot —
  // which is only ever a last resort, because it is a localStorage copy of
  // the row as it was at SIGN-IN.
  const myRoleId = meRole || users.find((u) => u.id === user?.uid)?.role || profile?.role || 'player';
  const isSelfRoot = myRoleId === CHIEF_ADMIN_ID;
  const [userSearch, setUserSearch] = useState('');
  const [designs, setDesigns] = useState([]);

  useEffect(() => {
    setPageTitle(t('admin.title', 'Admin Panel'));
  }, [setPageTitle, t]);

  // Modal State
  const [showCatModal, setShowCatModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [catForm, setCatForm] = useState({
    title: { en: '', ru: '' },
    description: { en: '', ru: '' },
    order: 0,
    group_id: '',
    permissions: {}
  });

  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupForm, setGroupForm] = useState({ title: { en: '', ru: '' }, order: 0 });

  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState(null);
  // `max_characters_limit` is a STRING here, not a number: the empty value
  // means "this role has no opinion — inherit the forum-wide setting", and a
  // number field cannot hold "empty" without a sentinel that has to be
  // translated back on save. It is converted to a number in handleSaveRole.
  const [roleForm, setRoleForm] = useState({ name: '', permissions: [], color: 'primary', max_characters_limit: '' });

  // ── Form validity ────────────────────────────────────────────────────────
  //
  // Every save handler below opened with a bare guard:
  //
  //     if (!groupForm.title?.en && !groupForm.title?.ru) return;
  //
  // which returns WITHOUT a request and WITHOUT a toast, so clicking Save on an
  // empty form did nothing at all. The guard was right; it just had no visible
  // counterpart.
  //
  // `.trim()` matters: the old guards compared raw values, so a field holding a
  // single space passed and became a request the server refused with 400
  // ("title is required"). Whitespace is not a title.
  const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

  // ── Errors are shown only AFTER a submit attempt ─────────────────────────
  //
  // Marking a field invalid the moment the modal opens condemns a form nobody
  // has touched yet: two red inputs and a red sentence greet an admin who was
  // only going to type a title. Errors must answer "you tried and this was
  // wrong", not "you have not started".
  //
  // This also resolves why Save must NOT be disabled from the start: a disabled
  // button is unclickable, so it could never surface the errors it hides, and
  // the original silent no-op would return wearing a disabled style. The button
  // therefore stays live until the first attempt — clicking it IS the signal —
  // and only then locks while the form is still invalid.
  const [groupAttempted, setGroupAttempted] = useState(false);
  const [catAttempted, setCatAttempted] = useState(false);
  const [roleAttempted, setRoleAttempted] = useState(false);

  // How many permissions this category currently overrides. Shown as a badge on
  // the block heading so a category that is NOT inheriting everything says so
  // at a glance.
  const overrideCount = Object.values(catForm.permissions || {}).filter(
    (v) => v !== undefined && v !== null
  ).length;

  // Refs to the first invalid control of each modal, so a rejected Save can
  // scroll the offending field into view instead of only greying the button.
  // The button greying is real feedback but a WEAK one: the admin is left
  // looking at a footer that changed colour, with the actual cause somewhere
  // above the fold.
  const catTitleRef = useRef(null);
  const catGroupRef = useRef(null);
  const groupTitleRef = useRef(null);
  const roleNameRef = useRef(null);

  // The two language inputs are ALTERNATIVES, not a required pair:
  // api/categories.js pickLabel() sends both, and the server takes `ru || en`
  // as the primary, so either one suffices.
  const groupTitleFilled = Boolean(trimmed(groupForm.title?.en) || trimmed(groupForm.title?.ru));
  const catTitleFilled = Boolean(trimmed(catForm.title?.en) || trimmed(catForm.title?.ru));
  // The server rejects a category with no group (category_commands.go), and such
  // a row would be invisible on the forum anyway.
  const catGroupChosen = Boolean(catForm.group_id);
  const catDescTooLong = (trimmed(catForm.description?.en).length + trimmed(catForm.description?.ru).length) > 1024;
  const roleNameFilled = Boolean(trimmed(roleForm.name));

  // One label function for the audit table, the badge, the filter dropdown, the
  // search box and the details modal — all five read the same label, so they
  // cannot drift apart.
  //
  // `t()` echoes the KEY PATH when a translation is missing (I18nProvider
  // returns `path` as its last resort), so the `t(...) || action_type` fallback
  // that used to sit at each call site could never fire: the path is a truthy
  // string. An untranslated action therefore rendered as
  // "admin.audit.actions.topic_delete" AND could not be found by the search box,
  // which matched on that same raw string. Deriving a readable label from the
  // raw type keeps the row usable the moment the backend adds an action, before
  // anybody remembers the dictionary.
  const auditActionLabel = (actionType) => {
    if (!actionType) return '';
    const key = `admin.audit.actions.${actionType}`;
    const label = t(key);
    if (!label || label === key) {
      console.warn(`[auditActionLabel] missing dictionary key: ${key}`);
      return actionType
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return label;
  };

  const groupFormValid = groupTitleFilled;
  const catFormValid = catTitleFilled && catGroupChosen && !catDescTooLong;

  // Visible invalidity — gated on the attempt. These drive isInvalid.
  const showGroupError = groupAttempted && !groupFormValid;
  const showCatTitleError = catAttempted && !catTitleFilled;
  const showCatGroupError = catAttempted && !catGroupChosen;
  const showCatDescError = catAttempted && catDescTooLong;
  const showRoleNameError = roleAttempted && !roleNameFilled;

  // The button locks only once the reasons are already on screen; before that it
  // must stay clickable, or the errors would have no way to appear at all.
  const groupSaveDisabled = saving || (groupAttempted && !groupFormValid);
  const catSaveDisabled = saving || (catAttempted && !catFormValid);
  const roleSaveDisabled = saving || (roleAttempted && !roleNameFilled);

  /**
   * Bring the first invalid control into view and focus it.
   *
   * `scrollIntoView` with `block: 'center'` is used instead of a bare
   * `focus()`: focusing alone scrolls the modal body but can leave the field
   * flush against the header, and in this modal the offending field is often
   * above the fold while the Save button that revealed the problem sits at the
   * bottom. The two are far apart, so the admin has to hunt for the cause.
   *
   * `requestAnimationFrame` defers the call by one frame because the attempt
   * flag is set in the same click: the isInvalid styling and the feedback
   * message are not in the DOM yet, and measuring mid-render would scroll to
   * the wrong offset.
   */
  const revealFirstInvalid = (refs) => {
    requestAnimationFrame(() => {
      for (const ref of refs) {
        const el = ref?.current;
        if (!el) continue;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus({ preventScroll: true });
        return;
      }
    });
  };

  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({ role: '', notifyRoleChange: true });

  // Confirm Modal State
  const [confirmState, setConfirmState] = useState({
    show: false,
    onConfirm: () => { },
    title: '',
    message: ''
  });
  // Whether "delete all posts by this user" is checked in the user-delete
  // confirmation dialog. Defaults off: delete only the account.
  const [deleteUserPosts, setDeleteUserPosts] = useState(false);
  // Ref mirror so the confirm handler (captured at dialog-open time in
  // confirmState.onConfirm) reads the CURRENT checkbox value at confirm time,
  // not the stale value from when the dialog was opened. Without this, a
  // checked checkbox is ignored and deletePosts is always false (bug O12).
  const deleteUserPostsRef = useRef(false);
  // Preview of what the "delete all their content" option destroys: how many
  // topics and posts the purge would remove. The SINGLE delete dialog counts
  // the one account it names; the bulk dialog sums the WHOLE selection —
  // including rows picked on other pages. Counts are asked lazily, only
  // while the option is checked.
  const [deleteContentCount, setDeleteContentCount] = useState(null);
  const [deleteContentCountLoading, setDeleteContentCountLoading] = useState(false);
  const [bulkContentCount, setBulkContentCount] = useState(null);
  const [bulkContentCountLoading, setBulkContentCountLoading] = useState(false);

  // A delete the SERVER would refuse, caught before the request is made.
  //
  // Both rules are referential, not advisory: deleting a group that still holds
  // categories would leave them pointing at a row that is gone, and the forum
  // index draws categories only inside a group — so they would silently vanish.
  // Firing the DELETE and showing the raw 409 body in a toast tells the admin
  // what happened but not what to DO. This modal names the blockers instead.
  const [blockedDelete, setBlockedDelete] = useState(null);

  // Audit Log State
  const [auditLogs, setAuditLogs] = useState([]);
  const [selectedAuditLog, setSelectedAuditLog] = useState(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [auditSearch, setAuditSearch] = useState('');
  const [debouncedAuditSearch, setDebouncedAuditSearch] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('all');
  const [auditPage, setAuditPage] = useState(1);
  const [auditReloadSignal, setAuditReloadSignal] = useState(0);
  const AUDIT_PAGE_SIZE = 50;

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAuditSearch(auditSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [auditSearch]);

  // id → nickname for the ids the audit trail names or users table holds.
  const auditNicknameIndex = useMemo(() => {
    const index = {};
    (users || []).forEach(u => {
      if (u?.id && u?.nickname) index[u.id] = u.nickname;
    });
    (auditLogs || []).forEach(log => {
      if (log.performer_id && log.performerNickname) {
        index[log.performer_id] = log.performerNickname;
      }
      const d = log.details || {};
      if (d.author_id && (d.author_nickname || log.targetNickname)) {
        index[d.author_id] = d.author_nickname || log.targetNickname;
      }
      if (d.owner_id && (d.owner_nickname || log.targetNickname)) {
        index[d.owner_id] = d.owner_nickname || log.targetNickname;
      }
      if (d.target_id && (d.target_nickname || log.targetNickname)) {
        index[d.target_id] = d.target_nickname || log.targetNickname;
      }
      if (Array.isArray(d.targets)) {
        d.targets.forEach(tg => {
          if (tg?.id && tg?.nickname) index[tg.id] = tg.nickname;
        });
      }
    });
    return index;
  }, [auditLogs, users]);

  // Tab permissions check
  const canAccessTab = useCallback((tab) => {
    switch (tab) {
      case 'settings': return hasPermission(PERMISSIONS.MANAGE_FORUM);
      case 'designs': return hasPermission(PERMISSIONS.MANAGE_DESIGNS);
      case 'users': return hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES);
      case 'roles': return hasPermission(PERMISSIONS.MANAGE_ROLES);
      case 'categories': return hasPermission(PERMISSIONS.MANAGE_CATEGORIES);
      case 'audit': return hasPermission(PERMISSIONS.VIEW_AUDIT_LOG);
      default: return false;
    }
  }, [hasPermission]);

  // Whether the role DEFINITION may be edited from this panel.
  //
  // The server's rule is the permission and nothing else: PATCH/POST/DELETE
  // /roles are bound to RequirePermission(PermManageRoles) (run.go) and the
  // handlers add no rank check of their own. A role definition is DATA the
  // admin owns — a system role is edited exactly like a custom one, since it is
  // the template every custom role is built from, and freezing it would freeze
  // everything built on it.
  //
  // This used to compare the viewer's rank against the target's, which had no
  // server counterpart and read two fields that do not exist: `user.role_id`
  // (the auth snapshot carries no role) and `role.level` (the registry
  // publishes `rank`). So the viewer's level was always 0, every comparison
  // came out false, and an admin could not edit ANY role — while the server
  // accepted those writes the whole time.
  const canEditRole = useCallback((_targetRole) => {
    if (!hasPermission(PERMISSIONS.MANAGE_ROLES)) return false;
    // The chief-admin role's own row is not in this table at all (it is
    // filtered out above), so nothing here reaches the office itself.
    return true;
  }, [hasPermission]);

  // ── Role-change authority (the client mirror of the server) ────────────────
  //
  // `checkRoleChange` (backend/internal/platform/pocketbase/admin_users.go) is
  // the authority, and the panel has to offer exactly what it accepts:
  //
  //   root  → may change the role of ANY account;
  //   admin → only of accounts ranked STRICTLY below their own, and may not
  //           appoint another administrator;
  //   other → may not change roles at all.
  //
  // The panel used to offer the role editor to everyone holding
  // `change_roles`, so an admin could open their OWN role dialog and then be
  // refused by the server with "you can only change the role of an account
  // ranked strictly below yours" (owner, A5). The button is now shown only
  // where the server would accept the change.
  const isRootActor = myRoleId === CHIEF_ADMIN_ID;

  const canChangeRoleOf = (targetRoleId) => {
    if (!hasPermission(PERMISSIONS.CHANGE_ROLES)) return false;
    if (isRootActor) return true;
    if (myRoleId !== ADMIN_ROLE_ID) return false;
    const myRank = rankOfRole(myRoleId, roles);
    const targetRank = rankOfRole(targetRoleId, roles);
    if (myRank === null || targetRank === null) return false;
    // Strictly below — the same comparison the server makes, so an admin can
    // never aim the editor at themselves or at an equal-ranked account.
    return targetRank < myRank;
  };

  // The roles this viewer may WRITE. `root` is transferred, never assigned
  // (checkRoleChange refuses it for every caller, root included), and only the
  // chief admin may appoint another administrator.
  const assignableRoles = roles.filter((r) => {
    if (r.id === CHIEF_ADMIN_ID) return false;
    if (r.id === ADMIN_ROLE_ID && !isRootActor) return false;
    return true;
  });

  // ── Bulk actions ────────────────────────────────────────────────────────
  //
  // A row's checkbox renders only when the actor may perform at least one bulk
  // operation on that user (§3.2): ban/unban (PermBanUsers), delete
  // (PermDeleteUsers) or role change (canChangeRoleOf). An account can never
  // be selected for an action on itself — the server repeats this rule.

  const canBulkEditUser = (u) => {
    if (u.id === user.uid) return false;
    return (
      hasPermission(PERMISSIONS.BAN_USERS) ||
      hasPermission(PERMISSIONS.DELETE_USERS) ||
      canChangeRoleOf(u.role)
    );
  };

  const bulkEditable = users.filter(canBulkEditUser);
  const bulkAll = bulkEditable.length > 0 && bulkEditable.every(u => selectedUserIds.has(u.id));
  const bulkAny = bulkEditable.some(u => selectedUserIds.has(u.id));

  // Ids that will actually be acted on: the persistent selection minus anything
  // the viewer dropped while the confirmation modal was open. The selection
  // persists across pages (§8.2), so this list can name rows that are NOT in
  // the current `users` page — the modal title, the chips and the ban/unban
  // button therefore read each picked account through bulkSelectionSnap and
  // only fall back to the current page.
  const effectiveBulkIds = [...selectedUserIds].filter(id => !bulkModalExcluded.has(id));
  const bulkAnyBanned = effectiveBulkIds.some(id => (
    (bulkSelectionSnap[id] ?? users.find(x => x.id === id))?.status === 'banned'
  ));

  // Default role for the bulk role-change modal: the role of the first selected
  // user when it is one the viewer may assign, otherwise the first assignable role.
  const defaultBulkRoleId = (() => {
    // The first picked account may live on another page (selection persists
    // across pages), so read it through the selection snapshot first.
    const firstId = effectiveBulkIds[0];
    const first = bulkSelectionSnap[firstId] ?? users.find(x => x.id === firstId);
    if (first && assignableRoles.some((r) => r.id === first.role)) return first.role;
    return assignableRoles[0]?.id || '';
  })();

  const toggleBulkUser = (id) => {
    const isRemoving = selectedUserIds.has(id);
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      if (isRemoving) next.delete(id);
      else next.add(id);
      return next;
    });
    // Keep the snapshot in step with the selection: a row picked on ANY page
    // must stay visible (and reviewable) in the confirmation modal even after
    // the admin flips to another page of the staff list.
    setBulkSelectionSnap(prev => {
      const next = { ...prev };
      if (isRemoving) {
        delete next[id];
      } else {
        const u = users.find(x => x.id === id);
        if (u) {
          next[id] = { id: u.id, nickname: u.nickname, avatar_url: u.avatar_url, role: u.role, status: u.status };
        }
      }
      return next;
    });
  };

  const toggleBulkAll = () => {
    if (bulkAll) {
      setSelectedUserIds(new Set());
      setBulkSelectionSnap({});
      return;
    }
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      bulkEditable.forEach(u => next.add(u.id));
      return next;
    });
    setBulkSelectionSnap(prev => {
      const next = { ...prev };
      bulkEditable.forEach(u => {
        next[u.id] = { id: u.id, nickname: u.nickname, avatar_url: u.avatar_url, role: u.role, status: u.status };
      });
      return next;
    });
  };

  const bulkModalTitle = () => {
    // The count must cover the WHOLE selection, including rows picked on other
    // pages — the request will act on every one of them.
    const count = effectiveBulkIds.length;
    if (bulkAction === 'role') return t('admin.users.bulk_modal_title_role', { count });
    if (bulkAction === 'ban') return t('admin.users.bulk_modal_title_ban', { count });
    if (bulkAction === 'unban') return t('admin.users.bulk_modal_title_unban', { count });
    return t('admin.users.bulk_modal_title_delete', { count });
  };

  const handleOpenBulkModal = (action) => {
    if (effectiveBulkIds.length === 0) return;
    setBulkAction(action);
    setBulkModalExcluded(new Set());
    setBulkRoleId(defaultBulkRoleId);
    setBulkRoleNotifyChange(true);
    setBulkDeletePosts(false);
    setBulkModalOpen(true);
  };

  const handleCloseBulkModal = () => {
    setBulkModalOpen(false);
    setBulkAction(null);
    setBulkModalExcluded(new Set());
    setBulkRoleNotifyChange(true);
    setBulkContentCount(null);
  };

  const handleRemoveFromBulkSelection = (id) => {
    setBulkModalExcluded(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    // Drop it from the persistent selection so the row checkbox unchecks too.
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setBulkSelectionSnap(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // Executes the chosen bulk action over the currently selected ids (minus any
  // the viewer dropped in the confirmation modal). Optimistic update with
  // per-target rollback on partial failure, mirroring the single-user handlers.
  const handleBulkConfirm = async () => {
    const ids = effectiveBulkIds;
    if (ids.length === 0) {
      setBulkModalOpen(false);
      return;
    }
    const before = users;
    setBulkPending(true);
    try {
      let optimistic;
      if (bulkAction === 'role') {
        optimistic = users.map(u => (selectedUserIds.has(u.id) && !bulkModalExcluded.has(u.id)
          ? { ...u, role: bulkRoleId }
          : u));
      } else if (bulkAction === 'ban' || bulkAction === 'unban') {
        optimistic = users.map(u => (selectedUserIds.has(u.id) && !bulkModalExcluded.has(u.id)
          ? { ...u, status: bulkAction === 'ban' ? 'banned' : 'active' }
          : u));
      } else {
        optimistic = users.filter(u => !(selectedUserIds.has(u.id) && !bulkModalExcluded.has(u.id)));
      }
      setUsers(optimistic);

      let res;
      if (bulkAction === 'delete') {
        res = await bulkDeleteUsers(ids, { delete_posts: bulkDeletePosts });
      } else if (bulkAction === 'role') {
        res = await bulkUpdateUsers(ids, { role: bulkRoleId, notify_role_change: bulkRoleNotifyChange });
      } else {
        res = await bulkUpdateUsers(ids, { status: bulkAction === 'ban' ? 'banned' : 'active' });
      }

      await refreshForumState?.(true);

      const failed = (res?.items || []).filter(i => !i.ok);
      if (failed.length > 0) {
        const rejected = new Set(failed.map(i => i.id));
        setUsers(prev => {
          // Failed targets go back to their pre-action state, and rows that
          // the optimistic delete removed re-enter the table at the position
          // they had in `before` — not appended at the bottom of the list.
          const next = prev.map(u => {
            if (!rejected.has(u.id)) return u;
            const old = before.find(o => o.id === u.id);
            return old || u;
          });
          const present = new Set(next.map(u => u.id));
          const restored = [];
          before.forEach((u, idx) => {
            if (rejected.has(u.id) && !present.has(u.id)) restored.push({ u, idx });
          });
          if (restored.length === 0) return next;
          const out = [...next];
          restored.forEach(({ u, idx }) => {
            out.splice(Math.min(idx, out.length), 0, u);
          });
          return out;
        });
        showToast(t('admin.users.toast_bulk_partial', {
          succeeded: res.succeeded,
          failed: res.failed,
        }), 'warning');
      } else {
        showToast(t('admin.users.toast_bulk_done', { count: res.processed }), 'success');
      }
      // The staff table renders one server page now, so the optimistic patch
      // above can only ever be a preview: the refetch brings back the server's
      // page and the honest totals (rows acted on may sit on other pages —
      // the selection persists across them).
      reloadUsers();
      // The request went through (fully or partially): the selection has done
      // its job. Only a FAILED REQUEST — the catch below — keeps it, so the
      // admin can retry without re-picking the rows.
      setSelectedUserIds(new Set());
      setBulkSelectionSnap({});
    } catch (err) {
      setUsers(before);
      console.error('[bulk users err]', err);
      showToast(err?.message || t('admin.users.error_bulk'), 'danger');
    } finally {
      setBulkPending(false);
      setBulkModalOpen(false);
      setBulkAction(null);
      setBulkModalExcluded(new Set());
      setBulkRoleId('');
      setBulkRoleNotifyChange(true);
      setBulkDeletePosts(false);
    }
  };

  // Preview of what the "delete all their content" option destroys: how many
  // topics and posts the purge would remove. The SINGLE delete dialog counts
  // the one account it names; the bulk dialog sums the WHOLE selection —
  // including rows picked on other pages, because effectiveBulkIds covers
  // them. Counts are asked lazily, only while the option is checked.
  const deleteCountUid = confirmState.kind === 'delete-user' && confirmState.show ? confirmState.uid : '';
  useEffect(() => {
    if (!deleteCountUid || !deleteUserPosts) {
      setDeleteContentCount(null);
      return;
    }
    let alive = true;
    setDeleteContentCountLoading(true);
    fetchUsersContentCounts([deleteCountUid])
      .then(res => {
        if (alive) setDeleteContentCount(res?.items?.[0] || null);
      })
      .catch(err => {
        console.error('[delete content count err]', err);
        if (alive) setDeleteContentCount(null);
      })
      .finally(() => {
        if (alive) setDeleteContentCountLoading(false);
      });
    return () => { alive = false; };
  }, [deleteCountUid, deleteUserPosts]);

  const bulkCountKey = bulkAction === 'delete' ? effectiveBulkIds.join(',') : '';
  useEffect(() => {
    const ids = bulkCountKey ? bulkCountKey.split(',') : [];
    if (bulkAction !== 'delete' || !bulkDeletePosts || ids.length === 0) {
      setBulkContentCount(null);
      return;
    }
    let alive = true;
    setBulkContentCountLoading(true);
    fetchUsersContentCounts(ids)
      .then(res => {
        if (!alive) return;
        const items = res?.items || [];
        setBulkContentCount({
          topics: items.reduce((acc, i) => acc + (i.topics || 0), 0),
          posts: items.reduce((acc, i) => acc + (i.posts || 0), 0),
        });
      })
      .catch(err => {
        console.error('[bulk content count err]', err);
        if (alive) setBulkContentCount(null);
      })
      .finally(() => {
        if (alive) setBulkContentCountLoading(false);
      });
    return () => { alive = false; };
  }, [bulkAction, bulkDeletePosts, bulkCountKey]);

  useEffect(() => {
    if (!canAccessTab(activeTab)) {
      const tabs = ['settings', 'designs', 'users', 'roles', 'categories', 'audit'];
      const firstAvailable = tabs.find(t => canAccessTab(t));
      if (firstAvailable) {
        setActiveTab(firstAvailable);
      }
    }
  }, [activeTab, canAccessTab, setActiveTab]);

  // Initial settings state
  const [settings, setSettings] = useState({
    forumName: { en: 'Aerun Forum', ru: 'Aerun Forum' },
    registrationEnabled: true,
    maxCharsPerPost: 15000,
    postsPerPage: 20,
    topicsPerPage: 20,
    maxPostsPerTopic: 1000,
    maxCharactersPerUser: 10,
    maintenanceMode: false,
    showMaintenanceMessage: false,
    maintenanceMessage: { en: '', ru: '' },
    welcomeMessage: { en: '', ru: '' },
    enableReputation: true,
    reputationStyle: 'both',
    enableCharacters: true,
    enableDice: true,
    allowGifAvatars: true,
    allowGifInPosts: true,
    allowUserCustomDesign: true,
    defaultDesignId: '',
    whitelistMode: true,
    requireApproval: true,
    logoUrl: '',
    deletedAvatar: '',
    guestAvatar: '',
    bgLight: 'https://images.unsplash.com/photo-1458668383970-8ddd3927deed?q=80&w=1400&auto=format&fit=crop',
    bgDark: 'https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop',
    bgNeutral: 'https://images.unsplash.com/photo-1675636173835-657f72144c77?q=80&w=1400&auto=format&fit=crop'
  });

  useEffect(() => {
    const unsubSettings = getGlobalSettings((data) => {
      if (data) {
        const ensureBilingual = (val, defaultVal = '') => {
          if (typeof val === 'string') return { en: val, ru: val };
          if (typeof val === 'object' && val !== null) {
            return {
              en: typeof val.en === 'string' ? val.en : (val.en ? String(val.en) : defaultVal),
              ru: typeof val.ru === 'string' ? val.ru : (val.ru ? String(val.ru) : defaultVal)
            };
          }
          return { en: defaultVal, ru: defaultVal };
        };

        const migrated = {
          ...data,
          forumName: ensureBilingual(data.forumName, 'Aerun Forum'),
          welcomeMessage: ensureBilingual(data.welcomeMessage, ''),
          maintenanceMessage: ensureBilingual(data.maintenanceMessage, ''),
          registrationEnabled: data.registrationEnabled ?? true,
          maintenanceMode: data.maintenanceMode ?? false,
          showMaintenanceMessage: data.showMaintenanceMessage ?? false,
          maxCharsPerPost: data.maxCharsPerPost ?? 15000,
          postsPerPage: data.postsPerPage ?? 20,
          topicsPerPage: data.topicsPerPage ?? 20,
          maxPostsPerTopic: data.maxPostsPerTopic ?? 1000,
          maxCharactersPerUser: data.maxCharactersPerUser ?? 10,
          whitelistMode: data.whitelistMode ?? false,
          requireApproval: data.requireApproval ?? true,
          enableCharacters: data.enableCharacters ?? true,
          enableDice: data.enableDice ?? true,
          enableReputation: data.enableReputation ?? true,
          reputationStyle: data.reputationStyle || 'both',
          allowGifAvatars: data.allowGifAvatars ?? true,
          allowGifInPosts: data.allowGifInPosts ?? true,
          allowUserCustomDesign: data.allowUserCustomDesign ?? true,
          defaultDesignId: data.defaultDesignId || '',
          logoUrl: data.logoUrl || '',
          deletedAvatar: data.deletedAvatar || '',
          guestAvatar: data.guestAvatar || '',
          bgLight: data.bgLight || 'https://images.unsplash.com/photo-1458668383970-8ddd3927deed?q=80&w=1400&auto=format&fit=crop',
          bgDark: data.bgDark || 'https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop',
          bgNeutral: data.bgNeutral || 'https://images.unsplash.com/photo-1675636173835-657f72144c77?q=80&w=1400&auto=format&fit=crop'
        };
        setSettings(migrated);
      }
    });
    return () => {
      unsubSettings();
    };
  }, []);

  // ── Per-tab loading ──────────────────────────────────────────────────────
  //
  // Every list below used to subscribe ON MOUNT, whether or not its tab was
  // open: opening /admin fired the categories read, the FULL staff walk (one
  // request per /admin/users page) and the designs read at once, even for an
  // admin who only came to look at Settings. The reads now follow the tab: a
  // subscription is created when its tab becomes active and dropped — its
  // connection-restored refetch listener with it — when the admin leaves, so
  // returning to the tab re-reads from the server rather than showing rows
  // that were current when the page mounted. None of these poll; each is a
  // one-shot read per subscription (see src/api/connection.js), so a tab
  // switch costs exactly the reads that tab needs.
  useEffect(() => {
    if (activeTab !== 'categories') return;
    const unsubCats = subscribeToAllCategories(setCategories);
    const unsubGroups = subscribeToCategoryGroups(setGroups);
    return () => {
      unsubCats();
      unsubGroups();
    };
  }, [activeTab]);

  // The search field holds the LIVE input; the COMMITTED value only changes
  // 400 ms after the last keystroke, so typing "anna" costs one server read,
  // not four, and every commit returns the table to page 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setUsersSearch(userSearch);
      setUsersPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [userSearch]);

  // The loader's error path needs `t` and `showToast`, but NEITHER may enter
  // the dependency array: I18nProvider hands out a fresh `t` on every render
  // (it is a plain function, not a useCallback), so a dep on it would re-run
  // this effect — and therefore refetch the page — on every unrelated state
  // change, the loading toggle included. The ref keeps the latest pair
  // reachable without becoming part of the effect's contract.
  const latestRenderRef = useRef({});
  latestRenderRef.current = { t, showToast };

  // The staff table reads one page per request from `GET /admin/users`.
  // `perPage` is capped at 30 server-side, so the whole list can no longer
  // arrive in a client-side walk: every page switch, committed search and
  // post-action refresh is an explicit read. The caller's own role needs no
  // read here at all — it rides on the /me projection that feeds
  // `hasPermission` (see myRoleId above) — so the roles tab, which renders no
  // rows, issues nothing.
  useEffect(() => {
    if (activeTab !== 'users') return;
    let alive = true;
    setUsersLoading(true);
    fetchAdminUsers({ page: usersPage, search: usersSearch })
      .then(res => {
        if (!alive) return;
        // Both sources spell the role `role` — the `users` column and the staff
        // DTO agree — but the raw staff row still needs the normalisation:
        // toMembersRow is the one mapper both routes go through, and skipping
        // it is how every badge once resolved to the Player fallback.
        const items = (res?.items || []).map(u => withLegacyDates(toMembersRow(u)));
        const tp = Math.max(1, res?.totalPages ?? 1);
        setUsers(items);
        setUsersTotalItems(res?.totalItems ?? 0);
        setUsersTotalPages(tp);
        // A page that emptied out under us — rows deleted on the last
        // page, a search that narrowed — steps back to the last real one
        // instead of showing an empty table forever.
        if (items.length === 0 && usersPage > tp) setUsersPage(tp);
      })
      .catch(err => {
        console.error('[admin users page err]', err);
        if (alive) {
          setUsers([]);
          setUsersTotalItems(0);
          setUsersTotalPages(1);
          latestRenderRef.current.showToast(
            latestRenderRef.current.t('admin.users.error_load'),
            'danger'
          );
        }
      })
      .finally(() => { if (alive) setUsersLoading(false); });
    return () => { alive = false; };
  }, [activeTab, usersPage, usersSearch, usersRefreshNonce]);

  // Designs render on the designs tab, and the Settings tab reads the same
  // list for the default-design dropdown.
  useEffect(() => {
    if (activeTab !== 'designs' && activeTab !== 'settings') return;
    const unsubDesigns = subscribeToDesigns(setDesigns);
    return () => unsubDesigns();
  }, [activeTab]);

  // The editor's role rows, loaded only when the roles tab is open AND this
  // account may manage roles.
  //
  // Both gates, not just the permission one: the editor renders only on the
  // roles tab, so the read follows it — an admin sitting on Settings no longer
  // pays for rows nothing was showing. The permission gate stays because the
  // public registry is enough to render badges: a moderator who gains or loses
  // `manage_roles` would otherwise see an editor whose rows never arrived, or
  // one still showing rows the server now refuses. Losing the permission clears
  // the rows; regaining it (on the roles tab) re-reads them.
  const canManageRoles = hasPermission(PERMISSIONS.MANAGE_ROLES);
  useEffect(() => {
    if (!canManageRoles) {
      setAdminRoles([]);
      return;
    }
    if (activeTab !== 'roles') {
      return;
    }
    let active = true;
    fetchAdminRoles()
      .then(rows => { if (active) setAdminRoles(rows); })
      .catch(err => {
        // Reported, not swallowed: an empty role editor looks like "no roles
        // exist", which is a very different fact from "you may not read them".
        if (active) console.warn('[AdminPage] admin roles failed to load:', err);
      });
    return () => { active = false; };
  }, [activeTab, canManageRoles]);

  // After a create/update/delete the editor list is re-read from the admin route.
  // refreshRoles() only refreshes the PUBLIC registry, which no longer carries the
  // fields this table renders — so without this the row would visibly not change.
  const reloadAdminRoles = useCallback(async () => {
    if (!hasPermission(PERMISSIONS.MANAGE_ROLES)) return;
    try {
      setAdminRoles(await fetchAdminRoles());
    } catch (err) {
      console.warn('[AdminPage] admin roles reload failed:', err);
    }
  }, [hasPermission]);

  const loadAuditLogs = useCallback(async (targetPage = 1) => {
    if (!hasPermission(PERMISSIONS.VIEW_AUDIT_LOG)) return;
    setLoadingAudit(true);
    try {
      const res = await getAuditLogs({
        page: targetPage,
        limit: AUDIT_PAGE_SIZE,
        action_type: auditActionFilter,
        q: debouncedAuditSearch,
      });
      setAuditLogs(res.items);
      setAuditTotal(res.total);
      setAuditTotalPages(res.totalPages);
      setAuditPage(res.page);
    } catch (err) {
      console.error('[AdminPage] Failed to fetch audit logs:', err);
    } finally {
      setLoadingAudit(false);
    }
  }, [hasPermission, auditActionFilter, debouncedAuditSearch]);

  const handleAuditPageChange = useCallback((newPage) => {
    loadAuditLogs(newPage);
  }, [loadAuditLogs]);

  const triggerAuditReload = useCallback(() => {
    setAuditReloadSignal((p) => p + 1);
  }, []);

  // Primary load & refresh when tab, filters or search change
  useEffect(() => {
    if (activeTab === 'audit' && hasPermission(PERMISSIONS.VIEW_AUDIT_LOG)) {
      loadAuditLogs(1);
    }
  }, [activeTab, hasPermission, auditActionFilter, debouncedAuditSearch, auditReloadSignal, loadAuditLogs]);

  // Refetch on tab visibility change (§5.2 trigger b)
  useEffect(() => {
    if (activeTab !== 'audit' || !hasPermission(PERMISSIONS.VIEW_AUDIT_LOG)) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadAuditLogs(1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeTab, hasPermission, loadAuditLogs]);

  // Quiet fallback polling: 60s, only while tab is active and visible (§5.2)
  useEffect(() => {
    if (activeTab !== 'audit' || !hasPermission(PERMISSIONS.VIEW_AUDIT_LOG)) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadAuditLogs(auditPage);
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [activeTab, hasPermission, auditPage, loadAuditLogs]);

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateGlobalSettings(settings, user.uid);
      showToast(t('admin.settings.success'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.settings.error'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  // Identity placeholder upload (plan I5/D2). The bytes go straight to the
  // dedicated upload endpoint, which owns the FileField and rewrites the
  // *_avatar_url reference — the same split the user avatar uses, so the URL
  // column never holds image data. uploadIdentityPlaceholder already refreshes
  // the shared settings cache and notifies subscribers, so the whole forum sees
  // the new image at once; we mirror it into local state for the preview.
  const handleUploadPlaceholder = async (kind, blob, filename) => {
    const url = await uploadIdentityPlaceholder(kind, blob, filename);
    if (url) {
      setSettings(prev => ({ ...prev, [kind === 'guest' ? 'guestAvatar' : 'deletedAvatar']: url }));
    }
    return url;
  };

  // Reset a placeholder to the neutral default: an empty reference, sent through
  // the same PATCH the rest of the settings use (an empty string clears it, just
  // like logoUrl). This only clears the reference — the stored file is left for
  // the schema, harmless and never served once the reference is empty.
  const handleResetPlaceholder = async (kind) => {
    const key = kind === 'guest' ? 'guestAvatar' : 'deletedAvatar';
    setSaving(true);
    try {
      await updateGlobalSettings({ [key]: '' }, user.uid);
      setSettings(prev => ({ ...prev, [key]: '' }));
      showToast(t('admin.settings.success'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.settings.error'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleOpenCatModal = (cat = null, prefillGroupId = null) => {
    // Every opening starts from "nothing attempted": a fresh form must not
    // inherit the red fields of the last one the admin tried and abandoned.
    setCatAttempted(false);

    // What the form should show for a category that already exists.
    //
    // `toCategory` already reports the inherit marker as null, so this needs no
    // special handling: a category that follows the global role settings arrives
    // with the override off, and one with an explicit list arrives with it on.
    // That round trip is exact, which the earlier snapshot could not manage —
    // a stored list of "every role with view_forum" was indistinguishable from
    // a deliberate pick of those same roles.
    const initialPermissions = cat?.permissions || {};

    if (cat) {
      setEditingCat(cat.id);
      setCatForm({
        title: typeof cat.title === 'object' ? { ...cat.title } : { en: cat.title, ru: cat.title },
        description: typeof cat.description === 'object' ? { ...cat.description } : { en: cat.description, ru: cat.description },
        order: cat.order || 0,
        group_id: cat.group_id || '',
        permissions: initialPermissions
      });
    } else {
      setEditingCat(null);
      // A new category starts with the override OFF, so visibility follows the
      // global role settings (stored as the inherit marker) rather than an
      // admin's hand-picked list. Seeding it as an explicit override here would
      // make the form claim the category overrides visibility when it does not,
      // and the badge would count an override that is not one.
      let initialGroupId = groups[0]?.id || '';
      let initialOrder = categories.length + 1;

      if (prefillGroupId !== null) {
        if (prefillGroupId === 'unassigned') {
          initialGroupId = '';
          const unassignedCats = categories.filter(c => !groups.find(g => g.id === c.group_id));
          initialOrder = unassignedCats.length > 0 ? Math.max(...unassignedCats.map(c => c.order || 0)) + 1 : 1;
        } else {
          initialGroupId = prefillGroupId;
          const groupCats = categories.filter(c => c.group_id === prefillGroupId);
          initialOrder = groupCats.length > 0 ? Math.max(...groupCats.map(c => c.order || 0)) + 1 : 1;
        }
      }

      setCatForm({
        title: { en: '', ru: '' },
        description: { en: '', ru: '' },
        order: initialOrder,
        group_id: initialGroupId,
        // No keys at all, so every permission reads as "inherit". An empty
        // object rather than an explicit empty array: `[]` would mean
        // root-only (ADR-1) and would render as an override that is switched
        // ON with no roles ticked — the exact state this bug produced.
        permissions: {}
      });
    }
    setShowCatModal(true);
  };

  // Toggle whether a category overrides a permission (null = inherit from role)
  const toggleCatPermOverride = (permKey) => {
    setCatForm(prev => {
      const perms = { ...prev.permissions };
      if (perms[permKey] !== undefined && perms[permKey] !== null) {
        // was overridden — revert to inherit
        perms[permKey] = null;
      } else {
        // Activate the override pre-ticked with the roles that hold this
        // permission GLOBALLY, so the seeded list mirrors what the forum
        // already grants and saving it unchanged changes nobody's access.
        //
        // The source is `adminRoles`, NOT the `roles` from useAuth(): that one
        // is the public badge registry (roleBadgePayload — role_id/name/rank/
        // color), so `r.permissions` was always `[]` there and the filter
        // matched nobody — the ONLY pre-checked box came from the hardcoded
        // guest push below. This is the same wrong-source bug the role editor
        // hit (see the note in handleOpenRoleModal), one table over.
        //
        // DEFAULT_ROLES is the fallback for an editor without manage_roles,
        // who never loads adminRoles: static defaults still beat an empty
        // pre-tick, and custom roles simply stay unticked for them to pick.
        const source = adminRoles.length > 0 ? adminRoles : DEFAULT_ROLES;
        const roleIds = source
          .filter(r => r.id !== 'root' && normalizePermissions(r.permissions).includes(permKey))
          .map(r => r.id);
        // For VIEW_FORUM specifically, also include 'guest' by default
        if (permKey === PERMISSIONS.VIEW_FORUM && !roleIds.includes('guest')) {
          roleIds.push('guest');
        }
        perms[permKey] = roleIds;
      }
      return { ...prev, permissions: perms };
    });
  };

  const toggleCatPermRole = (permKey, roleId) => {
    setCatForm(prev => {
      const current = Array.isArray(prev.permissions[permKey]) ? prev.permissions[permKey] : [];
      const next = current.includes(roleId)
        ? current.filter(r => r !== roleId)
        : [...current, roleId];
      return { ...prev, permissions: { ...prev.permissions, [permKey]: next } };
    });
  };

  // The admin board keeps its OWN `categories`/`groups` state, fed by one-shot
  // fetches on mount. `refreshForumState` updates a DIFFERENT list — the one in
  // AuthProvider that drives the public main page — so calling it after a
  // mutation left this board rendering the pre-mutation rows until a manual
  // reload. That is why deleting a category left it sitting there.
  //
  // These reload the board's own state from the server, so what the admin sees
  // is what the server actually holds rather than an optimistic guess.
  //
  // The reload reads the ADMIN list, never the public one: only
  // GET /admin/categories carries `allowed_roles`. Re-reading the public list
  // after every save mapped the absent key through toViewOverride into `[]` —
  // "override ON with nobody ticked" — so a category saved as inherit re-opened
  // with the switch flipped, a badge of 1 and every role box empty, and a
  // second Save from that state would have stored root-only ([]). The mount
  // subscription already uses the admin route; this has to match it.
  const reloadCategories = async () => {
    try {
      setCategories(await fetchAdminCategories());
    } catch (err) {
      console.error('[reloadCategories]', err);
    }
  };

  const reloadGroups = async () => {
    try {
      // useCache:false — the cache was written before the mutation, and reading
      // it back would resurrect the deleted row.
      setGroups(await fetchSecuredCategoryGroups({ useCache: false }));
    } catch (err) {
      console.error('[reloadGroups]', err);
    }
  };

  const handleSaveCategory = async () => {
    setCatAttempted(true);

    // Same trimmed guard as handleSaveGroup — see the note there.
    if (!trimmed(catForm.title?.en) && !trimmed(catForm.title?.ru)) {
      revealFirstInvalid([catTitleRef]);
      return;
    }

    // A category outside every group is INVISIBLE on the forum index, not just
    // unstyled: the index renders categories only inside a group. Refuse here
    // rather than let the admin fill in a form that silently produces a category
    // nobody can reach. The server enforces this too — this is the friendly
    // version of the same rule.
    if (!catForm.group_id) {
      revealFirstInvalid([catGroupRef]);
      showToast(t('admin.categories.group_required'), 'danger');
      return;
    }

    setSaving(true);
    try {
      // No role list is computed here any more. "Override off" is stored as the
      // inherit marker (see INHERIT_ROLES in src/api/categories.js), so the
      // server resolves visibility from each caller's own view_forum and a role
      // created later is admitted without anyone re-saving this category.
      if (editingCat) {
        await updateCategory(editingCat, catForm);
      } else {
        await addCategory(catForm);
      }
      await refreshForumState?.(true);
      await reloadCategories();
      showToast(t('admin.categories.toast_saved'), 'success');
      setShowCatModal(false);
    } catch (err) {
      console.error(err);
      showToast(t('admin.categories.error_save'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCategory = (id) => {
    const cat = categories.find(c => c.id === id);
    const topics = cat?.topics_count || 0;

    // The server refuses while topics still reference the category (ADR-7).
    // Topics are hard-deleted with their posts, so this is a real loss and the
    // admin should meet it as a warning with the count, not as a 409 toast.
    if (topics > 0) {
      setBlockedDelete({
        kind: 'category',
        name: resolveTitle(cat?.title),
        items: [],
        summary: t('admin.categories.category_blocked_topics_summary', { topics })
      });
      return;
    }

    setConfirmState({
      show: true,
      title: t('admin.categories.confirm_delete_title'),
      message: t('admin.categories.confirm_delete_message'),
      onConfirm: async () => {
        try {
          await deleteCategory(id, user.uid);
          await refreshForumState?.(true);
          await reloadCategories();
          showToast(t('admin.categories.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          if (conflictFrom(err)) {
            setBlockedDelete({
              kind: 'category',
              name: resolveTitle(cat?.title),
              items: [],
              summary: t('admin.categories.category_blocked_topics_appeared_summary')
            });
            return;
          }
          showToast(t('admin.categories.error_save'), 'danger');
        }
      }
    });
  };

  const handleOpenGroupModal = (group = null) => {
    setGroupAttempted(false);
    if (group) {
      setEditingGroup(group.id);
      setGroupForm({
        title: typeof group.title === 'object' ? { ...group.title } : { en: group.title, ru: group.title },
        order: group.order || 0
      });
    } else {
      setEditingGroup(null);
      setGroupForm({ title: { en: '', ru: '' }, order: groups.length + 1 });
    }
    setShowGroupModal(true);
  };

  const handleSaveGroup = async () => {
    // The click IS the signal that this form should now be judged. After it the
    // fields go red and the button locks, so the admin sees WHY rather than
    // wondering whether the click registered at all.
    setGroupAttempted(true);

    // Defence in depth: the handler can only be reached while the title is
    // filled (the button locks otherwise), but a stale closure or an Enter
    // submit must not slip a blank title to the server.
    if (!trimmed(groupForm.title?.en) && !trimmed(groupForm.title?.ru)) {
      revealFirstInvalid([groupTitleRef]);
      return;
    }
    setSaving(true);
    try {
      if (editingGroup) {
        await updateCategoryGroup(editingGroup, groupForm, user.uid);
      } else {
        await addCategoryGroup(groupForm, user.uid);
      }
      await refreshForumState?.(true);
      await reloadGroups();
      showToast(t('admin.categories.toast_saved'), 'success');
      setShowGroupModal(false);
    } catch (err) {
      console.error(err);
      showToast(t('admin.categories.error_save'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  // Titles are either a legacy {en, ru} map or a plain string depending on which
  // code path produced the record, so every render site handles both. The blocked
  // -delete modal needs the same rule and must not invent a third spelling.
  const resolveTitle = (title) => (typeof title === 'object' && title !== null
    ? (title[currentLang] || title.en || title.ru || '')
    : (title || ''));

  // A 409 means the server found a blocker our local copy did not know about —
  // this list went stale, or the row changed in another tab. Treat it as the same
  // blocked case rather than dumping the server's English sentence into a toast.
  const conflictFrom = (err) => /conflict/i.test(String(err?.status || err?.code || ''))
    || /out of this (group|category)/i.test(String(err?.message || ''));

  const handleDeleteGroup = (id) => {
    const group = groups.find(g => g.id === id);
    const blocking = categories.filter(c => c.group_id === id);

    if (blocking.length > 0) {
      setBlockedDelete({
        kind: 'group',
        name: resolveTitle(group?.title),
        items: blocking.map(c => ({
          id: c.id,
          label: resolveTitle(c.title),
          meta: t('admin.categories.stats', { topics: c.topics_count || 0, posts: c.posts_count || 0 })
        }))
      });
      return;
    }

    setConfirmState({
      show: true,
      title: t('common.confirm_title'),
      message: t('common.confirm_message'),
      onConfirm: async () => {
        try {
          await deleteCategoryGroup(id, user.uid);
          await refreshForumState?.(true);
          await reloadGroups();
          showToast(t('admin.categories.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          if (conflictFrom(err)) {
            setBlockedDelete({
              kind: 'group',
              name: resolveTitle(group?.title),
              items: categories.filter(c => c.group_id === id).map(c => ({
                id: c.id, label: resolveTitle(c.title), meta: ''
              }))
            });
            return;
          }
          showToast(t('admin.categories.error_delete'), 'danger');
        }
      }
    });
  };

  const handleRejectUser = (uid) => {
    setConfirmState({
      show: true,
      title: t('admin.users.confirm_reject_title'),
      message: t('admin.users.confirm_reject_message'),
      onConfirm: async () => {
        try {
          setUsers(prev => prev.filter(u => u.id !== uid));
          await rejectUser(uid, user.uid);
          // Reject deletes the pending account, so the public stats panel
          // (member count, newest member, today's visitors) has to be re-read;
          // this board's local `users` patch does not touch that snapshot.
          await refreshForumState?.(true);
          // Server truth replaces the optimistic patch: the page may have
          // shifted (a rejected account is deleted), and the footer counts
          // come from the next read.
          reloadUsers();
          showToast(t('admin.users.toast_rejected'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.users.error_reject'), 'danger');
        }
      }
    });
  };

  const handleApproveUser = async (uid) => {
    const before = users;
    setUsers(prev => prev.map(u => u.id === uid ? { ...u, status: 'active' } : u));
    try {
      await approveUser(uid, user.uid);
      // Approving flips pending -> active, which is what lets the account start
      // showing up in the online list and today's visitors on the public index.
      await refreshForumState?.(true);
      reloadUsers();
      showToast(t('admin.users.toast_approved'), 'success');
    } catch (err) {
      setUsers(before);
      console.error(err);
      showToast(err?.message || t('admin.users.error_approve'), 'danger');
    }
  };

  const handleBanUser = async (uid) => {
    setConfirmState({
      show: true,
      title: t('admin.users.confirm_ban_title'),
      message: t('admin.users.confirm_ban_message'),
      onConfirm: async () => {
        // Optimistic, then reverted if the write fails. Only `status` changes:
        // the account keeps its role, which is what lets Unban restore it to
        // where it actually was instead of flattening everyone to Player.
        const before = users;
        setUsers(prev => prev.map(u => u.id === uid ? { ...u, status: 'banned' } : u));
        try {
          await banUser(uid, user.uid);
          // A ban changes who the public stats may list (a banned account leaves
          // today's visitors / online), so re-read the shared snapshot.
          await refreshForumState?.(true);
          reloadUsers();
          showToast(t('admin.users.toast_banned'), 'success');
        } catch (err) {
          setUsers(before);
          console.error(err);
          showToast(err?.message || t('admin.users.error_ban'), 'danger');
        }
      }
    });
  };

  const handleUnbanUser = async (uid) => {
    const before = users;
    setUsers(prev => prev.map(u => u.id === uid ? { ...u, status: 'active' } : u));
    try {
      await unbanUser(uid, user.uid);
      // Mirror of the ban path: the account rejoins the population the public
      // stats may list, so the snapshot has to be refreshed.
      await refreshForumState?.(true);
      reloadUsers();
      showToast(t('admin.users.toast_unbanned'), 'success');
    } catch (err) {
      // Without the revert the row would stay banned in the table after a
      // failed write, which reads as "the ban half worked".
      setUsers(before);
      console.error(err);
      showToast(err?.message || t('admin.users.error_ban'), 'danger');
    }
  };

  // handleReauthForTransfer completes a Google sign-in so the server can accept
  // it as proof of identity for an account with no usable password.
  //
  // authWithOAuth2 REPLACES the session, which is normally what you want but is
  // a hazard here: if the provider resolves to a DIFFERENT account, the tab
  // would silently become somebody else — and this dialog is open because the
  // current session is the chief admin. So the previous session is captured and
  // restored when the id does not match, and the caller is told rather than
  // left logged in as a stranger.
  const handleReauthForTransfer = async () => {
    const previousToken = pb.authStore.token;
    const previousRecord = pb.authStore.record;
    try {
      const authData = await pb.collection('users').authWithOAuth2({ provider: 'google' });
      if (authData?.record?.id !== user?.uid) {
        pb.authStore.save(previousToken, previousRecord);
        throw new Error(t('auth.wrong_google_account'));
      }
      return authData;
    } catch (err) {
      // A failed round trip must not leave a half-changed session behind
      // either, so the restore runs for every failure, not just a mismatch.
      if (pb.authStore.record?.id !== user?.uid) {
        pb.authStore.save(previousToken, previousRecord);
      }
      throw err;
    }
  };

  // The handover dialog needs a candidate list that spans the WHOLE table,
  // but the staff table itself holds one server page. When the dialog opens,
  // its own loader walks the pages once — a rare, root-only action that can
  // afford the bounded walk the old table used to pay on every mount. The
  // walk is bounded by the server's own totalPages, so it cannot loop.
  const handleOpenTransferRoot = async () => {
    setShowTransferRoot(true);
    setTransferLoading(true);
    try {
      const rows = [];
      let page = 1;
      for (;;) {
        const res = await fetchAdminUsers({ page });
        // Same normalisation as the table: one mapper for both readers, so
        // the modal cannot receive a row shape the dialog did not expect.
        const items = (res?.items || []).map(u => withLegacyDates(toMembersRow(u)));
        rows.push(...items);
        const totalPages = res?.totalPages ?? 1;
        if (page >= totalPages || items.length === 0) break;
        page += 1;
      }
      setTransferCandidates(rows);
    } catch (err) {
      console.error('[transfer candidates err]', err);
      setTransferCandidates([]);
    } finally {
      setTransferLoading(false);
    }
  };

  const handleTransferRoot = async ({ successorId, password, confirmPhrase }) => {
    setTransferring(true);
    try {
      const res = await transferRoot({ successorId, password, confirmPhrase });
      showToast(t('admin.users.transfer_role_success', { new_root_nickname: res?.new_root_nickname || '' }), 'success');
      setShowTransferRoot(false);
      // The caller is now an admin and this page's role assignment is stale —
      // reload so the badge and the button both change.
      window.location.reload();
    } catch (err) {
      showToast(
        err?.message || t('admin.users.transfer_role_failed'),
        'danger'
      );
    } finally {
      setTransferring(false);
    }
  };

  const handleDeleteUser = (target) => {
    // The subject of the deletion, not just its id: the confirmation has to
    // NAME the account, or a staff member working through a list of a dozen
    // similar nicknames cannot tell which one the dialog is about.
    const uid = target?.id ?? target;
    const nickname = target?.nickname || t('admin.users.unnamed', 'Без имени');
    setDeleteUserPosts(false);
    setConfirmState({
      show: true,
      // Which operation this confirmation is, so the dialog can show the
      // options that belong to it. The alternative — comparing the rendered
      // title against a translated string — breaks the moment the wording
      // changes, and silently drops the checkbox with it.
      kind: 'delete-user',
      title: t('admin.users.confirm_delete_title'),
      message: t('admin.users.confirm_delete_message_named', { nickname }),
      uid,
      onConfirm: async () => {
        try {
          setUsers(prev => prev.filter(u => u.id !== uid));
          await deleteUser(uid, user.uid, { deletePosts: deleteUserPostsRef.current });
          // The stats panel (ForumStats) reads forumStats from AuthProvider —
          // total members, newest member, today's visitors — NOT from this
          // board's local `users` array. Filtering the row here left the shared
          // snapshot naming the deleted account, so navigating back to the index
          // (client-side, no reload) showed "Test" as the newest member over a
          // dead account until a full refresh re-ran the identity effect.
          // Refresh it here like every other mutation on this page does.
          await refreshForumState?.(true);
          reloadUsers();
          showToast(t('admin.users.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.users.error_delete'), 'danger');
        }
      }
    });
  };

  const handleOpenUserModal = (target) => {
    // Refuse to open the editor for an account this viewer may not re-role.
    // The button is already hidden for those rows, but the guard is what keeps
    // the refusal in ONE place: the server enforces the same matrix, and a
    // panel that opens a dialog the server will reject is a lie about what is
    // possible.
    if (!canChangeRoleOf(target?.role)) {
      showToast(t('admin.users.error_role_forbidden'), 'danger');
      return;
    }
    setEditingUser(target);
    setUserForm({ role: target.role || 'player', notifyRoleChange: true });
    setShowUserModal(true);
  };

  const handleSaveUserRole = async () => {
    if (!editingUser) return;
    // Re-checked at SAVE time, not only at open time: the role of the edited
    // account (or of the viewer) can change while the dialog is open, and a
    // request the server will refuse is better never sent than sent and
    // reported as a failure.
    if (!canChangeRoleOf(editingUser.role)) {
      showToast(t('admin.users.error_role_forbidden'), 'danger');
      setShowUserModal(false);
      return;
    }
    // The role being written must also be one this viewer may assign —
    // `root` is transferred, never assigned, and only the chief admin may
    // appoint another administrator.
    if (!assignableRoles.some((r) => r.id === userForm.role)) {
      showToast(t('admin.users.error_role_forbidden'), 'danger');
      return;
    }
    setSaving(true);
    try {
      setUsers(prev => prev.map(u => u.id === editingUser.id ? { ...u, role: userForm.role } : u));
      await updateUserRole(editingUser.id, userForm.role, user.uid, userForm.notifyRoleChange !== false);
      reloadUsers();
      showToast(t('admin.users.toast_role_updated'), 'success');
      setShowUserModal(false);
    } catch (err) {
      console.error(err);
      showToast(t('admin.users.error_role_update'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleOpenRoleModal = (role = null) => {
    setRoleAttempted(false);
    if (role) {
      setEditingRole(role);
      // The form starts from the role's STORED permissions, minus the keys the
      // server would refuse outright.
      //
      // It used to be clamped to MAX_ROLE_PERMISSIONS[role.id] — and for a
      // CUSTOM role that entry does not exist, so the clamp was an empty list
      // and the form opened with nothing checked. Saving that role then wrote
      // an empty permission set: a custom role's powers were erased by
      // opening its own editor and pressing Save. The ceiling is applied where
      // it belongs — the CHECKBOX LIST below, which shows a role only the
      // permissions its base may hold — so nothing above the ceiling is
      // offered, and nothing the role already holds is taken away.
      //
      // The unknown-key filter is what keeps the form saveable: the server
      // refuses a permission key it does not know with a 400, so a stale key
      // from an import would otherwise make the role uneditable.
      setRoleForm({
        name: role.name,
        permissions: normalizePermissions(role.permissions || []).filter(p => KNOWN_PERMISSIONS.has(p)),
        color: role.color || 'primary',
        base_role_id: role.base_role_id || '',
        // 0 means "inherit the forum-wide limit", and the form shows that as
        // an EMPTY field rather than a zero: a zero would read as "this role
        // may hold no masks at all", which is a different thing.
        max_characters_limit: role.max_characters_limit > 0 ? String(role.max_characters_limit) : ''
      });
    } else {
      setEditingRole(null);
      // adminRoles, NOT `roles` from useAuth(). The public registry is
      // roleBadgePayload — role_id/name/rank/color and nothing else — so
      // `roles.find(...).permissions` was always undefined and the form opened
      // with every checkbox empty instead of pre-filled from the base role. The
      // same wrong source sat in the base-role dropdown below, so switching base
      // blanked the list a second time.
      const defaultPlayerRole = adminRoles.find(r => r.id === 'player');
      setRoleForm({
        name: '',
        permissions: defaultPlayerRole
          ? normalizePermissions(defaultPlayerRole.permissions || [])
            .filter(p => MAX_ROLE_PERMISSIONS.player?.includes(p))
          : [],
        color: 'primary',
        base_role_id: 'player',
        // A new role states nothing about masks, so it inherits the
        // forum-wide setting.
        max_characters_limit: ''
      });
    }
    setShowRoleModal(true);
  };

  const handleSaveRole = async () => {
    setRoleAttempted(true);
    if (!trimmed(roleForm.name)) {
      revealFirstInvalid([roleNameRef]);
      return;
    }
    setSaving(true);
    try {
      // The form holds the mask limit as a STRING so it can be empty; the API
      // takes a number, where 0 means "inherit the forum-wide setting".
      // An unparseable value becomes 0 rather than NaN, because NaN would
      // reach the server as a JSON null and land in the column as a silent
      // zero anyway.
      const parsedLimit = Number.parseInt(roleForm.max_characters_limit, 10);
      const rolePayload = {
        ...roleForm,
        max_characters_limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 0
      };
      if (editingRole) {
        // A system role has NO base by definition, but roleForm.base_role_id
        // falls back to the role's own id — it has to, because that field also
        // keys the permission cap below, and for a system role the cap is its
        // own band. Sending that back would be a self-reference, which the
        // server rejects with "a system role cannot have a base role".
        //
        // So the base is omitted from the payload rather than sent as '': the
        // handler only touches the column when the key is present, and a
        // system role must never acquire one however the form is filled in.
        const { base_role_id: _formBase, ...payload } = rolePayload;
        await updateRole(editingRole.id, editingRole.is_system ? payload : rolePayload, user.uid);
      } else {
        await addRole(rolePayload, user.uid);
      }
      // The api layer re-reads the PUBLIC registry and pushes it into AuthProvider,
      // so every badge repaints. This table reads the admin route, which carries
      // the permission list and base role the public one no longer publishes, so
      // it has to be re-read separately or the row would visibly not change.
      await reloadAdminRoles();
      showToast(t('admin.roles.toast_saved'), 'success');
      setShowRoleModal(false);
    } catch (err) {
      console.error(err);
      // The server's message is the actionable one — "rank must be between 1 and
      // 10000", "this role is assigned to 3 account(s) and has no base role to
      // fall back to". The bare 'Error' this used to show told the admin
      // nothing except that something had gone wrong.
      showToast(err?.message || t('common.error'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRole = (id, isSystem) => {
    setConfirmState({
      show: true,
      title: t('admin.roles.confirm_delete_title'),
      message: t('admin.roles.confirm_delete_message'),
      onConfirm: async () => {
        try {
          await deleteRole(id, isSystem, user.uid);
          // Same as the save path: the public registry no longer carries the fields
          // this table renders, so the admin list is what has to be re-read.
          await reloadAdminRoles();
          showToast(t('admin.roles.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          // A deletion is refused for a reason the admin must act on — a
          // category still grants the role, or its holders have no base role
          // to fall back to. Showing the generic 'error_delete' hid which one,
          // and deleteRole used to swallow the server's message entirely.
          showToast(err?.message || t('admin.roles.error_delete'), 'danger');
        }
      }
    });
  };

  const togglePermission = (permId) => {
    setRoleForm(prev => {
      const hasPerm = prev.permissions.includes(permId);
      if (hasPerm) {
        return { ...prev, permissions: prev.permissions.filter(p => p !== permId) };
      } else {
        return { ...prev, permissions: [...prev.permissions, permId] };
      }
    });
  };

  const renderSettings = () => (
    <div className="admin-settings-tab">
      <div className="admin-card admin-card--spacing">
        <div className="admin-card__body">
        <Form>
          <h5 className="mb-4 text-primary">{t('admin.settings.general')}</h5>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="forumNameEn">
                <Form.Label className="fw-bold">{t('admin.settings.forum_name')} (EN)</Form.Label>
                <Form.Control
                  type="text"
                  value={settings.forumName?.en || ''}
                  onChange={(e) => setSettings({ ...settings, forumName: { ...settings.forumName, en: e.target.value } })}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="forumNameRu">
                <Form.Label className="fw-bold">{t('admin.settings.forum_name')} (RU)</Form.Label>
                <Form.Control
                  type="text"
                  value={settings.forumName?.ru || ''}
                  onChange={(e) => setSettings({ ...settings, forumName: { ...settings.forumName, ru: e.target.value } })}
                />
              </Form.Group>
            </Col>
          </Row>

          <Row>
            <Col md={12}>
              <Form.Group className="mb-4" controlId="logoUrl">
                <Form.Label className="fw-bold">{t('admin.settings.logo_url')}</Form.Label>
                <Form.Control
                  type="text"
                  placeholder="https://..."
                  value={settings.logoUrl}
                  onChange={(e) => setSettings({ ...settings, logoUrl: e.target.value })}
                />
              </Form.Group>
            </Col>
          </Row>

          <Row>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="welcomeMsgEn">
                <Form.Label className="fw-bold">{t('admin.settings.welcome_msg')} (EN)</Form.Label>
                <Form.Control
                  as="textarea"
                  rows={3}
                  value={settings.welcomeMessage?.en || ''}
                  onChange={(e) => setSettings({ ...settings, welcomeMessage: { ...settings.welcomeMessage, en: e.target.value } })}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="welcomeMsgRu">
                <Form.Label className="fw-bold">{t('admin.settings.welcome_msg')} (RU)</Form.Label>
                <Form.Control
                  as="textarea"
                  rows={3}
                  value={settings.welcomeMessage?.ru || ''}
                  onChange={(e) => setSettings({ ...settings, welcomeMessage: { ...settings.welcomeMessage, ru: e.target.value } })}
                />
              </Form.Group>
            </Col>
          </Row>

          <hr className="my-5" />
          <h5 className="mb-4 text-primary">{t('admin.settings.features')}</h5>
          <div className="ms-2">
            <Form.Check
              type="switch"
              id="char-switch"
              label={t('admin.settings.enable_characters')}
              className="mb-3 fw-bold"
              checked={settings.enableCharacters}
              onChange={(e) => setSettings({ ...settings, enableCharacters: e.target.checked })}
            />
            {/* The switch is enforced by the SERVER, so the admin deserves to
                know what it actually does — the previous version of this panel
                promised a feature it never switched off. */}
            <div className="small text-muted mb-3 opacity-75" style={{ marginTop: '-0.75rem' }}>
              {t('admin.settings.enable_characters_help')}
            </div>
            <Form.Check
              type="switch"
              id="dice-switch"
              label={t('admin.settings.enable_dice')}
              className="mb-3 fw-bold"
              checked={settings.enableDice}
              onChange={(e) => setSettings({ ...settings, enableDice: e.target.checked })}
            />
            <Form.Check
              type="switch"
              id="rep-switch"
              label={t('admin.settings.enable_reputation')}
              className="mb-3 fw-bold"
              checked={settings.enableReputation}
              onChange={(e) => setSettings({ ...settings, enableReputation: e.target.checked })}
            />
            {settings.enableReputation && (
              <div className="mb-3 rounded" style={{ marginTop: '-0.5rem' }}>
                <Form.Label className="small text-muted fw-bold mb-1 opacity-75">{t('admin.settings.reputation_style')}</Form.Label>
                <Form.Select
                  size="sm"
                  value={settings.reputationStyle || 'both'}
                  onChange={(e) => setSettings({ ...settings, reputationStyle: e.target.value })}
                  style={{ maxWidth: '250px' }}
                >
                  <option value="both">{t('admin.settings.rep_style_both')}</option>
                  <option value="positive_only">{t('admin.settings.rep_style_positive')}</option>
                </Form.Select>
              </div>
            )}
            <Form.Check
              type="switch"
              id="gif-avatar-switch"
              label={t('admin.settings.allow_gif_avatars')}
              className="mb-3 fw-bold"
              checked={settings.allowGifAvatars}
              onChange={(e) => setSettings({ ...settings, allowGifAvatars: e.target.checked })}
            />
            <Form.Check
              type="switch"
              id="gif-post-switch"
              label={t('admin.settings.allow_gif_posts')}
              className="mb-3 fw-bold"
              checked={settings.allowGifInPosts}
              onChange={(e) => setSettings({ ...settings, allowGifInPosts: e.target.checked })}
            />
          </div>

          <hr className="my-5" />
          <h5 className="mb-4 text-primary">{t('admin.settings.backgrounds')}</h5>
          <Row>
            <Col md={12}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.settings.bg_light')}</Form.Label>
                <div className="d-flex align-items-center gap-3">
                  <Form.Control
                    type="text"
                    value={settings.bgLight || ''}
                    onChange={(e) => setSettings({ ...settings, bgLight: e.target.value })}
                  />
                  <div className="d-flex align-items-center gap-2" style={{ minWidth: '220px' }}>
                    <span className="small text-muted text-nowrap">{t('admin.settings.opacity')}:</span>
                    <Form.Range
                      min="0" max="1" step="0.05"
                      value={settings.bgOpacityLight ?? 0.5}
                      onChange={(e) => setSettings({ ...settings, bgOpacityLight: parseFloat(e.target.value) })}
                      style={{ width: '100px' }}
                    />
                    <span className="small fw-bold" style={{ width: '40px', textAlign: 'right' }}>{Math.round((settings.bgOpacityLight ?? 0.5) * 100)}%</span>
                  </div>
                </div>
              </Form.Group>
            </Col>
            <Col md={12}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.settings.bg_dark')}</Form.Label>
                <div className="d-flex align-items-center gap-3">
                  <Form.Control
                    type="text"
                    value={settings.bgDark || ''}
                    onChange={(e) => setSettings({ ...settings, bgDark: e.target.value })}
                  />
                  <div className="d-flex align-items-center gap-2" style={{ minWidth: '220px' }}>
                    <span className="small text-muted text-nowrap">{t('admin.settings.opacity')}:</span>
                    <Form.Range
                      min="0" max="1" step="0.05"
                      value={settings.bgOpacityDark ?? 0.5}
                      onChange={(e) => setSettings({ ...settings, bgOpacityDark: parseFloat(e.target.value) })}
                      style={{ width: '100px' }}
                    />
                    <span className="small fw-bold" style={{ width: '40px', textAlign: 'right' }}>{Math.round((settings.bgOpacityDark ?? 0.5) * 100)}%</span>
                  </div>
                </div>
              </Form.Group>
            </Col>
            <Col md={12}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.settings.bg_neutral')}</Form.Label>
                <div className="d-flex align-items-center gap-3">
                  <Form.Control
                    type="text"
                    value={settings.bgNeutral || ''}
                    onChange={(e) => setSettings({ ...settings, bgNeutral: e.target.value })}
                  />
                  <div className="d-flex align-items-center gap-2" style={{ minWidth: '220px' }}>
                    <span className="small text-muted text-nowrap">{t('admin.settings.opacity')}:</span>
                    <Form.Range
                      min="0" max="1" step="0.05"
                      value={settings.bgOpacityNeutral ?? 0.5}
                      onChange={(e) => setSettings({ ...settings, bgOpacityNeutral: parseFloat(e.target.value) })}
                      style={{ width: '100px' }}
                    />
                    <span className="small fw-bold" style={{ width: '40px', textAlign: 'right' }}>{Math.round((settings.bgOpacityNeutral ?? 0.5) * 100)}%</span>
                  </div>
                </div>
              </Form.Group>
            </Col>
          </Row>

          <hr className="my-5" />
          <h5 className="mb-4 text-primary">{t('admin.settings.identity_placeholders')}</h5>
          <p className="small text-muted mb-3">{t('admin.settings.identity_placeholders_help')}</p>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-3" controlId="deletedAvatar">
                <Form.Label className="fw-bold">{t('admin.settings.placeholder_deleted')}</Form.Label>
                <AvatarUploader
                  value={settings.deletedAvatar || ''}
                  onChange={(url) => setSettings({ ...settings, deletedAvatar: url })}
                  onUpload={(blob, filename) => handleUploadPlaceholder('deleted', blob, filename)}
                  allowGifs={settings.allowGifAvatars !== false}
                  size={80}
                  canUpload={true}
                  disabled={saving}
                />
                {settings.deletedAvatar && (
                  <Button
                    variant="outline-secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => handleResetPlaceholder('deleted')}
                    disabled={saving}
                  >
                    {t('admin.settings.placeholder_reset')}
                  </Button>
                )}
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-3" controlId="guestAvatar">
                <Form.Label className="fw-bold">{t('admin.settings.placeholder_guest')}</Form.Label>
                <AvatarUploader
                  value={settings.guestAvatar || ''}
                  onChange={(url) => setSettings({ ...settings, guestAvatar: url })}
                  onUpload={(blob, filename) => handleUploadPlaceholder('guest', blob, filename)}
                  allowGifs={settings.allowGifAvatars !== false}
                  size={80}
                  canUpload={true}
                  disabled={saving}
                />
                {settings.guestAvatar && (
                  <Button
                    variant="outline-secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => handleResetPlaceholder('guest')}
                    disabled={saving}
                  >
                    {t('admin.settings.placeholder_reset')}
                  </Button>
                )}
              </Form.Group>
            </Col>
          </Row>

          <hr className="my-5" />
          <h5 className="mb-4 text-primary">{t('admin.settings.security')}</h5>
          <Row>
            <Col md={12}>
              <Form.Group className="mb-4" controlId="maxChars">
                <Form.Label className="fw-bold">{t('admin.settings.max_chars')}</Form.Label>
                <Form.Control
                  type="number"
                  value={settings.maxCharsPerPost ?? 15000}
                  onChange={(e) => setSettings({ ...settings, maxCharsPerPost: parseInt(e.target.value) || 0 })}
                />
              </Form.Group>
            </Col>
            <Col md={12}>
              <Form.Group className="mb-4" controlId="postsPerPage">
                <Form.Label className="fw-bold">{t('admin.settings.posts_per_page')}</Form.Label>
                <Form.Control
                  type="number"
                  min="1"
                  max="100"
                  value={settings.postsPerPage ?? 20}
                  onChange={(e) => setSettings({ ...settings, postsPerPage: parseInt(e.target.value) || 20 })}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.settings.posts_per_page_help')}
                </div>
              </Form.Group>
            </Col>
            <Col md={12}>
              <Form.Group className="mb-4" controlId="topicsPerPage">
                <Form.Label className="fw-bold">{t('admin.settings.topics_per_page')}</Form.Label>
                <Form.Control
                  type="number"
                  min="1"
                  max="50"
                  value={settings.topicsPerPage ?? 20}
                  onChange={(e) => setSettings({ ...settings, topicsPerPage: parseInt(e.target.value) || 20 })}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.settings.topics_per_page_help')}
                </div>
              </Form.Group>
            </Col>
            <Col md={12}>
              <Form.Group className="mb-4" controlId="maxCharactersPerUser">
                <Form.Label className="fw-bold">{t('admin.settings.max_characters_per_user')}</Form.Label>
                <Form.Control
                  type="number"
                  min="1"
                  max="100"
                  value={settings.maxCharactersPerUser ?? 10}
                  onChange={(e) => setSettings({ ...settings, maxCharactersPerUser: parseInt(e.target.value) || 10 })}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.settings.max_characters_per_user_help')}
                </div>
              </Form.Group>
            </Col>
            <Col md={12}>
              <Form.Group className="mb-4" controlId="maxPostsPerTopic">
                <Form.Label className="fw-bold">{t('admin.settings.max_posts_per_topic')}</Form.Label>
                <Form.Control
                  type="number"
                  value={settings.maxPostsPerTopic ?? 1000}
                  onChange={(e) => setSettings({ ...settings, maxPostsPerTopic: parseInt(e.target.value) || 1000 })}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.settings.max_posts_per_topic_help')}
                </div>
              </Form.Group>
            </Col>
          </Row>

          <div className="d-flex flex-column gap-3 mb-4">
            <div className="mb-2">
              <Form.Check
                type="switch"
                id="reg-switch"
                label={t('admin.settings.registration')}
                className="fw-bold"
                checked={settings.registrationEnabled}
                onChange={(e) => setSettings({ ...settings, registrationEnabled: e.target.checked })}
              />
            </div>

            {settings.registrationEnabled !== false && (
              <div className="mb-2">
                <Form.Check
                  type="switch"
                  id="approval-switch"
                  label={t('admin.settings.require_approval')}
                  className="fw-bold"
                  checked={settings.requireApproval}
                  onChange={(e) => setSettings({ ...settings, requireApproval: e.target.checked })}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.settings.require_approval_help')}
                </div>
              </div>
            )}

            <div className="mb-2">
              <Form.Check
                type="switch"
                id="whitelist-switch"
                label={t('admin.settings.white_wall')}
                className="fw-bold"
                checked={settings.whitelistMode}
                onChange={(e) => setSettings({ ...settings, whitelistMode: e.target.checked })}
              />
              <div className="small text-muted mt-1 opacity-75">
                {t('admin.settings.white_wall_help')}
              </div>
            </div>

            <div className="mb-2">
              <Form.Check
                type="switch"
                id="maintenance-switch"
                label={t('admin.settings.maintenance')}
                className="text-danger fw-bold"
                checked={settings.maintenanceMode}
                onChange={(e) => setSettings({ ...settings, maintenanceMode: e.target.checked })}
              />
              <div className="small text-muted mt-1 opacity-75">
                {t('admin.settings.maintenance_help')}
              </div>
            </div>

            {settings.maintenanceMode && (
              <div className="ms-4 ps-3 mt-2 border-start border-2 border-danger-subtle">
                <div className="mb-3">
                  <Form.Check
                    type="switch"
                    id="show-maintenance-message-switch"
                    label={t('admin.settings.show_maintenance_message')}
                    className="fw-bold"
                    checked={settings.showMaintenanceMessage ?? false}
                    onChange={(e) => setSettings({ ...settings, showMaintenanceMessage: e.target.checked })}
                  />
                  <div className="small text-muted mt-1 opacity-75">
                    {t('admin.settings.show_maintenance_message_help')}
                  </div>
                </div>

                <Form.Group className="mb-3" controlId="maintenanceMessageEn">
                  <Form.Label className="fw-bold">{t('admin.settings.maintenance_message_label')} (EN)</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={4}
                    value={settings.maintenanceMessage?.en || ''}
                    onChange={(e) => setSettings({ ...settings, maintenanceMessage: { ...settings.maintenanceMessage, en: e.target.value } })}
                    placeholder={t('admin.settings.maintenance_message_placeholder')}
                  />
                </Form.Group>
                <Form.Group className="mb-3" controlId="maintenanceMessageRu">
                  <Form.Label className="fw-bold">{t('admin.settings.maintenance_message_label')} (RU)</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={4}
                    value={settings.maintenanceMessage?.ru || ''}
                    onChange={(e) => setSettings({ ...settings, maintenanceMessage: { ...settings.maintenanceMessage, ru: e.target.value } })}
                    placeholder={t('admin.settings.maintenance_message_placeholder')}
                  />
                  <div className="small text-muted mt-1">
                    {t('admin.settings.maintenance_message_help')}
                  </div>
                </Form.Group>
              </div>
            )}
          </div>

          <hr className="my-5" />
          <h5 className="mb-4 text-primary">{t('admin.settings.design_section')}</h5>
          <div className="ms-2">
            <Form.Check
              type="switch"
              id="custom-design-switch"
              label={t('admin.settings.allow_user_custom_design')}
              className="mb-3 fw-bold"
              checked={settings.allowUserCustomDesign ?? true}
              onChange={(e) => setSettings({ ...settings, allowUserCustomDesign: e.target.checked })}
            />
            <div className="small text-muted mb-4 opacity-75">
              {t('admin.settings.allow_user_custom_design_help')}
            </div>
            <Form.Group className="mb-4" controlId="defaultDesignId" style={{ maxWidth: '400px' }}>
              <Form.Label className="fw-bold">{t('admin.settings.default_design')}</Form.Label>
              <Form.Select
                value={settings.defaultDesignId || ''}
                onChange={(e) => setSettings({ ...settings, defaultDesignId: e.target.value })}
              >
                <option value="">{t('admin.settings.default_design_none')}</option>
                <optgroup label={t('admin.settings.default_design_builtin') || 'Built-in Themes'}>
                  <option value="dark">{t('profile.theme_dark') || 'Dark'}</option>
                  <option value="light">{t('profile.theme_light') || 'Light'}</option>
                  <option value="neutral">{t('profile.theme_neutral') || 'Neutral'}</option>
                </optgroup>
                {designs.filter(d => d.isActive).length > 0 && (
                  <optgroup label={t('admin.settings.default_design_custom') || 'Custom Designs'}>
                    {designs.filter(d => d.isActive).map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </optgroup>
                )}
              </Form.Select>
              <div className="small text-muted mt-1 opacity-75">
                {t('admin.settings.default_design_help')}
              </div>
            </Form.Group>
          </div>

          <Button
            variant="primary"
            className="px-5"
            onClick={handleSaveSettings}
            disabled={saving}
          >
            {saving ? t('admin.settings.saving') : t('admin.settings.save_btn')}
          </Button>
        </Form>
        </div>
      </div>

    <EmailTemplatesSettings
      forumName={settings.forumName?.[currentLang] || settings.forumName?.en || 'Aerun'}
    />
  </div>
);



  const renderUsers = () => {
    // The search runs on the SERVER (`?search=` narrows by nickname before
    // the page is cut), so `users` already holds exactly the rows this page
    // renders — a client-side substring pass here would hide rows the server
    // counted and desync the pagination footer. (An email term matches
    // nothing server-side for the same reason it matched nothing here: the
    // staff endpoint does not serve email addresses.)
    const filteredUsers = users;

    return (
      <div className="admin-users-tab">
        <div className="admin-card">
          <div className="admin-card__header">
            <InputGroup style={{ maxWidth: '400px' }}>
              <InputGroup.Text className="border-end-0 text-muted">
                <Search size={18} />
              </InputGroup.Text>
              <Form.Control
                type="text"
                placeholder={t('common.search_placeholder')}
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="border-start-0 ps-0"
              />
            </InputGroup>
          </div>
          {selectedUserIds.size > 0 && (
            <div className="admin-card__header">
            <div className="d-flex flex-wrap align-items-center gap-2">
              <span className="fw-bold text-muted small">
                {t('admin.users.bulk_selected', { count: selectedUserIds.size })}
              </span>

              {hasPermission(PERMISSIONS.CHANGE_ROLES) && assignableRoles.length > 0 && (
                <Button
                  variant="outline-primary"
                  size="sm"
                  disabled={bulkPending}
                  onClick={() => handleOpenBulkModal('role')}
                >
                  {t('admin.users.bulk_change_role')}
                </Button>
              )}
              {hasPermission(PERMISSIONS.BAN_USERS) && (
                <Button
                  variant={bulkAnyBanned ? 'success' : 'danger'}
                  size="sm"
                  disabled={bulkPending}
                  onClick={() => handleOpenBulkModal(bulkAnyBanned ? 'unban' : 'ban')}
                >
                  {t(bulkAnyBanned ? 'admin.users.bulk_unban' : 'admin.users.bulk_ban')}
                </Button>
              )}
              {hasPermission(PERMISSIONS.DELETE_USERS) && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={bulkPending}
                  onClick={() => handleOpenBulkModal('delete')}
                >
                  {t('admin.users.bulk_delete')}
                </Button>
              )}
              <Button
                variant="outline-secondary"
                size="sm"
                disabled={bulkPending}
                onClick={() => setSelectedUserIds(new Set())}
              >
                {t('admin.users.bulk_clear')}
              </Button>
            </div>
          </div>
        )}
        <div className="admin-card__body">
        <Table hover responsive className="mb-0 overflow-hidden">
          <thead>
            <tr>
              <th style={{ width: '36px' }}>
                {bulkEditable.length > 0 && (
                  <input
                    type="checkbox"
                    className="form-check-input mt-1"
                    ref={(el) => {
                      // React does not map an `indeterminate` prop onto the DOM
                      // property (it is not a reflected attribute), so the
                      // mixed "some selected" state must be set by hand.
                      if (el) el.indeterminate = bulkAny && !bulkAll;
                    }}
                    checked={bulkAll}
                    onChange={toggleBulkAll}
                    aria-label={t('admin.users.table_select')}
                  />
                )}
              </th>
              <th>{t('admin.users.table_user')}</th>
              <th>{t('admin.users.table_role')}</th>
              <th>{t('admin.users.table_status')}</th>
              <th className="text-end">{t('admin.users.table_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 && usersLoading ? (
              <tr>
                <td colSpan={5} className="text-center text-muted py-4">
                  <Spinner animation="border" size="sm" className="me-2" />
                  {t('common.loading')}
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-muted py-4">
                  {t('admin.users.empty')}
                </td>
              </tr>
            ) : filteredUsers.map(u => (
              <tr key={u.id} className="align-middle">
                <td style={{ width: '36px' }} className="select-cell">
                  {canBulkEditUser(u) && (
                    <input
                      type="checkbox"
                      className="form-check-input mt-1"
                      checked={selectedUserIds.has(u.id)}
                      onChange={() => toggleBulkUser(u.id)}
                      aria-label={t('admin.users.table_select')}
                    />
                  )}
                </td>
                <td>
                  <div className="d-flex align-items-center">
                    {/* identityAvatar instead of a bare resolveAvatarUrl: the old
                        markup rendered NOTHING for a user without an avatar, which
                        left the admin table with an invisible gap in front of the
                        nickname. identityAvatar falls back to a generated avatar
                        built from the name, so every row shows the same
                        avatar-plus-nickname pair as the rest of the app. */}
                    <img src={identityAvatar({ name: u.nickname, avatar: u.avatar_url, size: 32 })} alt="" className="rounded-circle me-2" style={{ width: '32px', height: '32px', objectFit: 'cover' }} />
                    <div>
                      <div className="fw-bold">{u.nickname || t('admin.users.unnamed', 'Без имени')}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="d-flex align-items-center gap-1">
                    {isChiefAdmin(u.email, u.role) ? (
                      (() => {
                        const visuals = getRoleVisuals('admin', roles);
                        return (
                          // The chief admin's badge is the SAME chip as the
                          // administrator's — same padding, same type size. It
                          // used to be a class apart (`px-3` / 0.85rem against
                          // `px-2` / 0.8rem), which read as a different badge
                          // rather than a distinguished one.
                          //
                          // `badge-root` is the hook for that distinction: a
                          // theme may mark the office without the panel
                          // inventing a second set of metrics.
                          <Badge
                            bg={visuals.color}
                            className={`role-badge badge-root px-2 ${visuals.isLight ? 'text-dark' : 'text-white'}`}
                            style={{ fontSize: '0.8rem' }}
                          >
                            {visuals.name}
                          </Badge>
                        );
                      })()
                    ) : canChangeRoleOf(u.role) ? (
                      <Button
                        variant="link"
                        className="p-0 text-decoration-none d-inline-flex align-items-center gap-2 group border-0 shadow-none"
                        onClick={() => handleOpenUserModal(u)}
                      >
                        {(() => {
                          const visuals = getRoleVisuals(u.role || 'player', roles);
                          return (
                            <>
                              <Badge bg={visuals.color} className={`role-badge px-2 ${visuals.isLight ? 'text-dark' : 'text-white'}`} style={{ fontSize: '0.8rem' }}>
                                {visuals.name}
                              </Badge>
                              <Edit2 size={12} className="text-muted opacity-50 group-hover-opacity-100 transition-opacity" />
                            </>
                          );
                        })()}
                      </Button>
                    ) : (
                      /* The server would refuse this change — an admin may not
                         touch their own role or an equal-ranked one — so the
                         panel does not offer it. The badge is still shown: the
                         role is information, the pencil is a promise. */
                      (() => {
                        const visuals = getRoleVisuals(u.role || 'player', roles);
                        return (
                          <Badge bg={visuals.color} className={`role-badge px-2 ${visuals.isLight ? 'text-dark' : 'text-white'}`} style={{ fontSize: '0.8rem' }}>
                            {visuals.name}
                          </Badge>
                        );
                      })()
                    )}
                  </div>
                </td>
                <td>
                  {/* The account state lives in `status`, not in the role. The
                      legacy app encoded it as role_id "banned"/"pending"; the
                      target contract split them, and reading role_id here meant
                      a freshly banned account still rendered as Active. */}
                  {u.status !== 'pending' && u.status !== 'banned' && <Badge bg="success">{t('admin.users.status_active')}</Badge>}
                  {u.status === 'pending' && <Badge bg="warning" text="dark">{t('admin.users.status_pending')}</Badge>}
                  {u.status === 'banned' && <Badge bg="danger">{t('admin.users.status_banned')}</Badge>}
                </td>
                <td className="text-end">
                  {!isChiefAdmin(u.email, u.role) && u.id !== user.uid && (
                    <div className="d-flex flex-wrap gap-2 justify-content-end align-items-center">
                      {u.status === 'pending' && (
                        <>
                          {hasPermission(PERMISSIONS.APPROVE_USERS) && (
                            <Button variant="success" size="sm" className="fw-bold text-white text-nowrap" onClick={() => handleApproveUser(u.id)}>
                              <UserCheck size={14} className="me-1" /> {t('admin.users.approve')}
                            </Button>
                          )}
                          {hasPermission(PERMISSIONS.APPROVE_USERS) && (
                            <Button variant="danger" size="sm" className="fw-bold text-white text-nowrap" onClick={() => handleRejectUser(u.id)}>
                              <UserX size={14} className="me-1" /> {t('admin.users.reject')}
                            </Button>
                          )}
                        </>
                      )}
                      {u.status !== 'banned' ? (
                        hasPermission(PERMISSIONS.BAN_USERS) && (
                          <Button variant="link" size="sm" className="text-danger p-0 text-nowrap text-decoration-none ms-md-2" onClick={() => handleBanUser(u.id)}>
                            <UserMinus size={14} className="me-1" /> {t('admin.users.ban')}
                          </Button>
                        )
                      ) : (
                        hasPermission(PERMISSIONS.BAN_USERS) && (
                          <Button variant="link" size="sm" className="text-success p-0 text-nowrap text-decoration-none ms-md-2" onClick={() => handleUnbanUser(u.id)}>
                            {t('admin.users.unban')}
                          </Button>
                        )
                      )}
                      {hasPermission(PERMISSIONS.DELETE_USERS) && (
                        <Button variant="link" size="sm" className="text-danger p-0 text-nowrap text-decoration-none ms-md-2" onClick={() => handleDeleteUser(u)}>
                          <Trash2 size={14} className="me-1" /> {t('admin.users.delete')}
                        </Button>
                      )}
                    </div>
                  )}
                  {isChiefAdmin(u.email, u.role) && (
                    /* The protected badge sits where the actions would be. For
                       the CURRENT chief admin it also offers the handover — it is
                       the one account that can act on it at all. */
                    <div className="d-flex align-items-center gap-2 justify-content-end flex-wrap">
                      <Badge bg="secondary" className="opacity-50">{t('admin.users.protected')}</Badge>
                      {isSelfRoot && (
                        <Button
                          variant="outline-danger"
                          size="sm"
                          className="text-nowrap"
                          onClick={handleOpenTransferRoot}
                        >
                          <ShieldAlert size={14} className="me-1" />
                          {t('admin.users.transfer_role_btn')}
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        </div>
        {/* Server-side pagination: the footer mirrors the response envelope —
            one request renders one page, and `totalItems` is the count of the
            NARROWED set (the search filter applies before the page is cut).
            ForumPagination hides itself when there is a single page. */}
        <div className="admin-card__footer">
          <span className="text-muted small">{t('admin.users.total', { count: usersTotalItems })}</span>
          <ForumPagination
            currentPage={usersPage}
            totalPages={usersTotalPages}
            onPageChange={setUsersPage}
          />
        </div>
        </div>
      </div>
    );
  };

  const renderRoles = () => (
    <div className="admin-roles-tab">
      <div className="admin-card">
        <div className="admin-card__body">
        <div className="d-flex justify-content-between mb-4">
          <h5 className="mb-0">{t('admin.roles.title')}</h5>
          {hasPermission(PERMISSIONS.MANAGE_ROLES) && (
            <Button variant="primary" size="sm" onClick={() => handleOpenRoleModal()}>{t('admin.roles.create_btn')}</Button>
          )}
        </div>
        <Table hover responsive>
          <thead>
            <tr>
              <th>{t('admin.roles.table_name')}</th>
              <th>{t('admin.roles.table_perms')}</th>
              <th className="text-end">{t('admin.roles.table_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const ROLE_ORDER = { admin: 1, moderator: 2, player: 3, spectator: 4 };
              // adminRoles, not the public `roles`: the sort keys off
              // `base_role_id` and the system/custom distinction, and neither is
              // published on the ungated registry any more.
              const sortedRoles = [...adminRoles]
                .filter(r => r.id !== 'root')
                .sort((a, b) => {
                  const rankA = ROLE_ORDER[a.base_role_id || a.id] || 99;
                  const rankB = ROLE_ORDER[b.base_role_id || b.id] || 99;
                  if (rankA !== rankB) return rankA - rankB;
                  // Within same rank, system role (id matches base) comes first
                  const isSystemA = a.id === (a.base_role_id || a.id);
                  const isSystemB = b.id === (b.base_role_id || b.id);
                  if (isSystemA && !isSystemB) return -1;
                  if (!isSystemA && isSystemB) return 1;
                  return a.name.localeCompare(b.name);
                });

              return sortedRoles.map(role => (
                <tr key={role.id} className="align-middle">
                  <td>
                    <Badge bg={role.color || 'primary'} className={`role-badge me-2 ${['warning', 'light'].includes(role.color) ? 'text-dark' : 'text-white'}`}>
                      {role.name}
                    </Badge>
                  </td>
                  <td>
                    <div className="d-flex flex-column gap-2 py-1">
                      {PERMISSION_GROUPS.map(group => {
                        const rolePerms = normalizePermissions(role.permissions || []);
                        const groupPerms = rolePerms.filter(p => group.permissions.includes(p));
                        if (groupPerms.length === 0) return null;

                        return (
                          <div key={group.id} className="d-flex align-items-baseline mb-1">
                            <div className="text-muted fw-bold me-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', opacity: 0.8, width: '120px', flexShrink: 0 }}>
                              {group.name[currentLang] || group.name.en}:
                            </div>
                            <div className="d-flex flex-wrap gap-1">
                              {groupPerms.map(p => (
                                <Badge key={p} bg="secondary" className="role-badge fw-normal" style={{ background: 'var(--bs-gray-700)', color: 'white' }}>
                                  {PERMISSION_LABELS[p]?.[currentLang] || PERMISSION_LABELS[p]?.en || p}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </td>
                  <td className="text-end">
                    {hasPermission(PERMISSIONS.MANAGE_ROLES) && (
                      <>
                        <Button
                          variant="link"
                          size="sm"
                          disabled={!canEditRole(role)}
                          onClick={() => handleOpenRoleModal(role)}
                        >
                          {t('admin.roles.edit')}
                        </Button>
                        {/* System roles are editable but not deletable: they are
                            the templates, and deleting one would leave every
                            custom role derived from it pointing at nothing. */}
                        {!role.is_system && (
                          <Button variant="link" size="sm" disabled={!canEditRole(role)} className={`text-danger ${!canEditRole(role) ? 'opacity-50' : ''}`} onClick={() => handleDeleteRole(role.id, role.is_system)}>
                            {t('admin.roles.delete')}
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ));
            })()}
          </tbody>
        </Table>
        </div>
      </div>
    </div>
  );

  const renderCategories = () => {
    // A category row is only ever drawn UNDER its group (the loop below walks
    // groups and filters by group_id), so with zero groups AND zero categories
    // the table had no rows to show at all — yet it still painted its dark
    // header, and the "unassigned" block below it invented a "General"
    // pseudo-group. Both are replaced by one empty state.
    const showEmptyState = groups.length === 0 && categories.length === 0;

    // Categories whose group_id matches no loaded group. Legacy rows can exist
    // (the server refuses to CREATE one, but imported data may carry them) and
    // the forum index hides them, so the admin board needs a section for them.
    const unassignedCats = categories
      .filter(c => !groups.find(g => g.id === c.group_id))
      .sort((a, b) => a.order - b.order);
    // Drawn ONLY when such rows exist. It used to render whenever there were no
    // groups at all, which put a "General" heading over an empty table — a
    // category that does not exist, invented by the UI.
    const showUnassignedSection = !showEmptyState && unassignedCats.length > 0;

    // Groups exist, but not one category does yet.
    //
    // The categories table's header (Order / Title / Stats / Actions) describes
    // CATEGORY columns, and the only rows it would hold are group separators —
    // so the header labels nothing and the table looks like a populated list
    // whose data failed to load. Groups are listed as blocks instead, each with
    // its own "add a category" call to action.
    const showGroupScaffold = groups.length > 0 && categories.length === 0;

    return (
      <div className="admin-categories-tab">
        <div className="admin-card admin-card--spacing">
          <div className="admin-card__body">
            <div className="d-flex justify-content-between mb-4">
              <h5 className="mb-0">{t('admin.categories.groups_title')}</h5>
              {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
                <Button variant="primary" size="sm" onClick={() => handleOpenGroupModal()}>
                  {t('admin.categories.add_group')}
                </Button>
              )}
            </div>
            {/* An empty <Table> still paints its header row, so a groups table
              with nothing in it read as a populated table whose content failed
              to load. Swapping the table for a block removes that. */}
            {groups.length === 0 ? (
              <div className="admin-empty-state">
                <Layers size={40} strokeWidth={1} className="admin-empty-state__icon" />
                <div className="admin-empty-state__title">{t('admin.categories.groups_empty')}</div>
                <div className="admin-empty-state__desc">{t('admin.categories.groups_empty_desc')}</div>
                {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
                  <Button variant="primary" size="sm" className="mt-2" onClick={() => handleOpenGroupModal()}>
                    <PlusCircle size={14} className="me-1" /> {t('admin.categories.add_group')}
                  </Button>
                )}
              </div>
            ) : (
              <Table hover responsive>
                <thead>
                  <tr>
                    <th style={{ width: '80px' }}>{t('admin.categories.group_order')}</th>
                    <th>{t('admin.categories.group_title_en')}</th>
                    <th>{t('admin.categories.group_title_ru')}</th>
                    <th className="text-end">{t('admin.categories.group_actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(group => (
                    <tr key={group.id} className="align-middle">
                      <td>{group.order}</td>
                      <td>{group.title?.en}</td>
                      <td>{group.title?.ru}</td>
                      <td className="text-end">
                        {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
                          <>
                            <Button variant="link" size="sm" onClick={() => handleOpenGroupModal(group)}>{t('common.edit')}</Button>
                            <Button variant="link" size="sm" className="text-danger" onClick={() => handleDeleteGroup(group.id)}>{t('common.delete')}</Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </div>

        <div className="admin-card">
          <div className="admin-card__body">
            <div className="d-flex justify-content-between mb-4">
              <h5 className="mb-0">{t('admin.categories.title')}</h5>
            </div>
            {showEmptyState ? (
              <div className="admin-empty-state">
                <FolderTree size={40} strokeWidth={1} className="admin-empty-state__icon" />
                <div className="admin-empty-state__title">{t('admin.categories.empty')}</div>
                <div className="admin-empty-state__desc">{t('admin.categories.need_group_first')}</div>
              </div>
            ) : showGroupScaffold ? (
              /* No categories yet, so no table: its header names columns that
                 would hold no rows. Each group gets its own block, which keeps the
                 "add a category" action that the table row used to carry. */
              <div className="admin-group-scaffold">
                {groups.map(group => (
                  <div key={group.id} className="admin-group-scaffold__row">
                    <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                      <Badge bg="secondary" className="admin-group-badge">
                        {t('admin.categories.group_row_label')}
                      </Badge>
                      <span className="fw-bold">
                        {typeof group.title === 'object' ? (group.title[currentLang] || group.title.en) : group.title}
                      </span>
                    </div>
                    <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
                      <span className="small text-muted">{t('admin.categories.scaffold_hint')}</span>
                      {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
                        <Button variant="outline-primary" size="sm" className="d-inline-flex align-items-center flex-shrink-0" onClick={() => handleOpenCatModal(null, group.id)}>
                          <PlusCircle size={14} className="me-1" /> {t('admin.categories.create_btn')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Table hover responsive>
                <thead>
                  <tr>
                    <th style={{ width: '80px' }}>{t('admin.categories.table_order')}</th>
                    <th>{t('admin.categories.table_title')}</th>
                    <th>{t('admin.categories.table_stats')}</th>
                    <th className="text-end">{t('admin.categories.table_actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(group => {
                    const groupCats = categories.filter(c => c.group_id === group.id).sort((a, b) => a.order - b.order);
                    return (
                      <React.Fragment key={group.id}>
                        <tr className="table-active">
                          {/* The badge is what stops this row from reading as a
                          category: its name sits in the Title column, bold, in
                          the same place a category title does — which looked
                          like the group had been duplicated into a category. */}
                          <td colSpan="3" className="align-middle">
                            <div className="d-flex align-items-center gap-2 flex-wrap">
                              <Badge bg="secondary" className="admin-group-badge">
                                {t('admin.categories.group_row_label')}
                              </Badge>
                              <span className="fw-bold">
                                {typeof group.title === 'object' ? (group.title[currentLang] || group.title.en) : group.title}
                              </span>
                            </div>
                          </td>
                          <td className="text-end">
                            {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
                              <Button variant="outline-primary" size="sm" className="d-inline-flex align-items-center" onClick={() => handleOpenCatModal(null, group.id)}>
                                <PlusCircle size={14} className="me-1" /> {t('admin.categories.create_btn')}
                              </Button>
                            )}
                          </td>
                        </tr>
                        {groupCats.length === 0 ? (
                          <tr>
                            <td colSpan="4" className="text-center text-muted py-3 small">
                              {t('admin.categories.group_no_forums')}
                            </td>
                          </tr>
                        ) : groupCats.map(cat => (
                          <tr key={cat.id} className="align-middle">
                            <td>{cat.order}</td>
                            <td>
                              <div className="fw-bold">
                                {resolveTitle(cat.title)}
                              </div>
                              <div className="small text-muted">
                                {typeof cat.description === 'object' ? (cat.description[currentLang] || cat.description.en || cat.description.ru || '') : cat.description}
                              </div>
                            </td>
                            <td>{t('admin.categories.table_stats_combined', { topics: cat.topics_count || 0, posts: cat.posts_count || 0 })}</td>
                            <td className="text-end">
                              {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
                                <>
                                  <Button variant="link" size="sm" onClick={() => handleOpenCatModal(cat)}>{t('common.edit')}</Button>
                                  <Button variant="link" size="sm" className="text-danger" onClick={() => handleDeleteCategory(cat.id)}>{t('common.delete')}</Button>
                                </>
                              )}
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                  {/* Drawn ONLY when such rows exist. This used to render whenever there were
                  no groups at all, which put a "General" heading over an empty
                  table — a category that does not exist, invented by the UI. */}
                  {showUnassignedSection && (
                    <React.Fragment>
                      <tr className="table-active">
                        <td colSpan="3" className="fw-bold text-muted align-middle">
                          {t('admin.categories.group_unassigned')}
                        </td>
                        <td className="text-end">
                          {/* The create button here prefills NO group, and a category with
                            no group is rejected and would be invisible on the forum. So
                            it is offered only once a group exists to place the category
                            into — with zero groups the admin is told to make one instead.
                            This MUST be a JSX comment: a bare // in JSX children is not a
                            comment at all, it renders as literal text. Guarded by
                            scripts/check-jsx-no-line-comments.mjs. */}
                          {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (groups.length > 0 ? (
                            <Button variant="outline-secondary" size="sm" className="d-inline-flex align-items-center" onClick={() => handleOpenCatModal(null, 'unassigned')}>
                              <PlusCircle size={14} className="me-1" /> {t('admin.categories.create_btn')}
                            </Button>
                          ) : (
                            <span className="text-muted small">{t('admin.categories.need_group_first')}</span>
                          ))}
                        </td>
                      </tr>
                      <tr>
                        <td colSpan="4" className="small text-warning">
                          {t('admin.categories.unassigned_warning')}
                        </td>
                      </tr>
                      {unassignedCats.map(cat => (
                        <tr key={cat.id} className="align-middle">
                          <td>{cat.order}</td>
                          <td>
                            <div className="fw-bold">
                              {resolveTitle(cat.title)}
                            </div>
                            <div className="small text-muted">
                              {typeof cat.description === 'object' ? (cat.description[currentLang] || cat.description.en || cat.description.ru || '') : cat.description}
                            </div>
                          </td>
                          <td>{t('admin.categories.table_stats_combined', { topics: cat.topics_count || 0, posts: cat.posts_count || 0 })}</td>
                          <td className="text-end">
                            {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
                              <>
                                <Button variant="link" size="sm" onClick={() => handleOpenCatModal(cat)}>{t('common.edit')}</Button>
                                <Button variant="link" size="sm" className="text-danger" onClick={() => handleDeleteCategory(cat.id)}>{t('common.delete')}</Button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  )}
                </tbody>
              </Table>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderAuditLog = () => {
    // Build helper lookup
    const resolveId = (v) => {
      const usr = users?.find(u => u.id === v);
      if (usr) return usr.nickname || (isRootAdmin ? usr.email : '***');
      if (auditNicknameIndex[v]) return auditNicknameIndex[v];
      const cat = categories?.find(c => c.id === v);
      if (cat) return typeof cat.title === 'object' ? (cat.title[currentLang] || cat.title.en) : (cat.title || cat.name);
      return v.length < 20 ? v : null; // short = readable role id, long = opaque hash
    };

    const pageItems = auditLogs;

    return (
      <div className="admin-audit-tab">
        <div className="admin-card">
          <div className="admin-card__body">
            <div className="d-flex justify-content-between align-items-center mb-3">
              <h5 className="mb-0">{t('admin.audit.title')}</h5>
              <Button
                variant="outline-secondary"
                size="sm"
                className="d-flex align-items-center gap-1"
                onClick={triggerAuditReload}
                disabled={loadingAudit}
                title={t('admin.audit.refresh') || 'Refresh'}
              >
                <RefreshCw size={14} className={loadingAudit ? 'spin' : ''} />
                <span>{t('admin.audit.refresh') || 'Refresh'}</span>
              </Button>
            </div>

            {/* Toolbar */}
            <div className="d-flex flex-wrap gap-2 mb-3 align-items-center">
              <div style={{ flex: '1 1 200px', minWidth: '200px' }}>
                <InputGroup size="sm">
                  <InputGroup.Text><Search size={14} /></InputGroup.Text>
                  <Form.Control
                    placeholder={t('common.search_placeholder')}
                    value={auditSearch}
                    onChange={e => {
                      setAuditSearch(e.target.value);
                      setAuditPage(1);
                    }}
                  />
                </InputGroup>
              </div>
              <Form.Select
                size="sm"
                style={{ width: 'auto' }}
                value={auditActionFilter}
                onChange={e => {
                  setAuditActionFilter(e.target.value);
                  setAuditPage(1);
                }}
              >
                <option value="all">{t('common.all_actions')}</option>
                {AUDIT_ACTION_REGISTRY.map(group => (
                  <optgroup key={group.groupKey} label={t(`admin.audit.${group.groupKey}`)}>
                    {group.actions.map(action => (
                      <option key={action} value={action}>
                        {auditActionLabel(action)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Form.Select>
            </div>

            {debouncedAuditSearch && auditTotal >= 2000 && (
              <div className="alert alert-info py-2 px-3 mb-3 small">
                {t('admin.audit.search_clarify_hint', { count: 2000 })}
              </div>
            )}

            <div className="table-responsive">
              <Table hover responsive>
                <thead>
                  <tr>
                    <th style={{ minWidth: '150px' }}>{t('admin.audit.table_date')}</th>
                    <th>{t('admin.audit.table_performer')}</th>
                    <th>{t('admin.audit.table_action')}</th>
                    <th>{t('admin.audit.table_details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(log => {
                    const performerName = log.performerNickname
                      || users.find(u => u.id === log.performer_id)?.nickname
                      || 'Unknown User';

                    return (
                      <tr key={log.id} className="align-middle">
                        <td className="text-muted small text-nowrap">
                          {log.created_at ? <Timestamp date={log.created_at} /> : '...'}
                        </td>
                        <td>
                          <div className="fw-bold">{performerName}</div>
                        </td>
                        <td>
                          <span className="audit-badge">{auditActionLabel(log.action_type)}</span>
                        </td>
                        <td className="small text-muted" style={{ wordBreak: 'break-word', minWidth: '200px' }}>
                          {log.details && Object.keys(log.details).length > 0 ? (
                            <div className="d-flex flex-column align-items-start gap-1">
                              {Object.entries(log.details)
                                .map(([k, v]) => {
                                  if (v === null || v === undefined || v === '') return null;
                                  const transK = t(`admin.audit.fields.${k}`);
                                  const labelK = transK === `admin.audit.fields.${k}` ? k : transK;

                                  let displayValue = typeof v === 'object' ? JSON.stringify(v) : String(v);

                                  if (typeof v === 'string' && (k.toLowerCase().includes('id') || k.toLowerCase().includes('user'))) {
                                    const resolved = resolveId(v);
                                    if (resolved !== null) {
                                      displayValue = resolved;
                                    }
                                    // иначе оставляем raw `v`: строка показывается всегда — ник, если резолвится, иначе сам id
                                  }

                                  if (k === 'changes' && typeof v === 'object') {
                                    const changedKeys = Object.keys(v).map(ck => t(`admin.audit.fields.${ck}`) || ck);
                                    return (
                                      <div key={k}>
                                        <strong>{labelK}:</strong> {changedKeys.join(', ')}
                                      </div>
                                    );
                                  }

                                  return (
                                    <div key={k}>
                                      <strong>{labelK}:</strong> {displayValue}
                                    </div>
                                  );
                                })}
                              <Button
                                variant="link"
                                size="sm"
                                className="p-0 text-decoration-none text-muted"
                                onClick={() => setSelectedAuditLog(log)}
                              >
                                {t('admin.audit.view_details')}
                              </Button>
                            </div>
                          ) : <span className="opacity-50">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {pageItems.length === 0 && !loadingAudit && (
                    <tr>
                      <td colSpan="4" className="text-center p-4 text-muted">{t('admin.audit.empty')}</td>
                    </tr>
                  )}
                  {loadingAudit && (
                    <tr>
                      <td colSpan="4" className="text-center p-4 text-muted">
                        <Spinner animation="border" size="sm" className="me-2" />
                        {t('common.loading')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </div>

            <div className="d-flex flex-wrap justify-content-between align-items-center mt-3 gap-2">
              <div className="small text-muted">
                {t('admin.audit.entries_count', { count: auditTotal })}
                {auditSearch || auditActionFilter !== 'all' ? ` (${t('admin.audit.filtered_label')})` : ''}
              </div>
              <ForumPagination
                currentPage={auditPage}
                totalPages={auditTotalPages}
                onPageChange={handleAuditPageChange}
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div id="admin-page" className="admin-dashboard-layout">
      {/* Sidebar with Desktop Sticky and Mobile Offcanvas */}
      <AdminSidebar
        groups={visibleNavGroups}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      {/* Main Content Area */}
      <div className="admin-dashboard-content">
        {/* Mobile top toggle bar (visible only on < lg screens) */}
        <div className="admin-mobile-toggle-bar">
          <Button
            variant="outline-secondary"
            size="sm"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label={t('admin.nav.toggleMenu') || 'Open admin navigation'}
          >
            <Menu size={18} className="admin-mobile-toggle-icon" />
            <span>{t('admin.dashboard')}</span>
          </Button>
          <span className="admin-mobile-toggle-current">
            {t(`admin.tabs.${activeTab}`)}
          </span>
        </div>

        <div className="admin-dashboard-body">
          <ForumBreadcrumbs
            items={[
              { label: t('nav.admin'), active: false, link: '/admin' },
              { label: t(`admin.tabs.${activeTab}`), active: true }
            ]}
          />

          {activeTab === 'settings' && hasPermission(PERMISSIONS.MANAGE_FORUM) && renderSettings()}
          {activeTab === 'designs' && hasPermission(PERMISSIONS.MANAGE_DESIGNS) && (
            <DesignsTab
              designs={designs}
              settings={settings}
              updateSettings={(newSettings) => updateGlobalSettings(newSettings, user.uid)}
              userId={user.uid}
            />
          )}
          {activeTab === 'users' && (hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES)) && renderUsers()}
          {activeTab === 'roles' && hasPermission(PERMISSIONS.MANAGE_ROLES) && renderRoles()}
          {activeTab === 'categories' && hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && renderCategories()}
          {activeTab === 'audit' && hasPermission(PERMISSIONS.VIEW_AUDIT_LOG) && renderAuditLog()}
        </div>
      </div>

      {/* Role Modal */}
      <ForumModal
        show={showRoleModal}
        onHide={() => setShowRoleModal(false)}
        title={editingRole ? t('admin.roles.modal_edit') : t('admin.roles.modal_create')}
        size="lg"
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowRoleModal(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSaveRole} disabled={roleSaveDisabled}>
              {saving ? t('admin.settings.saving') : t('admin.roles.save_btn')}
            </Button>
          </>
        }
      >
        <Form>
          <Row>
            <Col md={7}>
              <Form.Group className="mb-4">
                <Form.Label className="fw-bold">{t('admin.roles.modal_name')}</Form.Label>
                <Form.Control
                  ref={roleNameRef}
                  type="text"
                  placeholder="e.g. Master Moderator"
                  value={roleForm.name}
                  onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                  isInvalid={showRoleNameError}
                />
                <Form.Control.Feedback type="invalid">
                  {t('admin.roles.name_required_hint')}
                </Form.Control.Feedback>
              </Form.Group>
            </Col>
            <Col md={5}>
              <Form.Group className="mb-4">
                <Form.Label className="fw-bold">{t('admin.roles.modal_mask_limit')}</Form.Label>
                <Form.Control
                  type="number"
                  min="1"
                  max="100"
                  placeholder={String(settings?.maxCharactersPerUser ?? 10)}
                  value={roleForm.max_characters_limit}
                  onChange={(e) => setRoleForm({ ...roleForm, max_characters_limit: e.target.value })}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.roles.modal_mask_limit_help', { limit: settings?.maxCharactersPerUser ?? 10 })}
                </div>
              </Form.Group>
            </Col>
            {!editingRole && (
              <Col md={5}>
                <Form.Group className="mb-4">
                  <Form.Label className="fw-bold">{t('admin.roles.modal_base_role')}</Form.Label>
                  <Dropdown className="w-100">
                    <Dropdown.Toggle
                      variant="outline-management"
                      className="w-100 d-flex justify-content-between align-items-center custom-select-toggle"
                    >
                      {roleForm.base_role_id === 'admin' ? t('admin.roles.system_roles.admin') :
                        roleForm.base_role_id === 'moderator' ? t('admin.roles.system_roles.moderator') :
                          roleForm.base_role_id === 'spectator' ? t('admin.roles.system_roles.spectator') :
                            t('admin.roles.system_roles.player')}
                    </Dropdown.Toggle>
                    <Dropdown.Menu className="w-100 custom-select-menu shadow-sm">
                      {['player', 'moderator', 'admin', 'spectator'].map(baseId => (
                        <Dropdown.Item
                          key={baseId}
                          active={roleForm.base_role_id === baseId}
                          onClick={() => {
                            // The base role's CURRENT permissions come from adminRoles, the one list that
                            // actually carries them — see the note in handleOpenRoleModal. Reading the
                            // public `roles` here blanked the form a second time on every base change.
                            const template = adminRoles.find(r => r.id === baseId);
                            const allowed = MAX_ROLE_PERMISSIONS[baseId];
                            setRoleForm({
                              ...roleForm,
                              base_role_id: baseId,
                              permissions: template
                                ? normalizePermissions(template.permissions || [])
                                  // Pre-fill exactly what this base may hold, so a
                                  // role cannot start life carrying a key its own
                                  // ceiling forbids — which the save would reject.
                                  .filter(p => !allowed || allowed.includes(p))
                                : roleForm.permissions
                            });
                          }}
                        >
                          {t(`admin.roles.system_roles.${baseId}`)}
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown>
                </Form.Group>
              </Col>
            )}
          </Row>

          <h6 className="fw-bold mb-3">{t('admin.roles.modal_perms')}</h6>
          {PERMISSION_GROUPS.map(group => {
            // A role's own id is its ceiling — guest with empty base_role_id
            // must NOT fall back to 'player' and show every player permission.
            const currentBaseRole = roleForm.base_role_id || editingRole?.id || 'player';
            const allowedPerms = MAX_ROLE_PERMISSIONS[currentBaseRole] || Object.values(PERMISSIONS);
            // What the role ALREADY holds is shown too, even when it sits above
            // its ceiling (an imported or stale role). A permission the admin
            // cannot see is one they can never take away, and a permission they
            // cannot see is also one they cannot account for.
            //
            // So the ceiling governs what may be ADDED, and the stored set
            // governs what is VISIBLE — the two together leave the admin in
            // control of the role instead of guessing at it.
            const storedPerms = (editingRole?.permissions || []).filter(p => KNOWN_PERMISSIONS.has(p));
            const visiblePerms = group.permissions.filter(p => allowedPerms.includes(p) || storedPerms.includes(p));

            if (visiblePerms.length === 0) return null;

            return (
              <div key={group.id} className="mb-4">
                <div className="small fw-bold text-uppercase text-primary mb-2 opacity-90 letter-spacing-1" style={{ fontSize: '0.7rem' }}>
                  {group.name[currentLang] || group.name.en}
                </div>
                <div className="modal-section-themed p-3 rounded mb-2">
                  <Row>
                    {visiblePerms.map(permId => {
                      const isChecked = roleForm.permissions.includes(permId);
                      return (
                        <Col md={6} key={permId} className="mb-2">
                          <Form.Check
                            type="checkbox"
                            id={`perm-${permId}`}
                            label={PERMISSION_LABELS[permId]?.[currentLang] || PERMISSION_LABELS[permId]?.en || permId}
                            checked={isChecked}
                            onChange={() => togglePermission(permId)}
                          />
                        </Col>
                      );
                    })}
                  </Row>
                </div>
              </div>
            )
          })}
        </Form>
      </ForumModal>

      {/* Category Modal */}
      <ForumModal
        show={showCatModal}
        onHide={() => setShowCatModal(false)}
        title={editingCat ? t('admin.categories.modal_edit') : t('admin.categories.modal_create')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowCatModal(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSaveCategory} disabled={catSaveDisabled}>
              {saving ? t('admin.settings.saving') : t('admin.categories.save_btn')}
            </Button>
          </>
        }
        backdropClassName="confirm-modal-backdrop"
      >
        <Form>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.modal_title')} (EN)</Form.Label>
                <Form.Control
                  ref={catTitleRef}
                  type="text"
                  value={catForm.title?.en || ''}
                  onChange={(e) => setCatForm({ ...catForm, title: { ...catForm.title, en: e.target.value } })}
                  isInvalid={showCatTitleError}
                  maxLength={128}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.modal_title')} (RU)</Form.Label>
                <Form.Control
                  type="text"
                  value={catForm.title?.ru || ''}
                  onChange={(e) => setCatForm({ ...catForm, title: { ...catForm.title, ru: e.target.value } })}
                  isInvalid={showCatTitleError}
                  maxLength={128}
                />
                {/* See the group modal: either language alone is a valid title. */}
                <Form.Control.Feedback type="invalid">
                  {t('admin.categories.title_one_required')}
                </Form.Control.Feedback>
              </Form.Group>
            </Col>
          </Row>

          <Row>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.modal_desc')} (EN)</Form.Label>
                <Form.Control
                  as="textarea"
                  rows={2}
                  value={catForm.description?.en || ''}
                  onChange={(e) => setCatForm({ ...catForm, description: { ...catForm.description, en: e.target.value } })}
                  isInvalid={showCatDescError}
                />
                <Form.Control.Feedback type="invalid">
                  {t('admin.categories.desc_too_long')}
                </Form.Control.Feedback>
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.modal_desc')} (RU)</Form.Label>
                <Form.Control
                  as="textarea"
                  rows={2}
                  value={catForm.description?.ru || ''}
                  onChange={(e) => setCatForm({ ...catForm, description: { ...catForm.description, ru: e.target.value } })}
                  isInvalid={showCatDescError}
                />
                <Form.Control.Feedback type="invalid">
                  {t('admin.categories.desc_too_long')}
                </Form.Control.Feedback>
              </Form.Group>
            </Col>
          </Row>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.modal_order')}</Form.Label>
                <Form.Control
                  type="number"
                  value={catForm.order}
                  onChange={(e) => setCatForm({ ...catForm, order: parseInt(e.target.value) || 0 })}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.modal_group_select')}</Form.Label>
                <Form.Select
                  ref={catGroupRef}
                  value={catForm.group_id}
                  onChange={(e) => setCatForm({ ...catForm, group_id: e.target.value })}
                  isInvalid={showCatGroupError}
                >
                  <option value="" disabled>{t('admin.categories.modal_group_select')}...</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>
                      {g.title?.[currentLang] || g.title?.en}
                    </option>
                  ))}
                </Form.Select>
                {/* The server refuses a category without a group, and the forum
                    index would never render it — so this is a real requirement,
                    stated on the field rather than only in a toast after a
                    click. */}
                <Form.Control.Feedback type="invalid">
                  {t('admin.categories.group_required')}
                </Form.Control.Feedback>
              </Form.Group>
            </Col>
          </Row>

          <hr className="my-3" />

          {/* Always visible, at the same level as the rest of the form.
              This was a collapsible panel once, and hiding it was a mistake:
              every toggle inside it defaults to OFF, so an admin who never
              opened it saw a form with no way to tell that permission
              overrides exist at all — and the collapsed control reported
              nothing about the state of the category being edited.

              The heading states what the block IS — an override of the global
              role settings — because "Access Permissions" next to the form's
              own title fields would otherwise read as if this were where access
              is configured at all, rather than as the optional exception layer
              it is. The hint below it repeats the rule in full for the same
              reason. */}
          <div className="admin-perm-overrides">
            <div className="d-flex align-items-center justify-content-between mb-1">
              <span className="fw-bold">{t('admin.categories.perms_override_toggle')}</span>
              {overrideCount > 0 && (
                <Badge bg="warning" text="dark" className="flex-shrink-0">
                  {overrideCount}
                </Badge>
              )}
            </div>
            <p className="text-muted small mb-3">{t('admin.categories.modal_perms_hint')}</p>
            <div id="cat-perm-overrides-panel" className="admin-perm-overrides__panel">
              {[
                { permKey: PERMISSIONS.VIEW_FORUM, label: t('admin.categories.perm_view') },
                { permKey: PERMISSIONS.CREATE_TOPIC, label: t('admin.categories.perm_create_topic') },
                { permKey: PERMISSIONS.POST_REPLY, label: t('admin.categories.perm_post_reply') },
                { permKey: PERMISSIONS.USE_MASKS, label: t('admin.categories.perm_use_masks') },
                { permKey: PERMISSIONS.USE_DICE, label: t('admin.categories.perm_use_dice') },
              ].map(({ permKey, label }) => {
                const isOverridden = catForm.permissions[permKey] !== undefined && catForm.permissions[permKey] !== null;
                const allowedRoles = isOverridden ? (catForm.permissions[permKey] || []) : [];
                const displayRoles = roles.filter(r => r.id !== 'root');
                return (
                  <div key={permKey} className="modal-section-themed p-3 rounded mb-2">
                    <Form.Check
                      type="switch"
                      id={`cat-perm-override-${permKey}`}
                      label={<span className="fw-bold">{label}</span>}
                      checked={isOverridden}
                      onChange={() => toggleCatPermOverride(permKey)}
                      className="mb-2"
                    />
                    {isOverridden && (
                      <>
                        <div className="text-muted small mb-2" style={{ marginLeft: '2rem' }}>
                          {t('admin.categories.perm_allowed_roles')}
                        </div>
                        <div className="d-flex flex-column gap-2" style={{ marginLeft: '2rem' }}>
                          {displayRoles.map(role => (
                            <Form.Check
                              key={role.id}
                              type="checkbox"
                              id={`cat-perm-${permKey}-${role.id}`}
                              label={role.name}
                              checked={allowedRoles.includes(role.id)}
                              onChange={() => toggleCatPermRole(permKey, role.id)}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </Form>
      </ForumModal>

      {/* User Edit Modal */}
      <ForumModal
        show={showUserModal}
        onHide={() => setShowUserModal(false)}
        title={t('admin.users.edit_user_title')}
        footer={
          <Button variant="primary" onClick={handleSaveUserRole} disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
        }
      >
        {editingUser && (
          <Form>
            <div className="mb-4 d-flex align-items-center modal-section-themed p-3 rounded shadow-sm">
              {resolveAvatarUrl(editingUser.avatar_url) && (
                <img
                  src={resolveAvatarUrl(editingUser.avatar_url)}
                  alt=""
                  className="rounded-circle me-3 border border-2 border-card"
                  style={{ width: '48px', height: '48px', objectFit: 'cover' }}
                />
              )}
              <div>
                <div className="fw-bold h5 mb-0" style={{ color: 'var(--primary-color)' }}>
                  {editingUser.nickname || (isRootAdmin ? editingUser.email : '***')}
                </div>
                {isRootAdmin && <div className="small opacity-75">{editingUser.email}</div>}
              </div>
            </div>

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold text-secondary small text-uppercase letter-spacing-1">{t('admin.users.change_role_label')}</Form.Label>
              <div className="d-flex flex-column gap-1">
                {assignableRoles.map(r => (
                  <div
                    key={r.id}
                    className={`p-2 rounded d-flex align-items-center mb-1 cursor-pointer role-radio-container`}
                    style={{
                      border: '1px solid',
                      borderColor: userForm.role === r.id ? 'rgba(var(--primary-rgb), 0.4)' : 'rgba(var(--primary-rgb), 0.12)',
                      background: userForm.role === r.id ? 'rgba(var(--primary-rgb), 0.08)' : 'transparent',
                      transition: 'all 0.15s ease-in-out',
                      opacity: userForm.role === r.id ? 1 : 0.8
                    }}
                    onClick={() => setUserForm({ ...userForm, role: r.id })}
                    onMouseEnter={(e) => {
                      if (userForm.role !== r.id) {
                        e.currentTarget.style.borderColor = 'rgba(var(--primary-rgb), 0.25)';
                        e.currentTarget.style.opacity = '1';
                        e.currentTarget.style.background = 'rgba(var(--primary-rgb), 0.03)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (userForm.role !== r.id) {
                        e.currentTarget.style.borderColor = 'rgba(var(--primary-rgb), 0.12)';
                        e.currentTarget.style.opacity = '0.8';
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    <Form.Check
                      type="radio"
                      id={`role-radio-${r.id}`}
                      name="userRole"
                      checked={userForm.role === r.id}
                      onChange={() => setUserForm({ ...userForm, role: r.id })}
                      className="mb-0 me-2"
                    />
                    <label htmlFor={`role-radio-${r.id}`} className="mb-0 cursor-pointer flex-grow-1">
                      <Badge bg={r.color || 'primary'} className={`role-badge px-3 ${['warning', 'light', 'management'].includes(r.color) ? 'text-dark' : 'text-white'}`} style={{ fontSize: '0.85rem' }}>
                        {r.name}
                      </Badge>
                    </label>
                  </div>
                ))}
              </div>
            </Form.Group>

            <Form.Group className="mb-1">
              <Form.Check
                type="checkbox"
                id="notify-role-change-checkbox"
                label={t('admin.users.notify_role_change_label')}
                checked={userForm.notifyRoleChange !== false}
                onChange={(e) => setUserForm({ ...userForm, notifyRoleChange: e.target.checked })}
              />
            </Form.Group>
          </Form>
        )}
      </ForumModal>

      {/* Bulk action confirmation modal — shows every selected nickname and lets
         the viewer drop anyone they accidentally picked before confirming. */}
      <ForumModal
        show={bulkModalOpen}
        onHide={handleCloseBulkModal}
        title={bulkAction ? bulkModalTitle() : t('common.confirm_title')}
        footer={
          <>
            <Button
              variant="outline-secondary"
              onClick={handleCloseBulkModal}
              disabled={bulkPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleBulkConfirm}
              disabled={bulkPending || (bulkAction === 'role' && !bulkRoleId) || effectiveBulkIds.length > adminBulkMaxIds}
            >
              {bulkPending ? t('common.loading') : t('admin.users.bulk_do')}
            </Button>
          </>
        }
      >
        <div className="mb-3">
          <Form.Label className="fw-bold text-secondary small text-uppercase letter-spacing-1">
            {t('admin.users.bulk_modal_users_label')}
          </Form.Label>
          <div className="d-flex flex-wrap gap-2" style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid rgba(var(--bs-gray-rgb),0.2)', padding: '8px', borderRadius: '6px', background: 'rgba(var(--bs-gray-rgb),0.03)' }}>
            {effectiveBulkIds.map(id => {
              // The row may not be on the CURRENT page (selection persists
              // across pages, §8.2) — the snapshot keeps it visible and
              // removable here regardless.
              const u = bulkSelectionSnap[id] || users.find(x => x.id === id);
              if (!u) return null;
              return (
                <div key={id} className="d-flex align-items-center gap-2 px-2 py-1 rounded border shadow-sm" style={{ background: 'rgba(var(--bs-gray-rgb), 0.08)' }}>
                  <img
                    src={identityAvatar({ name: u.nickname, avatar: u.avatar_url, size: 24 })}
                    alt=""
                    className="rounded-circle"
                    style={{ width: '24px', height: '24px', objectFit: 'cover' }}
                  />
                  <span className="small">{u.nickname || t('admin.users.unnamed', 'Без имени')}</span>
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 text-danger opacity-60 hover-opacity-100"
                    onClick={() => handleRemoveFromBulkSelection(id)}
                    aria-label={t('admin.users.bulk_modal_remove_user')}
                  >
                    <span className="visually-hidden">{t('admin.users.bulk_modal_remove_user')}</span>
                    &times;
                  </Button>
                </div>
              );
            })}
            {effectiveBulkIds.length === 0 && (
              <span className="text-muted small">{t('admin.users.bulk_modal_none_left', 'Никто не выбран')}</span>
            )}
          </div>
        </div>

        {effectiveBulkIds.length > adminBulkMaxIds && (
          <div className="small text-danger mb-2">
            {t('admin.users.bulk_modal_too_many', { count: effectiveBulkIds.length })}
          </div>
        )}

        {bulkAction === 'role' && (
          <>
            <Form.Group className="mb-3">
              <Form.Label className="fw-bold text-secondary small text-uppercase letter-spacing-1">
                {t('admin.users.bulk_modal_role_label')}
              </Form.Label>
              <div className="d-flex flex-column gap-1">
                {assignableRoles.map(r => (
                  <div
                    key={r.id}
                    className={`p-2 rounded d-flex align-items-center mb-1 cursor-pointer role-radio-container`}
                    style={{
                      border: '1px solid',
                      borderColor: bulkRoleId === r.id ? 'rgba(var(--primary-rgb), 0.4)' : 'rgba(var(--primary-rgb), 0.12)',
                      background: bulkRoleId === r.id ? 'rgba(var(--primary-rgb), 0.08)' : 'transparent',
                      transition: 'all 0.15s ease-in-out',
                      opacity: bulkRoleId === r.id ? 1 : 0.8
                    }}
                    onClick={() => setBulkRoleId(r.id)}
                  >
                    <Form.Check
                      type="radio"
                      id={`bulk-role-radio-${r.id}`}
                      name="bulkUserRole"
                      checked={bulkRoleId === r.id}
                      onChange={() => setBulkRoleId(r.id)}
                      className="mb-0 me-2"
                    />
                    <label htmlFor={`bulk-role-radio-${r.id}`} className="mb-0 cursor-pointer flex-grow-1">
                      <Badge bg={r.color || 'primary'} className={`role-badge px-3 ${['warning', 'light', 'management'].includes(r.color) ? 'text-dark' : 'text-white'}`} style={{ fontSize: '0.85rem' }}>
                        {r.name}
                      </Badge>
                    </label>
                  </div>
                ))}
              </div>
            </Form.Group>
            <Form.Group className="mb-0">
              <Form.Check
                type="checkbox"
                id="bulk-modal-notify-role-change"
                label={t('admin.users.notify_role_change_label')}
                checked={bulkRoleNotifyChange !== false}
                onChange={(e) => setBulkRoleNotifyChange(e.target.checked)}
              />
            </Form.Group>
          </>
        )}

        {bulkAction === 'delete' && (
          <Form.Group className="mb-1">
            <Form.Check
              type="checkbox"
              id="bulk-modal-delete-posts"
              label={t('admin.users.bulk_modal_delete_posts')}
              checked={bulkDeletePosts}
              onChange={(e) => setBulkDeletePosts(e.target.checked)}
            />
          </Form.Group>
        )}

        {bulkAction === 'delete' && bulkDeletePosts && (
          <div className="small text-danger">{t('admin.users.bulk_modal_delete_warning')}</div>
        )}
        {bulkAction === 'delete' && bulkDeletePosts && (
          <div className={bulkContentCountLoading || !bulkContentCount ? 'text-muted small' : 'small text-danger'}>
            {bulkContentCountLoading
              ? t('admin.users.delete_posts_counting')
              : bulkContentCount
                ? t('admin.users.bulk_delete_posts_count', { topics: bulkContentCount.topics, posts: bulkContentCount.posts })
                : null}
          </div>
        )}
      </ForumModal>

      <ConfirmModal
        show={confirmState.show}
        onHide={() => {
          setDeleteUserPosts(false);
          setConfirmState(prev => ({ ...prev, show: false }));
        }}
        onConfirm={confirmState.onConfirm}
        title={confirmState.title}
        message={confirmState.message}
      >
        {/* The "delete their posts too" option belongs INSIDE this dialog.
            It used to be rendered as a sibling of the modal, so while the
            dialog was open the checkbox sat behind the backdrop where it
            could not be reached — the option existed and was unreachable. */}
        {confirmState.kind === 'delete-user' && (
          <>
            <label className="d-block mb-2 mt-3">
              <input
                type="checkbox"
                checked={deleteUserPosts}
                onChange={e => {
                  setDeleteUserPosts(e.target.checked);
                  deleteUserPostsRef.current = e.target.checked;
                }}
                className="form-check-input me-2"
              />
              {t('admin.users.delete_posts_label')}
            </label>
            <p className="text-muted small mb-0">
              {t('admin.users.delete_posts_hint')}
            </p>
              {deleteUserPosts && (
                <p className={deleteContentCountLoading || !deleteContentCount ? 'text-muted small mb-0' : 'small text-danger mb-0'}>
                  {deleteContentCountLoading
                    ? t('admin.users.delete_posts_counting')
                    : deleteContentCount
                      ? t('admin.users.delete_posts_count', { topics: deleteContentCount.topics, posts: deleteContentCount.posts })
                      : null}
                </p>
              )}
          </>
        )}
      </ConfirmModal>

      {/* A delete the server would refuse. Rendered instead of firing a request
          that can only fail, and it names the blockers so the admin knows what to
          clear first. No confirm button: there is no valid action to take here. */}
      <ConfirmModal
        show={!!blockedDelete}
        onHide={() => setBlockedDelete(null)}
        onConfirm={() => { }}
        hideConfirm
        confirmText=""
        cancelText={t('common.got_it')}
        title={t('common.cannot_delete')}
        message={blockedDelete?.summary || (
          blockedDelete?.kind === 'group'
            ? t('admin.categories.group_still_holds_categories', { name: blockedDelete?.name })
            : ''
        )}
      >
        {blockedDelete?.items?.length > 0 && (
          <ul className="list-unstyled mt-3 mb-0 small">
            {blockedDelete.items.map(it => (
              <li
                key={it.id}
                className="d-flex justify-content-between gap-3 py-2 border-top"
              >
                <span className="fw-semibold">{it.label}</span>
                {it.meta && <span className="text-muted text-nowrap">{it.meta}</span>}
              </li>
            ))}
          </ul>
        )}
      </ConfirmModal>

      {/* Audit Log Details Modal (§3 of SPEC_REFACTOR_AUDIT_LOGS.md) */}
      <AuditDetailsModal
        show={!!selectedAuditLog}
        onHide={() => setSelectedAuditLog(null)}
        log={selectedAuditLog}
        users={users}
        categories={categories}
        currentLang={currentLang}
        isRootAdmin={isRootAdmin}
        auditActionLabel={auditActionLabel}
      />

      {/* Group Modal */}
      <ForumModal
        show={showGroupModal}
        onHide={() => setShowGroupModal(false)}
        title={editingGroup ? t('admin.categories.modal_group_edit') : t('admin.categories.modal_group_create')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowGroupModal(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSaveGroup} disabled={groupSaveDisabled}>
              {saving ? t('admin.settings.saving') : t('common.save')}
            </Button>
          </>
        }
      >
        <Form>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.group_title_en')}</Form.Label>
                <Form.Control
                  ref={groupTitleRef}
                  type="text"
                  value={groupForm.title?.en || ''}
                  onChange={(e) => setGroupForm({ ...groupForm, title: { ...groupForm.title, en: e.target.value } })}
                  isInvalid={showGroupError}
                  maxLength={128}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-3">
                <Form.Label className="fw-bold">{t('admin.categories.group_title_ru')}</Form.Label>
                <Form.Control
                  type="text"
                  value={groupForm.title?.ru || ''}
                  onChange={(e) => setGroupForm({ ...groupForm, title: { ...groupForm.title, ru: e.target.value } })}
                  isInvalid={showGroupError}
                  maxLength={128}
                />
                {/* Both fields are flagged while NEITHER is filled, because either
                    one alone is valid. Marking only EN would be a lie about what
                    the form accepts. */}
                <Form.Control.Feedback type="invalid">
                  {t('admin.categories.group_title_one_required')}
                </Form.Control.Feedback>
              </Form.Group>
            </Col>
          </Row>
          <Form.Group className="mb-3">
            <Form.Label className="fw-bold">{t('admin.categories.group_order')}</Form.Label>
            <Form.Control
              type="number"
              value={groupForm.order}
              onChange={(e) => setGroupForm({ ...groupForm, order: parseInt(e.target.value) || 0 })}
            />
          </Form.Group>
        </Form>
      </ForumModal>

      {/* The root handover lives with the members table because that is where
          the protected chief admin already shows up — the button appears on
          that row, for that account only. */}
      <TransferRootModal
        show={showTransferRoot}
        onHide={() => setShowTransferRoot(false)}
        candidates={transferCandidates}
        onConfirm={handleTransferRoot}
        busy={transferring || transferLoading}
        currentNickname={user?.displayName || user?.name || ''}
        currentUserId={user?.uid || ''}
        onReauthWithGoogle={handleReauthForTransfer}
      />
    </div>
  );
};

export default AdminPage;
