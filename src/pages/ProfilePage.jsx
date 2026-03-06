import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Container, Row, Col, Card, Button, Table, Modal, Form, Image, Tabs, Tab, Toast, ToastContainer } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToCharacters, addCharacter, updateCharacter, deleteCharacter } from '../api/character';
import { subscribeToUser } from '../api/forum';
import ConfirmModal from '../components/common/ConfirmModal';
import AvatarUploader from '../components/common/AvatarUploader';

const ProfilePage = () => {
  const { uid } = useParams();
  const { t, lang, setLang } = useI18n();
  const { profile, updateProfile } = useAuth();

  const [characters, setCharacters] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState(null);
  const [activeTab, setActiveTab] = useState('characters');
  const [viewedProfile, setViewedProfile] = useState(null);

  // Form State for User Account
  const [accountFormData, setAccountFormData] = useState({
    nickname: '',
    status_line: '',
    avatar_url: '',
    theme: 'dark',
    language: 'en',
    show_footer: true,
    signature: ''
  });

  // Confirm Modal State
  const [confirmState, setConfirmState] = useState({
    show: false,
    onConfirm: () => { },
    title: '',
    message: ''
  });

  // Toast notification
  const [toast, setToast] = useState({ show: false, message: '', variant: 'success' });
  const showToast = (message, variant = 'success') => {
    setToast({ show: true, message, variant });
  };

  // Form State for Character
  const [formData, setFormData] = useState({
    name: '',
    status_line: '',
    avatar_url: '',
    signature: '',
    show_footer: true
  });

  useEffect(() => {
    const unsubscribe = subscribeToCharacters(uid, setCharacters);
    const unsubProfile = subscribeToUser(uid, setViewedProfile);
    return () => {
      unsubscribe();
      unsubProfile();
    };
  }, [uid]);

  // Sync form data with profile (only if viewing own profile)
  useEffect(() => {
    if (profile && profile.uid === uid) {
      setAccountFormData({
        nickname: profile.nickname || profile.displayName || '',
        status_line: profile.status_line || '',
        avatar_url: profile.avatar_url || profile.photoURL || '',
        theme: profile.settings?.theme || 'dark',
        language: profile.settings?.language || 'en',
        show_footer: profile.settings?.show_footer !== false,
        signature: profile.settings?.signature || ''
      });
    }
  }, [profile, uid]);

  const handleOpenModal = (char = null) => {
    if (char) {
      setEditingChar(char);
      setFormData({
        name: char.name,
        status_line: char.status_line || '',
        avatar_url: char.avatar_url,
        signature: char.signature || '',
        show_footer: char.show_footer !== false
      });
    } else {
      setEditingChar(null);
      setFormData({
        name: '',
        status_line: '',
        avatar_url: '',
        signature: '',
        show_footer: true
      });
    }
    setShowModal(true);
  };

  const handleSaveCharacter = async () => {
    if (!formData.name) return;
    try {
      if (editingChar) {
        await updateCharacter(uid, editingChar.id, formData);
      } else {
        await addCharacter(uid, formData);
      }
      setShowModal(false);
    } catch (err) {
      console.error(err);
      showToast(lang === 'ru' ? 'Не удалось сохранить персонажа' : 'Failed to save character', 'danger');
    }
  };

  const handleSaveAccount = async () => {
    try {
      const updates = {
        nickname: accountFormData.nickname,
        status_line: accountFormData.status_line,
        avatar_url: accountFormData.avatar_url,
        settings: {
          theme: accountFormData.theme,
          language: accountFormData.language,
          show_footer: accountFormData.show_footer,
          signature: accountFormData.signature
        }
      };
      await updateProfile(updates);
      // Sync local language immediately
      if (accountFormData.language !== lang) {
        setLang(accountFormData.language);
      }
      showToast(lang === 'ru' ? 'Профиль обновлён!' : 'Profile updated successfully!');
    } catch (err) {
      console.error(err);
      showToast(lang === 'ru' ? 'Не удалось обновить профиль' : 'Failed to update profile', 'danger');
    }
  };

  const handleDelete = (id) => {
    setConfirmState({
      show: true,
      title: t('profile.delete_character'),
      message: t('profile.delete_character') + '?',
      onConfirm: async () => {
        try {
          await deleteCharacter(uid, id);
        } catch (err) {
          console.error(err);
        }
      }
    });
  };

  return (
    <Container className="py-5">
      <Row className="mb-4 align-items-center">
        <Col>
          <h2 className="mb-0">{t('nav.profile')}</h2>
        </Col>
      </Row>

      <Row>
        <Col lg={4} className="mb-4">
          <Card className="shadow-sm border-0">
            <Card.Header className="py-3">
              <h5 className="mb-0">{t('profile.info')}</h5>
            </Card.Header>
            <Card.Body className="p-4 text-center">
              <div className="mb-4">
                <Image
                  src={viewedProfile?.avatar_url || viewedProfile?.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(viewedProfile?.nickname || 'User')}&background=random`}
                  roundedCircle
                  className="mb-3 border border-3 border-light shadow-sm"
                  style={{ width: '120px', height: '120px', objectFit: 'cover' }}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    e.target.onerror = null;
                    e.target.src = 'https://ui-avatars.com/api/?name=User&background=666&color=fff';
                  }}
                />
                <h4 className="mb-1">{viewedProfile?.nickname || 'No Nickname'}</h4>
                <p className="text-muted small mb-0 text-truncate mx-auto" style={{ maxWidth: '250px' }}>
                  {viewedProfile?.status_line || 'No status set'}
                </p>
              </div>

              <div className="mb-3 text-start border-top pt-3 d-flex justify-content-between align-items-center">
                <div>
                  <span className="text-muted d-block small mb-1">{t('profile.posts_count')}</span>
                  <div className="fw-bold fs-5">{viewedProfile?.post_count || 0}</div>
                </div>
              </div>

              <div className="mb-3 text-start border-top pt-3">
                <span className="text-muted d-block small mb-1">Email</span>
                <div className="fw-bold text-truncate">{viewedProfile?.email}</div>
              </div>
              <div className="mb-0 text-start">
                <span className="text-muted d-block small mb-1 fw-bold text-uppercase" style={{ fontSize: '0.65rem', letterSpacing: '0.1em' }}>
                  {t('profile.account_role')}
                </span>
                <div className="role-badge">{viewedProfile?.role_id?.toUpperCase()}</div>
              </div>
            </Card.Body>
          </Card>
        </Col>

        <Col lg={8}>
          <Tabs
            activeKey={activeTab}
            onSelect={(k) => setActiveTab(k)}
            id="profile-tabs"
            className="mb-4 premium-tabs"
          >
            <Tab eventKey="characters" title={t('profile.tab_characters')}>
              <Card className="shadow-sm border-0">
                <Card.Header className="py-3 d-flex justify-content-between align-items-center bg-white">
                  <h5 className="mb-0">{t('profile.characters')}</h5>
                  <Button variant="primary" size="sm" onClick={() => handleOpenModal()}>
                    + {t('profile.add_character')}
                  </Button>
                </Card.Header>
                <Card.Body className="p-0">
                  {characters.length === 0 ? (
                    <div className="p-5 text-center text-muted">
                      <p className="mb-0">{t('profile.no_characters')}</p>
                    </div>
                  ) : (
                    <Table hover responsive className="mb-0 overflow-hidden">
                      <thead>
                        <tr>
                          <th style={{ width: '80px' }}></th>
                          <th>{t('profile.character_name')}</th>
                          <th className="text-end">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {characters.map(char => (
                          <tr key={char.id} className="align-middle">
                            <td>
                              <Image
                                src={char.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(char.name)}&background=random`}
                                roundedCircle
                                style={{ width: '40px', height: '40px', objectFit: 'cover' }}
                                onError={(e) => {
                                  e.target.onerror = null;
                                  e.target.src = 'https://ui-avatars.com/api/?name=?&background=666&color=fff';
                                }}
                              />
                            </td>
                            <td className="fw-bold">{char.name}</td>
                            <td className="text-end">
                              <Button
                                variant="link"
                                size="sm"
                                className="text-decoration-none me-2"
                                onClick={() => handleOpenModal(char)}
                              >
                                {t('profile.edit_character')}
                              </Button>
                              <Button
                                variant="link"
                                size="sm"
                                className="text-decoration-none text-danger"
                                onClick={() => handleDelete(char.id)}
                              >
                                {t('profile.delete_character')}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Card.Body>
              </Card>
            </Tab>

            {profile?.uid === uid && (
              <Tab eventKey="account" title={t('profile.tab_profile')}>
                <Card className="shadow-sm border-0">
                  <Card.Header className="py-3">
                    <h5 className="mb-0">{t('profile.tab_profile')}</h5>
                  </Card.Header>
                  <Card.Body className="p-4">
                    <Form>
                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold">{t('profile.nickname')}</Form.Label>
                        <Form.Control
                          type="text"
                          value={accountFormData.nickname}
                          onChange={(e) => setAccountFormData({ ...accountFormData, nickname: e.target.value })}
                          placeholder="Display Name"
                        />
                      </Form.Group>
                      <Form.Group className="mb-3">
                        <div className="d-flex justify-content-between align-items-center mb-1">
                          <Form.Label className="fw-bold mb-0">{t('profile.status_line')}</Form.Label>
                          <small className="text-muted">{(accountFormData.status_line || '').length}/100</small>
                        </div>
                        <Form.Control
                          type="text"
                          value={accountFormData.status_line}
                          onChange={(e) => setAccountFormData({ ...accountFormData, status_line: e.target.value })}
                          placeholder="What's on your mind?"
                          maxLength={100}
                        />
                      </Form.Group>
                      <Form.Group className="mb-3">
                        <AvatarUploader
                          label={t('profile.avatar_url')}
                          value={accountFormData.avatar_url}
                          onChange={(url) => setAccountFormData({ ...accountFormData, avatar_url: url })}
                          storagePath={`users/${uid}/avatar`}
                          size={100}
                        />
                      </Form.Group>
                      <Button variant="primary" onClick={handleSaveAccount} className="px-4">
                        {t('common.save')}
                      </Button>
                    </Form>
                  </Card.Body>
                </Card>
              </Tab>
            )}

            {profile?.uid === uid && (
              <Tab eventKey="settings" title={t('profile.tab_settings')}>
                <Card className="shadow-sm border-0">
                  <Card.Header className="py-3">
                    <h5 className="mb-0">{t('profile.tab_settings')}</h5>
                  </Card.Header>
                  <Card.Body className="p-4">
                    <Form>
                      <Row>
                        <Col md={6}>
                          <Form.Group className="mb-3">
                            <Form.Label className="fw-bold">{t('profile.language')}</Form.Label>
                            <Form.Select
                              value={accountFormData.language}
                              onChange={(e) => setAccountFormData({ ...accountFormData, language: e.target.value })}
                            >
                              <option value="en">English</option>
                              <option value="ru">Русский</option>
                            </Form.Select>
                          </Form.Group>
                        </Col>
                        <Col md={6}>
                          <Form.Group className="mb-3">
                            <Form.Label className="fw-bold">{t('profile.theme')}</Form.Label>
                            <Form.Select
                              value={accountFormData.theme}
                              onChange={(e) => setAccountFormData({ ...accountFormData, theme: e.target.value })}
                            >
                              <option value="light">{t('profile.theme_light')}</option>
                              <option value="dark">{t('profile.theme_dark')}</option>
                              <option value="neutral">{t('profile.theme_neutral')}</option>
                            </Form.Select>
                          </Form.Group>
                        </Col>
                      </Row>

                      <hr className="my-4" />

                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold text-primary small text-uppercase" style={{ letterSpacing: '0.05em' }}>
                          {t('profile.signature')}
                        </Form.Label>
                        <Form.Control
                          as="textarea"
                          rows={3}
                          value={accountFormData.signature}
                          onChange={(e) => setAccountFormData({ ...accountFormData, signature: e.target.value })}
                          placeholder={t('profile.signature_help')}
                        />
                      </Form.Group>

                      <Form.Check
                        type="switch"
                        id="show-footer-tab-switch"
                        label={t('profile.show_footer')}
                        className="fw-bold mb-4"
                        checked={accountFormData.show_footer}
                        onChange={(e) => setAccountFormData({ ...accountFormData, show_footer: e.target.checked })}
                      />

                      <Button variant="primary" onClick={handleSaveAccount} className="px-4">
                        {t('common.save')}
                      </Button>
                    </Form>
                  </Card.Body>
                </Card>
              </Tab>
            )}
          </Tabs>
        </Col>
      </Row>

      {/* Character Modal (Remains for creating/editing characters) */}
      <Modal
        show={showModal}
        onHide={() => setShowModal(false)}
        centered
        className="premium-modal"
        backdropClassName="confirm-modal-backdrop"
      >
        <Modal.Header closeButton className="border-0">
          <Modal.Title className="fw-bold">{editingChar ? t('profile.edit_character') : t('profile.add_character')}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="p-4">
          <Form>
            <Form.Group className="mb-3" controlId="charName">
              <Form.Label className="fw-bold">{t('profile.character_name')}</Form.Label>
              <Form.Control
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Aragorn"
              />
            </Form.Group>

            <Form.Group className="mb-3" controlId="charStatus">
              <div className="d-flex justify-content-between align-items-center mb-1">
                <Form.Label className="fw-bold mb-0">{t('profile.character_status')}</Form.Label>
                <small className="text-muted">{(formData.status_line || '').length}/100</small>
              </div>
              <Form.Control
                type="text"
                value={formData.status_line}
                onChange={(e) => setFormData({ ...formData, status_line: e.target.value })}
                placeholder="e.g. Hunting orcs..."
                maxLength={100}
              />
            </Form.Group>

            <Form.Group className="mb-3" controlId="charAvatar">
              <AvatarUploader
                label={t('profile.avatar_url')}
                value={formData.avatar_url}
                onChange={(url) => setFormData({ ...formData, avatar_url: url })}
                storagePath={`users/${uid}/characters/${editingChar?.id || 'new'}_avatar`}
                size={80}
              />
            </Form.Group>

            <Form.Group className="mb-3" controlId="charSignature">
              <Form.Label className="fw-bold text-primary small uppercase">{t('profile.signature')}</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                value={formData.signature}
                onChange={(e) => setFormData({ ...formData, signature: e.target.value })}
                placeholder={t('profile.signature_help')}
                className="bg-light"
              />
            </Form.Group>

            <Form.Check
              type="switch"
              id="char-show-footer-switch"
              label={t('profile.show_footer')}
              className="fw-bold"
              checked={formData.show_footer}
              onChange={(e) => setFormData({ ...formData, show_footer: e.target.checked })}
            />
          </Form>
        </Modal.Body>
        <Modal.Footer className="border-0">
          <Button variant="outline-secondary" onClick={() => setShowModal(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSaveCharacter}>
            {editingChar ? t('common.save') : t('profile.add_character')}
          </Button>
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={confirmState.show}
        onHide={() => setConfirmState(prev => ({ ...prev, show: false }))}
        onConfirm={confirmState.onConfirm}
        title={confirmState.title}
        message={confirmState.message}
      />

      <ToastContainer position="bottom-end" className="p-3" style={{ zIndex: 1100 }}>
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

export default ProfilePage;
