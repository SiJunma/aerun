import React, { useState, useEffect, useRef } from 'react';
import { Button } from 'react-bootstrap';
import LoginForm from '../auth/LoginForm';
import RegisterForm from '../auth/RegisterForm';
import ForgotPasswordForm from '../auth/ForgotPasswordForm';
import ForumModal from '../common/ForumModal';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';

const AuthModal = ({ show, onHide, initialMode = 'login' }) => {
  const [mode, setMode] = useState(initialMode);
  const { t } = useI18n();
  const { settings, user } = useAuth();
  const onHideRef = useRef(onHide);

  // Track the latest onHide without mutating a ref during render (React forbids
  // this). The effect runs after every render, so onHideRef.current is always
  // up to date for the safety net below.
  useEffect(() => {
    onHideRef.current = onHide;
  }, [onHide]);

  useEffect(() => {
    if (show) {
      setTimeout(() => setMode(initialMode), 0);
    }
  }, [show, initialMode]);

  // Safety net: the forms call onSuccess -> onHide after login/register, but if
  // that callback is ever missed (an exception between authStore write and the
  // call, a stale closure, an interrupted render), the user is already signed in
  // while show is still true — the modal would keep covering the forum. A
  // signed-in user never needs this guest-only modal, so close it as soon as
  // the session appears.
  //
  // Closing itself is synchronous because the modal renders through ForumModal
  // (if (!show) return null): there is no exit transition left for the auth
  // state storm to interrupt. The per-modal sweep for stuck exit-transition
  // leftovers that used to live here is obsolete — removed with the migration.
  useEffect(() => {
    if (show && user) {
      onHideRef.current?.();
    }
  }, [show, user]);

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      size="md"
      showHeader
      headerClassName="border-0"
      bodyClassName="px-4 pb-4 pt-0"
      contentClassName="shadow-lg rounded-4 overflow-hidden bg-card"
    >
      {mode === 'login' ? (
          <>
            <LoginForm onSuccess={onHide} onForgotPassword={() => setMode('forgot_password')} />
            {settings?.registrationEnabled !== false && (
              <div className="mt-4 text-center small border-top pt-3">
                <span className="text-muted">{t('auth.dont_have_account')}</span>
                <Button 
                  variant="link" 
                  className="p-0 mb-1 fw-bold text-decoration-none text-primary" 
                  onClick={() => setMode('register')}
                >
                  {t('auth.register_link')}
                </Button>
              </div>
            )}
          </>
        ) : mode === 'forgot_password' ? (
          <ForgotPasswordForm onSuccess={onHide} onBackToLogin={() => setMode('login')} />
        ) : (
          <>
            <RegisterForm onSuccess={onHide} />
            <div className="mt-4 text-center small border-top pt-3">
              <span className="text-muted">{t('auth.already_have_account')}</span>
              <Button 
                variant="link" 
                className="p-0 mb-1 fw-bold text-decoration-none text-primary" 
                onClick={() => setMode('login')}
              >
                {t('auth.login_link')}
              </Button>
            </div>
          </>
        )}
    </ForumModal>
  );
};

export default AuthModal;
