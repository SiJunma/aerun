import React, { useState, useEffect } from 'react';
import { Container, Button, Spinner } from 'react-bootstrap';
import { Mail, RefreshCw, Send, CheckCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';

const EmailVerificationBanner = () => {
  const { user, emailUnverified, resendVerificationEmail, checkVerificationStatus } = useAuth();
  const { t } = useI18n();

  const [resending, setResending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sentSuccess, setSentSuccess] = useState(false);

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

  if (!user || !emailUnverified) return null;

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    try {
      await resendVerificationEmail();
      setSentSuccess(true);
      setCooldown(60); // 60 seconds rate limit
    } catch (err) {
      console.error('[Resend Verification Error]', err);
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

  return (
    <Container className="email-verification-banner-wrapper py-2">
      <div className="email-verification-banner d-flex flex-column flex-md-row align-items-md-center justify-content-between gap-3 py-3 px-4 rounded-3">
        <div className="d-flex align-items-center gap-3">
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
              <div className="email-verification-success mt-1 d-flex align-items-center gap-1">
                <CheckCircle size={14} />
                <span>{t('auth.verification_email_sent') || 'A new verification link has been sent to your email.'}</span>
              </div>
            )}
          </div>
        </div>

        <div className="d-flex align-items-center gap-2 flex-shrink-0 flex-wrap">
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
