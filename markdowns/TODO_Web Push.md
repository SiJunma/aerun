# Концепция автономного PWA и Web Push уведомлений для Aerun

**Статус:** Архитектурная спецификация и план внедрения  
**Стек:** Go 1.27 (PocketBase v0.40.4) + React 19 (Vite) + Service Worker (PWA, Badging API, Web Share API, Web Push VAPID)  
**Главная цель:** Превратить веб-форум Aerun в полноценное автономное прогрессивное веб-приложение (PWA) с нативным пользовательским опытом на смартфонах и ПК: установка на рабочий стол, бейджи непрочитанных сообщений на иконке приложения, системное меню «Поделиться» и доставка Push-уведомлений без зависимости от сторонних облачных сервисов.

---

## 0. Архитектурный аудит кодовой базы

> **Вывод проверки:** Реализуемо на 100%. В проекте уже заложены все ключевые архитектурные узлы, к которым подключаются PWA-возможности.

| Механизм | Текущее состояние в кодовой базе | Точка интеграции |
| :--- | :--- | :--- |
| **Счётчик непрочитанного** | В `TitleProvider.jsx` уже рассчитывается единый `unreadCount = (userCount + hasDmUnread)`, рисуется на favicon и в заголовке вкладки. | **Badging API:** вызов `navigator.setAppBadge(unreadCount)` в том же эффекте `TitleProvider.jsx` + в Service Worker. |
| **Копирование ссылок** | В `TopicPostCard.jsx` (строка ~280) реализован клик по таймстампу с прямым вызовом `navigator.clipboard.writeText`. | **Web Share API:** абстракция в `src/utils/share.js` с приоритетом `navigator.share()` и fallback на буфер. Кнопка «Поделиться» в `TopicHeader` и `TopicActionsBar`. |
| **Рождение уведомлений** | `createNotification()` в `notifications.go` (строка ~294) — единственный серверный конструктор in-app уведомлений. | **Push Trigger:** вызов `maybeEnqueuePushNotification()` внутри той же транзакции БД. |
| **Outbox-очередь** | Коллекция `outbox_events` + cron-воркер `OutboxWorker` (1-минутный тик) с поддержкой retry и экспоненциального backoff. | **Push Dispatch:** добавление обработчика `push:notification` и `push:dm` в `OutboxWorker.ProcessBatch()`. |
| **Проверка онлайна** | `isMemberOnline()` в `dms.go` и `isMemberRecentlyActive()` в `presence.go` (15-минутное окно активности от реального клика). | **Push Guard:** Push отправляется только тогда, когда адресат неактивен на сайте (чтобы не спамить во время чтения темы). |
| **Настройки пользователя** | JSON-поле `users.settings` и паттерн чтения преференсов `emailNotificationsPref()`. | **Push Preferences:** аналогичное чтение `settings.push_notifications.*` для гранулярного отключения тем/ЛС/цитат. |
| **Realtime-шина** | Коллекция `realtime_signals` + SSE поток для открытых вкладок. | **Кооперация:** SSE обновляет UI открытой вкладки мгновенно; Web Push доставляет системное уведомление на спящий телефон/ПК. |
| **PWA Manifest и SW** | Отсутствуют (`public/` содержит только favicon и роботс, в `index.html` нет ссылок на манифест). | **PWA Foundation:** создание `manifest.webmanifest`, `sw.js` и регистрация в `main.jsx`. |

---

## 1. Полноценный PWA (Progressive Web App)

Aerun трансформируется в устанавливаемое веб-приложение, работающее в отдельном окне без адресной строки браузера на Android, iOS (Safari PWA), macOS и Windows.

### 1.1 Web App Manifest (`public/manifest.webmanifest`)

