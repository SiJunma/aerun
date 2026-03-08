import React from 'react';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { Container, Button, Card, Form, Spinner } from 'react-bootstrap';
import { checkNicknameExists } from '../api/forum';

const RegisterPage = () => {
  const [nickname, setNickname] = React.useState('');
  const [nicknameError, setNicknameError] = React.useState('');
  const [checkingNickname, setCheckingNickname] = React.useState(false);
  const { user, loginWithGoogle } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  if (user) {
    return <Navigate to={from} replace />;
  }

  const handleRegister = async () => {
    try {
      if (nickname.trim()) {
        setCheckingNickname(true);
        setNicknameError('');
        const isTaken = await checkNicknameExists(nickname.trim());
        setCheckingNickname(false);

        if (isTaken) {
          setNicknameError(t('auth.error_nickname_taken'));
          return; // Stop login process
        }
        sessionStorage.setItem('pending_nickname', nickname.trim());
      } else {
        sessionStorage.removeItem('pending_nickname');
      }
      await loginWithGoogle();
    } catch (error) {
      setCheckingNickname(false);
      console.error(t('auth.login_failed'), error);
    }
  };

  return (
    <Container className="d-flex align-items-center justify-content-center vh-100">
      <Card style={{ maxWidth: '400px', width: '100%' }} className="p-4 shadow">
        <Card.Body className="text-center">
          <h1 className="mb-4">{t('auth.register_title')}</h1>
          <p className="text-muted mb-4">{t('auth.register_subtitle')}</p>

          <Form.Group className="mb-4 text-start">
            <Form.Label className="fw-bold">{t('auth.optional_nickname')}</Form.Label>
            <Form.Control
              type="text"
              placeholder={t('auth.optional_nickname_placeholder')}
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value);
                setNicknameError('');
              }}
              maxLength={30}
              isInvalid={!!nicknameError}
              disabled={checkingNickname}
            />
            {nicknameError ? (
              <Form.Text className="text-danger small fw-bold">
                {nicknameError}
              </Form.Text>
            ) : (
              <Form.Text className="text-muted small">
                {t('auth.optional_nickname_help')}
              </Form.Text>
            )}
          </Form.Group>

          <Button
            variant="outline-primary"
            size="lg"
            onClick={handleRegister}
            disabled={checkingNickname}
            className="d-flex align-items-center justify-content-center w-100 gap-2 mb-3"
          >
            {checkingNickname ? (
              <Spinner as="span" animation="border" size="sm" role="status" aria-hidden="true" />
            ) : (
              <img
                src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
                alt="Google"
                style={{ width: '20px' }}
              />
            )}
            {checkingNickname ? t('common.loading') : t('auth.sign_up_google')}
          </Button>

          <div className="mt-4 text-center small">
            <span className="text-muted">{t('auth.already_have_account')}</span>
            <Link to="/login" className="text-decoration-none fw-bold">{t('auth.login_link')}</Link>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default RegisterPage;
