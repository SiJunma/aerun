import { pb, sendApi } from './pocketbase';

/**
 * Account sign-in credentials.
 *
 * WHY A MODULE AND NOT A DIRECT pb.collection('users') CALL. The Security tab
 * used to read `pb.collection('users').update(...)` for its password form, which
 * this backend refuses by design: migration 1766000000 sets
 * users.UpdateRule = nil, so browser writes are locked and every profile change
 * is a server command. Every call here goes through /api/aerun instead.
 *
 * WHY THE STATE IS FETCHED AND NOT DERIVED. The tab hardcoded
 * `hasGoogle = false; hasPassword = true;` — two constants presented as
 * account state. has_password in particular cannot be guessed client-side: an
 * account that only ever signed in with Google has no password at all, and the
 * importer gives one away unseen, so "does this account have a password" is
 * server knowledge and nothing else.
 */

// fetchMyAuthState reads what the caller can actually sign in with.
//
// `can_unlink_google` is deliberately taken from the server rather than
// recomputed here. The rule — an account may not remove its last sign-in
// method — is enforced there, and a client copy would drift from it.
export const fetchMyAuthState = async () => {
  const res = await sendApi('/api/aerun/me/auth');
  return {
    email: res?.email || '',
    emailVerified: !!res?.email_verified,
    hasPassword: !!res?.has_password,
    // mailEnabled is the server's own statement that SMTP is reconciled and on.
    // The "forgot password" disclosure branches on it: a real reset request
    // when true, the honest "no mail on this server" notice when false — the
    // same rule can_unlink_google follows, never a client-side guess.
    mailEnabled: !!res?.mail_enabled,
    googleEnabled: !!res?.google_enabled,
    googleLinked: !!res?.google_linked,
    canUnlinkGoogle: !!res?.can_unlink_google,
    methods: res?.methods || [],
    minPasswordLength: res?.min_password_length || 8
  };
};

/**
 * changeMyPassword sets or replaces the password.
 *
 * `currentPassword` is only sent when the account has one — the server decides
 * which proof applies, and an account with no password is asked for a recent
 * Google sign-in instead. Sending an empty string would be treated as a wrong
 * password, so it is omitted entirely.
 */
export const changeMyPassword = async ({ currentPassword, newPassword }) => {
  const body = {
    new_password: newPassword,
    new_password_confirm: newPassword
  };
  if (currentPassword) body.current_password = currentPassword;
  await sendApi('/api/aerun/me/password', { method: 'PUT', body });
};

export const changeMyEmail = async ({ email, currentPassword }) => {
  const body = { email };
  if (currentPassword) body.current_password = currentPassword;
  await sendApi('/api/aerun/me/email', { method: 'PATCH', body });
};

/**
 * requestMyPasswordReset asks for a reset link to `email`.
 *
 * This is PocketBase's own public endpoint — the one the login screen's
 * ForgotPasswordForm already uses — so it inherits the server's rate limit and
 * its anti-enumeration behaviour (204 whether or not the address exists).
 * The Security tab passes the CALLER's address, taken from the fetched auth
 * state rather than a form field: the member already proved which account they
 * are, and a typed address here would only add a way to reset somebody else's
 * password from a hijacked session.
 */
export const requestMyPasswordReset = async (email) => {
  await pb.collection('users').requestPasswordReset(email);
};

/**
 * unlinkGoogle removes the linked Google identity.
 *
 * The server refuses with 409 when Google is the account's only sign-in
 * method. The UI disables the button in that case, but the refusal is the real
 * guarantee — a client-side disable is a hint, not a boundary.
 */
export const unlinkGoogle = async (currentPassword) => {
  const body = {};
  if (currentPassword) body.current_password = currentPassword;
  await sendApi('/api/aerun/me/auth/google', { method: 'DELETE', body });
};

/**
 * confirmEmailVerification confirms email with token from confirmation letter (SEC-04).
 */
export const confirmEmailVerification = async (token) => {
  return await pb.collection('users').confirmVerification(token);
};

/**
 * confirmPasswordReset completes password reset using token and new password (SEC-04).
 */
export const confirmPasswordReset = async ({ token, password, passwordConfirm }) => {
  return await pb.collection('users').confirmPasswordReset(token, password, passwordConfirm);
};
