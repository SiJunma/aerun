import React, { useState, useEffect, useRef } from 'react';
import { Alert, Button, Container } from 'react-bootstrap';
import { WifiOff, AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { sendApi } from '../../api/pocketbase';

/**
 * ConnectionStatusBanner — Global sticky alert when network or backend connection is lost.
 */
const ConnectionStatusBanner = () => {
  const { lang } = useI18n();
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const disconnectTimerRef = useRef(null);

  useEffect(() => {
    // 1. Browser online/offline event
    const handleBrowserOffline = () => {
      setIsDisconnected(true);
    };
    const handleBrowserOnline = () => {
      checkHealth();
    };

    window.addEventListener('offline', handleBrowserOffline);
    window.addEventListener('online', handleBrowserOnline);

    // 2. Periodic backend health check probe (consolidated via /status)
    let isMounted = true;
    const checkHealth = async () => {
      try {
        await sendApi('/api/aerun/status');
        if (!isMounted) return;
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        setIsDisconnected(false);
        setDismissed(false);
      } catch {
        if (!isMounted) return;
        if (!disconnectTimerRef.current) {
          disconnectTimerRef.current = setTimeout(() => {
            if (isMounted) setIsDisconnected(true);
          }, 4000);
        }
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 25000);

    return () => {
      isMounted = false;
      window.removeEventListener('offline', handleBrowserOffline);
      window.removeEventListener('online', handleBrowserOnline);
      clearInterval(interval);
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
      }
    };
  }, []);

  if (!isDisconnected || dismissed) {
    return null;
  }

  return (
    <div
      className="connection-status-banner py-2 px-3 shadow"
      style={{
        backgroundColor: '#b02a37',
        color: '#ffffff',
        position: 'sticky',
        top: 0,
        zIndex: 1050,
        fontSize: '0.9rem',
        borderBottom: '1px solid rgba(0,0,0,0.2)'
      }}
    >
      <Container className="d-flex flex-wrap align-items-center justify-content-between gap-2 p-0">
        <div className="d-flex align-items-center gap-2">
          <WifiOff size={20} className="flex-shrink-0" />
          <span>
            {lang === 'ru' ? (
              <>
                <strong>Нет связи с сервером.</strong> Проверьте подключение к интернету или попробуйте обновить страницу.
              </>
            ) : (
              <>
                <strong>Connection to server lost.</strong> Please check your internet connection or try refreshing the page.
              </>
            )}
          </span>
        </div>
        <div className="d-flex align-items-center gap-2 ms-auto">
          <Button
            variant="light"
            size="sm"
            onClick={() => window.location.reload()}
            className="d-flex align-items-center gap-1 py-1 px-2 fw-semibold"
            style={{ fontSize: '0.8rem' }}
          >
            <RefreshCw size={12} />
            {lang === 'ru' ? 'Обновить' : 'Refresh'}
          </Button>
          <Button
            variant="link"
            size="sm"
            onClick={() => setDismissed(true)}
            className="text-white p-1 text-decoration-none"
            title={lang === 'ru' ? 'Скрыть предупреждение' : 'Dismiss'}
          >
            <X size={18} />
          </Button>
        </div>
      </Container>
    </div>
  );
};

export default ConnectionStatusBanner;
