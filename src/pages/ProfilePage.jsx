import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Container, Row, Col, Card, Button, Table, Modal, Form, Image, Tabs, Tab } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToCharacters, addCharacter, updateCharacter, deleteCharacter } from '../api/character';
import ConfirmModal from '../components/common/ConfirmModal';

const ProfilePage = () => {
  const { uid } = useParams();
  const { t, lang, setLang } = useI18n();
  const { profile, updateProfile } = useAuth();
  
  const [characters, setCharacters] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState(null);
  const [activeTab, setActiveTab] = useState('characters');

  // Form State for User Account
  const [accountFormData, setAccountFormData] = useState({
    nickname: '',
    status: '',
    avatar_url: '',
    theme: 'dark',
    language: 'en',
    show_footer: true,
    signature: ''
  });

  // Confirm Modal State
  const [confirmState, setConfirmState] = useState({ 
    show: false, 
    onConfirm: () => {}, 
    title: '', 
    message: '' 
  });

  // Form State for Character
  const [formData, setFormData] = useState({
    name: '',
    title: '',
    avatar_url: '',
    signature: '',
    show_footer: true
  });

  useEffect(() => {
    if (uid) {
      const unsubscribe = subscribeToCharacters(uid, setCharacters);
      return () => unsubscribe();
    }
  }, [uid]);

  // Sync form data with profile (only if viewing own profile)
  useEffect(() => {
    if (profile && profile.uid === uid) {
      setAccountFormData({
        nickname: profile.nickname || profile.displayName || '',
        status: profile.status || '',
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
        title: char.title, 
        avatar_url: char.avatar_url,
        signature: char.signature || '',
        show_footer: char.show_footer !== false
      });
    } else {
      setEditingChar(null);
      setFormData({ 
        name: '', 
        title: '', 
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
      alert('Failed to save character');
    }
  };

  const handleSaveAccount = async () => {
    try {
      const updates = {
        nickname: accountFormData.nickname,
        status: accountFormData.status,
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
      alert('Profile updated successfully!');
    } catch (err) {
      console.error(err);
      alert('Failed to update profile');
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
                  src={profile?.avatar_url || profile?.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.nickname || 'User')}&background=random`} 
                  roundedCircle 
                  className="mb-3 border border-3 border-light shadow-sm"
                  style={{ width: '120px', height: '120px', objectFit: 'cover' }}
                  referrerPolicy="no-referrer"
                  onError={(e) => { 
                    e.target.onerror = null; 
                    e.target.src = 'https://ui-avatars.com/api/?name=User&background=666&color=fff'; 
                  }}
                />
                <h4 className="mb-1">{profile?.nickname || 'No Nickname'}</h4>
                <p className="text-muted small mb-0">{profile?.status || 'No status set'}</p>
              </div>

              <div className="mb-3 text-start border-top pt-3">
                <span className="text-muted d-block small mb-1">Email</span>
                <div className="fw-bold text-truncate">{profile?.email}</div>
              </div>
              <div className="mb-0 text-start">
                <span className="text-muted d-block small mb-2 fw-bold text-uppercase" style={{ fontSize: '0.65rem', letterSpacing: '0.1em' }}>
                  {t('profile.account_role')}
                </span>
                <div className="role-badge">{profile?.role_id?.toUpperCase()}</div>
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
                          <th>{t('profile.character_title')}</th>
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
                            <td className="text-muted small">{char.title}</td>
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
                  <Card.Header className="py-3 bg-white">
                    <h5 className="mb-0">{t('profile.tab_profile')}</h5>
                  </Card.Header>
                  <Card.Body className="p-4">
                    <Form>
                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold">{t('profile.nickname')}</Form.Label>
                        <Form.Control 
                          type="text" 
                          value={accountFormData.nickname}
                          onChange={(e) => setAccountFormData({...accountFormData, nickname: e.target.value})}
                          placeholder="Display Name"
                        />
                      </Form.Group>
                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold">{t('profile.status')}</Form.Label>
                        <Form.Control 
                          type="text" 
                          value={accountFormData.status}
                          onChange={(e) => setAccountFormData({...accountFormData, status: e.target.value})}
                          placeholder="What's on your mind?"
                        />
                      </Form.Group>
                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold">{t('profile.avatar_url')}</Form.Label>
                        <Form.Control 
                          type="url" 
                          value={accountFormData.avatar_url}
                          onChange={(e) => setAccountFormData({...accountFormData, avatar_url: e.target.value})}
                          placeholder="https://..."
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
                  <Card.Header className="py-3 bg-white">
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
                              onChange={(e) => setAccountFormData({...accountFormData, language: e.target.value})}
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
                              onChange={(e) => setAccountFormData({...accountFormData, theme: e.target.value})}
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
                          onChange={(e) => setAccountFormData({...accountFormData, signature: e.target.value})}
                          placeholder={t('profile.signature_help')}
                          className="bg-light"
                        />
                      </Form.Group>

                      <Form.Check 
                        type="switch"
                        id="show-footer-tab-switch"
                        label={t('profile.show_footer')}
                        className="fw-bold mb-4"
                        checked={accountFormData.show_footer}
                        onChange={(e) => setAccountFormData({...accountFormData, show_footer: e.target.checked})}
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
                onChange={(e) => setFormData({...formData, name: e.target.value})}
                placeholder="e.g. Aragorn" 
              />
            </Form.Group>
            
            <Form.Group className="mb-3" controlId="charTitle">
              <Form.Label className="fw-bold">{t('profile.character_title')}</Form.Label>
              <Form.Control 
                type="text" 
                value={formData.title}
                onChange={(e) => setFormData({...formData, title: e.target.value})}
                placeholder="e.g. Strider" 
              />
            </Form.Group>
 
            <Form.Group className="mb-3" controlId="charAvatar">
              <Form.Label className="fw-bold">{t('profile.avatar_url')}</Form.Label>
              <Form.Control 
                type="url" 
                value={formData.avatar_url}
                onChange={(e) => setFormData({...formData, avatar_url: e.target.value})}
                placeholder="https://..." 
              />
            </Form.Group>

            <Form.Group className="mb-3" controlId="charSignature">
              <Form.Label className="fw-bold text-primary small uppercase">{t('profile.signature')}</Form.Label>
              <Form.Control 
                as="textarea"
                rows={3}
                value={formData.signature}
                onChange={(e) => setFormData({...formData, signature: e.target.value})}
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
              onChange={(e) => setFormData({...formData, show_footer: e.target.checked})}
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
    </Container>
  );
};

export default ProfilePage;
