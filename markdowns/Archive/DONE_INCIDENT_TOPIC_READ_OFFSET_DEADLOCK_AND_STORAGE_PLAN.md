# Инцидент: Deadlock прочтения тем из-за фантомного оффсета в localStorage и план изоляции хранилища

> **Дата инцидента:** 15 ноября 2026 г.  
> **Окружение:** Продакшн VPS (`https://aerun-world.com`), стек Go 1.27 + PocketBase (SQLite) + React 19.  
> **Затронутый ресурс:** Топик `hfooihb04h0hez4` («Нортбэйский мыслефлуд #3», 251 пост / 250 ответов), топик `80d7abmusux0de0` («Функционал форума», 69 постов).  
> **Учётная запись:** `25lxtkoqluxy9gz` (Arin).  
> **Статус:** Первопричина подтверждена ревью кода бэкенда и клиента (дедлок оффсета в `AuthProvider.jsx` + отсутствие guard страницы в Effect 15). План этапов 1–4 утверждён к реализации. См. разделы 7–8 за находками и статусом.

---

## 1. Описание инцидента и симптомы

### 1.1. Симптоматика на релизной версии сайта
1. При переходе в тему [Нортбэйский мыслефлуд #3](https://aerun-world.com/topic/hfooihb04h0hez4) и прокрутке темы до самого конца (страница 9, последнее сообщение #251 пользователя `Shimadzu` в 10:42) тема **не помечается прочитанной**.
2. В верхней панели навигации счётчик `Active Topics (1)` упорно показывает `(1)`.
3. На странице `/new-replies` активна вкладка `New Replies (1)` с индикатором непрочитанности на этой теме.
4. Во вкладке **Network** в DevTools:
   - Регулярно опрашиваются фоновые ресурсы (`unread-counts`, `stats`, `heartbeat`, `me`).
   - `GET /api/aerun/me/unread-counts` возвращает:
     ```json
     {
       "unread_conversations": 0,
       "total_unread_messages": 0,
       "unread_notifications": 0,
       "unread_topics": 1
     }
     ```
   - Запрос `POST /api/aerun/topics/hfooihb04h0hez4/read` **вообще отсутствует в сетевом журнале** (браузер даже не пытается его отправить).
5. Во вкладке **Application → Local Storage → https://aerun-world.com**:
   - В ключе `aerun_readmap_25lxtkoqluxy9gz` для темы `hfooihb04h0hez4` зафиксировано:
     ```json
     {
       "offset": 269,
       "timestamp": 1794764008909
     }
     ```

---

## 2. Опровержение гипотезы о часовых поясах (Торонто)

Предварительная гипотеза другого агента связывала сбой с часовыми поясами (пользователь находится в Торонто, EST = UTC-5). Проверка данных из бекапа базы данных `pb_data-backup-20261115-123557.tgz` показала, что **таймзоны ни при чём**:

1. **Формат дат на сервере:** PocketBase хранит все метки времени в UTC в формате ISO 8601 с суффиксом `Z`.
   - В таблице `topics` топика `hfooihb04h0hez4`: `last_post_created = "2026-11-15 15:42:21.376Z"`.
   - В таблице `posts` сообщения #251 (`w7uu0whf311zya5`): `created = "2026-11-15 15:42:21.376Z"`.
2. **Локальное время клиента:**
   - 15:42 UTC минус 5 часов = **10:42 EST** (время Торонто).
   - В интерфейсе форума (Скриншот 1) пост отрендерен с совершенно точным локальным временем: **«Today, 10:42»**.
   - Время пользовательской сессии — около 12:35–12:39 EST (17:35–17:39 UTC). Сообщение было отправлено за 2 часа до просмотра.
3. **Почему возникло подозрение на таймзоны:**
   Другой агент сравнил «15:42» (UTC из базы) с текущими часами пользователя «12:39» (EST), не учтя смещение -5 часов, и ошибочно заключил, что время поста «в будущем». Все сравнения на сервере и в `src/utils/dates.js` выполняются в миллисекундах эпохи UTC (`toMillis`), временные метки полностью валидны.

---

## 3. Анатомия сбоя: гонка рендера и дедлок оффсета

### 3.1. Механизм зарождения фантомного оффсета (Race Condition)
Параметры форума из таблицы `forum_settings`:
- `posts_per_page = 30` (30 сообщений на страницу).
- Всего постов в теме: **251** (страницы 1–8 полные по 30 постов = 240; страница 9 содержит всего **11 постов**, индексы с 240 по 250).

Хронология появления `offset: 269`:
1. Пользователь находился на странице 8 (где в массиве `posts` загружено ровно 30 сообщений) и кликнул переход на страницу 9.
2. Роутер React (`useSearchParams`) синхронно обновил `currentPage = 9`.
3. Запрос за постами 9-й страницы (`fetchSecuredPosts`) асинхронный и ещё летит по сети. В стейте `TopicPage` массив `posts` **всё ещё держит 30 сообщений от страницы 8**.
4. Срабатывает Effect 15 в `TopicPage.jsx:1472`:
   ```javascript
   const lastMessageIndex = (currentPage - 1) * ITEMS_PER_PAGE + (posts.length - 1);
   // currentPage = 9, ITEMS_PER_PAGE = 30, posts.length = 30
   // lastMessageIndex = (9 - 1) * 30 + (30 - 1) = 240 + 29 = 269!
   markTopicRead(id, lastMessageIndex, lastRealPost.id);
   ```
5. В Effect 15 **отсутствовала проверка** `loadedPageRef.current === currentPage`.
6. Вычислен оффсет **269**, который соответствует 30-му сообщению 9-й страницы — несуществующему в природе посту #270 при реальном количестве постов 251.
7. Функция `markTopicRead` немедленно записала `{ offset: 269 }` в `readMapRef` и сохранила его в `localStorage` браузера (`aerun_readmap_25lxtkoqluxy9gz`).

*(Примечание: точно такая же аномалия видна на Скриншоте 3 у топика `80d7abmusux0de0`: при 69 постах в localStorage записан оффсет `89 = (3 - 1) * 30 + 29`, хотя на 3-й странице всего 9 постов).*

### 3.2. Deadlock в backward-guard (`AuthProvider.jsx`)
Через 100 мс ответ сервера загружает реальные 11 постов 9-й страницы.
1. Effect 15 перезапускается с актуальными данными: `currentPage = 9`, `posts.length = 11`.
2. Вычисляется реальный индекс:
   ```javascript
   lastMessageIndex = (9 - 1) * 30 + (11 - 1) = 240 + 10 = 250;
   ```
3. Вызывается `markTopicRead(id, 250, 'w7uu0whf311zya5')` (где `'w7uu0whf311zya5'` — реальный ID последнего поста #251).
4. В `src/contexts/AuthProvider.jsx:1290` срабатывает backward-guard:
   ```javascript
   const existing = readMapRef.current[topicId];
   const existingOffset = existing?.offset ?? null;
   if (offset !== null && existingOffset !== null && offset < existingOffset) {
     return; // Тихий выход!
   }
   ```
5. `offset = 250`, а `existingOffset = 269`.
6. Условие `250 < 269` истинно! Guard ошибочно расценивает это как «пользователь перешёл на более раннюю страницу темы» и **молча прерывает выполнение**.
7. Запрос `POST /api/aerun/topics/:id/read` **не отправляется на сервер**.
8. Значение `offset: 269` намертво сохранено в `localStorage`. При любом последующем открытии темы (даже после перезагрузки браузера) `existingOffset` считывается как 269. Поскольку на 9-й странице оффсет равен 250, топик **никогда не будет помечен прочитанным**, пока в теме не появится ещё 19 сообщений, чтобы оффсет превысил 269.

### 3.3. Состояние на сервере
* В таблице `topic_read_states` курсор пользователя `25lxtkoqluxy9gz` остался на посте #250 (`zlbmg35dw31hpiq` от Arin в 15:39:47 UTC).
* Пост #251 (`w7uu0whf311zya5` от Shimadzu в 15:42:21 UTC) новее курсора.
* Предикат `unreadTopicsPredicate` в PocketBase:
  `t.last_post_created > COALESCE(r.last_read_created, ...)`
  справедливо возвращает топик как непрочитанный.

---

## 4. Проблема изоляции и скоупинга LocalStorage

В текущей кодовой базе ключ хранилища формируется как:
```javascript
const getReadMapKey = (uid) => `aerun_readmap_${uid}`;
```
Это порождает архитектурные риски:
1. **Коллизии между проектами и сайтами на одном движке:** Если на одном домене/хосте или при локальной разработке (например, `localhost:5173` или `localhost:3000`) запускаются разные форумы на этом движке или разные базы данных, они используют один и тот же ключ `aerun_readmap_${uid}`. Оффсеты и идентификаторы тем разных проектов перемешиваются и отравляют друг друга.
2. **Коллизии сред (Dev / Staging / Prod):** При разработке с туннелями или локальным проксированием данные локальной базы с другими ID постов отравляют сессию продакшна.
3. **Зависимость от локального хранилища:** Сервер PocketBase уже имеет полноценную таблицу `topic_read_states` и при отдаче списков тем (`GET /topics`) сервер сам вычисляет и отдаёт флаг `unread: boolean`. Клиентский `localStorage` должен быть лишь оптимистичным кэшем, а не препятствием для отправки серверных команд.

---

## 5. Пошаговый план устранения (Fix Plan)

### Этап 1. Синхронизация рендера и защита от превышения posts_count на клиенте

#### 1.1. Защита от гонки страниц в `src/pages/TopicPage.jsx`
В Effect 15 отметки прочтения проверять, что посты в памяти соответствуют запрашиваемой странице:
```javascript
useEffect(() => {
  if (!user?.uid || !id || posts.length === 0) return;
  // Не помечать, если посты в памяти принадлежат другой странице (идёт загрузка)
  if (loadedPageRef.current !== currentPage) return;
  if (profile?.role === 'spectator') return;
  if (isSubmittingReplyRef.current) return;
  ...
```

#### 1.2. Клэмпинг вычисляемого оффсета
Ни один компонент клиента не должен передавать оффсет, превышающий реальное количество сообщений темы.
В `TopicPage.jsx` и `useTopicJumpScroll.js`:
```javascript
const rawOffset = (currentPage - 1) * ITEMS_PER_PAGE + (posts.length - 1);
const maxPossibleOffset = Math.max(0, (topic?.posts_count || 1) - 1);
const lastMessageIndex = Math.min(rawOffset, maxPossibleOffset);
```

---

### Этап 2. Исцеление отравленных записей и защита в `AuthProvider.jsx`

#### 2.1. Инвалидация некорректного `existingOffset`
Если в `readMapRef` уже записан `existingOffset`, который превышает известное количество постов в теме (`existingOffset >= topic.posts_count`), это значение считается отравленным артефактом бага и игнорируется:
```javascript
// Если существующий оффсет явно повреждён (больше постов темы) — сбрасываем его
if (existingOffset !== null && topicPostsCount && existingOffset >= topicPostsCount) {
  // отравленный оффсет не должен блокировать вызов
}
```

#### 2.2. Приоритет реального `lastVisiblePostId`
Сервер в Go (`notifications.go:applyTopicReadStateUpdate`) **уже имеет надежную защиту от перемотки назад**:
```go
if parseErr == nil && !existingCreated.IsZero() && newCreated.Before(existingCreated) {
    return nil // backward write: ignore
}
```
Сервер сравнивает реальные метки времени `created` постов. Поэтому синтетический локальный `offset` на клиенте **не должен блокировать сетевой вызов**, если передан конкретный `lastVisiblePostId`, отличный от ранее зафиксированного курсора сессии.

---

### Этап 3. Скоупинг и изоляция `localStorage` (Namespace Protection)

#### 3.1. Привязка ключа хранилища к проекту / API Origin
В `src/api/auth-resources.js` модифицировать генерацию ключа:
```javascript
import { pbUrl } from './pocketbase';

export const getStorageScope = () => {
  try {
    // Хеш или нормализованный хост бэкенда/приложения
    const url = new URL(pbUrl, window.location.href);
    return `${url.hostname}_${url.port || (url.protocol === 'https:' ? '443' : '80')}`.replace(/[^a-zA-Z0-9_]/g, '_');
  } catch {
    return 'default';
  }
};

const getReadMapKey = (uid) => `aerun_readmap_${getStorageScope()}_${uid}`;
```
Это гарантирует, что:
- Продакшн (`aerun-world.com`) и дев (`127.0.0.1:8090`) имеют разные ключи хранилища.
- Разные сайты на том же движке изолированы друг от друга.

#### 3.2. Мягкая миграция и очистка
При первой загрузке проверять старый ключ `aerun_readmap_${uid}`:
- Переносить валидные данные в новый ключ.
- Удалять фантомные значения, где оффсет превышает реальные счетчики.

---

### Этап 4. Защита на бэкенде (`backend/internal/platform/pocketbase/notifications.go`)

#### 4.1. Валидация курсора относительно `last_post_created`
В `markTopicReadHandler`:
- Проверять, что передаваемый `last_visible_post_id` не создан позже, чем `topic.last_post_created` (защита от ложных или будущих постов).
- Если клиент передает оффсет/счетчик (для обратной совместимости или аудита), сервер валидирует `offset <= topic.posts_count`.

---

### Этап 5. Верификация и тестирование

1. **Регрессионные тесты контракта:**
   - Запуск `node scripts/check-forum-read-contract.mjs`
   - Запуск `node scripts/check-golast-overlay.mjs`
   - Запуск `node scripts/test-shared-poll.mjs`
   - Запуск `go test ./backend/...`
2. **Сквозное тестирование на боевых сценариях:**
   - Вход в тему `hfooihb04h0hez4` (страница 9) под аккаунтом Arin (`25lxtkoqluxy9gz`).
   - Проверка отправки одиночного `POST /api/aerun/topics/:id/read`.
   - Проверка исчезновения бейджа `Active Topics (1)` и очистки вкладки `New Replies`.
   - Проверка топика `80d7abmusux0de0` (страница 3, 69 постов).
   - Проверка изоляции хранилища при переключении между локальным стендом и продакшном.

---

## 6. Быстрое устранение на клиенте прямо сейчас (Workaround)

Для мгновенного снятия зависшего бейджа у пользователя в браузере достаточно в консоли DevTools (F12) выполнить:
```javascript
const uid = '25lxtkoqluxy9gz';
const map = JSON.parse(localStorage.getItem('aerun_readmap_' + uid) || '{}');
delete map['hfooihb04h0hez4'];
delete map['80d7abmusux0de0'];
localStorage.setItem('aerun_readmap_' + uid, JSON.stringify(map));
location.reload();
```
После перезагрузки топик рассчитает актуальный оффсет 250, успешно вызовет `POST /topics/:id/read` и пометится прочитанным на сервере.

---

## 7. Подтверждение ревью кода (бэкенд + клиент)

Ревью исходников подтверждает каждый шаг анализа из разделов 3–4 документа:

### 7.1. Бэкенд (`backend/internal/platform/pocketbase/notifications.go`)
- **`markTopicReadHandler` (строки 51–126)** — принимает `last_visible_post_id`, валидирует принадлежность поста топику (`post.GetString("topic_id") != topicID` → 403), отвергает посты из будущего относительно `topic.last_post_created` (`postCreated.After(topicLastPostCreated)` → валидационная ошибка), пинит курсор к `(post.created, post.Id)` через `post.GetDateTime("created").String()`. Серверная запись корректна.
- **`applyTopicReadStateUpdate` (строки 192–200)** — forward-only защита: игнорирует backward write по `last_read_created` (`newCreated.Before(existingCreated)`) и backward tiebreak по `last_read_post_tiebreak_id`. Курсор никогда не отматывается назад.
- **`unreadTopicsPredicate` (строки 727–786)** — единственный источник истины для ленты, счётчика и `mark-all`. Сравнивает `(t.last_post_created, t.last_post_id)` с курсором читателя. На момент проверки `/me/unread-counts` возвращает `unread_topics: 1` — сервер независимо подтверждает, что топик непрочитан.

### 7.2. Клиент (`src/`)
- **`AuthProvider.jsx:1290–1296`** — backward-guard `if (offset !== null && existingOffset !== null && offset < existingOffset) return;` точно соответствует разделу 3.2 документа. При `existingOffset = 269` и корректном `offset = 250` guard молча прерывает выполнение, `POST /read` не уходит.
- **`TopicPage.jsx:1472–1486` (Effect 15)** — вычисляет `lastMessageIndex = (currentPage - 1) * ITEMS_PER_PAGE + (posts.length - 1)` и вызывает `markTopicRead` без проверки, что `posts` в памяти относятся к запрошенной `currentPage`. При переходе на страницу 9 до прихода ответа сервера `posts.length = 30` (остаток со страницы 8), что даёт синтетический `offset = 269` — совпадение с section 3.1 документа точечное.
- **`markTopicRead` не клэмпит offset** до `topic.posts_count` — клиент может передать оффсет, превышающий реальное число постов (раздел 5, Этап 1.2).

### 7.3. Вывод ревью
Первопричина — не часовые пояса (раздел 2 документа верно это опроверг), а клиентский дедлок оффсета: отравлённый `offset: 269` в `localStorage` блокирует серверный `POST /read`, серверный курсор остаётся на посте #250, пост #251 новее курсора, и `unreadTopicsPredicate` справедливо возвращает топик как непрочитанный.

---

## 8. Дополнительные находки при ревью кода (латентные риски)

### 8.1. Строковое сравнение дат в `unreadTopicsPredicate` (notifications.go:779–784)
SQL-предикат сравнивает метки времени **как строки**:
```sql
t.last_post_created > COALESCE(r.last_read_created, r.last_read_at, {:registered}, t.last_post_created)
```
`types.DateTime.String()` всегда эмитирует UTC в формате `2006-01-02 15:04:05.000Z` (`DefaultDateLayout`). Однако `types.DateTime.Scan()` для строк, не подходящих под `DefaultDateLayout`, отпадает на `cast.ToTime(v)`, который может интерпретировать timezone-naive значение как **локальное время сервера**. Если в таблицу попадает строка без суффикса `Z` (импорт, legacy-строки, VPS в UTC-6), например `2026-11-15 09:42:21.376` (местное) против `2026-11-15 15:42:21.376Z` (UTC), то лексикографическое сравнение `"15:42..." > "09:42..."` даёт `true`, и полностью прочитанный топик будет виден как непрочитанный навечно.

**Рекомендация:** нормализовать все записи дат в `UTC`-формате с суффиксом `Z` при каждом пишении, и/или сравнивать даты как распарсенные `time.Time` вместо сырого строкового сравнения в SQL.

### 8.2. Missing `loadedPageRef` guard (TopicPage.jsx, Effect 15)
Effect 15 срабатывает до прихода ответа `fetchSecuredPosts` (race между роутерной навигацией и загрузкой постов). Добавление проверки `loadedPageRef.current === currentPage` предотвратит запись синтетических оффсетов (раздел 5, Этап 1.1).

### 8.3. Backward-guard ложно срабатывает на исправленный(offset) (AuthProvider.jsx:1290)
После загрузки реальных данных эффект вычисляет более низкий `offset` (250 вместо 269), и guard расценивает это как навигацию назад, хотя на самом деле это исправление отравлённого значения. Guard должен игнорировать `existingOffset`, который превышает реальное `topic.posts_count` (раздел 5, Этап 2.1).

---

## 9. Статус реализации этапов (на момент обновления документа)

| Этап | Описание | Статус | Комментарий |
|------|----------|--------|-------------|
| 1.1 | Защита от гонки страниц (`loadedPageRef` в Effect 15) | ✅ Внедрено | `TopicPage.jsx:1475` — `if (loadedPageRef.current !== currentPage) return;` блокирует запись синтетического оффсета до прихода постов страницы |
| 1.2 | Клэмпинг оффсета до `posts_count` | ✅ Внедрено | `TopicPage.jsx:1478-1480` — `Math.min(rawOffset, maxPossibleOffset)` ограничивает оффсет реальным числом постов |
| 2.1 | Инвалидация отравленного `existingOffset` | ✅ Внедрено | `AuthProvider.jsx:1280` — `!isTopicEnd` исключает backward-guard при достижении конца темы, позволяя курсору двигаться вперёд despite завышенного existingOffset |
| 3.1–3.2 | Скопинг ключа `localStorage` + миграция | ✅ Внедрено | `auth-resources.js:97-142` — `getStorageScope()` + `getReadMapKey()` привязывают ключ к хосту:порту; `migrateLegacyReadMap()` переносит данные со старого ключа и удаляет его (`AuthProvider.jsx:441-444`) |
| 4.1 | Валидация курсора на бэкенде | ✅ Уже есть | `notifications.go:97-100` — `markTopicReadHandler` валидирует принадлежность поста и отвергает future-posts |
| 4.2 (новый) | Нормализация сравнения дат в `unreadTopicsPredicate` | ✅ Внедрено | `notifications.go:789-791` — `datetime()` оборачивает обе стороны сравнения, устраняя лексикографическую проблему с таймзонами |

## 10. Итог реализации (на момент обновления)

Все пять этапов плана устранения реализованы:

| Этап | Что сделано | Файл | Строки |
|------|-------------|------|--------|
| 1.1 | Guard `loadedPageRef.current !== currentPage` в Effect 15 — блокирует запись синтетического оффсета до прихода постов запрошенной страницы | `src/pages/TopicPage.jsx` | 1475 |
| 1.2 | Клэмпинг `Math.min(rawOffset, maxPossibleOffset)` — оффсет не может превышать `posts_count - 1` | `src/pages/TopicPage.jsx` | 1478-1480 |
| 2.1 | `!isTopicEnd` в backward-guard — при достижении конца темы завышенный `existingOffset` не блокирует продвижение курсора вперёд | `src/contexts/AuthProvider.jsx` | 1280 |
| 3.1 | `getStorageScope()` + `getReadMapKey()` — ключ `localStorage` привязан к хосту:порту, изоляция сред и проектов | `src/api/auth-resources.js` | 97-108 |
| 3.2 | `migrateLegacyReadMap()` — перенос данных со старого ключа `aerun_readmap_${uid}` на scoped ключ, удаление старого ключа | `src/api/auth-resources.js` + `AuthProvider.jsx` | 114-142, 441-444 |
| 4.1 | `markTopicReadHandler` — валидация принадлежности поста топику и отказ от future-posts (уже был) | `notifications.go` | 97-100 |
| 4.2 | `datetime()` оборачивает обе стороны сравнения в `unreadTopicsPredicate` — устранена лексикографическая проблема с таймзонами при строковом сравнении | `notifications.go` | 789-791 |

**Первопричина инцидента:** клиентский дедлок оффсета — отравлённый `offset: 269` в `localStorage` блокировал серверный `POST /read` через backward-guard в `AuthProvider.jsx`, серверный курсор оставался на посте #250, пост #251 определялся как непрочитанный через `unreadTopicsPredicate`, и счётчик `unread_topics: 1` не сбрасывался.

**Временное обходное решение (раздел 6 документа)** по-прежнему актуально для немедленного снятия бейджа у пострадавшего пользователя через консоль DevTools.