```json
{
  "name": "Aerun — Текстовая ролевая игра",
  "short_name": "Aerun",
  "description": "Форум текстовых ролевых игр, авторского творчества и общения",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#12121c",
  "theme_color": "#4f46e5",
  "lang": "ru",
  "icons": [
    {
      "src": "/icons/icon-192x192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-maskable-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ],
  "shortcuts": [
    {
      "name": "Новые ответы",
      "short_name": "Ответы",
      "description": "Просмотр новых ответов в темах",
      "url": "/new-replies",
      "icons": [{ "src": "/icons/shortcut-replies.png", "sizes": "96x96" }]
    },
    {
      "name": "Личные сообщения",
      "short_name": "Диалоги",
      "description": "Открыть входящие сообщения",
      "url": "/messages",
      "icons": [{ "src": "/icons/shortcut-messages.png", "sizes": "96x96" }]
    }
  ]
}
```

### 1.2 Мета-теги для iOS Safari PWA (`index.html`)

Apple iOS требует явные теги для активации полноэкранного автономного режима:

```html
<!-- PWA Web App Manifest -->
<link rel="manifest" href="/manifest.webmanifest" />

<!-- iOS Safari PWA Support -->
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Aerun" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
```

### 1.3 Жизненный цикл Service Worker (`public/sw.js`)

Кэширование строится по правилу: **API-запросы и мутации никогда не кэшируются Service Worker'ом** (PocketBase SSE и REST идут напрямую в сеть). SW обслуживает только статические ресурсы (шрифты, смайлы, иконки, базовую разметку), события push, клики и бейджи:

```javascript
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
});
```

### 1.4 UX установки приложения (Install Prompt)

- **На Android и десктопных Chromium-браузерах:** Перехватывается событие `beforeinstallprompt`. В шапке профиля или навбаре показывается аккуратная кнопка «Установить приложение Aerun».
- **На iOS (Safari):** Так как Apple запрещает программный вызов диалога установки, проверяется режим отображения (`window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone`). Если сайт открыт в Safari на iPhone, в блоке настроек показывается пошаговая плашка: *«Нажмите «Поделиться» ➔ «На экран «Домой»»*.

---

## 2. Бейдж-индикатор на иконке (Badging API)

**Стандарт:** W3C Badging API (`navigator.setAppBadge` / `navigator.clearAppBadge`).  
**Поведение:** Красный индикатор с числом непрочитанных сообщений/ответов отображается на иконке приложения на рабочем столе смартфона, в доке macOS или на панели задач Windows.

```
┌─────────┐
│  Aerun  │ (3) ◄── Красный кружок с числом непрочитанных ЛС и упоминаний
└─────────┘
```

### 2.1 Интеграция в `TitleProvider.jsx` (активное приложение)

В `src/contexts/TitleProvider.jsx` уже сосредоточена логика подсчёта непрочитанного контента:
- `unreadCount = (countsEligible ? userCount : 0) + hasDmUnread`
- Сейчас этот счётчик выводится в `document.title` и рисуется на Canvas фавиконки.

Сюда же добавляется синхронизация с системным бейджем:

```javascript
// Внутри useEffect обновления заголовка и фавиконки в TitleProvider.jsx:
const syncAppBadge = (count) => {
  if ('setAppBadge' in navigator) {
    if (count > 0) {
      navigator.setAppBadge(count).catch((err) => {
        console.debug('[Badging API] setAppBadge suppressed:', err);
      });
    } else {
      navigator.clearAppBadge().catch((err) => {
        console.debug('[Badging API] clearAppBadge suppressed:', err);
      });
    }
  }
};

syncAppBadge(unreadCount);
```

### 2.2 Фоновое обновление бейджа в Service Worker (`sw.js`)

Когда приложение закрыто, а на устройство прилетает Push-сообщение, Service Worker обновляет системный бейдж на иконке устройства без открытия приложения:

```javascript
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
```

При клике на уведомление (`notificationclick`) бейдж сбрасывается или уменьшается:

```javascript
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
```

---

## 3. Нативное меню «Поделиться» (Web Share API)

**Стандарт:** W3C Web Share API (`navigator.share`).  
**Цель:** При нажатии кнопки «Поделиться» на телефоне или планшете открывать нативное меню операционной системы (Telegram, WhatsApp, ВКонтакте, системная почта, быстрый AirDrop / Quick Share), а на устройствах без поддержки Web Share API — бесшовно копировать ссылку в буфер обмена с всплывающим Toast-уведомлением.

