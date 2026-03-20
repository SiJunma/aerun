import React from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { checkNicknameExists } from '../../api/forum';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../../firebase';

const RegisterForm = ({ onSuccess }) => {
  const { loginWithGoogle, settings } = useAuth();
  const { t, lang } = useI18n();
  
  const [nickname, setNickname] = React.useState('');
  const [nicknameError, setNicknameError] = React.useState('');
  const [checkingNickname, setCheckingNickname] = React.useState(false);
  const [adminMessage, setAdminMessage] = React.useState('');
  const [adminNickname, setAdminNickname] = React.useState('');
  const [registrationEnabled, setRegistrationEnabled] = React.useState(true);
  const [authError, setAuthError] = React.useState(null);

  React.useEffect(() => {
    const error = sessionStorage.getItem('auth_error');
    if (error === 'nickname_taken_at_registration') {
      setAuthError(t('auth.error_nickname_taken_at_registration'));
      sessionStorage.removeItem('auth_error');
    }
  }, [t]);

  // Fetch global settings from the publicly readable settings doc
  React.useEffect(() => {
    getDoc(doc(db, 'settings', 'global'))
      .then(snap => {
        if (snap.exists()) {
          const data = snap.data();
          if (data.adminNickname) setAdminNickname(data.adminNickname);
          if (data.registrationEnabled === false) setRegistrationEnabled(false);
        }
      })
      .catch(() => { /* silently fail */ });
  }, []);

  const handleRegister = async () => {
    try {
      if (nickname.trim()) {
        setCheckingNickname(true);
        setNicknameError('');
        const isTaken = await checkNicknameExists(nickname.trim());
        setCheckingNickname(false);

        if (isTaken) {
          setNicknameError(t('auth.error_nickname_taken'));
          return;
        }
        sessionStorage.setItem('pending_nickname', nickname.trim());
      } else {
        sessionStorage.removeItem('pending_nickname');
      }

      sessionStorage.setItem('is_registering', 'true');
      
      if (adminMessage.trim()) {
        sessionStorage.setItem('pending_message', adminMessage.trim());
      } else {
        sessionStorage.removeItem('pending_message');
      }

      await loginWithGoogle();
      if (onSuccess) onSuccess();
    } catch (error) {
      setCheckingNickname(false);
      console.error(t('auth.login_failed'), error);
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
        <div className="alert alert-danger py-2 small mb-4 fw-bold text-center">
          {authError}
        </div>
      )}

      <Form.Group className="mb-3 text-start">
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

      <Form.Group className="mb-4 text-start">
        <Form.Label className="fw-bold">{adminMessageLabel}</Form.Label>
        <Form.Control
          as="textarea"
          rows={3}
          placeholder={t('auth.admin_message_placeholder')}
          value={adminMessage}
          onChange={(e) => setAdminMessage(e.target.value)}
          maxLength={500}
          disabled={checkingNickname}
        />
        <Form.Text className="text-muted small">
          {t('auth.admin_message_help')}
        </Form.Text>
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
        <span className="fw-bold">
          {checkingNickname ? t('common.loading') : t('auth.sign_up_google')}
        </span>
      </Button>
    </div>
  );
};

export default RegisterForm;
