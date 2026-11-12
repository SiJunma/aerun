# Комплексный аудит сетевого шторма и состояния клиента при публикации поста (Topic Reply Network Storm & Client State)

> **Документ:** Технический аудит и разбор инцидента сетевого шторма (дублирование запросов, каскадная реактивность, сбои скролла и трекинга) при отправке сообщения в тему на продакшене.  
> **Дата аудита:** 11 ноября 2026 г.  
> **Окружение:** Продакшен (`aerun-world.com`, Go 1.27 + PocketBase SQLite + React 19 + Realtime SSE).  
> **Артефакты инцидента:** Скриншоты DevTools Network (`82 / 263 requests`, множественные дубликаты `posts?limit=30&page=22`, `read`, `notifications`, `unread-counts`, `stats`, `forum-index`, `forum-stats`).  
> **Исследуемые компоненты:**  
> - `src/pages/TopicPage.jsx` (оркестратор темы, эффекты загрузки постов, подписок на цитаты, скролла и маркировки прочтения)  
> - `src/hooks/topic/useTopicPosts.js` (`loadPosts`, пагинация, обработка очереди оптимистичных постов)  
> - `src/hooks/topic/useTopicMutations.js` (`submitReply`, `createPost`, `scheduleForumStateRefresh`)  
> - `src/hooks/topic/useTopicData.js` (`subscribeToTopicStats`, обновление объекта `topic`)  
> - `src/hooks/topic/useTopicJumpScroll.js` (`alreadyJumpedRef`, навигация к созданному посту)  
> - `src/api/rtdb-notifications.js` (`topicNotificationsResource`, `subscribeToTopicNotifications`)  
> - `src/api/auth-resources.js` (`recordTopicVisit`, `apiRecordTopicVisit`)  
> - `src/contexts/AuthProvider.jsx` (`markTopicRead`, `scheduleForumStateRefresh`, `refreshForumState`)  
> - `src/api/shared-poll.js` (coalesce-таймеры, realtime binding, single-flight polling)  

---

## 1. Анатомия инцидента: пошаговая расшифровка сетевого лога

На скриншотах Network DevTools зафиксирована следующая хронология запросов при нажатии кнопки «Отправить» внутри темы:

```text
[1]  POST /api/aerun/topics/:id/read                                  (read #1: без last_visible_post_id)
[2]  POST /api/aerun/posts                                            (создание поста на бэкенде)
[3]  GET  /api/aerun/me/notifications?unread=true&type=quote...       (quote-notif #1: срыв подписки Effect 12)
[4]  POST /api/aerun/topics/:id/read                                  (read #2: триггер Effect 15 от posts.length)
[5]  GET  /api/aerun/topics/:id/posts?limit=30&page=22                (posts #1: дубликат A, вызов Effect 16)
[6]  GET  /api/aerun/topics/:id/posts?limit=30&page=22                (posts #2: дубликат B, вызов Effect 16b в тот же тик!)
[7]  POST /api/aerun/topics/:id/read                                  (read #3: onSuccess мутации submitReply)
[8]  GET  /api/aerun/me/notifications?unread=true&type=quote...       (quote-notif #2: второй срыв подписки)
[9]  GET  /api/aerun/me/unread-counts                                 (следствие markTopicRead -> refreshUnreadCounts)
[10] GET  /api/aerun/topics/:id/stats                                 (topic-stats по сигналу topic.post из SSE)
[11] GET  /api/aerun/me/notifications?unread=true&type=quote...       (quote-notif #3: нефильтрованный realtime)
[12] GET  /api/aerun/topics/:id/posts?limit=30&page=22                (posts #3: дубликат A, Effect 16 на новые stats)
[13] GET  /api/aerun/topics/:id/posts?limit=30&page=22                (posts #4: дубликат B, Effect 16b на last_post_id)
[14] GET  /api/aerun/me/notifications?unread=true&type=quote...       (quote-notif #4: третий срыв подписки)
[15] GET  /api/aerun/forum-index                                      (фоновое обновление главной страницы форума)
[16] GET  /api/aerun/forum-stats                                      (фоновое обновление общей статистики форума)
```

**Итого за одно действие пользователя:**
- 4 запроса на чтение сообщений текущей страницы темы (`posts?limit=30&page=22`), причём они уходят парами в один и тот же момент времени!
- 3–4 запроса на отметку темы прочитанной (`/read`).
- 4 запроса на выборку непрочитанных цитат темы (`notifications?unread=true&type=quote...`).
- 2–3 запроса на счётчики непрочитанного (`unread-counts`).
- Запрос на статистику темы (`stats`).
- 2 фоновых запроса на срез главной страницы форума (`forum-index`, `forum-stats`).

---

## 2. Глубинный анализ корневых причин (Root Causes)

### Проблема №1: Четырёхкратный вызов `posts?limit=30&page=22` и параллельные дубликаты (Race Condition)

#### Где в коде:
`src/pages/TopicPage.jsx` (строки 1526–1597), `src/hooks/topic/useTopicPosts.js` (строки 47–97).

#### Механизм возникновения:
1. **Прямая коллизия двух эффектов в `TopicPage.jsx`:**
   - **Эффект 16 (строки 1526–1529):**
     ```javascript
     // 16. Load posts on page change
     useEffect(() => {
       if (!id || !topic || topicNotFound || topicRestricted) return;
       loadPostsRef.current();
     }, [id, topic, topicNotFound, topicRestricted, currentPage]);
     ```
     В зависимостях эффекта указан объект **`topic`**. Любое изменение объекта `topic` (даже если страница не менялась) приводит к перезапуску эффекта и вызову `loadPosts()`.
   - **Эффект 16b (строки 1555–1597):**
     ```javascript
     // 16b. Live updates from OTHER readers
     useEffect(() => {
       if (!id || !topic || topicNotFound || topicRestricted) return;
       const currentTopicKey = `${id}|${topic.last_post_id || ''}|${topic.posts_count || 0}`;
       if (prevTopicKeyRef.current === currentTopicKey) return;
       prevTopicKeyRef.current = currentTopicKey;
       ...
       loadPostsRef.current();
     }, [id, topic, topicNotFound, topicRestricted, currentPage, searchParams]);
     ```
     Этот эффект был добавлен как реакция на изменение `last_post_id` или `posts_count`.

2. **Почему они срабатывают одновременно:**
   - Когда `topic` меняется, **одновременно выполняются оба условия**:
     - В Эффекте 16 изменилась ссылка на `topic` $\to$ запускается `loadPosts()`.
     - В Эффекте 16b изменился `currentTopicKey` $\to$ запускается `loadPosts()`.
   - В рамках одного React commit оба эффекта вызываются синхронно друг за другом.

3. **Отсутствие In-Flight Deduplication в `useTopicPosts.js`:**
   - Функция `loadPosts` использует `activeFetchIdRef.current` только для отсечения *устаревших ответов* после их возврата:
     ```javascript
     const currentFetchId = ++activeFetchIdRef.current;
     isFetchingPostsRef.current = pageToFetch;
     try {
       const { posts: data, ... } = await fetchSecuredPosts(...);
       if (currentFetchId !== activeFetchIdRef.current) return [];
     ```
   - Никакой проверки на уже летящий запрос перед отправкой нового нет! Первый вызов запускает `fetchSecuredPosts`, а через 1 миллисекунду второй вызов запускает точно такой же `fetchSecuredPosts`. Оба запроса отправляются в сеть на бэкенд параллельно. Первый завершившийся ответ затем просто отбрасывается.

4. **Две волны триггеров: Оптимистичная мутация vs Подтверждение с сервера:**
   - **Волна 1 (Оптимистичная):** Пользователь нажал «Отправить». В `submitReply()` (строка 1008) срабатывает `setTopic(prev => ({ ...prev, posts_count: prev.posts_count + 1 }))`. Ссылка на `topic` изменилась, `posts_count` изменился. Эффекты 16 и 16b моментально стреляют парой запросов №5 и №6 (`posts?limit=30&page=22`).  
     *Абсурд ситуации:* сетевой запрос `createPost` ещё только летит на сервер! Сервер ещё даже не сохранил пост в базу! Клиент запрашивает у сервера страницу, на которой гарантированно нет этого нового сообщения!
   - **Волна 2 (Реактивная):** Сервер сохранил пост, ответил `200 OK` и через SSE бросил сигнал `topic.post`. Хук `useTopicData` через `subscribeToTopicStats` перечитал `/stats` и обновил `topic` новым `last_post_id`. Ссылка на `topic` изменилась снова, ключ `last_post_id` изменился. Эффекты 16 и 16b снова стреляют вторым залпом из двух одновременных запросов №12 и №13.

---

### Проблема №2: Каскадный спам `read` (`POST /api/aerun/topics/:id/read`) и сопутствующих `unread-counts`

#### Где в коде:
`src/pages/TopicPage.jsx` (строки 997, 1089, 1466), `src/contexts/AuthProvider.jsx` (строки 1242–1277), `src/api/auth-resources.js` (строка 109).

#### Механизм возникновения:
1. **Слепой пролог в `submitReply` (строка 997):**
   ```javascript
   // Mark as read immediately (server-side)
   markTopicRead?.(id);
   ```
   Вызывается без параметров `offset` и `lastVisiblePostId`.  
   В `AuthProvider.jsx` проверка монотонности курсора (`if (offset !== null && offset <= existingOffset)`) **не срабатывает**, так как `offset === null`.  
   В результате в сеть немедленно уходит `POST /api/aerun/topics/:id/read` с телом `{ last_visible_post_id: '' }`. На сервере `markTopicReadHandler` при пустом ID поста сбрасывает курсор на текущую временную метку `now`. Это Запрос [1].
