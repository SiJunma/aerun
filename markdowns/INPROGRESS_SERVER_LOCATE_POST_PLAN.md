# INPROGRESS: Серверный locatePost + loadPosts — план реализации

**Статус:** Завершено (все 5 спринтов выполнены и протестированы)  
**Дата создания:** 2026-10-15  
**Ветка:** `feature/pocketbase-migration`  
**Концепт-основа:** [`CONCEPT_Server locatePost+render.md`](aerun/markdowns/CONCEPT_Server%20locatePost+render.md) + директива человека по унификации с `loadPosts`

---

## 0. Архитектурная парадигма: Единый эндпоинт (Single Endpoint Pattern)

Изначальный концепт предполагал отдельный эндпоинт `/api/aerun/posts/locate`, после которого клиент делал второй запрос на `loadPosts`.
**Утвержденное решение:** Смерджить логику `locatePost` в существующий `GET /api/aerun/topics/:id/posts` (`loadPosts`).

### Как это соотносится с `goToLast`:
В текущем Go-бэкенде ([`forum_posts.go:381–440`](aerun/backend/internal/platform/pocketbase/forum_posts.go#L381-L440)) `goToLast` уже реализован именно так:
- Запрос: `GET /api/aerun/topics/:id/posts?page=last&limit=20`
- Сервер по `topic_read_states` (или `last_visit`) вычисляет первый непрочитанный пост через `COUNT(*)`, определяет нужную страницу `page` и **сразу же возвращает посты этой страницы** в `items`.

Точно так же расширяется поддержка целевого поста `?post=<postId>`:
- `GET /api/aerun/topics/:id/posts?page=2` — загрузка конкретной страницы.
- `GET /api/aerun/topics/:id/posts?page=last` — переход к первому непрочитанному (`goToLast`).
- `GET /api/aerun/topics/:id/posts?post=XYZ` — переход к конкретному посту (`locatePost`). Сервер находит пост в БД, вычисляет страницу через SQL `COUNT(*)`, и **в том же ответе** отдает `items` этой страницы, номер страницы `page`, `target_post_id` и `target_found`.

**Итог:** Ровно **1 сетевой запрос** вместо 41 запроса (клиентский цикл перебора) или 2 запросов (locate + load).

---

## 1. Находки: текущее состояние кода

### 1.1. Текущая клиентская проблема
**Файл:** [`src/api/forum.js:594–626`](aerun/src/api/forum.js#L594-L626)  
`locatePost` выполняет клиентский цикл до 40 страниц последовательными запросами `GET /topics/:id/posts?page=...`. В большой теме это вызывает до 41 HTTP-запроса подряд и сильные зависания интерфейса.

### 1.2. Текущая логика в `TopicPage.jsx`
В [`src/pages/TopicPage.jsx:579–583`](aerun/src/pages/TopicPage.jsx#L579-L583):
```js
if ((hasPostJump || hasHashJump) && !hasExplicitPage) {
  setPosts([]);
  return; // блокирует загрузку постов и ждет отдельного эффекта с locatePost!
}
```
При унификации: `loadPosts` просто передает `post: queryPostId` в `fetchSecuredPosts`, получает за **1 запрос** страницу и посты, сразу монтирует их в DOM и скроллит к элементу.

### 1.3. Обработка краевых ситуаций
1. **Пост удален (hard delete)**:
   - Если пост с `id = postID` не найден в БД, сервер возвращает `target_found: false`, `page: 1` и посты первой страницы.
   - Тема не крашится, не висит вечный скелетон. Фронтенд видит `target_found: false`, показывает тост: `Исходное сообщение было удалено` и очищает `?post=` из адресной строки.
2. **Пост перемещен в другую тему** (`posts.topic_id != :id`):
   - Сервер возвращает `target_found: false`, `moved_to_topic_id: post.topic_id`.
   - Фронтенд выполняет `navigate('/topic/' + moved_to_topic_id + '?post=' + postID)`.
3. **Индекс базы данных**:
   - В SQLite необходим индекс `(topic_id, created, id)` для ускорения `COUNT(*)` и хронологической сортировки.

---

## 2. Спецификация API: `GET /api/aerun/topics/:id/posts`

### Параметры запроса (Query Params):
| Параметр | Тип | Описание |
|---|---|---|
| `limit` | int | Размер страницы (default: `posts_per_page` из настроек, обычно 20) |
| `page` | string / int | Номер страницы (`1`, `2`...) или `last` / `latest` / `unread` |
| `post` | string | ID поста для перехода и локации (`target_post_id`) |
| `last_visit` | string / int | Fallback cutoff для `page=last` |

### Алгоритм на бэкенде (`resolveListPage` в `forum_posts.go`):
1. Если передан параметр `post` (или `post_id`):
   - Найти запись в `posts` по ID.
   - Если записи нет -> `targetFound = false`, `page = 1`.
   - Если `post.topic_id != topicID` -> `targetFound = false`, `movedToTopicID = post.topic_id`.
   - Если `post.topic_id == topicID`:
     - SQL `COUNT` опубликованных постов темы до целевого:
       ```sql
       SELECT COUNT(*) FROM posts
       WHERE topic_id = {:topicID}
         AND (is_draft = false OR is_draft IS NULL)
         AND (created < {:cut} OR (created = {:cut} AND id <= {:pid}))
       ```
     - `page = int((countBefore - 1) / limit) + 1`
     - `targetFound = true`.
2. Иначе если `page == "last" || page == "latest" || page == "unread"`:
   - Существующая логика разрешения по `topic_read_states`.
3. Иначе:
   - `parseIntParam(page, 1)`.

### Формат ответа:
```json
{
  "items": [ /* массив постов страницы */ ],
  "topic_id": "zxg675bwvwox048",
  "posts_count": 142,
  "page": 4,
  "per_page": 20,
  "pinned_post": { /* если page > 1 и first_post_pinned */ },
  "target_post_id": "post_xyz",
  "target_found": true,
  "read_cutoff": "2026-10-15 12:00:00.000Z"
}
```

---

## 3. Пошаговые спринты реализации

### Спринт 1: Миграция базы данных — Индекс `(topic_id, created, id)` [ВЫПОЛНЕНО]
- **Файл:** [`backend/internal/migrations/1769600000_posts_topic_created_index.go`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/backend/internal/migrations/1769600000_posts_topic_created_index.go)
- Добавлен составной индекс на коллекцию `posts`:
  ```go
  posts.AddIndex("idx_posts_topic_created", false, "topic_id, created, id", "")
  ```
- Написан тест в [`backend/internal/migrations/posts_index_test.go`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/backend/internal/migrations/posts_index_test.go).
- Проверено: все тесты миграций успешно пройдены (`go test -v ./internal/migrations` PASS, 22 теста).

### Спринт 2: Бэкенд — расширение `resolveListPage` и `listPostsHandler` [ВЫПОЛНЕНО]
- **Файл:** [`backend/internal/platform/pocketbase/forum_posts.go`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/backend/internal/platform/pocketbase/forum_posts.go#L275-L440)
- Обновлена структура `resolveListPage` и `listPageResolution`:
  - Распознавание `?post=` / `?post_id=`.
  - Поиск записи поста по ID.
  - SQL `CountRecords` с предикатом `(created < :cut) OR (created = :cut AND id <= :pid)` для точного определения позиции.
  - Расчет страницы `(countBefore - 1) / limit + 1`.
  - Возврат полей `target_post_id`, `target_found` (`bool`), `moved_to_topic_id`.
  - Защита черновиков (`is_draft = true` не локализуются).
  - Красивый фолбэк при удаленном посте (`target_found = false`, выдача страницы темы без падения).
- Написаны тесты в [`backend/internal/platform/pocketbase/topic_posts_locate_test.go`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/backend/internal/platform/pocketbase/topic_posts_locate_test.go):
  - `TestListPostsLocatesTargetPost` (локация постов на 1, 2, 3 страницах) — PASS.
  - `TestListPostsLocateTargetPostDeleted` (удаленный пост) — PASS.
  - `TestListPostsLocateTargetPostMovedTopic` (перенесенный пост) — PASS.
  - `TestListPostsLocateDraftExcluded` (черновик) — PASS.

### Спринт 3: Фронтенд API — `fetchSecuredPosts` и `locatePost` [ВЫПОЛНЕНО]
- **Файл:** [`src/api/forum.js`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/api/forum.js#L388-L415)
- `fetchSecuredPosts(topicId, page, pageSize, lastVisit, targetPostId)`:
  - Пробрасывает `&post=${encodeURIComponent(targetPostId)}` в query string.
  - Возвращает нормализованные `targetPostId`, `targetFound`, `movedToTopicId`.
- `locatePost(postId, itemsPerPage, knownTopicId)`:
  - Убран клиентский цикл перебора до 40 страниц!
  - Выполняет прямой запрос к `fetchSecuredPosts` (и при необходимости один `GET /posts/:id` для определения `topic_id`).
  - Сохранена полная совместимость сигнатуры и возвращаемого контракта `{ topicId, page, postId }`.
- Проверено: `node scripts/check-post-navigation.mjs` — PASS (0 errors, 0 warnings, contract verified).

### Спринт 4: Фронтенд UI — интеграция в `TopicPage.jsx` [ВЫПОЛНЕНО]
- **Файл:** [`src/pages/TopicPage.jsx`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/pages/TopicPage.jsx)
- В `loadPosts` ([строки 330–380](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/pages/TopicPage.jsx#L330-L380)):
  - Распознается наличие `searchParams.get('post')` при отсутствии `page`.
  - `targetPostId` передается напрямую в `fetchSecuredPosts` — сервер отдает посты нужной страницы за 1 запрос.
  - Обработка `movedToTopicId`: автоматический переход в новую тему.
  - Обработка `targetFound === false`: показ тоста об удалении, удаление `?post=` из параметров URL, показ 1-й страницы (без падений и бесконечных лоадеров).
  - Обработка `targetFound === true`: обновление `page` в `searchParams` (`replace: true`), прокрутка и центрирование поста.
- В эффекте загрузки ([строки 600–620](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/pages/TopicPage.jsx#L600-L620)):
  - Снята блокировка загрузки для `?post=` — загрузка стартует сразу сервером.
- В Priority 1 и Priority 2:
  - Вызовы `locatePost` дополнены передачей `id` темы для мгновенного резолва за 1 запрос.
- Проверено: `node scripts/check-post-navigation.mjs` — PASS (0 errors, 0 warnings, strict ESLint clean).

### Спринт 5: Регрессионное тестирование и CI [ВЫПОЛНЕНО]
- `node scripts/check-post-navigation.mjs` — PASS (0 errors, 0 warnings, ESLint clean).
- `npm test` на фронтенде — PASS (все 30+ наборов тестов пройдены успешно).
- `go test ./internal/migrations` — PASS (все 22 теста пройдены).
- `go test ./internal/platform/pocketbase -run "TestListPosts|TestTopicReads|TestTopicContext"` — PASS (все целевые интеграционные тесты пройдены).

---

## 4. Итоговые результаты реализации

1. **Единый эндпоинт `GET /api/aerun/topics/:id/posts`**:
   - `?page=N`: числовая пагинация.
   - `?page=last`: переход к первому непрочитанному (`goToLast`).
   - `?post=<postId>`: серверная локация поста (`locatePost`) с немедленной выдачей постов страницы.
2. **Производительность**:
   - Количество запросов при клике на ссылку поста: снижено с 41 запроса до **ровно 1 запроса**.
   - Добавлен индекс `idx_posts_topic_created` по `(topic_id, created, id)`, благодаря чему `COUNT(*)` отрабатывает за микросекунды.
3. **Отказоустойчивость**:
   - При удалении поста сервер возвращает `target_found: false`, тема загружает первую страницу, а пользователь видит тост «Исходное сообщение было удалено» (никаких белых экранов и бесконечных спиннеров).
   - При перемещении поста сервер возвращает `moved_to_topic_id`, и клиент мгновенно редиректит в нужную тему.

