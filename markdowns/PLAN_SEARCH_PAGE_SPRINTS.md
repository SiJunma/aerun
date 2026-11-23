# План спринтов: Полнотекстовый поиск по форуму (Search Page)

> **Статус:** Рабочий пошаговый план внедрения для исполнителя  
> **Ветка:** `main`  
> **Стек:** Go 1.27 + PocketBase v0.40.4 + SQLite (FTS5) + React 19 + Lucide-react  
> **Основа:** `*_Search_Page.md`  
> **Референс:** Классическая панель расширенного поиска форума (стиль MyBB / vBulletin)

---

## 0. Руководство для исполнителя (Прочти перед началом)

Этот документ — пошаговая инструкция для реализации функционала поиска по форуму с нуля. В кодовой базе поиска сейчас нет: отсутствуют FTS5-таблицы, хендлеры, роуты, клиентский API и страница `/search`.

### Ключевые принципы работы:
1. **Спринты выполняются строго по порядку (1 → 6).** Не начинать следующий спринт, пока полностью не закрыт предыдущий и не пройдены все его проверки.
2. **Один спринт = один законченный рабочий инкремент.** После каждого спринта проект должен собираться без ошибок (`npm run build`), проходить тесты (`npm test`, `go test`) и не иметь регрессий.
3. **Безопасность (Zero Leakage) — без компромиссов.** Если совпадение найдено только внутри тега `[hide]`, к которому у зрителя нет доступа, пост **не возвращается** ни в списке, ни в счётчике `total`. Скрытый контент никогда не попадает в сниппеты.
4. **Правила темизации обязательны с первого дня:**
   - **Никаких инлайн-стилей** (`style={...}`) в компонентах поиска.
   - **Никаких Bootstrap-утилит** (`d-flex`, `d-none`, `mb-3`, `text-muted`, `border-0` и др.) в новой вёрстке — все стили определяются именованными классами в `SearchPage.css`.
   - **Никаких новых импортов react-bootstrap.** Кнопки, селекты, чекбоксы — через нативные теги с проектными классами или общие компоненты проекта.
   - **Цвета — только через токены темы** из `src/styles/theme-variables.css`. Прямой hex в CSS запрещён. Новые токены создаются только для цветов и строго во всех трёх темах (`light`, `dark`, `neutral`).
   - **Подсветка `<mark class="search-highlight">`** и выделение целевого поста оформляются через новые цветовые переменные (`--search-highlight-bg`, `--search-highlight-color`), а не захардкоженный жёлтый цвет.
5. **Environment-neutral код и документация:** Никаких абсолютных путей машины разработки в коде, тестах и документах.

---

## Карта спринтов

```
┌────────────────────────────────────────────────────────────────────────┐
│ Спринт 1: Бэкенд FTS5 фундамент, синхронизация мутаций и базовый API   │
│ (Миграция SQLite FTS5, бэкфилл, синхронизация в транзакциях, searchHandler) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 2: Бэкенд безопасность (RBAC, Zero Leakage для [hide], тесты)   │
│ (Фильтрация canViewCategory/canViewTopic, санитизация хайдов, сниппеты)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 3: Клиентский слой API, токенизация темы и утилиты истории     │
│ (src/api/search.js, токены в theme-variables.css, aerun_search_history)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 4: UI — Форма поиска в стиле MyBB и чипы недавних запросов      │
│ (SearchPage.jsx, SearchForm, SearchHistoryChips, SearchPage.css)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 5: UI — Выдача результатов, карточки со сниппетами и пагинация  │
│ (SearchPostCard, TopicRow интеграция, ForumPagination, подсветка <mark>)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 6: Интеграция в экосистему, навигация, deep-link и таб профиля  │
│ (Роут /search, ссылка в Navbar, поиск в теме, ?highlight=, ProfilePage)│
└────────────────────────────────────────────────────────────────────────┘
```

---

## Спринт 1: Бэкенд FTS5 фундамент, синхронизация мутаций и базовый API

### Цель спринта
Развернуть полнотекстовый индекс SQLite FTS5 в PocketBase, обеспечить его 100% транзакционную синхронизацию со всеми мутациями контента (создание, правка, удаление, перенос), выполнить бэкфилл существующих данных и реализовать базовый эндпоинт `GET /api/aerun/search` с поддержкой поисковых операторов и фильтрацией по автору.

### Файлы спринта
- **Создать:**
  - `backend/internal/migrations/1779000000_posts_search_fts5.go`
  - `backend/internal/platform/pocketbase/search.go`
  - `backend/internal/platform/pocketbase/search_query.go`
  - `backend/internal/platform/pocketbase/search_author.go`
  - `backend/internal/platform/pocketbase/search_fts_test.go`
- **Изменить:**
  - `backend/internal/platform/pocketbase/run.go` (регистрация маршрута `group.GET("/search", searchHandler)`)
  - `backend/internal/platform/pocketbase/forum_posts.go` (синхронизация FTS5 при `createPostHandler`, `editPostHandler`, `deletePostHandler`)
  - `backend/internal/platform/pocketbase/forum_topics.go` (синхронизация FTS5 при `createTopicHandler`, `updateTopicHandler`, `deleteTopicHandler`, `moveTopicHandler`, `movePostsHandler`)
  - `backend/internal/platform/pocketbase/drafts.go` (синхронизация FTS5 при `publishDraftHandler`)

---

### Пошаговые задачи исполнителя

#### Задача 1.1. Миграция схемы FTS5 и бэкфилл данных
1. Создать миграцию `backend/internal/migrations/1779000000_posts_search_fts5.go`.
2. В функции применения миграции (`up`):
   - Создать виртуальную таблицу `posts_fts`:
     ```sql
     CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
         post_id UNINDEXED,
         topic_id UNINDEXED,
         category_id UNINDEXED,
         title,
         content,
         author_name,
         tokenize='unicode61 remove_diacritics 2'
     );
     ```
   - Заполнить индекс всеми существующими опубликованными сообщениями:
     - Исключить черновики: `is_draft = 0 OR is_draft IS NULL`.
     - Заголовок темы брать из родительской записи `topics.title`.
     - Имя автора `author_name` вычислять по цепочке `AuthorRef`:
       * если `author_character_id != ""` -> `characters.name`
       * иначе если `author_kind == 'guest'` -> `posts.guest_display_name`
       * иначе -> `users.nickname` (fallback `users.username`)