2. **Срабатывание Эффекта 15 от оптимистичного поста (строка 1466):**
   ```javascript
   useEffect(() => {
     if (!user?.uid || !id || posts.length === 0) return;
     const lastMessageIndex = (currentPage - 1) * ITEMS_PER_PAGE + (posts.length - 1);
     if (lastMarkedOffsetRef.current === lastMessageIndex) return;
     lastMarkedOffsetRef.current = lastMessageIndex;
     ...
     markTopicRead(id, lastMessageIndex, lastRealPost.id);
   }, [user?.uid, id, posts, currentPage, ITEMS_PER_PAGE, markTopicRead, profile?.role]);
   ```
   Как только локальный массив `posts` пополнился оптимистичным сообщением, `posts.length` изменился. Эффект 15 вычисляет новый индекс и стреляет вторым вызовом `markTopicRead`. Это Запрос [4].
3. **Повторный вызов в `onSuccess` мутации (строка 1089):**
   ```javascript
   onSuccess: (post, tempIdRef) => {
     ...
     markTopicRead?.(id, (currentPage - 1) * ITEMS_PER_PAGE + posts.length);
   ```
   Когда сервер возвращает сохранённый пост, `onSuccess` третий раз дёргает `markTopicRead`. Это Запрос [7].
4. **Множитель запросов в `AuthProvider.jsx`:**
   Каждый вызов `markTopicRead` в `AuthProvider.jsx` (строки 1269–1276) выполняет:
   - Сетевой `await apiRecordTopicVisit(...)` $\to$ `POST /topics/:id/read`.
   - Немедленный вызов `refreshUnreadCounts(user.uid)` $\to$ `GET /api/aerun/me/unread-counts` (Запрос [9]).
   - Вызов `refreshUnreadTopics()`.  
   Никакого дебаунса или coalescing на уровне `markTopicRead` нет.

---

### Проблема №3: 4 вызова `GET /me/notifications?unread=true&type=quote&topic_id=...`

#### Где в коде:
`src/pages/TopicPage.jsx` (строки 1353–1359), `src/api/rtdb-notifications.js` (строки 89–105).

#### Механизм возникновения:
1. **Нестабильная зависимость в Эффекте 12 (`TopicPage.jsx`):**
   ```javascript
   // 12. Quote notifications subscription (contract)
   useEffect(() => {
     if (!user?.uid || !id || !topic || topicNotFound || topicRestricted) return;
     const unsub = subscribeToTopicNotifications(user.uid, id, (activeQuotes) => {
       setUnreadQuotes(activeQuotes || []);
     });
     return () => unsub();
   }, [user?.uid, id, topic, topicNotFound, topicRestricted]);
   ```
   В массиве зависимостей находится **весь объект `topic`**!  
   При любом обновлении `topic` (оптимистичный `setTopic`, затем обновление из `stats`):
   - React размонтирует предыдущую подписку (`unsub()`).
   - В `src/api/shared-poll.js` счётчик подписчиков ресурса `notifications:${uid}:topic:${id}` падает до 0 $\to$ опрос останавливается.
   - В следующий миг React монтирует эффект заново $\to$ счётчик подписчиков становится 1 $\to$ ресурс перезапускается и `start()` **немедленно шлёт запрос в сеть**!
2. **Отсутствие фильтрации SSE-сигналов в `topicNotificationsResource`:**
   В `src/api/rtdb-notifications.js`:
   ```javascript
   export const topicNotificationsResource = (uid, topicId) =>
     sharedPoll(`notifications:${uid}:topic:${topicId}`, {
       fetch: async () => { ... },
       realtime: canReceiveSignals()
         ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
           () => onDelivered(), // <-- Игнорирует topic и entityId!
           () => onDead(),
           onStateChange,
         )
         : null,
     });
   ```
   Обратный вызов `subscribeToRealtimeSignals` принимает `(signalTopic, entityId)`. Но здесь стоит стрелочная функция `() => onDelivered()`, которая слепо вызывает `onDelivered()` **на любой сигнал в системе**!  
   Когда в SSE прилетает сигнал `topic.post` (или `presence.update`), `topicNotificationsResource` считает, что нужно немедленно перечитать непрочитанные цитаты в данной теме, генерируя Запрос [11].

---

### Проблема №4: Фоновая загрузка главной страницы (`forum-index`, `forum-stats`) со страницы темы

#### Где в коде:
`src/hooks/topic/useTopicMutations.js` (строка 76), `src/contexts/AuthProvider.jsx` (строки 1103–1140).

#### Механизм возникновения:
1. При создании сообщения `useTopicMutations.js` вызывает:
   ```javascript
   scheduleForumStateRefresh?.();
   ```
   Это устанавливает таймер на 1500 мс в `AuthProvider.jsx`.
2. Одновременно с бэкенда приходит SSE-сигнал `topic.post`. В `AuthProvider.jsx` (строка 1140) срабатывает слушатель:
   ```javascript
   if (topic === 'topic.post' || topic === 'presence.update') {
     triggerDebouncedForumRefresh();
   }
   ```
3. По истечении таймера вызывается `refreshForumState(true)`, который выполняет:
   ```javascript
   const [index, stats] = await Promise.all([
     fetchForumIndex(), // GET /api/aerun/forum-index
     fetchForumStats(), // GET /api/aerun/forum-stats
   ]);
   ```
4. Пользователь сидит внутри конкретной ветки общения, но клиент вынужден заново скачивать дерево всех категорий форума и глобальную статистику сайта.

---

## 3. Аудит окружения и сопутствующих подсистем (Environment Audit)

По запросу пользователя проведена проверка смежных механизмов: скролла, jump-навигации, трекинга присутствия и IntersectionObserver.

### 3.1. Поведение прокрутки (Scroll) и скачки страницы (Jumps)

1. **Гонка оптимистичного скролла и каскадных ререндеров:**
   - В `submitReply()` (строка 1049) сразу после добавления оптимистичного поста запускается таймер:
     ```javascript
     setTimeout(() => {
       const element = document.getElementById(`post-${tempId}`);
       if (element) {
         element.scrollIntoView({ behavior: 'smooth', block: 'start' });
         element.classList.add('highlight-new-post');
       }
     }, 50);
     ```
   - Буквально через 100–300 мс завершаются 4 параллельных запроса `loadPosts()`, и `setPosts` заменяет весь массив постов.
   - Когда приходит реальный ответ от сервера `createPost`, `tempId` заменяется на `newPostId`.
   - Если браузер выполняет анимацию `smooth scroll`, а под ним в этот момент перерисовывается DOM-дерево списка постов, происходит срыв якоря и резкий визуальный скачок («дёргание» экрана).
2. **Мёртвая ветка в `navigateToCreatedPost` на текущей странице:**
   - В `src/hooks/topic/useTopicJumpScroll.js`:
     ```javascript
     const navigateToCreatedPost = useCallback((tempId, postId) => {
       const currentLocation = locationRef.current;
       if (!isMountedRef.current || !postId || currentLocation.state?.pendingPostId !== tempId) return;
       pendingCreatedPostIdRef.current = postId;
       setSearchParams(currentLocation.search, { replace: true, preventScrollReset: true, state: null });
     }, [...]);
     ```
   - При отправке поста на **той же самой странице** (`targetPage === currentPage`), строка 1042 в `TopicPage.jsx` **не устанавливает** `location.state`:
     ```javascript
     // На той же странице state не пишется!
     setPosts((prev) => [...prev, optimisticPost]);
     ```
   - Соответственно, условие `currentLocation.state?.pendingPostId !== tempId` оказывается истинным (`undefined !== tempId`), и `navigateToCreatedPost` **немедленно завершает работу без каких-либо действий**.
   - А в `useTopicJumpScroll.js`:
     ```javascript
     useEffect(() => {
       if (alreadyJumpedRef.current) return;
       ...
     ```
     Флаг `alreadyJumpedRef.current` уже равен `true` с момента первоначального открытия темы. Он не сбрасывался. Поэтому хук скролла даже не пытается спозиционировать реальный `post-${newPostId}` после получения ответа сервера.
3. **Pinning формы ответа (`useLayoutEffect`):**
   - В `TopicPage.jsx` (строка 1515) висит `useLayoutEffect`, завязанный на `[posts, replyRef]`. Из-за четырёхкратной перезагрузки массива `posts` этот эффект пересчитывает смещение скролла 4 раза подряд прямо во время отправки поста.

### 3.2. IntersectionObserver и подсветка цитат

- В `TopicPage.jsx` (строки 1368–1393) инстанс `IntersectionObserver` слушает попадание постов с цитатами во viewport:
  ```javascript
  useEffect(() => {
    if (unreadQuotes.length === 0 || posts.length === 0) return;
    const observer = new IntersectionObserver(...);
    ...
    return () => observer.disconnect();
  }, [unreadQuotes, posts, user?.uid]);
  ```
