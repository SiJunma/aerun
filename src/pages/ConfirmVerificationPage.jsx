import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Container, Card, Button, Spinner, Alert } from 'react-bootstrap';
import { CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { usePageTitle } from '../contexts/TitleProvider';
import { confirmEmailVerification } from '../api/account-credentials';

const ConfirmVerificationPage = () => {
  const { token } = useParams();
  const { t } = useI18n();
  const { setPageTitle } = usePageTitle();

  const [loading, setLoading] = useState(Boolean(token));
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(() => (token ? null : t('forum.missing_token')));

  useEffect(() => {
    setPageTitle(t('forum.email_verification'));
  }, [setPageTitle, lang]);

  useEffect(() => {
    if (!token) return;
    let alive = true;

    confirmEmailVerification(token)
      .then(() => {
        if (!alive) return;
        setSuccess(true);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setSuccess(false);
        setError(err?.message || t('forum.invalid_link'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <Container className="d-flex align-items-center justify-content-center min-vh-100 py-5">
      <Card className="shadow-sm border-0" style={{ maxWidth: '480px', width: '100%' }}>
        <Card.Body className="p-4 text-center">
          <div className="mb-4">
            <Link to="/" className="text-decoration-none fw-bold fs-4 text-dark">
              Aerun
            </Link>
          </div>

          {loading && (
            <div className="py-4">
              <Spinner animation="border" variant="primary" className="mb-3" />
              <p className="text-muted">
                {t('forum.verifying_email')}
              </p>
            </div>
          )}

          {!loading && success && (
            <div className="py-2">
              <div className="text-success mb-3">
                <CheckCircle2 size={54} className="mx-auto" />
              </div>
              <h4 className="fw-bold mb-2">
                {t('forum.email_verified_success')}
              </h4>
              <p className="text-muted mb-4">
                {t('forum.email_verified_message')}
              </p>
              <Button as={Link} to="/login" variant="primary" className="w-100 d-flex align-items-center justify-content-center gap-2">
                <span>{t('forum.sign_in')}</span>
                <ArrowRight size={18} />
              </Button>
            </div>
          )}

          {!loading && error && (
            <div className="py-2">
              <div className="text-danger mb-3">
                <AlertTriangle size={54} className="mx-auto" />
              </div>
              <h4 className="fw-bold mb-2">
                {t('forum.verification_failed')}
              </h4>
              <Alert variant="danger" className="text-start py-2 small mb-4">
                {error}
              </Alert>
              <div className="d-flex flex-column gap-2">
                <Button as={Link} to="/login" variant="primary" className="w-100">
                  {t('forum.go_to_sign_in')}
                </Button>
                <Button as={Link} to="/" variant="outline-secondary" className="w-100">
                  {t('forum.back_to_home')}
                </Button>
              </div>
            </div>
          )}
        </Card.Body>
      </Card>
    </Container>
  );
};

export default ConfirmVerificationPage;

