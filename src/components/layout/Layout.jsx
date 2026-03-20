import Navigation from './Navbar';
import { Container } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { useMemo } from 'react';
import ForumBackground from './ForumBackground';

const Layout = ({ children }) => {
  const { settings } = useAuth();
  const { lang } = useI18n();

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