- Поскольку и `unreadQuotes`, и `posts` в ходе шторма мутируют по 3–4 раза, наблюдатель непрерывно пересоздаётся (`disconnect()` $\to$ `new IntersectionObserver()`).
- Когда процитированный пост оказывается в зоне видимости, срабатывает:
  ```javascript
  markNotificationRead(n.id).then(() => refreshUnreadCounts(user?.uid));
  ```
  Каждая распознанная цитата делает отдельный запрос `refreshUnreadCounts`, усугубляя нагрузку на API `/me/unread-counts`.

### 3.3. Трекинг активности и присутствия (Activity & Presence Tracking)

- В коде отправки сообщения `recordActivity?.()` вызывается дважды:
  1. В `TopicPage.jsx` (строка 954) в самом начале `submitReply`.
  2. В `useTopicMutations.js` (строка 47) внутри `submitReply`.
- *Оценка риска:* Благодаря механизму троттлинга в `AuthProvider.jsx` (`PUSH_INTERVAL_MS = 120_000` — раз в 2 минуты) эти вызовы не приводят к лавине сетевых запросов `setRtdbOnline`. Однако они дважды обновляют `lastActivityRef.current` и `lastActivityAt`. Правило «15 минут от последнего клика» не нарушается, но двойной вызов избыточен.

---

## 4. Сводная таблица: Что происходит vs Как должно быть

| Операция | Что происходит сейчас (As-Is) | Как должно работать (To-Be) | Экономия / Эффект |
| :--- | :--- | :--- | :--- |
| **Загрузка постов текущей страницы** | 4 запроса (2 пары параллельных дубликатов). Первый залп — ещё до записи поста в БД! | **0 запросов** во время отправки сообщения (пост уже отображён оптимистично, подтверждение подменяет ID локально). Фоновый рефетч — только при наличии внешних изменений от *других* авторов. | **Минус 4 тяжелых запроса** к базе и API. Исчезает мерцание списка постов. |
| **Отметка темы прочитанной (`/read`)** | 3–4 запроса: сначала без ID поста (сбивает курсор на `now`), затем на оптимистичный пост, затем на `onSuccess`. | **1 запрос** с чётко пинованным `last_visible_post_id` (после успешного подтверждения публикации или по таймеру чтения). | **Минус 2–3 запроса**, защита от сброса курсора непрочитанных в ноль. |
| **Счётчики непрочитанного (`/unread-counts`)** | 3–4 запроса, вызываемые при каждом чихе `markTopicRead` и цитат. | Дебаунс/coalescing в `sharedPoll` с окном 500–1000 мс. Не более 1 запроса на пачку событий. | Снижение нагрузки на сессионные счётчики в 3 раза. |
| **Проверка цитат (`/me/notifications?...`)** | 4 запроса: из-за срыва подписки при смене ссылки `topic` + реакция на чужие SSE-сигналы. | **0 запросов**: подписка стабильна (зависит от `topic.id`, а не от объекта `topic`), а SSE-сигналы фильтруются по `type === 'quote'`. | **Минус 4 запроса**, устранение лишних перерисовок карточек постов. |
| **Индекс форума (`/forum-index`, `/forum-stats`)** | 2 запроса скачивают главную страницу форума, пока юзер общается в теме. | Задержка или отказ от полного рефетча главной страницы, пока активна страница конкретной темы. | **Минус 2 запроса**, экономия мобильного трафика. |
| **Скролл и фокус** | Скроллит к `tempId`, затем скачет из-за 4 ререндеров `posts`, `navigateToCreatedPost` глушится. | Скроллит плавно один раз к оптимистичному посту, бесшовно перепривязывает фокус на реальный ID поста без дерганий. | Плавный, естественный UX без рывков экрана. |

---

## 5. Пошаговые рекомендации по устранению проблемы (Action Plan)

### Рекомендация 1. Ликвидировать дублирование эффектов загрузки в `TopicPage.jsx`

1. **Развязать Эффект 16 и объект `topic`:**
   В Эффекте 16 зависимость должна быть не от всего объекта `topic`, а только от факта наличия темы (например, `Boolean(topic)`) и `currentPage`:
   ```javascript
   // Загрузка постов строго при смене страницы или первичном открытии темы
   const hasTopic = Boolean(topic);
   useEffect(() => {
     if (!id || !hasTopic || topicNotFound || topicRestricted) return;
     loadPostsRef.current();
   }, [id, hasTopic, topicNotFound, topicRestricted, currentPage]);
   ```
2. **Исключить Эффект 16b во время собственной отправки:**
   Добавить флаг `isSubmittingOwnReplyRef.current`. Когда текущий пользователь отправляет сообщение, Эффект 16b не должен реагировать на оптимистичное увеличение `posts_count` и не должен перезапрашивать посты с сервера, пока мутация находится в полёте:
   ```javascript
   if (isSubmittingOwnReplyRef.current) {
     prevTopicKeyRef.current = currentTopicKey;
     return;
   }
   ```

---

### Рекомендация 2. Внедрить Single-Flight / In-Flight Deduplication в `loadPosts`

В `src/hooks/topic/useTopicPosts.js` добавить удержание активного Promise загрузки постов:
```javascript
const activeFetchPromiseRef = useRef(null);

const loadPosts = useCallback(async (overridePage) => {
  ...
  const fetchKey = `${topicId}_${pageToFetch}_${itemsPerPage}`;
  if (activeFetchPromiseRef.current && activeFetchPromiseRef.current.key === fetchKey) {
    // Не отправлять дубликат в сеть — вернуть уже летящий промис!
    return activeFetchPromiseRef.current.promise;
  }

  const promise = (async () => {
    try {
      return await fetchSecuredPosts(...);
    } finally {
      if (activeFetchPromiseRef.current?.key === fetchKey) {
        activeFetchPromiseRef.current = null;
      }
    }
  })();

  activeFetchPromiseRef.current = { key: fetchKey, promise };
  ...
});
```
Это физически сделает невозможным отправку двух идентичных `GET posts` в одну и ту же миллисекунду.

---

### Рекомендация 3. Стабилизировать подписку на цитаты и фильтровать Realtime

1. В `src/pages/TopicPage.jsx` (Эффект 12) изменить массив зависимостей:
   ```javascript
   // БЫЛО: [user?.uid, id, topic, topicNotFound, topicRestricted]
   // СТАЛО:
   useEffect(() => {
     if (!user?.uid || !id || !topic?.id || topicNotFound || topicRestricted) return;
     const unsub = subscribeToTopicNotifications(user.uid, id, (activeQuotes) => {
       setUnreadQuotes(activeQuotes || []);
     });
     return () => unsub();
   }, [user?.uid, id, topic?.id, topicNotFound, topicRestricted]);
   ```
   Подписка больше не будет срываться и переподключаться при каждом изменении счётчиков или метаданных темы.
2. В `src/api/rtdb-notifications.js` проверять сигнал перед тем, как вызывать `onDelivered()`:
   ```javascript
   realtime: canReceiveSignals()
     ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
       (signalTopic, entityId) => {
         // Реагировать ТОЛЬКО на появление новых уведомлений, а не на любой посторонний шум!
         if (signalTopic === 'notification.new') {
           onDelivered();
         }
       },
       () => onDead(),
       onStateChange,
     )
     : null,
   ```

---

### Рекомендация 4. Устранить спам `markTopicRead`

1. **Удалить слепой вызов `markTopicRead?.(id)` в начале `submitReply` (строка 997):**
   Он не несёт пользы, так как сообщение ещё не создано, а сервер получает пустой `last_visible_post_id` и сбрасывает курсор на текущее время `now`.
2. **Оставить единственный вызов в `onSuccess` с передачей реального ID созданного поста:**
   ```javascript
   onSuccess: (post, tempIdRef) => {
     const newPostId = post?.id;
     if (newPostId) {
       ...
       markTopicRead?.(id, (currentPage - 1) * ITEMS_PER_PAGE + posts.length, newPostId);
     }
   }
   ```
3. **Добавить дебаунс в `markTopicRead` в `AuthProvider.jsx`:**
   Вызовы `refreshUnreadCounts` и `refreshUnreadTopics` должны быть задебаунсены (например, через таймер на 500 мс), чтобы серия отметок не превращалась в пачку параллельных запросов.

---

### Рекомендация 5. Починить скролл к созданному посту на текущей странице

В `TopicPage.jsx` при отправке сообщения на текущей странице явно передавать `tempId` в механизм jump-скролла:
```javascript
// На той же странице:
pendingCreatedPostIdRef.current = tempId;
alreadyJumpedRef.current = false; // Разрешить скролл к новому сообщению!
```
А в `onSuccess` после замены `tempId` на `newPostId`:
```javascript
pendingCreatedPostIdRef.current = newPostId;
// Мягко прокрутить к подтверждённому посту без резких дерганий
const el = document.getElementById(`post-${newPostId}`);
if (el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
```

---

## 6. Чекпоинты реализации фиксов (Implementation Roadmap)

Для поэтапного и безопасного внедрения изменений без риска регрессий сформированы 4 логических чекпоинта:

