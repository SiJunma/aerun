import React, { useState, useEffect } from 'react';
import { Container, Row, Col, Card, Nav, Form, Button, Table, Badge } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { getGlobalSettings, updateGlobalSettings, approveUser, rejectUser, banUser, updateUserRole } from '../api/admin';
import { subscribeToCategories, addCategory, updateCategory, deleteCategory, subscribeToAllUsers } from '../api/forum';
import { InputGroup } from 'react-bootstrap';
import ForumModal from '../components/common/ForumModal';
import { UserCheck, UserMinus, UserX, PlusCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthProvider';
import ConfirmModal from '../components/common/ConfirmModal';

const AdminPage = () => {
  const { t } = useI18n();
  const { user: currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState('settings');
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState([]);
  const [users, setUsers] = useState([]);

  // Modal State
  const [showCatModal, setShowCatModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [catForm, setCatForm] = useState({ title: '', description: '', order: 0 });

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
      alert('Settings saved successfully!');
    } catch (err) {
      console.error(err);
      alert('Error saving settings');
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
    } catch (err) {
      console.error(err);
      alert('Error saving category');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCategory = (id) => {
    setConfirmState({
      show: true,
      title: 'Delete Category',
      message: 'Are you sure you want to delete this category and all its contents? This action cannot be undone.',
      onConfirm: async () => {
        try {
          await deleteCategory(id);
        } catch (err) {
          console.error(err);
          alert('Error deleting category');
        }
      }
    });
  };

  const handleRejectUser = (uid) => {
    setConfirmState({
      show: true,
      title: 'Reject User',
      message: 'Are you sure you want to reject this user? Their pending profile data will be permanently deleted.',
      onConfirm: async () => {
        try {
          await rejectUser(uid);
        } catch (err) {
          console.error(err);
        }
      }
    });
  };

  const handleApproveUser = async (uid) => {
    try {
      await approveUser(uid);
    } catch (err) {
      console.error(err);
    }
  };

  const handleBanUser = async (uid) => {
    setConfirmState({
      show: true,
      title: 'Ban User',
      message: 'Are you sure you want to ban this user? They will lose all access immediately.',
      onConfirm: async () => {
        try {
          await banUser(uid);
        } catch (err) {
          console.error(err);
        }
      }
    });
  };

  const handleRoleChange = async (uid, roleId) => {
    try {
      await updateUserRole(uid, roleId);
    } catch (err) {
      console.error(err);
    }
  };

  // Mock roles and permissions
  const availableRoles = [
    { id: 'admin', name: 'Administrator', color: 'danger', permissions: ['all'] },
    { id: 'mod', name: 'Moderator', color: 'info', permissions: ['moderate_posts', 'ban_users'] },
    { id: 'player', name: 'Player', color: 'primary', permissions: ['create_topics', 'post_replies', 'use_masks'] },
    { id: 'spectator', name: 'Spectator', color: 'secondary', permissions: ['view_content'] }
  ];

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
            {saving ? 'Saving...' : 'Save Settings'}
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
            <th>User</th>
            <th>Role Assignment</th>
            <th>Status</th>
            <th className="text-end">Actions</th>
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
                <Form.Select
                  size="sm"
                  value={u.role_id || 'player'}
                  className="w-75 bg-light"
                  onChange={(e) => handleRoleChange(u.id, e.target.value)}
                  disabled={u.id === currentUser.uid}
                >
                  {availableRoles.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </Form.Select>
              </td>
              <td>
                {u.status === 'active' && <Badge bg="success">Active</Badge>}
                {u.status === 'pending' && <Badge bg="warning" text="dark">Pending</Badge>}
                {u.status === 'banned' && <Badge bg="danger">Banned</Badge>}
              </td>
              <td className="text-end">
                {u.id !== currentUser.uid && (
                  <>
                    {u.status === 'pending' && (
                      <>
                        <Button variant="outline-success" size="sm" className="me-2 fw-bold" onClick={() => handleApproveUser(u.id)}>
                          <UserCheck size={14} className="me-1" /> Approve
                        </Button>
                        <Button variant="outline-dark" size="sm" className="me-2 fw-bold" onClick={() => handleRejectUser(u.id)}>
                          <UserX size={14} className="me-1" /> Reject
                        </Button>
                      </>
                    )}
                    {u.status !== 'banned' ? (
                      <Button variant="link" size="sm" className="text-danger" onClick={() => handleBanUser(u.id)}>
                        <UserMinus size={14} className="me-1" /> Ban
                      </Button>
                    ) : (
                      <Button variant="link" size="sm" className="text-success" onClick={() => handleApproveUser(u.id)}>
                        Unban
                      </Button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );

  const renderRoles = () => (
    <Card className="shadow-sm border-0">
      <Card.Body className="p-4">
        <div className="d-flex justify-content-between mb-4">
          <h5 className="mb-0">Role Permissions (RBAC)</h5>
          <Button variant="primary" size="sm">+ Create New Role</Button>
        </div>
        <Table hover responsive>
          <thead>
            <tr>
              <th>Role Name</th>
              <th>Permissions</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {availableRoles.map(role => (
              <tr key={role.id} className="align-middle">
                <td>
                  <Badge bg={role.color} className="me-2">{role.name}</Badge>
                </td>
                <td>
                  {role.permissions.map(p => (
                    <Badge key={p} bg="secondary" className="me-1 fw-normal opacity-75">
                      {p.replace(/_/g, ' ')}
                    </Badge>
                  ))}
                </td>
                <td className="text-end">
                  <Button variant="link" size="sm">Edit Permissions</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );

  const renderCategories = () => (
    <>
      <Card className="shadow-sm border-0">
        <Card.Body className="p-4">
          <div className="d-flex justify-content-between mb-4">
            <h5 className="mb-0">Forum Categories</h5>
            <Button variant="primary" size="sm" onClick={() => handleOpenCatModal()}>+ Add Category</Button>
          </div>
          <Table hover responsive>
            <thead>
              <tr>
                <th>Order</th>
                <th>Title</th>
                <th>Stats</th>
                <th className="text-end">Actions</th>
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
                  <td>{cat.topics_count || 0} Topics / {cat.posts_count || 0} Posts</td>
                  <td className="text-end">
                    <Button variant="link" size="sm" onClick={() => handleOpenCatModal(cat)}>Edit</Button>
                    <Button variant="link" size="sm" className="text-danger" onClick={() => handleDeleteCategory(cat.id)}>Delete</Button>
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
        title={editingCat ? 'Edit Category' : 'Add Category'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowCatModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleSaveCategory} disabled={saving}>
              {saving ? 'Saving...' : 'Save Category'}
            </Button>
          </>
        }
        backdropClassName="confirm-modal-backdrop"
      >
        <Form>
          <Form.Group className="mb-3">
            <Form.Label className="fw-bold">Title (EN)</Form.Label>
            <Form.Control
              type="text"
              value={catForm.title}
              onChange={(e) => setCatForm({ ...catForm, title: e.target.value })}
            />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label className="fw-bold">Description (EN)</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              value={catForm.description}
              onChange={(e) => setCatForm({ ...catForm, description: e.target.value })}
            />
          </Form.Group>
          <Form.Group className="mb-0">
            <Form.Label className="fw-bold">Display Order</Form.Label>
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
      <h2 className="mb-4">{t('nav.admin')} Dashboard</h2>

      <Nav variant="tabs" activeKey={activeTab} className="mb-4 border-0" onSelect={(k) => setActiveTab(k)}>
        <Nav.Item>
          <Nav.Link eventKey="settings" className="px-4 fw-bold border-0">Settings</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="users" className="px-4 fw-bold border-0">Users</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="roles" className="px-4 fw-bold border-0">Roles</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="categories" className="px-4 fw-bold border-0">Categories</Nav.Link>
        </Nav.Item>
      </Nav>

      {activeTab === 'settings' && renderSettings()}
      {activeTab === 'users' && renderUsers()}
      {activeTab === 'roles' && renderRoles()}
      {activeTab === 'categories' && renderCategories()}

      <ConfirmModal
        show={confirmState.show}
        onHide={() => setConfirmState(prev => ({ ...prev, show: false }))}
        onConfirm={confirmState.onConfirm}
        title={confirmState.title}
        message={confirmState.message}
      />
    </Container>
  );
};

export default AdminPage;
