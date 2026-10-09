import React from 'react';
import { Card, Button, Alert, Spinner } from 'react-bootstrap';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';

import { usePageTitle } from '../contexts/TitleProvider';

// PendingPage — the gate for unverified/pending accounts.
//
// WHY THE LOCAL busy/error STATES. The buttons used to call
// resendVerificationEmail / checkVerificationStatus directly — back when both
// were empty stubs, so a click did nothing and showed nothing. Now the calls
// are real (PocketBase requestVerification + authRefresh) and can fail (mail
// off → 503, session expired, rate limit), so the page reports the outcome
// instead of swallowing it.
const PendingPage = () => {
  const { logout, profile, emailUnverified, resendVerificationEmail, checkVerificationStatus } = useAuth();
  const { translations } = useI18n(); // Access raw translations if needed, or just force key
  const { setPageTitle } = usePageTitle();
  const [busy, setBusy] = React.useState(null);
  const [notice, setNotice] = React.useState(null);

  // Force English for this page as requested
  // Memoised on `translations` (a stable module import) so the page-title effect
  // can depend on it without re-running on every render.
  const t = React.useCallback((path) => {
    const keys = path.split('.');
    let result = translations['en'];
    for (const key of keys) {
      if (result) result = result[key];
    }
    return result || path;
  }, [translations]);

  React.useEffect(() => {
    setPageTitle(emailUnverified ? (t('gatekeeper.pending_email_title') || 'Verify Email') : (t('gatekeeper.pending_title') || 'Pending Approval'));
  }, [setPageTitle, emailUnverified, t]);

  React.useEffect(() => {
    if (profile && profile.status === 'active') {
      window.location.href = '/';
    }
  }, [profile]);

  const handleResend = async () => {
    if (busy) return;
    setBusy('resend');
    setNotice(null);
    try {
      await resendVerificationEmail();
      setNotice({ variant: 'success', text: t('auth.verification_email_sent') });
    } catch (err) {
      setNotice({ variant: 'danger', text: `${t('auth.verification_email_failed')}: ${err?.message || 'request failed'}` });
    } finally {
      setBusy(null);
    }
  };

  const handleCheck = async () => {
    if (busy) return;
    setBusy('check');
    setNotice(null);
    try {
      const verified = await checkVerificationStatus();
      if (verified) {
        window.location.href = '/';
        return;
      }
      setNotice({ variant: 'info', text: t('gatekeeper.pending_banner_email') });
    } catch (err) {
      setNotice({ variant: 'danger', text: err?.message || 'request failed' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="d-flex align-items-center justify-content-center py-5" style={{ minHeight: '60vh' }}>
      <Card style={{ maxWidth: '500px', width: '100%' }} className="p-4 shadow border-warning">
        <Card.Body className="text-center">
          <h2 className="mb-4 text-warning">
            {emailUnverified ? t('gatekeeper.pending_email_title') : t('gatekeeper.pending_title')}
          </h2>
          <p className="mb-4">
            {emailUnverified ? t('gatekeeper.pending_email_message') : t('gatekeeper.pending_message')}
          </p>
          {notice && (
            <Alert variant={notice.variant} className="py-2 small">
              {notice.text}
            </Alert>
          )}
          <div className="d-flex justify-content-center gap-3 flex-wrap">
            {emailUnverified && (
              <Button variant="outline-primary" onClick={handleResend} disabled={!!busy}>
                {busy === 'resend' ? <Spinner size="sm" animation="border" /> : t('auth.resend_verification')}
              </Button>
            )}
            <Button variant="outline-danger" onClick={logout} disabled={!!busy}>{t('common.logout')}</Button>
            <Button variant="primary" onClick={handleCheck} disabled={!!busy}>
              {busy === 'check' ? <Spinner size="sm" animation="border" /> : t('common.check_status')}
            </Button>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
};

export default PendingPage;
