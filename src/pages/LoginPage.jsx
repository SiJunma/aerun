import React from 'react';
import { useAuth } from '../contexts/AuthProvider';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { Container, Card } from 'react-bootstrap';
import LoginForm from '../components/auth/LoginForm';
import { useI18n } from '../contexts/I18nProvider';

import { usePageTitle } from '../contexts/TitleProvider';
import { sanitizeHtml } from '../utils/text';

const LoginPage = () => {
  const { user, profile, settings, hasPermission, PERMISSIONS } = useAuth();
  const { t, lang } = useI18n();
  const { setPageTitle } = usePageTitle();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  React.useEffect(() => {
    setPageTitle(t('auth.login', 'Вход'));
  }, [setPageTitle, t, lang]);

  /**
   * Maintenance notice on the white wall. Shown only when BOTH Maintenance Mode
   * and the White Wall for Guests are on AND the admin checked
   * "Show Maintenance Message". Renders the admin's HTML message in a
   * highlighted box; without a custom message a default text is shown.
   */
  // No manual useMemo here: its deps missed `t` and `lang`, which made the
  // compiler rule skip this component — and the computation is a few string
  // checks plus one sanitize of a short message, so memoizing it buys nothing.
  let maintenanceNotice = null;
  if (settings?.maintenanceMode && settings?.whitelistMode && settings?.showMaintenanceMessage) {
    const raw = settings?.maintenanceMessage;
    const custom = sanitizeHtml(
      typeof raw === 'string' ? raw : (raw?.[lang] || raw?.en || raw?.ru || '')
    );
    maintenanceNotice = custom || sanitizeHtml(t('forum.maintenance_default'));
  }

  if (user) {
    if (!profile) return null; // Wait for profile to load before redirecting

    // If banned, don't redirect anywhere - AuthProvider will handle the forced logout shortly.
    // This avoids a jarring jump to /banned before being kicked back to /
    if (profile.status === 'banned') return null;
    
    // Default redirect for other logged-in users
    const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);
    const target = (isAdmin && (from === '/pending' || from === '/banned')) ? '/' : from;
    return <Navigate to={target} replace />;
  }

  // If whitelist mode is OFF, guests shouldn't see the separate login page.
  // They are redirected to the Home page where they can use the AuthModal popup.
  if (settings?.whitelistMode === false) {
    return <Navigate to="/" replace />;
  }

  // If whitelist mode is OFF, guests should be redirected to the home page
  // (They can use the AuthModal in the Navbar if they want to log in)
  if (!user && settings && !settings.whitelistMode) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container className="d-flex align-items-center justify-content-center vh-100">
      <Card style={{ maxWidth: '400px', width: '100%' }} className="p-4 shadow border-0 rounded-4">
        <Card.Body>
          {maintenanceNotice && (
            // Plain div, NOT react-bootstrap <Alert>: Alert always passes both
            // children and the spread props (incl. dangerouslySetInnerHTML) to
            // its inner <div>, which makes React throw
            // "Can only set one of `children` or `props.dangerouslySetInnerHTML`".
            <div
              className="alert alert-warning maintenance-message small mb-3"
              role="alert"
              dangerouslySetInnerHTML={{ __html: maintenanceNotice }}
            />
          )}
          <LoginForm />
          {settings?.maintenanceMode && (
            <div className="mt-3 text-center small text-muted">
              {t('forum.admins_only')}
            </div>
          )}
          {settings?.registrationEnabled !== false && (
            <div className="mt-4 text-center small border-top pt-3">
              <span className="text-muted">{t('auth.dont_have_account')}</span>
              <Link to="/register" className="ms-1 fw-bold text-decoration-none text-primary">
                {t('auth.register_link')}
              </Link>
            </div>
          )}
        </Card.Body>
      </Card>
    </Container>
  );
};

export default LoginPage;
