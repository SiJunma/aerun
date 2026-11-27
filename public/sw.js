const CACHE_NAME = 'aerun-static-v1';
const STATIC_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.jpg',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Стратегия: Network First для страниц, Cache First для локальных ассетов (смайлы, иконки)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Никакого кэширования для API, SSE и запросов мутаций
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  // Смайлики и статические ассеты — Cache First с обновлением в фоне
  if (url.pathname.startsWith('/smiles/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Страницы — Network First с fallback на кэш
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});

// Push-уведомления
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};

  // 1. Показ системной плашки уведомления
  const notificationPromise = self.registration.showNotification(data.title || 'Aerun', {
    body: data.body || '',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/badge-72x72.png',
    data: { url: data.url || '/' },
    tag: data.tag || 'aerun-notification',
    renotify: true
  });

  // 2. Обновление цифры на иконке приложения на рабочем столе
  let badgePromise = Promise.resolve();
  if ('setAppBadge' in navigator && typeof data.badge_count === 'number') {
    badgePromise = navigator.setAppBadge(data.badge_count).catch(() => {});
  }

  event.waitUntil(Promise.all([notificationPromise, badgePromise]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Если вкладка форума уже открыта — фокусируемся на ней и переходим по URL
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      // Если закрыта — открываем новое окно
      return clients.openWindow(targetUrl);
    })
  );
});