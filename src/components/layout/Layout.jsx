import Navigation from './Navbar';
import { Container } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';
import { useMemo } from 'react';

const Layout = ({ children }) => {
  const { settings } = useAuth();

  const sanitizedBanner = useMemo(() => {
    if (!settings?.welcomeMessage) return null;
    // Basic sanitization: remove <script> tags and any on* attributes
    try {
      let html = settings.welcomeMessage;
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

  return (
    <>
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
          <p className="mb-0 small">&copy; {new Date().getFullYear()} {settings?.forumName || 'Aerun Forum'}</p>
        </Container>
      </footer>
    </>
  );
};

export default Layout;