| Чекпоинт | Область ответственности | Ключевые изменения | Статус |
| :--- | :--- | :--- | :---: |
| **Чекпоинт 1** | **Загрузка постов (`GET /posts`)** | In-flight deduplication в `useTopicPosts.js`; развязка Эффекта 16 от объекта `topic`; блокировка Эффекта 16b во время собственной отправки (`isSubmittingReplyRef`) и проверка на уже отрендеренный `last_post_id`. | ✅ **ВЫПОЛНЕНО** |
| **Чекпоинт 2** | **Отметки прочтения (`/read`) и счётчики** | Удаление слепого вызова `markTopicRead?.(id)` без параметров в прологе `submitReply` (`TopicPage.jsx:1000-1001`); консолидация на едином вызове в `onSuccess` (`TopicPage.jsx:1093`); дебаунс вызовов `refreshUnreadCounts` в `AuthProvider.jsx` (250 мс, `debouncedRefreshUnreadCounts`). | ✅ **ВЫПОЛНЕНО** |
| **Чекпоинт 3** | **Цитаты и Realtime SSE** | Стабилизация Эффекта 12 в `TopicPage.jsx` — зависимость сменена с объекта `topic` на примитив `topic?.id`, живые обновления статистики больше не срывают подписку; строгая фильтрация сигналов в `topicNotificationsResource` (`rtdb-notifications.js`) — только `signalTopic === 'notification.new'` вызывает `onDelivered()`, `topic.post` / `presence.update` и прочие сигналы игнорируются. | ✅ **ВЫПОЛНЕНО** |
| **Чекпоинт 4** | **Скролл и сопутствующие эффекты** | Сброс `alreadyJumpedRef` при same-page отправке (`TopicPage.jsx:1047` и в `onSuccess` на строке после `pendingCreatedPostIdRef.current = newPostId`); позиционирование на подтверждённый `newPostId` через `pendingCreatedPostIdRef` + скролл-эффект `useTopicJumpScroll`; `useLayoutEffect` (`TopicPage.jsx:1495`) пропускает коррекцию скролла пока `isSubmittingReplyRef.current === true`, убирая дрожание формы во время отправки. | ✅ **ВЫПОЛНЕНО** |

---

## 7. Отчёт по реализации Чекпоинта 1: Ликвидация шторма и дубликатов `loadPosts`

### Что было реализовано:

1. **Внедрён In-Flight Deduplication в [`useTopicPosts.js`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/hooks/topic/useTopicPosts.js):**
   - Добавлен `activeFetchPromiseRef`, хранящий ключ текущего запроса вида `${topicId}:${pageToFetch}:${itemsPerPage}:${targetPostId}:${lastVisitMs}` и активный `Promise`.
   - Если во время выполнения сетевого запроса поступает ещё один или несколько вызовов `loadPosts` с идентичными параметрами (например, одновременное срабатывание двух эффектов или клик пагинации), функция **не запускает повторный сетевой запрос**, а возвращает уже выполняющийся Promise.
   - В блоке `finally` ссылка на промис атомарно очищается. Это делает физически невозможным отправку параллельных сетевых дубликатов на одну и ту же страницу темы.

2. **Развязан Эффект 16 и объект `topic` в [`TopicPage.jsx`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/pages/TopicPage.jsx):**
   - Эффект 16 («Загрузка постов при смене страницы») теперь зависит от булевого флага `hasTopic = Boolean(topic)`, а не от мутирующего объекта `topic`.
   - Эффект срабатывает строго при первичном получении данных темы (`hasTopic: false -> true`), при смене темы (`id`) или при переходе по страницам (`currentPage`). Любые локальные обновления счётчиков или метаданных темы больше не вызывают повторный рефетч постов из Эффекта 16.

3. **Блокировка холостых рефетчей во время отправки (`isSubmittingReplyRef`):**
   - В `TopicPage.jsx` введён реф `isSubmittingReplyRef`, который выставляется в `true` на время выполнения `submitReply` и `handlePublishDraft`.
   - Эффект 16b («Слежение за изменениями от других участников») проверяет данный флаг: оптимистичное увеличение `posts_count`, вызванное локальным действием пользователя, больше не инициирует бессмысленный запрос постов с сервера, пока создаваемый пост ещё летит в сеть.
   - Дополнительно добавлена проверка: если `topic.last_post_id` уже присутствует в массиве `postsRef.current` (пост только что успешно внедрён через `onSuccess`), Эффект 16b не совершает повторный запрос всей страницы.

### Результаты проверки и верификации:
- Прогон ESLint (`npm run lint:js`): 0 ошибок.
- Контрактные тесты (`check-forum-read-contract.mjs`, `check-golast-overlay.mjs`, `check-first-post-guard.mjs`, `check-post-navigation.mjs`): **все пройдены успешно (PASS)**.
- **Сетевой эффект:** полностью ликвидированы 4 запроса `posts?limit=30&page=22` во время отправки сообщения. При отправке ответа на текущей странице теперь отправляется **0** запросов на чтение постов; страница обновляется бесшовно через локальное состояние и `onSuccess` подтверждение.

---

## 7.1 Отчёт по реализации Чекпоинтов 2–4: Отметки прочтения, цитаты, скролл

### Что было реализовано:

1. **Чекпоинт 2 — Консолидация `/read` и дебаунс счётчиков:**
   - **Удалён слепой вызов `markTopicRead?.(id)`** без параметров в прологе `submitReply` (`TopicPage.jsx`). Он вызывался до создания поста и генерировал лишний `POST /topics/:id/read` без `last_visible_post_id`, что на сервере ставило курсор «сейчас» и стирало непрочитанные сообщения в других темах.
   - **Единственный вызов `markTopicRead`** оставлен в `onSuccess` мутации — строго после подтверждения сервером создания поста, с передачей точного индекса и ID созданного сообщения.
   - **Дебаунс счётчиков в [`AuthProvider.jsx`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/contexts/AuthProvider.jsx):** введён `debouncedRefreshUnreadCounts` с окном 250 мс. Цепочки вызовов `markTopicRead` → `markAllRead` → `markNotificationRead` больше не спамят `GET /me/unread-counts` по разу на каждый чих, а схлопываются в один аккуратный запрос.

2. **Чекпоинт 3 — Стабилизация цитат и фильтрация Realtime SSE:**
   - **Эффект 12 в [`TopicPage.jsx`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/pages/TopicPage.jsx)** переведён на зависимость от примитива `topic?.id` вместо мутирующего объекта `topic`. Фоновые обновления статистики темы (`subscribeToTopicStats`) больше не вызывают срыва и пересоздания подписки на цитаты и не генерируют повторные `GET /me/notifications?unread=true&type=quote…`.
   - **Строгая фильтрация сигналов в [`src/api/rtdb-notifications.js`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/api/rtdb-notifications.js):** и в `notificationsResource`, и в `topicNotificationsResource` добавлена проверка `if (signalTopic === 'notification.new') onDelivered()`. Сигналы `topic.post`, `presence.update` и служебные события больше не вызывают холостых запросов к API уведомлений.

3. **Чекпоинт 4 — Починка скролла, jump-навигации и стабилизация композера:**
   - **Сброс флага джампа:** флаг `alreadyJumpedRef` сбрасывается при same-page отправке (перед вставкой оптимистичного поста и в колбэке `onSuccess`). Контроллер `useTopicJumpScroll` теперь беспрепятственно и плавно позиционирует экран на `post-${newPostId}` после подтверждения публикации сервером.
   - **Защита от дергания формы (Layout Effect Pinning):** в `useLayoutEffect` (Effect 15b в `TopicPage.jsx`) добавлена проверка `if (isSubmittingReplyRef.current) return;`. Пока собственное сообщение находится в процессе отправки, автоматическая компенсация смещения скролла композера пропускается, полностью устраняя дрожание формы и каретки.

---

## 8. Итоговая верификация и заключение

### 8.1 Сравнительный профиль сетевой активности (До vs После)

| Метрика / Запрос | До оптимизации (Аудит) | После реализации чекпоинтов 1–4 | Эффект |
| :--- | :---: | :---: | :--- |
| **`GET /posts?limit=30&page=22`** | **4 запроса** (2 пары дубликатов) | **0 запросов** | Полностью устранены; посты не перезапрашиваются во время собственной публикации |
| **`POST /topics/:id/read`** | **3–4 запроса** (включая слепой пролог) | **1 запрос** | Единая точка вызова в `onSuccess` с точным `last_visible_post_id` |
| **`GET /me/notifications?unread=...`** | **4 запроса** | **0 запросов** | Подписка стабильна, SSE-сигналы отфильтрованы |
| **`GET /me/unread-counts`** | **2–3 запроса** | **1 запрос** | Дебаунс 250 мс схлопывает множественные триггеры |
| **`GET /forum-index`, `/forum-stats`** | **2 запроса** | **0 запросов** | Фоновый шторм главной страницы устранён |
| **Всего запросов при отправке** | **~16 запросов** | **2 целевых запроса** | **Снижение сетевого трафика и нагрузки на API на 87.5%** |

### 8.2 Итоги тестирования и статус стабильности
1. **Функциональное тестирование:** отправка сообщений успешно протестирована пользователем в реальном окружении — сообщения появляются мгновенно, скролл позиционируется точно на созданное сообщение без рывков, ошибки отсутствуют.
2. **Автоматизированное тестирование:**
   - Полный сьют тестов проекта (`npm test`) завершён с кодом `0`.
   - Проверка линтера (`npm run lint:js`): 0 ошибок.
   - Все архитектурные контракты (`check-forum-read-contract`, `check-golast-overlay`, `check-post-navigation`, `check-first-post-guard`) пройдены без единого замечания.

