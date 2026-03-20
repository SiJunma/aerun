import React from 'react';
import { useAuth } from '../contexts/AuthProvider';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { Container, Card } from 'react-bootstrap';
import RegisterForm from '../components/auth/RegisterForm';
import { useI18n } from '../contexts/I18nProvider';

const RegisterPage = () => {
  const { user, settings, hasPermission, PERMISSIONS } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';
  
  if (user) {
    // If admin logs in/registers, don't send them back to the maintenance/pending page
    const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);
    const target = (isAdmin && (from === '/maintenance' || from === '/pending' || from === '/banned')) ? '/' : from;
    return <Navigate to={target} replace />;
  }

  // If whitelist mode is ON, guests shouldn't be here (too restrictive)
  // If whitelist mode is OFF, guests should be redirected to the home page 
  // (They can use the AuthModal in the Navbar if they want to register)
  // If registration is explicitly disabled, always redirect to home
  if (!user && settings && (!settings.whitelistMode || settings.whitelistMode === true || settings.registrationEnabled === false)) {
    return <Navigate to="/" replace />;
  }

  // If whitelist mode is OFF, guests shouldn't see the separate register page.
  // They are redirected to the Home page where they can use the AuthModal popup.
  if (settings?.whitelistMode === false) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container className="d-flex align-items-center justify-content-center vh-100">
      <Card style={{ maxWidth: '440px', width: '100%' }} className="p-4 shadow border-0 rounded-4">
        <Card.Body>
          <RegisterForm />
          <div className="mt-4 text-center small border-top pt-3">
            <span className="text-muted">{t('auth.already_have_account')}</span>
            <Link to="/login" className="ms-1 fw-bold text-decoration-none text-primary">
              {t('auth.login_link')}
            </Link>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default RegisterPage;
