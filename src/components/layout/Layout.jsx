import React, { useMemo } from 'react';
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
import { sanitizeHtml, resolveField } from '../../utils/text';

const Layout = ({ children }) => {
  const { settings, PERMISSIONS } = useAuth();
  const { lang, t } = useI18n();
  const { resolvedDesign } = useDesign();
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

  const sanitizedHeader = useMemo(() => {
    return sanitizeHtml(resolvedDesign?.headerHtml || '') || null;
  }, [resolvedDesign?.headerHtml]);

  const sanitizedFooter = useMemo(() => {
    return sanitizeHtml(resolvedDesign?.footerHtml || '') || null;
  }, [resolvedDesign?.footerHtml]);

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

          {sanitizedHeader && location.pathname === '/' && (
            <div id="forum-banner" className="forum-banner" dangerouslySetInnerHTML={{ __html: sanitizedHeader }} />
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
              {sanitizedFooter && (
                <div className="forum-custom-footer" dangerouslySetInnerHTML={{ __html: sanitizedFooter }} />
              )}
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