### 3.1 Единый модуль: `src/utils/share.js`

Создаётся централизованная утилита для всего приложения:

```javascript
/**
 * Вызывает нативное меню "Поделиться" операционной системы
 * либо копирует ссылку в буфер обмена при отсутствии поддержки.
 *
 * @param {Object} options
 * @param {string} options.title Заголовок темы или имя автора
 * @param {string} options.text Краткое описание или текст поста
 * @param {string} options.url Абсолютная ссылка
 * @param {Function} [options.onCopied] Callback при успешном копировании в буфер
 * @param {Function} [options.onError] Callback при ошибке
 */
export async function shareOrCopy({ title, text, url, onCopied, onError }) {
  const shareData = {
    title: title || document.title,
    text: text ? text.slice(0, 150) : undefined,
    url: url || window.location.href,
  };

  if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
    try {
      await navigator.share(shareData);
      return { shared: true };
    } catch (err) {
      // Пользователь закрыл системное меню шеринга (AbortError) — это не ошибка приложения
      if (err.name === 'AbortError') {
        return { aborted: true };
      }
      console.warn('[WebShare] Failed, falling back to clipboard:', err);
    }
  }

  // Fallback: запись в буфер обмена
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(shareData.url);
    } else {
      // Резервный метод для устаревших вебвью
      const textArea = document.createElement('textarea');
      textArea.value = shareData.url;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
    onCopied?.();
    return { copied: true };
  } catch (clipErr) {
    console.error('[WebShare] Clipboard fallback failed:', clipErr);
    onError?.(clipErr);
    return { error: clipErr };
  }
}
```

### 3.2 Точки внедрения в интерфейс

1. **В шапку темы (`TopicHeader.jsx`) и нижнюю панель (`TopicActionsBar.jsx`):**
   - Добавляется стильная кнопка с иконкой `Share2` (из пакета `lucide-react`, который уже используется в проекте).
   - При клике передаётся: `title = topic.title`, `url = window.location.href`.
   - Всплывает системное окно ОС: пользователь в один клик отправляет ссылку в диалог Telegram или заметки.
2. **В каждый отдельный пост темы (`TopicPostCard.jsx`):**
   - Сейчас в строках 275–282 клик по дате поста просто копирует ссылку:
     ```javascript
     const url = `${window.location.origin}/topic/${topicId}?post=${post.id}`;
     navigator.clipboard.writeText(url);
     showToast?.(lang === 'ru' ? 'Ссылка скопирована!' : 'Link copied!', 'success');
     ```
   - Заменяется на вызов `shareOrCopy({ title: topic.title, url, onCopied: () => showToast(...) })`. На телефоне открывается системное меню с прямой ссылкой на конкретный пост.
3. **В профиль пользователя (`ProfilePage.jsx`):**
   - Кнопка «Поделиться профилем» рядом с контактами.

---

## 4. Автономные Web Push уведомления (VAPID)

Связь между бэкендом форума и устройством пользователя осуществляется через стандартные шлюзы доставки (Google FCM / Apple APNs / Mozilla Push Service) по протоколу RFC 8291/RFC 8292. Никаких внешних облачных аккаунтов или сторонних ключей не требуется — PocketBase подписывает пакеты своим локальным ECDSA-ключом.

```
[Aerun Go Backend] ──(VAPID HTTP POST)──> [Push Service (Apple/Google)] ──> [Устройство]
```

### 4.1 Схема базы данных (PocketBase)

#### Коллекция `push_subscriptions`
Создаётся новой Go-миграцией `1780100000_push_subscriptions.go`:

| Поле | Тип | Описание |
| :--- | :--- | :--- |
| `user_id` | Relation (`users`) | Владелец подписки. Очищается при удалении пользователя в `admin_user_delete_purge.go`. |
| `endpoint` | Text (Unique) | Уникальный URL устройства от push-службы браузера. Индексирован. |
| `p256dh` | Text | Публичный ключ шифрования устройства (base64url). |
| `auth_key` | Text | Секретный ключ аутентификации устройства (base64url). Назван `auth_key`, так как `auth` зарезервировано PocketBase. |
| `user_agent` | Text | Название браузера/ОС (для отображения в списке подключенных устройств в профиле). |
| `created` / `updated` | Autodate | Системные временные метки. |

