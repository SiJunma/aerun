import React, { useMemo } from 'react';
import Navigation from './Navbar';
import { Container, Alert } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import ForumBackground from './ForumBackground';
import { useLocation, Link } from 'react-router-dom';


const Layout = ({ children }) => {
  const { settings, profile, PERMISSIONS } = useAuth();
  const { lang, t } = useI18n();
  const location = useLocation();

  // Update document title dynamically
  React.useEffect(() => {
    const forumName = (typeof settings?.forumName === 'object' && settings.forumName !== null)
      ? (settings.forumName[lang] || settings.forumName.en || 'Aerun Forum')
      : (settings?.forumName || 'Aerun Forum');
    document.title = forumName;
  }, [settings, lang]);

  const sanitizedBanner = useMemo(() => {
    if (!settings?.welcomeMessage) return null;
    try {
      let rawHtml = '';
      if (typeof settings.welcomeMessage === 'object' && settings.welcomeMessage !== null) {
        rawHtml = settings.welcomeMessage[lang] || settings.welcomeMessage.en || '';
      } else {
        rawHtml = settings.welcomeMessage;
      }

      if (!rawHtml || typeof rawHtml !== 'string') {
        if (rawHtml && typeof rawHtml === 'object') {
          console.error('[Layout] rawHtml is an object, keys:', Object.keys(rawHtml));
        }
        return null;
      }

      let html = rawHtml;
      // Remove scripts
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      // Remove inline event handlers (onmouseover, onclick, etc.)
      html = html.replace(/\bon\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');
      return html;
    } catch (e) {
      console.error('Error sanitizing banner:', e);
      return null;
    }
  }, [settings?.welcomeMessage, lang]);

  return (
    <>
      <ForumBackground />

      <div className="app-wrapper">
        <Navigation />

        {settings?.maintenanceMode && location.pathname !== '/maintenance' && (
          <Alert variant="danger" className="m-0 text-center rounded-0 border-0 shadow-sm sticky-top maintenance-status-banner" style={{ zIndex: 900, top: '56px' }}>
            <span className="small fw-medium">
              {t('auth.maintenance_banner')}
            </span>
          </Alert>
        )}

        {profile?.role_id === 'pending' && location.pathname !== '/pending' && (
          <Alert variant="warning" className="m-0 text-center rounded-0 border-0 shadow-sm sticky-top pending-status-banner" style={{ zIndex: 900, top: '56px' }}>
            <span className="small fw-medium">
              {t('gatekeeper.pending_banner')}
            </span>
          </Alert>
        )}
        
        {sanitizedBanner && (
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
              (typeof settings?.forumName === 'object' && settings.forumName !== null)
                ? (settings.forumName[lang] || settings.forumName.en || 'Aerun Forum')
                : (settings?.forumName || 'Aerun Forum')
            }
          </p>
        </Container>
      </footer>
    </>
  );
};

export default Layout;
