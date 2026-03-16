import React, { useState, useEffect } from 'react';
import { Container, Row, Col, Card, Nav, Form, Button, Table, Badge, Toast, ToastContainer, Dropdown } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useSearchParams } from 'react-router-dom';
import { getGlobalSettings, updateGlobalSettings, approveUser, rejectUser, banUser, updateUserRole, subscribeToRoles, addRole, updateRole, deleteRole } from '../api/admin';
import { subscribeToCategories, addCategory, updateCategory, deleteCategory, subscribeToAllUsers } from '../api/forum';
import { PERMISSIONS, PERMISSION_LABELS, DEFAULT_ROLES, getRoleVisuals, resolveUserRoleId, isChiefAdmin } from '../constants/permissions';
import { InputGroup } from 'react-bootstrap';
import ForumModal from '../components/common/ForumModal';
import { UserCheck, UserMinus, UserX, PlusCircle, Edit2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthProvider';
import ConfirmModal from '../components/common/ConfirmModal';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
const AdminPage = () => {
  const { t, lang: currentLang } = useI18n();
  const { user: currentUser, profile, hasPermission, roles } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'settings';
  const setActiveTab = (k) => setSearchParams({ tab: k }, { replace: true });
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState([]);
  const [users, setUsers] = useState([]);

  // Modal State
  const [showCatModal, setShowCatModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [catForm, setCatForm] = useState({ title: '', description: '', order: 0 });

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

  // Initial settings state
  const [settings, setSettings] = useState({
    forumName: 'Aerun Forum',
    registrationEnabled: true,
    maxUploadSize: 500,
    maintenanceMode: false,
    welcomeMessage: 'Welcome to our TTRPG home!',
    enableReputation: true,
    enableCharacters: true,
    enableDice: true,
    logoUrl: ''
  });

  useEffect(() => {
    const unsubSettings = getGlobalSettings((data) => {
      if (data) setSettings(data);
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
      setEditingCat(cat);
      setCatForm({
        title: typeof cat.title === 'object' ? cat.title.en : cat.title,
        description: typeof cat.description === 'object' ? cat.description.en : cat.description,
        order: cat.order
      });
    } else {
      setEditingCat(null);
      setCatForm({ title: '', description: '', order: categories.length + 1 });
    }
    setShowCatModal(true);
  };

  const handleSaveCategory = async () => {
    if (!catForm.title) return;
    setSaving(true);
    setShowCatModal(false); // Close first
    try {
      if (editingCat) {
        await updateCategory(editingCat.id, catForm);
      } else {
        await addCategory(catForm);
      }
      setToast({ show: true, message: t('admin.categories.toast_saved'), variant: 'success' });
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
      setToast({ show: true, message: 'Error', variant: 'danger' });
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

  const handleRoleChange = async (uid, roleId) => {
    try {
      await updateUserRole(uid, roleId);
      setToast({ show: true, message: t('admin.users.toast_role_updated'), variant: 'success' });
    } catch (err) {
      console.error(err);
      setToast({ show: true, message: 'Error updating user role', variant: 'danger' });
    }
  };

  const handleOpenUserModal = (user) => {
    setEditingUser(user);
    setUserForm({ role_id: user.role_id || 'player' });
    setShowUserModal(true);
  };

  const handleSaveUserRole = async () => {
    if (!editingUser) return;
    setSaving(true);
    setShowUserModal(false);
    try {
      await updateUserRole(editingUser.id, userForm.role_id);
      setToast({ show: true, message: t('admin.users.toast_role_updated'), variant: 'success' });
    } catch (err) {
      console.error(err);
      setToast({ show: true, message: 'Error updating user role', variant: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const handleOpenRoleModal = (role = null) => {
    if (role) {
      setEditingRole(role);
      setRoleForm({ name: role.name, permissions: role.permissions || [], color: role.color || 'primary' });
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
    setShowRoleModal(false);
    try {
      if (editingRole) {
        await updateRole(editingRole.id, roleForm);
      } else {
        await addRole(roleForm);
      }
      setToast({ show: true, message: t('admin.roles.toast_saved'), variant: 'success' });
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
          <h5 className="mb-4 text-primary">General Configuration</h5>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="forumName">
                <Form.Label className="fw-bold">Forum Name</Form.Label>
                <Form.Control
                  type="text"
                  value={settings.forumName}
                  onChange={(e) => setSettings({ ...settings, forumName: e.target.value })}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="logoUrl">
                <Form.Label className="fw-bold">Forum Logo URL</Form.Label>
                <Form.Control
                  type="text"
                  placeholder="https://..."
                  value={settings.logoUrl}
                  onChange={(e) => setSettings({ ...settings, logoUrl: e.target.value })}
                />
              </Form.Group>
            </Col>
          </Row>

          <Form.Group className="mb-4" controlId="welcomeMsg">
            <Form.Label className="fw-bold">Welcome Message (Banner)</Form.Label>
            <Form.Control
              as="textarea"
              rows={3}
              value={settings.welcomeMessage}
              onChange={(e) => setSettings({ ...settings, welcomeMessage: e.target.value })}
            />
          </Form.Group>

          <hr className="my-5" />
          <h5 className="mb-4 text-primary">Feature Toggles</h5>
          <div className="ms-2">
            <Form.Check
              type="switch"
              id="char-switch"
              label="Enable Character (Mask) System"
              className="mb-3 fw-bold"
              checked={settings.enableCharacters}
              onChange={(e) => setSettings({ ...settings, enableCharacters: e.target.checked })}
            />
            <Form.Check
              type="switch"
              id="dice-switch"
              label="Enable Dice Roller"
              className="mb-3 fw-bold"
              checked={settings.enableDice}
              onChange={(e) => setSettings({ ...settings, enableDice: e.target.checked })}
            />
            <Form.Check
              type="switch"
              id="rep-switch"
              label="Enable Reputation System"
              className="mb-3 fw-bold"
              checked={settings.enableReputation}
              onChange={(e) => setSettings({ ...settings, enableReputation: e.target.checked })}
            />
          </div>

          <hr className="my-5" />
          <h5 className="mb-4 text-primary">Security & Access</h5>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-4" controlId="maxUpload">
                <Form.Label className="fw-bold">Max Upload Size per Post (KB)</Form.Label>
                <Form.Control
                  type="number"
                  value={settings.maxUploadSize}
                  onChange={(e) => setSettings({ ...settings, maxUploadSize: parseInt(e.target.value) })}
                />
              </Form.Group>
            </Col>
          </Row>

          <Form.Check
            type="switch"
            id="reg-switch"
            label="Allow New User Registration"
            className="mb-3 fw-bold"
            checked={settings.registrationEnabled}
            onChange={(e) => setSettings({ ...settings, registrationEnabled: e.target.checked })}
          />

          <Form.Check
            type="switch"
            id="maintenance-switch"
            label="Maintenance Mode (Only Admins can log in)"
            className="mb-4 text-danger fw-bold"
            checked={settings.maintenanceMode}
            onChange={(e) => setSettings({ ...settings, maintenanceMode: e.target.checked })}
          />

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



  const renderUsers = () => (
    <Card className="shadow-sm border-0">
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
          {users.map(u => (
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
                  <>
                    {u.status === 'pending' && (
                      <>
                        {hasPermission(PERMISSIONS.APPROVE_USERS) && (
                          <Button variant="success" size="sm" className="me-2 fw-bold text-white" onClick={() => handleApproveUser(u.id)}>
                             <UserCheck size={14} className="me-1" /> {t('admin.users.approve')}
                          </Button>
                        )}
                        {hasPermission(PERMISSIONS.APPROVE_USERS) && (
                          <Button variant="danger" size="sm" className="me-2 fw-bold text-white" onClick={() => handleRejectUser(u.id)}>
                            <UserX size={14} className="me-1" /> {t('admin.users.reject')}
                          </Button>
                        )}
                      </>
                    )}
                    {u.status !== 'banned' ? (
                      hasPermission(PERMISSIONS.BAN_USERS) && (
                        <Button variant="link" size="sm" className="text-danger" onClick={() => handleBanUser(u.id)}>
                          <UserMinus size={14} className="me-1" /> {t('admin.users.ban')}
                        </Button>
                      )
                    ) : (
                      hasPermission(PERMISSIONS.BAN_USERS) && (
                        <Button variant="link" size="sm" className="text-success" onClick={() => handleApproveUser(u.id)}>
                          {t('admin.users.unban')}
                        </Button>
                      )
                    )}
                  </>
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

  const renderRoles = () => (
    <>
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
              {roles.filter(r => r.id !== 'root').map(role => (
                <tr key={role.id} className="align-middle">
                  <td>
                    <Badge bg={role.color || 'primary'} className={`role-badge me-2 ${['warning', 'light'].includes(role.color) ? 'text-dark' : 'text-white'}`}>
                      {role.name}
                    </Badge>
                  </td>
                  <td>
                    <div className="d-flex flex-wrap gap-1">
                      {role.permissions?.map(p => (
                        <Badge key={p} bg="secondary" className="role-badge fw-normal opacity-75" style={{ background: 'var(--bs-gray-700)', color: 'white' }}>
                          {PERMISSION_LABELS[p]?.[currentLang] || PERMISSION_LABELS[p]?.en || p}
                        </Badge>
                      ))}
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
              ))}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

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
                      {roleForm.base_role_id === 'moderator' ? t('admin.roles.system_roles.moderator') : 
                       roleForm.base_role_id === 'spectator' ? t('admin.roles.system_roles.spectator') : 
                       t('admin.roles.system_roles.player')}
                    </Dropdown.Toggle>
                    <Dropdown.Menu className="w-100 custom-select-menu shadow-sm">
                      {['player', 'moderator', 'spectator'].map(baseId => (
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
            <Col md={editingRole ? 5 : 12}>
            </Col>
          </Row>

          <h6 className="fw-bold mb-3">{t('admin.roles.modal_perms')}</h6>
          <div className="modal-section-themed p-3 rounded mb-2">
            <Row>
              {Object.keys(PERMISSIONS).map(permKey => {
                const permId = PERMISSIONS[permKey];
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
        </Form>
      </ForumModal>
    </>
  );

  const renderCategories = () => (
    <>
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
                      {typeof cat.title === 'object' ? cat.title.en : cat.title}
                    </div>
                    <div className="small text-muted">
                      {typeof cat.description === 'object' ? cat.description.en : cat.description}
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
          <Form.Group className="mb-3">
            <Form.Label className="fw-bold">{t('admin.categories.modal_title')}</Form.Label>
            <Form.Control
              type="text"
              value={catForm.title}
              onChange={(e) => setCatForm({ ...catForm, title: e.target.value })}
            />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label className="fw-bold">{t('admin.categories.modal_desc')}</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              value={catForm.description}
              onChange={(e) => setCatForm({ ...catForm, description: e.target.value })}
            />
          </Form.Group>
          <Form.Group className="mb-0">
            <Form.Label className="fw-bold">{t('admin.categories.modal_order')}</Form.Label>
            <Form.Control
              type="number"
              value={catForm.order}
              onChange={(e) => setCatForm({ ...catForm, order: parseInt(e.target.value) })}
            />
          </Form.Group>
        </Form>
      </ForumModal>
    </>
  );

  return (
    <Container className="py-5">
      <ForumBreadcrumbs 
        items={[{ label: t('nav.admin'), active: true }]} 
      />
      <h2 className="mb-4">{t('admin.dashboard')}</h2>

      <Nav variant="tabs" activeKey={activeTab} className="mb-4 border-0" onSelect={(k) => setActiveTab(k)}>
        {hasPermission(PERMISSIONS.MANAGE_SETTINGS) && (
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

      {activeTab === 'settings' && hasPermission(PERMISSIONS.MANAGE_SETTINGS) && renderSettings()}
      {activeTab === 'users' && (hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.CHANGE_ROLES)) && renderUsers()}
      {activeTab === 'roles' && hasPermission(PERMISSIONS.MANAGE_ROLES) && renderRoles()}
      {activeTab === 'categories' && hasPermission(PERMISSIONS.MANAGE_CATEGORIES) && renderCategories()}

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
            <div className="mb-4 d-flex align-items-center bg-light p-3 rounded border shadow-sm">
              {editingUser.avatar_url && (
                <img src={editingUser.avatar_url} alt="" className="rounded-circle me-3 border border-2 border-white" style={{ width: '48px', height: '48px', objectFit: 'cover' }} />
              )}
              <div>
                <div className="fw-bold h5 mb-0 text-primary">{editingUser.nickname || editingUser.email}</div>
                <div className="small text-muted">{editingUser.email}</div>
              </div>
            </div>

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold text-secondary small text-uppercase letter-spacing-1">{t('admin.users.change_role_label')}</Form.Label>
              <Dropdown className="w-100">
                <Dropdown.Toggle 
                  variant="outline-management" 
                  className="w-100 d-flex justify-content-between align-items-center custom-select-toggle py-2"
                >
                  {roles.find(r => r.id === userForm.role_id)?.name || userForm.role_id}
                </Dropdown.Toggle>
                <Dropdown.Menu className="w-100 custom-select-menu shadow-sm">
                  {roles.filter(r => r.id !== 'root').map(r => (
                    <Dropdown.Item 
                      key={r.id} 
                      active={userForm.role_id === r.id}
                      onClick={() => setUserForm({ ...userForm, role_id: r.id })}
                    >
                      {r.name}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown>
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
