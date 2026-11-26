import React, { useState } from 'react';
import { Button, Form, Spinner, Alert } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { describeAuthError } from '../../utils/auth-errors';
import { resolveField } from '../../utils/text';
import { makeStorageKey } from '../../utils/storageScope';

const LoginForm = ({ onSuccess, onForgotPassword }) => {
  const { loginWithGoogle, loginWithEmail, settings } = useAuth();
  const { t, lang } = useI18n();
  const [authError, setAuthError] = useState(null);
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [loadingGoogle, setLoadingGoogle] = useState(false);

  React.useEffect(() => {
    const error = sessionStorage.getItem(makeStorageKey('auth_error', 'guest'));
    if (error === 'registration_disabled') {
      setAuthError(t('auth.error_registration_disabled'));
    } else if (error === 'need_registration') {
      setAuthError(t('auth.error_registration_needed'));
    } else if (error === 'nickname_taken_at_registration') {
      setAuthError(t('auth.error_nickname_taken_at_registration'));
    }

    if (error) {
      sessionStorage.removeItem(makeStorageKey('auth_error', 'guest'));
    }
  }, [t]);

  const handleGoogleLogin = async () => {
    try {
      setLoadingGoogle(true);
      setAuthError(null);
      sessionStorage.removeItem(makeStorageKey('pending_nickname', 'guest'));
      await loginWithGoogle();
      setLoadingGoogle(false);
      if (onSuccess) onSuccess();
    } catch (error) {
      setLoadingGoogle(false);
      console.error(t('auth.login_failed'), error);
      if (error.code === 'auth/account-exists-with-different-credential') {
        setAuthError(t('auth.link_account_password'));
      } else {
        setAuthError(describeAuthError(error, t) || error.message);
      }
    }
  };

  const handleEmailLogin = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    try {
      setLoadingEmail(true);
      setAuthError(null);
      sessionStorage.removeItem(makeStorageKey('pending_nickname', 'guest'));
      await loginWithEmail(email.trim(), password);
      setLoadingEmail(false);
      if (onSuccess) onSuccess();
    } catch (error) {
      setLoadingEmail(false);
      console.error(t('auth.login_failed'), error);
      if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        setAuthError(t('auth.wrong_password')); // use a generic wrong password or user not found
      } else {
        setAuthError(describeAuthError(error, t) || error.message);
      }
    }
  };

  return (
    <div className="text-center">
      <h2 className="mb-4">
        {resolveField(settings?.forumName, lang) || t('auth.login_title')}
      </h2>
      <p className="text-muted mb-4">
        {settings?.whitelistMode === false
          ? t('auth.login_subtitle_public')
          : settings?.maintenanceMode
            ? t('auth.login_subtitle_maintenance')
            : t('auth.login_subtitle_closed')}
      </p>

      {authError && (
        <Alert variant="warning" className="py-2 small mb-4 fw-bold">
          {authError}
        </Alert>
      )}

      <Form onSubmit={handleEmailLogin} className="mb-4 text-start">
        <Form.Group className="mb-3">
          <Form.Label className="fw-bold fs-7">{t('common.email')}</Form.Label>
          <Form.Control
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loadingEmail || loadingGoogle}
            required
            className="shadow-none"
          />
        </Form.Group>

        <Form.Group className="mb-4">
          <div className="d-flex justify-content-between align-items-center mb-1">
             <Form.Label className="fw-bold fs-7 mb-0">{t('auth.password')}</Form.Label>
             {onForgotPassword && (
               <Button variant="link" className="p-0 text-decoration-none small fs-7" onClick={onForgotPassword}>
                 {t('auth.forgot_password')}
               </Button>
             )}
          </div>
          <Form.Control
            type="password"
            placeholder={t('auth.password_placeholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loadingEmail || loadingGoogle}
            required
            className="shadow-none"
          />
        </Form.Group>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={loadingEmail || loadingGoogle || !email.trim() || !password.trim()}
          className="w-100 fw-bold shadow-sm"
        >
          {loadingEmail ? <Spinner size="sm" animation="border" /> : t('auth.sign_in_email')}
        </Button>
      </Form>

      <div className="d-flex align-items-center mb-4">
        <div className="flex-grow-1 border-top"></div>
        <div className="px-3 text-muted small fw-bold text-uppercase">{t('auth.or_continue_with')}</div>
        <div className="flex-grow-1 border-top"></div>
      </div>

      <Button
        variant="outline-secondary"
        size="lg"
        onClick={handleGoogleLogin}
        disabled={loadingEmail || loadingGoogle}
        className="d-flex align-items-center justify-content-center w-100 gap-2 px-4 py-2 border border-2 border-secondary bg-transparent"
        style={{ color: 'var(--text-color)' }}
      >
        {loadingGoogle ? <Spinner size="sm" animation="border" /> : (
          <>
            <img
              src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
              alt="Google"
              style={{ width: '22px' }}
            />
            <span className="fw-bold">{t('auth.sign_in_google')}</span>
          </>
        )}
      </Button>
    </div>
  );
};

export default LoginForm;
