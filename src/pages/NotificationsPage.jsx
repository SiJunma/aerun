import React, { useEffect, useState } from 'react';
import { Container, Card, Badge, Button, Row, Col, Nav, Toast, ToastContainer } from 'react-bootstrap';
import { Bell, BellOff, CheckCheck, UserCheck, Clock, FlaskConical, Archive, X, MessageSquare } from 'lucide-react';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';
import {
  subscribeToAdminNotifications,
  subscribeToUserNotifications,
  markNotificationRead,
  markAllAdminNotificationsRead,
  createNotification,
  archiveNotification,
  archiveAllAdminNotifications,
  archiveAllUserNotifications
} from '../api/notifications';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import ForumPagination from '../components/common/ForumPagination';

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
  }
};

const formatDate = (ts, lang = 'ru') => {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const NotificationsPage = () => {
  const { profile, recordActivity } = useAuth();
  const { t, lang } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const activeTab = searchParams.get('tab') || 'active'; // 'active' or 'archived'
  const setActiveTab = (tab) => setSearchParams({ tab });
  const [archivingId, setArchivingId] = useState(null);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;
  
  // Toast state
  const [toast, setToast] = useState({ show: false, message: '', variant: 'success' });
  const showToast = (message, variant = 'success') => setToast({ show: true, message, variant });

  const isAdmin = profile?.role_id === 'admin';

  useEffect(() => {
    if (!profile?.uid) return;
    
    let unsubAdminActive = () => {};
    let unsubAdminArchive = () => {};
    let unsubUserActive = () => {};
    let unsubUserArchive = () => {};

    // Personal Notifications
    unsubUserActive = subscribeToUserNotifications(profile.uid, (notifs) => {
      setUserActive(notifs);
    }, false);
    unsubUserArchive = subscribeToUserNotifications(profile.uid, (notifs) => {
      setUserArchived(notifs);
    }, true);

    // Admin Notifications
    if (isAdmin) {
      unsubAdminActive = subscribeToAdminNotifications(setAdminActive, false);
      unsubAdminArchive = subscribeToAdminNotifications(setAdminArchived, true);
    }

    return () => {
      unsubUserActive();
      unsubUserArchive();
      unsubAdminActive();
      unsubAdminArchive();
    };
  }, [isAdmin, profile?.uid]);

  const [adminActive, setAdminActive] = useState([]);
  const [adminArchived, setAdminArchived] = useState([]);
  const [userActive, setUserActive] = useState([]);
  const [userArchived, setUserArchived] = useState([]);

  const activeNotifs = [...adminActive, ...userActive].sort((a, b) => 
    (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0)
  );
  const archivedNotifs = [...adminArchived, ...userArchived].sort((a, b) => 
    (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0)
  );

  // Reset pagination on tab switch
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab]);

  const handleMarkRead = (e, id) => {
    if (e) e.stopPropagation();
    recordActivity();
    markNotificationRead(id)
      .catch(err => showToast(err.message, 'danger'));
  };

  const handleArchive = (e, id) => {
    e.stopPropagation();
    recordActivity();
    
    // Trigger animation first
    setArchivingId(id);
    
    // Wait for animation to finish before calling API
    setTimeout(() => {
      archiveNotification(id)
        .then(() => {
          showToast(t('notifications.archived_toast'));
          setArchivingId(null);
        })
        .catch(err => {
          showToast(err.message, 'danger');
          setArchivingId(null);
        });
    }, 300);
  };

  const handleArchiveAll = async () => {
    recordActivity();
    try {
      if (isAdmin) {
        await archiveAllAdminNotifications();
      }
      if (profile?.uid) {
        await archiveAllUserNotifications(profile.uid);
      }
      showToast(t('notifications.archived_all_toast'));
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };


  const unreadCount = activeNotifs.filter(n => !n.read).length;
  const archivedCount = archivedNotifs.length;

  const currentSet = activeTab === 'active' ? activeNotifs : archivedNotifs;

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
    const isArchiving = archivingId === n.id;
    // Reverse numbering: newest (top) gets the highest number
    const globalIndex = currentSet.length - ((currentPage - 1) * itemsPerPage + idx);

    return (
      <Card
        key={n.id}
        className={`mb-3 notification-card border-1 ${!n.read ? 'unread-notif' : 'read-notif'} shadow-sm ${isArchiving ? 'archiving-exit' : ''}`}
      >
        <Card.Body className="py-3 px-4 position-relative">
          <Row className="align-items-start g-3">
            <Col xs="auto" className="pt-1 flex-shrink-0">
              <div 
                className="d-flex align-items-center justify-content-center bg-secondary bg-opacity-20 text-primary rounded-circle"
                style={{ width: '40px', height: '40px' }}
              >
                {meta?.icon ?? <Bell size={18} />}
              </div>
            </Col>
            <Col>
              <div className="d-flex align-items-center gap-2 mb-2 line-height-1">
                <span className="fw-bold small text-uppercase text-muted" style={{ letterSpacing: '1px', fontSize: '0.65rem' }}>
                  {n.type === 'topic_reply' ? (
                    (() => {
                      const fullText = t('notifications.types.topic_reply', { count: payload.post_count, topic: '|||TOPIC|||' });
                      const parts = fullText.split('|||TOPIC|||');
                      return (
                        <>
                          {parts[0]}
                          <Link 
                            to={`/topic/${payload.topic_id}?goLast=0#post-${payload.last_post_id}`}
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

                <div className="ms-auto d-flex align-items-center gap-3">
                  <span className="text-muted small d-flex align-items-center gap-1" style={{ fontSize: '0.75rem' }}>
                    <Clock size={12} />
                    {formatDate(n.created_at, lang)}
                  </span>
                  
                  {activeTab === 'active' && (
                    <Button 
                      variant="link" 
                      className="p-0 text-muted hover-opacity-100 opacity-50 transition-all archive-btn d-flex align-items-center"
                      onClick={(e) => handleArchive(e, n.id)}
                      title={t('notifications.archive')}
                    >
                      <X size={18} />
                    </Button>
                  )}
                </div>
              </div>

              {n.type === 'new_registration' && payload && (
                <div className="ps-0 ps-md-1">
                  <div className="mb-2 d-flex align-items-baseline gap-2">
                    <span className="fw-bold fs-5">{payload.nickname}</span>
                    <span className="text-muted small">{payload.email}</span>
                  </div>
                  {payload.admin_message && (
                    <div
                      className="mt-2 p-3 rounded-3 small"
                      style={{ 
                        background: 'rgba(var(--primary-rgb), 0.05)', 
                        border: '1px solid var(--border-color)',
                        whiteSpace: 'pre-wrap', 
                        wordBreak: 'break-word',
                        color: 'var(--text-color)',
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

                    {!n.read && activeTab === 'active' && (
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
                      to={`/topic/${payload.topic_id}?goLast=0#post-${payload.first_post_id}`} 
                      className="text-decoration-none small fw-bold text-primary"
                      onClick={() => !n.read && handleMarkRead(null, n.id)}
                    >
                      {lang === 'ru' ? 'Перейти к сообщению →' : 'Go to message →'}
                    </Link>

                    {!n.read && activeTab === 'active' && (
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
            background-color: rgba(var(--primary-rgb), 0.05) !important;
            border-left: 4px solid var(--primary-color) !important;
            border-top-left-radius: 4px !important;
            border-bottom-left-radius: 4px !important;
          }
          .notification-card.read-notif {
            opacity: 0.6;
          }
          .notification-card:hover {
            background-color: rgba(var(--primary-rgb), 0.02) !important;
          }
          .archive-btn:hover {
            color: var(--bs-danger) !important;
            opacity: 1 !important;
          }
          .nav-pills .nav-link {
            color: var(--text-color);
            opacity: 0.6;
            font-weight: 500;
            border-radius: 20px;
            padding: 8px 16px;
            transition: all 0.2s ease;
          }
          .nav-pills .nav-link.active {
            background-color: var(--primary-color) !important;
            color: var(--bg-color) !important;
            opacity: 1;
          }
          .nav-pills .nav-link:hover:not(.active) {
            background-color: rgba(var(--primary-rgb), 0.1);
            opacity: 1;
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
            background-color: rgba(var(--primary-rgb), 0.08) !important;
            color: var(--primary-color) !important;
            border: 1px solid rgba(var(--primary-rgb), 0.15) !important;
            opacity: 0.9;
          }
          .custom-toast {
            min-width: 240px; 
            background: #0f172a !important; /* Deep Slate 900 */
            backdrop-filter: blur(10px);
            border: 1px solid rgba(var(--primary-rgb), 0.2) !important;
            border-left: 4px solid var(--primary-color) !important;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4) !important;
          }
          .icon-box {
            background-color: rgba(var(--primary-rgb), 0.05) !important;
            border: 1px solid var(--border-color) !important;
            padding: 12px;
            border-radius: 12px;
            color: var(--primary-color);
            opacity: 0.7;
            transition: opacity 0.2s ease;
          }
          .icon-box:hover {
            opacity: 1;
          }
          .tab-badge {
            background-color: rgba(var(--primary-rgb), 0.08) !important;
            color: var(--primary-color) !important;
            border: 1px solid rgba(var(--primary-rgb), 0.2) !important;
            font-size: 0.8rem;
            margin-left: 6px;
            font-weight: 700;
            padding: 0.1rem 0.5rem;
            opacity: 0.9;
            min-width: 1.8rem;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
          .tab-badge.archived-badge {
            background-color: transparent !important;
            color: #94a3b8 !important;
            border-color: rgba(148, 163, 184, 0.4) !important;
          }
          .nav-pills .nav-link.active .tab-badge {
            background-color: var(--bg-color) !important;
            color: var(--primary-color) !important;
            border-color: rgba(var(--primary-rgb), 0.2) !important;
            box-shadow: inset 0 0 5px rgba(0,0,0,0.1);
          }
          .nav-pills .nav-link.active .tab-badge.archived-badge {
            color: var(--primary-color) !important;
            border-color: rgba(var(--primary-rgb), 0.3) !important;
          }
        `}
      </style>

      <div className="d-flex align-items-center justify-content-between mb-4">
        <div className="d-flex align-items-center gap-3">
          <div className="icon-box">
            <Bell size={28} />
          </div>
          <div>
            <h2 className="mb-0 fw-bold">{t('notifications.title')}</h2>
          </div>
        </div>
        <div className="d-flex gap-2">
          {activeTab === 'active' && activeNotifs.length > 0 && (
            <Button 
              variant="outline-primary" 
              size="sm" 
              onClick={handleArchiveAll} 
              className="d-flex align-items-center gap-2 px-3 rounded-pill"
            >
              <Archive size={14} />
              {t('notifications.archive_all')}
            </Button>
          )}
        </div>
      </div>

      <div className="d-flex align-items-center justify-content-between mb-4">
        <Nav variant="pills" className="gap-2">
          <Nav.Item>
            <Nav.Link 
              as={Link}
              to="/notifications?tab=active"
              active={activeTab === 'active'} 
              className="d-flex align-items-center gap-2"
            >
              {t('notifications.tab_active')} 
              {unreadCount > 0 && (
                <Badge pill className="tab-badge">{unreadCount}</Badge>
              )}
            </Nav.Link>
          </Nav.Item>
          <Nav.Item>
            <Nav.Link 
              as={Link}
              to="/notifications?tab=archived"
              active={activeTab === 'archived'} 
              className="d-flex align-items-center gap-2"
            >
              {t('notifications.tab_archived')}
              {archivedCount > 0 && (
                <Badge pill className="tab-badge archived-badge">{archivedCount}</Badge>
              )}
            </Nav.Link>
          </Nav.Item>
        </Nav>

        {currentSet.length > 0 && (
          <ForumPagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        )}
      </div>

      {currentSet.length === 0 ? (
        <Card className="text-center py-5 border-0 bg-transparent">
          <Card.Body>
            <div className="mb-4 text-muted opacity-25">
              {activeTab === 'active' ? <BellOff size={64} strokeWidth={1} /> : <Archive size={64} strokeWidth={1} />}
            </div>
            <h4 className="text-muted fw-light">
              {activeTab === 'active' ? t('notifications.no_notifications') : t('notifications.archive_empty')}
            </h4>
            {activeTab === 'active' && <p className="text-muted small">{t('notifications.we_will_notify')}</p>}
          </Card.Body>
        </Card>
      ) : (
        <>

          <div className="notifications-list mb-4">
            {currentItems.map((n, idx) => renderNotification(n, idx))}
          </div>
          
          <div className="d-flex justify-content-center mt-5 mb-4">
            <ForumPagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={handlePageChange}
              centered
            />
          </div>
        </>
      )}

      {/* Toasts */}
      <ToastContainer position="bottom-end" className="p-3" style={{ position: 'fixed', zIndex: 1060 }}>
        <Toast 
          show={toast.show} 
          onClose={() => setToast({ ...toast, show: false })} 
          delay={3000} 
          autohide
          className="custom-toast"
        >
          <Toast.Body className="d-flex align-items-center gap-3 py-3 px-3 text-white">
            <div className="d-flex align-items-center" style={{ color: 'var(--primary-color)' }}>
              {toast.variant === 'danger' ? <BellOff size={18} className="text-danger" /> : <CheckCheck size={18} />}
            </div>
            <span className="fw-medium small" style={{ color: '#fff' }}>{toast.message}</span>
          </Toast.Body>
        </Toast>
      </ToastContainer>
    </Container>
  );
};

export default NotificationsPage;
