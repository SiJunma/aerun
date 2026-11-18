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
import { sanitizeHtml } from '../../utils/text';

const Layout = ({ children }) => {
  const { settings, PERMISSIONS } = useAuth();
  const { lang, t } = useI18n();
  const { activeDesign } = useDesign();
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

  const sanitizedBanner = useMemo(() => {
    let rawHtml = '';

    if (activeDesign?.welcomeMessage) {
      rawHtml = activeDesign.welcomeMessage;
    } else if (settings?.welcomeMessage) {
      if (typeof settings.welcomeMessage === 'object' && settings.welcomeMessage !== null) {
        rawHtml = settings.welcomeMessage[lang] || settings.welcomeMessage.en || '';
      } else {
        rawHtml = settings.welcomeMessage;
      }
    }

    return sanitizeHtml(rawHtml) || null;
  }, [settings?.welcomeMessage, activeDesign?.welcomeMessage, lang]);

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
          
          {sanitizedBanner && location.pathname === '/' && (
            <div id="forum-announcement" className="forum-announcement" dangerouslySetInnerHTML={{ __html: sanitizedBanner }} />
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
              <p className="mb-0 small">
                &copy; {new Date().getFullYear()} {
                  activeDesign?.forumTitle ? activeDesign.forumTitle : (
                    (typeof settings?.forumName === 'object' && settings.forumName !== null)
                      ? (settings.forumName[lang] || settings.forumName.en || 'Aerun Forum')
                      : (settings?.forumName || 'Aerun Forum')
                  )
                }
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
