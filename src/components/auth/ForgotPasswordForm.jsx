import React, { useState } from 'react';
import { Button, Form, Spinner, Alert } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';

const ForgotPasswordForm = ({ onSuccess, onBackToLogin }) => {
  const { resetPassword } = useAuth();
  const { t } = useI18n();

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleReset = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;

    try {
      setLoading(true);
      setError('');
      setSuccess('');
      await resetPassword(email.trim());
      setSuccess(t('auth.reset_link_sent'));
      if (onSuccess) setTimeout(onSuccess, 3000);
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/user-not-found') {
        setError(t('auth.user_not_found'));
      } else if (err.code === 'auth/invalid-email') {
        setError(t('auth.invalid_email'));
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="text-center">
      <h2 className="mb-4">
        {t('auth.forgot_password_title')}
      </h2>
      <p className="text-muted mb-4 px-2">
        {t('auth.forgot_password_desc')}
      </p>

      {error && (
        <Alert variant="danger" className="py-2 small mb-4 fw-bold">
          {error}
        </Alert>
      )}
      
      {success && (
        <Alert variant="success" className="py-2 small mb-4 fw-bold">
          {success}
        </Alert>
      )}

      <Form onSubmit={handleReset}>
        <Form.Group className="mb-4 text-start">
          <Form.Label className="fw-bold">{t('common.email')}</Form.Label>
          <Form.Control
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading || success}
          />
        </Form.Group>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={loading || success || !email.trim()}
          className="w-100 mb-3 fw-bold"
        >
          {loading ? <Spinner size="sm" animation="border" /> : t('auth.send_reset_link')}
        </Button>
      </Form>

      {onBackToLogin && (
        <div className="mt-3">
          <Button variant="link" className="text-muted text-decoration-none small" onClick={onBackToLogin}>
            &larr; {t('common.back_to_main')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default ForgotPasswordForm;
