import React from 'react';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { Container, Button, Card } from 'react-bootstrap';

const LoginPage = () => {
  const { user, loginWithGoogle } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  if (user) {
    return <Navigate to={from} replace />;
  }

  const handleLogin = async () => {
    try {
      sessionStorage.removeItem('pending_nickname');
      await loginWithGoogle();
    } catch (error) {
      console.error(t('auth.login_failed'), error);
    }
  };

  return (
    <Container className="d-flex align-items-center justify-content-center vh-100">
      <Card style={{ maxWidth: '400px', width: '100%' }} className="p-4 shadow">
        <Card.Body className="text-center">
          <h1 className="mb-4">{t('auth.login_title')}</h1>
          <p className="text-muted mb-4">{t('auth.login_subtitle')}</p>

          <Button
            variant="outline-primary"
            size="lg"
            onClick={handleLogin}
            className="d-flex align-items-center justify-content-center w-100 gap-2 mb-3"
          >
            <img
              src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
              alt="Google"
              style={{ width: '20px' }}
            />
            {t('auth.sign_in_google')}
          </Button>

          <div className="mt-4 text-center small">
            <span className="text-muted">{t('auth.dont_have_account')}</span>
            <Link to="/register" className="text-decoration-none fw-bold">{t('auth.register_link')}</Link>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default LoginPage;
