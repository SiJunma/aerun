import React, { useState, useEffect } from 'react';
import { Modal, Button } from 'react-bootstrap';
import LoginForm from '../auth/LoginForm';
import RegisterForm from '../auth/RegisterForm';
import ForgotPasswordForm from '../auth/ForgotPasswordForm';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';

const AuthModal = ({ show, onHide, initialMode = 'login' }) => {
  const [mode, setMode] = useState(initialMode);
  const { t } = useI18n();
  const { settings } = useAuth();

  useEffect(() => {
    if (show) {
      setTimeout(() => setMode(initialMode), 0);
    }
  }, [show, initialMode]);

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
