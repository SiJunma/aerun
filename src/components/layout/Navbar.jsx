import React from 'react';
import { Navbar, Nav, Container, NavDropdown, Image, Badge } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { Bell, BellOff, User, LogOut } from 'lucide-react';
import { subscribeToAdminNotifications, subscribeToUserNotifications } from '../../api/notifications';

const Navigation = () => {
  const { user, profile, settings, logout } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [adminUnread, setAdminUnread] = React.useState(0);
  const [userUnread, setUserUnread] = React.useState(0);

  const isAdmin = profile?.role_id === 'admin';

  // Subscribe to notifications
  React.useEffect(() => {
    if (!user?.uid) return;

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
  }, [isAdmin, user?.uid]);

  const totalUnread = adminUnread + userUnread;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <Navbar bg="dark" variant="dark" expand="lg" sticky="top" className="mb-0 shadow-sm border-bottom border-secondary border-opacity-25">
      <Container>
        <Navbar.Brand as={Link} to="/">{t('common.app_name')}</Navbar.Brand>
        <Navbar.Toggle aria-controls="basic-navbar-nav" />
        <Navbar.Collapse id="basic-navbar-nav">
          <Nav className="me-auto">
            <Nav.Link as={Link} to="/members">{t('nav.members')}</Nav.Link>
            {isAdmin && (
              <Nav.Link as={Link} to="/admin" className="text-warning fw-semibold">
                {t('nav.admin')}
              </Nav.Link>
            )}
          </Nav>
          <Nav className="align-items-center gap-3">
            {settings?.maintenanceMode && isAdmin && (
              <Badge bg="warning" text="dark" className="d-flex align-items-center gap-1 shadow-sm px-2 py-1" style={{ fontSize: '0.75rem', letterSpacing: '0.5px' }}>
                <div className="bg-dark rounded-circle me-1" style={{ width: '6px', height: '6px', animation: 'pulse 1.5s infinite' }}></div>
                {lang === 'ru' ? 'ТЕХРАБОТЫ' : 'MAINTENANCE'}
              </Badge>
            )}

            {/* Notifications bell — all users */}
            {user && (
              <Nav.Link
                as={Link}
                to="/notifications"
                className="position-relative p-1 d-flex align-items-center"
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

            {user ? (
              <NavDropdown
                title={
                  <div className="d-flex align-items-center gap-2 py-0">
                    <Image
                      src={profile?.avatar_url || user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.nickname || user.displayName || 'User')}&background=random`}
                      roundedCircle
                      style={{ width: '32px', height: '32px', objectFit: 'cover', display: 'block' }}
                      alt="Avatar"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        e.target.onerror = null;
                        e.target.src = 'https://ui-avatars.com/api/?name=User&background=666&color=fff';
                      }}
                    />
                    <span className="fw-semibold lh-1">{profile?.nickname || user.displayName || 'User'}</span>
                  </div>
                }
                id="user-nav-dropdown"
                align="end"
              >
                <NavDropdown.Item as={Link} to={`/profile/${user.uid}`} className="d-flex align-items-center gap-2">
                  <User size={16} />
                  {t('nav.profile')}
                </NavDropdown.Item>
                <NavDropdown.Divider />
                <NavDropdown.Item onClick={handleLogout} className="d-flex align-items-center gap-2 text-danger">
                  <LogOut size={16} />
                  {t('common.logout')}
                </NavDropdown.Item>
              </NavDropdown>
            ) : (
              <>
                <Nav.Link as={Link} to="/login" className="me-2 fw-semibold">Login</Nav.Link>
                <Link to="/register" className="btn btn-primary btn-sm rounded-pill px-3">Register</Link>
              </>
            )}
          </Nav>
        </Navbar.Collapse>
      </Container>
    </Navbar>
  );
};

export default Navigation;
