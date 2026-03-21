import React from 'react';
import { Card, Button } from 'react-bootstrap';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';

const PendingPage = () => {
  const { logout, profile } = useAuth();
  const { translations } = useI18n(); // Access raw translations if needed, or just force key

  // Force English for this page as requested
  const t = (path) => {
    const keys = path.split('.');
    let result = translations['en'];
    for (const key of keys) {
      if (result) result = result[key];
    }
    return result || path;
  };

  React.useEffect(() => {
    if (profile && profile.status === 'active') {
      window.location.href = '/';
    }
  }, [profile]);

  return (
    <div className="d-flex align-items-center justify-content-center py-5" style={{ minHeight: '60vh' }}>
      <Card style={{ maxWidth: '500px', width: '100%' }} className="p-4 shadow border-warning">
        <Card.Body className="text-center">
          <h2 className="mb-4 text-warning">{t('gatekeeper.pending_title')}</h2>
          <p className="mb-4">
            {t('gatekeeper.pending_message')}
          </p>
          <div className="d-flex justify-content-center gap-3">
            <Button variant="outline-danger" onClick={logout}>{t('common.logout')}</Button>
            <Button variant="primary" onClick={() => window.location.reload()}>{t('common.check_status')}</Button>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
};

export default PendingPage;