3. В функции отката (`down`):
   ```sql
   DROP TABLE IF EXISTS posts_fts;
   ```

#### Задача 1.2. Транзакционная синхронизация FTS5 при мутациях контента
В соответствии с правилом `AGENTS.md` (удаление и изменение обязаны синхронизировать все денормализованные копии в той же транзакции):
1. **Создание темы (`createTopicHandler` в `forum_topics.go`):**
   - При создании первого сообщения темы вставить запись в `posts_fts`:
     `INSERT INTO posts_fts (post_id, topic_id, category_id, title, content, author_name) VALUES (...)`.
2. **Создание сообщения (`createPostHandler` в `forum_posts.go`):**
   - В транзакции создания поста добавить запись в `posts_fts` с `title` родительской темы и вычисленным `author_name`.
3. **Публикация черновика (`publishDraftHandler` в `drafts.go`):**
   - В момент конвертации черновика в публичный пост выполнить `INSERT` в `posts_fts`.
4. **Редактирование сообщения (`editPostHandler` в `forum_posts.go`):**
   - Обновить запись в `posts_fts`:
     `UPDATE posts_fts SET content = :content WHERE post_id = :post_id`.
   - Если пост является первым сообщением темы и было отредактировано название темы — обновить `title` во всех постах этой темы в `posts_fts`.
5. **Редактирование темы (`updateTopicHandler` в `forum_topics.go`):**
   - При смене заголовка темы обновить `title` для всех записей с данным `topic_id`:
     `UPDATE posts_fts SET title = :new_title WHERE topic_id = :topic_id`.
6. **Перенос темы в другой раздел (`moveTopicHandler` в `forum_topics.go`):**
   - Обновить `category_id` для всех постов темы:
     `UPDATE posts_fts SET category_id = :new_cat_id WHERE topic_id = :topic_id`.
7. **Перенос постов между темами (`movePostsHandler` в `forum_topics.go`):**
   - Обновить `topic_id`, `category_id` и `title` для переносимых `post_id`.
8. **Удаление сообщения (`deletePostHandler` в `forum_posts.go`):**
   - В той же транзакции удалить строку из FTS5:
     `DELETE FROM posts_fts WHERE post_id = :post_id`.
9. **Удаление темы (`deleteTopicHandler` / `deleteTopicPosts` в `forum_topics.go`):**
   - В той же транзакции удалить все посты темы из FTS5:
     `DELETE FROM posts_fts WHERE topic_id = :topic_id`.

#### Задача 1.3. Парсер и санитизатор поискового запроса (`search_query.go`)
1. Создать хелпер безопасной сборки FTS5 MATCH выражения:
   - Поддержка операторов: `AND`, `OR`, `NOT`.
   - Поддержка точных фраз в кавычках `"..."`.
   - Поддержка префиксного поиска `слово*`.
2. **Санитизация:**
   - Экранировать или отсекать спецсимволы FTS5, вызывающие синтаксические ошибки SQLite (одиночные незакрытые кавычки `"`, двоеточия `:`, скобки, операторы `NEAR`, знаки `+`, `-`, `^`).
   - Валидация минимальной длины слова: термы короче 2 символов отсекаются (защита от перегрузки).
3. Построение условия по области поиска (`in`):
   - `in=both` -> `posts_fts MATCH :query` (поиск по `title`, `content`)
   - `in=content` -> `posts_fts MATCH '{content} : ' || :query`
   - `in=title` -> `posts_fts MATCH '{title} : ' || :query`

#### Задача 1.4. Резолвер автора по модели AuthorRef (`search_author.go`)
1. Реализовать функцию `resolveAuthorIDs(app core.App, authorQuery string, exact bool) (userIDs, charIDs []string, guestPattern string, err error)`:
   - Если `exact = true`:
     * поиск пользователей: `LOWER(nickname) = LOWER(:q) OR LOWER(username) = LOWER(:q)`
     * поиск персонажей: `LOWER(name) = LOWER(:q)`
     * гости: `LOWER(guest_display_name) = LOWER(:q)`
   - Если `exact = false`:
     * поиск пользователей: `nickname LIKE :pattern OR username LIKE :pattern`
     * поиск персонажей: `name LIKE :pattern`
     * гости: `guest_display_name LIKE :pattern`
2. Построение SQL-условия по автору:
   - `(posts.author_id IN (:userIDs) OR posts.author_character_id IN (:charIDs) OR posts.guest_display_name LIKE :guestPattern)`

#### Задача 1.5. Базовый хендлер поиска `searchHandler` (`search.go`)
1. Зарегистрировать маршрут в `registerRoutes` (`run.go`):
   ```go
   group.GET("/search", searchHandler)
   ```
2. Реализовать чтение query-параметров:
   - `q` (string, по умолчанию `""`)
   - `author` (string, по умолчанию `""`)
   - `exact_author` (bool, `0` или `1`)
   - `category_id` (string)
   - `topic_id` (string)
   - `in` (`both`, `content`, `title`, default `both`)
   - `sort` (`created`, `relevance`, `author`, `title`, `category`, default `created`)
   - `order` (`desc`, `asc`, default `desc`)
   - `as` (`posts`, `topics`, default `posts`)
   - `page` (int, 1-based, default 1)
   - `limit` (int, clamp 1..50, default 20)