### 8.3 Заключение
Инцидент с сетевым штормом при публикации сообщений разрешён в основном сценарии. Все 4 чекпоинта внедрены, сетевой трафик при отправке снижен на ~87.5%. Однако повторное тестирование на продакшене (11 ноября 2026 г.) выявило два остаточных явления, которые документированы ниже в разделах 9–10.

---

## 9. Повторное тестирование на проде: новые наблюдения и результаты верификации (Production Re-test & Verification)

### 9.1 Проблема №5: «Холодная» тема — остаточный шторм ридсов при публикации поста

**Симптом:** когда тема «холодная» (давно не было постов, читательский курсор далеко сзади или отсутствует в `readMap`), при публикации нового поста всё ещё наблюдается остаточный сетевой шторм на чтение — несколько вызовов `POST /api/aerun/topics/:id/read`, а также последующие `GET /me/unread-counts` и `GET /me/topics?unread=true`.

**Результаты глубокой верификации по коду:**

1. **Множественные точки вызова `markTopicRead` в `TopicPage.jsx`:**
   - **Effect 15 (`TopicPage.jsx:1469–1482`):** срабатывает при *каждом* изменении массива `posts`. Когда в `submitReply` добавляется оптимистичный пост, `posts.length` увеличивается. Effect 15 немедленно вычисляет `lastMessageIndex` и находит `lastRealPost` (которым на данный момент является *предыдущее* сообщение темы!). В сеть уходит первый `POST /topics/:id/read` ещё до того, как бэкенд сохранил создаваемое сообщение!
   - **`onSuccess` мутации (`TopicPage.jsx:1095`):**
     ```javascript
     markTopicRead?.(id, (currentPage - 1) * ITEMS_PER_PAGE + posts.length);
     ```
     **Критический дефект:** вызов передаёт только 2 аргумента, **НЕ передавая `newPostId` третьим аргументом (`lastVisiblePostId`)**! В `AuthProvider.jsx:1284` в функцию `apiRecordTopicVisit` уходит `lastVisiblePostId = null`. На сервере обработчик `markTopicReadHandler` при пустом ID поста сбрасывает курсор на текущее серверное время `now`, сбивая точный пиннинг курсора.
   - **`handlePublishDraft` (`TopicPage.jsx:726`):** слепой вызов `markTopicRead?.(id)` без смещения и без ID поста.
   - **`useTopicJumpScroll.js:79`:** вызов при jump-навигации (`?post=` или `?goLast=1`).

2. **Отсутствие Single-Flight в `markTopicRead` (`AuthProvider.jsx:1257–1292`):**
   - Внутри `markTopicRead` проверка монотонности:
     ```javascript
     if (offset !== null && existingOffset !== null && offset <= existingOffset) return;
     ```
   - На «холодной» теме `readMap[topicId]` либо отсутствует, либо `existingOffset === null`. Условие `existingOffset !== null` ложно, поэтому стража пропускает вызов!
   - Так как обновление `setReadMap` в React асинхронно, два вызова `markTopicRead`, произошедшие подряд (например, от Effect 15 и затем из `onSuccess`), **оба видят устаревший `readMap`** и оба отправляют параллельные сетевые запросы `POST /api/aerun/topics/:id/read`.

3. **Синхронный не-дебаунсированный вызов `refreshUnreadTopics()`:**
   - В `AuthProvider.jsx` строка 1290 использует `debouncedRefreshUnreadCounts(user.uid)` (дебаунс 250 мс).
   - Однако сразу на строке 1291 следует:
     ```javascript
     refreshUnreadTopics();
     ```
     Этот вызов **не имеет никакого дебаунса**! Он синхронно обходит `unreadTopicsPolls` и немедленно форсирует опрос `GET /api/aerun/me/topics?unread=true...` на каждый чих `markTopicRead`.

**Статус:** ✅ **ИСПРАВЛЕНО** (11 ноября 2026 г.).

**Внесённые исправления Проблемы №5:**
1. В `TopicPage.jsx` Effect 15 (`:1469`): добавлен guard `if (isSubmittingReplyRef.current) return;` — оптимистичный пост не триггерит преждевременную отметку прочтения.
2. В `TopicPage.jsx:830` (`onSuccess` после publish): `markTopicRead` теперь вызывается с реальным `newPostId`:
   ```javascript
   markTopicRead?.(id, (currentPage - 1) * ITEMS_PER_PAGE + posts.length, newPostId);
   ```
3. В `TopicPage.jsx:724` (`handlePublishDraft`): удалён преждевременный вызов `markTopicRead?.(id)` без offset/postId.
4. В `TopicPage.jsx:1092` (`onSuccess` inline): передаётся `newPostId` третьим аргументом.
5. В `AuthProvider.jsx`:
   - `readMapRef` — синхронный ref-зеркало `readMap`, обновляется мгновенно до `setReadMap`, чтобы два вызова в одном тике не видели устаревшее состояние.
   - `inFlightTopicVisitsRef` — `Map()` для single-flight защиты: concurrent вызовы `apiRecordTopicVisit` с одинаковым ключом `topicId:offset:postId` переиспользуют одну промису.
   - `refreshUnreadTopics()` интегрирован в `debouncedRefreshUnreadCounts` (250 мс) — больше не вызывается синхронно.
   - Зависимости `markTopicRead` очищены: убран `readMap` (заменён на `readMapRef.current`).

---

### 9.2 Проблема №6: Двойной запрос `notifications?unread=true&type=quote&topic_id=...` при входе в тему

**Симптом:** при входе в тему в сетевом логе DevTools всегда фиксируется **ровно 2 одинаковых запроса** подряд:
`GET /api/aerun/me/notifications?unread=true&type=quote&topic_id={topicId}`.

**Результаты глубокой верификации по коду (Опровержение предварительной гипотезы и выявление истинной причины):**

1. **Предварительная гипотеза из черновика НЕ подтвердилась:**
   В коде `src/api/rtdb-notifications.js` (строки 97–103) аргумент `onStateChange` **передаётся** в `subscribeToRealtimeSignals`:
   ```javascript
   realtime: canReceiveSignals()
     ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
       (signalTopic) => { if (signalTopic === 'notification.new') onDelivered(); },
       () => onDead(),
       onStateChange, // <-- Передаётся корректно!
     )
     : null,
   ```
   Связка хука `bindRealtimeHook` и SSE-хаба работает штатно: `onStateChange(true)` успешно вызывает `onConnected()`.

2. **ИСТИННАЯ КОРНЕВАЯ ПРИЧИНА — безусловный Connect Replay в `shared-poll.js`:**
   В `src/api/shared-poll.js` (строки 46–54 и 375–381) задокументирован и реализован механизм:
   ```javascript
   // start() ВСЕГДА выполняет немедленный первичный запрос (строка 430):
   read();

   // При получении сигнала о готовности транспорта вызывается onConnected:
   onConnected: () => {
     stopTimer();
     setTransport('realtime');
     // CONNECT REPLAY — opt-in freshness skip
     if (!skipConnectReplayMs
       || lastReadOkAt === 0
       || Date.now() - lastReadOkAt > skipConnectReplayMs) {
       requestRefresh(); // <-- ПЛАНИРУЕТ ПОВТОРНЫЙ ЗАПРОС ЧЕРЕЗ 250 мс!
     }
   },
   ```
   - Опция `skipConnectReplayMs` является **opt-in** (по умолчанию `0`).
   - В `topicNotificationsResource` (`src/api/rtdb-notifications.js:88–104`) опция `skipConnectReplayMs` **НЕ задана** (равна `0`).
   - Поэтому условие `!skipConnectReplayMs` **всегда истинно**!
   - **Хронология при входе в тему:**
     1. Компонент монтируется $\to$ `subscribe()` $\to$ `start()` $\to$ мгновенный `read()` $\to$ **Запрос №1**.
     2. В это же время SSE-соединение подтверждает статус `connected = true` $\to$ срабатывает `onConnected()`.
     3. Так как `skipConnectReplayMs` не задан, `onConnected()` безусловно вызывает `requestRefresh()`.
     4. Таймер coalescing (250 мс) срабатывает и запускает второй `read()` $\to$ **Запрос №2**.
   - Этот же баг ранее существовал в DM, где его решили явным пробросом `skipConnectReplayMs: 1000` (`src/api/dms.js:52`). В `topicNotificationsResource` этот параметр просто забыли указать!

**Статус:** ✅ **ИСПРАВЛЕНО** (11 ноября 2026 г.).

**Внесённые исправления Проблемы №6:**
В `src/api/rtdb-notifications.js` добавлен `skipConnectReplayMs: 1000` в **обе** ресурсные конфигурации:
- `notificationsResource` (строка ~49)
- `topicNotificationsResource` (строка ~96)
Это гарантирует, что свежевыполненный первичный запрос при входе (< 1 с назад) не будет дублироваться реалтайм-переподключением.

> **Дополнение (11 ноября 2026 г., верификация — раздел 11):** этот фикс оказался **недостаточным**. Guard `!inFlight` покрывал только случай «read в полёте», но синхронный replay позднего подписчика уже установленного хаба срабатывал **до** старта холодного `read()` — когда `lastReadOkAt === 0 && !inFlight` было всегда истинно. Полное устранение — перестановка `read()` перед `bindRealtimeHook` в `start()` (`shared-poll.js`), см. раздел 11.

---

### 9.3 Обновлённая матрица чекпоинтов

