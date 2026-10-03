import React, { useEffect, useState } from 'react';
import { Container, Card, Badge, Button, Row, Col } from 'react-bootstrap';
import { Bell, BellOff, CheckCheck, UserCheck, Clock, Trash2, X, MessageSquare, TrendingUp, TrendingDown, Quote, AtSign, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';
import { usePageTitle } from '../contexts/TitleProvider';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import {
  subscribeToAdminNotifications,
  subscribeToUserNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  markAllAdminNotificationsRead,
  deleteNotification,
  deleteAllAdminNotifications,
  deleteAllUserNotifications
} from '../api/notifications';
import { Link } from 'react-router-dom';
import ForumPagination from '../components/common/ForumPagination';
import ForumEmptyState from '../components/common/ForumEmptyState';
import Timestamp from '../components/common/Timestamp';
import { useToast } from '../contexts/ToastProvider';

const TYPE_META = {
  new_registration: {
    icon: <UserCheck size={18} />,
    labelEn: 'New registration',
    labelRu: 'Новая регистрация',
    labelKey: 'notifications.types.new_registration',
    color: 'primary'
  },
  topic_reply: {
    icon: <MessageSquare size={18} />,
    labelKey: 'notifications.types.topic_reply',
    color: 'info'
  },
  post_quoted: {
    icon: <Quote size={18} />,
    labelKey: 'notifications.types.post_quoted',
    color: 'secondary'
  },
  reputation_change: {
    // Dynamic icon, set in render
    labelKey: 'notifications.types.reputation_change',
    color: 'success'
  },
  post_mentioned: {
    icon: <AtSign size={18} />,
    labelKey: 'notifications.types.post_mentioned',
    color: 'secondary'
  },
  dm: {
    icon: <Mail size={18} />,
    labelKey: 'notifications.types.dm',
    color: 'dark'
  },
  POST_MENTIONED: {
    icon: <AtSign size={18} />,
    labelKey: 'notifications.types.post_mentioned',
    color: 'secondary'
  }
};

const NotificationsPage = () => {
  const { profile, recordActivity, hasPermission, PERMISSIONS, isRootAdmin } = useAuth();
  const { t, lang } = useI18n();
  const { showToast } = useToast();
  const [deletingId, setDeletingId] = useState(null);

  const [adminActive, setAdminActive] = useState([]);
  const [userActive, setUserActive] = useState([]);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;

  // Only users who can actually act on registrations should see these notifications
  const canManageUsers = hasPermission(PERMISSIONS.APPROVE_USERS)
    || hasPermission(PERMISSIONS.BAN_USERS)
    || hasPermission(PERMISSIONS.DELETE_USERS);

  const { setPageTitle } = usePageTitle();

  useEffect(() => {
    setPageTitle(t('notifications.title', 'Уведомления'));
  }, [setPageTitle, t, lang]);

  useEffect(() => {
    if (!profile?.uid) return;
    
    let unsubAdminActive = () => {};
    let unsubUserActive = () => {};

    // Personal Notifications (limit 100 newest)
    unsubUserActive = subscribeToUserNotifications(profile.uid, (notifs) => {
      setUserActive(notifs);
    });

    // Admin broadcast notifications (backward-compat: legacy recipient_uid=null docs)
    if ((profile?.role_id === 'admin' || profile?.role_id === 'root') && canManageUsers) {
      unsubAdminActive = subscribeToAdminNotifications(setAdminActive);
    }

    return () => {
      unsubUserActive();
      unsubAdminActive();
    };
  }, [canManageUsers, profile?.uid]);

  // Client-side filter: respect user's in_app notification preferences
  const notifSettings = profile?.settings?.notifications;
  const filterByPrefs = (n) => {
    const isMention = n.type === 'POST_MENTIONED' || n.type === 'post_mentioned';
    if (n.type === 'topic_reply'       && notifSettings?.topic_reply?.in_app       === false) return false;
    if (n.type === 'post_quoted'       && notifSettings?.post_quoted?.in_app       === false) return false;
    if (isMention                      && notifSettings?.post_quoted?.in_app       === false) return false; // Reuse post_quoted setting for mentions
    if (n.type === 'reputation_change' && notifSettings?.reputation_change?.in_app === false) return false;
    if (n.type === 'new_registration'  && notifSettings?.new_registration?.in_app  === false) return false;
    return true;
  };

  const getNotifTs = (item) => {
    if (!item?.created_at) return 0;
    if (typeof item.created_at === 'number') return item.created_at;
    if (typeof item.created_at?.toMillis === 'function') return item.created_at.toMillis();
    return 0;
  };

  const activeNotifs = [...adminActive, ...userActive]
    .filter(filterByPrefs)
    .sort((a, b) => getNotifTs(b) - getNotifTs(a));

  const handleMarkRead = (e, id) => {
    if (e) e.stopPropagation();
    recordActivity();
    const isAdminNotif = adminActive.some(n => n.id === id);

    // Update the list the admin is looking at first. The subscription polls on a
    // 15s timer, so without this the row stays bold until the next tick — the
    // click looks like it did nothing. The server response still decides the
    // truth: on failure we reload, which puts the row back to unread.
    setUserActive(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
    setAdminActive(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));

    markNotificationRead(id, profile?.uid, isAdminNotif)
      .catch(err => {
        console.error('[markNotificationRead]', err);
        showToast(err.message, 'danger');
        setUserActive(prev => prev.map(n => (n.id === id ? { ...n, read: false } : n)));
        setAdminActive(prev => prev.map(n => (n.id === id ? { ...n, read: false } : n)));
      });
  };

  const handleDelete = (e, id) => {
    if (e) e.stopPropagation();
    recordActivity();
    
    // Trigger animation first
    setDeletingId(id);
    const isAdminNotif = adminActive.some(n => n.id === id);
    
    // Wait for animation to finish before calling API
    setTimeout(() => {
      deleteNotification(id, profile?.uid, isAdminNotif)
        .then(() => {
          // Drop the row locally as well. The list reloads on the 15s poll, so
          // without this an archived notification keeps occupying its slot —
          // and `archived:true` rows are filtered out of the next fetch, so it
          // would disappear on its own seconds later, looking like a glitch.
          setUserActive(prev => prev.filter(n => n.id !== id));
          setAdminActive(prev => prev.filter(n => n.id !== id));
          showToast(t('notifications.deleted_toast', 'Уведомление удалено'));
          setDeletingId(null);
        })
        .catch(err => {
          console.error('[deleteNotification]', err);
          showToast(err.message, 'danger');
          setDeletingId(null);
        });
    }, 300);
  };

  const handleMarkAllRead = async () => {
    recordActivity();

    // Optimistic: clear the unread marks immediately, then let the server's
    // answer stand. If a request fails the toast says so AND the marks come
    // back, because the marks are not a lie we are allowed to keep.
    setUserActive(prev => prev.map(n => ({ ...n, read: true })));
    setAdminActive(prev => prev.map(n => ({ ...n, read: true })));

    try {
      if (profile?.uid && userActive.length > 0) {
        await markAllNotificationsRead(profile.uid, userActive);
      }
      if (canManageUsers && adminActive.length > 0) {
        await markAllAdminNotificationsRead(adminActive);
      }
      showToast(t('notifications.all_read_toast', 'Все уведомления прочитаны'));
    } catch (err) {
      console.error('[handleMarkAllRead]', err);
      showToast(err.message, 'danger');
      // Roll the marks back so the page matches the server.
      setUserActive(prev => prev.map(n => ({ ...n, read: false })));
      setAdminActive(prev => prev.map(n => ({ ...n, read: false })));
    }
  };

  const handleDeleteAll = async () => {
    recordActivity();
    try {
      if (canManageUsers) {
        await deleteAllAdminNotifications();
      }
      if (profile?.uid) {
        await deleteAllUserNotifications(profile.uid);
      }
      // Clear locally too. Archived rows are filtered out of the next poll, so
      // leaving them rendered until then shows the list contradicting itself.
      setUserActive([]);
      setAdminActive([]);
      showToast(t('notifications.all_deleted_toast', 'Все уведомления очищены'));
    } catch (err) {
      console.error('[deleteAllNotifications]', err);
      showToast(err.message, 'danger');
    }
  };

  const unreadCount = activeNotifs.filter(n => !n.read).length;
  const currentSet = activeNotifs;

  // Pagination logic
  const totalPages = Math.ceil(currentSet.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentItems = currentSet.slice(startIndex, startIndex + itemsPerPage);

  const handlePageChange = (page) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderNotification = (n, idx) => {
    const meta = TYPE_META[n.type];
    const { payload } = n;
    const isDeleting = deletingId === n.id;
    // Reverse numbering: newest (top) gets the highest number
    const globalIndex = currentSet.length - ((currentPage - 1) * itemsPerPage + idx);

    return (
      <Card
        key={n.id}
        className={`mb-3 notification-card border-1 ${!n.read ? 'unread-notif' : 'read-notif'} shadow-sm ${isDeleting ? 'archiving-exit' : ''}`}
      >
        <Card.Body className="py-3 px-4 position-relative">
          <Row className="align-items-start g-3">
            <Col xs="auto" className="pt-1 flex-shrink-0">
              <div 
                className="d-flex align-items-center justify-content-center text-primary rounded-circle icon-box-small"
                style={{ width: '40px', height: '40px' }}
              >
                {n.type === 'reputation_change' ? (
                  payload?.value > 0 ? <TrendingUp size={18} className="text-success" /> : <TrendingDown size={18} className="text-danger" />
                ) : (
                  meta?.icon ?? <Bell size={18} />
                )}
              </div>
            </Col>
            <Col>
              <div className="d-flex align-items-center flex-wrap justify-content-between gap-2 mb-2 line-height-1">
                <div className="d-flex align-items-center flex-wrap gap-2">
                  <span className="fw-bold small text-uppercase text-muted" style={{ letterSpacing: '1px', fontSize: '0.65rem' }}>
                    {n.type === 'topic_reply' ? (
                      (() => {
                        const fullText = t('notifications.types.topic_reply', { count: payload.post_count, topic: '|||TOPIC|||' });
                        const parts = fullText.split('|||TOPIC|||');
                        return (
                          <>
                            {parts[0]}
                            <Link 
                              to={`/topic/${payload.topic_id}?post=${payload.last_post_id}`}
                              className="text-primary text-decoration-none hover-underline"
                              style={{ textTransform: 'none', letterSpacing: 'normal', fontSize: '0.75rem' }}
                              onClick={() => !n.read && handleMarkRead(null, n.id)}
                            >
                              {payload.topic_title}
                            </Link>
                            {parts[1]}
                          </>
                        );
                      })()
                    ) : (n.type === 'post_quoted' || n.type === 'post_mentioned' || n.type === 'POST_MENTIONED') ? (
                      (() => {
                        const typeKey = n.type === 'post_quoted' ? 'post_quoted' : 'post_mentioned';
                        const fullText = t(`notifications.types.${typeKey}`, { topic: '|||TOPIC|||' });
                        const parts = fullText.split('|||TOPIC|||');
                        return (
                          <>
                            {parts[0]}
                            <Link 
                              to={`/topic/${payload.topic_id}?post=${payload.post_id}`}
                              className="text-primary text-decoration-none hover-underline"
                              style={{ textTransform: 'none', letterSpacing: 'normal', fontSize: '0.75rem' }}
                              onClick={() => !n.read && handleMarkRead(null, n.id)}
                            >
                              {payload.topic_title}
                            </Link>
                            {parts[1]}
                          </>
                        );
                      })()
                    ) : n.type === 'reputation_change' && payload?.topic_title ? (
                      (() => {
                        const typeLabel = meta?.labelKey ? t(meta.labelKey) : n.type;
                        return (
                          <>
                            {typeLabel} {lang === 'ru' ? 'в теме ' : 'in topic '}
                            <Link 
                              to={`/topic/${payload.topic_id}?post=${payload.post_id || ''}`}
                              className="text-decoration-none hover-underline"
                              style={{ color: 'var(--content-link-color)', textTransform: 'none', letterSpacing: 'normal', fontSize: '0.75rem' }}
                              onClick={() => !n.read && handleMarkRead(null, n.id)}
                            >
                              {payload.topic_title}
                            </Link>
                          </>
                        );
                      })()
                    ) : n.type === 'dm' ? (
                      (() => {
                        // Deep link to the conversation with the sender. The DM
                        // routes address a USER, not a conversation, so the
                        // sender_uid in the payload is what makes this a real jump
                        // rather than a link that lands on the message list.
                        //
                        // Comments in this position must live INSIDE the IIFE: a
                        // bare // placed directly in JSX children is not a comment
                        // at all, it becomes literal text in the rendered row.
                        //
                        // The phrase comes from the dictionary, not a hardcoded
                        // ternary, so a third locale needs no change here.
                        const typeLabel = meta?.labelKey
                          ? t(meta.labelKey, 'Direct message')
                          : (lang === 'ru' ? 'Личное сообщение' : 'Direct message');
                        const preview = (payload?.preview || '').trim();
                        return (
                          <>
                            {typeLabel}{' '}
                            {payload?.sender_uid ? (
                              <Link
                                to={`/messages/${payload.sender_uid}`}
                                className="text-decoration-none hover-underline"
                                style={{ color: 'var(--content-link-color)', textTransform: 'none', letterSpacing: 'normal', fontSize: '0.75rem' }}
                                onClick={() => !n.read && handleMarkRead(null, n.id)}
                              >
                                {payload?.sender_nickname || payload.sender_uid}
                              </Link>
                            ) : (
                              <span>{payload?.sender_nickname || typeLabel}</span>
                            )}
                            {preview && (
                              <span className="text-muted" style={{ marginLeft: '0.35rem' }}>
                                «{preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}»
                              </span>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      (meta?.labelKey ? t(meta.labelKey) : n.type)
                    )}
                  </span>
                  {!n.read && (
                    <Badge 
                      pill 
                      className="text-uppercase px-2 badge-new"
                    >
                      {t('notifications.new_badge')}
                    </Badge>
                  )}
                </div>

                <div className="d-flex align-items-center gap-2 gap-md-3 mt-1 mt-md-0 ms-auto flex-shrink-0">
                  <span className="text-muted small d-flex align-items-center gap-1" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    <Clock size={12} />
                    <Timestamp date={n.created_at} />
                  </span>
                  
                  <Button 
                    variant="link" 
                    className="p-0 text-muted archive-btn d-flex align-items-center"
                    onClick={(e) => handleDelete(e, n.id)}
                    title={t('notifications.delete', 'Удалить')}
                  >
                    <X size={18} />
                  </Button>
                </div>
              </div>

              {n.type === 'new_registration' && payload && (
                <div className="ps-0 ps-md-1">
                  <div className="mb-2 d-flex align-items-baseline gap-2">
                    <span className="fw-bold fs-5">{payload.nickname}</span>
                    {isRootAdmin && payload.email && (
                      <span className="text-muted small">{payload.email}</span>
                    )}
                  </div>
                  {payload.admin_message && (
                    <div
                      className="mt-2 p-3 rounded-3 small message-preview-box"
                      style={{ 
                        whiteSpace: 'pre-wrap', 
                        wordBreak: 'break-word',
                        lineHeight: '1.5'
                      }}
                    >
                      {payload.admin_message}
                    </div>
                  )}
                  <div className="mt-3 d-flex align-items-center">
                    <Link 
                      to="/admin?tab=users" 
                      className="text-decoration-none small fw-bold text-primary"
                      onClick={() => !n.read && handleMarkRead(null, n.id)}
                    >
                      {t('notifications.manage_users')}
                    </Link>

                    {!n.read && (
                      <Button 
                        variant="link" 
                        size="sm" 
                        className="p-0 ms-auto text-decoration-none small fw-bold text-muted transition-all d-flex align-items-center"
                        onClick={(e) => handleMarkRead(e, n.id)}
                      >
                        <CheckCheck size={14} className="me-1" />
                        {t('notifications.mark_as_read')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {n.type === 'topic_reply' && payload && (
                <div className="ps-0 ps-md-1">
                  <div className="mt-3 d-flex align-items-center">
                    <Link 
                      to={`/topic/${payload.topic_id}?post=${payload.first_post_id}`} 
                      className="text-decoration-none small fw-bold text-primary"
                      onClick={() => !n.read && handleMarkRead(null, n.id)}
                    >
                      {lang === 'ru' ? 'Перейти к сообщению →' : 'Go to message →'}
                    </Link>

                    {!n.read && (
                      <Button 
                        variant="link" 
                        size="sm" 
                        className="p-0 ms-auto text-decoration-none small fw-bold text-muted transition-all d-flex align-items-center"
                        onClick={(e) => handleMarkRead(e, n.id)}
                      >
                        <CheckCheck size={14} className="me-1" />
                        {t('notifications.mark_as_read')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {(n.type === 'post_quoted' || n.type === 'post_mentioned' || n.type === 'POST_MENTIONED') && payload && (
                <div className="ps-0 ps-md-1">
                  <div className="mt-3 d-flex align-items-center">
                    <Link 
                      to={`/topic/${payload.topic_id}?post=${payload.post_id}`} 
                      className="text-decoration-none small fw-bold text-primary"
                      onClick={() => !n.read && handleMarkRead(null, n.id)}
                    >
                      {lang === 'ru' ? 'Перейти к сообщению →' : 'Go to message →'}
                    </Link>

                    {!n.read && (
                      <Button 
                        variant="link" 
                        size="sm" 
                        className="p-0 ms-auto text-decoration-none small fw-bold text-muted transition-all d-flex align-items-center"
                        onClick={(e) => handleMarkRead(e, n.id)}
                      >
                        <CheckCheck size={14} className="me-1" />
                        {t('notifications.mark_as_read')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {n.type === 'reputation_change' && payload && (
                <div className="ps-0 ps-md-1">
                  <div className="mt-2 text-muted small">
                    {t(payload.value > 0 ? 'notifications.reputation_increased' : 'notifications.reputation_decreased', { user: payload.voter_nickname }).replace('{user}', payload.voter_nickname)}
                  </div>
                  {payload.comment && (
                    <div
                      className="mt-2 p-3 rounded-3 small message-preview-box"
                      style={{ 
                        whiteSpace: 'pre-wrap', 
                        wordBreak: 'break-word',
                        lineHeight: '1.5'
                      }}
                    >
                      {payload.comment}
                    </div>
                  )}
                  <div className="mt-3 d-flex align-items-center">
                    {payload.post_id ? (
                      <Link 
                        to={`/topic/${payload.topic_id}?post=${payload.post_id}`} 
                        className="text-decoration-none small fw-bold text-primary"
                        onClick={() => !n.read && handleMarkRead(null, n.id)}
                      >
                        {payload.topic_title ? `${t('notifications.view_post')} → ${payload.topic_title}` : t('notifications.view_post')}
                      </Link>
                    ) : (
                      <Link 
                        to={`/profile/${profile?.uid}`} 
                        className="text-decoration-none small fw-bold text-primary"
                        onClick={() => !n.read && handleMarkRead(null, n.id)}
                      >
                        {t('notifications.view_profile')}
                      </Link>
                    )}

                    {!n.read && (
                      <Button 
                        variant="link" 
                        size="sm" 
                        className="p-0 ms-auto text-decoration-none small fw-bold text-muted transition-all d-flex align-items-center"
                        onClick={(e) => handleMarkRead(e, n.id)}
                      >
                        <CheckCheck size={14} className="me-1" />
                        {t('notifications.mark_as_read')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </Col>
          </Row>

          {/* Global index in the absolute bottom-left corner of the card body */}
          <div 
            className="position-absolute fw-bold" 
            style={{ fontSize: '0.8rem', bottom: '5px', left: '7px', color: '#6c757d' }}
          >
            #{globalIndex}
          </div>
        </Card.Body>
      </Card>
    );
  };

  return (
    <Container className="py-5" style={{ maxWidth: '800px' }}>
      <ForumBreadcrumbs 
        items={[{ label: t('notifications.title'), active: true }]} 
      />
      <style>
        {`
          .notification-card {
            background-color: var(--card-bg) !important;
            border: 1px solid var(--border-color) !important;
            transition: all 0.3s ease;
            max-height: 500px;
            overflow: hidden;
            border-left: 4px solid transparent !important;
          }
          .notification-card.unread-notif {
            border-left: 2px solid var(--primary-color) !important;
            border-top-left-radius: 4px !important;
            border-bottom-left-radius: 4px !important;
            background-color: var(--card-bg) !important;
          }
          .notification-card.read-notif {
            opacity: 1;
            border-left: 2px solid transparent !important;
          }
          .notification-card.read-notif .card-body {
            color: var(--secondary-color);
          }
          .notification-card:hover {
            border-color: rgba(var(--primary-rgb), 0.3) !important;
            transform: translateY(-1px);
          }
          .archive-btn:hover {
            color: var(--bs-danger) !important;
          }
          .archiving-exit {
            transform: translateX(30px);
            opacity: 0;
            max-height: 0;
            margin-bottom: 0 !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
            pointer-events: none;
          }
          .badge-new {
            font-size: 0.6rem;
            background-color: var(--badge-bg, var(--primary-color)) !important;
            color: var(--badge-text, #ffffff) !important;
            border: 1px solid var(--badge-bg, var(--primary-color)) !important;
            opacity: 1;
          }

          .icon-box {
            background-color: #f1f5f9 !important;
            border: 1px solid var(--border-color) !important;
            padding: 12px;
            border-radius: 12px;
            color: #0f172a;
            opacity: 1;
            transition: transform 0.2s ease;
          }
          [data-theme='dark'] .icon-box {
            background-color: #2d3d5a !important;
            color: #f8fafc;
          }
          [data-theme='neutral'] .icon-box {
            background-color: #e0dbca !important;
            color: #433422;
            border-color: rgba(67, 52, 34, 0.2) !important;
          }
          .icon-box-small {
            background-color: #f8f9fa !important;
            border: 1px solid var(--border-color) !important;
          }
          [data-theme='dark'] .icon-box-small {
            background-color: #2d3d5a !important;
          }
          [data-theme='neutral'] .icon-box-small {
            background-color: #e0dbca !important;
            border-color: rgba(67, 52, 34, 0.15) !important;
          }
          .message-preview-box {
            background-color: #f8f9fa !important;
            border: 1px solid var(--border-color) !important;
            color: var(--text-color) !important;
          }
          [data-theme='dark'] .message-preview-box {
            background-color: #1a2333 !important;
            border-color: rgba(255, 255, 255, 0.1) !important;
          }
          [data-theme='neutral'] .message-preview-box {
            background-color: #e8e4d8 !important;
            border-color: rgba(67, 52, 34, 0.12) !important;
          }
          .icon-box:hover {
            opacity: 1;
          }
        `}
      </style>

      <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
        <div className="d-flex align-items-center gap-3">
          <div className="icon-box">
            <Bell size={28} />
          </div>
          <div>
            <h2 className="mb-0 fw-bold d-flex align-items-center gap-2">
              {t('notifications.title')}
              {unreadCount > 0 && (
                <Badge pill bg="primary" style={{ fontSize: '0.85rem' }}>
                  {unreadCount}
                </Badge>
              )}
            </h2>
          </div>
        </div>
        <div className="d-flex gap-2 ms-auto">
          {unreadCount > 0 && (
            <Button 
              variant="outline-primary" 
              size="sm" 
              onClick={handleMarkAllRead} 
              className="d-flex align-items-center gap-2 px-3 rounded-pill"
            >
              <CheckCheck size={14} />
              {t('notifications.mark_all_read', 'Прочитать все')}
            </Button>
          )}
          {activeNotifs.length > 0 && (
            <Button 
              variant="outline-danger" 
              size="sm" 
              onClick={handleDeleteAll} 
              className="d-flex align-items-center gap-2 px-3 rounded-pill"
            >
              <Trash2 size={14} />
              {t('notifications.delete_all', 'Очистить все')}
            </Button>
          )}
        </div>
      </div>

      {currentSet.length > 0 && totalPages > 1 && (
        <div className="d-flex justify-content-end mb-3">
          <ForumPagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </div>
      )}

      {currentSet.length === 0 ? (
        <ForumEmptyState
          icon={BellOff}
          title={t('notifications.no_notifications')}
          description={t('notifications.we_will_notify')}
        />
      ) : (
        <>
          <div className="notifications-list mb-4">
            {currentItems.map((n, idx) => renderNotification(n, idx))}
          </div>
          
          {totalPages > 1 && (
            <div className="d-flex justify-content-center mt-5 mb-4">
              <ForumPagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
                centered
              />
            </div>
          )}
        </>
      )}

    </Container>
  );
};

export default NotificationsPage;
