import React, { useState } from 'react';
import { Card, Button, Form, Spinner, Alert, ListGroup, Badge } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { pb } from '../../api/pocketbase';
import { Key, Mail, ShieldAlert } from 'lucide-react';

const SecurityTab = () => {
  const { user } = useAuth();
  const { t } = useI18n();

  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [loadingPassword, setLoadingPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  if (!user) return null;

  const hasGoogle = false;
  const hasPassword = true;

  const handleLinkGoogle = async () => {
    try {
      setLoadingGoogle(true);
      setError(null);
      setSuccess(null);
      await pb.collection('users').authWithOAuth2({ provider: 'google' });
      setSuccess(t('profile.auth_google_linked'));
    } catch (err) {
      console.error(err);
      setError(err.message || 'Failed to link Google account');
    } finally {
      setLoadingGoogle(false);
    }
  };

  const handleLinkPassword = async (e) => {
    e.preventDefault();
    if (!passwordInput.trim()) return;
    if (passwordInput.length < 6) {
      setError(t('auth.password_too_weak'));
      return;
    }

    try {
      setLoadingPassword(true);
      setError(null);
      setSuccess(null);
      const uid = user.id || user.uid;
      await pb.collection('users').update(uid, {
        password: passwordInput,
        passwordConfirm: passwordInput
      });
      setSuccess(t('profile.auth_password_updated'));
      setPasswordInput('');
    } catch (err) {
      console.error(err);
      setError(err.message || 'Failed to update password');
    } finally {
      setLoadingPassword(false);
    }
  };

  return (
    <Card className="shadow-sm border-0 bg-card">
      <Card.Header className="py-3">
        <h5 className="mb-0">{t('profile.auth_providers')}</h5>
      </Card.Header>
      <Card.Body className="p-4">
        {error && (
          <Alert variant="danger" className="py-2 small fw-bold mb-4">
            {error}
          </Alert>
        )}
        {success && (
          <Alert variant="success" className="py-2 small fw-bold mb-4">
            {success}
          </Alert>
        )}

        <ListGroup variant="flush" className="mb-4 bg-transparent">
          {/* Google Provider Status */}
          <ListGroup.Item className="bg-transparent border-bottom d-flex justify-content-between align-items-center py-3 px-0">
            <div className="d-flex align-items-center gap-3">
              <div className="rounded-circle bg-light d-flex align-items-center justify-content-center" style={{ width: '40px', height: '40px' }}>
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style={{ width: '20px' }} />
              </div>
              <div>
                <div className="fw-bold">{t('profile.auth_provider_google')}</div>
                <div className="small text-muted">
                  {hasGoogle ? user.email : t('profile.auth_not_linked')}
                </div>
              </div>
            </div>
            <div>
              {hasGoogle ? (
                <Badge bg="success" className="px-3 py-2 opacity-75">{t('profile.auth_linked')}</Badge>
              ) : (
                <Button 
                  variant="outline-primary" 
                  size="sm" 
                  onClick={handleLinkGoogle}
                  disabled={loadingGoogle}
                >
                  {loadingGoogle ? <Spinner size="sm" animation="border" /> : t('profile.auth_add_google')}
                </Button>
              )}
            </div>
          </ListGroup.Item>

          {/* Password Provider Status */}
          <ListGroup.Item className="bg-transparent d-flex justify-content-between align-items-center py-3 px-0 border-bottom">
            <div className="d-flex align-items-center gap-3">
              <div className="rounded-circle bg-light d-flex align-items-center justify-content-center text-dark" style={{ width: '40px', height: '40px' }}>
                <Key size={18} />
              </div>
              <div>
                <div className="fw-bold">{t('profile.auth_provider_password')}</div>
                <div className="small text-muted">
                  {hasPassword ? t('profile.auth_linked') : t('profile.auth_not_linked')}
                </div>
              </div>
            </div>
            <div>
              {hasPassword ? (
                <Badge bg="success" className="px-3 py-2 opacity-75">{t('profile.auth_linked')}</Badge>
              ) : null}
            </div>
          </ListGroup.Item>
        </ListGroup>

        <div className="p-3 modal-section-themed rounded mt-2">
          <h6 className="fw-bold mb-2 d-flex align-items-center gap-2">
            <ShieldAlert size={16} className="text-warning" />
            {t('profile.auth_add_password')}
          </h6>
          <p className="small text-muted mb-3 opacity-75">
            {t('profile.auth_password_set_desc')}
          </p>
          <Form onSubmit={handleLinkPassword}>
            <Form.Group className="mb-3 d-flex gap-2">
              <Form.Control
                type="password"
                placeholder={t('auth.password_placeholder')}
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                disabled={loadingPassword}
                className="shadow-none flex-grow-1"
              />
              <Button 
                type="submit" 
                variant="primary" 
                disabled={loadingPassword || !passwordInput.trim()}
                className="px-4 fw-bold"
              >
                {loadingPassword ? <Spinner size="sm" animation="border" /> : t('common.save')}
              </Button>
            </Form.Group>
          </Form>
        </div>

      </Card.Body>
    </Card>
  );
};

export default SecurityTab;
