import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Container, Row, Col, Card, Button, Table, Modal, Form, Image, Tabs, Tab, Badge, OverlayTrigger, Tooltip, Spinner, Dropdown } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { User, Settings, LogOut, MessageSquare, TrendingUp, TrendingDown, Save, Lock, MessageCircle, Filter, MapPin, Cake, Briefcase, Heart, Share2, ClipboardList, Trash2, Bell, Volume2, Mail } from 'lucide-react';
import { playNotificationSound } from '../utils/notificationSound';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumRoleBadge from '../components/common/ForumRoleBadge';
import ForumCharacterBadge from '../components/common/ForumCharacterBadge';
import { subscribeToCharacters, addCharacter, updateCharacter, deleteCharacter } from '../api/character';
import { checkNicknameExists, fetchUserPosts } from '../api/forum';
import { subscribeToUser } from '../api/auth-resources';
import ConfirmModal from '../components/common/ConfirmModal';
import { resolveField } from '../utils/text';
import ForumModal from '../components/common/ForumModal';
import AvatarUploader from '../components/common/AvatarUploader';
import { voteOnProfile, fetchReputationLogs, getProfileVote, deleteReputation, updateReputationComment } from '../api/reputation';
import { subscribeToDesigns } from '../api/designs';
import { resolveAvatarUrl, uploadMyAvatar } from '../api/avatars';
import Timestamp from '../components/common/Timestamp';
import BBCode from '../components/common/BBCode';

import { useToast } from '../contexts/ToastProvider';
import DirectMessages from '../components/dm/DirectMessages';
import ForumPagination from '../components/common/ForumPagination';
import ForumEmptyState from '../components/common/ForumEmptyState';
import Skeleton from '../components/common/Skeleton';
import SecurityTab from '../components/profile/SecurityTab';


import { usePageTitle } from '../contexts/TitleProvider';