Коллекция закрыта от браузера (`CreateRule = nil`, `ListRule = nil` и т.д.). Все операции выполняются исключительно через эндпоинты `/api/aerun/me/push/*`.

#### Поля в коллекции `forum_settings`
В синглтон-запись `forumsettings01` добавляются:
- `vapid_public_key` (Text) — публичный ключ VAPID, отдается фронтенду для регистрации подписки.
- `vapid_private_key` (Text) — приватный ключ, хранится в зашифрованном виде на сервере.
- `push_enabled` (Bool) — мастер-выключатель Web Push на уровне всего форума.

### 4.2 Генерация ключей VAPID
При первом старте бэкенда с новой миграцией, если `vapid_public_key` пуст:
1. Вызывается `webpush.GenerateVAPIDKeys()` из библиотеки `github.com/SherClockHolmes/webpush-go`.
2. Ключи сохраняются в `forumsettings01`.
3. Публичный ключ автоматически включается в публичный ответ `GET /api/aerun/settings`.

### 4.3 Outbox-архитектура отправки

Отправка Push-уведомлений интегрируется в существующую транзакционную Outbox-очередь Aerun (`outbox_events`):

```
Мутация в БД (новый пост / ЛС)
   │
   ├── [В той же транзакции] ➔ Сохранение поста/сообщения
   ├── [В той же транзакции] ➔ createNotification() ➔ запись in-app уведомления
   ├── [В той же транзакции] ➔ publishSignal() ➔ SSE сигнал для активных вкладок
   │
   └── [В той же транзакции] ➔ maybeEnqueuePushNotification()
                                  │
                                  ├─ Проверка: получатель оффлайн? (!isMemberOnline)
                                  ├─ Проверка: настройка push включена в профиле?
                                  │
                                  └─ enqueueOutboxEvent(txApp, dedupeKey, "push:notification", payload)
```

#### Обработка в `OutboxWorker` (асинхронно, вне транзакции)
1. Каждую минуту тикает `registerOutboxWorkerCron()`.
2. Воркер выбирает события со статусом `pending`.
3. Для событий типа `push:notification` и `push:dm`:
   - Выбираются все активные устройства из `push_subscriptions` для данного `recipient_id`.
   - Формируется JSON payload (заголовок, текст, URL перехода, актуальный `badge_count`).
   - Пакет шифруется и отправляется на `endpoint`.
   - Если Push-сервер возвращает `410 Gone` или `404 Not Found` (пользователь удалил сайт или сбросил разрешения), подписка **немедленно удаляется** из базы SQLite.
   - Если сервер временно недоступен (5xx) — событие переходит в режим экспоненциального retry (уже заложенный механизм в `outbox.go`).

### 4.4 Защита от спама и учет статуса присутствия
Push-уведомления отправляются только тогда, когда пользователь **не видит экран форума**:
- Если получатель прямо сейчас находится на сайте (`isMemberOnline() == true` в `dms.go`), системный push не ставится в очередь — пользователь получает мгновенный SSE-сигнал в интерфейсе и звуковое оповещение.
- Пользователь может переопределить это поведение в настройках («Присылать Push всегда, даже если я на сайте»).

---

## 5. UI/UX в профиле пользователя (`ProfilePage.jsx`)

В профиле в табе «Настройки» создается полноценный блок управления PWA и уведомлениями.

### 5.1 Статусы текущего устройства
- 🟢 **Push-уведомления активны** — Устройство успешно зарегистрировано в базе.
- 🟡 **Не настроено** — Браузер поддерживает PWA/Push, но подписка еще не включена.
- 🔴 **Заблокировано в браузере** — Пользователь нажал «Запретить». Отображается подсказка, как сбросить разрешение в замке адресной строки.
- ⚪ **Требуется установка на экран «Домой» (iOS)** — Показывается в Safari на iPhone, если приложение не запущено как PWA.

