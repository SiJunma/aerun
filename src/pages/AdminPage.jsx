import React, { useState, useEffect, useCallback } from 'react';
import { Container, Row, Col, Card, Nav, Form, Button, Table, Badge, Toast, ToastContainer, Dropdown } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useSearchParams } from 'react-router-dom';
import { 
  getGlobalSettings, updateGlobalSettings, approveUser, rejectUser, deleteUser, banUser, 
  updateUserRole, addRole, updateRole, deleteRole 
} from '../api/admin';
import { subscribeToCategories, addCategory, updateCategory, deleteCategory, subscribeToAllUsers } from '../api/forum';
import { MAX_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_LABELS, DEFAULT_ROLES, getRoleVisuals, isChiefAdmin, normalizePermissions, PERMISSION_GROUPS } from '../constants/permissions';
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
const AdminPage = () => {
  const { t, lang: currentLang } = useI18n();
  const { hasPermission, roles } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'settings';
  const setActiveTab = useCallback((k) => setSearchParams({ tab: k }, { replace: true }), [setSearchParams]);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState([]);
  const [users, setUsers] = useState([]);
  const [userSearch, setUserSearch] = useState('');

  // Modal State
  const [showCatModal, setShowCatModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [catForm, setCatForm] = useState({ 
    title: { en: '', ru: '' }, 
    description: { en: '', ru: '' }, 
    order: 0, 
    permissions: {} 
  });

  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState(null);
  const [roleForm, setRoleForm] = useState({ name: '', permissions: [], color: 'primary' });

  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({ role_id: '' });

  const [toast, setToast] = useState({ show: false, message: '', variant: 'success' });


  // Confirm Modal State
  const [confirmState, setConfirmState] = useState({
    show: false,
    onConfirm: () => { },
    title: '',
    message: ''
  });

  // Tab permissions check
  const canAccessTab = useCallback((tab) => {
    switch (tab) {
      case 'settings': return hasPermission(PERMISSIONS.MANAGE_FORUM);
      case 'users': return hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES);
      case 'roles': return hasPermission(PERMISSIONS.MANAGE_ROLES);
      case 'categories': return hasPermission(PERMISSIONS.MANAGE_CATEGORIES);
      default: return false;
    }
  }, [hasPermission]);

  useEffect(() => {
    if (!canAccessTab(activeTab)) {
      const tabs = ['settings', 'users', 'roles', 'categories'];
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
    maintenanceMode: false,
    welcomeMessage: { en: 'Welcome to our TTRPG home!', ru: 'Добро пожаловать в наш дом TTRPG!' },
    enableReputation: true,
    enableCharacters: true,
    enableDice: true,
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
          whitelistMode: data.whitelistMode ?? false,
          requireApproval: data.requireApproval ?? true
        };
        // Defaults for backgrounds
        if (!data.bgLight) migrated.bgLight = 'https://images.unsplash.com/photo-1458668383970-8ddd3927deed?q=80&w=1400&auto=format&fit=crop';
        if (!data.bgDark) migrated.bgDark = 'https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop';
        if (!data.bgNeutral) migrated.bgNeutral = 'https://images.unsplash.com/photo-1675636173835-657f72144c77?q=80&w=1400&auto=format&fit=crop';
        setSettings(migrated);
      }
    });
    const unsubCats = subscribeToCategories(setCategories);
    const unsubUsers = subscribeToAllUsers(setUsers);

    return () => {
      unsubSettings();
      unsubCats();
      unsubUsers();
    };
  }, []);

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateGlobalSettings(settings);
      setToast({ show: true, message: t('admin.settings.success'), variant: 'success' });
    } catch (err) {
      console.error(err);
      setToast({ show: true, message: t('admin.settings.error'), variant: 'danger' });
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
        permissions: cat.permissions || {}
      });
    } else {
      setEditingCat(null);
      setCatForm({ 
        title: { en: '', ru: '' }, 
        description: { en: '', ru: '' }, 
        order: categories.length + 1, 
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
        // activate override with roles that currently have this permission globally
        // This prevents accidentally giving spectators/guests write access when toggling on an override.
        perms[permKey] = roles
          .filter(r => r.id !== 'root' && r.permissions?.includes(permKey))
          .map(r => r.id);
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
        await updateCategory(editingCat, catForm);
      } else {
        await addCategory(catForm);
      }
      setToast({ show: true, message: t('admin.categories.toast_saved'), variant: 'success' });
      setShowCatModal(false);
    } catch (err) {
      console.error(err);
      setToast({ show: true, message: t('admin.categories.error_save'), variant: 'danger' });
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
          await deleteCategory(id);
          setToast({ show: true, message: t('admin.categories.toast_deleted'), variant: 'success' });
        } catch (err) {
          console.error(err);
          setToast({ show: true, message: t('admin.categories.error_delete'), variant: 'danger' });
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
          await rejectUser(uid);
          setToast({ show: true, message: t('admin.users.toast_rejected'), variant: 'success' });
        } catch (err) {
          console.error(err);
          setToast({ show: true, message: t('admin.users.error_reject'), variant: 'danger' });
        }
      }
    });
  };

  const handleApproveUser = async (uid) => {
    try {
      await approveUser(uid);
      setToast({ show: true, message: t('admin.users.toast_approved'), variant: 'success' });
    } catch (err) {
      console.error(err);
      setToast({ show: true, message: t('admin.users.error_approve'), variant: 'danger' });
    }
  };

  const handleBanUser = async (uid) => {
    setConfirmState({
      show: true,
      title: t('admin.users.confirm_ban_title'),
      message: t('admin.users.confirm_ban_message'),
      onConfirm: async () => {
        try {
          await banUser(uid);
          setToast({ show: true, message: t('admin.users.toast_banned'), variant: 'success' });
        } catch (err) {
          console.error(err);
          setToast({ show: true, message: t('admin.users.error_ban'), variant: 'danger' });
        }
      }
    });
  };

  const handleDeleteUser = (uid) => {
    setConfirmState({
      show: true,
      title: t('admin.users.confirm_delete_title'),
      message: t('admin.users.confirm_delete_message'),
      onConfirm: async () => {
        try {
          await deleteUser(uid);
          setToast({ show: true, message: t('admin.users.toast_deleted'), variant: 'success' });
        } catch (err) {
          console.error(err);
          setToast({ show: true, message: t('admin.users.error_delete'), variant: 'danger' });
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
      await updateUserRole(editingUser.id, userForm.role_id);
      setToast({ show: true, message: t('admin.users.toast_role_updated'), variant: 'success' });
      setShowUserModal(false);
    } catch (err) {
      console.error(err);
      setToast({ show: true, message: t('admin.users.error_role_update'), variant: 'danger' });
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
        await updateRole(editingRole.id, roleForm);
      } else {
        await addRole(roleForm);
      }
      setToast({ show: true, message: t('admin.roles.toast_saved'), variant: 'success' });
      setShowRoleModal(false);
    } catch (err) {
      console.error(err);
      setToast({ show: true, message: 'Error', variant: 'danger' });
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
          await deleteRole(id, isSystem);
          setToast({ show: true, message: t('admin.roles.toast_deleted'), variant: 'success' });
        } catch (err) {
          console.error(err);
          setToast({ show: true, message: t('admin.roles.error_delete'), variant: 'danger' });
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
      u.email?.toLowerCase().includes(userSearch.toLowerCase())
    );

    return (
      <Card className="shadow-sm border-0">
        <Card.Header className="bg-transparent py-3 border-bottom">
          <InputGroup style={{ maxWidth: '400px' }}>
            <InputGroup.Text className="bg-card border-end-0 text-muted">
              <Search size={18} />
            </InputGroup.Text>
            <Form.Control
              type="text"
              placeholder={currentLang === 'ru' ? 'Поиск по нику или email...' : 'Search by nickname or email...'}
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
                    <div className="fw-bold">{u.nickname || u.email}</div>
                    <div className="small text-muted">{u.email}</div>
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
                {u.status === 'active' && <Badge bg="success">{t('admin.users.status_active')}</Badge>}
                {u.status === 'pending' && <Badge bg="warning" text="dark">{t('admin.users.status_pending')}</Badge>}
                {u.status === 'banned' && <Badge bg="danger">{t('admin.users.status_banned')}</Badge>}
              </td>
              <td className="text-end">
                {!isChiefAdmin(u.email, u.role_id) && (
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
                        <Button variant="link" size="sm" className="text-success p-0 text-nowrap text-decoration-none ms-md-2" onClick={() => handleApproveUser(u.id)}>
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
                <th>{t('admin.categories.table_order')}</th>
                <th>{t('admin.categories.table_title')}</th>
                <th>{t('admin.categories.table_stats')}</th>
                <th className="text-end">{t('admin.categories.table_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {categories.map(cat => (
                <tr key={cat.id} className="align-middle">
                  <td>{cat.order}</td>
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
              ))}
            </tbody>
          </Table>
        </Card.Body>
      </Card>
  );

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
      </Nav>

      {activeTab === 'settings' && hasPermission(PERMISSIONS.MANAGE_FORUM) && renderSettings()}
      {activeTab === 'users' && (hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES)) && renderUsers()}
      {activeTab === 'roles' && hasPermission(PERMISSIONS.MANAGE_ROLES) && renderRoles()}
      {activeTab === 'categories' && hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && renderCategories()}

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
          )})}
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
          <Form.Group className="mb-3">
            <Form.Label className="fw-bold">{t('admin.categories.modal_order')}</Form.Label>
            <Form.Control
              type="number"
              value={catForm.order}
              onChange={(e) => setCatForm({ ...catForm, order: parseInt(e.target.value) })}
            />
          </Form.Group>

          <hr className="my-3" />
          <h6 className="fw-bold mb-1">{t('admin.categories.modal_perms_title')}</h6>
          <p className="text-muted small mb-3">{t('admin.categories.modal_perms_hint')}</p>
          {[
            { permKey: PERMISSIONS.VIEW_FORUM,   label: t('admin.categories.perm_view') },
            { permKey: PERMISSIONS.CREATE_TOPIC, label: t('admin.categories.perm_create_topic') },
            { permKey: PERMISSIONS.POST_REPLY,   label: t('admin.categories.perm_post_reply') },
            { permKey: PERMISSIONS.USE_MASKS,    label: t('admin.categories.perm_use_masks') },
            { permKey: PERMISSIONS.USE_DICE,     label: t('admin.categories.perm_use_dice') },
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
                  {editingUser.nickname || editingUser.email}
                </div>
                <div className="small opacity-75">{editingUser.email}</div>
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

      <ToastContainer position="bottom-end" className="p-3" style={{ zIndex: 1100, position: 'fixed' }}>
        <Toast
          bg={toast.variant}
          show={toast.show}
          onClose={() => setToast(t => ({ ...t, show: false }))}
          delay={3500}
          autohide
        >
          <Toast.Body className="d-flex align-items-center gap-2 text-white fw-semibold">
            <span>{toast.variant === 'success' ? '✓' : '✕'}</span>
            <span>{toast.message}</span>
          </Toast.Body>
        </Toast>
      </ToastContainer>
    </Container>
  );
};

export default AdminPage;
