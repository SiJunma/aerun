import React, { useState, useEffect, useRef } from 'react';
import { Alert, Button, Container } from 'react-bootstrap';
import { WifiOff, AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { subscribeToStatus, probeStatus } from '../../api/rtdb-presence';
import { notifyConnectionRestored } from '../../api/connection';

/**
 * ConnectionStatusBanner — Global sticky alert when network or backend connection is lost.
 */
const ConnectionStatusBanner = () => {
  const { lang } = useI18n();
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const disconnectTimerRef = useRef(null);

  // Announce the recovery exactly once per transition, not on every passing probe.
  // The banner is mounted globally, so it is the only component that knows the
  // backend came back — without this signal nothing re-runs the reads that failed
  // while we were down, and the page keeps showing the empty state it settled on.
  const wasDisconnectedRef = useRef(false);

  useEffect(() => {
    // 1. Browser online/offline event
    const handleBrowserOffline = () => {
      setIsDisconnected(true);
    };
    const handleBrowserOnline = () => {
      // Coming back is the moment a stale "disconnected" verdict is most
      // likely, so probe immediately rather than waiting for the next tick.
      probeStatus();
    };

    window.addEventListener('offline', handleBrowserOffline);
    window.addEventListener('online', handleBrowserOnline);

    // 2. Backend health, from the SHARED /api/aerun/status snapshot.
    //
    // This banner used to run its own 25-second interval against that endpoint
    // while the presence module ran a 20-second one — two loops, one endpoint,
    // and the second one existed only to decide whether to show a red strip.
    // Subscribing to the same resource removes the duplicate entirely, and
    // brings the two clocks into agreement: the banner can no longer disagree
    // with the online list it sits above.
    let isMounted = true;
    const onStatus = (_snapshot, error) => {
      if (!isMounted) return;
      if (!error) {
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        setIsDisconnected(false);
        setDismissed(false);

        // Only on a real offline→online transition. This succeeds most of the
        // time, so announcing unconditionally would refetch the whole app every
        // twenty seconds.
        if (wasDisconnectedRef.current) {
          wasDisconnectedRef.current = false;
          notifyConnectionRestored();
        }
        return;
      }
      // A single failed probe is not a disconnection — a member on a flaky
      // mobile connection should not be shown a red banner for one dropped
      // request. Four seconds of continuous failure is the same threshold this
      // component always used.
      if (!disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => {
          if (isMounted) {
            setIsDisconnected(true);
            wasDisconnectedRef.current = true;
          }
        }, 4000);
      }
    };

    const unsubscribe = subscribeToStatus(onStatus);

    return () => {
      isMounted = false;
      window.removeEventListener('offline', handleBrowserOffline);
      window.removeEventListener('online', handleBrowserOnline);
      unsubscribe();
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
            className="btn-dismiss p-1"
            title={lang === 'ru' ? 'Скрыть предупреждение' : 'Dismiss'}
            aria-label={lang === 'ru' ? 'Скрыть предупреждение' : 'Dismiss'}
          >
            <X size={18} />
          </Button>
        </div>
      </Container>
    </div>
  );
};

export default ConnectionStatusBanner;