3. Исключение черновиков: `posts.is_draft = 0 OR posts.is_draft IS NULL`.
4. Сортировка по релевантности: при `sort=relevance` использовать `ORDER BY posts_fts.rank ASC` (в FTS5 меньший ранг BM25 означает более высокую релевантность).
5. Формирование базового JSON-ответа по контракту раздела 6 концепта.

---

### Критерии готовности Спринта 1 (Definition of Done)
1. Миграция FTS5 применяется и откатывается без ошибок.
2. Все операции создания, правки, удаления постов/тем и публикации черновиков атомарно обновляют индекс `posts_fts`.
3. Запросы `GET /api/aerun/search` с параметрами `q`, `author`, `in`, `sort`, `order`, `as`, `page`, `limit` возвращают корректные данные.
4. Ошибочный поисковый синтаксис (незакрытые кавычки, спецсимволы) не роняет базу, а корректно санитизируется.
5. Написаны и проходят тесты `search_fts_test.go`.

### Чеклист проверки после Спринта 1
- [ ] `cd backend && go test -v ./internal/platform/pocketbase -run TestSearchFTS` — все тесты зелёные.
- [ ] `cd backend && go vet ./...` — нет предупреждений.
- [ ] Проверить целостность удаления: создание тестовой темы с 3 постами, поиск по ним, затем удаление темы — поиск по ключевым словам должен вернуть 0 записей.
- [ ] `npm test` в корне проекта выполняется без регрессий.

---

## Спринт 2: Бэкенд безопасность (RBAC, Zero Leakage для `[hide]`, сниппеты, тесты)

### Цель спринта
Обеспечить полную изоляцию прав доступа (RBAC) при поиске, реализовать бескомпромиссную защиту скрытого содержимого (`[hide]`) с гарантией отсутствия утечек информации (Zero Leakage), генерацию безопасных сниппетов текста с подсветкой и покрыть бэкенд интеграционными тестами на безопасность и кириллицу.

### Файлы спринта
- **Создать:**
  - `backend/internal/platform/pocketbase/search_hide.go`
  - `backend/internal/platform/pocketbase/search_snippet.go`
  - `backend/internal/platform/pocketbase/search_security_test.go`
- **Изменить:**
  - `backend/internal/platform/pocketbase/search.go` (подключение RBAC-фильтров, санитизации хайдов и генерации сниппетов)

---

### Пошаговые задачи исполнителя

#### Задача 2.1. RBAC-изоляция категорий и тем
1. В `searchHandler` получить контекст вызывающего: `acc := AccessFrom(e)`.
2. **Если передан параметр `category_id`:**
   - Проверить доступность: `allowed, err := canViewCategory(e.App, acc, reqCatID)`.
   - Если `!allowed` или ошибка: вернуть ошибку валидации `400/403` («категория не найдена или недоступна»).
   - Сузить выборку: `WHERE category_id = :reqCatID`.
3. **Если передан параметр `topic_id`:**
   - Проверить доступность темы и её категории: `allowed, topic, err := canViewTopic(e.App, acc, reqTopicID)`.
   - Если `!allowed` или ошибка: вернуть ошибку валидации `400/403` («тема не найдена или недоступна»).
   - Сузить выборку: `WHERE topic_id = :reqTopicID`.
4. **Если раздел/тема не указаны (глобальный поиск):**
   - Получить все категории форума, отфильтровать их через `canViewCategory(e.App, acc, c.Id)`.
   - Сформировать слайс разрешенных ID `allowedCatIDs`.
   - Если разрешённых категорий нет — вернуть пустой результат (`total: 0, items: []`).
   - Иначе добавить условие: `WHERE category_id IN (:allowedCatIDs)`.
   - *Результат:* посты из закрытых разделов физически не могут попасть в выборку неавторизованного участника или гостя.

#### Задача 2.2. Защита тега `[hide]` и политика Zero Leakage (`search_hide.go`)
1. Определить параметры зрителя:
   ```go
   canBypassHide := auth.Has(acc.Permissions, auth.PermBypassHideTags)
   viewerID := acc.UserID
   viewerPosts := acc.PostCount
   ```
2. Реализовать парсер и санитизатор:
   `sanitizeContentForViewer(content string, authorID string, viewerID string, viewerPosts int, canBypassHide bool) string`
   - Если `canBypassHide == true`: контент возвращается полностью без изменений.
   - Если `viewerID != "" && viewerID == authorID`: контент возвращается полностью (автор видит свои хайды).
   - Для остальных:
     * `[hide]текст[/hide]` — вырезается.
     * `[hide=N]текст[/hide]` — если `viewerID != "" && viewerPosts >= N`, текст остаётся; иначе вырезается.
     * `[hide=@target_id]текст[/hide]` — если `viewerID != "" && viewerID == target_id`, текст остаётся; иначе вырезается.
3. **Критическое правило Zero Leakage (§5.3.2 концепта):**
   - При поиске по ключевым словам (`q != ""`), для каждого кандидата из FTS5 проверяется санитизированный текст:
     * Если поисковые термы присутствовали в исходном посте, но **отсутствуют** в санитизированном тексте (так как находились исключительно внутри недоступного хайда) — такой пост **категорически исключается из результатов**.
     * Пост не попадает в `items` и не увеличивает общий счётчик `total`.
   - Это предотвращает атаку перебором слов, с помощью которой злоумышленник мог бы по наличию совпадения угадать секретные данные под чужим хайдом.

#### Задача 2.3. Генерация сниппетов и очистка BBCode (`search_snippet.go`)
1. Реализовать функцию нарезки сниппета:
   `generateSearchSnippet(sanitizedContent string, queryTerms []string, maxLen int) string`
   - **Очистка тяжелого BBCode:** перед нарезкой вырезать теги, ломающие разметку или загромождающие сниппет (`[quote]...[/quote]`, `[img]...[/img]`, `[spoiler]...[/spoiler]`, `[roll]...[/roll]`, `[dice]...[/dice]`, `[table]...[/table]`).
   - **Контекстное окно:** найти первое (или наиболее релевантное) вхождение поискового терма. Взять окно шириной ~200–300 символов вокруг него с привязкой к границам слов.
   - **Подсветка совпадений:** обернуть найденные термы в `<mark class="search-highlight">терм</mark>`.
   - Если текст обрезан слева или справа — добавить многоточие `...`.
