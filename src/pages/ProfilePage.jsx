import React, { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Container, Row, Col, Card, Button, Table, Modal, Form, Image, Tabs, Tab, Badge, OverlayTrigger, Tooltip, Spinner, Dropdown } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { User, Settings, LogOut, MessageSquare, TrendingUp, TrendingDown, Save, Lock, MessageCircle, Filter, MapPin, Cake, Briefcase, Heart, Share2, ClipboardList } from 'lucide-react';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumRoleBadge from '../components/common/ForumRoleBadge';
import { subscribeToCharacters, addCharacter, updateCharacter, deleteCharacter } from '../api/character';
import { subscribeToUser, checkNicknameExists, subscribeToCategories, subscribeToUserPosts } from '../api/forum';
import ConfirmModal from '../components/common/ConfirmModal';
import ForumModal from '../components/common/ForumModal';
import AvatarUploader from '../components/common/AvatarUploader';
import { voteOnProfile, subscribeToReputationLogs, getProfileVote } from '../api/reputation';
import { db } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import BBCode from '../components/common/BBCode';

import { useToast } from '../contexts/ToastProvider';
import DirectMessages from '../components/dm/DirectMessages';
import ForumPagination from '../components/common/ForumPagination';
import Skeleton from '../components/common/Skeleton';


