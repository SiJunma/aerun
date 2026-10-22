import React, { useState, useEffect } from 'react';
import { Container, Button, Spinner, Alert } from 'react-bootstrap';
import { Mail, RefreshCw, Send, CheckCircle, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';

// EmailVerificationBanner — the honest resend control.
//
// WHY THE SUCCESS/ERROR STATES EXIST. The banner used to show
// "a new verification link has been sent" after calling a resend function
// that was an empty stub — the success message appeared while no request ever
// left the browser, which is exactly the reported bug ("Brevo shows nothing").
// Success now renders ONLY after the honest resend command answers
// mail_sent=true; a 503/502 (mail off, relay down) renders the error text
// instead of a green checkmark.
const EmailVerificationBanner = () => {
  const { user, emailUnverified, resendVerificationEmail, checkVerificationStatus } = useAuth();
  const { t } = useI18n();

  const [resending, setResending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sentSuccess, setSentSuccess] = useState(false);
  const [sendError, setSendError] = useState('');

  useEffect(() => {
    let timer = null;
    if (cooldown > 0) {
      timer = setInterval(() => {
        setCooldown(prev => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [cooldown]);

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setSendError('');
    try {
      await resendVerificationEmail();
      // The command answered mail_sent=true — only now may the banner claim a
      // link was sent. Anything else (503 mail off, 502 relay down) threw and
      // lands in the error branch below.
      setSentSuccess(true);
      setCooldown(60); // 60 seconds rate limit
    } catch (err) {
      console.error('[Resend Verification Error]', err);
      setSentSuccess(false);
      setSendError(err?.message || 'Failed to send the verification email');
    } finally {
      setResending(false);
    }
  };

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await checkVerificationStatus();
    } catch (err) {
      console.error('[Check Verification Status Error]', err);
    } finally {
      setChecking(false);
    }
  };

  // After all hooks: a non-member never sees the banner.
  if (!user || !emailUnverified) return null;

  return (
    <Container className="email-verification-banner-wrapper py-2">
      <div className="email-verification-banner d-flex flex-column flex-md-row align-items-md-center justify-content-between gap-3 py-3 px-4 rounded-3">
        {/* The left half (icon + text) and the right half (buttons) get their own
            hook classes: the mobile layout in index.css has to collapse the two
            halves independently, and Bootstrap utility classes alone could not
            express "keep the icon on top of the text" on phones. */}
        <div className="email-verification-left d-flex align-items-start gap-3">
          <div className="email-verification-icon-box flex-shrink-0">
            <Mail size={22} />
          </div>
          <div>
            <div className="email-verification-title fs-6 d-flex align-items-center gap-2">
              {t('auth.email_verification_required') || 'Email Verification Required'}
            </div>
            <div className="email-verification-desc mt-1">
              {t('auth.email_verification_desc', { email: user.email }) || `Please verify your email address (${user.email}) to unlock full forum permissions.`}
            </div>
            {sentSuccess && (
              <div className="email-verification-success mt-1 d-flex align-items-start gap-1">
                <CheckCircle size={14} />
                <span>{t('auth.verification_email_sent') || 'A new verification link has been sent to your email.'}</span>
              </div>
            )}
            {sendError && (
              <Alert variant="danger" className="py-1 px-2 small mt-2 mb-0 d-flex align-items-center gap-2">
                <AlertTriangle size={14} className="flex-shrink-0" />
                <span>{t('auth.verification_email_failed') || 'Could not send the verification email'}: {sendError}</span>
              </Alert>
            )}
          </div>
        </div>

        <div className="email-verification-actions d-flex align-items-center gap-2 flex-shrink-0 flex-wrap">
          <Button
            size="sm"
            className="email-verification-btn-primary d-flex align-items-center gap-2 px-3 shadow-sm border-0"
            onClick={handleResend}
            disabled={resending || cooldown > 0}
          >
            {resending ? (
              <Spinner size="sm" animation="border" />
            ) : (
              <Send size={15} />
            )}
            <span>
              {cooldown > 0 
                ? `${t('auth.resend_in') || 'Resend in'} ${cooldown}s` 
                : (t('auth.resend_verification_email') || 'Resend Email')}
            </span>
          </Button>

          <Button
            size="sm"
            className="email-verification-btn-secondary d-flex align-items-center gap-2 px-3 shadow-sm"
            onClick={handleCheck}
            disabled={checking}
          >
            {checking ? (
              <Spinner size="sm" animation="border" />
            ) : (
              <RefreshCw size={15} />
            )}
            <span>{t('auth.check_status') || 'Check Status'}</span>
          </Button>
        </div>
      </div>
    </Container>
  );
};

export default EmailVerificationBanner;