2. При формировании карточки сообщения в ответе декорировать автора через `AuthorRef` DTO (`ForumAuthorAvatar`, `ForumAuthorName`, `ForumCharacterBadge`, `ForumRoleBadge`).

#### Задача 2.4. Набор интеграционных тестов безопасности (`search_security_test.go`)
1. **Тест кириллицы и токенизатора `unicode61`:**
   - Поиск слова "магия" должен находить "Магия", "МАГИЯ", "магический" (при префиксе `маг*`).
2. **Тест RBAC категорий:**
   - Создать скрытую категорию для роли `vip`. Обычный пользователь не должен находить посты из неё ни при глобальном поиске, ни при прямой передаче `category_id`.
3. **Тест Zero Leakage для `[hide]`:**
   - Пост: `Публичный текст [hide]секретный пароль дракона[/hide] продолжение`.
   - Поиск по слову `дракон`:
     * Админ с `PermBypassHideTags` -> находит пост, в сниппете виден текст хайда.
     * Автор поста -> находит пост.
     * Гость / обычный участник -> **0 результатов**, пост не возвращается, `total = 0`.
   - Поиск по слову `публичный`:
     * Обычный участник -> находит пост, но в сниппете блок `[hide]` полностью отсутствует.
4. **Тест `[hide=N]` и `[hide=@user_id]`:**
   - Проверка видимости при достаточном и недостаточном `post_count`.
   - Проверка адресного хайда для целевого получателя и посторонних.

---

### Критерии готовности Спринта 2 (Definition of Done)
1. Выдача `GET /api/aerun/search` строго уважает права на категории `canViewCategory` и темы `canViewTopic`.
2. Тесты на Zero Leakage подтверждают: совпадения только внутри недоступных хайдов не возвращают пост и не протекают в сниппеты.
3. Кириллический поиск регистронезависим.
4. Сниппеты очищены от тяжелых BBCode-тегов и содержат подсветку `<mark class="search-highlight">`.
5. Все тесты в `backend/internal/platform/pocketbase/` проходят.

### Чеклист проверки после Спринта 2
- [ ] `cd backend && go test -v ./internal/platform/pocketbase -run "TestSearchSecurity|TestSearchHideZeroLeakage"` — все тесты проходят.
- [ ] `cd backend && go test ./...` — полный пакет бэкенда зелёный.
- [ ] Проверить, что закрытый раздел возвращает 403 / пустой список для гостя.
- [ ] `npm test` в корне проекта зелёный.

---

## Спринт 3: Клиентский слой API, токенизация темы и утилиты истории

### Цель спринта
Создать клиентский модуль вызова API поиска `src/api/search.js`, внедрить дизайн-токены подсветки и элементов поиска во все три темы (`light`, `dark`, `neutral`) в `src/styles/theme-variables.css`, реализовать утилиту работы с историей поиска в `localStorage` (`aerun_search_history`) с ограничением до 5 записей.

### Файлы спринта
- **Создать:**
  - `src/api/search.js`
  - `src/utils/searchHistory.js`
  - `scripts/check-search-api.mjs`
  - `scripts/check-search-history.mjs`
- **Изменить:**
  - `src/styles/theme-variables.css` (добавление новых цветовых переменных во все 3 темы)
  - `package.json` (подключение проверочных скриптов к `npm test`)

---

### Пошаговые задачи исполнителя

#### Задача 3.1. Добавление цветовых токенов темы (`theme-variables.css`)
В соответствии с разделом 8 концепта и правилом запрета захардкоженного жёлтого цвета:
1. В блок `body` (базовая/светлая тема):
   ```css
   /* ── Search Tokens ────────────────────────────────────────── */
   --search-highlight-bg: rgba(245, 158, 11, 0.25);
   --search-highlight-color: inherit;
   --search-chip-bg: var(--card-bg);
   --search-chip-text: var(--text-color);
   --search-chip-border: var(--border-color);
   --search-chip-hover-bg: rgba(var(--primary-rgb), 0.08);
   --search-topic-banner-bg: rgba(var(--primary-rgb), 0.06);
   --search-topic-banner-border: rgba(var(--primary-rgb), 0.2);
   --search-target-pulse-border: var(--link-color);
   ```
2. В блок `[data-theme='dark']`:
   ```css
   --search-highlight-bg: rgba(245, 158, 11, 0.35);
   --search-highlight-color: #fbbf24;
   --search-chip-bg: rgba(255, 255, 255, 0.05);
   --search-chip-text: var(--text-color);
   --search-chip-border: rgba(255, 255, 255, 0.12);
   --search-chip-hover-bg: rgba(255, 255, 255, 0.1);
   --search-topic-banner-bg: rgba(var(--primary-rgb), 0.15);
   --search-topic-banner-border: rgba(var(--primary-rgb), 0.35);
   --search-target-pulse-border: var(--link-color);
   ```
3. В блок `[data-theme='neutral']`:
   ```css
   --search-highlight-bg: rgba(217, 119, 6, 0.22);
   --search-highlight-color: inherit;
   --search-chip-bg: var(--card-bg);
   --search-chip-text: var(--text-color);
   --search-chip-border: var(--border-color);
   --search-chip-hover-bg: rgba(0, 0, 0, 0.05);
   --search-topic-banner-bg: rgba(0, 0, 0, 0.04);
   --search-topic-banner-border: var(--border-color);
   --search-target-pulse-border: var(--secondary-color);
   ```
4. **Важно:** Геометрических токенов (размеры, паддинги, радиусы) не создавать — все размеры задаются литералами в CSS-классах.