const ProfilePage = () => {
  const { uid } = useParams();
  const { t, lang, setLang } = useI18n();
  const { profile, hasPermission, PERMISSIONS, settings, updateProfile, recordActivity } = useAuth();
  const { showToast } = useToast();

  const [characters, setCharacters] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const setActiveTab = (k) => setSearchParams({ tab: k }, { replace: true });
  const [viewedProfile, setViewedProfile] = useState(null);

  const isLimitedProfile = viewedProfile?.role_id === 'pending' || viewedProfile?.role_id === 'spectator' || viewedProfile?.role_id === 'banned';
  const isOwn = profile?.uid === uid;
  const canEditNickname = isOwn ? hasPermission(PERMISSIONS.EDIT_SELF_NICKNAME) : hasPermission(PERMISSIONS.EDIT_OTHERS_NICKNAMES);
  const canEditAvatar = isOwn ? hasPermission(PERMISSIONS.EDIT_SELF_AVATAR) : hasPermission(PERMISSIONS.EDIT_OTHERS_AVATARS);
  const canEditStatus = isOwn ? hasPermission(PERMISSIONS.EDIT_SELF_STATUS) : hasPermission(PERMISSIONS.EDIT_OTHERS_STATUSES);
  const canEditSignature = isOwn ? hasPermission(PERMISSIONS.EDIT_SELF_SIGNATURE) : hasPermission(PERMISSIONS.EDIT_OTHERS_SIGNATURES);
  const canEditAnyAccount = isOwn || canEditNickname || canEditAvatar || canEditStatus || canEditSignature;

  const hasTabs = !isLimitedProfile || profile?.uid === uid || canEditAnyAccount;
  const activeTab = searchParams.get('tab') || (!isLimitedProfile ? 'characters' : (profile?.uid === uid || canEditAnyAccount ? 'account' : ''));

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
    rep_show_comments: true,
    bio: '',
    location: '',
    birthday: '',
    occupation: '',
    interests: '',
    contacts: ''
  });

  // Reputation Voting State
  const [showRepModal, setShowRepModal] = useState(false);
  const [repValue, setRepValue] = useState(1);
  const [repComment, setRepComment] = useState('');
  const [submittingRep, setSubmittingRep] = useState(false);
  const [repLogs, setRepLogs] = useState([]);
  const [myVote, setMyVote] = useState(null);
  const [categories, setCategories] = useState([]);
  const [logTopicsInfo, setLogTopicsInfo] = useState({});
  const [userPosts, setUserPosts] = useState([]);
  const [userPostsLimit] = useState(100); // Fetch more for pagination
  const [currentPagePosts, setCurrentPagePosts] = useState(1);
  const [loadingUserPosts, setLoadingUserPosts] = useState(false);
  const [postFilter, setPostFilter] = useState('all');
  const POSTS_PER_PAGE = 10;

  // Confirm Modal State
  const [confirmState, setConfirmState] = useState({
    show: false,
    onConfirm: () => { },
    title: '',
    message: ''
  });



  // Form State for Character
  const [formData, setFormData] = useState({
    name: '',
    status_line: '',
    avatar_url: '',
    signature: ''
  });

  useEffect(() => {
    const unsubCats = subscribeToCategories(setCategories);
    const unsubscribe = subscribeToCharacters(uid, setCharacters);
    const unsubProfile = subscribeToUser(uid, (data) => {
      setViewedProfile(data);
    });
    const unsubRep = subscribeToReputationLogs(uid, setRepLogs);
    
    if (profile && profile.uid !== uid) {
      getProfileVote(profile.uid, uid).then(setMyVote).catch(console.error);
    } else {
      setMyVote(null);
    }

    return () => {
      unsubCats();
      unsubscribe();
      unsubProfile();
      unsubRep();
    };
  }, [uid, profile]);

  // Subscribe to user posts when on 'posts' tab
  useEffect(() => {
    if (!uid || activeTab !== 'posts') return;
    setLoadingUserPosts(true);
    const unsub = subscribeToUserPosts(uid, userPostsLimit, (posts) => {
      setUserPosts(posts);
      setLoadingUserPosts(false);
    });
    return () => unsub();
  }, [uid, userPostsLimit, activeTab]);

  // Fetch topics associated with reputation logs to check category visibility
  useEffect(() => {
    const fetchMissingTopics = async () => {
      const neededIds = [
        ...new Set([
          ...repLogs.map(l => l.topic_id),
          ...userPosts.map(p => p.topic_id)
        ].filter(Boolean))
      ];
      const newTopics = {};
      let needsUpdate = false;

      for (const tId of neededIds) {
        if (!logTopicsInfo[tId]) {
          try {
            const snap = await getDoc(doc(db, 'topics', tId));
            if (snap.exists()) {
              const data = snap.data();
              newTopics[tId] = { 
                category_id: data.category_id,
                title: data.title 
              };
              needsUpdate = true;
            } else {
              newTopics[tId] = { is_deleted: true };
              needsUpdate = true;
            }
          } catch (e) {
            console.error('Error fetching topic context', e);
          }
        }
      }

      if (needsUpdate) {
        setLogTopicsInfo(prev => ({ ...prev, ...newTopics }));
      }
    };
    if (repLogs.length > 0 || userPosts.length > 0) {
      fetchMissingTopics();
    }
  }, [repLogs, userPosts, logTopicsInfo]);

  // Sync form data with profile (own or if admin/mod is editing)
  useEffect(() => {
    const source = (profile?.uid === uid) ? profile : (canEditAnyAccount ? viewedProfile : null);
    if (source) {
      setAccountFormData({
        nickname: source.nickname || source.displayName || '',
        status_line: source.status_line || '',
        avatar_url: source.avatar_url || '',
        theme: source.settings?.theme || 'dark',
        language: source.settings?.language || 'en',
        signature: source.settings?.signature || '',
        rep_show_history: source.settings?.rep_show_history !== false,
        rep_show_comments: source.settings?.rep_show_comments !== false,
        bio: source.bio || '',
        location: source.location || '',
        birthday: source.birthday || '',
        occupation: source.occupation || '',
        interests: source.interests || '',
        contacts: source.contacts || ''
      });
    }
  }, [profile, viewedProfile, uid, canEditAnyAccount]);

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
    // Close modal first to avoid "stuck" transitions when subscription updates fire
    setShowModal(false);
    try {
      if (editingChar) {
        await updateCharacter(uid, editingChar.id, formData);
      } else {
        await addCharacter(uid, formData);
      }
    } catch (err) {
      console.error(err);
      showToast(lang === 'ru' ? 'Не удалось сохранить персонажа' : 'Failed to save character', 'danger');
      // If failed, we might want to re-open it, but usually a toast is enough
    }
  };

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';

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
      if (trimmedNickname !== viewedProfile?.nickname) {
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
        bio: accountFormData.bio?.trim() || '',
        location: accountFormData.location?.trim() || '',
        birthday: accountFormData.birthday?.trim() || '',
        occupation: accountFormData.occupation?.trim() || '',
        interests: accountFormData.interests?.trim() || '',
        contacts: accountFormData.contacts?.trim() || '',
        settings: {
          theme: accountFormData.theme,
          language: accountFormData.language,
          signature: accountFormData.signature,
          rep_show_history: accountFormData.rep_show_history ?? true,
          rep_show_comments: accountFormData.rep_show_comments ?? true
        }
      };
      await updateProfile(updates, uid);
      if (uid === profile?.uid && accountFormData.language !== lang) {
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
      setShowRepModal(false); // Close AFTER success
      setMyVote({ value: repValue, comment: repComment });
      setRepComment('');
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
    const char = characters.find(c => c.id === id);
    setConfirmState({
      show: true,
      title: t('profile.delete_character'),
      message: (lang === 'ru' 
        ? `Вы уверены, что хотите удалить персонажа "${char?.name || '?'}"?` 
        : `Are you sure you want to delete character "${char?.name || '?'}"?`) + ' ' + (lang === 'ru' ? 'Это действие нельзя отменить.' : 'This action is irreversible.'),
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
      <ForumBreadcrumbs 
        items={[
          { label: t('nav.profile'), active: !viewedProfile?.nickname, to: '/profile' },
          viewedProfile?.nickname ? { label: viewedProfile.nickname, active: true } : null
        ].filter(Boolean)} 
      />
      <Row className="mb-4 align-items-center">
        <Col>
          <h2 className="mb-0">{t('nav.profile')}</h2>
        </Col>
      </Row>

      <Row className={!hasTabs ? "justify-content-center" : ""}>
        <Col lg={hasTabs ? 4 : 5} className="mb-4">
          <Card className="shadow-sm border-0 bg-card">
            <Card.Header className="py-3">
              <h5 className="mb-0">{t('profile.info')}</h5>
            </Card.Header>
            <Card.Body className="p-4 text-center">
              <div className="mb-4">
                {!viewedProfile ? (
                  <div className="mb-3">
                    <Skeleton variant="avatar" width={120} height={120} className="rounded-circle d-block mx-auto shadow-sm" style={{ border: '3px solid var(--border-color)' }} />
                    <Skeleton width="180px" height="1.8rem" className="d-block mx-auto mt-3" />
                    <Skeleton width="120px" height="0.9rem" className="d-block mx-auto mt-2" />
                  </div>
                ) : (
                  <>
                    <Image
                      src={viewedProfile?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(viewedProfile?.nickname || 'User')}&background=random`}
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
                  </>
                )}

                {/* Send Message Button */}
                {hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES) && viewedProfile?.role_id !== 'banned' && uid !== profile?.uid && (
                  <div className="mt-3">
                    <Button
                      as={Link}
                      to={`/messages/${uid}`}
                      variant="primary"
                      className="d-inline-flex align-items-center justify-content-center gap-2"
                      style={{ borderRadius: '20px', padding: '0.4rem 1.2rem', fontSize: '0.9rem' }}
                    >
                      <MessageCircle size={16} />
                      {lang === 'ru' ? 'Написать сообщение' : 'Send Message'}
                    </Button>
                  </div>
                )}
              </div>

              {!isLimitedProfile && (
                <div className="mb-3 text-start border-top pt-3 d-flex justify-content-between align-items-center">
                  <div>
                    <span className="text-muted d-block small mb-1">{t('profile.posts_count')}</span>
                    <div className="fw-bold fs-5">
                      {!viewedProfile ? <Skeleton width="30px" height="1.5rem" /> : (viewedProfile?.post_count || 0)}
                    </div>
                  </div>
                  <div className="text-end">
                    <span className="text-muted d-block small mb-1">{t('profile.reputation')}</span>
                      <div className="d-flex align-items-center justify-content-end gap-2">
                      <div className="fw-bold fs-5 text-accent">
                        {!viewedProfile ? <Skeleton width="30px" height="1.5rem" /> : (viewedProfile?.reputation || 0)}
                      </div>
                      {profile && profile.role_id !== 'pending' && profile.uid !== uid && profile.role_id !== 'spectator' && viewedProfile?.role_id !== 'banned' && (
                        <div className="d-flex gap-1 align-items-center">
                          {!myVote ? (
                            <>
                              <Button size="sm" variant="outline-danger" className="py-0 px-2" onClick={() => { setRepValue(-1); setShowRepModal(true); }}>−</Button>
                              <Button size="sm" variant="outline-success" className="py-0 px-2" onClick={() => { setRepValue(1); setShowRepModal(true); }}>+</Button>
                            </>
                          ) : (
                            <Badge bg={myVote.value > 0 ? 'success' : 'danger'} className="ms-1" style={{ opacity: 0.8 }}>
                              {myVote.value > 0 ? `+${myVote.value}` : myVote.value}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {(profile?.uid === uid || hasPermission('admin_access')) && (
                <div className="mb-3 text-start border-top pt-3">
                  <span className="text-muted d-block small mb-1">{t('common.email')}</span>
                  <div className="fw-bold text-truncate">{viewedProfile?.email}</div>
                </div>
              )}
              <div className="mb-0 text-start">
                <span className="text-muted d-block small mb-1 fw-bold text-uppercase" style={{ fontSize: '0.65rem', letterSpacing: '0.1em' }}>
                  {t('profile.account_role')}
                </span>
                {!viewedProfile ? (
                  <Skeleton width="100px" height="1.5rem" className="mt-1" />
                ) : (
                  <ForumRoleBadge
                    roleId={viewedProfile?.role_id}
                    status={viewedProfile?.status}
                    userEmail={viewedProfile?.email}
                    isDeleted={viewedProfile === null}
                    className="px-3 py-1 mt-1 font-uppercase"
                  />
                )}
              </div>

            </Card.Body>
          </Card>
        </Col>

        {hasTabs && (
          <Col lg={8}>
              <Tabs
                activeKey={activeTab}
                onSelect={(k) => setActiveTab(k)}
                id="profile-tabs"
                className="mb-4 premium-tabs"
              >
                {!isLimitedProfile && (viewedProfile?.bio || viewedProfile?.contacts || viewedProfile?.location || viewedProfile?.birthday || viewedProfile?.occupation || viewedProfile?.interests) && (
                  <Tab eventKey="about" title={t('profile.tab_about')}>
                    <Card className="shadow-sm border-0 bg-card">
                      <Card.Header className="py-3">
                        <h5 className="mb-0">{t('profile.tab_about')}</h5>
                      </Card.Header>
                      <Card.Body className="p-4">
                        {viewedProfile?.bio && (
                          <div className={viewedProfile?.location || viewedProfile?.birthday || viewedProfile?.occupation || viewedProfile?.interests || viewedProfile?.contacts ? "mb-4 pb-4 border-bottom" : "mb-0"}>
                            <h6 className="text-primary text-uppercase small fw-bold mb-3 d-flex align-items-center gap-2">
                              <User size={16} /> {t('profile.bio')}
                            </h6>
                            <div className="post-content fs-5" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
                              {viewedProfile.bio}
                            </div>
                          </div>
                        )}

                        {(viewedProfile?.location || viewedProfile?.birthday || viewedProfile?.occupation || viewedProfile?.interests) && (
                          <div className={viewedProfile?.contacts ? "mb-4 pb-4 border-bottom" : "mb-0"}>
                            <h6 className="text-primary text-uppercase small fw-bold mb-3 d-flex align-items-center gap-2">
                              <ClipboardList size={16} /> {lang === 'ru' ? 'Информация' : 'Information'}
                            </h6>
                            <Row className="g-4">
                              {viewedProfile?.location && (
                                <Col md={6}>
                                  <div className="d-flex align-items-start gap-2">
                                    <MapPin size={18} className="mt-1 flex-shrink-0 text-primary opacity-75" />
                                    <div>
                                      <span className="text-muted d-block small text-uppercase fw-bold" style={{ fontSize: '0.7rem' }}>{t('profile.location')}</span>
                                      <div className="fs-6">{viewedProfile.location}</div>
                                    </div>
                                  </div>
                                </Col>
                              )}
                              {viewedProfile?.birthday && (
                                <Col md={6}>
                                  <div className="d-flex align-items-start gap-2">
                                    <Cake size={18} className="mt-1 flex-shrink-0 text-danger opacity-75" />
                                    <div>
                                      <span className="text-muted d-block small text-uppercase fw-bold" style={{ fontSize: '0.7rem' }}>{t('profile.birthday')}</span>
                                      <div className="fs-6">{viewedProfile.birthday}</div>
                                    </div>
                                  </div>
                                </Col>
                              )}
                              {viewedProfile?.occupation && (
                                <Col md={6}>
                                  <div className="d-flex align-items-start gap-2">
                                    <Briefcase size={18} className="mt-1 flex-shrink-0 text-success opacity-75" />
                                    <div>
                                      <span className="text-muted d-block small text-uppercase fw-bold" style={{ fontSize: '0.7rem' }}>{t('profile.occupation')}</span>
                                      <div className="fs-6">{viewedProfile.occupation}</div>
                                    </div>
                                  </div>
                                </Col>
                              )}
                              {viewedProfile?.interests && (
                                <Col md={6}>
                                  <div className="d-flex align-items-start gap-2">
                                    <Heart size={18} className="mt-1 flex-shrink-0 text-accent opacity-75" />
                                    <div>
                                      <span className="text-muted d-block small text-uppercase fw-bold" style={{ fontSize: '0.7rem' }}>{t('profile.interests')}</span>
                                      <div className="fs-6">{viewedProfile.interests}</div>
                                    </div>
                                  </div>
                                </Col>
                              )}
                            </Row>
                          </div>
                        )}

                        {viewedProfile?.contacts && (
                          <div className="pt-2">
                            <h6 className="text-primary text-uppercase small fw-bold mb-3 d-flex align-items-center gap-2">
                              <Share2 size={16} /> {t('profile.contacts')}
                            </h6>
                            <div className="text-muted" style={{ whiteSpace: 'pre-wrap' }}>
                              {viewedProfile.contacts}
                            </div>
                          </div>
                        )}
                      </Card.Body>
                    </Card>
                  </Tab>
                )}
              {!isLimitedProfile && (
                <Tab eventKey="characters" title={t('profile.tab_characters')}>
              <Card className="shadow-sm border-0 bg-card">
                <Card.Header className="py-3 d-flex justify-content-between align-items-center">
                  <h5 className="mb-0">{isOwn ? t('profile.characters') : t('profile.characters_other')}</h5>
                  {((isOwn && hasPermission(PERMISSIONS.CREATE_SELF_MASK)) || (!isOwn && hasPermission(PERMISSIONS.CREATE_OTHERS_MASK))) && (
                    <Button variant="outline-light" size="sm" onClick={() => handleOpenModal()}>
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
                                <div className="d-flex flex-column gap-1 align-items-end">
                                  {(isOwn && hasPermission(PERMISSIONS.CREATE_SELF_MASK)) || hasPermission(PERMISSIONS.EDIT_OTHERS_MASK) ? (
                                    <Button
                                      variant="link"
                                      size="sm"
                                      className="text-decoration-none p-0 text-primary small fw-bold"
                                      onClick={() => handleOpenModal(char)}
                                    >
                                      {t('profile.edit_character')}
                                    </Button>
                                  ) : null}
                                  {(isOwn && hasPermission(PERMISSIONS.DELETE_SELF_MASK)) || hasPermission(PERMISSIONS.DELETE_OTHERS_MASK) ? (
                                    <Button
                                      variant="link"
                                      size="sm"
                                      className="text-decoration-none p-0 text-danger small"
                                      onClick={() => handleDelete(char.id)}
                                    >
                                      {t('profile.delete_character')}
                                    </Button>
                                  ) : null}
                                </div>
                            </Card.Body>
                          </Card>
                        </Col>
                      ))}
                    </Row>
                  )}
                </Card.Body>
              </Card>
                </Tab>
              )}

              {!isLimitedProfile && settings?.enableReputation && (
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
                          {repLogs.map(log => {
                            const isAllowed = (() => {
                              if (!log.topic_id) return true;
                              const info = logTopicsInfo[log.topic_id];
                              if (!info) return true; // not loaded yet
                              if (info.is_deleted) return false;
                              const cat = categories.find(c => c.id === info.category_id);
                              if (!cat) return false;
                              return hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
                            })();

                            return (
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
                                          {isAllowed && log.topic_title && <div className="small opacity-75 mt-1">{log.topic_title}</div>}
                                          {isAllowed && log.post_number && <div className="small opacity-75">#{log.post_number}</div>}
                                          {!isAllowed && <div className="small opacity-75 mt-1 text-warning d-flex align-items-center gap-1 justify-content-center"><Lock size={10}/> {t('forum.private_topic')}</div>}
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
                                          {isAllowed && log.topic_title && <div className="fw-bold mb-1">{log.topic_title}</div>}
                                          {isAllowed && log.post_number && <div className="small opacity-75 mb-1">#{log.post_number}</div>}
                                          {!isAllowed && <div className="fw-bold mb-1 text-warning d-flex align-items-center gap-1 justify-content-center"><Lock size={12}/> {t('forum.private_topic')}</div>}
                                          {isAllowed && <div>{lang === 'ru' ? 'Перейти к сообщению' : 'Go to post'}</div>}
                                        </>
                                      ) : (
                                        lang === 'ru' ? 'Голос за профиль' : 'Profile vote'
                                      )}
                                    </Tooltip>
                                  }
                                >
                                  <Badge
                                    bg={log.value > 0 ? 'success' : 'danger'}
                                    as={(log.topic_id && isAllowed) ? Link : 'span'}
                                    to={(log.topic_id && isAllowed) ? `/topic/${log.topic_id}${log.post_id ? `#post-${log.post_id}` : ''}` : undefined}
                                    className={log.topic_id ? 'text-decoration-none d-inline-flex align-items-center gap-1' : 'd-inline-flex align-items-center gap-1'}
                                    style={{ cursor: (log.topic_id && isAllowed) ? 'pointer' : 'default', padding: '0.4em 0.6em' }}
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
                            );
                          })}
                        </tbody>
                      </Table>
                    </div>
                  )}
                </Card.Body>
              </Card>
                </Tab>
              )}

              <Tab eventKey="posts" title={t('profile.tab_posts')}>
                <Card className="shadow-sm border-0 bg-card">
                  <Card.Header className="py-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
                    <h5 className="mb-0">{t('profile.tab_posts')}</h5>
                    <Dropdown onSelect={(k) => { setPostFilter(k); setCurrentPagePosts(1); }} align="end" className="flex-shrink-0">
                      <Dropdown.Toggle 
                        variant="link" 
                        size="sm" 
                        className="d-flex align-items-center gap-2 custom-select-toggle text-light text-decoration-none" 
                        style={{ minWidth: '160px' }}
                      >
                        <Filter size={14} className="opacity-75" />
                        <span className="text-truncate">
                          {postFilter === 'all' ? t('profile.filter_all') : 
                           postFilter === 'account' ? t('profile.filter_account') : 
                           characters.find(c => `char_${c.id}` === postFilter)?.name || t('profile.filter_masks')}
                        </span>
                      </Dropdown.Toggle>
                      <Dropdown.Menu className="shadow-sm border-0 mt-1 custom-select-menu" style={{ minWidth: '220px' }}>
                        <Dropdown.Item eventKey="all" active={postFilter === 'all'}>
                          <div className="d-flex align-items-center gap-2">
                            <Filter size={14} />
                            {t('profile.filter_all')}
                          </div>
                        </Dropdown.Item>
                        <Dropdown.Item eventKey="account" active={postFilter === 'account'}>
                          <div className="d-flex align-items-center gap-2">
                            <User size={14} />
                            {t('profile.filter_account')}
                          </div>
                        </Dropdown.Item>
                        {characters.length > 0 && (
                          <>
                            <Dropdown.Divider />
                            <Dropdown.Header className="small text-muted text-uppercase fw-bold opacity-75" style={{ fontSize: '0.65rem', letterSpacing: '0.05em', paddingLeft: '1rem' }}>
                              {t('profile.filter_masks')}
                            </Dropdown.Header>
                            {characters.map(c => (
                              <Dropdown.Item key={c.id} eventKey={`char_${c.id}`} active={postFilter === `char_${c.id}`}>
                                {c.name}
                              </Dropdown.Item>
                            ))}
                          </>
                        )}
                      </Dropdown.Menu>
                    </Dropdown>
                  </Card.Header>
                  <Card.Body className="p-0">
                    {(() => {
                      const filteredPosts = userPosts.filter(post => {
                        if (postFilter === 'all') return true;
                        if (postFilter === 'account') return !post.is_character;
                        if (postFilter.startsWith('char_')) {
                          const charId = postFilter.replace('char_', '');
                          return post.is_character && post.author_character_id === charId;
                        }
                        return true;
                      });

                      const totalPagesPosts = Math.ceil(filteredPosts.length / POSTS_PER_PAGE);

                      if (filteredPosts.length === 0) {
                        return (
                          <div className="p-5 text-center text-muted">
                            {loadingUserPosts ? t('common.loading') : <p className="mb-0">{t('profile.no_posts_user')}</p>}
                          </div>
                        );
                      }

                      const pagedPosts = filteredPosts.slice(
                        (currentPagePosts - 1) * POSTS_PER_PAGE,
                        currentPagePosts * POSTS_PER_PAGE
                      );

                      return (
                        <div className="posts-history-list">
                          {totalPagesPosts > 1 && (
                            <div className="p-3 d-flex justify-content-center border-bottom">
                              <ForumPagination 
                                currentPage={currentPagePosts}
                                totalPages={totalPagesPosts}
                                onPageChange={setCurrentPagePosts}
                              />
                            </div>
                          )}
                          {pagedPosts.map((post, idx) => {
                            const topicInfo = logTopicsInfo[post.topic_id];
                            const category = topicInfo ? categories.find(c => c.id === topicInfo.category_id) : null;
                            const isAllowed = topicInfo && category && hasPermission(PERMISSIONS.VIEW_FORUM, { category });
                            
                            if (topicInfo && !isAllowed) return null; // Hide restricted posts

                            // Only show border-bottom if not the last item OR if pagination follows
                            const isLastItem = idx === pagedPosts.length - 1;
                            const showBorder = !isLastItem || totalPagesPosts > 1;

                            return (
                              <div key={post.id} className={`p-3 hover-bg-light transition-all ${showBorder ? 'border-bottom' : ''}`}>
                                <div className="d-flex justify-content-between align-items-start mb-2">
                                  <div className="min-w-0">
                                    <Link 
                                      to={`/topic/${post.topic_id}?post=${post.id}`} 
                                      className="fw-bold text-decoration-none d-block line-clamp-2"
                                      style={{ fontSize: '1.1rem', lineHeight: '1.25' }}
                                    >
                                      {topicInfo?.title || '...'}
                                    </Link>
                                    <div className="d-flex align-items-center gap-2 mt-1">
                                      {category && (
                                        <Badge bg="secondary" className="opacity-75 fw-normal" style={{ fontSize: '0.7rem' }}>
                                          {resolveText(category.name)}
                                        </Badge>
                                      )}
                                      <span className="text-muted small">
                                        {post.created_at ? format(post.created_at.toDate(), 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS }) : '...'}
                                      </span>
                                    </div>
                                  </div>
                                  {post.is_character && (
                                    <Badge className="ms-2 badge-character">
                                      {post.author_name}
                                    </Badge>
                                  )}
                                </div>
                                <div className="post-preview text-muted small text-break line-clamp-4">
                                  <BBCode rolls={post.rolls}>{post.content}</BBCode>
                                </div>
                              </div>
                            );
                          })}
                          
                          {totalPagesPosts > 1 && (
                            <div className="p-3 d-flex justify-content-center border-top">
                              <ForumPagination 
                                currentPage={currentPagePosts}
                                totalPages={totalPagesPosts}
                                onPageChange={setCurrentPagePosts}
                              />
                            </div>
                          )}

                          {filteredPosts.length >= userPostsLimit && postFilter === 'all' && (
                            <div className="p-2 text-center text-muted small opacity-50 bg-light-subtle">
                              {lang === 'ru' 
                                ? 'Показаны последние 100 сообщений. Для доступа к более старым обратитесь к администратору для настройки индексов БД.' 
                                : 'Showing latest 100 posts. For more, database indexes tuning is required.'}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </Card.Body>
                </Card>
              </Tab>




              {canEditAnyAccount && (
              <Tab eventKey="account" title={t('profile.tab_profile')}>
                <Card className="shadow-sm border-0 bg-card">
                  <Card.Header className="py-3">
                    <h5 className="mb-0">{t('profile.tab_profile')}</h5>
                  </Card.Header>
                  <Card.Body className="p-4">
                    <Form>
                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold d-flex align-items-center flex-wrap mb-1">
                          {t('profile.nickname')}
                          {!canEditNickname && <Lock size={14} className="ms-2 opacity-50 text-muted" />}
                        </Form.Label>
                        <Form.Control
                          type="text"
                          value={accountFormData.nickname}
                          onChange={(e) => setAccountFormData({ ...accountFormData, nickname: e.target.value })}
                          placeholder="Display Name"
                          disabled={!canEditNickname}
                          style={!canEditNickname ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                        />
                      </Form.Group>
                      {hasPermission(PERMISSIONS.POST_REPLY) && (
                        <Form.Group className="mb-3">
                          <div className="d-flex justify-content-between align-items-center mb-1">
                            <Form.Label className="fw-bold mb-0 d-flex align-items-center">
                              {t('profile.status_line')}
                              {!canEditStatus && <Lock size={14} className="ms-2 opacity-50 text-muted" />}
                            </Form.Label>
                            <small className="text-muted">{(accountFormData.status_line || '').length}/30</small>
                          </div>
                          <Form.Control
                            type="text"
                            value={accountFormData.status_line}
                            onChange={(e) => setAccountFormData({ ...accountFormData, status_line: e.target.value })}
                            placeholder="What's on your mind?"
                            maxLength={30}
                            disabled={!canEditStatus}
                            style={!canEditStatus ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                          />
                        </Form.Group>
                      )}
                      {canEditAvatar && (
                        <Form.Group className="mb-3">
                          <AvatarUploader
                            label={
                              <div className="d-flex align-items-center mb-2">
                                <span className="fw-bold m-0 p-0" style={{ fontSize: '0.875rem' }}>{t('profile.avatar')}</span>
                              </div>
                            }
                            value={accountFormData.avatar_url}
                            onChange={(url) => setAccountFormData({ ...accountFormData, avatar_url: url })}
                            storagePath={`users/${uid}/avatar`}
                            size={100}
                            canUpload={profile?.role_id !== 'pending'}
                            disabled={false}
                          />
                        </Form.Group>
                      )}

                      {hasPermission(PERMISSIONS.POST_REPLY) && (
                        <>
                          <hr className="my-4" />
                          <Form.Group className="mb-4">
                            <Form.Label className="fw-bold text-primary small text-uppercase d-flex align-items-center mb-1" style={{ letterSpacing: '0.05em' }}>
                              {t('profile.signature')}
                              {!canEditSignature && <Lock size={14} className="ms-2 opacity-50 text-muted" />}
                            </Form.Label>
                            <Form.Control
                              as="textarea"
                              rows={3}
                              value={accountFormData.signature}
                              onChange={(e) => setAccountFormData({ ...accountFormData, signature: e.target.value })}
                              placeholder={t('profile.signature_help')}
                              disabled={!canEditSignature}
                              style={!canEditSignature ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                            />
                          </Form.Group>
                        </>
                      )}

                      <hr className="my-4" />
                      <h6 className="mb-3 text-primary uppercase small fw-bold d-flex align-items-center gap-2">
                        <ClipboardList size={18} /> {lang === 'ru' ? 'Дополнительная информация' : 'Additional Information'}
                      </h6>
                      
                      <Row>
                        <Col md={6}>
                          <Form.Group className="mb-3">
                            <Form.Label className="fw-bold d-flex align-items-center gap-2 small text-uppercase opacity-75">
                              <MapPin size={14} /> {t('profile.location')}
                            </Form.Label>
                            <Form.Control
                              type="text"
                              value={accountFormData.location}
                              onChange={(e) => setAccountFormData({ ...accountFormData, location: e.target.value })}
                              placeholder={lang === 'ru' ? 'Город, Страна' : 'City, Country'}
                            />
                          </Form.Group>
                        </Col>
                        <Col md={6}>
                          <Form.Group className="mb-3">
                            <Form.Label className="fw-bold d-flex align-items-center gap-2 small text-uppercase opacity-75">
                              <Cake size={14} /> {t('profile.birthday')}
                            </Form.Label>
                            <Form.Control
                              type="text"
                              value={accountFormData.birthday}
                              onChange={(e) => setAccountFormData({ ...accountFormData, birthday: e.target.value })}
                              placeholder="e.g. 15 June"
                            />
                          </Form.Group>
                        </Col>
                      </Row>

                      <Row>
                        <Col md={6}>
                          <Form.Group className="mb-3">
                            <Form.Label className="fw-bold d-flex align-items-center gap-2 small text-uppercase opacity-75">
                              <Briefcase size={14} /> {t('profile.occupation')}
                            </Form.Label>
                            <Form.Control
                              type="text"
                              value={accountFormData.occupation}
                              onChange={(e) => setAccountFormData({ ...accountFormData, occupation: e.target.value })}
                            />
                          </Form.Group>
                        </Col>
                        <Col md={6}>
                          <Form.Group className="mb-3">
                            <Form.Label className="fw-bold d-flex align-items-center gap-2 small text-uppercase opacity-75">
                              <Heart size={14} /> {t('profile.interests')}
                            </Form.Label>
                            <Form.Control
                              type="text"
                              value={accountFormData.interests}
                              onChange={(e) => setAccountFormData({ ...accountFormData, interests: e.target.value })}
                            />
                          </Form.Group>
                        </Col>
                      </Row>

                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold d-flex align-items-center gap-2 small text-uppercase opacity-75">
                          <Share2 size={14} /> {t('profile.contacts')}
                        </Form.Label>
                        <Form.Control
                          as="textarea"
                          rows={2}
                          value={accountFormData.contacts}
                          onChange={(e) => setAccountFormData({ ...accountFormData, contacts: e.target.value })}
                          placeholder={t('profile.contacts_help')}
                        />
                      </Form.Group>

                      <Form.Group className="mb-3">
                        <Form.Label className="fw-bold d-flex align-items-center gap-2 small text-uppercase opacity-75">
                          <User size={14} /> {t('profile.bio')}
                        </Form.Label>
                        <Form.Control
                          as="textarea"
                          rows={4}
                          value={accountFormData.bio}
                          onChange={(e) => setAccountFormData({ ...accountFormData, bio: e.target.value })}
                          placeholder={t('profile.bio_help')}
                        />
                      </Form.Group>

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
                            <Dropdown className="w-100">
                              <Dropdown.Toggle 
                                variant="outline-management" 
                                className="w-100 d-flex justify-content-between align-items-center custom-select-toggle"
                              >
                                {accountFormData.language === 'ru' ? 'Русский' : 'English'}
                              </Dropdown.Toggle>
                              <Dropdown.Menu className="w-100 custom-select-menu shadow-sm">
                                <Dropdown.Item 
                                  active={accountFormData.language === 'en'}
                                  onClick={() => setAccountFormData({ ...accountFormData, language: 'en' })}
                                >
                                  English
                                </Dropdown.Item>
                                <Dropdown.Item 
                                  active={accountFormData.language === 'ru'}
                                  onClick={() => setAccountFormData({ ...accountFormData, language: 'ru' })}
                                >
                                  Русский
                                </Dropdown.Item>
                              </Dropdown.Menu>
                            </Dropdown>
                          </Form.Group>
                        </Col>
                        <Col md={6}>
                          <Form.Group className="mb-3">
                            <Form.Label className="fw-bold">{t('profile.theme')}</Form.Label>
                            <Dropdown className="w-100">
                              <Dropdown.Toggle 
                                variant="outline-management" 
                                className="w-100 d-flex justify-content-between align-items-center custom-select-toggle"
                              >
                                {accountFormData.theme === 'light' ? t('profile.theme_light') : 
                                 accountFormData.theme === 'dark' ? t('profile.theme_dark') : 
                                 t('profile.theme_neutral')}
                              </Dropdown.Toggle>
                              <Dropdown.Menu className="w-100 custom-select-menu shadow-sm">
                                <Dropdown.Item 
                                  active={accountFormData.theme === 'light'}
                                  onClick={() => setAccountFormData({ ...accountFormData, theme: 'light' })}
                                >
                                  {t('profile.theme_light')}
                                </Dropdown.Item>
                                <Dropdown.Item 
                                  active={accountFormData.theme === 'dark'}
                                  onClick={() => setAccountFormData({ ...accountFormData, theme: 'dark' })}
                                >
                                  {t('profile.theme_dark')}
                                </Dropdown.Item>
                                <Dropdown.Item 
                                  active={accountFormData.theme === 'neutral'}
                                  onClick={() => setAccountFormData({ ...accountFormData, theme: 'neutral' })}
                                >
                                  {t('profile.theme_neutral')}
                                </Dropdown.Item>
                              </Dropdown.Menu>
                            </Dropdown>
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
        )}
      </Row>

      <ForumModal
        show={showModal}
        onHide={() => setShowModal(false)}
        title={editingChar ? t('profile.edit_character') : t('profile.add_character')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSaveCharacter}>
              {editingChar ? t('common.save') : t('profile.add_character')}
            </Button>
          </>
        }
      >
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
              placeholder="Title or status"
              maxLength={30}
            />
          </Form.Group>

          <AvatarUploader
            label={<div className="fw-bold mb-2">{t('profile.character_avatar')}</div>}
            value={formData.avatar_url}
            onChange={(url) => setFormData({ ...formData, avatar_url: url })}
            storagePath={`users/${uid}/characters/avatar`}
            size={100}
          />
          
          <Form.Group className="mt-3" controlId="charSignature">
            <Form.Label className="fw-bold">{t('profile.character_signature')}</Form.Label>
            <Form.Control
              as="textarea"
              rows={3}
              value={formData.signature}
              onChange={(e) => setFormData({ ...formData, signature: e.target.value })}
              placeholder="Character biography or signature"
            />
          </Form.Group>
        </Form>
      </ForumModal>

      <ConfirmModal 
        show={confirmState.show}
        onHide={() => setConfirmState(prev => ({ ...prev, show: false }))}
        onConfirm={confirmState.onConfirm}
        title={confirmState.title}
        message={confirmState.message}
      />



      {/* Profile Reputation Modal */}
      <Modal show={showRepModal} onHide={() => setShowRepModal(false)} centered className="reputation-modal shadow-lg">
        <Modal.Header closeButton className="border-0 pb-0">
          <Modal.Title className="fw-bold text-accent">
            {lang === 'ru' ? 'Репутация пользователя' : 'User Reputation'}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body className="pt-4">
          <div className="text-center mb-4">
            <h5 className="mb-2">
              {lang === 'ru' ? 'Ваш голос для' : 'Your vote for'} <strong>{viewedProfile?.nickname}</strong>: 
              <span className={`ms-2 fs-4 fw-bold ${repValue > 0 ? 'text-success' : 'text-danger'}`}>
                {repValue > 0 ? `+${repValue}` : repValue}
              </span>
            </h5>
            <p className="text-muted small">
              {lang === 'ru' 
                ? 'Вы можете добавить комментарий к своему голосу (необязательно)' 
                : 'You can add a comment to your vote (optional)'}
            </p>
          </div>
          <Form.Group>
            <Form.Control
              as="textarea"
              rows={3}
              value={repComment}
              onChange={(e) => setRepComment(e.target.value)}
              placeholder={lang === 'ru' ? 'Напишите комментарий...' : 'Write a comment...'}
              maxLength={200}
              className="rep-textarea border-0 bg-dark opacity-75 text-white"
            />
            <div className="text-end mt-1 small text-muted">
              {repComment.length}/200
            </div>
          </Form.Group>
        </Modal.Body>
        <Modal.Footer className="border-0 pt-0">
          <Button variant="outline-secondary" onClick={() => setShowRepModal(false)} disabled={submittingRep}>
            {t('common.cancel')}
          </Button>
          <Button 
            variant={repValue > 0 ? 'success' : 'danger'} 
            onClick={handleRepVote} 
            disabled={submittingRep}
            className="px-4 fw-bold shadow-sm"
          >
            {submittingRep ? <Spinner size="sm" animation="border" className="me-2" /> : null}
            {lang === 'ru' ? 'Проголосовать' : 'Submit Vote'}
          </Button>
        </Modal.Footer>
      </Modal>



    </Container>
  );
};

export default ProfilePage;
