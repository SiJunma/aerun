import React, { useState, useEffect, useCallback } from 'react';
import { Container, Row, Col, Card, Nav, Form, Button, Table, Badge, Dropdown, Modal } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useSearchParams } from 'react-router-dom';
import {
  getGlobalSettings, updateGlobalSettings, approveUser, rejectUser, deleteUser, banUser, unbanUser,
  updateUserRole, addRole, updateRole, deleteRole
} from '../api/admin';
import { subscribeToCategories, addCategory, updateCategory, deleteCategory, subscribeToCategoryGroups, addCategoryGroup, updateCategoryGroup, deleteCategoryGroup } from '../api/categories';
import { subscribeToAllUsers } from '../api/auth-resources';
import { subscribeToAuditLogs, getMoreAuditLogs } from '../api/audit';
import { MAX_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_LABELS, DEFAULT_ROLES, getRoleVisuals, isChiefAdmin, normalizePermissions, PERMISSION_GROUPS } from '../constants/permissions';
import Timestamp from '../components/common/Timestamp';
import { InputGroup } from 'react-bootstrap';
import ForumModal from '../components/common/ForumModal';
import {
  UserCheck, UserMinus, UserX, PlusCircle, Edit2, Trash2,
  Search, Award, Pin, Lock, Settings, MessageSquareOff,
  Bell, BellOff, ArrowRightLeft, Send, FilePen, User
} from 'lucide-react';
import { useAuth } from '../contexts/AuthProvider';
import ConfirmModal from '../components/common/ConfirmModal';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumPagination from '../components/common/ForumPagination';
import { useToast } from '../contexts/ToastProvider';

