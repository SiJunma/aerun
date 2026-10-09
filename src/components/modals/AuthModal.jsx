import React, { useState, useEffect, useRef } from 'react';
import { Modal, Button } from 'react-bootstrap';
import LoginForm from '../auth/LoginForm';
import RegisterForm from '../auth/RegisterForm';
import ForgotPasswordForm from '../auth/ForgotPasswordForm';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';

const AuthModal = ({ show, onHide, initialMode = 'login' }) => {
  const [mode, setMode] = useState(initialMode);
  const { t } = useI18n();
  const { settings, user } = useAuth();
  const onHideRef = useRef(onHide);

  // Track the latest onHide without mutating a ref during render (React forbids
  // this). The effect runs after every render, so onHideRef.current is always
  // up to date for the cleanup logic below.
  useEffect(() => {
    onHideRef.current = onHide;
  }, [onHide]);

  // Tracks whether THIS modal was open, so the sweep below fires only on its
  // own open -> closed transition and never touches another modal's backdrop.
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (show) {
      setTimeout(() => setMode(initialMode), 0);
    }
  }, [show, initialMode]);

  // Safety net: the forms call onSuccess -> onHide after login/register, but if
  // that callback is ever missed (an exception between authStore write and the
  // call, a stale closure, an interrupted render), the user is already signed in
  // while show is still true — the backdrop then blocks the whole forum, exactly
  // the stuck state from the bug report. A signed-in user never needs this
  // guest-only modal, so close it as soon as the session appears.
  useEffect(() => {
    if (show && user) {
      onHideRef.current?.();
    }
  }, [show, user]);

  // Cleanup for an interrupted exit transition: react-bootstrap removes
  // body.modal-open and the .modal-backdrop node onExited; if the transition is
  // cut off (parent remount during the auth state storm), those leftovers keep
  // blocking clicks even with show === false. Sweep them on this modal's own
  // open -> closed transition only — never while another modal is open.
  useEffect(() => {
    if (show) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    // Another modal took over (e.g. a confirm dialog): its backdrop and body
    // lock are legitimate, leave them alone.
    if (document.querySelector('.modal.show')) return;
    document.body.classList.remove('modal-open');
    document.body.removeAttribute('data-rr-ui-modal-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  }, [show]);

  return (
    <Modal 
      show={show} 
      onHide={onHide} 
      centered 
      size="md"
      contentClassName="shadow-lg rounded-4 overflow-hidden bg-card"
    >
      <Modal.Header closeButton className="border-0 pb-0">
      </Modal.Header>
      <Modal.Body className="px-4 pb-4 pt-0">
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
      </Modal.Body>
    </Modal>
  );
};

export default AuthModal;
