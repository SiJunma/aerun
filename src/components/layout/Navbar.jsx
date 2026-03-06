import React from 'react';
import { Navbar, Nav, Container, NavDropdown, Image } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { User, Settings, LogOut } from 'lucide-react';

const Navigation = () => {
  const { user, profile, logout } = useAuth();
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <Navbar bg="dark" variant="dark" expand="lg" sticky="top" className="mb-0">
      <Container>
        <Navbar.Brand as={Link} to="/">{t('common.app_name')}</Navbar.Brand>
        <Navbar.Toggle aria-controls="basic-navbar-nav" />
        <Navbar.Collapse id="basic-navbar-nav">
          <Nav className="me-auto">
            <Nav.Link as={Link} to="/">{t('nav.home')}</Nav.Link>
            <Nav.Link as={Link} to="/members">{t('nav.members')}</Nav.Link>
          </Nav>
          <Nav className="align-items-center">

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
                {profile?.role_id === 'admin' && (
                  <>
                    <NavDropdown.Divider />
                    <NavDropdown.Item as={Link} to="/admin" className="d-flex align-items-center gap-2">
                      <Settings size={16} />
                      {t('nav.admin')}
                    </NavDropdown.Item>
                  </>
                )}
                <NavDropdown.Divider />
                <NavDropdown.Item onClick={handleLogout} className="d-flex align-items-center gap-2 text-danger">
                  <LogOut size={16} />
                  {t('common.logout')}
                </NavDropdown.Item>
              </NavDropdown>
            ) : (
              <Nav.Link as={Link} to="/login">Login</Nav.Link>
            )}
          </Nav>
        </Navbar.Collapse>
      </Container>
    </Navbar>
  );
};

export default Navigation;