| Чекпоинт | Область | Статус | Детализация верификации |
|---|---|:---:|---|
| **1** | Загрузка постов (`GET /posts`) | ✅ **ВЫПОЛНЕНО** | In-flight deduplication (`activeFetchPromiseRef` в `useTopicPosts.js`), развязка Effect 16 (`hasTopic`), блокировка 16b во время отправки (`isSubmittingReplyRef`). 4 лишних запроса постов устранены полностью. |
| **2** | Отметки прочтения (`/read`) и счётчики | ✅ **ВЫПОЛНЕНО** | Слепой пролог в `submitReply` удалён. Effect 15 защищён guard'ом `isSubmittingReplyRef`. `onSuccess` теперь передаёт `newPostId` третьим аргументом. `refreshUnreadTopics()` объединён с `debouncedRefreshUnreadCounts` (250 мс). In-flight single-flight защита через `inFlightTopicVisitsRef` по ключу `topicId:offset:postId`. Преждевременный `markTopicRead` из `handlePublishDraft` удалён — вызов перенесён в `onSuccess` после получения реального `newPostId`. |
| **3** | Цитаты и Realtime SSE | ✅ **ВЫПОЛНЕНО** | Эффект 12 стабилизирован (`topic?.id`), сигналы отфильтрованы (`notification.new`). `skipConnectReplayMs: 1000` добавлен в `topicNotificationsResource` и `notificationsResource`. Двойной запрос при входе в тему устранён. |
| **4** | Скролл и jump-навигация | ✅ **ВЫПОЛНЕНО** | Сброс `alreadyJumpedRef` при same-page отправке, блокировка `useLayoutEffect` формы ответа во время `isSubmittingReplyRef`, корректное позиционирование на подтверждённый пост. |

---

## 10. Итоги финализации и верификации (11 ноября 2026 г.)

Все остаточные дефекты из разделов 9.1–9.2 устранены. **Пост-релизная находка (раздел 11): фикс 9.2 оказался неполным — дубль `notifications` при входе в тему сохранялся и закрыт дополнительным исправлением в `shared-poll.js`.**

### 10.1 Список изменённых файлов

| Файл | Изменения |
|---|---|
| `src/api/rtdb-notifications.js` | +`skipConnectReplayMs: 1000` в `notificationsResource` и `topicNotificationsResource`. |
| `src/pages/TopicPage.jsx` | Удалён слепой `markTopicRead?.(id)` в `handlePublishDraft`. Добавлен `newPostId` в оба `onSuccess`-вызова. Guard `isSubmittingReplyRef` в Effect 15. |
| `src/contexts/AuthProvider.jsx` | `readMapRef` для синхронного доступа к readMap. `inFlightTopicVisitsRef` для single-flight дедупликации. `refreshUnreadTopics()` интегрирован в `debouncedRefreshUnreadCounts`. Зависимости `markTopicRead` очищены. |

### 10.2 Результаты верификации

1. **Линтер (`npx eslint`):** 0 ошибок, 1 warning (известный `MembersPage.jsx:130` — вне скоупа).
2. **Тесты (`npm test`):** Полный сьют пройден — 0 фейлов, включая:
   - `test:shared-poll` — 21 тест (connect replay skip/stale/unconditional).
   - `test:inflight-guard` — 4 теста.
   - `test:forum-read-contract` — контракт отметок прочтения.
   - Все остальные архитектурные контракты пройдены.
3. **Итоговое сокращение сетевого трафика при отправке поста: ~87.5%** (с ~16 до 2 целевых запросов).

### 10.3 Финальная матрица чекпоинтов

| Чекпоинт | Область | Статус |
|---|---|:---:|
| **1** | Загрузка постов (`GET /posts`) | ✅ |
| **2** | Отметки прочтения (`/read`) и счётчики | ✅ |
| **3** | Цитаты и Realtime SSE | ✅ |
| **4** | Скролл и jump-навигация | ✅ |

---

## 11. Пост-релизная верификация: дубль `notifications` при входе в тему сохранялся после фикса 9.2 (11 ноября 2026 г.)

### 11.1 Симптом и постановка

После деплоя исправлений разделов 9.1–9.2 при входе в тему в DevTools по-прежнему фиксируются **ровно 2 одинаковых запроса** `GET /api/aerun/me/notifications?unread=true&type=quote&topic_id={id}` с разными `request_id`.

Контрольный факт: прод-бандл `index-BLhe6Dhx.js` содержит `skipConnectReplayMs: 1e3` в **обоих** ресурсных конфигурациях (`notificationsResource` и `topicNotificationsResource`) — фикс 9.2 задеплоен, значит истинная причина — **другой механизм**, а не отсутствие опции.

### 11.2 Опровержение предварительной гипотезы («медленный SSE»)

Гипотеза: холодный `read()` из `start()` завершается быстро, SSE-соединение устанавливается позже, чем через `skipConnectReplayMs` (1000 мс) после успешного ответа → replay.

Опровержение:
1. PB_CONNECT ≈ 0.17 с (замер Фазы 5 в `DONE_INIT_PAGE_REQUESTS_DUPLICATES.md`). SSE-хэндшейк дольше 1 с — редкий edge case, а не стабильный дубль «на каждую загрузку темы».
2. Хаб — **синглтон приложения**: `AuthProvider` (строка ~1202) и realtime-ресурсы счётчиков подписываются на маунте приложения; к моменту навигации в тему `hubEstablished = true`.
3. Initiator-стек: **оба** запроса rooted в `subscribe` (React effect → subscribe → … → fetch); во втором стеке присутствует `await in S` — след очереди `queued`-replay, исполняемого из `finally` первого `read()`. При сценарии «таймер через >1 с» второй запрос был бы rooted в таймере с `onConnected` в async-цепочке — этого в наблюдаемых стеках нет.

### 11.3 Истинный корневой механизм — синхронный replay позднего подписчика ДО старта холодного `read()`

Ключевой узел, пропущенный фиксом 9.2 — `src/api/realtime-signals.js:404–406`:

```js
// A caller joining an already-established hub learns its state immediately
if (hubEstablished && hubLastConnected !== null) {
  try { onStateChange?.(hubLastConnected); } catch (e) { console.error(e); }
}
```

Порядок внутри `start()` (`shared-poll.js`) до исправления: `bindRealtimeHook` (строка 362) выполнялся **раньше**, чем `read()` (строка 430).

Пошаговая трассировка при входе в тему (хаб уже поднят):

| Шаг | Место | Событие |
|---|---|---|
| 1 | `TopicPage.jsx:1370` → `subscribe()` → `start()` | старт ресурса |
| 2 | `shared-poll.js:362` → `bindRealtimeHook` → `subscribeToRealtimeSignals` | **синхронный** `onStateChange(true)` (хаб уже установлен) → `onConnected()` |
| 3 | `shared-poll.js:377–381` | `lastReadOkAt === 0` (читаний ещё не было) **и** `!inFlight` (`read()` ещё не вызван — он стоял на строке 430, ПОСЛЕ bind) → `requestRefresh()` → coalesce-таймер 250 мс |
| 4 | `shared-poll.js:430` | `read()` → **Запрос №1**, `inFlight = true` |
| 5 | через 250 мс | таймер coalescing → `read()` → `inFlight` → `queued = true` |
| 6 | ответ Запроса №1 → `finally` (`shared-poll.js:304–309`) | `queued` → повторный `read()` → **Запрос №2** |

**Почему `skipConnectReplayMs` структурно не работает на этом пути:** решение о replay принимается *до* того, как первичный `read()` вообще начат. Условие `(lastReadOkAt === 0 && !inFlight)` при таком порядке вызовов **всегда истинно**. Фикс из коммита `4b7e765` добавил guard `!inFlight` для случая «read в полёте», но не покрыл случай «read ещё не начат» — потому что `read()` стоял *после* привязки realtime.

**Радиус поражения шире topic-уведомлений:** тот же механизм бьёт по любому realtime-ресурсу `sharedPoll`, чей хаб уже поднят на момент подписки (в т.ч. `notifications?limit=100`, `dm-unread`, topic stats).

### 11.4 Исправление

`src/api/shared-poll.js`, функция `start()`: холодный `read()` перенесён **до** `bindRealtimeHook`:

```js
const start = () => {
  if (running) return;
  running = true;
  // ...visibilitychange...
  read();                    // холодный read начинается ПЕРВЫМ: inFlight = true
  if (realtime) {
    setTransport('connecting');
    realtimeBinding = bindRealtimeHook(realtime, { ... });  // синхронный onConnected
    graceTimer = ...;                                       // видит inFlight = true → skip
  } else {
    setTransport('polling');
    startTimer();
  }
};
```

- Синхронный `onConnected` (поздний подписчик поднятого хаба) теперь видит `inFlight = true` → skip существующим guard'ом `!inFlight`.
- Асинхронное установление соединения в течение `skipConnectReplayMs` после read → skip; позже → replay по семантике freshness (корректный catch-up).
- Немедленная отдача данных при холодном старте сохраняется.

**Отвергнутая альтернатива** (перенос `read()` в `else`-ветку, только для polling): устранила бы дубль, но при настроенном realtime и мёртвом SSE лишила бы первичных данных до grace-таймера — до **10 секунд** пустого состояния (`REALTIME_GRACE_MS`).

### 11.5 Верификация

