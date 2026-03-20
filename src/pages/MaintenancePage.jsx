import React from 'react';
import { Container, Card, Button } from 'react-bootstrap';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Hammer, LogOut, ChevronLeft } from 'lucide-react';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';

const MaintenancePage = () => {
  const { user, profile, hasPermission, PERMISSIONS, logout, settings } = useAuth();
  const { lang } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (settings && !settings.whitelistMode) {
      navigate('/', { replace: true });
    }
  }, [settings, navigate]);

  // If admin logs in, move them to the forum immediately
  React.useEffect(() => {
    if (user && profile && hasPermission(PERMISSIONS.ADMIN_ACCESS)) {
      navigate('/', { replace: true });
    }
  }, [user, profile, hasPermission, navigate]);

  return (
    <div className="vh-100 d-flex align-items-center justify-content-center bg-dark text-white p-3">
      <Container style={{ maxWidth: '600px' }}>
        <Card className="shadow-lg border-0 text-center p-4 p-md-5" style={{ background: 'rgba(255, 255, 255, 0.05)', backdropFilter: 'blur(20px)', borderRadius: '24px' }}>
          <div className="mb-4">
            <div 
              className="d-inline-flex p-4 rounded-circle mb-4" 
              style={{ background: 'rgba(255, 193, 7, 0.1)', border: '2px solid rgba(255, 193, 7, 0.2)' }}
            >
              <Hammer size={64} className="text-warning" />
            </div>
            <h1 className="fw-bold mb-3 text-white" style={{ fontSize: '2.5rem' }}>
              {lang === 'ru' ? 'Технические работы' : 'Maintenance Mode'}
            </h1>
            <p className="text-muted fs-5 mb-5 px-md-4">
              {lang === 'ru' 
                ? 'На форуме ведутся технические работы. Мы скоро вернемся! Пожалуйста, зайдите позже.' 
                : 'The forum is currently under maintenance. We will be back soon! Please check again later.'}
            </p>
          </div>
          <div className="d-grid gap-3 col-md-8 mx-auto">
            {user ? (
              <Button 
                variant="outline-light" 
                size="lg" 
                className="fw-bold py-3 d-flex align-items-center justify-content-center gap-2 shadow-sm"
                onClick={logout}
                style={{ borderRadius: '12px', transition: 'all 0.3s ease' }}
              >
                <LogOut size={20} />
                {lang === 'ru' ? 'Выйти из аккаунта' : 'Logout and Leave'}
              </Button>
            ) : (
              <Button 
                variant="primary" 
                size="lg" 
                className="fw-bold py-3 d-flex align-items-center justify-content-center gap-2 shadow-sm"
                as={Link}
                to="/login"
                state={{ from: location }}
                style={{ borderRadius: '12px', transition: 'all 0.3s ease' }}
              >
                {lang === 'ru' ? 'Войти как админ' : 'Login as Admin'}
              </Button>
            )}
            <p className="small text-muted mt-3">
              {lang === 'ru' ? 'Только администраторы могут войти в данный момент.' : 'Only administrators can log in at this time.'}
            </p>
          </div>
        </Card>
      </Container>
    </div>
  );
};

export default MaintenancePage;
