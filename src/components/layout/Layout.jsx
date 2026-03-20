import Navigation from './Navbar';
import { Container } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { useMemo } from 'react';

const Layout = ({ children }) => {
  const { settings } = useAuth();
  const { lang } = useI18n();

  const sanitizedBanner = useMemo(() => {
    if (!settings?.welcomeMessage) return null;
    // Basic sanitization: remove <script> tags and any on* attributes
    try {
      let rawHtml = '';
      if (typeof settings.welcomeMessage === 'object') {
        rawHtml = settings.welcomeMessage[lang] || settings.welcomeMessage.en || '';
      } else {
        rawHtml = settings.welcomeMessage;
      }

      if (!rawHtml) return null;

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
  }, [settings?.welcomeMessage]);

  const getResponsiveSrcSet = (url) => {
    if (!url || typeof url !== 'string') return '';
    if (url.includes('images.unsplash.com')) {
      const baseUrl = url.split('?')[0];
      const params = new URLSearchParams(url.split('?')[1] || '');
      params.delete('w');
      params.set('auto', 'format');
      params.set('fit', 'crop');
      params.set('q', '80');

      return [600, 1000, 1400, 2000]
        .map(w => {
          params.set('w', w.toString());
          return `${baseUrl}?${params.toString()} ${w}w`;
        })
        .join(', ');
    }
    return url;
  };

  return (
    <>
      <style>{`
        .forum-bg-img {
          width: 100%;
          height: 100vh;
          position: fixed;
          top: 0;
          left: 0;
          z-index: -1;
          object-fit: cover;
          object-position: top;
          opacity: 0.5;
          pointer-events: none;
          display: none;
          visibility: hidden;
        }
        body[data-theme="dark"] #bg_forum_picture__dark .forum-bg-img,
        body[data-theme="light"] #bg_forum_picture__light .forum-bg-img,
        body[data-theme="neutral"] #bg_forum_picture__neutral .forum-bg-img {
          display: block;
          visibility: visible;
        }
      `}</style>

      {settings?.bgNeutral && (
        <picture id="bg_forum_picture__neutral">
          <source srcSet={getResponsiveSrcSet(settings.bgNeutral)} sizes="100vw" />
          <img src={settings.bgNeutral} alt="" className="forum-bg-img" />
        </picture>
      )}
      {settings?.bgDark && (
        <picture id="bg_forum_picture__dark">
          <source srcSet={getResponsiveSrcSet(settings.bgDark)} sizes="100vw" />
          <img src={settings.bgDark} alt="" className="forum-bg-img" />
        </picture>
      )}
      {settings?.bgLight && (
        <picture id="bg_forum_picture__light">
          <source srcSet={getResponsiveSrcSet(settings.bgLight)} sizes="100vw" />
          <img src={settings.bgLight} alt="" className="forum-bg-img" />
        </picture>
      )}

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
              typeof settings?.forumName === 'object' 
                ? (settings.forumName[lang] || settings.forumName.en) 
                : (settings?.forumName || 'Aerun Forum')
            }
          </p>
        </Container>
      </footer>
    </>
  );
};

export default Layout;
