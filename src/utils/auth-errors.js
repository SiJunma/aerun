/**
 * Maps a Firebase auth error to a human-friendly localized message.
 * Returns null when the caller should fall back to error.message.
 *
 * Context: Firebase App Check (reCAPTCHA v3 attestation) failures surface from
 * the auth popup flow as a bare `auth/internal-error` — the console shows
 * "Error while retrieving App Check token ... HTTP status: 403". On Firefox
 * this is almost always caused by Enhanced Tracking Protection /
 * Fingerprinting Protection distorting the browser environment so reCAPTCHA
 * cannot attest the client (works fine in Chrome/Opera/Edge).
 */
export const describeAuthError = (error, t) => {
  const code = error?.code || '';

  if (code === 'auth/internal-error' || /appCheck/i.test(error?.message || '')) {
    if (/firefox/i.test(navigator.userAgent)) return t('auth.error_appcheck_firefox');
    return t('auth.error_appcheck_generic');
  }

  return null;
};