### 5.2 Управление подключенными устройствами
Таблица зарегистрированных устройств пользователя:
```
┌────────────────────────────────────────────────────────┐
│ Мои устройства с Push-уведомлениями                     │
├────────────────────────────────────────────────────────┤
│ 📱 Safari (iPhone 15, iOS 17.4)   • Активен • [Отвязать]│
│ 💻 Chrome (Windows 11)            • Активен • [Отвязать]│
└────────────────────────────────────────────────────────┘
```
Пользователь может в один клик удалить старый телефон или потерянное устройство.

### 5.3 Гранулярные переключатели уведомлений
По аналогии с существующими email-переключателями:
- 🔘 Личные сообщения (ЛС)
- 🔘 Новые ответы в отслеживаемых темах
- 🔘 Упоминания вашего ника и цитирование постов
- 🔘 Изменения репутации

---

## 6. Пошаговый план внедрения (Plan of Attack)

### Фаза 1: PWA Foundation (Манифест, SW, Badging API, Web Share)

| # | Задача | Файлы | Описание |
|---|---|---|---|
| 1.1 | PWA Manifest | `public/manifest.webmanifest` | Создание манифеста с иконками, цветами темы и ярлыками быстрого доступа. |
| 1.2 | Мета-теги в HTML | `index.html` | Подключение манифеста, иконки `apple-touch-icon`, мета-тегов `apple-mobile-web-app-*`. |
| 1.3 | Базовый Service Worker | `public/sw.js` | Кэширование статики, обработчики fetch (Network First для данных, Cache First для смайлов). |
| 1.4 | Регистрация SW | `src/main.jsx` | Безопасная регистрация `/sw.js` при загрузке приложения. |
| 1.5 | Модуль Web Share | `src/utils/share.js` | Реализация `shareOrCopy()` с поддержкой `navigator.share` и fallback на буфер обмена. |
| 1.6 | Кнопка «Поделиться» в теме | `src/components/topic/TopicHeader.jsx`, `TopicActionsBar.jsx` | Добавление кнопки расшаривания темы через нативное меню ОС. |
| 1.7 | Шеринг поста | `src/components/topic/TopicPostCard.jsx` | Интеграция `shareOrCopy` в клик по ссылке на конкретный пост. |
| 1.8 | Интеграция Badging API | `src/contexts/TitleProvider.jsx` | Вызов `navigator.setAppBadge(unreadCount)` / `clearAppBadge()` при изменении счётчика непрочитанного. |

### Фаза 2: Бэкенд и база данных (Go + PocketBase)

| # | Задача | Файлы | Описание |
|---|---|---|---|
| 2.1 | Добавить зависимость `webpush-go` | `backend/go.mod`, `backend/go.sum` | Подключение чистого Go-модуля `github.com/SherClockHolmes/webpush-go`. |
| 2.2 | Миграция базы данных | `backend/internal/migrations/1780100000_pwa_push_subscriptions.go` | Создание коллекции `push_subscriptions`, добавление полей `vapid_public_key`, `vapid_private_key`, `push_enabled` в `forum_settings`. |
| 2.3 | Структуры и VAPID логика | `backend/internal/platform/pocketbase/forum_settings.go` | Расширение структуры `forumSettings`, автогенерация ключей при их отсутствии. |
| 2.4 | Публикация VAPID ключа | `backend/internal/platform/pocketbase/global_settings.go` | Отдача `vapid_public_key` в открытом эндпоинте `GET /api/aerun/settings`. |
| 2.5 | Обработчики подписки | `backend/internal/platform/pocketbase/push_notifications.go` | Эндпоинты `POST/DELETE /api/aerun/me/push/subscribe`, `GET /api/aerun/me/push/subscriptions`, `DELETE /api/aerun/me/push/subscriptions/{id}`. |
| 2.6 | Регистрация маршрутов | `backend/internal/platform/pocketbase/run.go` | Регистрация push-маршрутов с проверкой авторизации и `enforceIdempotency`. |
| 2.7 | Очистка при удалении аккаунта | `backend/internal/platform/pocketbase/admin_user_delete_purge.go` | Удаление подписок пользователя при удалении его учетной записи. |

