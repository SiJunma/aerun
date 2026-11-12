import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner } from 'react-bootstrap';
import { CheckCircle2, Lock, ArrowRight } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { usePageTitle } from '../contexts/TitleProvider';
import { confirmPasswordReset } from '../api/account-credentials';

const ConfirmPasswordResetPage = () => {
  const { token } = useParams();
  const { t } = useI18n();
  const { setPageTitle } = usePageTitle();

  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setPageTitle(t('forum.reset_password'));
  }, [setPageTitle, lang]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password || !passwordConfirm) {
      setError(t('forum.fill_both_fields'));
      return;
    }
    if (password !== passwordConfirm) {
      setError(t('forum.passwords_not_match'));
      return;
    }
    if (password.length < 8) {
      setError(t('forum.password_min_length'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await confirmPasswordReset({ token, password, passwordConfirm });
      setSuccess(true);
    } catch (err) {
      setError(err?.message || t('forum.reset_failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container className="d-flex align-items-center justify-content-center min-vh-100 py-5">
      <Card className="shadow-sm border-0" style={{ maxWidth: '440px', width: '100%' }}>
        <Card.Body className="p-4">
          <div className="text-center mb-4">
            <Link to="/" className="text-decoration-none fw-bold fs-4 text-dark">
              Aerun
            </Link>
          </div>

          {success ? (
            <div className="text-center py-2">
              <div className="text-success mb-3">
                <CheckCircle2 size={54} className="mx-auto" />
              </div>
              <h4 className="fw-bold mb-2">
                {t('forum.password_reset_success')}
              </h4>
              <p className="text-muted mb-4">
                {t('forum.sign_in_now')}
              </p>
              <Button as={Link} to="/login" variant="primary" className="w-100 d-flex align-items-center justify-content-center gap-2">
                <span>{t('forum.sign_in')}</span>
                <ArrowRight size={18} />
              </Button>
            </div>
          ) : (
            <>
              <div className="text-center mb-4">
                <div className="d-inline-flex p-3 rounded-circle bg-light text-primary mb-2">
                  <Lock size={28} />
                </div>
                <h4 className="fw-bold mb-1">
                  {t('forum.set_new_password')}
                </h4>
                <p className="text-muted small mb-0">
                  {t('forum.password_at_least_8')}
                </p>
              </div>

              {error && (
                <Alert variant="danger" className="py-2 small mb-3">
                  {error}
                </Alert>
              )}

              <Form onSubmit={handleSubmit}>
                <Form.Group className="mb-3">
                  <Form.Label className="small fw-semibold">
                    {t('forum.new_password')}
                  </Form.Label>
                  <Form.Control
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={submitting}
                  />
                </Form.Group>

                <Form.Group className="mb-4">
                  <Form.Label className="small fw-semibold">
                    {t('forum.confirm_password')}
                  </Form.Label>
                  <Form.Control
                    type="password"
                    placeholder="••••••••"
                    value={passwordConfirm}
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                    required
                    disabled={submitting}
                  />
                </Form.Group>

                <Button
                  type="submit"
                  variant="primary"
                  className="w-100 py-2 d-flex align-items-center justify-content-center gap-2"
                  disabled={submitting}
                >
                  {submitting ? (
                    <>
                      <Spinner size="sm" animation="border" />
                      <span>{t('forum.saving')}</span>
                    </>
                  ) : (
                    <span>{t('forum.save_password')}</span>
                  )}
                </Button>
              </Form>

              <div className="text-center mt-3">
                <Link to="/login" className="text-decoration-none small text-muted">
                  {t('forum.back_to_login')}
                </Link>
              </div>
            </>
          )}
        </Card.Body>
      </Card>
    </Container>
  );
};

export default ConfirmPasswordResetPage;