#### Задача 3.2. Клиентский API модуль `src/api/search.js`
1. Реализовать функцию `searchForum(params)`:
   - Принимает объект:
     ```js
     {
       q = '',
       author = '',
       exact_author = false,
       category_id = '',
       topic_id = '',
       in: searchIn = 'both',
       sort = 'created',
       order = 'desc',
       as = 'posts',
       page = 1,
       limit = 20
     }
     ```
   - Строит `URLSearchParams` (пустые параметры не включаются в query).
   - Выполняет запрос `pb.send('/api/aerun/search?' + queryParams.toString(), { method: 'GET' })`.
   - При сетевых ошибках возвращает структурированный объект ошибки, готовый для отображения в `ErrorCard`.

#### Задача 3.3. Утилита истории поиска `src/utils/searchHistory.js`
1. Константа ключа: `const SEARCH_HISTORY_KEY = 'aerun_search_history';`
2. Максимальный размер: `const MAX_HISTORY_ITEMS = 5;`
3. Методы:
   - `getSearchHistory()`: безопасное чтение из `localStorage` (возвращает массив объектов, при поврежденном JSON возвращает `[]`).
   - `saveSearchHistory(entry)`: добавляет запись в начало, удаляет дубликаты по совпадению `(q, author, category_id, topic_id, as)`, оставляет не более 5 элементов (FIFO).
   - `removeSearchHistoryItem(index)`: удаляет элемент по индексу.
   - `clearSearchHistory()`: очищает ключ в `localStorage`.

#### Задача 3.4. Тесты контракта и утилит
1. Создать `scripts/check-search-api.mjs`: проверка экспортов `src/api/search.js` и нормализации параметров.
2. Создать `scripts/check-search-history.mjs`: проверка лимита 5 элементов, удаления дублей и очистки.
3. Добавить их вызов в `package.json` в секцию `scripts.test`.

---

### Критерии готовности Спринта 3 (Definition of Done)
1. Цветовые переменные поиска добавлены во все 3 темы без пропусков.
2. Модуль `src/api/search.js` протестирован и корректно форматирует query-строку.
3. Утилита `searchHistory.js` строго соблюдает лимит 5 записей и вытеснение FIFO.
4. `npm test` проходит без ошибок.

### Чеклист проверки после Спринта 3
- [ ] `node scripts/check-search-api.mjs` — OK.
- [ ] `node scripts/check-search-history.mjs` — OK.
- [ ] `git diff src/styles/theme-variables.css` — новые переменные есть в `body`, `[data-theme='dark']` и `[data-theme='neutral']`.
- [ ] `npm run lint:js` — 0 ошибок и предупреждений.

---

## Спринт 4: UI — Форма поиска в стиле MyBB и чипы недавних запросов

### Цель спринта
Сверстать страницу поиска `SearchPage.jsx` со стилизованной формой расширенного поиска в референсном стиле MyBB/vBulletin, чипами истории запросов, двусторонней синхронизацией параметров с URL и плашкой контекстного поиска в теме.

### Файлы спринта
- **Создать:**
  - `src/pages/SearchPage.jsx`
  - `src/components/search/SearchForm.jsx`
  - `src/components/search/SearchHistoryChips.jsx`
  - `src/styles/SearchPage.css`
  - `scripts/check-search-theming-rules.mjs`
- **Изменить:**
  - `package.json` (добавление `check-search-theming-rules.mjs` в `npm test`)

---

### Пошаговые задачи исполнителя

#### Задача 4.1. Стилизация страницы `src/styles/SearchPage.css`
Строго следовать правилам раздела 8 концепта:
1. Семантические классы:
   - `.search-page`: контейнер страницы (max-width, отступы).
   - `.search-topic-banner`: плашка контекстного поиска в теме (фон `--search-topic-banner-bg`, рамка `--search-topic-banner-border`, скругление 8px, кнопка сброса темы).
   - `.search-history`: контейнер чипов истории.
   - `.search-chip`: интерактивный тег (фон `--search-chip-bg`, рамка `--search-chip-border`, ховер `--search-chip-hover-bg`, цвет текста `--search-chip-text`).
   - `.search-chip__remove`: кнопка удаления отдельного чипа.
   - `.search-form-card`: карточка формы (фон `--card-bg`, рамка `--border-color`, скругление 12px, тень).
   - `.search-section`: секция формы (заголовок small-caps, разделитель).
   - `.search-grid`: CSS Grid раскладка формы (десктоп: 2–3 колонки, мобильный: 1 колонка).
   - `.search-field`: блок поля (лейбл, инпут, хинт).
   - `.search-input`, `.search-select`: нативные элементы управления со стилизацией проекта.
   - `.search-checkbox-label`: чекбокс точного автора.
   - `.search-actions`: ряд кнопок отправки и сброса.
2. **Запреты:**
   - Никаких инлайн-стилей `style={{ ... }}`.
   - Никаких утилитных классов Bootstrap (`d-flex`, `p-2`, `mb-3`, `text-muted` и т.д.).
   - Цвета только через `var(--...)`.

#### Задача 4.2. Компонент чипов истории `SearchHistoryChips.jsx`
1. Отображает до 5 недавних запросов над формой.
2. Каждый чип содержит краткое описание: текст `q` или автора `author`.
3. Клик по чипу:
   - Заполняет все поля формы сохранёнными параметрами.
   - Немедленно инициирует выполнение поискового запроса.
4. Кнопка `[✕]` на чипе удаляет этот запрос из `localStorage` без запуска поиска.
5. Кнопка `[Очистить историю]` очищает все чипы.

#### Задача 4.3. Компонент формы расширенного поиска `SearchForm.jsx`
1. **Контекстная плашка (если задан `topic_id`):**
   - «🔍 Поиск в теме: [Название темы] [✕ Искать везде]».
   - Клик по «Искать везде» сбрасывает `topic_id` и переводит поиск в режим всего форума.
