import React from 'react';
import { Navbar, Nav, Container, NavDropdown, Image, Badge, Button } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { Bell, User, LogOut, MessageCircle } from 'lucide-react';
import { subscribeToAdminNotifications, subscribeToUserNotifications } from '../../api/notifications';
import { subscribeToDmList } from '../../api/dms';
import AuthModal from '../modals/AuthModal';

const Navigation = () => {
  const { user, profile, settings, logout, unreadTopicsCount, hasPermission, PERMISSIONS } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [adminUnread, setAdminUnread] = React.useState(0);
  const [userUnread, setUserUnread] = React.useState(0);
  const [dmUnread, setDmUnread] = React.useState(0);
  const [expanded, setExpanded] = React.useState(false);
  const [showAuthModal, setShowAuthModal] = React.useState(false);
  const [authModalMode, setAuthModalMode] = React.useState('login');

  const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);

  // Subscribe to notifications
  React.useEffect(() => {
    if (!user?.uid || profile?.role_id === 'pending' || profile?.role_id === 'banned') return;

    // User notifications
    const unsubUser = subscribeToUserNotifications(user.uid, (notifs) => {
      setUserUnread(notifs.filter(n => !n.read).length);
    });

    // Admin notifications
    let unsubAdmin = () => {};
    if (isAdmin) {
      unsubAdmin = subscribeToAdminNotifications((notifs) => {
        setAdminUnread(notifs.filter(n => !n.read).length);
      });
    } else {
      setAdminUnread(0);
    }

    return () => {
      unsubUser();
      unsubAdmin();
    };
  }, [isAdmin, user?.uid, profile?.role_id]);

  // Subscribe to DM unread count
  React.useEffect(() => {
    if (!hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES)) {
      setDmUnread(0);
      return;
    }
    const unsub = subscribeToDmList(user.uid, (convs) => {
      const total = convs.reduce((sum, c) => sum + (c.unread?.[user.uid] || 0), 0);
      setDmUnread(total);
    });
    return () => unsub();
  }, [user?.uid, hasPermission, PERMISSIONS.USE_DIRECT_MESSAGES]);

  const totalUnread = adminUnread + userUnread;

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
          <Navbar.Toggle 
            aria-controls="basic-navbar-nav" 
            className="me-2 border-0 p-1"
            onClick={() => setExpanded(!expanded)}
          />
          <Navbar.Brand as={Link} to="/" onClick={() => setExpanded(false)} className="d-flex align-items-center gap-2">
            {settings?.logoUrl && (
              <img 
                src={settings.logoUrl} 
                alt="Logo" 
                style={{ height: '32px', width: 'auto', objectFit: 'contain' }}
              />
            )}
            <span>
              {(typeof settings?.forumName === 'object' && settings.forumName !== null)
                ? (settings.forumName[lang] || settings.forumName.en || 'Aerun Forum')
                : (settings?.forumName || 'Aerun Forum')}
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
                  style={{ top: '-4px', right: '-6px', fontSize: '0.6rem', minWidth: '16px', padding: '2px 4px' }}
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
                  style={{ top: '-4px', right: '-6px', fontSize: '0.6rem', minWidth: '16px', padding: '2px 4px' }}
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
                    src={profile?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.nickname || user.displayName || 'User')}&background=random`}
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
              <NavDropdown.Divider />
              <NavDropdown.Item onClick={() => { handleLogout(); setExpanded(false); }} className="d-flex align-items-center gap-2 text-danger">
                <LogOut size={16} />
                {t('common.logout')}
              </NavDropdown.Item>
            </NavDropdown>
          ) : (
            <div className="d-flex align-items-center gap-2">
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
              <Nav.Link as={Link} to="/new-replies" onClick={() => setExpanded(false)}>
                {t('nav.new_replies')}
                {unreadTopicsCount > 0 && ` (${unreadTopicsCount})`}
              </Nav.Link>
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
