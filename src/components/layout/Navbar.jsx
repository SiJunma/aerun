import React, { useRef } from 'react';
import { Navbar, Nav, Container, NavDropdown, Image, Badge, Button } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { useTheme } from '../../contexts/ThemeProvider';
import { resolveAvatarUrl } from '../../api/avatars';
import { useDesign } from '../../contexts/DesignProvider';
import { resolveField } from '../../utils/text';
import { Bell, User, LogOut, MessageCircle, Palette, Check, FilePen } from 'lucide-react';
import { subscribeToDmUnread } from '../../api/dms';
import { subscribeToDefaultDesigns } from '../../api/designs';
import { builtinThemeLabel, visibleBuiltinThemeKeys } from '../../utils/defaultDesignPicker';
import { playNotificationSound } from '../../utils/notificationSound';
import AuthModal from '../modals/AuthModal';

const Navigation = () => {
  const { user, profile, settings, logout, unreadTopicsCount, hasPermission, PERMISSIONS, _activeDmConvId, dmUnread: unreadCounts } = useAuth();
  const { t, lang } = useI18n();
  const { changeGuestTheme } = useTheme();
  const { activeDesign, resolvedDesign } = useDesign();
  const navigate = useNavigate();
  const [dmUnread, setDmUnread] = React.useState(0);
  const [expanded, setExpanded] = React.useState(false);
  const [showAuthModal, setShowAuthModal] = React.useState(false);
  const [authModalMode, setAuthModalMode] = React.useState('login');

  // Guest theme picker: the names come from the default-design cards
  // (subscribeToDefaultDesigns — one fetch, module cache), exactly like the
  // member picker in ProfilePage; the dictionary labels are the fallback
  // while the cards are loading, and hidden cards never appear once loaded.
  const [defaultDesigns, setDefaultDesigns] = React.useState([]);
  React.useEffect(() => {
    const unsub = subscribeToDefaultDesigns(setDefaultDesigns);
    return () => unsub();
  }, []);

  // The checkmark follows the card actually applied, not the `theme` state:
  // while the single-record GET for a fresh guest choice is in flight the
  // page still shows the old card, so a checkmark on `theme` would lie
  // about the page. No card resolved yet (boot / in flight) → no checkmark.
  const appliedThemeKey = activeDesign?.isDefaultDesign ? activeDesign.key : null;

  // One renderer for both dropdown variants (persistent desktop, collapse
  // mobile) so the two cannot drift apart again. Selecting a card stores
  // its KEY as the guest theme — the same value the login migration sends
  // to the server.
  const renderGuestThemeItems = () => visibleBuiltinThemeKeys(defaultDesigns).map((key) => (
    <NavDropdown.Item
      key={key}
      onClick={() => { changeGuestTheme(key); setExpanded(false); }}
      className={`d-flex align-items-center gap-2 ${appliedThemeKey === key ? 'fw-bold text-primary' : ''}`}
    >
      {appliedThemeKey === key ? <Check size={16} /> : <div style={{ width: 16 }}></div>}
      {builtinThemeLabel(defaultDesigns, t, key)}
    </NavDropdown.Item>
  ));

  const isAdmin = (profile?.role === 'admin' || profile?.role === 'root') && hasPermission(PERMISSIONS.ADMIN_ACCESS);

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
    // A PENDING member is excluded here by the permission check alone: the
    // unread-count response carries their private conversations, and a member
    // who may not see them must not be told they exist. The check reads the
    // STATUS (the permission list is already status-narrowed by the server) —
    // the old `role === 'pending'` test could never fire, because a pending
    // account's role is a real role and its pending-ness is a status.
    if (!user?.uid || !hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES)) {
      setDmUnread(0);
      setDmUnreadData({ total: 0, conversations: {} });
      return;
    }
    const unsub = subscribeToDmUnread(user.uid, (data) => {
      setDmUnreadData(data || { total: 0, conversations: {} });
    });
    return () => unsub();
  }, [user?.uid, hasPermission, PERMISSIONS.USE_DIRECT_MESSAGES]);

  // Exclude the currently open DM conversation from the badge
  React.useEffect(() => {
    const { total = 0 } = dmUnreadData;
    setDmUnread(total);
  }, [dmUnreadData]);

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
      as="header"
      id="forum-header"
      bg="dark"
      variant="dark"
      expand="lg"
      sticky="top"
      expanded={expanded}
      onToggle={(val) => setExpanded(val)}
      className="forum-header mb-0 shadow-sm border-bottom border-secondary border-opacity-25"
    >
      <Container className="d-flex align-items-center">
        <div id="forum-title" className="forum-title d-flex align-items-center">
          <div className="position-relative d-lg-none">
            <Navbar.Toggle
              aria-controls="basic-navbar-nav"
              className="me-2 border-0 p-1"
              onClick={() => setExpanded(!expanded)}
            />
            {unreadTopicsCount > 0 && (
              <span className="nav-mobile-unread-dot" />
            )}
          </div>
          <Navbar.Brand as={Link} to="/" onClick={() => setExpanded(false)} className="forum-brand d-flex align-items-center gap-2">
            <span className="forum-name">
              {resolvedDesign?.forumTitle || resolveField(settings?.forumName, lang) || 'Aerun Forum'}
            </span>
          </Navbar.Brand>
        </div>

        {/* Persistent actions (Right side on mobile & desktop) */}
        <div id="forum-user-links" className="forum-user-links d-flex align-items-center gap-2 gap-md-3 order-lg-3 ms-auto">
          {settings?.maintenanceMode && (
            <Badge bg="warning" text="dark" className="d-none d-sm-flex align-items-center gap-1 shadow-sm px-2 py-1" style={{ fontSize: '0.75rem', letterSpacing: '0.5px' }}>
              <div className="bg-dark rounded-circle me-1" style={{ width: '6px', height: '6px', animation: 'pulse 1.5s infinite' }}></div>
              {t('navbar.maintenance')}
            </Badge>
          )}

          {/* Notifications bell */}
          {user && profile?.role !== 'banned' && profile?.role !== 'pending' && profile?.role !== 'spectator' && (
            <Nav.Link
              as={Link}
              to="/notifications"
              onClick={() => setExpanded(false)}
              className="position-relative p-1 d-flex align-items-center text-light opacity-75 hover-opacity-100"
              title={t('navbar.notifications')}
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
              title={t('navbar.messages')}
            >
              <MessageCircle size={20} />
              {dmUnread > 0 && (
                <Badge
                  bg="danger"
                  pill
                  className="dm-unread-badge"
                  aria-label={t('dm.aria_unread')}
                />
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
                {renderGuestThemeItems()}
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
          <Nav id="forum-nav" className="forum-nav me-auto mt-2 mt-lg-0">
            <Nav.Link as={Link} to="/new-replies" onClick={() => setExpanded(false)} className="nav-active-topics">
              {t('nav.active_topics')}
              {unreadTopicsCount > 0 && ` (${unreadTopicsCount})`}
            </Nav.Link>
            {user && (
              <Nav.Link as={Link} to="/subscriptions" onClick={() => setExpanded(false)} className="nav-subscriptions">
                {t('nav.subscriptions', 'Подписки')}
              </Nav.Link>
            )}
            <Nav.Link as={Link} to="/members" onClick={() => setExpanded(false)} className="nav-members">
              {t('nav.members')}
            </Nav.Link>
            {isAdmin && (
              <Nav.Link as={Link} to="/admin" onClick={() => setExpanded(false)} className="nav-admin">
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
                    <span>{t('navbar.theme')}</span>
                  </div>
                }
                id="guest-theme-dropdown-collapse"
                align="end"
                className="no-caret"
              >
                {renderGuestThemeItems()}
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