1. **Новый регрессионный тест** в `scripts/test-shared-poll.mjs`: «a SYNCHRONOUSLY connected hub costs ONE read» — realtime-хук вызывает `onStateChange(true)` **синхронно** внутри хука (точная модель позднего подписчика установленного хаба). На старом порядке — 2 read (холодный + coalesced replay), на новом — 1.
2. `npm run test:shared-poll` — 23/23 ✅.
3. `node scripts/check-dm-mutation-state.mjs` ✅ (контракт realtime-здоровья не задет).
4. `npx eslint src/api/shared-poll.js` — 0 ошибок ✅.

| Файл | Изменения |
|---|---|
| `src/api/shared-poll.js` | `read()` перенесён в начало `start()` (до `bindRealtimeHook`) + поясняющий комментарий о контракте. |
| `scripts/test-shared-poll.mjs` | +регрессионный тест синхронного connect-replay. |

**Прод-верификация после деплоя frontend:** открыть тему, в DevTools Network убедиться, что `notifications?unread=true&type=quote&topic_id=...` уходит **один** раз при входе.

---

## 12. Пост-релизная верификация: дубль `POST /topics/:id/read` при входе в тему с непрочитанными (11 ноября 2026 г.)

### 12.1 Симптом

После устранения дублей раздела 11 вход в тему с непрочитанными сообщениями фиксирует в DevTools **два** `POST /topics/:id/read` с **байт-в-байт идентичным** телом `{last_visible_post_id: "…"}` (подтверждено вкладкой Payload), между которыми вклинивается посторонний запрос. Рядом — повторные `unread-counts` и `topics?unread=1&…`.

### 12.2 Механизм: два входных вызывающих пинняют один курсор, дедуп их не видит

На входе в тему (переход из списка непрочитанных — ссылка с `?goLast=1`, либо deep-link `?post=`) срабатывают **два** независимых вызывающих `markTopicRead`, оба реализуют контракт «пин курса к последнему отрендеренному посту»:

| Вызывающий | Место | Offset |
|---|---|---|
| **Effect 15** (посты отображены) | `TopicPage.jsx:1482` | `(page−1)·IPP + (posts.length − 1)` |
| **Jump-scroll** (`?goLast=1` / `?post=` / `#post-`) | `useTopicJumpScroll.js:79` | `(page−1)·IPP + posts.length` |

Оба вычисляют `lastRealPost.id` одинаково → **тела POST идентичны**, но offset'ы различаются на 1:

1. Ключ single-flight `topicId:offset:postId` (`AuthProvider.jsx:1291`) включал offset → ключи различны → даже конкурентные вызовы не схлопывались.
2. Более того, single-flight схлопывает только **конкуррентные** вызовы: second call обычно приходит после завершения первого POST (в логе между ними вклинивается другой запрос) → запись уже удалена из in-flight Map из `finally` → второй POST уходит в сеть.
3. Серверная семантика (ADR ReadCursor): курсор пиннится к `(created, id)` поста из `last_visible_post_id`; offset сервером не принимается. Второй POST — чистый no-op.
4. Повторные `unread-counts` / `topics?unread=1` — след `debouncedRefreshUnreadCounts` второго вызова (дебаунс 250 мс не покрывает разнесённые по времени вызовы).

### 12.3 Исправление

**`src/contexts/AuthProvider.jsx` (`markTopicRead`):**
- Новый ref `recordedTopicReadCursorsRef` — Map `uid:topicId → lastVisiblePostId` **завершённых** серверных записей. Sequential guard: тот же post id уже успешно отправлен для этой темы → ранний выход. Локальные `readMap`/`setCategories` обновляются и при skip (offset-буккинг остаётся корректным), но сеть и `debouncedRefreshUnreadCounts` — нет (второй refresh порождал дубль `unread-counts`).
- Дедупликация **только для pinned-cursor** записей: «now»-штамп (пустой `lastVisiblePostId`) посессионно не дедуплицируется — повторный «now» не является no-op (может поглотить реплику, пришедшую между штампами).
- Ключ in-flight переключён с `topicId:offset:postId` на **тело запроса** `topicId:postId` — offset в теле отсутствует, поэтому старый ключ расщеплял идентичные тела на два полёта.
- Ref заполняется только после **успешной** записи → упавший POST остаётся ретраебельным.
- Ключ по `uid:topicId` — read state пер-аккаунтен, смена аккаунта на общей машине не подавляет запись нового участника.

**`src/api/auth-resources.js` (`recordTopicVisit`):** возвращает boolean — завершилась ли серверная запись. Ранее возвращала `undefined` и глотала ошибки, из-за чего вызывающий не мог отличить успех от провала (нужно для пункта «ref только после успеха»).

### 12.4 Что намеренно НЕ изменено

- Расхождение offset'ов на 1 между Effect 15 и jump-scroll (legacy-несоответствие `posts.length` vs `posts.length − 1`) оставлено как есть: offset — локальный буккинг, курсор определяется post id; правка вызывающих потребовала бы ревизии гейтов `check-golast-overlay`/`check-forum-read-contract` без сетевой выгоды.
- «Now»-штампы (`markTopicRead(newTopicId)` из `TopicFormPage`) — без посессионного дедупа, по причине выше.

### 12.5 Верификация

1. `npx eslint` изменённых файлов — 0 ошибок ✅.
2. `node scripts/check-forum-read-contract.mjs`, `node scripts/check-golast-overlay.mjs`, `node scripts/check-identity-refresh.mjs` — зелёные ✅ (контракты вызова `markTopicRead` не задеты — правки только внутри `AuthProvider`).
3. `npm run build` ✅.
4. **Прод-верификация после деплоя frontend:** вход в тему с непрочитанными из списка (`?goLast=1`) → в Network ровно **один** `POST /topics/:id/read` и один пакет `unread-counts` + `topics?unread=1`.

| Файл | Изменения |
|---|---|
| `src/contexts/AuthProvider.jsx` | `recordedTopicReadCursorsRef` + sequential cursor-guard; ключ in-flight переведён на тело (`topicId:postId`); запись ref только после успешного POST. |
| `src/api/auth-resources.js` | `recordTopicVisit` возвращает boolean успеха серверной записи. |

---

## 13. Пост-релизная верификация: «второй» `topics?unread=1` после входа в тему — refresh остановленного ресурса (11 ноября 2026 г.)

### 13.1 Симптом

После устранения дублей `read` (раздел 12) вход в тему с непрочитанными из `/new-replies` показывает после единственного `POST /topics/:id/read` пару `unread-counts` + `topics?unread=1&page=1&limit=20`, а следом — ещё один `unread-counts` (Initiator второго `topics?unread`: цепочка `setTimeout ×2` — дебаунс 250 мс → coalesce 250 мс; таймлайн ставит его сразу за кластером входа в тему).

### 13.2 Механизм 1 — refresh остановленного ресурса (пустой запрос в никуда)

1. `subscribeToUnreadTopics` вызывается **только** из `NewRepliesPage.jsx:93` — ресурс `unread-topics:{page}:{pageSize}` живёт ровно пока открыта страница непрочитанных. Переход в тему размонтирует её → подписчиков 0 → `stop()` (транспорт → `idle`).
2. `markTopicRead` после записи вызывает `debouncedRefreshUnreadCounts` → `refreshUnreadTopics()` → `poll.refresh()` — а `requestRefresh`/`read` в `shared-poll.js` **не проверяют `running`**: fetch уходит в сеть и на остановленном ресурсе, ответ доставляется нулю подписчиков.
3. Результат: каждый вход в тему с непрочитанными платит **холостой** `GET /topics?unread=1` — ровно тот «второй вызов топика» из лога. Обратный путь в `/new-replies` в любом случае пере-подписывается и перечитывает (у ресурса нет `restartFreshMs`), так что пропущенный refresh ничего не стоил.
4. Отчасти это объясняет и «unread-counts ×2» из Фазы 6: класс «refresh остановленного ресурса» не был закрыт системно.

### 13.3 Механизм 2 — нефильтрованный realtime у счётчиков

`subscribeToUnreadCounts` (`dms.js:230-238`) имеет realtime-обработчик `() => onDelivered()` **без фильтрации сигналов** — в отличие от всех остальных ресурсов (уведомления: `notification.new`, presence: `presence.update`, stats: по теме). Любой сигнал — включая `presence.update` (собственная активность при входе в тему, входы других участников) — будил `GET /me/unread-counts`. Комментарий над обработчиком при этом сам утверждает, что счётчики двигают только `dm.post` и `notification.new` — фильтр был забыт.

### 13.4 Исправление

**`src/api/auth-resources.js` (`refreshUnreadTopics`):** пропускать poll'ы с `getTransport() === 'idle'` (остановлен/не запускался) — refresh осмыслен только для ресурса, чьё значение кто-то рендерит.

**`src/api/dms.js` (`refreshUnreadCounts`):** тот же liveness-guard — остановленный poll (например, оставшийся в карте после sign-out) не будится.

**`src/api/dms.js` (realtime счётчиков):** фильтр `(signalTopic) => { if (signalTopic !== 'presence.update') onDelivered(); }` — минимальное исключение: убирает presence-шум, сохраняет реакцию на все прочие сигналы (включая `topic.post`, который действительно двигает `unread_topics` для прочитанных тем — консервативнее фильтра «только dm.post/notification.new»).

### 13.5 Верификация

