import React, { useCallback, useEffect, useState } from 'react';
import { Card, Button, Form, Spinner, Alert, ListGroup, Badge } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import { pb } from '../../api/pocketbase';
import { fetchMyAuthState, changeMyPassword, changeMyEmail, unlinkGoogle, requestMyPasswordReset } from '../../api/account-credentials';
import { Key, Mail } from 'lucide-react';

// SecurityTab manages the caller's sign-in methods.
//
// THE STATE IS FETCHED, NEVER ASSUMED. This component used to open with
// `const hasGoogle = false; const hasPassword = true;` — two constants
// presented as account facts. It told every member their Google account was
// unlinked and their password was linked, which is the wrong way round for at
// least one real population: an account that has only ever signed in with
// Google has NO password, and the importer hands accounts a generated password
// nobody was ever shown. Those are server facts and cannot be derived here.
//
// The password form also wrote through pb.collection('users').update(), which
// migration 1766000000 forbids (users.UpdateRule = nil): every credential change
// is a server command now.

const SecurityTab = () => {
  const { user } = useAuth();
  const { t } = useI18n();
  const { showToast } = useToast();

  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [emailInput, setEmailInput] = useState('');
  // The "forgot your password?" disclosure starts CLOSED: it is an escape hatch
  // for a locked-out member, not something to greet every visitor with.
  const [forgotOpen, setForgotOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const state = await fetchMyAuthState();
      setAuth(state);
      // Prefill only once per load: overwriting the field on every re-render
      // would discard what the member is currently typing.
      setEmailInput(prev => (prev ? prev : state.email));
    } catch (err) {
      console.error('[SecurityTab] auth state', err);
      setError(err?.message || 'Failed to load your sign-in methods');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  if (!user) return null;

  // One place owns the busy flag, the banners and the state refresh, so no
  // action can forget to clear its own spinner or reload the row it changed.
  //
  // SUCCESS TRAVELS AS A TOAST, NOT AS A BANNER. The success Alert used to
  // render at the very top of the card — on the password form that is several
  // screens of scrolling away from the "Send Reset Link" button the member just
  // pressed, so the confirmation was effectively invisible. Every other screen
  // in this app reports outcomes through the shared ToastProvider; this tab now
  // does the same. Errors stay inline: they belong to a specific form field the
  // caller must fix, and a toast would be gone before they read it.
  const run = async (key, action, successKey) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      showToast(t(successKey), 'success');
      await load();
      return true;
    } catch (err) {
      console.error('[SecurityTab]', key, err);
      setError(err?.message || 'Request failed');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleLinkGoogle = () =>
    run('link-google', async () => {
      // authWithOAuth2 replaces the session when it resolves to a different
      // account; the guard below is the same one AdminPage uses before driving
      // this flow on somebody's behalf.
      const previousToken = pb.authStore.token;
      const previousRecord = pb.authStore.record;
      const authData = await pb.collection('users').authWithOAuth2({ provider: 'google' });
      if (authData?.record?.id !== user?.uid && authData?.record?.id !== user?.id) {
        pb.authStore.save(previousToken, previousRecord);
        throw new Error(t('auth.wrong_google_account'));
      }
    }, 'auth_google_linked');

  const handleUnlinkGoogle = () =>
    run('unlink-google', () => unlinkGoogle(currentPassword), 'auth_google_unlinked')
      .then(ok => { if (ok) setCurrentPassword(''); });

  const handleChangePassword = (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError(t('profile.error_password_mismatch') || 'Passwords do not match');
      return;
    }
    run('password', () => changeMyPassword({
      currentPassword,
      newPassword
    }), 'auth_password_changed').then(ok => {
      if (ok) {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    });
  };

  const handleChangeEmail = (e) => {
    e.preventDefault();
    run('email', () => changeMyEmail({
      email: emailInput,
      currentPassword
    }), 'auth_email_changed').then(ok => { if (ok) setCurrentPassword(''); });
  };

  if (loading && !auth) {
    return (
      <Card className="shadow-sm border-0 bg-card">
        <Card.Body className="p-4 d-flex justify-content-center">
          <Spinner animation="border" />
        </Card.Body>
      </Card>
    );
  }

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

        <ListGroup variant="flush" className="mb-4 bg-transparent">
          {/* Google — the linked/unlinked badge is now the fetched fact. */}
          <ListGroup.Item className="bg-transparent border-bottom d-flex justify-content-between align-items-center py-3 px-0">
            <div className="d-flex align-items-center gap-3">
              <div className="rounded-circle bg-light d-flex align-items-center justify-content-center" style={{ width: '40px', height: '40px' }}>
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style={{ width: '20px' }} />
              </div>
              <div>
                <div className="fw-bold">{t('profile.auth_provider_google')}</div>
                <div className="small text-muted">
                  {auth?.googleLinked
                    ? t('profile.auth_linked')
                    : auth?.googleEnabled
                      ? t('profile.auth_not_linked')
                      : t('profile.auth_provider_unavailable')}
                </div>
              </div>
            </div>
            <div className="d-flex align-items-center gap-2">
              {auth?.googleLinked ? (
                <>
                  <Badge bg="success" className="px-3 py-2 opacity-75">{t('profile.auth_linked')}</Badge>
                  <Button
                    variant="outline-danger"
                    size="sm"
                    onClick={handleUnlinkGoogle}
                    disabled={busy === 'unlink-google' || !auth?.canUnlinkGoogle}
                    title={!auth?.canUnlinkGoogle ? t('profile.auth_only_method') : undefined}
                  >
                    {busy === 'unlink-google' ? <Spinner size="sm" animation="border" /> : t('profile.auth_unlink_google')}
                  </Button>
                </>
              ) : auth?.googleEnabled ? (
                <Button
                  variant="outline-primary"
                  size="sm"
                  onClick={handleLinkGoogle}
                  disabled={busy === 'link-google'}
                >
                  {busy === 'link-google' ? <Spinner size="sm" animation="border" /> : t('profile.auth_add_google')}
                </Button>
              ) : null}
            </div>
          </ListGroup.Item>

          {/* Password */}
          <ListGroup.Item className="bg-transparent d-flex justify-content-between align-items-center py-3 px-0 border-bottom">
            <div className="d-flex align-items-center gap-3">
              <div className="rounded-circle bg-light d-flex align-items-center justify-content-center text-dark" style={{ width: '40px', height: '40px' }}>
                <Key size={18} />
              </div>
              <div>
                <div className="fw-bold">{t('profile.auth_provider_password')}</div>
                <div className="small text-muted">
                  {auth?.hasPassword ? t('profile.auth_linked') : t('profile.auth_not_linked')}
                </div>
              </div>
            </div>
            <div>
              {auth?.hasPassword ? (
                <Badge bg="success" className="px-3 py-2 opacity-75">{t('profile.auth_linked')}</Badge>
              ) : (
                <Badge bg="secondary" className="px-3 py-2 opacity-75">{t('profile.auth_not_linked')}</Badge>
              )}
            </div>
          </ListGroup.Item>
        </ListGroup>

        {!auth?.canUnlinkGoogle && auth?.googleLinked && (
          <Alert variant="warning" className="py-2 small mb-4">
            {t('profile.auth_only_method')}
          </Alert>
        )}

        <div className="p-3 modal-section-themed rounded mb-3">
          <h6 className="fw-bold mb-2 d-flex align-items-center gap-2">
            <Key size={16} className="text-warning" />
            {auth?.hasPassword ? t('profile.auth_change_password') : t('profile.auth_add_password')}
          </h6>
          <p className="small text-muted mb-3 opacity-75">
            {t('profile.auth_password_set_desc')}
          </p>
          <Form onSubmit={handleChangePassword}>
            {/* The current password is the ownership proof the server asks for
                when the account HAS one. It is hidden entirely when it does
                not: an account with no password is confirmed by a recent
                provider sign-in instead, and showing the field would only
                invite a member to type something that cannot work. */}
            {auth?.hasPassword && (
              <Form.Group className="mb-3">
                <Form.Label className="small fw-bold">{t('profile.auth_current_password')}</Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={busy === 'password'}
                />
              </Form.Group>
            )}
            <Form.Group className="mb-3">
              <Form.Label className="small fw-bold">{t('profile.auth_new_password')}</Form.Label>
              <Form.Control
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={busy === 'password'}
              />
              <Form.Text className="text-muted">
                {t('profile.auth_password_hint', { size: auth?.minPasswordLength || 8 })}
              </Form.Text>
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label className="small fw-bold">{t('profile.auth_confirm_password')}</Form.Label>
              <Form.Control
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy === 'password'}
                isInvalid={confirmPassword.length > 0 && confirmPassword !== newPassword}
              />
            </Form.Group>
            <Button
              type="submit"
              variant="primary"
              disabled={busy === 'password' || !newPassword || newPassword !== confirmPassword}
              className="px-4 fw-bold"
            >
              {busy === 'password' ? <Spinner size="sm" animation="border" /> : t('common.save')}
            </Button>
          </Form>

          {/* FORGOT THE PASSWORD.
              The reset flow exists and is reachable from the login screen
              (ForgotPasswordForm), but whether this deployment ACTUALLY sends
              mail is a server fact reported by /me/auth as `mail_enabled`
              (configureSMTP reconciles it from AERUN_MAIL_MODE on every boot).

              With mail off, MailHardDisableGuard aborts every send, so the
              disclosure must not claim a link is on its way — a reset that
              silently never arrives is worse than no reset at all. It says
              plainly what is true instead, and points at the two routes that
              work without mail: signing in with Google, or an administrator
              setting a new one.

              With mail on, the same disclosure issues the real request — to
              the address the server already holds for this account, never a
              typed one — and only then may say the link was sent.

              It only appears when the account actually HAS a password,
              because that is the only case where somebody can have forgotten it. */}
          {auth?.hasPassword && (
            <div className="mt-3 pt-3 border-top">
              <Button
                variant="link"
                size="sm"
                className="p-0 text-decoration-none small"
                onClick={() => setForgotOpen(v => !v)}
              >
                {t('profile.auth_forgot_password')}
              </Button>

              {forgotOpen && !auth?.mailEnabled && (
                <Alert variant="warning" className="py-2 small mt-2 mb-0 text-start">
                  {t('profile.auth_reset_mail_disabled')}
                </Alert>
              )}

              {forgotOpen && auth?.mailEnabled && (
                <Alert variant="info" className="py-2 small mt-2 mb-0 text-start">
                  <div className="mb-2">
                    {t('profile.auth_reset_mail_hint')}
                  </div>
                  <Button
                    size="sm"
                    variant="outline-primary"
                    className="fw-bold"
                    disabled={busy === 'reset-mail'}
                    onClick={() =>
                      run(
                        'reset-mail',
                        () => requestMyPasswordReset(auth.email),
                        'profile.auth_reset_sent'
                      )
                    }
                  >
                    {busy === 'reset-mail' ? <Spinner size="sm" animation="border" /> : t('auth.send_reset_link')}
                  </Button>
                </Alert>
              )}
            </div>
          )}
        </div>

        <div className="p-3 modal-section-themed rounded">
          <h6 className="fw-bold mb-2 d-flex align-items-center gap-2">
            <Mail size={16} className="text-warning" />
            {t('profile.auth_change_email')}
          </h6>
          <p className="small text-muted mb-3 opacity-75">
            {t('profile.auth_email_change_desc')}
          </p>
          <Form onSubmit={handleChangeEmail}>
            <Form.Group className="mb-3">
              <Form.Label className="small fw-bold">{t('profile.auth_email')}</Form.Label>
              <Form.Control
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                disabled={busy === 'email'}
              />
            </Form.Group>
            {auth?.hasPassword && (
              <Form.Group className="mb-3">
                <Form.Label className="small fw-bold">{t('profile.auth_current_password')}</Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={busy === 'email'}
                />
              </Form.Group>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={busy === 'email' || !emailInput || emailInput === auth?.email}
              className="px-4 fw-bold"
            >
              {busy === 'email' ? <Spinner size="sm" animation="border" /> : t('common.save')}
            </Button>
          </Form>
        </div>

      </Card.Body>
    </Card>
  );
};

export default SecurityTab;
