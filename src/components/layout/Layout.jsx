import React from 'react';
import Navigation from './Navbar';
import { Container } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { useDesign } from '../../contexts/DesignProvider';
import ForumBackground from './ForumBackground';
import { useLocation, Link } from 'react-router-dom';
import ConnectionStatusBanner from '../common/ConnectionStatusBanner';
import EmailVerificationBanner from '../common/EmailVerificationBanner';
import ScrollButtons from '../common/ScrollButtons';
import RawHtml from '../common/RawHtml';
import { resolveField } from '../../utils/text';

const Layout = ({ children }) => {
  const { settings, PERMISSIONS } = useAuth();
  const { lang, t } = useI18n();
  const { resolvedDesign } = useDesign();
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

  // The header/footer HTML renders raw, without sanitization — see
  // RawHtml. Both fields are admin-only, and an admin can already run
  // arbitrary JS in every visitor's browser through the design JS field
  // (DesignProvider), so raw rendering does not expand the trust boundary.

  // forumName is a plain string now; resolveField keeps the defensive
  // object fallback for a snapshot that still carries the old {en, ru} shape.
  const forumTitle = resolvedDesign?.forumTitle
    || resolveField(settings?.forumName, lang)
    || 'Aerun Forum';

  return (
    <div id="forum-wrapper" className="forum-wrapper">
      <div id="forum" className="forum">
        <ForumBackground />

        <div className="app-wrapper">
          <ConnectionStatusBanner />
          <Navigation />

          {settings?.maintenanceMode && (
            <div id="forum-status" className="forum-status-banner maintenance-status-banner">
              <span className="small fw-medium">
                {t('auth.maintenance_banner')}
              </span>
            </div>
          )}

          <EmailVerificationBanner />

          {location.pathname === '/' && (
            <RawHtml id="forum-banner" className="forum-banner" html={resolvedDesign?.headerHtml} />
          )}

          {isAdminRoute ? (
            <main className="admin-main-fullwidth">
              <div className="admin-viewport-wrapper">
                {children}
              </div>
            </main>
          ) : (
            <main className="forum-main-content">
              <Container>
                {children}
              </Container>
            </main>
          )}
        </div>
        {!isAdminRoute && (
          <footer id="forum-about" className="forum-about footer-custom py-2 text-center">
            <Container>
              <RawHtml className="forum-custom-footer" html={resolvedDesign?.footerHtml} />
              <p className="mb-0 small">
                &copy; {new Date().getFullYear()} {forumTitle}
              </p>
            </Container>
          </footer>
        )}
        <ScrollButtons />
      </div>
    </div>
  );
};

export default Layout;