const AdminPage = () => {
  const { t, lang: currentLang } = useI18n();
  const { user, hasPermission, roles, isRootAdmin } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'settings';
  const setActiveTab = useCallback((k) => setSearchParams({ tab: k }, { replace: true }), [setSearchParams]);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState([]);
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [userSearch, setUserSearch] = useState('');

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
  const [roleForm, setRoleForm] = useState({ name: '', permissions: [], color: 'primary' });

  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({ role_id: '' });


  // Confirm Modal State
  const [confirmState, setConfirmState] = useState({
    show: false,
    onConfirm: () => { },
    title: '',
    message: ''
  });

  // Audit Log State
  const [auditLogs, setAuditLogs] = useState([]);
  const [selectedAuditLog, setSelectedAuditLog] = useState(null);
  const [lastAuditDoc, setLastAuditDoc] = useState(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [hasMoreAudit, setHasMoreAudit] = useState(true);
  const [auditSearch, setAuditSearch] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('all');
  const [auditSortDesc, setAuditSortDesc] = useState(true);
  const [auditPage, setAuditPage] = useState(1);
  const AUDIT_PAGE_SIZE = 25;

  // Tab permissions check
  const canAccessTab = useCallback((tab) => {
    switch (tab) {
      case 'settings': return hasPermission(PERMISSIONS.MANAGE_FORUM);
      case 'users': return hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES);
      case 'roles': return hasPermission(PERMISSIONS.MANAGE_ROLES);
      case 'categories': return hasPermission(PERMISSIONS.MANAGE_CATEGORIES);
      case 'audit': return hasPermission(PERMISSIONS.VIEW_AUDIT_LOG);
      default: return false;
    }
  }, [hasPermission]);

  useEffect(() => {
    if (!canAccessTab(activeTab)) {
      const tabs = ['settings', 'users', 'roles', 'categories', 'audit'];
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
    maxUploadSize: 500,
    maxCharsPerPost: 15000,
    maintenanceMode: false,
    welcomeMessage: { en: 'Welcome to our TTRPG home!', ru: 'Добро пожаловать в наш дом TTRPG!' },
    enableReputation: true,
    reputationStyle: 'both',
    enableCharacters: true,
    enableDice: true,
    allowGifAvatars: true,
    allowGifInPosts: true,
    whitelistMode: true,
    requireApproval: true,
    logoUrl: '',
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
          registrationEnabled: data.registrationEnabled ?? true,
          maintenanceMode: data.maintenanceMode ?? false,
          maxUploadSize: data.maxUploadSize ?? 500,
          maxCharsPerPost: data.maxCharsPerPost ?? 15000,
          whitelistMode: data.whitelistMode ?? false,
          requireApproval: data.requireApproval ?? true,
          enableCharacters: data.enableCharacters ?? true,
          enableDice: data.enableDice ?? true,
          enableReputation: data.enableReputation ?? true,
          reputationStyle: data.reputationStyle || 'both',
          allowGifAvatars: data.allowGifAvatars ?? true,
          allowGifInPosts: data.allowGifInPosts ?? true,
          logoUrl: data.logoUrl || '',
          bgLight: data.bgLight || 'https://images.unsplash.com/photo-1458668383970-8ddd3927deed?q=80&w=1400&auto=format&fit=crop',
          bgDark: data.bgDark || 'https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop',
          bgNeutral: data.bgNeutral || 'https://images.unsplash.com/photo-1675636173835-657f72144c77?q=80&w=1400&auto=format&fit=crop'
        };
        setSettings(migrated);
      }
    });
    const unsubCats = subscribeToCategories(setCategories);
    const unsubGroups = subscribeToCategoryGroups(setGroups);
    const unsubUsers = subscribeToAllUsers(setUsers);

    return () => {
      unsubSettings();
      unsubCats();
      unsubGroups();
      unsubUsers();
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'audit' && hasPermission(PERMISSIONS.VIEW_AUDIT_LOG)) {
      setLoadingAudit(true);
      const unsub = subscribeToAuditLogs(200, (data, lastDoc) => {
        setAuditLogs(data);
        setLastAuditDoc(lastDoc);
        setHasMoreAudit(data.length >= 200);
        setLoadingAudit(false);
      });
      return () => unsub();
    }
  }, [activeTab, hasPermission]);

  const handleLoadMoreAudit = async () => {
    if (!lastAuditDoc || !hasMoreAudit) return;
    setLoadingAudit(true);
    try {
      const { logs, lastDoc: newLastDoc } = await getMoreAuditLogs(lastAuditDoc, 200);
      setAuditLogs(prev => [...prev, ...logs]);
      setLastAuditDoc(newLastDoc);
      if (logs.length < 200) setHasMoreAudit(false);
    } catch (err) {
      console.error('Failed to load more audit logs', err);
    } finally {
      setLoadingAudit(false);
    }
  };

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

  const handleOpenCatModal = (cat = null) => {
    if (cat) {
      setEditingCat(cat.id);
      setCatForm({
        title: typeof cat.title === 'object' ? { ...cat.title } : { en: cat.title, ru: cat.title },
        description: typeof cat.description === 'object' ? { ...cat.description } : { en: cat.description, ru: cat.description },
        order: cat.order || 0,
        group_id: cat.group_id || '',
        permissions: cat.permissions || {}
      });
    } else {
      setEditingCat(null);
      // Build a default VIEW_FORUM override that includes all roles with that permission
      // plus 'guest' so new categories are visible to guests by default
      const defaultViewRoles = [
        ...roles
          .filter(r => r.id !== 'root' && r.permissions?.includes(PERMISSIONS.VIEW_FORUM))
          .map(r => r.id),
        'guest'
      ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate
      setCatForm({
        title: { en: '', ru: '' },
        description: { en: '', ru: '' },
        order: categories.length + 1,
        group_id: groups[0]?.id || '',
        permissions: {
          [PERMISSIONS.VIEW_FORUM]: defaultViewRoles
        }
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
        // activate override with roles that currently have this permission globally
        // This prevents accidentally giving spectators/guests write access when toggling on an override.
        const roleIds = roles
          .filter(r => r.id !== 'root' && r.permissions?.includes(permKey))
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

  const handleSaveCategory = async () => {
    if (!catForm.title?.en && !catForm.title?.ru) return;
    setSaving(true);
    try {
      if (editingCat) {
        await updateCategory(editingCat, catForm, user.uid);
      } else {
        await addCategory(catForm, user.uid);
      }
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
    setConfirmState({
      show: true,
      title: t('admin.categories.confirm_delete_title'),
      message: t('admin.categories.confirm_delete_message'),
      onConfirm: async () => {
        try {
          await deleteCategory(id, user.uid);
          showToast(t('admin.categories.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.categories.error_save'), 'danger');
        }
      }
    });
  };

  const handleOpenGroupModal = (group = null) => {
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
    if (!groupForm.title?.en && !groupForm.title?.ru) return;
    setSaving(true);
    try {
      if (editingGroup) {
        await updateCategoryGroup(editingGroup, groupForm, user.uid);
      } else {
        await addCategoryGroup(groupForm, user.uid);
      }
      showToast(t('admin.categories.toast_saved'), 'success');
      setShowGroupModal(false);
    } catch (err) {
      console.error(err);
      showToast(t('admin.categories.error_save'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteGroup = (id) => {
    setConfirmState({
      show: true,
      title: t('common.confirm_title'),
      message: t('common.confirm_message'),
      onConfirm: async () => {
        try {
          await deleteCategoryGroup(id, user.uid);
          showToast(t('admin.categories.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
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
          await rejectUser(uid, user.uid);
          showToast(t('admin.users.toast_rejected'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.users.error_reject'), 'danger');
        }
      }
    });
  };

  const handleApproveUser = async (uid) => {
    try {
      await approveUser(uid, user.uid);
      showToast(t('admin.users.toast_approved'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.users.error_approve'), 'danger');
    }
  };

  const handleBanUser = async (uid) => {
    setConfirmState({
      show: true,
      title: t('admin.users.confirm_ban_title'),
      message: t('admin.users.confirm_ban_message'),
      onConfirm: async () => {
        try {
          await banUser(uid, user.uid);
          showToast(t('admin.users.toast_banned'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.users.error_ban'), 'danger');
        }
      }
    });
  };

  const handleUnbanUser = async (uid) => {
    try {
      await unbanUser(uid, user.uid);
      showToast(t('admin.users.toast_unbanned'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.users.error_ban'), 'danger');
    }
  };

  const handleDeleteUser = (uid) => {
    setConfirmState({
      show: true,
      title: t('admin.users.confirm_delete_title'),
      message: t('admin.users.confirm_delete_message'),
      onConfirm: async () => {
        try {
          await deleteUser(uid, user.uid);
          showToast(t('admin.users.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.users.error_delete'), 'danger');
        }
      }
    });
  };

  const handleOpenUserModal = (user) => {
    setEditingUser(user);
    setUserForm({ role_id: user.role_id || 'player' });
    setShowUserModal(true);
  };

  const handleSaveUserRole = async () => {
    if (!editingUser) return;
    setSaving(true);
    try {
      await updateUserRole(editingUser.id, userForm.role_id, user.uid);
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
    if (role) {
      setEditingRole(role);
      setRoleForm({
        name: role.name,
        permissions: normalizePermissions(role.permissions || []),
        color: role.color || 'primary',
        base_role_id: role.base_role_id || role.id
      });
    } else {
      setEditingRole(null);
      const defaultPlayerRole = DEFAULT_ROLES.find(r => r.id === 'player');
      setRoleForm({
        name: '',
        permissions: defaultPlayerRole ? [...defaultPlayerRole.permissions] : [],
        color: 'primary',
        base_role_id: 'player'
      });
    }
    setShowRoleModal(true);
  };

  const handleSaveRole = async () => {
    if (!roleForm.name) return;
    setSaving(true);
    try {
      if (editingRole) {
        await updateRole(editingRole.id, roleForm, user.uid);
      } else {
        await addRole(roleForm, user.uid);
      }
      showToast(t('admin.roles.toast_saved'), 'success');
      setShowRoleModal(false);
    } catch (err) {
      console.error(err);
      showToast('Error', 'danger');
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
          showToast(t('admin.roles.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.roles.error_delete'), 'danger');
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
    <Card className="shadow-sm border-0">
      <Card.Body className="p-4">
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
          <h5 className="mb-4 text-primary">{t('admin.settings.security')}</h5>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="maxUpload">
                <Form.Label className="fw-bold">{t('admin.settings.max_upload')}</Form.Label>
                <Form.Control
                  type="number"
                  value={settings.maxUploadSize}
                  onChange={(e) => setSettings({ ...settings, maxUploadSize: parseInt(e.target.value) })}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="maxChars">
                <Form.Label className="fw-bold">{t('admin.settings.max_chars')}</Form.Label>
                <Form.Control
                  type="number"
                  value={settings.maxCharsPerPost ?? 15000}
                  onChange={(e) => setSettings({ ...settings, maxCharsPerPost: parseInt(e.target.value) || 0 })}
                />
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
                label={t('admin.settings.whitelist_mode')}
                className="fw-bold"
                checked={settings.whitelistMode}
                onChange={(e) => setSettings({ ...settings, whitelistMode: e.target.checked })}
              />
              <div className="small text-muted mt-1 opacity-75">
                {t('admin.settings.whitelist_mode_help')}
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
            </div>
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
      </Card.Body>
    </Card>
  );



  const renderUsers = () => {
    const filteredUsers = users.filter(u =>
      u.nickname?.toLowerCase().includes(userSearch.toLowerCase()) ||
      (isRootAdmin && u.email?.toLowerCase().includes(userSearch.toLowerCase()))
    );

    return (
      <Card className="shadow-sm border-0">
        <Card.Header className="bg-transparent py-3 border-bottom">
          <InputGroup style={{ maxWidth: '400px' }}>
            <InputGroup.Text className="border-end-0 text-muted">
              <Search size={18} />
            </InputGroup.Text>
            <Form.Control
              type="text"
              placeholder={currentLang === 'ru' ? 'Поиск...' : 'Search...'}
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              className="border-start-0 ps-0"
            />
          </InputGroup>
        </Card.Header>
        <Table hover responsive className="mb-0 overflow-hidden">
          <thead>
            <tr>
              <th>{t('admin.users.table_user')}</th>
              <th>{t('admin.users.table_role')}</th>
              <th>{t('admin.users.table_status')}</th>
              <th className="text-end">{t('admin.users.table_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map(u => (
              <tr key={u.id} className="align-middle">
                <td>
                  <div className="d-flex align-items-center">
                    {u.avatar_url && <img src={u.avatar_url} alt="" className="rounded-circle me-2" style={{ width: '32px', height: '32px', objectFit: 'cover' }} />}
                    <div>
                      <div className="fw-bold">{u.nickname || (isRootAdmin ? u.email : '***')}</div>
                      {isRootAdmin && <div className="small text-muted">{u.email}</div>}
                    </div>
                  </div>
                </td>
                <td>
                  <div className="d-flex align-items-center gap-1">
                    {isChiefAdmin(u.email, u.role_id) ? (
                      (() => {
                        const visuals = getRoleVisuals('admin', roles);
                        return (
                          <Badge bg={visuals.color} className={`role-badge px-3 ${visuals.isLight ? 'text-dark' : 'text-white'}`} style={{ fontSize: '0.85rem' }}>
                            {visuals.name}
                          </Badge>
                        );
                      })()
                    ) : (
                      <Button
                        variant="link"
                        className="p-0 text-decoration-none d-inline-flex align-items-center gap-2 group border-0 shadow-none"
                        onClick={() => handleOpenUserModal(u)}
                        disabled={!hasPermission(PERMISSIONS.CHANGE_ROLES)}
                      >
                        {(() => {
                          const visuals = getRoleVisuals(u.role_id || 'player', roles);
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
                    )}
                  </div>
                </td>
                <td>
                  {u.role_id !== 'pending' && u.role_id !== 'banned' && <Badge bg="success">{t('admin.users.status_active')}</Badge>}
                  {u.role_id === 'pending' && <Badge bg="warning" text="dark">{t('admin.users.status_pending')}</Badge>}
                  {u.role_id === 'banned' && <Badge bg="danger">{t('admin.users.status_banned')}</Badge>}
                </td>
                <td className="text-end">
                  {!isChiefAdmin(u.email, u.role_id) && (
                    <div className="d-flex flex-wrap gap-2 justify-content-end align-items-center">
                      {u.role_id === 'pending' && (
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
                      {u.role_id !== 'banned' ? (
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
                        <Button variant="link" size="sm" className="text-danger p-0 text-nowrap text-decoration-none ms-md-2" onClick={() => handleDeleteUser(u.id)}>
                          <Trash2 size={14} className="me-1" /> {t('admin.users.delete')}
                        </Button>
                      )}
                    </div>
                  )}
                  {isChiefAdmin(u.email, u.role_id) && (
                    <Badge bg="secondary" className="opacity-50">{t('admin.users.protected')}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    );
  };

  const renderRoles = () => (
    <Card className="shadow-sm border-0">
      <Card.Body className="p-4">
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
              const sortedRoles = [...roles]
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
                        <Button variant="link" size="sm" onClick={() => handleOpenRoleModal(role)}>
                          {t('admin.roles.edit')}
                        </Button>
                        {!(role.is_system || ['admin', 'moderator', 'player', 'spectator'].includes(role.id)) && (
                          <Button variant="link" size="sm" className="text-danger" onClick={() => handleDeleteRole(role.id, role.is_system)}>
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
      </Card.Body>
    </Card>
  );

  const renderCategories = () => (
    <>
      <Card className="shadow-sm border-0 mb-4">
        <Card.Body className="p-4">
          <div className="d-flex justify-content-between mb-4">
            <h5 className="mb-0">{t('admin.categories.groups_title')}</h5>
            {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
              <Button variant="primary" size="sm" onClick={() => handleOpenGroupModal()}>
                {t('admin.categories.add_group')}
              </Button>
            )}
          </div>
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
        </Card.Body>
      </Card>

      <Card className="shadow-sm border-0">
        <Card.Body className="p-4">
          <div className="d-flex justify-content-between mb-4">
            <h5 className="mb-0">{t('admin.categories.title')}</h5>
            {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
              <Button variant="primary" size="sm" onClick={() => handleOpenCatModal()}>{t('admin.categories.create_btn')}</Button>
            )}
          </div>
          <Table hover responsive>
            <thead>
              <tr>
                <th style={{ width: '80px' }}>{t('admin.categories.table_order')}</th>
                <th>{t('admin.categories.modal_group_select')}</th>
                <th>{t('admin.categories.table_title')}</th>
                <th>{t('admin.categories.table_stats')}</th>
                <th className="text-end">{t('admin.categories.table_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {categories.map(cat => {
                const group = groups.find(g => g.id === cat.group_id);
                return (
                  <tr key={cat.id} className="align-middle">
                    <td>{cat.order}</td>
                    <td>
                      <span className="group-badge">
                        {group ? (group.title?.[currentLang] || group.title?.en) : t('admin.categories.group_unassigned')}
                      </span>
                    </td>
                    <td>
                      <div className="fw-bold">
                        {typeof cat.title === 'object' ? (cat.title[currentLang] || cat.title.en) : cat.title}
                      </div>
                      <div className="small text-muted">
                        {typeof cat.description === 'object' ? (cat.description[currentLang] || cat.description.en) : cat.description}
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
                );
              })}
            </tbody>
          </Table>
        </Card.Body>
      </Card>
    </>
  );

  const renderAuditLog = () => {
    // Build helper lookup
    const resolveId = (v) => {
      const usr = users?.find(u => u.id === v);
      if (usr) return usr.nickname || (isRootAdmin ? usr.email : '***');
      const cat = categories?.find(c => c.id === v);
      if (cat) return typeof cat.title === 'object' ? (cat.title[currentLang] || cat.title.en) : cat.title;
      return v.length < 20 ? v : null; // short = readable role id, long = opaque hash
    };

    const searchLower = auditSearch.toLowerCase();

    const filtered = auditLogs
      .filter(log => {
        if (auditActionFilter !== 'all' && log.action_type !== auditActionFilter) return false;
        if (!searchLower) return true;
        const performer = users?.find(u => u.id === log.performer_id);
        const performerName = (performer?.nickname || (isRootAdmin ? performer?.email : '***') || '').toLowerCase();
        const actionLabel = t(`admin.audit.actions.${log.action_type}`).toLowerCase();
        const detailValues = Object.values(log.details || {}).map(v => {
          if (typeof v === 'string') return (resolveId(v) || v).toLowerCase();
          return '';
        }).join(' ');
        return performerName.includes(searchLower)
          || actionLabel.includes(searchLower)
          || detailValues.includes(searchLower)
          || log.id.toLowerCase().includes(searchLower);
      })
      .slice()
      .sort((a, b) => {
        const ta = a.created_at?.toMillis() ?? 0;
        const tb = b.created_at?.toMillis() ?? 0;
        return auditSortDesc ? tb - ta : ta - tb;
      });

    const totalPages = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE));
    const correctedPage = Math.min(auditPage, totalPages);
    const pageItems = filtered.slice((correctedPage - 1) * AUDIT_PAGE_SIZE, correctedPage * AUDIT_PAGE_SIZE);

    // All action types for the filter dropdown
    const allActions = [...new Set(auditLogs.map(l => l.action_type))].sort();

    return (
      <Card className="shadow-sm border-0">
        <Card.Body className="p-4">
          <h5 className="mb-3">{t('admin.audit.title')}</h5>

          {/* Toolbar */}
          <div className="d-flex flex-wrap gap-2 mb-3 align-items-center">
            <div style={{ flex: '1 1 200px', minWidth: '200px' }}>
              <InputGroup size="sm">
                <InputGroup.Text><Search size={14} /></InputGroup.Text>
                <Form.Control
                  placeholder={currentLang === 'ru' ? 'Поиск...' : 'Search...'}
                  value={auditSearch}
                  onChange={e => { setAuditSearch(e.target.value); setAuditPage(1); }}
                />
              </InputGroup>
            </div>
            <Form.Select size="sm" style={{ width: 'auto' }} value={auditActionFilter} onChange={e => { setAuditActionFilter(e.target.value); setAuditPage(1); }}>
              <option value="all">{currentLang === 'ru' ? 'Все действия' : 'All actions'}</option>
              {allActions.map(a => (
                <option key={a} value={a}>{t(`admin.audit.actions.${a}`) || a}</option>
              ))}
            </Form.Select>
            <Button variant="outline-secondary" size="sm" onClick={() => { setAuditSortDesc(p => !p); setAuditPage(1); }} title={auditSortDesc ? 'Oldest first' : 'Newest first'}>
              {t('admin.audit.table_date')} {auditSortDesc ? '↓' : '↑'}
            </Button>
          </div>

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
                  const performer = users.find(u => u.id === log.performer_id);
                  const performerName = performer ? (performer.nickname || (isRootAdmin ? performer.email : '***')) : 'Unknown User';

                  return (
                    <tr key={log.id} className="align-middle">
                      <td className="text-muted small text-nowrap">
                        {log.created_at ? <Timestamp date={log.created_at.toDate()} /> : '...'}
                      </td>
                      <td>
                        <div className="fw-bold">{performerName}</div>
                      </td>
                      <td>
                        <span className="audit-badge">{t(`admin.audit.actions.${log.action_type}`) || log.action_type}</span>
                      </td>
                      <td className="small text-muted" style={{ wordBreak: 'break-word', minWidth: '200px' }}>
                        {log.details && Object.keys(log.details).length > 0 ? (
                          <div className="d-flex flex-column align-items-start gap-1">
                            {Object.entries(log.details)
                              .map(([k, v]) => {
                                const transK = t(`admin.audit.fields.${k}`);
                                const labelK = transK === `admin.audit.fields.${k}` ? k : transK;

                                let displayValue = typeof v === 'object' ? JSON.stringify(v) : String(v);
                                let hideRow = false;

                                if (typeof v === 'string' && k.toLowerCase().includes('id')) {
                                  const resolved = resolveId(v);
                                  if (resolved !== null) {
                                    displayValue = resolved;
                                  } else {
                                    hideRow = true; // opaque hash
                                  }
                                }

                                if (hideRow) return null;

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
                            <Button variant="link" size="sm" className="p-0 text-decoration-none text-muted" onClick={() => setSelectedAuditLog(log)}>
                              {currentLang === 'ru' ? 'Подробнее...' : 'View details...'}
                            </Button>
                          </div>
                        ) : <span className="opacity-50">—</span>}
                      </td>
                    </tr>
                  )
                })}
                {pageItems.length === 0 && !loadingAudit && (
                  <tr>
                    <td colSpan="4" className="text-center p-4 text-muted">{t('admin.audit.empty')}</td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>

          <div className="d-flex flex-wrap justify-content-between align-items-center mt-3 gap-2">
            <div className="small text-muted">
              {currentLang === 'ru' ? `Записей: ${filtered.length}` : `Entries: ${filtered.length}`}
              {auditSearch || auditActionFilter !== 'all' ? ` (${currentLang === 'ru' ? 'фильтр)' : 'filtered)'}` : ''}
            </div>
            <ForumPagination
              currentPage={correctedPage}
              totalPages={totalPages}
              onPageChange={p => setAuditPage(p)}
            />
          </div>

          {hasMoreAudit && (
            <div className="text-center mt-2">
              <Button variant="link" size="sm" onClick={handleLoadMoreAudit} disabled={loadingAudit}>
                {loadingAudit ? t('common.loading') : (currentLang === 'ru' ? 'Загрузить еще...' : 'Load more entries...')}
              </Button>
            </div>
          )}
        </Card.Body>
      </Card>
    );
  };

  return (
    <Container className="py-5">
      <ForumBreadcrumbs
        items={[{ label: t('nav.admin'), active: true }]}
      />
      <h2 className="mb-4">{t('admin.dashboard')}</h2>

      <Nav variant="tabs" activeKey={activeTab} className="mb-4 border-0" onSelect={(k) => setActiveTab(k)}>
        {hasPermission(PERMISSIONS.MANAGE_FORUM) && (
          <Nav.Item>
            <Nav.Link eventKey="settings" className="px-4 fw-bold border-0">{t('admin.tabs.settings')}</Nav.Link>
          </Nav.Item>
        )}
        {(hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES)) && (
          <Nav.Item>
            <Nav.Link eventKey="users" className="px-4 fw-bold border-0">{t('admin.tabs.users')}</Nav.Link>
          </Nav.Item>
        )}
        {hasPermission(PERMISSIONS.MANAGE_ROLES) && (
          <Nav.Item>
            <Nav.Link eventKey="roles" className="px-4 fw-bold border-0">{t('admin.tabs.roles')}</Nav.Link>
          </Nav.Item>
        )}
        {hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && (
          <Nav.Item>
            <Nav.Link eventKey="categories" className="px-4 fw-bold border-0">{t('admin.tabs.categories')}</Nav.Link>
          </Nav.Item>
        )}
        {hasPermission(PERMISSIONS.VIEW_AUDIT_LOG) && (
          <Nav.Item>
            <Nav.Link eventKey="audit" className="px-4 fw-bold border-0">{t('admin.tabs.audit')}</Nav.Link>
          </Nav.Item>
        )}
      </Nav>

      {activeTab === 'settings' && hasPermission(PERMISSIONS.MANAGE_FORUM) && renderSettings()}
      {activeTab === 'users' && (hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES)) && renderUsers()}
      {activeTab === 'roles' && hasPermission(PERMISSIONS.MANAGE_ROLES) && renderRoles()}
      {activeTab === 'categories' && hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && renderCategories()}
      {activeTab === 'audit' && hasPermission(PERMISSIONS.VIEW_AUDIT_LOG) && renderAuditLog()}

      {/* Role Modal */}
      <ForumModal
        show={showRoleModal}
        onHide={() => setShowRoleModal(false)}
        title={editingRole ? t('admin.roles.modal_edit') : t('admin.roles.modal_create')}
        size="lg"
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowRoleModal(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSaveRole} disabled={saving}>
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
                  type="text"
                  placeholder="e.g. Master Moderator"
                  value={roleForm.name}
                  onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                />
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
                            const template = DEFAULT_ROLES.find(r => r.id === baseId);
                            setRoleForm({
                              ...roleForm,
                              base_role_id: baseId,
                              permissions: template ? [...template.permissions] : roleForm.permissions
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
            const currentBaseRole = roleForm.base_role_id || 'player';
            const allowedPerms = MAX_ROLE_PERMISSIONS[currentBaseRole] || Object.values(PERMISSIONS);
            const visiblePerms = group.permissions.filter(p => allowedPerms.includes(p));

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
            <Button variant="primary" onClick={handleSaveCategory} disabled={saving}>
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
                  type="text"
                  value={catForm.title?.en || ''}
                  onChange={(e) => setCatForm({ ...catForm, title: { ...catForm.title, en: e.target.value } })}
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
                />
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
                />
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
                />
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
                  value={catForm.group_id}
                  onChange={(e) => setCatForm({ ...catForm, group_id: e.target.value })}
                  required
                >
                  <option value="" disabled>{t('admin.categories.modal_group_select')}...</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>
                      {g.title?.[currentLang] || g.title?.en}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
          </Row>

          <hr className="my-3" />
          <h6 className="fw-bold mb-1">{t('admin.categories.modal_perms_title')}</h6>
          <p className="text-muted small mb-3">{t('admin.categories.modal_perms_hint')}</p>
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
              {editingUser.avatar_url && (
                <img
                  src={editingUser.avatar_url}
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
                {roles.filter(r => r.id !== 'root').map(r => (
                  <div
                    key={r.id}
                    className={`p-2 rounded d-flex align-items-center mb-1 cursor-pointer role-radio-container`}
                    style={{
                      border: '1px solid',
                      borderColor: userForm.role_id === r.id ? 'rgba(var(--primary-rgb), 0.4)' : 'rgba(var(--primary-rgb), 0.12)',
                      background: userForm.role_id === r.id ? 'rgba(var(--primary-rgb), 0.08)' : 'transparent',
                      transition: 'all 0.15s ease-in-out',
                      opacity: userForm.role_id === r.id ? 1 : 0.8
                    }}
                    onClick={() => setUserForm({ ...userForm, role_id: r.id })}
                    onMouseEnter={(e) => {
                      if (userForm.role_id !== r.id) {
                        e.currentTarget.style.borderColor = 'rgba(var(--primary-rgb), 0.25)';
                        e.currentTarget.style.opacity = '1';
                        e.currentTarget.style.background = 'rgba(var(--primary-rgb), 0.03)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (userForm.role_id !== r.id) {
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
                      checked={userForm.role_id === r.id}
                      onChange={() => setUserForm({ ...userForm, role_id: r.id })}
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
          </Form>
        )}
      </ForumModal>

      <ConfirmModal
        show={confirmState.show}
        onHide={() => setConfirmState(prev => ({ ...prev, show: false }))}
        onConfirm={confirmState.onConfirm}
        title={confirmState.title}
        message={confirmState.message}
      />

      {/* Audit Log Details Modal */}
      <Modal show={!!selectedAuditLog} onHide={() => setSelectedAuditLog(null)} centered>
        <Modal.Header closeButton>
          <Modal.Title>{t('admin.audit.table_details')}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="small">
          {selectedAuditLog && (
            <div className="d-flex flex-column gap-3" style={{ wordBreak: 'break-word' }}>
              <div>
                <strong>{t('admin.audit.table_action')}:</strong> <span className="audit-badge ms-1">{t(`admin.audit.actions.${selectedAuditLog.action_type}`) || selectedAuditLog.action_type}</span>
              </div>
              <div>
                <strong>{t('admin.audit.table_date')}:</strong> {selectedAuditLog.created_at ? <Timestamp date={selectedAuditLog.created_at.toDate()} /> : '...'}
              </div>

              <div className="p-3 bg-light rounded border border-secondary border-opacity-25">
                <div className="mb-1 text-muted fw-bold" style={{ textTransform: 'uppercase', fontSize: '0.7rem' }}>
                  {t('admin.audit.table_performer')}
                </div>
                <div>
                  {(() => {
                    const p = users.find(u => u.id === selectedAuditLog.performer_id);
                    return p ? `${p.nickname || (isRootAdmin ? p.email : '***')}` : 'Unknown User';
                  })()}
                </div>
                <div className="text-muted" style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
                  ID: {selectedAuditLog.performer_id}
                </div>
              </div>

              <div className="p-3 bg-light rounded border border-secondary border-opacity-25">
                <div className="mb-2 text-muted fw-bold" style={{ textTransform: 'uppercase', fontSize: '0.7rem' }}>
                  Raw Details
                </div>
                {Object.entries(selectedAuditLog.details || {}).map(([k, v]) => {
                  const transK = t(`admin.audit.fields.${k}`);
                  const label = transK === `admin.audit.fields.${k}` ? k : transK;

                  let resolvedName = null;
                  if (v && typeof v === 'string' && v.length > 20) {
                    const tgt = users.find(u => u.id === v);
                    if (tgt) resolvedName = tgt.nickname || (isRootAdmin ? tgt.email : '***');
                  }

                  return (
                    <div key={k} className="mb-2 last-child-mb-0">
                      <div className="fw-bold">{label} {k !== label && <span className="text-muted fw-normal">({k})</span>}:</div>
                      <div className="ms-2">
                        {k === 'changes' && typeof v === 'object' ? (
                          <div className="d-flex flex-column gap-1 mt-1">
                            {Object.entries(v).map(([ck, cv]) => {
                              const cLabel = t(`admin.audit.fields.${ck}`) || ck;
                              return (
                                <div key={ck} className="p-2 rounded bg-white border border-secondary border-opacity-10">
                                  <div className="fw-bold small">{cLabel}:</div>
                                  <div className="d-flex align-items-center gap-2 small">
                                    <span className="text-danger text-decoration-line-through opacity-75">{String(cv.from)}</span>
                                    <ArrowRightLeft size={10} className="text-muted" />
                                    <span className="text-success fw-bold">{String(cv.to)}</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <>
                            {typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}
                            {resolvedName && <span className="text-muted ms-2">({resolvedName})</span>}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="text-muted text-end" style={{ fontSize: '0.65rem', fontFamily: 'monospace' }}>
                Log ID: {selectedAuditLog.id}
              </div>
            </div>
          )}
        </Modal.Body>
      </Modal>

      {/* Group Modal */}
      <ForumModal
        show={showGroupModal}
        onHide={() => setShowGroupModal(false)}
        title={editingGroup ? t('admin.categories.modal_group_edit') : t('admin.categories.modal_group_create')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowGroupModal(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSaveGroup} disabled={saving}>
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
                  type="text"
                  value={groupForm.title?.en || ''}
                  onChange={(e) => setGroupForm({ ...groupForm, title: { ...groupForm.title, en: e.target.value } })}
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
                />
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
    </Container>
  );
};

export default AdminPage;
