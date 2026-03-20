import React from 'react';
import { Card, Button } from 'react-bootstrap';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';

const BannedPage = () => {
  const { logout, settings } = useAuth();
  const { translations } = useI18n();

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
    // No automatic redirection away from BannedPage based on whitelistMode.
    // The user stays here until they logout or are unbanned.
  }, []);

  return (
    <div className="d-flex align-items-center justify-content-center py-5" style={{ minHeight: '60vh' }}>
      <Card style={{ maxWidth: '500px', width: '100%' }} className="p-4 shadow border-danger">
        <Card.Body className="text-center">
          <h2 className="mb-4 text-danger">{t('gatekeeper.banned_title')}</h2>
          <p className="mb-4">
            {t('gatekeeper.banned_message')}
          </p>
          <div className="d-flex justify-content-center">
            <Button variant="outline-danger" onClick={logout}>{t('common.logout')}</Button>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
};

export default BannedPage;
