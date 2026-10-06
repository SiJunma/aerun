import React, { useMemo } from 'react';
import Navigation from './Navbar';
import { Container, Alert, Button } from 'react-bootstrap';
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
    <>
      <ForumBackground />

      <div className="app-wrapper">
        <ConnectionStatusBanner />
        <Navigation />

        {settings?.maintenanceMode && (
          <Alert variant="danger" className="m-0 text-center rounded-0 border-0 shadow-sm sticky-top maintenance-status-banner" style={{ zIndex: 900, top: '56px' }}>
            <span className="small fw-medium">
              {t('auth.maintenance_banner')}
            </span>
          </Alert>
        )}

        <EmailVerificationBanner />
        
        {sanitizedBanner && location.pathname === '/' && (
          <div dangerouslySetInnerHTML={{ __html: sanitizedBanner }} />
        )}

        <main className="py-2">
          <Container>
            {children}
          </Container>
        </main>
      </div>
      <footer className="footer-custom py-2 text-center">
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
      <ScrollButtons />
    </>
  );
};

export default Layout;
