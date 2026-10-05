import React, { useRef } from 'react';
import { Navbar, Nav, Container, NavDropdown, Image, Badge, Button } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { useTheme } from '../../contexts/ThemeProvider';
import { resolveAvatarUrl } from '../../api/avatars';
import { useDesign } from '../../contexts/DesignProvider';
import { Bell, User, LogOut, MessageCircle, Palette, Check, FilePen } from 'lucide-react';
import { subscribeToDmUnread } from '../../api/dms';
import { playNotificationSound } from '../../utils/notificationSound';
import AuthModal from '../modals/AuthModal';

const Navigation = () => {
  const { user, profile, settings, logout, unreadTopicsCount, hasPermission, PERMISSIONS, activeDmConvId, dmUnread: unreadCounts } = useAuth();
  const { t, lang } = useI18n();
  const { theme, changeGuestTheme } = useTheme();
  const { activeDesign } = useDesign();
  const navigate = useNavigate();
  const [dmUnread, setDmUnread] = React.useState(0);
  const [expanded, setExpanded] = React.useState(false);
  const [showAuthModal, setShowAuthModal] = React.useState(false);
  const [authModalMode, setAuthModalMode] = React.useState('login');

  const isAdmin = (profile?.role_id === 'admin' || profile?.role_id === 'root') && hasPermission(PERMISSIONS.ADMIN_ACCESS);

  // The unread-notification badge is the SERVER's count, not a list counted here.
  //
  // This used to subscribe to `subscribeToUserNotifications` and render
  // `notifs.filter(n => !n.read).length` — so the bell cost every member a
  // `GET /me/notifications?limit=100` on every page of the forum, a hundred whole
  // notification records fetched to derive one integer, and a number that could not
  // exceed the page size however many unread rows actually existed.
  //
  // `unreadCounts` is AuthProvider's `/me/unread-counts` subscription, which
  // already carries `unread_notifications` on the request it was making anyway, so
  // this reads state that costs nothing extra. The bell is a number; the LIST is
  // now fetched only where rows are rendered — the Notifications page and
  // TopicPage's quote highlighting.
  //
  // Derived, not stored: nothing ever assigns this, and a `useState` fed by an
  // effect would re-render the whole navbar a second time on every poll for a
  // number the render can read directly.
  const userUnread = unreadCounts?.notifications || 0;

  // Subscribe to DM unread count via RTDB (0 Firestore reads)
  const [dmUnreadData, setDmUnreadData] = React.useState({ total: 0, conversations: {} });
  React.useEffect(() => {
    if (!user?.uid || !hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES) || profile?.role_id === 'pending') {
      setDmUnread(0);
      setDmUnreadData({ total: 0, conversations: {} });
      return;
    }
    const unsub = subscribeToDmUnread(user.uid, (data) => {
      setDmUnreadData(data || { total: 0, conversations: {} });
    });
    return () => unsub();
  }, [user?.uid, hasPermission, PERMISSIONS.USE_DIRECT_MESSAGES, profile?.role_id]);

  // Exclude the currently open DM conversation from the badge
  React.useEffect(() => {
    const { total = 0, conversations = {} } = dmUnreadData;
    if (activeDmConvId && conversations[activeDmConvId]) {
      const openConvCount = conversations[activeDmConvId]?.unread_count || 0;
      setDmUnread(Math.max(0, total - openConvCount));
    } else {
      setDmUnread(total);
    }
  }, [dmUnreadData, activeDmConvId]);

  const totalUnread = userUnread;
  const totalBadge = totalUnread + dmUnread;

  // ── Play sound when new notification or DM arrives ───────────────
  const prevTotalBadgeRef = useRef(null);
  const isHydratedRef = useRef(false);

  // Reset hydration grace window on initial load or user change
  React.useEffect(() => {
    isHydratedRef.current = false;
    prevTotalBadgeRef.current = null;
    const timer = setTimeout(() => {
      isHydratedRef.current = true;
    }, 2000); // 2s grace window to absorb initial snapshot loads
    return () => clearTimeout(timer);
  }, [user?.uid]);

  React.useEffect(() => {
    // Skip sound on initial page load / initial state hydration grace period
    if (!isHydratedRef.current || prevTotalBadgeRef.current === null) {
      prevTotalBadgeRef.current = totalBadge;
      return;
    }
    const prev = prevTotalBadgeRef.current;
    const isSoundEnabled = profile?.settings?.sound?.enabled !== false;
    if (totalBadge > prev && isSoundEnabled) {
      playNotificationSound(profile?.settings?.sound?.volume ?? 40);
    }
    prevTotalBadgeRef.current = totalBadge;
  }, [totalBadge, profile?.settings?.sound?.enabled, profile?.settings?.sound?.volume]);

  const handleLogout = async () => {
    await logout();
    if (settings?.whitelistMode) {
      navigate('/login');
    } else {
      navigate('/');
    }
  };

  return (
    <Navbar 
      bg="dark" 
      variant="dark" 
      expand="lg" 
      sticky="top" 
      expanded={expanded}
      onToggle={(val) => setExpanded(val)}
      className="mb-0 shadow-sm border-bottom border-secondary border-opacity-25"
    >
      <Container className="d-flex align-items-center">
        <div className="d-flex align-items-center">
          <div className="position-relative d-lg-none">
            <Navbar.Toggle 
              aria-controls="basic-navbar-nav" 
              className="me-2 border-0 p-1"
              onClick={() => setExpanded(!expanded)}
            />
            {(unreadTopicsCount > 0 || totalBadge > 0) && (
              <span 
                className="position-absolute rounded-circle bg-warning shadow-sm" 
                style={{ 
                  width: '10px', 
                  height: '10px', 
                  top: '5px', 
                  right: '11px', 
                  border: '2px solid var(--nav-bg)',
                  pointerEvents: 'none'
                }}
              />
            )}
          </div>
          <Navbar.Brand as={Link} to="/" onClick={() => setExpanded(false)} className="d-flex align-items-center gap-2">
            {(activeDesign?.logoUrl || settings?.logoUrl) && (
              <img 
                src={activeDesign?.logoUrl || settings.logoUrl} 
                alt="Logo" 
                style={{ height: '32px', width: 'auto', objectFit: 'contain' }}
              />
            )}
            <span>
              {activeDesign?.forumTitle ? activeDesign.forumTitle : (
                (typeof settings?.forumName === 'object' && settings.forumName !== null)
                  ? (settings.forumName[lang] || settings.forumName.en || 'Aerun Forum')
                  : (settings?.forumName || 'Aerun Forum')
              )}
            </span>
          </Navbar.Brand>
        </div>

        {/* Persistent actions (Right side on mobile & desktop) */}
        <div className="d-flex align-items-center gap-2 gap-md-3 order-lg-3 ms-auto">
          {settings?.maintenanceMode && (
            <Badge bg="warning" text="dark" className="d-none d-sm-flex align-items-center gap-1 shadow-sm px-2 py-1" style={{ fontSize: '0.75rem', letterSpacing: '0.5px' }}>
              <div className="bg-dark rounded-circle me-1" style={{ width: '6px', height: '6px', animation: 'pulse 1.5s infinite' }}></div>
              {lang === 'ru' ? 'ТЕХРАБОТЫ' : 'MAINTENANCE'}
            </Badge>
          )}

          {/* Notifications bell */}
          {user && profile?.role_id !== 'banned' && profile?.role_id !== 'pending' && profile?.role_id !== 'spectator' && (
            <Nav.Link
              as={Link}
              to="/notifications"
              onClick={() => setExpanded(false)}
              className="position-relative p-1 d-flex align-items-center text-light opacity-75 hover-opacity-100"
              title={lang === 'ru' ? 'Уведомления' : 'Notifications'}
            >
              <Bell size={20} />
              {totalUnread > 0 && (
                <Badge
                  bg="danger"
                  pill
                  className="position-absolute"
                  style={{ top: '0px', right: '-3px', fontSize: '0.6rem', minWidth: '16px', padding: '2px 4px' }}
                >
                  {totalUnread > 99 ? '99+' : totalUnread}
                </Badge>
              )}
            </Nav.Link>
          )}

          {/* DM inbox button */}
          {hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES) && (
            <Nav.Link
              as={Link}
              to="/messages"
              onClick={() => setExpanded(false)}
              className="position-relative p-1 d-flex align-items-center text-light opacity-75 hover-opacity-100"
              title={lang === 'ru' ? 'Личные сообщения' : 'Messages'}
            >
              <MessageCircle size={20} />
              {dmUnread > 0 && (
                <Badge
                  bg="danger"
                  pill
                  className="position-absolute"
                  style={{ top: '0px', right: '-3px', fontSize: '0.6rem', minWidth: '16px', padding: '2px 4px' }}
                >
                  {dmUnread > 99 ? '99+' : dmUnread}
                </Badge>
              )}
            </Nav.Link>
          )}

          {user ? (
            <NavDropdown
              title={
                <div className="d-flex align-items-center gap-2 py-0">
                  <Image
                    src={resolveAvatarUrl(profile?.avatar_url) || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.nickname || user.displayName || 'User')}&background=random`}
                    roundedCircle
                    style={{ width: '32px', height: '32px', objectFit: 'cover', display: 'block' }}
                    alt="Avatar"
                    referrerPolicy="no-referrer"
                  />
                  <span className="fw-semibold lh-1 d-none d-sm-inline-block text-light">{profile?.nickname || user.displayName || 'User'}</span>
                </div>
              }
              id="user-nav-dropdown"
              align="end"
              onToggle={(isOpen) => {
                if (isOpen) setExpanded(false);
              }}
            >
              <NavDropdown.Item 
                as={Link} 
                to={`/profile/${user.uid}`} 
                onClick={() => setExpanded(false)}
                className="d-flex align-items-center gap-2"
              >
                <User size={16} />
                {t('nav.profile')}
              </NavDropdown.Item>
              {/* Drafts live under the account menu, not in the top-level nav.
                  They are the signed-in member's own unsent text — a personal
                  inbox, not a section of the forum — and a top-level link to
                  somebody's private working notes is the wrong thing to put
                  next to Members and Admin. */}
              <NavDropdown.Item 
                as={Link} 
                to="/drafts" 
                onClick={() => setExpanded(false)}
                className="d-flex align-items-center gap-2"
              >
                <FilePen size={16} />
                {t('nav.drafts')}
              </NavDropdown.Item>
              <NavDropdown.Divider />
              <NavDropdown.Item onClick={() => { handleLogout(); setExpanded(false); }} className="d-flex align-items-center gap-2 text-danger">
                <LogOut size={16} />
                {t('common.logout')}
              </NavDropdown.Item>
            </NavDropdown>
          ) : (
            <div className="d-flex align-items-center gap-2">
              <NavDropdown
                title={<Palette size={18} className="text-light opacity-75 hover-opacity-100" />}
                id="guest-theme-dropdown-persistent"
                align="end"
                className="no-caret d-none d-lg-block"
              >
                <NavDropdown.Item onClick={() => { changeGuestTheme('light'); setExpanded(false); }} className={`d-flex align-items-center gap-2 ${theme === 'light' ? 'fw-bold text-primary' : ''}`}>
                  {theme === 'light' ? <Check size={16} /> : <div style={{width: 16}}></div>}
                  {t('profile.theme_light')}
                </NavDropdown.Item>
                <NavDropdown.Item onClick={() => { changeGuestTheme('dark'); setExpanded(false); }} className={`d-flex align-items-center gap-2 ${theme === 'dark' ? 'fw-bold text-primary' : ''}`}>
                  {theme === 'dark' ? <Check size={16} /> : <div style={{width: 16}}></div>}
                  {t('profile.theme_dark')}
                </NavDropdown.Item>
                <NavDropdown.Item onClick={() => { changeGuestTheme('neutral'); setExpanded(false); }} className={`d-flex align-items-center gap-2 ${theme === 'neutral' ? 'fw-bold text-primary' : ''}`}>
                  {theme === 'neutral' ? <Check size={16} /> : <div style={{width: 16}}></div>}
                  {t('profile.theme_neutral')}
                </NavDropdown.Item>
              </NavDropdown>

              <Nav.Link 
                as={settings?.whitelistMode ? Link : 'span'}
                to={settings?.whitelistMode ? "/login" : undefined}
                role={settings?.whitelistMode ? undefined : "button"}
                onClick={() => {
                  if (!settings?.whitelistMode) {
                    setAuthModalMode('login');
                    setShowAuthModal(true);
                  }
                  setExpanded(false);
                }} 
                className="fw-semibold text-light px-2"
                style={{ cursor: 'pointer' }}
              >
                {t('nav.login')}
              </Nav.Link>
              {settings?.registrationEnabled !== false && (
                <Button
                  variant="primary"
                  size="sm"
                  className="rounded-pill px-3 fw-semibold"
                  onClick={() => {
                    if (!settings?.whitelistMode) {
                      setAuthModalMode('register');
                      setShowAuthModal(true);
                    } else {
                      navigate('/register');
                    }
                    setExpanded(false);
                  }}
                >
                  {t('nav.register')}
                </Button>
              )}
            </div>
          )}
        </div>

        <Navbar.Collapse id="basic-navbar-nav" className="order-lg-2">
          <Nav className="me-auto mt-2 mt-lg-0">
            {user && (
              <>
                <Nav.Link as={Link} to="/new-replies" onClick={() => setExpanded(false)}>
                  {t('nav.active_topics')}
                  {unreadTopicsCount > 0 && ` (${unreadTopicsCount})`}
                </Nav.Link>
                <Nav.Link as={Link} to="/subscriptions" onClick={() => setExpanded(false)}>
                  {t('nav.subscriptions', 'Подписки')}
                </Nav.Link>
              </>
            )}
            <Nav.Link as={Link} to="/members" onClick={() => setExpanded(false)}>

              {t('nav.members')}
            </Nav.Link>
            {isAdmin && (
              <Nav.Link as={Link} to="/admin" onClick={() => setExpanded(false)} className="text-warning fw-semibold">
                {t('nav.admin')}
              </Nav.Link>
            )}
          </Nav>
          
          {!user && (
            <Nav className="d-lg-none mt-2 pt-2 border-top border-secondary border-opacity-25">
              <NavDropdown
                title={
                  <div className="d-flex align-items-center gap-2 text-light opacity-75 hover-opacity-100">
                    <Palette size={18} />
                    <span>{lang === 'ru' ? 'Тема оформления' : 'Theme'}</span>
                  </div>
                }
                id="guest-theme-dropdown-collapse"
                align="end"
                className="no-caret"
              >
                <NavDropdown.Item onClick={() => { changeGuestTheme('light'); setExpanded(false); }} className={`d-flex align-items-center gap-2 ${theme === 'light' ? 'fw-bold text-primary' : ''}`}>
                  {theme === 'light' ? <Check size={16} /> : <div style={{width: 16}}></div>}
                  {t('profile.theme_light')}
                </NavDropdown.Item>
                <NavDropdown.Item onClick={() => { changeGuestTheme('dark'); setExpanded(false); }} className={`d-flex align-items-center gap-2 ${theme === 'dark' ? 'fw-bold text-primary' : ''}`}>
                  {theme === 'dark' ? <Check size={16} /> : <div style={{width: 16}}></div>}
                  {t('profile.theme_dark')}
                </NavDropdown.Item>
                <NavDropdown.Item onClick={() => { changeGuestTheme('neutral'); setExpanded(false); }} className={`d-flex align-items-center gap-2 ${theme === 'neutral' ? 'fw-bold text-primary' : ''}`}>
                  {theme === 'neutral' ? <Check size={16} /> : <div style={{width: 16}}></div>}
                  {t('profile.theme_neutral')}
                </NavDropdown.Item>
              </NavDropdown>
            </Nav>
          )}
        </Navbar.Collapse>
      </Container>
      
      <AuthModal 
        show={showAuthModal} 
        onHide={() => setShowAuthModal(false)} 
        initialMode={authModalMode}
      />
    </Navbar>
  );
};

export default Navigation;