2. **Секция 1: Критерии поиска (Enter your search criteria):**
   - Поле «Ключевые слова» (`q`) с текстовой подсказкой: «Разделяйте слова пробелами. Используйте AND, OR, NOT, кавычки и звездочку *».
   - Поле «Автор» (`author`) + чекбокс «Точное совпадение» (`exact_author`).
3. **Секция 2: Где и что искать (Select where and what to search):**
   - Выпадающий список «Раздел» (`category_id`): опция «Все разделы» + список доступных категорий, сгруппированных по группам разделов (категории получаются через существующий контекст или запрос; закрытые категории исключаются).
   - Выпадающий список «Искать в» (`in`):
     * «В тексте и заголовках» (`both`)
     * «Только в тексте сообщений» (`content`)
     * «Только в заголовках тем» (`title`)
4. **Секция 3: Отображение результатов (Select how to view search results):**
   - «Сортировать по» (`sort`): Дата публикации (`created`), Релевантность (`relevance`), Автор (`author`), Заголовок (`title`), Раздел (`category`).
   - «Порядок» (`order`): По убыванию (`desc`), По возрастанию (`asc`).
   - «Формат выдачи» (`as`): Сообщения (`posts`), Темы (`topics`).
5. **Кнопки:**
   - «Найти» (акцентная кнопка)
   - «Сбросить фильтры» (нейтральная кнопка, очищающая форму к дефолтным значениям).
   - *Важно:* Использовать нативный `<button type="submit">` с проектными классами или общий `Button` проекта, без `react-bootstrap`.

#### Задача 4.4. Синхронизация с URL в `SearchPage.jsx`
1. Использовать хук `useSearchParams` из `react-router-dom`.
2. При загрузке страницы: если URL содержит поисковые параметры (например, `/search?q=магия&as=posts`), форма предзаполняется из URL и автоматически запускается поиск.
3. При сабмите формы: параметры записываются в URL через `setSearchParams(...)` (пустые значения не пишутся).
4. История браузера: кнопки «Назад» и «Вперёд» корректно обновляют состояние формы.

#### Задача 4.5. Скрипт проверки правил темизации
1. Создать `scripts/check-search-theming-rules.mjs`:
   - Сканирует файлы `src/pages/SearchPage.jsx`, `src/components/search/**/*.jsx`, `src/styles/SearchPage.css`.
   - Проверяет:
     * Отсутствие атрибутов `style={`.
     * Отсутствие Bootstrap-утилитных классов (`d-flex`, `d-none`, `p-`, `m-`, `text-`, `border-`, `bg-`).
     * Отсутствие импортов из `'react-bootstrap'`.
     * Отсутствие прямых hex-кодов (`#fff`, `#000` и т.д.) в `SearchPage.css`.
2. Добавить запуск скрипта в `package.json` -> `npm test`.

---

### Критерии готовности Спринта 4 (Definition of Done)
1. Форма поиска полностью воспроизводит структуру референса (3 секции, подсказки, плашка темы, чипы).
2. Параметры формы полностью синхронизируются с URL в обе стороны.
3. Чипы истории префиллят форму и удаляются индивидуально / целиком.
4. Скрипт `check-search-theming-rules.mjs` подтверждает нулевое наличие инлайн-стилей, Bootstrap-утилит и hex-кодов.
5. Страница проверена визуально в светлой, тёмной и нейтральной темах.

### Чеклист проверки после Спринта 4
- [ ] `node scripts/check-search-theming-rules.mjs` — PASS (0 нарушений).
- [ ] `npm run lint:js` — чистый вывод.
- [ ] Ручная проверка в браузере: ввод параметров, сабмит, перезагрузка страницы — все поля остаются заполненными.
- [ ] Проверка респонсивности: форма корректно перестраивается в одну колонку на мобильном экране (≤768px).

---

## Спринт 5: UI — Выдача результатов, карточки со сниппетами и пагинация

### Цель спринта
Реализовать отображение результатов поиска в двух форматах (`Posts` и `Topics`), карточки сообщений со сниппетами и подсветкой `<mark class="search-highlight">`, интеграцию `TopicRow.jsx`, пагинацию через `ForumPagination.jsx`, а также скелетоны загрузки и пустые состояния.

### Файлы спринта
- **Создать:**
  - `src/components/search/SearchPostCard.jsx`
  - `src/components/search/SearchResultsHeader.jsx`
- **Изменить:**
  - `src/pages/SearchPage.jsx` (интеграция получения данных, пагинации, переключения режимов выдачи)
  - `src/styles/SearchPage.css` (стили карточек постов, сниппетов, подсветки `<mark>`, хлебных крошек)

---

### Пошаговые задачи исполнителя

#### Задача 5.1. Карточка результата сообщения `SearchPostCard.jsx` (`as=posts`)
1. **Шапка карточки:**
   - Хлебные крошки раздела: `<Link to="/category/:catId">{category_name}</Link> » <Link to="/topic/:topicId">{topic_title}</Link>`.
   - Заголовок темы с подсветкой искомых слов (если совпадение было в названии).
   - Ссылка на пост: `<Link to="/topic/:topicId?post=:postId&highlight=:query">Перейти к сообщению »</Link>`.
2. **Блок автора (полная поддержка модели AuthorRef):**
   - Переиспользовать проектные компоненты:
     * `ForumAuthorAvatar`
     * `ForumAuthorName`
     * `ForumCharacterBadge` (если пост написан от лица персонажа)
     * `ForumRoleBadge`
     * Таймстамп публикации через проектный хелпер форматирования дат.
3. **Сниппет текста:**
   - Вывод сниппета, полученного от бэкенда, с безопасным рендерингом тегов `<mark class="search-highlight">`.
   - Оформление подсветки в `SearchPage.css`:
     ```css
     .search-highlight {
       background-color: var(--search-highlight-bg);
       color: var(--search-highlight-color);
       padding: 0.1em 0.25em;
       border-radius: 3px;
       font-weight: 600;
     }
     ```
