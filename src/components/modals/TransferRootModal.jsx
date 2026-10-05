import React, { useState, useEffect } from 'react';
import { Button, Form, Alert } from 'react-bootstrap';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';
import ForumModal from '../common/ForumModal';
import { useI18n } from '../../contexts/I18nProvider';
import { TRANSFER_PHRASE } from '../../api/admin';

/**
 * TransferRootModal hands the chief-admin role to somebody else.
 *
 * Its own component rather than a ConfirmModal, because the action is
 * IRREVERSIBLE and the generic dialog treats confirmation as a formality.
 * Three things make it look and behave like it deserves:
 *
 *  1. The CONSEQUENCES are spelled out before anything can be clicked — you lose
 *     the role, you become an admin, and you cannot take it back. Somebody who
 *     does not read the dialog can still lose the forum.
 *  2. RE-AUTHENTICATION. The server refuses the handover unless the caller can
 *     prove they are the account owner, and the field is here because that is
 *     the whole point; without it the dialog would be theatre.
 *
 *     It accepts EITHER the account password OR a fresh Google sign-in, because
 *     the password is not available to every account here: one that has only
 *     ever signed in through Google has none at all, and one imported from the
 *     legacy backend was given a generated password nobody was shown. For those
 *     accounts the password box is not a hurdle, it is a wall — and since this
 *     action is irreversible, a wall here means the forum is stuck. The Google
 *     path is checked by the SERVER from the OAuth hook, not by anything the
 *     browser asserts.
 *  3. The confirmation PHRASE must be typed exactly. It is imported from the
 *     API module, so the server's required phrase and the one this dialog asks
 *     for cannot drift apart.
 */
