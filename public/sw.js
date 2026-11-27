const CACHE_NAME = 'aerun-static-v2';
const MANIFEST_URL = '/api/aerun/manifest.webmanifest';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // The manifest is the source of truth for the icon URLs: they are admin
    // uploads, so their paths cannot be hardcoded here. A single missing
    // file must never fail the install — the old cache.addAll of hardcoded
    // /icons/* paths that did not exist did exactly that, and the worker
    // never activated.
    const urls = ['/'];
    try {
      const res = await fetch(MANIFEST_URL);
      if (res.ok) {
        const manifest = await res.clone().json();
        for (const icon of manifest.icons || []) {
          if (icon && icon.src) urls.push(icon.src);
        }
        await cache.put(MANIFEST_URL, res);
      }
    } catch {
      // No manifest (backend down, first deploy): install anyway.
    }
    await Promise.all(urls.map((url) => cache.add(url).catch(() => {})));
  })());
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

// Стратегия: Network First для страниц, Cache First для смайлов.
// API-запросы и мутации никогда не кэшируются Service Worker'ом (PocketBase
// SSE и REST идут напрямую в сеть) — кроме GET /api/files/, где лежат
// загруженные админом иконки PWA: они идут Network First с fallback на кэш.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') {
    return;
  }

  // Смайлики — Cache First с обновлением в фоне
  if (url.pathname.startsWith('/smiles/')) {
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

  // Никакого кэширования для API, кроме загруженных файлов
  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/files/')) {
    return;
  }

  // Всё остальное, включая /api/files/ — Network First с fallback на кэш
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

// Иконки уведомления — из манифеста (кэш, иначе сеть). Без манифеста
// уведомление всё равно показывается, просто без иконки.
async function manifestIcons() {
  try {
    let res = await caches.match(MANIFEST_URL);
    if (!res) {
      res = await fetch(MANIFEST_URL);
    }
    if (res && res.ok) {
      const manifest = await res.json();
      const icons = manifest.icons || [];
      const icon192 = icons.find((icon) => icon.sizes === '192x192');
      return {
        icon: (icon192 || icons[0] || {}).src || undefined,
        badge: manifest.badge_icon || undefined,
      };
    }
  } catch {
    // No manifest available — the notification still shows.
  }
  return {};
}

// Push-уведомления
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const data = event.data?.json() || {};
    const icons = await manifestIcons();

    // 1. Показ системной плашки уведомления
    const notificationOptions = {
      body: data.body || '',
      data: { url: data.url || '/' },
      tag: data.tag || 'aerun-notification',
      renotify: true,
    };
    if (icons.icon) notificationOptions.icon = icons.icon;
    if (icons.badge) notificationOptions.badge = icons.badge;
    const notificationPromise = self.registration.showNotification(data.title || 'Aerun', notificationOptions);

    // 2. Обновление цифры на иконке приложения на рабочем столе
    let badgePromise = Promise.resolve();
    if ('setAppBadge' in navigator && typeof data.badge_count === 'number') {
      badgePromise = navigator.setAppBadge(data.badge_count).catch(() => {});
    }

    await Promise.all([notificationPromise, badgePromise]);
  })());
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
