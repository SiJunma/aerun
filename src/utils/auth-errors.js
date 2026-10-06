/**
 * Maps an authentication error (PocketBase ClientResponseError or network failure)
 * to a human-friendly localized message.
 * Returns null when the caller should fall back to error.message.
 */
export const describeAuthError = (error, t) => {
  if (!error) return null;

  const code = error?.code || '';
  const message = (error?.message || '').toLowerCase();
  const data = error?.data || {};

  // PocketBase / network authentication failures
  if (
    message.includes('failed to authenticate') ||
    code === 'invalid_grant' ||
    (error?.status === 400 && data?.message?.includes('Failed to authenticate'))
  ) {
    return t('auth.wrong_password');
  }

  // Duplicate email or unique constraint violation
  if (
    code === 'validation_not_unique' ||
    data?.data?.email?.code === 'validation_not_unique' ||
    message.includes('email already in use') ||
    message.includes('email already registered')
  ) {
    return t('auth.email_already_in_use');
  }

  // Network / fetch drop
  if (
    error?.isAbort ||
    message.includes('failed to fetch') ||
    message.includes('networkerror')
  ) {
    return t('common.error_connection', 'Ошибка подключения к серверу. Пожалуйста, проверьте интернет.');
  }

  // Legacy Firebase App Check (reCAPTCHA v3 attestation) fallback
  if (code === 'auth/internal-error' || /appcheck/i.test(message)) {
    if (typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)) {
      return t('auth.error_appcheck_firefox');
    }
    return t('auth.error_appcheck_generic');
  }

  return null;
};