const ProfilePage = () => {
  const { uid } = useParams();
  const { t, lang, setLang } = useI18n();
  const { profile, hasPermission, PERMISSIONS, settings, updateProfile, recordActivity, categories, scheduleForumStateRefresh } = useAuth();
  const { showToast } = useToast();
  const { setPageTitle } = usePageTitle();

  const [characters, setCharacters] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const setActiveTab = (k) => setSearchParams({ tab: k }, { replace: true });
  const [viewedProfile, setViewedProfile] = useState(null);

  // `pending` and `banned` are ACCOUNT STATUSES, not roles (internal/auth), so
// they are read from the status column; only `spectator` is a role. Testing
// them against role_id could never match, which left a banned member with a
// full profile — the messaging button and the reputation controls included.
const isLimitedProfile = viewedProfile?.status === 'pending'
  || viewedProfile?.status === 'banned'
  || viewedProfile?.role_id === 'spectator';
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
    contacts: '',
    notif_topic_reply: true,
    notif_post_quoted: true,
    notif_reputation: true,
    notif_new_registration: true,
    email_notif_dms: true,
    email_notif_topic_replies: true,
    soundEnabled: false,
    soundVolume: 40
  });

  // Reputation Voting State
  const [showRepModal, setShowRepModal] = useState(false);
  const [repComment, setRepComment] = useState('');
  const [repValue, setRepValue] = useState(1);

  const [designs, setDesigns] = useState([]);

  useEffect(() => {
    return subscribeToDesigns(setDesigns);
  }, []);

  const [submittingRep, setSubmittingRep] = useState(false);
  const [repLogs, setRepLogs] = useState([]);
  const [totalRepLogs, setTotalRepLogs] = useState(0);
  const [currentPageRep, setCurrentPageRep] = useState(1);
  const [loadingRepLogs, setLoadingRepLogs] = useState(false);
  const REP_PER_PAGE = 20;
  const [myVote, setMyVote] = useState(null);
  const [editingLogId, setEditingLogId] = useState(null);
  const [editLogComment, setEditLogComment] = useState('');
  const [savingLogComment, setSavingLogComment] = useState(false);
  const [userPosts, setUserPosts] = useState([]);
  const [totalUserPosts, setTotalUserPosts] = useState(0);
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
  
  // Track which profile UID is currently loaded into the form to prevent overwriting local edits on background syncs (like last_seen updates)
  const lastInitUidRef = useRef(null);

  useEffect(() => {
    const unsubscribe = subscribeToCharacters(uid, setCharacters);
    const unsubProfile = subscribeToUser(uid, (data) => {
      setViewedProfile(data);
      if (data) {
        setPageTitle(data.nickname || data.email || t('profile.title', 'Профиль'));
      }
    });

    if (profile && profile.uid !== uid) {
      getProfileVote(profile.uid, uid).then(setMyVote).catch(console.error);
    } else {
      setMyVote(null);
    }

    return () => {
      unsubscribe();
      unsubProfile();
    };
  }, [uid, profile, setPageTitle, t]);

  // Tracks if we've already done the initial seek for a deep-linked log
  const didSeekRef = useRef(false);
  const lastFetchedPageRef = useRef(null);

  // Reset seek flag whenever the viewed profile changes
  useEffect(() => { 
    didSeekRef.current = false; 
    lastFetchedPageRef.current = null;
  }, [uid]);

  // Fetch reputation logs paginated
  useEffect(() => {
    if (!uid || activeTab !== 'reputation') return;

    const highlightLog = searchParams.get('log');

    // On the very first load when a deep-link ?log= is present, pass seekLogId
    // so the function resolves the correct page automatically.
    const seekLogId = (highlightLog && !didSeekRef.current) ? highlightLog : null;

    // If we have already fetched this page as part of the seek resolution, skip fetching it again.
    if (!seekLogId && lastFetchedPageRef.current === currentPageRep) {
      lastFetchedPageRef.current = null;
      return;
    }

    if (seekLogId) didSeekRef.current = true;

    let isMounted = true;
    const fetchLogs = async () => {
      setLoadingRepLogs(true);
      try {
        const result = await fetchReputationLogs(uid, seekLogId ? 1 : currentPageRep, REP_PER_PAGE, seekLogId);
        if (isMounted) {
          setRepLogs(result.logs || []);
          // fetchReputationLogs names it `total` (reputation.js returns
          // { logs, total, hidden }); reading `totalCount` here yielded
          // undefined, so the pager always drew "1 of 0" and the reputation
          // tab looked empty however many rows came back.
          setTotalRepLogs(result.total || 0);
          
          if (result.page) {
            lastFetchedPageRef.current = result.page;
            // Sync page state if the function resolved a different page
            if (result.page !== currentPageRep) {
              setCurrentPageRep(result.page);
            }
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (isMounted) setLoadingRepLogs(false);
      }
    };

    fetchLogs();
    return () => { isMounted = false; };
  }, [uid, activeTab, currentPageRep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to and highlight a specific reputation log after logs are rendered
  useEffect(() => {
    if (activeTab === 'reputation' && !loadingRepLogs && repLogs.length > 0) {
      const highlightLog = searchParams.get('log');
      if (highlightLog) {
        const timer = setTimeout(() => {
          const el = document.getElementById(`rep-log-${highlightLog}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 300);
        return () => clearTimeout(timer);
      }
    }
  }, [activeTab, loadingRepLogs, repLogs, searchParams]);

  // Fetch user posts when on 'posts' tab, page changes, or filter changes
  useEffect(() => {
    if (!uid || activeTab !== 'posts') return;
    
    let isMounted = true;
    const fetchPosts = async () => {
      setLoadingUserPosts(true);
      const result = await fetchUserPosts(uid, currentPagePosts, POSTS_PER_PAGE, postFilter);
      if (isMounted) {
        setUserPosts(result.posts);
        // fetchUserPosts names it `total` too; `totalCount` was undefined here,
        // so the posts tab paginated against NaN and rendered no rows.
        setTotalUserPosts(result.total || 0);
        setLoadingUserPosts(false);
      }
    };
    
    fetchPosts();
    return () => { isMounted = false; };
  }, [uid, activeTab, currentPagePosts, postFilter]);



  // THE SEED. One place that turns a profile into form state, because there are now
  // two callers that must agree: the sync effect below, and the re-seed after a
  // save. Duplicating this list is how the two drifted — a field added to one and
  // not the other renders as an input that quietly empties itself.
  const seedAccountForm = (source) => {
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
      contacts: source.contacts || '',
      notif_topic_reply: source.settings?.notifications?.topic_reply?.in_app !== false,
      notif_post_quoted: source.settings?.notifications?.post_quoted?.in_app !== false,
      notif_reputation:  source.settings?.notifications?.reputation_change?.in_app !== false,
      notif_new_registration: source.settings?.notifications?.new_registration?.in_app !== false,
      email_notif_dms: source.settings?.email_notifications?.dms !== false,
      email_notif_topic_replies: source.settings?.email_notifications?.topic_replies !== false,
      soundEnabled: source.settings?.sound?.enabled ?? false,
      soundVolume:  source.settings?.sound?.volume  ?? 40
    });
  };

  // Sync form data with profile (own or if admin/mod is editing)
  useEffect(() => {
    const source = (profile?.uid === uid) ? profile : (canEditAnyAccount ? viewedProfile : null);

    // Only initialize/reset the form if we are looking at a different user's profile
    // This prevents background updates to the profile (like last_seen) from wiping unsaved local edits
    if (source && source.uid !== lastInitUidRef.current) {
      seedAccountForm(source);
      lastInitUidRef.current = source.uid;
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
      scheduleForumStateRefresh();
    } catch (err) {
      console.error(err);
      showToast(lang === 'ru' ? 'Не удалось сохранить персонажа' : 'Failed to save character', 'danger');
      // If failed, we might want to re-open it, but usually a toast is enough
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
          rep_show_comments: accountFormData.rep_show_comments ?? true,
          notifications: {
            topic_reply:       { in_app: accountFormData.notif_topic_reply },
            post_quoted:       { in_app: accountFormData.notif_post_quoted },
            reputation_change: { in_app: accountFormData.notif_reputation },
            new_registration:  { in_app: accountFormData.notif_new_registration }
          },
          email_notifications: {
            dms: accountFormData.email_notif_dms,
            topic_replies: accountFormData.email_notif_topic_replies
          },
          sound: {
            enabled: accountFormData.soundEnabled,
            volume:  accountFormData.soundVolume
          }
        }
      };
      const savedProfile = await updateProfile(updates, uid);
      // Re-seed the form from what the SERVER confirmed, not from what was typed.
      //
      // Without this the inputs kept whatever was last typed, and a rejected or
      // server-normalised value stayed on screen looking saved. More importantly it
      // is the repair path for the reported "saved, re-opened, fields are old": the
      // form is a snapshot, and the snapshot has to be refreshed from the profile
      // the save just updated.
      //
      // `lastInitUidRef` is deliberately NOT cleared. Clearing it would let the next
      // background event (a last_seen write, say) re-seed the form and wipe edits
      // the reader has started since — the exact thing the guard exists to prevent.
      if (savedProfile) {
        seedAccountForm(savedProfile);
      }
      scheduleForumStateRefresh();
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

    // Prevention: Block URLs in reputation comments
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
    if (repComment && urlRegex.test(repComment)) {
      showToast(t('profile.rep_error_links'), 'danger');
      return;
    }

    setSubmittingRep(true);
    try {
      await voteOnProfile(profile.uid, uid, repValue, repComment, profile.nickname || 'User');

      // Optimistic update for profile reputation
      setViewedProfile(prev => ({
        ...prev,
        reputation: (prev?.reputation || 0) + repValue
      }));

      // Optimistic update for repLogs
      setRepLogs(prev => [
        {
          id: 'temp-' + Date.now(),
          voter_id: profile.uid,
          voter_nickname: profile.nickname || profile.displayName || 'User',
          value: repValue,
          comment: repComment,
          created_at: new Date()
        },
        ...prev
      ]);

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

  const handleUpdateLogComment = async (logId) => {
    setSavingLogComment(true);
    try {
      // The whole log row travels, not just its id: the command needs the
      // target and the current value to make this an EDIT of the existing
      // vote rather than a second one.
      const log = repLogs.find((l) => l.id === logId);
      await updateReputationComment(log, editLogComment);
      setEditingLogId(null);
      showToast(lang === 'ru' ? 'Комментарий к репутации обновлен' : 'Reputation comment updated');
    } catch (err) {
      console.error(err);
      showToast(err.message, 'danger');
    } finally {
      setSavingLogComment(false);
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
          scheduleForumStateRefresh();
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
        <Col lg={hasTabs ? 3 : 4} className="mb-4">
          <Card className="shadow-sm border-0 bg-card">
            <Card.Header className="py-3">
              <h5 className="mb-0">{t('profile.info')}</h5>
            </Card.Header>
            <Card.Body className="p-3">
              {/* ── Responsive profile layout: column on <=380px & >=992px, row on 381px..991px ── */}
              <div className="profile-sidebar-wrapper d-flex flex-row align-items-start gap-3 d-lg-block text-lg-center">

                {/* Avatar */}
                <div className="flex-shrink-0 text-center profile-sidebar-avatar">
                  {!viewedProfile ? (
                    <Skeleton variant="avatar" width={72} height={72} className="rounded-circle d-block mx-auto shadow-sm" style={{ border: '3px solid var(--border-color)' }} />
                  ) : (
                    <Image
                      src={resolveAvatarUrl(viewedProfile?.avatar_url) || `https://ui-avatars.com/api/?name=${encodeURIComponent(viewedProfile?.nickname || 'User')}&background=random`}
                      roundedCircle
                      className="border border-3 border-light shadow-sm"
                      style={{ width: '72px', height: '72px', objectFit: 'cover' }}
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        e.target.onerror = null;
                        e.target.src = 'https://ui-avatars.com/api/?name=User&background=666&color=fff';
                      }}
                    />
                  )}
                </div>

                {/* Info block */}
                <div className="flex-grow-1 min-w-0 w-100 profile-sidebar-info">
                  {/* Name & status */}
                  <div className="mb-2 mb-lg-3 text-lg-center">
                    {!viewedProfile ? (
                      <>
                        <Skeleton width="140px" height="1.5rem" className="d-block mb-1 mx-lg-auto" />
                        <Skeleton width="100px" height="0.85rem" className="d-block mx-lg-auto" />
                      </>
                    ) : (
                      <>
                        <h5 className="mb-1 text-truncate">{viewedProfile?.nickname || 'No Nickname'}</h5>
                        <p className="text-muted small mb-0" style={{ wordBreak: 'break-word' }}>
                          {viewedProfile?.status_line || ''}
                        </p>
                      </>
                    )}
                  </div>

                  {/* Send Message button */}
                  {hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES) && viewedProfile?.status !== 'banned' && uid !== profile?.uid && (
                    <div className="mb-2 text-lg-center">
                      <Button
                        as={Link}
                        to={`/messages/${uid}`}
                        variant="primary"
                        size="sm"
                        className="d-inline-flex align-items-center gap-2"
                        style={{ borderRadius: '20px', padding: '0.3rem 1rem', fontSize: '0.85rem' }}
                      >
                        <MessageCircle size={14} />
                        {lang === 'ru' ? 'Написать' : 'Message'}
                      </Button>
                    </div>
                  )}

                  {/* Stats */}
                  {!isLimitedProfile && (
                    <div className="profile-sidebar-stats d-flex justify-content-start justify-content-lg-between gap-4 gap-lg-0 align-items-center border-top pt-2 mt-1">
                      <div className="profile-stat-item text-start">
                        <span className="text-muted d-block small mb-0" style={{ fontSize: '0.72rem' }}>{t('profile.posts_count')}</span>
                        <div className="fw-bold">
                          {!viewedProfile ? <Skeleton width="30px" height="1.2rem" /> : (viewedProfile?.post_count || 0)}
                        </div>
                      </div>
                      <div className="profile-stat-item text-start text-lg-end">
                        <span className="text-muted d-block small mb-0" style={{ fontSize: '0.72rem' }}>{t('profile.reputation')}</span>
                        <div className="profile-rep-row d-flex align-items-center justify-content-start justify-content-lg-end gap-1">
                          <div className="fw-bold text-accent">
                            {!viewedProfile ? <Skeleton width="30px" height="1.2rem" /> : (viewedProfile?.reputation || 0)}
                          </div>
                          {profile && profile.status !== 'pending' && profile.uid !== uid && profile.role_id !== 'spectator' && viewedProfile?.status !== 'banned' && viewedProfile?.status !== 'pending' && (
                            <div className="d-flex gap-1 align-items-center">
                              {!myVote ? (
                                <>
                                  {settings?.reputationStyle !== 'positive_only' && (
                                    <Button size="sm" variant="outline-danger" className="py-0 px-1" style={{ fontSize: '0.8rem' }} onClick={() => { setRepValue(-1); setShowRepModal(true); }}>−</Button>
                                  )}
                                  <Button size="sm" variant="outline-success" className="py-0 px-1" style={{ fontSize: '0.8rem' }} onClick={() => { setRepValue(1); setShowRepModal(true); }}>+</Button>
                                </>
                              ) : (
                                <Badge bg={myVote.value > 0 ? 'success' : 'danger'} style={{ opacity: 0.8 }}>
                                  {myVote.value > 0 ? `+${myVote.value}` : myVote.value}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Role */}
                  <div className="mt-2 text-start text-lg-center profile-sidebar-role">
                    <span className="text-muted d-block mb-1 fw-bold text-uppercase" style={{ fontSize: '0.62rem', letterSpacing: '0.1em' }}>
                      {t('profile.account_role')}
                    </span>
                    {!viewedProfile ? (
                      <Skeleton width="80px" height="1.4rem" className="mx-lg-auto" />
                    ) : (
                      <ForumRoleBadge
                        roleId={viewedProfile?.role_id}
                        status={viewedProfile?.status}
                        userEmail={viewedProfile?.email}
                        isDeleted={viewedProfile === null}
                        className="px-3 py-1 font-uppercase"
                      />
                    )}
                  </div>
                </div>
              </div>

            </Card.Body>
          </Card>
        </Col>

        {hasTabs && (
          <Col lg={9}>
              <Tabs
                activeKey={activeTab}
                onSelect={(k) => setActiveTab(k)}
                id="profile-tabs"
                className="mb-4 premium-tabs"
              >
                {!isLimitedProfile && profile && (viewedProfile?.bio || viewedProfile?.contacts || viewedProfile?.location || viewedProfile?.birthday || viewedProfile?.occupation || viewedProfile?.interests) && (
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

                        {profile?.uid && (viewedProfile?.location || viewedProfile?.birthday || viewedProfile?.occupation || viewedProfile?.interests) && (
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
                    <div className="p-4">
                      <ForumEmptyState
                        icon={User}
                        title={
                          profile?.uid === uid
                            ? t('profile.no_characters', 'У вас пока нет масок')
                            : t('profile.no_characters_other', 'У этого пользователя нет масок')
                        }
                      />
                    </div>
                  ) : (
                    <Row className="g-3 p-3">
                      {characters.map(char => (
                        <Col key={char.id} xs={12} md={6}>
                          <Card className="h-100 border shadow-sm modal-inner-card char-card">
                            <Card.Body className="d-flex flex-column px-3 py-2 gap-2">
                              {/* Top row: avatar + name/status */}
                              <div className="d-flex align-items-center gap-3">
                                <Image
                                  src={resolveAvatarUrl(char.avatar_url) || `https://ui-avatars.com/api/?name=${encodeURIComponent(char.name)}&background=random`}
                                  roundedCircle
                                  style={{ width: '64px', height: '64px', objectFit: 'cover' }}
                                  className="border border-2 border-accent shadow-sm flex-shrink-0"
                                  onError={(e) => {
                                    e.target.onerror = null;
                                    e.target.src = 'https://ui-avatars.com/api/?name=?&background=666&color=fff';
                                  }}
                                />
                                <div className="flex-grow-1 min-w-0">
                                  <h6 className="mb-1 fw-bold text-truncate">{char.name}</h6>
                                  {char.status_line ? (
                                    <p className="text-muted small mb-0" style={{ fontStyle: 'italic', opacity: 0.8, wordBreak: 'break-word' }}>
                                      {char.status_line}
                                    </p>
                                  ) : (
                                    <p className="text-muted small mb-0 opacity-50">
                                      {lang === 'ru' ? 'Нет статуса' : 'No status'}
                                    </p>
                                  )}
                                </div>
                              </div>

                              {/* Bottom row: edit / delete buttons on opposite sides */}
                              {(() => {
                                const canEdit = (isOwn && hasPermission(PERMISSIONS.CREATE_SELF_MASK)) || hasPermission(PERMISSIONS.EDIT_OTHERS_MASK);
                                const canDelete = (isOwn && hasPermission(PERMISSIONS.DELETE_SELF_MASK)) || hasPermission(PERMISSIONS.DELETE_OTHERS_MASK);
                                if (!canEdit && !canDelete) return null;
                                return (
                                  <div className="d-flex justify-content-between align-items-center char-card-actions">
                                    <span>
                                      {canEdit && (
                                        <Button
                                          variant="link"
                                          size="sm"
                                          className="text-decoration-none p-0 text-primary small fw-bold"
                                          onClick={() => handleOpenModal(char)}
                                        >
                                          {t('profile.edit_character')}
                                        </Button>
                                      )}
                                    </span>
                                    <span>
                                      {canDelete && (
                                        <Button
                                          variant="link"
                                          size="sm"
                                          className="text-decoration-none p-0 text-danger small"
                                          onClick={() => handleDelete(char.id)}
                                        >
                                          {t('profile.delete_character')}
                                        </Button>
                                      )}
                                    </span>
                                  </div>
                                );
                              })()}
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
                  {(() => {
                    const isGuest = !profile?.uid;
                    const canOverride = hasPermission(PERMISSIONS.DELETE_REPUTATION) || hasPermission(PERMISSIONS.ADMIN_ACCESS);
                    const historyHidden = viewedProfile?.settings?.rep_show_history === false && profile?.uid !== uid && !canOverride;
                    const commentsHidden = isGuest || (viewedProfile?.settings?.rep_show_comments === false && profile?.uid !== uid && !canOverride);
                    const historyAdminBypass = !isGuest && viewedProfile?.settings?.rep_show_history === false && profile?.uid !== uid && canOverride;
                    const commentsAdminBypass = !isGuest && viewedProfile?.settings?.rep_show_comments === false && profile?.uid !== uid && canOverride;

                    const totalPagesRep = Math.ceil(totalRepLogs / REP_PER_PAGE);
                    // If history is hidden, non-admins can only see their own logs
                    const visibleRepLogs = historyHidden ? repLogs.filter(l => l.voter_id === profile?.uid) : repLogs;

                    if (historyHidden && visibleRepLogs.length === 0) return (
                      <div className="p-4">
                        <ForumEmptyState
                          icon={Lock}
                          title={t('profile.rep_history_hidden', 'История репутации скрыта')}
                        />
                      </div>
                    );

                    if (loadingRepLogs) {
                      return (
                        <div className="p-4 opacity-50">
                          {Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="mb-3">
                              <Skeleton width="60%" height="1.5rem" className="mb-2" />
                              <Skeleton width="40%" height="0.8rem" />
                            </div>
                          ))}
                        </div>
                      );
                    }

                    if (visibleRepLogs.length === 0) {
                      return (
                        <div className="p-4">
                          <ForumEmptyState
                            icon={TrendingUp}
                            title={t('profile.no_rep_logs', 'Записей о репутации нет.')}
                          />
                        </div>
                      );
                    }
                    return (
                    <div className="table-responsive rep-history-list">
                      {totalPagesRep > 1 && (
                        <div className="p-3 d-flex justify-content-center border-bottom">
                          <ForumPagination 
                            currentPage={currentPageRep}
                            totalPages={totalPagesRep}
                            onPageChange={setCurrentPageRep}
                          />
                        </div>
                      )}
                      {historyAdminBypass && (
                        <div className="px-4 py-2 small text-warning opacity-75 d-flex align-items-center gap-1">
                          <Lock size={12}/> {t('profile.rep_history_admin_note')}
                        </div>
                      )}
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
                            {hasPermission(PERMISSIONS.DELETE_REPUTATION) && <th></th>}
                          </tr>
                        </thead>
                        <tbody>
                          {visibleRepLogs.map(log => {
                            const isAllowed = log.isAllowed !== false;
                            return (
                            <tr 
                              key={log.id} 
                              id={`rep-log-${log.id}`}
                              className={searchParams.get('log') === log.id ? 'highlight-rep-row' : ''}
                            >
                              <td className="px-4 py-3 small text-muted">
                                {log.created_at ? <Timestamp date={log.created_at} /> : '...'}
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
                                    to={(log.topic_id && isAllowed) ? `/topic/${log.topic_id}${log.post_id ? `?post=${log.post_id}` : ''}` : undefined}
                                    className={log.topic_id ? 'text-decoration-none d-inline-flex align-items-center gap-1' : 'd-inline-flex align-items-center gap-1'}
                                    style={{ cursor: (log.topic_id && isAllowed) ? 'pointer' : 'default', padding: '0.4em 0.6em' }}
                                  >
                                    {log.value > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                                    <span>{log.value > 0 ? `+${log.value}` : log.value}</span>
                                  </Badge>
                                </OverlayTrigger>
                              </td>
                              <td className="py-3 rep-comment-cell">
                                {isGuest ? (
                                  <span className="text-muted small italic">{t('profile.rep_comments_guest_hidden')}</span>
                                ) : (commentsHidden && log.voter_id !== profile?.uid) ? (
                                  <span className="text-muted small italic">{t('profile.rep_comments_hidden')}</span>
                                ) : (
                                  editingLogId === log.id ? (
                                    <div className="d-flex flex-column gap-2" style={{ minWidth: '200px' }}>
                                      <Form.Control
                                        as="textarea"
                                        rows={2}
                                        value={editLogComment}
                                        onChange={(e) => setEditLogComment(e.target.value)}
                                        placeholder={lang === 'ru' ? 'Ваш комментарий...' : 'Your comment...'}
                                        size="sm"
                                        className="modal-section-themed"
                                      />
                                      <div className="d-flex justify-content-end gap-1">
                                        <Button variant="outline-secondary" size="sm" onClick={() => setEditingLogId(null)} disabled={savingLogComment}>
                                          {t('common.cancel')}
                                        </Button>
                                        <Button variant="primary" size="sm" onClick={() => handleUpdateLogComment(log.id)} disabled={savingLogComment}>
                                          {savingLogComment ? t('common.loading') : (lang === 'ru' ? 'Сохранить' : 'Save')}
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="d-flex justify-content-between align-items-center">
                                      <div className="text-break">
                                        {commentsAdminBypass && log.comment && (
                                          <Lock size={10} className="text-warning opacity-50 me-1" />
                                        )}
                                        {log.comment || '—'}
                                      </div>
                                      {profile?.uid === log.voter_id && (
                                        <div className="d-flex gap-1 ms-2 align-items-center opacity-75">
                                          <Button 
                                            variant="link" 
                                            size="sm" 
                                            className="p-0 text-decoration-none text-muted"
                                            onClick={() => {
                                              setEditLogComment(log.comment || '');
                                              setEditingLogId(log.id);
                                            }}
                                            title={lang === 'ru' ? 'Изменить комментарий' : 'Edit comment'}
                                          >
                                            <Settings size={14} />
                                          </Button>
                                          {log.comment && (
                                            <Button 
                                              variant="link" 
                                              size="sm" 
                                              className="p-0 text-decoration-none text-danger opacity-75 ms-1"
                                              onClick={async () => {
                                                if (window.confirm(lang === 'ru' ? 'Удалить комментарий?' : 'Delete comment?')) {
                                                  try {
                                                    await updateReputationComment(log, '');
                                                    showToast(lang === 'ru' ? 'Комментарий удален' : 'Comment deleted');
                                                  } catch (err) {
                                                    showToast(err.message, 'danger');
                                                  }
                                                }
                                              }}
                                              title={lang === 'ru' ? 'Удалить комментарий' : 'Delete comment'}
                                            >
                                              <Trash2 size={14} />
                                            </Button>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )
                                )}
                              </td>
                              {hasPermission(PERMISSIONS.DELETE_REPUTATION) && (
                                <td className="py-3 text-end pe-3">
                                  <Button
                                    size="sm"
                                    variant="link"
                                    className="text-danger p-0 opacity-50"
                                    style={{ lineHeight: 1 }}
                                    title={t('profile.rep_delete')}
                                    onClick={() => {
                                      setConfirmState({
                                        show: true,
                                        title: t('profile.rep_delete'),
                                        message: t('profile.rep_delete_confirm'),
                                        onConfirm: async () => {
                                          try {
                                            const valueToDelete = log.value;
                                            const postIdToDeleteFrom = log.post_id;
                                            await deleteReputation(log.id, profile.uid);
                                            
                                            // Optimistic update for logs and total reputation
                                            setRepLogs(prev => prev.filter(l => l.id !== log.id));
                                            setViewedProfile(prev => ({
                                              ...prev,
                                              reputation: (prev?.reputation || 0) - valueToDelete
                                            }));

                                            // Optimistic update for posts in the posts tab
                                            if (postIdToDeleteFrom) {
                                              setUserPosts(prev => prev.map(p => 
                                                p.id === postIdToDeleteFrom 
                                                  ? { ...p, reputation: (p.reputation || 0) - valueToDelete } 
                                                  : p
                                              ));
                                            }

                                            showToast(lang === 'ru' ? 'Запись удалена' : 'Entry deleted');
                                          } catch (err) {
                                            console.error(err);
                                            showToast(err.message, 'danger');
                                          }
                                        }
                                      });
                                    }}
                                  >
                                    <Trash2 size={14} />
                                  </Button>
                                </td>
                              )}
                            </tr>
                            );
                          })}
                        </tbody>
                      </Table>
                      {totalPagesRep > 1 && (
                        <div className="p-3 d-flex justify-content-center border-top">
                          <ForumPagination 
                            currentPage={currentPageRep}
                            totalPages={totalPagesRep}
                            onPageChange={setCurrentPageRep}
                          />
                        </div>
                      )}
                    </div>
                    );
                  })()}
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
                      const totalPagesPosts = Math.ceil(totalUserPosts / POSTS_PER_PAGE);

                      if (userPosts.length === 0 && !loadingUserPosts) {
                        // The message has to follow the FILTER. With a mask
                        // selected, "This user hasn't posted anything yet" is
                        // false and actively confusing — they have posts, just not
                        // ones written as this character, and the reader is left
                        // looking for a bug that isn't there.
                        return (
                          <div className="p-4">
                            <ForumEmptyState
                              icon={MessageSquare}
                              title={postFilter === 'all'
                                ? t('profile.no_posts_user', 'Этот пользователь еще ничего не опубликовал.')
                                : t('profile.no_posts_filtered', 'Нет сообщений по этому фильтру.')}
                            />
                          </div>
                        );
                      }

                      const pagedPosts = userPosts;

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
                          {loadingUserPosts ? (
                            Array.from({ length: 3 }).map((_, i) => (
                              <div key={i} className="p-4 border-bottom opacity-50">
                                <Skeleton width="60%" height="1.5rem" className="mb-2" />
                                <Skeleton width="40%" height="0.8rem" className="mb-3" />
                                <Skeleton count={2} height="0.8rem" />
                              </div>
                            ))
                          ) : (
                            pagedPosts.map((post, idx) => {
                              const category = categories.find(c => c.id === post.category_id);
                              
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
                                        {post.topic_title || '...'}
                                      </Link>
                                      <div className="d-flex align-items-center gap-2 mt-1">
                                        {category && (
                                          <Badge bg="secondary" className="opacity-75 fw-normal" style={{ fontSize: '0.7rem' }}>
                                            {resolveField(category.name || category.title, lang)}
                                          </Badge>
                                        )}
                                        <span className="text-muted small">
                                          {post.created_at ? <Timestamp date={post.created_at} /> : '...'}
                                        </span>
                                      </div>
                                    </div>
                                    {/* THE MASK BADGE.
                                        It carried only `badge-character`, so the
                                        theme rules — which are all scoped to
                                        `.role-badge.badge-character` — never matched
                                        it and the row rendered the stock Bootstrap
                                        blue, against every theme. Adding the
                                        `role-badge` class is what puts it back in the
                                        themed system: the same violet/amber ghost
                                        styling a mask gets in a topic.

                                        `size="sm"` keeps it from outweighing the
                                        topic headline it sits beside, and the tooltip
                                        carries the account nickname the server now
                                        attaches, so the same "who is really behind
                                        this mask" answer works here too.

                                        `characterName` is what makes the badge name
                                        the character rather than read "Char." for
                                        every row: the server already swaps
                                        `author_name` to the character's own name on
                                        a masked post (applyMask), and this list has
                                        no author header to show it, so the badge was
                                        the only place it could appear. Two rows
                                        written as two different characters were
                                        otherwise indistinguishable. */}
                                    {post.is_character && (
                                      <ForumCharacterBadge
                                        characterName={post.author_name}
                                        ownerName={post.owner_name}
                                        size="sm"
                                        className="ms-2"
                                      />
                                    )}
                                  </div>
                                  <div className="post-preview text-muted small text-break line-clamp-4">
                                    <BBCode rolls={post.rolls} authorId={post.author_id}>{post.content}</BBCode>
                                  </div>
                                </div>
                              );
                            })
                          )}
                          
                          {!loadingUserPosts && totalPagesPosts > 1 && (
                            <div className="p-3 d-flex justify-content-center border-top">
                              <ForumPagination 
                                currentPage={currentPagePosts}
                                totalPages={totalPagesPosts}
                                onPageChange={setCurrentPagePosts}
                              />
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
                            onUpload={uploadMyAvatar}
                            allowGifs={settings?.allowGifAvatars !== false}
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
                      <h6 className="mb-1 text-primary uppercase small fw-bold d-flex align-items-center gap-2">
                        <ClipboardList size={18} /> {lang === 'ru' ? 'Дополнительная информация' : 'Additional Information'}
                      </h6>
                      <p className="small text-muted mb-3">
                        {lang === 'ru' ? 'Эта информация будет видна в профиле только зарегистрированным пользователям.' : 'This information will be visible on your profile only to registered users.'}
                      </p>
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
                                 accountFormData.theme === 'neutral' ? t('profile.theme_neutral') :
                                 designs.find(d => d.id === accountFormData.theme)?.name || accountFormData.theme || t('profile.theme_dark')}
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
                                {settings?.allowUserCustomDesign && designs.filter(d => d.isActive && d.showInList).length > 0 && (
                                  <>
                                    <Dropdown.Divider />
                                    <Dropdown.Header className="small text-muted text-uppercase fw-bold opacity-75">
                                      {lang === 'ru' ? 'Кастомные дизайны' : 'Custom Designs'}
                                    </Dropdown.Header>
                                    {designs.filter(d => d.isActive && d.showInList).map(d => (
                                      <Dropdown.Item
                                        key={d.id}
                                        active={accountFormData.theme === d.id}
                                        onClick={() => setAccountFormData({ ...accountFormData, theme: d.id })}
                                      >
                                        {d.name}
                                      </Dropdown.Item>
                                    ))}
                                  </>
                                )}
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

                      {/* ── Notification Settings ───────────────────────── */}
                      <hr className="my-4" />
                      <h6 className="mb-1 text-primary small fw-bold d-flex align-items-center gap-2">
                        <Bell size={15} /> {t('profile.notifications_section')}
                      </h6>
                      <p className="small text-muted mb-3" style={{ maxWidth: '480px' }}>
                        {lang === 'ru'
                          ? 'Выберите, какие события будут отображаться на странице уведомлений.'
                          : 'Choose which events appear on your Notifications page.'}
                      </p>
                      <Form.Check
                        type="switch"
                        id="notif-topic-reply-switch"
                        label={t('profile.notif_topic_reply')}
                        className="mb-2"
                        checked={accountFormData.notif_topic_reply}
                        onChange={(e) => setAccountFormData({ ...accountFormData, notif_topic_reply: e.target.checked })}
                      />
                      <Form.Check
                        type="switch"
                        id="notif-post-quoted-switch"
                        label={t('profile.notif_post_quoted')}
                        className="mb-2"
                        checked={accountFormData.notif_post_quoted}
                        onChange={(e) => setAccountFormData({ ...accountFormData, notif_post_quoted: e.target.checked })}
                      />
                      <Form.Check
                        type="switch"
                        id="notif-reputation-switch"
                        label={t('profile.notif_reputation')}
                        className="mb-2"
                        checked={accountFormData.notif_reputation}
                        onChange={(e) => setAccountFormData({ ...accountFormData, notif_reputation: e.target.checked })}
                      />
                      {(hasPermission(PERMISSIONS.APPROVE_USERS) || hasPermission(PERMISSIONS.BAN_USERS) || hasPermission(PERMISSIONS.DELETE_USERS)) && (
                        <Form.Check
                          type="switch"
                          id="notif-new-registration-switch"
                          label={t('profile.notif_new_registration')}
                          className="mb-2"
                          checked={accountFormData.notif_new_registration}
                          onChange={(e) => setAccountFormData({ ...accountFormData, notif_new_registration: e.target.checked })}
                        />
                      )}

                      {/* ── Email Notifications (Brevo) ────────────────── */}
                      <hr className="my-4" />
                      <h6 className="mb-1 text-primary small fw-bold d-flex align-items-center gap-2">
                        <Mail size={15} /> {lang === 'ru' ? 'Email-уведомления (когда вы не на форуме)' : 'Email Notifications (when offline)'}
                      </h6>
                      <p className="small text-muted mb-3" style={{ maxWidth: '520px' }}>
                        {lang === 'ru'
                          ? 'Уведомления на ваш email отправляются только если вы не проявляли активности последние 15 минут.'
                          : 'Transactional emails are only sent if you have been offline for at least 15 minutes.'}
                      </p>
                      <Form.Check
                        type="switch"
                        id="email-notif-dms-switch"
                        label={lang === 'ru' ? 'Личные сообщения (ЛС)' : 'Direct Messages'}
                        className="mb-2"
                        checked={accountFormData.email_notif_dms}
                        onChange={(e) => setAccountFormData({ ...accountFormData, email_notif_dms: e.target.checked })}
                      />
                      <Form.Check
                        type="switch"
                        id="email-notif-replies-switch"
                        label={lang === 'ru' ? 'Новые ответы в отслеживаемых темах' : 'New replies in subscribed topics'}
                        className="mb-2"
                        checked={accountFormData.email_notif_topic_replies}
                        onChange={(e) => setAccountFormData({ ...accountFormData, email_notif_topic_replies: e.target.checked })}
                      />

                      {/* ── Sound Settings ──────────────────────────────── */}
                      <hr className="my-4" />
                      <h6 className="mb-1 text-primary small fw-bold d-flex align-items-center gap-2">
                        <Volume2 size={15} /> {t('profile.sound_section')}
                      </h6>
                      <Form.Check
                        type="switch"
                        id="sound-enabled-switch"
                        label={t('profile.sound_enabled')}
                        className="mb-3"
                        checked={accountFormData.soundEnabled}
                        onChange={(e) => setAccountFormData({ ...accountFormData, soundEnabled: e.target.checked })}
                      />
                      {accountFormData.soundEnabled && (
                        <div className="mb-3" style={{ maxWidth: '360px' }}>
                          <div className="d-flex align-items-center justify-content-between mb-1">
                            <Form.Label className="small fw-bold mb-0">{t('profile.sound_volume')}</Form.Label>
                            <span className="small text-muted">{accountFormData.soundVolume}%</span>
                          </div>
                          <Form.Range
                            min={1}
                            max={100}
                            step={1}
                            value={accountFormData.soundVolume}
                            onChange={(e) => setAccountFormData({ ...accountFormData, soundVolume: Number(e.target.value) })}
                          />
                          <div className="d-flex justify-content-between" style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                            <span>1%</span><span>100%</span>
                          </div>
                        </div>
                      )}
                      <Button
                        variant="outline-secondary"
                        size="sm"
                        className="d-flex align-items-center gap-2 mb-4"
                        onClick={() => playNotificationSound(accountFormData.soundEnabled ? accountFormData.soundVolume : 40)}
                      >
                        <Volume2 size={14} /> {t('profile.sound_test')}
                      </Button>

                      <Button variant="primary" onClick={handleSaveAccount} className="px-4">
                        {t('common.save')}
                      </Button>
                    </Form>
                  </Card.Body>
                </Card>
              </Tab>
              )}

              {profile?.uid === uid && !isLimitedProfile && (
                <Tab eventKey="security" title={t('profile.tab_security')}>
                  <SecurityTab />
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
              placeholder={t('profile.character_status_placeholder')}
              maxLength={30}
            />
          </Form.Group>

          <AvatarUploader
            label={<div className="fw-bold mb-2">{t('profile.character_avatar')}</div>}
            value={formData.avatar_url}
            allowGifs={settings?.allowGifAvatars !== false}
            onChange={(url) => setFormData({ ...formData, avatar_url: url })}
            // No onUpload: a character avatar has nowhere to be stored yet.
            // The `characters` collection is server-only (all browser rules
            // are nil) and has no command layer, so there is no endpoint to
            // send bytes to — the control stays visible but refuses clearly
            // instead of producing a data URL that could never be saved.
            canUpload={false}
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
              placeholder={t('profile.character_signature_placeholder')}
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
            />
            <div className="d-flex justify-content-between mt-1 small text-muted">
              <span><i className="bi bi-info-circle me-1"></i>{t('profile.rep_no_links_hint')}</span>
              <span>{repComment.length}/200</span>
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
