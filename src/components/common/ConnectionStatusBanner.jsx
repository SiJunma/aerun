import React, { useState, useEffect, useRef } from 'react';
import { Alert, Button, Container } from 'react-bootstrap';
import { WifiOff, AlertTriangle, RefreshCw, X } from 'lucide-react';
import { ref, onValue } from 'firebase/database';
import { rtdb } from '../../../firebase';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * ConnectionStatusBanner — Global sticky alert when Firebase/network connection is lost.
 * Specifically alerts users about potential VPN/ISP blockades (especially for Russian users connecting to Google/Firebase).
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
      // Don't immediately set disconnected to false until RTDB verifies, but clear offline flag
    };

    window.addEventListener('offline', handleBrowserOffline);
    window.addEventListener('online', handleBrowserOnline);

    // 2. Firebase RTDB connection state
    let unsubConnected = () => {};
    if (rtdb) {
      try {
        const connectedRef = ref(rtdb, '.info/connected');
        unsubConnected = onValue(connectedRef, (snap) => {
          const connected = snap.val() === true;
          if (connected) {
            if (disconnectTimerRef.current) {
              clearTimeout(disconnectTimerRef.current);
              disconnectTimerRef.current = null;
            }
            setIsDisconnected(false);
            setDismissed(false); // Reset dismissal on successful reconnect
          } else {
            // Grace period: wait 4 seconds of continuous disconnection before alarming the user
            if (!disconnectTimerRef.current) {
              disconnectTimerRef.current = setTimeout(() => {
                setIsDisconnected(true);
              }, 4000);
            }
          }
        });
      } catch (e) {
        console.warn('[ConnectionStatusBanner err]', e);
      }
    }

    return () => {
      window.removeEventListener('offline', handleBrowserOffline);
      window.removeEventListener('online', handleBrowserOnline);
      unsubConnected();
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
