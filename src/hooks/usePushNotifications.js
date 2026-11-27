import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthProvider';

const VAPID_PUBLIC_KEY_URL = '/api/aerun/me/push/vapid-public-key';
const SUBSCRIBE_URL = '/api/aerun/me/push/subscribe';
const UNSUBSCRIBE_URL = '/api/aerun/me/push/subscribe';
const SUBSCRIPTIONS_URL = '/api/aerun/me/push/subscriptions';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * usePushNotifications manages Web Push subscription for the current user.
 *
 * Returns:
 *   { supported, subscribing, subscribed, devices, subscribe, unsubscribe, error }
 *
 *   supported   — boolean, true if the browser supports Push API + PushManager
 *   subscribing — boolean, true while a subscribe/unsubscribe call is in flight
 *   subscribed  — boolean, true if at least one device is registered
 *   devices     — array of { id, endpoint, user_agent, created, updated }
 *   subscribe() — requests permission and subscribes the current device
 *   unsubscribe() — removes a device subscription by id or endpoint
 *   error       — last error message, if any
 */
export function usePushNotifications() {
  const { user, token } = useAuth();
  const [supported, setSupported] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSupported(
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }, []);

  const loadDevices = useCallback(async () => {
    if (!user || !supported) return;
    try {
      const res = await fetch(SUBSCRIPTIONS_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setDevices(data.items || []);
      setSubscribed((data.items || []).length > 0);
    } catch (err) {
      console.warn('[usePushNotifications] loadDevices failed:', err);
    }
  }, [user, token, supported]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const subscribe = useCallback(async () => {
    if (!supported || !user) {
      setError('Push API не поддерживается браузером');
      return false;
    }

    setSubscribing(true);
    setError(null);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError('Разрешение на уведомления не предоставлено');
        return false;
      }

      const keyRes = await fetch(VAPID_PUBLIC_KEY_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!keyRes.ok) {
        setError('Не удалось получить ключ VAPID');
        return false;
      }
      const { publicKey } = await keyRes.json();
      if (!publicKey) {
        setError('VAPID ключ не настроен на сервере');
        return false;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subRes = await fetch(SUBSCRIBE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          p256dhKey: btoa(
            String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))
          ),
          authKey: btoa(
            String.fromCharCode(...new Uint8Array(subscription.getKey('auth')))
          ),
          userAgent: navigator.userAgent,
        }),
      });

      if (!subRes.ok) {
        setError('Не удалось зарегистрировать подписку на сервере');
        return false;
      }

      await loadDevices();
      return true;
    } catch (err) {
      console.error('[usePushNotifications] subscribe failed:', err);
      setError(err.message || 'Неизвестная ошибка подписки');
      return false;
    } finally {
      setSubscribing(false);
    }
  }, [user, token, supported, loadDevices]);

  const unsubscribe = useCallback(async (idOrEndpoint) => {
    if (!user) return false;

    setSubscribing(true);
    setError(null);

    try {
      let res;
      if (idOrEndpoint && idOrEndpoint.startsWith('http')) {
        res = await fetch(UNSUBSCRIBE_URL, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ endpoint: idOrEndpoint }),
        });
      } else {
        res = await fetch(`${SUBSCRIPTIONS_URL}/${idOrEndpoint}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      if (!res.ok) {
        setError('Не удалось отписаться от уведомлений');
        return false;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        if (idOrEndpoint && idOrEndpoint.startsWith('http')) {
          if (subscription.endpoint === idOrEndpoint) {
            await subscription.unsubscribe();
          }
        } else {
          await subscription.unsubscribe();
        }
      }

      await loadDevices();
      return true;
    } catch (err) {
      console.error('[usePushNotifications] unsubscribe failed:', err);
      setError(err.message || 'Неизвестная ошибка отписки');
      return false;
    } finally {
      setSubscribing(false);
    }
  }, [user, token, loadDevices]);

  return {
    supported,
    subscribing,
    subscribed,
    devices,
    subscribe,
    unsubscribe,
    error,
  };
}

export default usePushNotifications;