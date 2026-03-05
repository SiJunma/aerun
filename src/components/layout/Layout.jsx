import Navigation from './Navbar';
import { Container } from 'react-bootstrap';
import { useAuth } from '../../contexts/AuthProvider';

const Layout = ({ children }) => {
  const { profile } = useAuth();
  const showFooter = profile?.settings?.show_footer !== false;

  return (
    <>
      <div className="app-wrapper">
        <Navigation />
        <main className="py-2">
          <Container>
            {children}
          </Container>
        </main>
      </div>
      {showFooter && (
        <footer className="footer-custom py-2 text-center">
          <Container>
            <p className="mb-0 small">&copy; {new Date().getFullYear()} Aerun Forum</p>
          </Container>
        </footer>
      )}
    </>
  );
};

export default Layout;