const TransferRootModal = ({
  show,
  onHide,
  candidates,
  onConfirm,
  busy = false,
  currentNickname = '',
  currentUserId = '',
  onReauthWithGoogle,
}) => {
  const { lang } = useI18n();
  const [successorId, setSuccessorId] = useState('');
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [reauthState, setReauthState] = useState('idle'); // idle | busy | done | error

  // Reset on every open, so a half-finished attempt — including the password —
  // never leaks into the next one.
  useEffect(() => {
    if (show) {
      setSuccessorId('');
      setPassword('');
      setPhrase('');
      setSubmitted(false);
      setReauthState('idle');
    }
  }, [show]);

  // The self row is filtered by ID, not by a flag on the row.
  //
  // The dialog used to drop candidates carrying `is_self`, but nothing in the
  // codebase ever set that field: `candidates` is the plain admin users list, so
  // `c.is_self` was always undefined, the filter removed nobody, and the chief
  // admin appeared as a candidate for their own succession. The server refuses
  // that transfer (root_transfer.go), so the offer could only ever have failed
  // at submit time — a dialog that looks actionable and is not.
  //
  // `status` is filtered for the same reason and on the same principle: the
  // server rejects a successor who is not active, because a chief admin who
  // cannot sign in is not a chief admin.
  const options = (candidates || []).filter(
    (c) => c.id !== currentUserId && c.status === 'active'
  );

  const phraseOk = phrase.trim().toUpperCase() === TRANSFER_PHRASE;

  const handleReauth = async () => {
    setReauthState('busy');
    try {
      await onReauthWithGoogle?.();
      setReauthState('done');
    } catch {
      setReauthState('error');
    }
  };

  // Either proof satisfies the confirmation, and the password stays preferred:
  // an operator who knows their password should never be sent through a Google
  // consent screen they did not ask for.
  const confirmed = password.length > 0 || reauthState === 'done';
  const canSubmit = Boolean(successorId) && confirmed && phraseOk && !busy;

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    setSubmitted(true);
    if (!canSubmit) return;
    onConfirm({ successorId, password, confirmPhrase: phrase.trim().toUpperCase() });
  };

  const footer = (
    <>
      <Button variant="link" className="text-decoration-none text-muted fw-bold me-2" onClick={onHide} disabled={busy}>
        {lang === 'ru' ? 'Отмена' : 'Cancel'}
      </Button>
      <Button variant="danger" className="px-4 fw-bold shadow-sm" onClick={handleSubmit} disabled={!canSubmit}>
        {busy
          ? (lang === 'ru' ? 'Передача…' : 'Transferring…')
          : (lang === 'ru' ? 'Передать роль' : 'Transfer role')}
      </Button>
    </>
  );

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      size="lg"
      title={
        <span className="d-inline-flex align-items-center gap-2">
          <ShieldAlert size={20} className="text-danger" />
          {lang === 'ru' ? 'Передача роли главного администратора' : 'Transfer chief admin role'}
        </span>
      }
      footer={footer}
    >
      <Form onSubmit={handleSubmit}>
        {/* Consequences in full, before the first input. */}
        <Alert variant="danger" className="small">
          <p className="fw-bold mb-2">
            {lang === 'ru' ? 'Это действие необратимо.' : 'This action cannot be undone.'}
          </p>
          <ul className="mb-2 ps-3">
            <li>
              {lang === 'ru'
                ? `Роль перейдёт к выбранному участнику, а вы станете администратором${
                    currentNickname ? ` (${currentNickname} → admin)` : ' (admin)'
                  }.`
                : `The role passes to the chosen member and you become an administrator${
                    currentNickname ? ` (${currentNickname} → admin)` : ' (admin)'
                  }.`}
            </li>
            <li>
              {lang === 'ru'
                ? 'Вернуть роль себе вы не сможете: назначить главного администратора может только главный.'
                : 'You cannot take the role back: only the chief admin can appoint one.'}
            </li>
            <li>
              {lang === 'ru'
                ? 'У нового главного будут все права, включая право передать роль дальше.'
                : 'The new chief admin gets every power, including handing the role on.'}
            </li>
          </ul>
          <p className="mb-0">
            {lang === 'ru'
              ? 'Передача будет записана в журнал аудита с указанием обоих участников.'
              : 'The handover is recorded in the audit log naming both members.'}
          </p>
        </Alert>

        <Form.Group className="mb-3">
          <Form.Label className="fw-bold">
            {lang === 'ru' ? 'Новый главный администратор' : 'New chief admin'}
          </Form.Label>
          <Form.Select
            value={successorId}
            onChange={(e) => setSuccessorId(e.target.value)}
            isInvalid={submitted && !successorId}
            disabled={busy}
          >
            <option value="">{lang === 'ru' ? '— выберите участника —' : '— choose a member —'}</option>
            {(options).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nickname}
                </option>
              ))}
          </Form.Select>
          {submitted && !successorId && (
            <div className="invalid-feedback d-block">
              {lang === 'ru' ? 'Выберите участника.' : 'Choose a member.'}
            </div>
          )}
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label className="fw-bold">
            {lang === 'ru' ? 'Ваш пароль (повторная аутентификация)' : 'Your password (re-authentication)'}
          </Form.Label>
          <Form.Control
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            isInvalid={submitted && !confirmed}
            disabled={busy}
            autoComplete="current-password"
            placeholder={lang === 'ru' ? 'Ваш текущий пароль' : 'Your current password'}
          />
          <Form.Text className="text-muted">
            {lang === 'ru'
              ? 'Требуется, чтобы украденная сессия не позволяла передать форум.'
              : 'Required so a stolen session cannot hand over the forum.'}
          </Form.Text>

          {/* The alternative for an account that has no password to type. */}
          <div className="mt-2 pt-2 border-top">
            {reauthState === 'done' ? (
              <div className="d-flex align-items-center gap-2 text-success small">
                <CheckCircle2 size={14} />
                {lang === 'ru'
                  ? 'Вход через Google подтверждён.'
                  : 'Google sign-in confirmed.'}
              </div>
            ) : (
              <>
                <Button
                  variant="outline-secondary"
                  size="sm"
                  onClick={handleReauth}
                  disabled={busy || reauthState === 'busy' || !onReauthWithGoogle}
                >
                  {reauthState === 'busy'
                    ? (lang === 'ru' ? 'Проверяем…' : 'Checking…')
                    : (lang === 'ru' ? 'Войти через Google повторно' : 'Sign in with Google again')}
                </Button>
                <Form.Text className="text-muted d-block mt-1">
                  {lang === 'ru'
                    ? 'Если пароль не помните или его не было — подтвердите вход через Google. Проверяет сервер.'
                    : 'No password, or you cannot recall it? Confirm with Google instead. The server verifies this.'}
                </Form.Text>
                {reauthState === 'error' && (
                  <div className="text-danger small mt-1">
                    {lang === 'ru'
                      ? 'Не удалось подтвердить вход. Попробуйте ещё раз.'
                      : 'Could not confirm the sign-in. Please try again.'}
                  </div>
                )}
              </>
            )}
          </div>
        </Form.Group>

        <Form.Group className="mb-2">
          <Form.Label className="fw-bold">
            {lang === 'ru'
              ? `Введите ${TRANSFER_PHRASE}, чтобы подтвердить`
              : `Type ${TRANSFER_PHRASE} to confirm`}
          </Form.Label>
          <Form.Control
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            isInvalid={submitted && !phraseOk}
            disabled={busy}
            placeholder={TRANSFER_PHRASE}
          />
        </Form.Group>
      </Form>
    </ForumModal>
  );
};

export default TransferRootModal;