### Фаза 3: Очередь отправки и диспетчер (Outbox Integration)

| # | Задача | Файлы | Описание |
|---|---|---|---|
| 3.1 | Функция постановки в очередь | `backend/internal/platform/pocketbase/push_notifications.go` | `maybeEnqueuePushNotification()`: проверка онлайна (`!isMemberOnline`), проверка настроек пользователя, вставка в `outbox_events`. |
| 3.2 | Триггер постов и тем | `backend/internal/platform/pocketbase/notifications.go` | Вызов `maybeEnqueuePushNotification()` внутри транзакции `createNotification()`. |
| 3.3 | Триггер личных сообщений | `backend/internal/platform/pocketbase/dms.go` | Постановка push-уведомления для DM рядом с `maybeEnqueueDMEmail()`. |
| 3.4 | Расширение OutboxWorker | `backend/internal/platform/pocketbase/outbox.go` | Обработка типов `push:notification` и `push:dm` в `ProcessBatch()`. |
| 3.5 | Диспетчер Web Push | `backend/internal/platform/pocketbase/push_dispatch.go` | Подпись VAPID JWT, HTTP POST к Google/Apple push-сервису, каскадное удаление мертвых токенов при коде 410/404. |

### Фаза 4: Фронтенд-интеграция Push и Настроек

| # | Задача | Файлы | Описание |
|---|---|---|---|
| 4.1 | Обработчики Push в SW | `public/sw.js` | События `push` (показ уведомления + `navigator.setAppBadge`), событие `notificationclick` (фокус/навигация). |
| 4.2 | React-хук управления подпиской | `src/hooks/usePushNotifications.js` | Проверка поддержки браузером, запрос разрешения, подписка через PushManager и отправка на сервер. |
| 4.3 | Настройки Push в профиле | `src/pages/ProfilePage.jsx` | UI-блок: переключатель push, список подключенных устройств, инструкции для iOS/Android. |
| 4.4 | Интеграция с формой настроек | `src/pages/ProfilePage.jsx` | Добавление ключей `push_notifications.*` в `buildAccountForm()` и `buildSettingsPatch()`. |

### Фаза 5: Тестирование и верификация

| # | Задача | Окружение | Проверка |
|---|---|---|---|
| 5.1 | Unit-тесты бэкенда | `go test ./backend/...` | Тесты постановки в очередь, фильтрации по онлайну, генерации VAPID и обработки 410 Gone. |
| 5.2 | Тестирование Web Share | Мобильный Chrome/Safari | Проверка открытия системного меню шеринга темы и отдельного поста; проверка буфера обмена на ПК. |
| 5.3 | Тестирование Badging API | PWA на рабочем столе | Проверка появления цифры непрочитанных на иконке при новом ЛС и её сброс при прочтении. |
| 5.4 | Тестирование Push (Android) | Android Chrome / Firefox | Проверка фоновой доставки push-уведомления при заблокированном телефоне. |
| 5.5 | Тестирование Push (iOS PWA) | iOS Safari Add to Home Screen | Проверка установки на домашний экран, запрос разрешения и фоновая доставка через Apple Push Service (APNs). |

---

## 7. Вопросы безопасности и приватности

1. **Защита личных данных:** Payload уведомления шифруется алгоритмом AES-128-GCM ключами устройства пользователя (`p256dh` и `auth_key`). Ни Apple, ни Google, ни промежуточные узлы сети не имеют доступа к тексту личных сообщений.
2. **Deny-by-default для коллекции подписок:** Браузер не имеет прямых прав записи в `push_subscriptions`. Все добавления и удаления токенов валидируются через серверные сессии.
3. **Безопасность VAPID:** Приватный ключ VAPID генерируется локально, хранится в зашифрованной SQLite-базе PocketBase и никогда не передается клиенту.
4. **Конфиденциальность в спящем режиме:** Если пользователь включит опцию скрытия содержимого в настройках («Скрывать текст в push-уведомлениях»), сервер будет присылать нейтральный текст: *«Новое личное сообщение на форуме Aerun»* без указания автора и текста сообщения.