4. Верстка: карточка оформляется семантическими классами `.search-result-card`, `.search-result-header`, `.search-result-author`, `.search-result-content`. Без инлайн-стилей.

#### Задача 5.2. Отображение в виде списка тем (`as=topics`)
1. Переиспользовать готовый проектный компонент `TopicRow.jsx`.
2. Передать проп `showCategory={true}`, чтобы в строке темы отображалось название раздела.
3. Подсветить ключевые слова в названии темы (оборачивая совпадения в `<mark class="search-highlight">`).

#### Задача 5.3. Шапка результатов, скелетоны и пустые состояния
1. **Компонент `SearchResultsHeader.jsx`:**
   - Строка статистики: *«Результаты поиска: Найдено {total} {сообщений/тем} (Страница {page} из {totalPages})»*.
2. **Состояние загрузки:**
   - При выполнении запроса показывать скелетоны по проектному паттерну (полоски реалистичной ширины, без мигания старым контентом).
3. **Пустой результат:**
   - Если `total === 0` и запрос выполнен — рендерить общий компонент `ForumEmptyState`:
     * Заголовок: «Ничего не найдено».
     * Описание: «Попробуйте изменить формулировку запроса, убрать лишние фильтры или использовать оператор OR».
4. **Обработка ошибок:**
   - При ошибке сети или 500 — показывать `ErrorCard` с понятным текстом и кнопкой «Повторить запрос».

#### Задача 5.4. Пагинация через `ForumPagination.jsx`
1. Подключить проектный компонент `ForumPagination.jsx`.
2. Передать `currentPage={page}`, `totalPages={totalPages}`, `onPageChange={handlePageChange}`.
3. При клике на страницу:
   - Обновлять параметр `page` в URL.
   - Скроллить страницу к началу результатов поиска.
   - Сохранять все остальные фильтры в неизменном виде.

---

### Критерии готовности Спринта 5 (Definition of Done)
1. Выдача в режиме `as=posts` рендерит карточки постов со сниппетами, подсветкой и корректным `AuthorRef`.
2. Выдача в режиме `as=topics` рендерит темы через `TopicRow` с отображением категорий.
3. Пагинация работает плавно, меняет страницу в URL и сохраняет фильтры.
4. Отработаны состояния загрузки, пустого результата и сетевой ошибки.
5. Скрипт `check-search-theming-rules.mjs` и `npm test` зелёные.

### Чеклист проверки после Спринта 5
- [ ] `npm test` — все тесты проходят.
- [ ] `npm run build` — фронтенд собирается без ошибок за штатное время (~10 с).
- [ ] Ручная проверка подсветки в трёх темах:
  * В `light` теме подсветка контрастна и легко читается.
  * В `dark` теме подсветка не слепит и не сливается с тёмным фоном карточки.
  * В `neutral` теме подсветка гармонична с серыми тонами.
- [ ] Проверка клика по хлебным крошкам и кнопке «Перейти к сообщению».

---

## Спринт 6: Интеграция в экосистему, навигация, deep-link и таб профиля

### Цель спринта
Зарегистрировать маршрут `/search` в приложении, добавить ссылку в верхний навбар для пользователей и гостей, внедрить кнопку «Поиск в теме» на странице темы, реализовать deep-link переход с подсветкой целевого сообщения в теме (`?highlight=`), добавить переключатель в профиль автора и провести финальную сквозную приёмку.

### Файлы спринта
- **Создать:**
  - `scripts/check-search-integration.mjs`
- **Изменить:**
  - `src/App.jsx` (регистрация роута `/search`)
  - `src/components/layout/Navbar.jsx` (добавление пункта «Поиск»)
  - `src/pages/TopicPage.jsx` (кнопка «Поиск в теме», обработка `?highlight=`)
  - `src/components/topic/TopicPostCard.jsx` (эффект подсветки целевого сообщения при наличии `highlight`)
  - `src/styles/topic-view.css` (анимация и стили подсветки целевого поста)
  - `src/pages/ProfilePage.jsx` (переключатель «Сообщения автора / Темы автора»)
  - `src/i18n/dictionary.js` (добавление ключей локализации для поиска)

---

### Пошаговые задачи исполнителя

#### Задача 6.1. Маршрут `/search` в `App.jsx`
1. Импортировать `SearchPage` (с lazy-loading или прямым импортом по паттерну `App.jsx`).
2. Зарегистрировать публичный маршрут:
   ```jsx
   <Route path="/search" element={<SearchPage />} />
   ```
   *Маршрут доступен и авторизованным пользователям, и гостям.*

#### Задача 6.2. Ссылка «Поиск» в навбаре (`Navbar.jsx`)
1. Добавить пункт в основную навигацию навбара рядом с «Пользователи» (`/members`):
   ```jsx
   <Nav.Link as={Link} to="/search" onClick={() => setExpanded(false)}>
     {t('nav.search', 'Поиск')}
   </Nav.Link>
   ```
2. Убедиться, что ссылка видна и гостям (`allowGuest: true`), и авторизованным участникам.
3. При клике мобильное меню корректно схлопывается (`setExpanded(false)`).

#### Задача 6.3. Кнопка «Поиск в теме» в `TopicPage.jsx`
1. В панели действий темы (рядом с кнопками подписки и ответа) добавить кнопку:
   ```jsx
   <button
     type="button"
     className="topic-action-btn"
     onClick={handleSearchInTopic}
     title={t('forum.search_in_topic', 'Поиск в теме')}
   >
     <Search size={16} />
     <span className="topic-action-btn__text">{t('forum.search_in_topic', 'Поиск в теме')}</span>
   </button>
   ```
2. Обработчик `handleSearchInTopic` выполняет переход:
   `navigate(`/search?topic_id=${topic.id}&as=posts`)`.

