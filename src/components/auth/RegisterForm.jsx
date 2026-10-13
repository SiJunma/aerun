import React, { useState } from 'react';
import { Button, Form, Spinner, Alert } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { describeAuthError } from '../../utils/auth-errors';
import { checkNicknameExists } from '../../api/forum';
import { getGlobalSettings } from '../../api/admin';

const RegisterForm = ({ onSuccess }) => {
  const { loginWithGoogle, registerWithEmail, settings } = useAuth();
  const { t, lang } = useI18n();
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [nicknameError, setNicknameError] = useState('');
  const [adminMessage, setAdminMessage] = useState('');
  const [adminNickname, setAdminNickname] = useState('');
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [authError, setAuthError] = useState(null);
  
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [loadingGoogle, setLoadingGoogle] = useState(false);

  React.useEffect(() => {
    const error = sessionStorage.getItem('auth_error');
    if (error === 'nickname_taken_at_registration') {
      setAuthError(t('auth.error_nickname_taken_at_registration'));
      sessionStorage.removeItem('auth_error');
    }
  }, [t]);

  React.useEffect(() => {
    getGlobalSettings(data => {
      if (data) {
        if (data.adminNickname) setAdminNickname(data.adminNickname);
        if (data.registrationEnabled === false) setRegistrationEnabled(false);
      }
    });
  }, []);

  const prepareSession = async () => {
    if (nickname.trim()) {
      setNicknameError('');
      const isTaken = await checkNicknameExists(nickname.trim());
      if (isTaken) {
        setNicknameError(t('auth.error_nickname_taken'));
        return false;
      }
      sessionStorage.setItem('pending_nickname', nickname.trim());
    } else {
      sessionStorage.removeItem('pending_nickname');
    }

    sessionStorage.setItem('is_registering', 'true');
    // Snapshot the guest-side theme/language BEFORE the OAuth redirect, so a
    // brand-new Google account can be seeded once on return (same contract as
    // the email path above). Only read here — never written back elsewhere.
    try {
      const guestTheme = localStorage.getItem('guest_theme') || '';
      const guestLang = lang || localStorage.getItem('language') || '';
      if (guestTheme) sessionStorage.setItem('pending_theme', guestTheme);
      else sessionStorage.removeItem('pending_theme');
      if (guestLang) sessionStorage.setItem('pending_language', guestLang);
      else sessionStorage.removeItem('pending_language');
    } catch {
      // Storage may be unavailable (private mode) — seeding is best-effort,
      // the live fallbacks keep rendering either way.
    }
    if (lang) {
      sessionStorage.setItem('language', lang);
      localStorage.setItem('language', lang);
      sessionStorage.setItem('preferred_language', lang);
      localStorage.setItem('preferred_language', lang);
    }
    
    if (adminMessage.trim()) {
      sessionStorage.setItem('pending_message', adminMessage.trim());
    } else {
      sessionStorage.removeItem('pending_message');
    }
    return true;
  };

  const handleGoogleRegister = async () => {
    try {
      setLoadingGoogle(true);
      setAuthError(null);
      const isOk = await prepareSession();
      if (!isOk) {
        setLoadingGoogle(false);
        return;
      }
      await loginWithGoogle();
      setLoadingGoogle(false);
      if (onSuccess) onSuccess();
    } catch (error) {
      setLoadingGoogle(false);
      console.error(t('auth.login_failed'), error);
      setAuthError(describeAuthError(error, t) || error.message);
    }
  };

  const handleEmailRegister = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    if (password.length < 6) {
      setAuthError(t('auth.password_too_weak'));
      return;
    }

    try {
      setLoadingEmail(true);
      setAuthError(null);
      setNicknameError('');

      const isOk = await prepareSession();
      if (!isOk) {
        setLoadingEmail(false);
        return;
      }

      await registerWithEmail(email.trim(), password, nickname.trim(), adminMessage.trim(), {
        // Seed the fresh account with what the forum shows right now, so the
        // first profile save never rewrites theme/language from a default.
        theme: localStorage.getItem('guest_theme') || '',
        language: lang || localStorage.getItem('language') || ''
      });
      // Reset before closing: if the exit transition is ever interrupted and the
      // modal remounts, it must not reopen with a stuck spinner.
      setLoadingEmail(false);
      if (onSuccess) onSuccess();
    } catch (error) {
      setLoadingEmail(false);
      console.error(t('auth.login_failed'), error);
      const msg = error?.message || '';
      if (msg.includes('email') || error?.code === 'validation_not_unique') {
        setAuthError(t('auth.email_already_in_use'));
      } else if (msg.includes('nickname')) {
        setNicknameError(msg);
      } else {
        setAuthError(msg || 'Registration failed');
      }
    }
  };

  const adminMessageLabel = adminNickname
    ? t('auth.admin_message_to').replace('{name}', adminNickname)
    : t('auth.admin_message');

  if (!registrationEnabled) {
    return (
      <div className="text-center py-4">
        <h2 className="mb-4 text-danger">{t('auth.registration_disabled_title')}</h2>
        <p className="mb-4">{t('auth.registration_disabled_message')}</p>
      </div>
    );
  }

  const forumName = (typeof settings?.forumName === 'object' && settings.forumName !== null)
    ? (settings.forumName[lang] || settings.forumName.en || 'Aerun Forum')
    : (settings?.forumName || 'Aerun Forum');

  return (
    <div className="text-center">
      <h2 className="mb-4">
        {(typeof settings?.forumName === 'object' && settings.forumName !== null)
          ? (settings.forumName[lang] || settings.forumName.en || t('auth.register_title'))
          : (settings?.forumName || t('auth.register_title'))}
      </h2>
      <p className="text-muted mb-4">{t('auth.register_subtitle', { name: forumName })}</p>

      {authError && (
        <Alert variant="danger" className="py-2 small mb-4 fw-bold text-center">
          {authError}
        </Alert>
      )}

      <Form onSubmit={handleEmailRegister} className="text-start">
        <Form.Group className="mb-3">
          <Form.Label className="fw-bold fs-7">{t('common.email')} *</Form.Label>
          <Form.Control
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loadingEmail || loadingGoogle}
            required
            className="shadow-none"
          />
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label className="fw-bold fs-7 mb-0">{t('auth.password')} *</Form.Label>
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

        <Form.Group className="mb-3 mt-4 text-start">
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
            disabled={loadingEmail || loadingGoogle}
            className="shadow-none"
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

        <Form.Group className="mb-4 text-start">
          <Form.Label className="fw-bold">{adminMessageLabel}</Form.Label>
          <Form.Control
            as="textarea"
            rows={2}
            placeholder={t('auth.admin_message_placeholder')}
            value={adminMessage}
            onChange={(e) => setAdminMessage(e.target.value)}
            maxLength={500}
            disabled={loadingEmail || loadingGoogle}
            className="shadow-none"
          />
          <Form.Text className="text-muted small">
            {t('auth.admin_message_help')}
          </Form.Text>
        </Form.Group>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={loadingEmail || loadingGoogle || !email.trim() || !password.trim()}
          className="w-100 mb-4 fw-bold shadow-sm"
        >
          {loadingEmail ? <Spinner size="sm" animation="border" /> : t('auth.sign_up_email')}
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
        onClick={handleGoogleRegister}
        disabled={loadingEmail || loadingGoogle}
        className="d-flex align-items-center justify-content-center w-100 gap-2 mb-3 bg-transparent border-2 border-secondary"
        style={{ color: 'var(--text-color)' }}
      >
        {loadingGoogle ? (
          <Spinner as="span" animation="border" size="sm" role="status" aria-hidden="true" />
        ) : (
          <>
            <img
              src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
              alt="Google"
              style={{ width: '22px' }}
            />
            <span className="fw-bold">{t('auth.sign_up_google')}</span>
          </>
        )}
      </Button>
    </div>
  );
};

export default RegisterForm;
