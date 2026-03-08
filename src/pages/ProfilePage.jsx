import React, { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Container, Row, Col, Card, Button, Table, Modal, Form, Image, Tabs, Tab, Toast, ToastContainer, Badge, OverlayTrigger, Tooltip, Spinner } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { User, Settings, LogOut, MessageSquare, TrendingUp, TrendingDown, Save } from 'lucide-react';
import { subscribeToCharacters, addCharacter, updateCharacter, deleteCharacter } from '../api/character';
import { subscribeToUser, checkNicknameExists } from '../api/forum';
import ConfirmModal from '../components/common/ConfirmModal';
import AvatarUploader from '../components/common/AvatarUploader';
import { voteOnProfile, subscribeToReputationLogs } from '../api/reputation';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';

const ProfilePage = () => {
  const { uid } = useParams();
  const { t, lang, setLang } = useI18n();
  const { profile, updateProfile, recordActivity } = useAuth();

  const [characters, setCharacters] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'characters';
  const setActiveTab = (k) => setSearchParams({ tab: k }, { replace: true });
  const [viewedProfile, setViewedProfile] = useState(null);
  const [savingAccount, setSavingAccount] = useState(false);

  // Form State for User Account
  const [accountFormData, setAccountFormData] = useState({
    nickname: '',
    status_line: '',
    avatar_url: '',
    theme: 'dark',
    language: 'en',
    signature: '',
    rep_show_history: true,
    rep_show_comments: true
  });

  // Reputation Voting State
  const [showRepModal, setShowRepModal] = useState(false);
  const [repValue, setRepValue] = useState(1);
  const [repComment, setRepComment] = useState('');
  const [submittingRep, setSubmittingRep] = useState(false);
  const [repLogs, setRepLogs] = useState([]);

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
    signature: ''
  });

  useEffect(() => {
    const unsubscribe = subscribeToCharacters(uid, setCharacters);
    const unsubProfile = subscribeToUser(uid, setViewedProfile);
    const unsubRep = subscribeToReputationLogs(uid, setRepLogs);
    return () => {
      unsubscribe();
      unsubProfile();
      unsubRep();
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
        signature: profile.settings?.signature || '',
        rep_show_history: profile.settings?.rep_show_history !== false,
        rep_show_comments: profile.settings?.rep_show_comments !== false
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
        signature: char.signature || ''
      });
    } else {
      setEditingChar(null);
      setFormData({
        name: '',
        status_line: '',
        avatar_url: '',
        signature: ''
      });
    }
    setShowModal(true);
  };

  const handleSaveCharacter = async () => {
    if (!formData.name) return;
    recordActivity();
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
    recordActivity();
    setSavingAccount(true);

    try {
      const trimmedNickname = accountFormData.nickname?.trim();
      if (!trimmedNickname) {
        setSavingAccount(false);
        return;
      }

      // Check for uniqueness if the nickname has actually changed
      if (trimmedNickname !== profile.nickname) {
        const isTaken = await checkNicknameExists(trimmedNickname, uid);
        if (isTaken) {
          showToast(t('common.error_nickname_taken') || (lang === 'ru' ? 'Этот никнейм уже занят.' : 'This nickname is already taken.'), 'danger');
          setSavingAccount(false);
          return;
        }
      }

      const updates = {
        nickname: trimmedNickname,
        status_line: accountFormData.status_line?.trim() || '',
        avatar_url: accountFormData.avatar_url,
        settings: {
          theme: accountFormData.theme,
          language: accountFormData.language,
          signature: accountFormData.signature,
          rep_show_history: accountFormData.rep_show_history ?? true,
          rep_show_comments: accountFormData.rep_show_comments ?? true
        }
      };
      await updateProfile(updates);
      if (accountFormData.language !== lang) {
        setLang(accountFormData.language);
      }
      showToast(lang === 'ru' ? 'Вам удалось обновить профиль' : 'Profile updated successfully!');
    } catch (err) {
      console.error(err);
      showToast(lang === 'ru' ? 'Не удалось обновить профиль' : 'Failed to update profile', 'danger');
    } finally {
      setSavingAccount(false);
    }
  };

  const handleRepVote = async () => {
    if (!profile || profile.uid === uid || profile.role_id === 'spectator') return;
    setSubmittingRep(true);
    try {
      await voteOnProfile(profile.uid, uid, repValue, repComment);
      setRepComment('');
      setShowRepModal(false);
      showToast(t('profile.rep_success'));
      recordActivity();
    } catch (err) {
      console.error(err);
      showToast(err.message, 'danger');
    } finally {
      setSubmittingRep(false);
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
          <Card className="shadow-sm border-0 bg-card">
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
                <div className="text-end">
                  <span className="text-muted d-block small mb-1">{t('profile.reputation')}</span>
                  <div className="d-flex align-items-center gap-2">
                    <div className="fw-bold fs-5 text-accent">{viewedProfile?.reputation || 0}</div>
                    {profile?.uid !== uid && profile?.role_id !== 'spectator' && (
                      <div className="d-flex gap-1">
                        <Button size="sm" variant="outline-danger" className="py-0 px-2" onClick={() => { setRepValue(-1); setShowRepModal(true); }}>−</Button>
                        <Button size="sm" variant="outline-success" className="py-0 px-2" onClick={() => { setRepValue(1); setShowRepModal(true); }}>+</Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {(profile?.uid === uid || profile?.role_id === 'admin') && (
                <div className="mb-3 text-start border-top pt-3">
                  <span className="text-muted d-block small mb-1">{t('common.email')}</span>
                  <div className="fw-bold text-truncate">{viewedProfile?.email}</div>
                </div>
              )}
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
              <Card className="shadow-sm border-0 bg-card">
                <Card.Header className="py-3 d-flex justify-content-between align-items-center">
                  <h5 className="mb-0">{profile?.uid === uid ? t('profile.characters') : t('profile.characters_other')}</h5>
                  {profile?.uid === uid && profile?.role_id !== 'spectator' && (
                    <Button variant="primary" size="sm" onClick={() => handleOpenModal()}>
                      + {t('profile.add_character')}
                    </Button>
                  )}
                </Card.Header>
                <Card.Body className="p-0">
                  {characters.length === 0 ? (
                    <div className="p-5 text-center text-muted">
                      <p className="mb-0">{profile?.uid === uid ? t('profile.no_characters') : t('profile.no_characters_other')}</p>
                    </div>
                  ) : (
                    <Row className="g-3 p-3">
                      {characters.map(char => (
                        <Col key={char.id} xs={12} md={6}>
                          <Card className="h-100 border shadow-sm modal-inner-card">
                            <Card.Body className="d-flex align-items-center gap-3 p-3">
                              <Image
                                src={char.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(char.name)}&background=random`}
                                roundedCircle
                                style={{ width: '64px', height: '64px', objectFit: 'cover' }}
                                className="border border-2 border-accent shadow-sm"
                                onError={(e) => {
                                  e.target.onerror = null;
                                  e.target.src = 'https://ui-avatars.com/api/?name=?&background=666&color=fff';
                                }}
                              />
                              <div className="flex-grow-1 min-w-0">
                                <h6 className="mb-1 fw-bold text-truncate">{char.name}</h6>
                                {char.status_line ? (
                                  <p className="text-muted small mb-0 text-truncate" style={{ fontStyle: 'italic', opacity: 0.8 }}>
                                    {char.status_line}
                                  </p>
                                ) : (
                                  <p className="text-muted small mb-0 opacity-50">
                                    {lang === 'ru' ? 'Нет статуса' : 'No status'}
                                  </p>
                                )}
                              </div>
                              {profile?.uid === uid && (
                                <div className="d-flex flex-column gap-1 align-items-end">
                                  <Button
                                    variant="link"
                                    size="sm"
                                    className="text-decoration-none p-0 text-primary small fw-bold"
                                    onClick={() => handleOpenModal(char)}
                                  >
                                    {t('profile.edit_character')}
                                  </Button>
                                  <Button
                                    variant="link"
                                    size="sm"
                                    className="text-decoration-none p-0 text-danger small"
                                    onClick={() => handleDelete(char.id)}
                                  >
                                    {t('profile.delete_character')}
                                  </Button>
                                </div>
                              )}
                            </Card.Body>
                          </Card>
                        </Col>
                      ))}
                    </Row>
                  )}
                </Card.Body>
              </Card>
            </Tab>

            <Tab eventKey="reputation" title={t('profile.tab_reputation')}>
              <Card className="shadow-sm border-0 bg-card">
                <Card.Header className="py-3">
                  <h5 className="mb-0">{t('profile.tab_reputation')}</h5>
                </Card.Header>
                <Card.Body className="p-0">
                  {viewedProfile?.settings?.rep_show_history === false && profile?.uid !== uid ? (
                    <div className="p-5 text-center text-muted">
                      <p className="mb-0">{t('profile.rep_history_hidden')}</p>
                    </div>
                  ) : repLogs.length === 0 ? (
                    <div className="p-5 text-center text-muted">
                      <p className="mb-0">{t('forum.no_posts')}</p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <Table hover className="mb-0">
                        <thead>
                          <tr>
                            <th className="px-4">{t('profile.rep_date')}</th>
                            <th className="text-center" title={lang === 'ru' ? 'Тип голоса' : 'Vote Type'}>
                              <div className="small fw-bold text-uppercase opacity-50">Type</div>
                            </th>
                            <th>{t('profile.rep_from')}</th>
                            <th className="text-center">{t('profile.rep_value')}</th>
                            <th>{t('profile.rep_comment')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {repLogs.map(log => (
                            <tr key={log.id}>
                              <td className="px-4 py-3 small text-muted">
                                {log.created_at ? format(log.created_at.toDate(), 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS }) : '...'}
                              </td>
                              <td className="py-3 text-center">
                                <OverlayTrigger
                                  placement="top"
                                  overlay={
                                    <Tooltip>
                                      {log.post_id || log.topic_id ? (
                                        <>
                                          <div className="fw-bold">{lang === 'ru' ? 'Голос за сообщение' : 'Post vote'}</div>
                                          {log.topic_title && <div className="small opacity-75 mt-1">{log.topic_title}</div>}
                                          {log.post_number && <div className="small opacity-75">#{log.post_number}</div>}
                                        </>
                                      ) : (
                                        lang === 'ru' ? 'Голос за профиль' : 'Profile vote'
                                      )}
                                    </Tooltip>
                                  }
                                >
                                  <div className="d-inline-block">
                                    {log.post_id || log.topic_id ? (
                                      <MessageSquare size={16} className="text-primary opacity-75" />
                                    ) : (
                                      <User size={16} className="text-accent opacity-75" />
                                    )}
                                  </div>
                                </OverlayTrigger>
                              </td>
                              <td className="py-3">
                                <Link to={`/profile/${log.voter_id}`} className="text-decoration-none fw-semibold">
                                  {log.voter_nickname || 'User'}
                                </Link>
                              </td>
                              <td className="py-3 text-center">
                                <OverlayTrigger
                                  placement="top"
                                  overlay={
                                    <Tooltip>
                                      {log.topic_id ? (
                                        <>
                                          {log.topic_title && <div className="fw-bold mb-1">{log.topic_title}</div>}
                                          {log.post_number && <div className="small opacity-75 mb-1">#{log.post_number}</div>}
                                          <div>{lang === 'ru' ? 'Перейти к сообщению' : 'Go to post'}</div>
                                        </>
                                      ) : (
                                        lang === 'ru' ? 'Голос за профиль' : 'Profile vote'
                                      )}
                                    </Tooltip>
                                  }
                                >
                                  <Badge
                                    bg={log.value > 0 ? 'success' : 'danger'}
                                    as={log.topic_id ? Link : 'span'}
                                    to={log.topic_id ? `/topic/${log.topic_id}${log.post_id ? `#post-${log.post_id}` : ''}` : undefined}
                                    className={log.topic_id ? 'text-decoration-none d-inline-flex align-items-center gap-1' : 'd-inline-flex align-items-center gap-1'}
                                    style={{ cursor: log.topic_id ? 'pointer' : 'default', padding: '0.4em 0.6em' }}
                                  >
                                    {log.value > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                                    <span>{log.value > 0 ? `+${log.value}` : log.value}</span>
                                  </Badge>
                                </OverlayTrigger>
                              </td>
                              <td className="py-3">
                                {viewedProfile?.settings?.rep_show_comments === false && profile?.uid !== uid ? (
                                  <span className="text-muted small italic">{t('profile.rep_comments_hidden')}</span>
                                ) : (
                                  log.comment || '—'
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                  )}
                </Card.Body>
              </Card>
            </Tab>

            {profile?.uid === uid && (
              <Tab eventKey="account" title={t('profile.tab_profile')}>
                <Card className="shadow-sm border-0 bg-card">
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
                      {profile?.role_id !== 'spectator' && (
                        <Form.Group className="mb-3">
                          <div className="d-flex justify-content-between align-items-center mb-1">
                            <Form.Label className="fw-bold mb-0">{t('profile.status_line')}</Form.Label>
                            <small className="text-muted">{(accountFormData.status_line || '').length}/30</small>
                          </div>
                          <Form.Control
                            type="text"
                            value={accountFormData.status_line}
                            onChange={(e) => setAccountFormData({ ...accountFormData, status_line: e.target.value })}
                            placeholder="What's on your mind?"
                            maxLength={30}
                          />
                        </Form.Group>
                      )}
                      <Form.Group className="mb-3">
                        <AvatarUploader
                          label={t('profile.avatar')}
                          value={accountFormData.avatar_url}
                          onChange={(url) => setAccountFormData({ ...accountFormData, avatar_url: url })}
                          storagePath={`users/${uid}/avatar`}
                          size={100}
                        />
                      </Form.Group>

                      {profile?.role_id !== 'spectator' && (
                        <>
                          <hr className="my-4" />
                          <Form.Group className="mb-4">
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
                        </>
                      )}

                      <Button
                        variant="primary"
                        onClick={handleSaveAccount}
                        className="px-4 d-flex align-items-center gap-2"
                        disabled={savingAccount}
                      >
                        {savingAccount ? (
                          <>
                            <Spinner as="span" animation="border" size="sm" role="status" aria-hidden="true" />
                            {t('common.loading')}
                          </>
                        ) : (
                          <>
                            <Save size={18} />
                            {t('common.save')}
                          </>
                        )}
                      </Button>
                    </Form>
                  </Card.Body>
                </Card>
              </Tab>
            )}

            {profile?.uid === uid && (
              <Tab eventKey="settings" title={t('profile.tab_settings')}>
                <Card className="shadow-sm border-0 bg-card">
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

                      {profile?.role_id !== 'spectator' && (
                        <>
                          <hr className="my-4" />
                          <h6 className="mb-3 text-primary uppercase small fw-bold">Reputation Privacy</h6>
                          <Form.Check
                            type="switch"
                            id="rep-history-switch"
                            label={t('profile.rep_privacy_show_history')}
                            className="mb-2"
                            checked={accountFormData.rep_show_history}
                            onChange={(e) => setAccountFormData({ ...accountFormData, rep_show_history: e.target.checked })}
                          />
                          <Form.Check
                            type="switch"
                            id="rep-comments-switch"
                            label={t('profile.rep_privacy_show_comments')}
                            className="mb-4"
                            checked={accountFormData.rep_show_comments}
                            onChange={(e) => setAccountFormData({ ...accountFormData, rep_show_comments: e.target.checked })}
                          />
                        </>
                      )}

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
                <small className="text-muted">{(formData.status_line || '').length}/30</small>
              </div>
              <Form.Control
                type="text"
                value={formData.status_line}
                onChange={(e) => setFormData({ ...formData, status_line: e.target.value })}
                placeholder="e.g. Hunting orcs..."
                maxLength={30}
              />
            </Form.Group>

            <Form.Group className="mb-3" controlId="charAvatar">
              <AvatarUploader
                label={t('profile.avatar')}
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

      <Modal show={showRepModal} onHide={() => setShowRepModal(false)} centered className="premium-modal">
        <Modal.Header closeButton className="border-0">
          <Modal.Title className="fw-bold">{t('profile.rep_give')}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="p-4">
          <div className="text-center mb-4">
            <Badge bg={repValue > 0 ? 'success' : 'danger'} className="fs-3 px-4 py-2">
              {repValue > 0 ? `+${repValue}` : repValue}
            </Badge>
          </div>
          <Form.Group>
            <Form.Label className="fw-bold">{t('profile.rep_comment_placeholder')}</Form.Label>
            <Form.Control
              as="textarea"
              rows={3}
              value={repComment}
              onChange={(e) => setRepComment(e.target.value)}
              placeholder="..."
              className="bg-light"
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer className="border-0">
          <Button variant="outline-secondary" onClick={() => setShowRepModal(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleRepVote} disabled={submittingRep}>
            {submittingRep ? t('common.loading') : t('common.confirm')}
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