#### Задача 6.4. Deep-link подсветка сообщения (`TopicPage.jsx` + `TopicPostCard.jsx`)
1. При переходе из поиска ссылка на сообщение имеет вид:
   `/topic/:topicId?post=:postId&highlight=:encodedQuery`.
2. В `TopicPage.jsx`:
   - Серверный локатор `locatePost` уже находит нужную страницу и позицию.
   - Извлечь `highlight` из query-параметров.
3. В `TopicPostCard.jsx`:
   - Если `post.id === targetPostId` и передан `highlight`:
     * Добавить карточке класс целевой подсветки `.topic-post--search-target`.
     * В тексте сообщения ключевые слова подсвечиваются тегом `<mark class="search-highlight">`.
4. В `src/styles/topic-view.css`:
   - Добавить плавную анимацию затухания рамки:
     ```css
     .topic-post--search-target {
       outline: 2px solid var(--search-target-pulse-border);
       box-shadow: 0 0 12px var(--search-highlight-bg);
       animation: searchTargetFade 3s ease-out forwards;
     }

     @keyframes searchTargetFade {
       0%, 70% {
         outline-color: var(--search-target-pulse-border);
       }
       100% {
         outline-color: transparent;
       }
     }
     ```

#### Задача 6.5. Расширение таба «Сообщения» в `ProfilePage.jsx`
В соответствии с разделом 7.3 концепта (отдельный поиск из профиля не выносится):
1. В существующий таб «Сообщения» профиля добавить сегментированный переключатель:
   - `[ Сообщения автора ]` / `[ Темы автора ]`.
2. При выборе «Темы автора» запрашивать список тем, созданных данным пользователем (через существующий API тем автора), отображая их через `TopicRow`.

#### Задача 6.6. Локализация (`dictionary.js`)
1. Добавить русские и английские фразы для всех новых элементов интерфейса:
   - `nav.search`: "Поиск" / "Search"
   - `forum.search_in_topic`: "Поиск в теме" / "Search in topic"
   - `search.*`: заголовки секций формы, подсказки операторов, опции селектов, плейсхолдеры, тексты чипов и результатов.

#### Задача 6.7. Скрипт интеграционной проверки `check-search-integration.mjs`
1. Проверяет наличие маршрута `/search` в `App.jsx`.
2. Проверяет наличие ссылки в `Navbar.jsx`.
3. Проверяет наличие кнопки поиска в теме в `TopicPage.jsx`.
4. Проверяет отсутствие запрещённых паттернов (инлайн-стили, Bootstrap-утилиты, react-bootstrap).
5. Подключить к `npm test`.

---

### Критерии готовности Спринта 6 (Definition of Done)
1. Роут `/search` доступен в браузере гостю и залогиненному участнику.
2. В навбаре отображается ссылка «Поиск».
3. В теме работает кнопка «Поиск в теме», открывая `/search` с плашкой темы.
4. Deep-link переход подсвечивает целевое сообщение и слова запроса.
5. В профиле работает переключатель «Сообщения автора / Темы автора».
6. Полный цикл автоматических проверок (`npm test`, `npm run build`, `go test`) зелёный.
7. Проведен визуальный аудит во всех трёх темах (`light`, `dark`, `neutral`).

### Чеклист проверки после Спринта 6
- [ ] `node scripts/check-search-integration.mjs` — PASS.
- [ ] `npm test` — все тесты проекта зелёные (35+ тестов).
- [ ] `npm run lint:js` — 0 ошибок и 0 предупреждений.
- [ ] `npm run build` — успешная сборка без ошибок.
- [ ] `cd backend && go test ./...` — полный пакет Go-тестов зелёный.
- [ ] Ручной сценарий E2E в браузере:
  1. Главная страница → клик «Поиск» в навбаре → открылась `/search`.
  2. Ввести запрос с оператором (например, `магия AND огонь`), выбрать формат «Сообщения» → клик «Найти».
  3. В выдаче отобразились сниппеты с подсвеченными словами `<mark>`.
  4. В истории появился чип недавнего запроса.
  5. Клик по ссылке «Перейти к сообщению » в карточке → открылась страница темы на нужном посте с мягкой подсветкой.
  6. В теме клик «Поиск в теме» → возврат на `/search` с плашкой «Поиск в теме: [Название]».
  7. Клик по крестику на плашке → поиск сбросился на весь форум.
  8. Переключить тему оформления на Dark, затем на Neutral — интерфейс поиска, чипы и подсветка отображаются гармонично и контрастно.

---

## 7. Сводная таблица правил и проверок

| Правило | Где проверять | Команда / Скрипт |
|---|---|---|
| **Zero Leakage ([hide])** | Go backend | `go test -v ./internal/platform/pocketbase -run TestSearchHideZeroLeakage` |
| **RBAC разделов** | Go backend | `go test -v ./internal/platform/pocketbase -run TestSearchSecurity` |
| **Кириллица Unicode61** | Go backend | `go test -v ./internal/platform/pocketbase -run TestSearchFTS` |
| **FTS5 мутации** | Go backend | `go test -v ./internal/platform/pocketbase -run TestSearchSyncMutations` |
| **Без инлайн-стилей** | Frontend JSX | `node scripts/check-search-theming-rules.mjs` |
| **Без Bootstrap-утилит** | Frontend JSX / CSS | `node scripts/check-search-theming-rules.mjs` |
| **Без react-bootstrap** | Frontend JSX | `node scripts/check-search-theming-rules.mjs` |
| **Токены во всех 3 темах** | theme-variables.css | `node scripts/check-search-theming-rules.mjs` |
| **История до 5 запросов** | localStorage | `node scripts/check-search-history.mjs` |
| **Интеграция навбара/роута** | App.jsx, Navbar.jsx | `node scripts/check-search-integration.mjs` |
| **Общая сборка фронтенда** | Vite build | `npm run build` |
| **Линтер фронтенда** | ESLint | `npm run lint:js` |
| **Регрессия тестов** | Весь проект | `npm test` |
