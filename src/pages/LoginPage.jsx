import React from 'react';
import { useAuth } from '../contexts/AuthProvider';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { Container, Card } from 'react-bootstrap';
import LoginForm from '../components/auth/LoginForm';
import { useI18n } from '../contexts/I18nProvider';

const LoginPage = () => {
  const { user, profile, loading, settings, hasPermission, PERMISSIONS } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  if (user) {
    if (!profile) return null; // Wait for profile to load before redirecting

    // If banned, don't redirect anywhere - AuthProvider will handle the forced logout shortly.
    // This avoids a jarring jump to /banned before being kicked back to /
    if (profile.status === 'banned') return null;
    
    // Default redirect for other logged-in users
    const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);
    const target = (isAdmin && (from === '/maintenance' || from === '/pending' || from === '/banned')) ? '/' : from;
    return <Navigate to={target} replace />;
  }

  // If whitelist mode is OFF, guests shouldn't see the separate login page.
  // They are redirected to the Home page where they can use the AuthModal popup.
  if (settings?.whitelistMode === false) {
    return <Navigate to="/" replace />;
  }

  // If whitelist mode is OFF, guests should be redirected to the home page
  // (They can use the AuthModal in the Navbar if they want to log in)
  if (!user && settings && !settings.whitelistMode) {
    return <Navigate to="/" replace />;
  }


  return (
    <Container className="d-flex align-items-center justify-content-center vh-100">
      <Card style={{ maxWidth: '400px', width: '100%' }} className="p-4 shadow border-0 rounded-4">
        <Card.Body>
          <LoginForm />
          {settings?.registrationEnabled !== false && (
            <div className="mt-4 text-center small border-top pt-3">
              <span className="text-muted">{t('auth.dont_have_account')}</span>
              <Link to="/register" className="ms-1 fw-bold text-decoration-none text-primary">
                {t('auth.register_link')}
              </Link>
            </div>
          )}
        </Card.Body>
      </Card>
    </Container>
  );
};

export default LoginPage;
