import React from 'react';
import { Button } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';

const LoginForm = ({ onSuccess }) => {
  const { loginWithGoogle, settings } = useAuth();
  const { t, lang } = useI18n();
  const [authError, setAuthError] = React.useState(null);

  React.useEffect(() => {
    const error = sessionStorage.getItem('auth_error');
    if (error === 'registration_disabled') {
      setAuthError(t('auth.error_registration_disabled'));
    } else if (error === 'need_registration') {
      setAuthError(t('auth.error_registration_needed'));
    } else if (error === 'nickname_taken_at_registration') {
      setAuthError(t('auth.error_nickname_taken_at_registration'));
    }

    if (error) {
      sessionStorage.removeItem('auth_error');
    }
  }, [t]);

  const handleLogin = async () => {
    try {
      setAuthError(null);
      sessionStorage.removeItem('pending_nickname');
      await loginWithGoogle();
      if (onSuccess) onSuccess();
    } catch (error) {
      console.error(t('auth.login_failed'), error);
    }
  };

  return (
    <div className="text-center">
      <h2 className="mb-4">
        {(typeof settings?.forumName === 'object' && settings.forumName !== null)
          ? (settings.forumName[lang] || settings.forumName.en || t('auth.login_title'))
          : (settings?.forumName || t('auth.login_title'))}
      </h2>
      <p className="text-muted mb-4">
        {settings?.whitelistMode === false 
          ? t('auth.login_subtitle_public') 
          : t('auth.login_subtitle')}
      </p>

      {authError && (
        <div className="alert alert-warning py-2 small mb-4 fw-bold">
          {authError}
        </div>
      )}

      <Button
        variant="outline-primary"
        size="lg"
        onClick={handleLogin}
        className="d-flex align-items-center justify-content-center w-100 gap-2 mb-3 px-4 py-3"
      >
        <img
          src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
          alt="Google"
          style={{ width: '24px' }}
        />
        <span className="fw-bold">{t('auth.sign_in_google')}</span>
      </Button>
    </div>
  );
};

export default LoginForm;
