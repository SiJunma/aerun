import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Container, Card, Button, Spinner, Alert } from 'react-bootstrap';
import { CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { usePageTitle } from '../contexts/TitleProvider';
import { confirmEmailVerification } from '../api/account-credentials';

const ConfirmVerificationPage = () => {
  const { token } = useParams();
  const { lang } = useI18n();
  const { setPageTitle } = usePageTitle();

  const [loading, setLoading] = useState(Boolean(token));
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(() => (token ? null : (lang === 'ru' ? 'Токен подтверждения не передан' : 'Missing verification token')));

  useEffect(() => {
    setPageTitle(lang === 'ru' ? 'Подтверждение email' : 'Email Verification');
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
        setError(err?.message || (lang === 'ru' ? 'Ссылка подтверждения недействительна или устарела' : 'Verification link is invalid or expired'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [token, lang]);

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
                {lang === 'ru' ? 'Подтверждаем ваш адрес электронной почты...' : 'Verifying your email address...'}
              </p>
            </div>
          )}

          {!loading && success && (
            <div className="py-2">
              <div className="text-success mb-3">
                <CheckCircle2 size={54} className="mx-auto" />
              </div>
              <h4 className="fw-bold mb-2">
                {lang === 'ru' ? 'Email успешно подтверждён!' : 'Email Verified Successfully!'}
              </h4>
              <p className="text-muted mb-4">
                {lang === 'ru'
                  ? 'Ваш аккаунт теперь активирован. Вы можете войти и использовать все возможности форума.'
                  : 'Your account is now fully active. You can sign in and participate in discussions.'}
              </p>
              <Button as={Link} to="/login" variant="primary" className="w-100 d-flex align-items-center justify-content-center gap-2">
                <span>{lang === 'ru' ? 'Войти в аккаунт' : 'Sign In'}</span>
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
                {lang === 'ru' ? 'Ошибка подтверждения' : 'Verification Failed'}
              </h4>
              <Alert variant="danger" className="text-start py-2 small mb-4">
                {error}
              </Alert>
              <div className="d-flex flex-column gap-2">
                <Button as={Link} to="/login" variant="primary" className="w-100">
                  {lang === 'ru' ? 'Перейти ко входу' : 'Go to Sign In'}
                </Button>
                <Button as={Link} to="/" variant="outline-secondary" className="w-100">
                  {lang === 'ru' ? 'На главную' : 'Back to Home'}
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