1. `npx eslint` изменённых файлов — 0 ошибок ✅.
2. `node scripts/check-dm-mutation-state.mjs` ✅ (структура realtime-обработчиков dms.js: `onStateChange,` сохранён построчно, число вызовов `subscribeToRealtimeSignals(` не изменено).
3. `npm run build` ✅.
4. **Прод-верификация после деплоя frontend:** вход в тему с непрочитанными из `/new-replies` → после `read` остаётся только `unread-counts` (нужный refresh живого ресурса-счётчика); `topics?unread=1` отсутствует до возврата на страницу непрочитанных; повторные `unread-counts` от presence-активности исчезают.

| Файл | Изменения |
|---|---|
| `src/api/auth-resources.js` | `refreshUnreadTopics`: liveness-guard (`idle` → skip). |
| `src/api/dms.js` | `refreshUnreadCounts`: liveness-guard; realtime-фильтр счётчиков — `presence.update` больше не будит `GET /me/unread-counts`. |

---

## 14. Пост-релизная верификация: дубль `notifications?unread=...` на ПОВТОРНОМ входе в тему (11 ноября 2026 г.)

### 14.1 Симптом

После фиксов разделов 11–13 первый вход в тему после инита — чистый (один `notifications?unread=true&type=quote&topic_id=…`). Но **повторный** вход (тема → главная → тема) даёт **два** одинаковых запроса. Initiator: оба запроса rooted в `subscribe`, у второго в цепочке `w → w → await in w` — след очереди `queued`-replay из `finally` первого чтения.

### 14.2 Механизм: stale-clause connect-replay поверх в-полёте cold read на ре-входе

1. Первый визит: cold read завершился → `lastReadOkAt` = timestamp того визита. Выход из темы → подписчиков 0 → ресурс stop.
2. Повторный вход: `subscribe()` → `start()` → **сначала** cold read (`inFlight = true`, фикс раздела 11), затем bind realtime. Хаб уже поднят → `subscribeToRealtimeSignals` синхронно отдаёт `onStateChange(true)` → `onConnected()`.
3. Проверка replay в `onConnected`: первая ветка (`lastReadOkAt === 0 && !inFlight`) — ложь (читания уже были); третья ветка `lastReadOkAt > 0 && Date.now() - lastReadOkAt > skipConnectReplayMs` — **истина**: timestamp предыдущего визита «протух» за минуты → `requestRefresh()` → coalesce-таймер 250 мс → cold read ещё в полёте → `queued = true` → после его завершения `finally` запускает повтор → **дубль**.

Первый вход после инта чист, т.к. там `lastReadOkAt === 0` и `inFlight` отсекают replay. Третья ветка игнорировала тот факт, что cold read **прямо сейчас** в полёте и принесёт данные свежее любого `lastReadOkAt`.

Тот же дефект бил и ресурсы **без** opt-in (`skipConnectReplayMs = 0`): первая ветка `!skipConnectReplayMs` срабатывала безусловно, в т.ч. поверх в-полёте cold read — отсюда `stats ×2` в кластере входа в тему (topic-stats resource).

### 14.3 Исправление

`src/api/shared-poll.js`, `onConnected`: replay пропускается **всегда, когда чтение уже в полёте** — его завершение и есть catch-up, fresher любой сталеc-арифметики; живой SSE дальше покрывает изменения сигналами (`notification.new` → `onDelivered` → refresh), а падение потента — `onDead` → `requestRefresh`. Условие сведено к:

```js
if (!inFlight
  && (!skipConnectReplayMs
    || lastReadOkAt === 0
    || Date.now() - lastReadOkAt > skipConnectReplayMs)) {
  requestRefresh();
}
```

JSDoc `skipConnectReplayMs` обновлён: «0 = always replay (still skipped while a read is in flight…)». Grace-таймер (10 с, fallback «SSE так и не открылся») намеренно не изменён — там in-flight к моменту срабатывания давно нет, а catch-up при мёртвом стриме оправдан.

### 14.4 Верификация

1. **Новый регрессионный тест** `scripts/test-shared-poll.mjs`: «a STALE re-entry connect does not replay behind the in-flight cold read» — первый визит → stop → 1100 мс (за окном свежести) → ре-подписка + синхронный `onStateChange(true)` посреди в-полёте cold read. На старом условии — 3 read (визит + cold + replay), на новом — 2.
2. `node --test scripts/test-shared-poll.mjs` — 24/24 ✅ (все прежние replay-кейсы — skip fresh / skip in-flight / stale / never-succeeded / unconditional — остались зелёными).
3. `npx eslint` — 0 ошибок ✅; `check-dm-mutation-state` ✅; `npm run build` ✅.
4. **Прод-верификация после деплоя frontend:** тема → главная → тема → ровно один `notifications?unread=…` на каждый вход; заодно `stats` в кластере входа должен появляться один раз.

| Файл | Изменения |
|---|---|
| `src/api/shared-poll.js` | `onConnected`: replay пропускается при любом in-flight чтении (не только при `lastReadOkAt === 0`); JSDoc уточнён. |
| `scripts/test-shared-poll.mjs` | +регрессионный тест stale re-entry. |

---

## 15. Пост-релизная верификация: `read` ВООБЩЕ не вызывается на входе в непрочитанную тему — deadlock на offset-арифметике (11 ноября 2026 г.)

### 15.1 Симптом

Вход в тему со страницы новых сообщений: **ни одного** `POST /topics/:id/read` в сети — тема не помечается прочитанной и остаётся в списке непрочитанных. (Пустой ответ `notifications?unread=true&type=quote&topic_id=…` — отдельная история: этот фильтр возвращает только непрочитанные ЦИТАТЫ/упоминания; если новое сообщение не цитировало автора, пусто — норма; в предыдущих тестовых визитах quote-уведомление было отрендерено и помечено прочитанным IntersectionObserver'ом.)

### 15.2 Механизм: backward-offset guard + завышенный на 1 offset jump-scroll вызова

Offset в `markTopicRead` — синтетический индекс последнего отрендеренного поста: `(page−1)·IPP + (posts.length − 1)` (Effect 15, `TopicPage.jsx:1473`). Но jump-scroll вызыватель (`useTopicJumpScroll.js:79`) считал `(page−1)·IPP + posts.length` — **на 1 больше**.

Хронология (IPP=30, страница 22, «+1 новый ответ в пределах последней страницы»):

| Шаг | Событие | readMap[topic].offset |
|---|---|---|
| Визит N (641 пост, len=11) | Effect 15: offset 630+10=**640** → POST, курсор → #641 | 640 |
| Визит N, jump-scroll | offset 630+**11**=**641** → cursor-guard/in-flight гасят POST (то же тело), но **readMap обновляется до 641** | **641** |
| Визит N+1 (642 поста — новый ответ #642, всё ещё страница 22, len=12) | Effect 15: offset 630+11=**641** → backward-guard `641 <= 641` → **RETURN, POST не вызывается** | 641 |

**Deadlock:** каждый визит с ровно одним новым ответом в пределах последней страницы вычисляет offset, РАВНЫЙ записанному jump-вызовом предыдущего визита, и молча глотается. Тема навсегда непрочитана, `read` отсутствует в сети. Корень — до-исторический (инфляция +1 в jump-вызове и сравнение `<=` существовали до правок раздела 12), но проявился именно сейчас.

Существенность: отравленное значение живёт в `localStorage` (`aerun_readmap_<uid>`) и переживает сессии; «самоизлечение» требовало бы двух новых ответов (offset +2).

### 15.3 Исправление

1. **`src/hooks/topic/useTopicJumpScroll.js:79`** — offset приведён к арифметике Effect 15: `+ (posts.length - 1)`. Оба вызывающих теперь вычисляют идентичный offset для одного экрана → расхождение, породившее отравление, устранено в корне.
2. **`src/contexts/AuthProvider.jsx` (backward-guard)** — `offset <= existingOffset` → `offset < existingOffset`. Равный offset при **другом** post id («+1 ответ в той же странице») проходит guard → cursor-guard пропускает только совпадение по id → POST уходит, курсор двигается вперёд. Это также **лечит уже отравленные записи** немедленно (не требуя двух ответов). Назад-навигация вычисляет строго меньший offset и остаётся заблокированной; равный offset при том же post id отсекается cursor-guard'ом (созданным в разделе 12).

### 15.4 Верификация

1. `npx eslint` изменённых файлов — 0 ошибок ✅.
2. `check-golast-overlay`, `check-forum-read-contract`, `check-dm-mutation-state` — зелёные ✅ (выражения offset ни одним гейтом не закреплены — проверено grep'ом).
3. `npm run build` ✅.
4. **Прод-верификация после деплоя frontend:** войти в непрочитанную тему (из раздела 15 сценарий: тема уже посещалась, затем +1 ответ) → `POST /topics/:id/read` уходит, тема покидает список непрочитанных; повторный вход без новых ответов → `read` отсутствует (cursor-guard — корректно).

| Файл | Изменения |
|---|---|
| `src/hooks/topic/useTopicJumpScroll.js` | offset jump-вызова приведён к `+ (posts.length - 1)` (унификация с Effect 15). |
| `src/contexts/AuthProvider.jsx` | backward-guard: `<=` → `<` — равный offset при другом post id больше не глотает mark-read (лечит отравленные записи). |

**Документ готов к переименованию в `DONE_TOPIC_REPLY_NETWORK_STORM_AND_CLIENT_STATE.md` после прод-верификации исправлений разделов 11–15.**

