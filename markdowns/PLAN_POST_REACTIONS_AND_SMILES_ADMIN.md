# План реализации: Реакции на посты (в стиле Discord) и единая админ-панель смайлов/реакций

> **Статус:** План имплементации для исполнителя  
> **Дата:** 2026-11-26  
> **Ветка:** `main`  
> **Стек:** Go 1.27 + PocketBase v0.40 + SQLite, React 19 + Vite + Lucide-react  
> **Связанные документы:** [`CONCEPT_Smiles_Customization.md`](./CONCEPT_Smiles_Customization.md), [`SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md`](./SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md), [`PROJECT_SPEC.md`](../PROJECT_SPEC.md)

---

## 1. Цели и продуктовый контракт

Добавить Discord-подобные реакции на сообщения форума с единой админ-настройкой наборов (совместно с кастомными смайлами/стикерами из `CONCEPT_Smiles_Customization.md`).

### Ключевые требования
1. **UI рядом с репутацией поста (`TopicPostCard.jsx`):**
   - Кнопка добавления реакции с иконкой **смайлика** (`SmilePlus`), а не плюса.
   - По клику открывается выпадашка/поповер (на мобильных — адаптированная панель/bottom sheet) с поиском, секцией **«Часто/недавно используемое»** и категориями (включая кастомные стикеры и эмодзи).
   - Установленные реакции отображаются пилюлями `[иконка/эмодзи] N`; свои реакции визуально выделены.
   - Клик по существующей пилюле **добавляет** голос пользователя, повторный клик — **отжимает** (снимает) реакцию. При `count === 0` пилюля исчезает.
2. **Просмотр кто прореагировал (Desktop + Mobile):**
   - **На десктопе при ховере** по пилюле — тултип со списком ников (`Прореагировали: Envy, баэль бард` / `и ещё N`).
   - **Модалка просмотра всех реакций (удобно на мобильных):** в стиле Discord — список реакций с количеством (слева на десктопе / горизонтальная лента чипов сверху на мобильных) и список участников с аватарками, ссылками на профиль и временем (справа / снизу).
   - **Точка входа в модалку:** объединённая кнопка **глазика** (`.rep-eye-btn` / `PostVotersModal.jsx`) с двумя вкладками — **«Репутация»** и **«Реакции»**. По умолчанию глазик открывает вкладку **«Репутация»** (а для гостевых постов и постов без голосов репутации — сразу вкладку **«Реакции»**). На тач-экранах дополнительно можно поддержать долгое нажатие (long-press) по пилюле для быстрого перехода сразу к этой реакции.
3. **Кто и на какие посты может ставить реакции:**
   - Ставить реакции могут **только авторизованные пользователи и спектаторы** (роли `root`, `admin`, `moderator`, `player`, `spectator` с правом `use_reactions` и статусом `active`). Гости (`guest`), неподтверждённые (`pending`) и заблокированные (`banned`) реакции ставить не могут.
   - **Нельзя ставить реакции на собственные посты** (`post.author_id === currentUser.id`) — как и с репутацией, кнопка `SmilePlus` скрыта, клик по пилюлям не голосует, сервер возвращает отказ (`403`).
   - Реакции можно ставить на **любой опубликованный чужой пост**, включая **посты гостей** (`author_id == ""`). На черновиках (`is_draft = true`) реакции недоступны.
4. **Жизненный цикл (перенос и удаление) и изоляция от счётчиков:**
   - Реакции привязаны строго к посту: **при переносе темы или поста** (`moveTopic` / `movePosts`) реакции остаются на месте без изменений и **без каких-либо уведомлений**.
   - **При удалении поста или темы** реакции удаляются вместе с постом **безвозвратно**, **без отправки каких-либо уведомлений**.
   - Реакции **не меняют** `posts.reputation`, `users.reputation`, `users.post_count`, `users.topics_count` и не участвуют в `RecomputeUserCounters` / `RecomputePostReputation`.
5. **Уведомления и защита от спама:**
   - При добавлении реакции автору поста (если это зарегистрированный пользователь, а не гостевой пост) отправляется in-app уведомление `post_reaction` — аналогично `reputation_change`.
   - **Анти-спам инвариант:** при повторном снятии и постановке одной и той же реакции одним и тем же пользователем на один и тот же пост уведомление отправляется **только один раз** (на первое добавление). На каждую *другую* уникальную реакцию того же пользователя на этом посте — своё одно уведомление. Удаление/архивирование уведомления получателем не сбрасывает этот запрет.
6. **Администрирование и темизация:**
   - В админке создаётся раздел **«Смайлы и реакции»** (в `forumContent` в `src/config/adminNavigation.js`), объединяющий управление наборами стикеров/смайлов (по `CONCEPT_Smiles_Customization.md`) и списками доступных реакций (категории, порядок, включение/выключение, загрузка своих картинок, привязка эмодзи и стикеров из паков).
   - **Строгие правила темизации (и на посте, и в админке):** никаких inline-стилей (`style={...}`), никаких компонентов `react-bootstrap` и Bootstrap-утилит (`d-flex`, `mb-3`, `text-muted` и т.п.); только семантические CSS-классы и цвета через переменные из `src/styles/theme-variables.css`.

---

## 2. UX и UI-архитектура

### 2.1. Блок реакций в `TopicPostCard.jsx`
Сейчас в `src/components/topic/TopicPostCard.jsx` (строки 366–465) строка `.post-meta-row` рендерится только при условии:
```jsx
{!isDraft && !isEditing && (post.author?.user_id || (post.rolls && Object.keys(post.rolls).length > 0)) && (...)}
```
Из-за этого у гостевых постов без бросков кубиков строка вообще не выводится.

**Изменение:**
- Право реакции на посте: `const isOwnPost = !!(post.author?.user_id && post.author.user_id === user?.uid);` и `const canReact = !!(user && !isOwnPost && hasPermission?.(PERMISSIONS.USE_REACTIONS));` (плюс на клиенте для `pending` `hasPermission` уже вернёт `false` после сужения `NarrowForStatus`).
- Условие рендера `.post-meta-row` для опубликованного поста (`!isDraft && !isEditing`):
  - рендерить всегда, если есть хотя бы одно из: `post.author?.user_id`, броски кубиков `post.rolls`, активные реакции `post.reactions?.length > 0`, либо `canReact`.
- Структура `.post-meta-row` (строго семантическая вёрстка без `react-bootstrap`, без Bootstrap-утилит и без inline-стилей; все цвета — через CSS-переменные в `src/styles/theme-variables.css`, раскладка — в `src/styles/topic-view.css`):
  - Левый слот: `.post-dice-slot` (кубики, как сейчас) + `.post-reactions-bar` (с `flex-wrap: wrap`, чтобы длинный ряд реакций не сжимал блок `.post-rep`).
  - Состав `.post-reactions-bar`:
    - Пилюли реакций (`button.reaction-pill`, с модификатором `.is-reacted` для своих реакций и `.is-readonly` на своём посте / у гостей): `[emoji или <img className="reaction-pill__img" />] <span>{count}</span>`. На своём посте и у гостей клик по пилюле не голосует (можно открыть модалку или показать тултип).
    - Кнопка добавления (`button.reaction-add-btn` с иконкой `<SmilePlus size={15} />`), видимая только при `canReact` (скрыта для гостей, `pending`, `banned` и на собственных постах).
  - Правый слот `.post-rep`:
    - Кнопка глазика (`.rep-eye-btn`) — показывается, если `(postRepVotesCount > 0 || postRepValue !== 0 || postReactionsTotal > 0)`.
    - Бейдж кармы поста (только для постов с `post.author?.user_id`, для гостевых постов бейдж репутации по-прежнему не выводится).

### 2.2. Просмотр списка реакций (объединённый глазик)
- Единая кнопка глазика (`.rep-eye-btn`) открывает обновлённый `PostVotersModal` с двумя вкладками: **«Репутация»** и **«Реакции»**.
- **Правило вкладки по умолчанию:**
  - При клике по глазику **по умолчанию открывается вкладка «Репутация»** (если у поста есть автор-аккаунт и голоса/балл репутации: `postRepVotesCount > 0 || postRepValue !== 0`).
  - Если голосов репутации нет (включая **все гостевые посты**), а реакции есть (`postReactionsTotal > 0`) — автоматически открывается вкладка **«Реакции»** (а вкладка «Репутация» скрывается, если `post.author?.user_id` отсутствует или голосов 0).
  - При долгом нажатии (long-press на тач-экранах) по конкретной пилюле реакции модалка открывается сразу на вкладке **«Реакции»** с предвыбранной реакцией.

### 2.3. Компонент `ReactionPicker.jsx` (поповер выбора реакции)
- Открывается по клику на `<SmilePlus />`, закрывается по клику вне, `Esc` или после выбора реакции.
- **Позиционирование:** на десктопе — выпадающий поповер с авто-коррекцией краёв вьюпорта (портал или fixed/floating, чтобы не обрезался `overflow` карточки поста); на узких экранах (`< 640px`) — bottom sheet / адаптивный оверлей.
- **Структура:**
  1. **Панель вкладок категорий** (иконки/эмодзи категорий):
     - `recent` (иконка часов `<Clock />`) — «Недавно / часто используемое».
     - Далее включённые категории из `reaction_groups` по `sort_order` (например: «Кастомные», «Эмоции», «Жесты», «Сердечки и символы» и т.д.).
  2. **Поле поиска** (`<Search />` + input): мгновенная клиентская фильтрация по `label.ru`, `label.en`, `keywords`, `key`. При активном поиске показываются все совпадения единой сеткой.
  3. **Секция «Часто используемое»:** объединяет серверную историю пользователя (`recent_keys` из каталога) + мгновенное обновление в `localStorage` (`aerun:reactions:recent:<uid>`) при каждом клике. Если пользователь ещё не ставил реакции — показывается fallback из первых 8–12 популярных/дефолтных реакций.
  4. **Секции по категориям:** клик по вкладке вверху плавно прокручивает список к нужной категории (как в Discord) или фильтрует её.

### 2.4. Модалка всех реакций (`PostReactionsTab` внутри `PostVotersModal`)
**Раскладка (в стиле списка реакций Discord):**
- Левая колонка (десктоп, ~130–160px) / верхняя горизонтальная прокручиваемая лента чипов (мобильные `< 640px`): все реакции поста (`emoji/img + count`), отсортированные по убыванию количества (при равенстве — по времени первого появления). Первая (или выбранная) активна.
- Правая область: список пользователей, поставивших выбранную реакцию:
  - аватар (`resolveAvatarUrl`),
  - кликабельный никнейм (`Link to=/profile/:id`, закрывает модалку при переходе),
  - время постановки (`<Timestamp />`).
- Данные загружаются лениво при открытии вкладки/модалки через `GET /api/aerun/posts/{id}/reactions` (не раздувая основной фид топика сотнями объектов пользователей).

---

## 3. Модель данных и миграции (PocketBase / SQLite)

Соблюдаются правила `PROJECT_SPEC.md`: append-only миграции в `backend/internal/migrations/` (следующая нумерация после `1781000005`), все новые коллекции закрыты для прямого доступа из браузера (`ListRule/ViewRule/CreateRule/UpdateRule/DeleteRule = nil`).

### 3.1. Коллекция `reaction_groups` (категории реакций)
| Поле | Тип | Индекс / Ограничения | Описание |
|---|---|---|---|
| `slug` | `text` | UNIQUE, required | Латинский идентификатор группы (`emotions`, `custom`, `gestures`...) |
| `name` | `json` | required | Локализованное название `{ "en": "...", "ru": "..." }` |
| `icon` | `text` | — | Символ эмодзи или имя иконки Lucide для вкладки в пикере |
| `sort_order` | `number` | INDEX | Порядок отображения |
| `enabled` | `bool` | default `true` | Выключенная группа скрывается из пикера |

### 3.2. Коллекция `reaction_items` (доступные реакции)
| Поле | Тип | Индекс / Ограничения | Описание |
|---|---|---|---|
| `group_id` | `relation` → `reaction_groups` | INDEX, required | Категория реакции |
| `key` | `text` | UNIQUE, required | Стабильный ключ реакции (`u_1f525`, `c_pepe_cowboy`, `s_possumhappy`) |
| `kind` | `text` | required | `unicode` \| `image` \| `smile_ref` |
| `emoji` | `text` | — | Символ(ы) Unicode для `kind = "unicode"` (например, `🔥`) |
| `image` | `file` | single, max 5MB, image/gif/webp/png/jpg | Файл для загруженных в админке кастомных реакций |
| `image_url` | `text` | — | Готовый относительный путь (`/api/files/...` или `/smiles/...`) |
| `smile_item_id` | `text` | — | Опциональная ссылка на `smile_items.id` (если реакция импортирована/связана с паком смайлов) |
| `label` | `json` | — | `{ "en": "Fire", "ru": "Огонь" }` |
| `keywords` | `text` | — | Ключевые слова для поиска через пробел (`fire lit огонек огонь`) |
| `sort_order` | `number` | INDEX | Порядок внутри группы |
| `enabled` | `bool` | default `true` | Выключенная реакция пропадает из пикера, но исторические пилюли на старых постах не ломаются |

### 3.3. Коллекция `post_reactions` (поставленные реакции)
| Поле | Тип | Индекс / Ограничения | Описание |
|---|---|---|---|
| `post_id` | `text` | INDEX, required | ID поста (`posts.id`) |
| `topic_id` | `text` | INDEX, required | Денормализованный ID темы (для быстрой очистки при удалении темы и синхронизации при переносе постов) |
| `user_id` | `text` | INDEX, required | ID пользователя (`users.id`), поставившего реакцию |
| `reaction_key` | `text` | INDEX, required | Ключ из `reaction_items.key` |
| `created` | `autodate` | — | Время постановки (определяет порядок пилюль и список пользователей) |

**Индексы:**
- `UNIQUE(post_id, user_id, reaction_key)` — один пользователь может поставить каждую уникальную реакцию на пост ровно один раз.
- `INDEX(post_id, reaction_key, created)` — быстрая агрегация в ленте топика и модалке.
- `INDEX(user_id, created)` — быстрый расчёт `recent_keys` для пикера.
- `INDEX(topic_id)` — быстрая очистка в `deleteTopicPosts`.

> **Почему нет кэш-колонки `posts.reactions_json`:** При чтении страницы топика (15–30 постов) один `SELECT ... WHERE post_id IN (...)` в SQLite выполняется за < 1 мс. Отсутствие денормализованного кэша на `posts` полностью исключает рассинхронизацию счётчиков и не требует отдельного `RecomputePostReactions`.

### 3.4. Коллекция `post_reaction_notifications` (анти-спам журнал уведомлений)
| Поле | Тип | Индекс / Ограничения | Описание |
|---|---|---|---|
| `post_id` | `text` | INDEX, required | ID поста |
| `topic_id` | `text` | INDEX, required | ID темы (для очистки при удалении темы) |
| `actor_id` | `text` | required | Кто поставил реакцию |
| `reaction_key` | `text` | required | Ключ реакции |
| `created` | `autodate` | — | Время первой отправки уведомления |

**Индексы:**
- `UNIQUE(post_id, actor_id, reaction_key)` — гарантирует **exactly-once** отправку уведомления за всё время жизни поста для каждой тройки `(post, actor, reaction_key)`.
- При снятии (отжатии) реакции строка из `post_reaction_notifications` **не удаляется**. Она удаляется только при физическом (hard) удалении поста/темы/пользователя.

### 3.5. Связь с коллекциями из `CONCEPT_Smiles_Customization.md`
Если модуль кастомных смайлов (`smile_groups`, `smile_items`, `user_smiles`) реализуется параллельно или в рамках той же задачи:
- `smile_groups` / `smile_items` продолжают отвечать за BBCode-смайлы `[code]` в редакторе и постах.
- `reaction_groups` / `reaction_items` отвечают за реакции на посты (включая стандартные Unicode-эмодзи, которые не должны заменять текст в BBCode).
- В админке оба набора управляются из **одной вкладки**, а у администратора есть действие **«Добавить в реакции»** прямо на карточке стикера из `smile_items` (создаёт `reaction_items` с `kind = "smile_ref"` и ссылкой на картинку стикера без дублирования файла).

### 3.6. Миграция-сид и RBAC-права
1. **Новые ключи прав** (`backend/internal/auth/permission.go`, `backend/internal/auth/role.go`, `src/constants/permissions.js`, миграция обновления ролей):
   - `use_reactions` (`PermUseReactions`) — право ставить и снимать реакции на посты.
     - Выдаётся по умолчанию ролям: `root`, `admin`, `moderator`, `player` и **`spectator`** (обновить `RoleSpectator` в `role.go`, `MAX_ROLE_PERMISSIONS.spectator` / `player` / `moderator` в `src/constants/permissions.js` и роли в БД через миграцию).
     - **Не** выдаётся роли `guest` и **не** включается в `pendingAllowedPermissions` (`status.go`): таким образом, ставить реакции могут только авторизованные активные пользователи и спектаторы. Забаненные (`banned`) и удалённые (`deleted`) отсекаются `NarrowForStatus` и `requireNotBanned`.
   - `manage_reactions` (`PermManageReactions`, либо общий ключ с модулем смайлов + `manage_forum`) — управление списками реакций и смайлов в админке. Выдаётся по умолчанию `root`, `admin`.
2. **Сид каталога реакций:**
   - Базовые группы: `custom` («Кастомные» — можно сразу наполнить ключевыми стикерами `possum` или оставить готовой для админа), `emotions` («Эмоции»), `gestures` («Жесты и люди»), `symbols` («Символы и сердца»), `objects` («Огонь, еда и объекты»).
   - Набор стандартных Unicode-эмодзи (👍, 👎, ❤️, 💙, 🔥, 💯, 😂, 😭, 😍, 🤯, 👀, 🎉, 🙏, 🤔, 💀, ✨, 👌 и т.д.) с русскими и английскими `label` и `keywords` для поиска.

---

## 4. Бэкенд: API-маршруты и бизнес-логика (`backend/internal/platform/pocketbase/`)

Все маршруты регистрируются в `registerRoutes` (`run.go`) под `/api/aerun/*` с прохождением `AccessResolver` и `requireLiveAccount`.

### 4.1. Клиентские эндпоинты
1. `GET /api/aerun/reactions/catalog`
   - Доступен всем (включая гостей, для отрисовки и метаданных).
   - Возвращает `{ groups: [...], items: [...], recent_keys: [...] }`, где `groups` и `items` только с `enabled = true`, отсортированные по `sort_order`.
   - Для авторизованного пользователя `recent_keys` — до 24 последних уникальных `reaction_key` из `post_reactions WHERE user_id = {:uid} ORDER BY MAX(created) DESC`.

2. **Проекция реакций в существующих эндпоинтах постов** (`forum_posts.go`):
   - В `listPostsHandler`, `getPostHandler`, `loadTopicFirstPost` добавить вызов `decoratePostReactions(e.App, items, viewerUserID)` сразу после `decoratePostAuthors`.
   - Также поддержать в `listUserPostsHandler` (`user_posts.go`), если там возвращаются карточки постов.
   - Формат поля `post.reactions` (отсортировано по времени первого появления реакции на посте, чтобы пилюли не прыгали при переключении):
     ```json
     [
       {
         "key": "u_1f525",
         "kind": "unicode",
         "emoji": "🔥",
         "image_url": "",
         "label": { "en": "Fire", "ru": "Огонь" },
         "count": 5,
         "reacted_by_me": true,
         "users": [
           { "id": "u1", "nickname": "Envy" },
           { "id": "u2", "nickname": "баэль бард" }
         ]
       }
     ]
     ```
   - `users` в ленте топика ограничивается первыми 15 никами (достаточно для hover-тултипа «и ещё M» без раздувания ответа).

3. `GET /api/aerun/posts/{id}/reactions`
   - Проверяет существование поста (`!is_draft`) и `canViewTopic` (иначе 404/403 — как в `getPostVotersHandler`).
   - Возвращает полный список реакций поста с развёрнутыми участниками `{ id, nickname, avatar_url, created_at }` для Discord-модалки (поддержка опционального `?key=...` или возврат сгруппированного списка, т.к. у поста обычно < 20 уникальных эмодзи и < 100 реакций; предусмотреть безопасный `limit`).

4. `POST /api/aerun/posts/{id}/reactions` (toggle-команда)
   - Middleware: `RequirePermission(auth.PermUseReactions)` + `enforceIdempotency` (клиент генерирует `Idempotency-Key` на каждый клик, как в `votePostHandler`).
   - Доп. гейт: `e.Auth != nil` (только авторизованные, гости запрещены) + `requireNotBanned(acc, ...)` (и `pending` отсекается отсутствием `PermUseReactions` в `pendingAllowedPermissions`).
   - **Транзакция `runCommand`:**
     1. Найти `post` по `id`; проверить `!post.GetBool("is_draft")`.
     2. Проверить `post.GetString("author_id") != e.Auth.Id` — **нельзя реагировать на собственный пост** (`forbiddenError("cannot react to your own post")`).
     3. Проверить `canViewTopic(txApp, acc, post.GetString("topic_id"))` — нельзя реагировать на скрытую категорию.
     4. Проверить наличие существующей записи `post_reactions` по `(post_id, e.Auth.Id, reaction_key)`:
        - **Снятие (если запись найдена):**
          - Удалить запись из `post_reactions`. (Можно снимать даже ту реакцию, которую админ позже выключил в `reaction_items`!)
          - **Не** трогать `post_reaction_notifications`.
          - Вернуть `{ action: "removed", reaction_key, reactions: <актуальный срез поста> }`.
        - **Добавление (если записи нет):**
          - Проверить в `reaction_items`, что `key` существует и `enabled == true` (плюс его группа `enabled == true`).
          - (Опционально — анти-абуз лимит: например, не более 20 уникальных реакций от одного пользователя на один пост или макс. 50 разных реакций на пост).
          - Вставить запись в `post_reactions`.
          - **Уведомление:**
            - Определить `authorID := post.GetString("author_id")`.
            - Если `authorID != ""` (не гостевой пост! На собственный пост проверка уже отсекла выше):
              - Найти `targetUser`; проверить `!isUserDeleted(targetUser)` и `postReactionWanted(targetUser)` (`settings.notifications.post_reaction.in_app !== false`).
              - Выполнить атомарную вставку в `post_reaction_notifications`:
                ```sql
                INSERT OR IGNORE INTO post_reaction_notifications (id, post_id, topic_id, actor_id, reaction_key, created)
                VALUES ({:id}, {:post}, {:topic}, {:actor}, {:key}, {:now})
                ```
              - Если `res.RowsAffected() == 1` — вызвать `createNotification(txApp, authorID, e.Auth.Id, "post_reaction", title, payload)`, где `payload` содержит `topic_id`, `topic_title`, `post_id`, `reactor_id`, `reactor_nickname`, `reaction_key`, `reaction_emoji`, `reaction_image_url`, `reaction_label`.
              - `createNotification` автоматически публикует realtime-сигнал `notification.new` получателю в той же транзакции.
     5. Опубликовать лёгкий сигнал обновления топика `publishTopicReactionSignal(txApp, topic)` (новая константа `realtimeSignalTopicReaction = "topic.reaction"`, с той же проверкой `canViewCategory(app, guestAccess(), categoryID)`, что и `publishTopicSignal`).
     6. **Не** менять `posts.reputation`, `users.reputation` и любые счётчики пользователя.

### 4.2. Консистентность при удалении и переносе (обязательное правило проекта)
Реакции привязаны строго к посту, при переносе темы или поста они не изменяются и не сбрасываются, при удалении поста удаляются безвозвратно. **Ни в одном из этих сценариев не отправляются уведомления о реакциях.** Согласно правилу *«Deletion Must Settle Its Denormalized Copies»* (`.agent/rules/AGENTS.md`):
- **`deletePostHandler` (`forum_posts.go`):** в той же транзакции безвозвратно удалить из `post_reactions` и `post_reaction_notifications` все строки с `post_id = {:post}`. Уведомления не создаются.
- **`deleteTopicPosts` (`forum_topics.go`):** в той же транзакции безвозвратно удалить из `post_reactions` и `post_reaction_notifications` все строки с `topic_id = {:topic}` (аналогично очистке `reputation_votes`). Уведомления не создаются.
- **`movePostsHandler` (`forum_posts.go`):** сами реакции на посте остаются нетронутыми; в той же транзакции синхронизируется только техническое поле `topic_id = {:target}` в `post_reactions` и `post_reaction_notifications` для переносимых `post_id` (чтобы последующее удаление целевой темы корректно зачистило их). Перенос темы (`moveTopicHandler`) меняет `category_id` темы, не трогая `topic_id` постов, поэтому реакции сохраняются автоматически. Уведомления не создаются.
- **`purgeSinglePostForUserDeletion` (`admin_user_delete_votes.go`):** в той же транзакции удалить `post_reactions` и `post_reaction_notifications` с `post_id = {:post}`.
- **Удаление пользователя (`admin_user_delete_votes.go` / `admin_user_delete_purge.go`):** при удалении аккаунта (когда зачищаются его голоса в `purgeUserProfileVotes`) удалить `post_reactions` где `user_id = {:user}` и `post_reaction_notifications` где `actor_id = {:user}`.

### 4.3. Админские эндпоинты (реакции + смайлы)
Гейт: `RequirePermission(auth.PermManageReactions)` (и/или `PermManageForum` для смайлов) + `audit_logs` на все мутации:
- `GET /api/aerun/admin/reactions` — все группы и элементы (включая `enabled = false`) + количество использований в `post_reactions` (чтобы предупреждать админа перед удалением).
- `POST /api/aerun/admin/reaction-groups`, `PATCH /api/aerun/admin/reaction-groups/{id}`, `DELETE /api/aerun/admin/reaction-groups/{id}` (`enforceIdempotency`).
- `POST /api/aerun/admin/reaction-items` — создание Unicode-реакции, `smile_ref`-реакции или multipart-загрузка картинки (`image`, аналогично `avatar_upload.go` — multipart без `enforceIdempotency`!).
- `PATCH /api/aerun/admin/reaction-items/{id}` — обновление `label`, `keywords`, `group_id`, `sort_order`, `enabled`, либо замена картинки.
- `DELETE /api/aerun/admin/reaction-items/{id}` — в одной транзакции удаляет запись `reaction_items` и очищает связанные строки `post_reactions` / `post_reaction_notifications` (с обязательным подтверждением в UI).
- `POST /api/aerun/admin/reaction-items/reorder` — пакетное обновление `sort_order`.
- *(Аналогичный CRUD-набор для `smile_groups` / `smile_items` / `user_smiles` по `CONCEPT_Smiles_Customization.md` в том же admin-модуле).*

---

## 5. Фронтенд: модули и интеграция

### 5.1. API и глобальный контекст каталога
- **`src/api/reactions.js`**:
  - `fetchReactionCatalog()` → `GET /api/aerun/reactions/catalog`
  - `togglePostReaction(postId, reactionKey)` → `POST /api/aerun/posts/${postId}/reactions`
  - `fetchPostReactions(postId)` → `GET /api/aerun/posts/${postId}/reactions`
  - Админские функции: `fetchAdminReactions()`, `createReactionGroup()`, `updateReactionGroup()`, `deleteReactionGroup()`, `createReactionItem()`, `uploadReactionImage()`, `updateReactionItem()`, `deleteReactionItem()`, `reorderReactionItems()`.
- **`src/contexts/ReactionsProvider.jsx`** (или объединить с `SmilesProvider` из `CONCEPT_Smiles_Customization.md`):
  - Загружает каталог один раз за сессию (и обновляется по требованию после изменений в админке).
  - Хранит мапу `reactionsByKey` и список `reactionGroups` + локальный кэш `recentKeys` (мердж серверного `recent_keys` + `localStorage` для мгновенного отклика в пикере).

### 5.2. Компоненты темы (`src/components/topic/` и `src/components/common/`)
- **`src/components/topic/PostReactionsBar.jsx`**:
  - Отрисовывает пилюли `post.reactions` и кнопку `<SmilePlus />`.
  - Ховер на пилюлю показывает стилизованный тултип (`.reaction-tooltip`) с именами: `Прореагировали: A, B, C` (или `A, B и ещё K`). На тач-устройствах (`@media (hover: none)`) ховер-тултип подавляется, а долгое нажатие открывает модалку.
  - Оптимистичное обновление состояния `posts` / `pinnedFirstPost` в `TopicPage`: реакция добавляется/убирается мгновенно при клике, при ошибке сети/сервера состояние откатывается и показывается `showToast(..., 'danger')`.
- **`src/components/topic/ReactionPicker.jsx`**:
  - Категорийные вкладки, строка поиска, «Часто используемое», сетка эмодзи и кастомных картинок.
  - Без `react-bootstrap`, без inline-стилей; цвета через переменные `theme-variables.css`.
- **`src/components/common/PostVotersModal.jsx`** (расширение и перевод на семантическую темизацию):
  - Пропсы: `initialTab` (`'reputation' | 'reactions'`, по умолчанию `'reputation'`, но если у поста нет репутационных голосов/автора, а реакции есть — переключается на `'reactions'`), `hasReputationActivity`, `hasReactions`, `initialReactionKey`.
  - Если активны оба типа активности — рендерит две семантические вкладки в шапке модалки.
  - Вкладка «Реакции» реализует Discord-лейаут: слева список реакций с счётчиками (на мобиле — горизонтальный скролл-бар сверху), справа список пользователей с аватарками, ссылками на `/profile/:id` и `<Timestamp />`.
  - Обрабатывает ошибки загрузки через понятное сообщение + кнопку `Retry` (требование *Network & Connection Resilience*).
  - Новая разметка и стили модалки — строго без `react-bootstrap`, без Bootstrap-утилит и без inline-стилей (заодно очистить legacy-классы внутри `PostVotersModal.jsx` или в новой обёртке, переведя на семантические классы и CSS-переменные темы).

### 5.3. Live-обновления на странице темы
- В `src/api/forum.js` (`subscribeToTopicStats`) не ломать существующую логику подсчёта `posts_count` (которая вызывает звуковой сигнал нового поста только при росте `posts_count`).
- Добавить лёгкую реакцию на сигнал `topic.reaction` (когда `entityId === topicId`): тихий рефетч постов текущей страницы (`loadPosts(currentPage, true)` без скелетона и без звука), либо подписка через `shared-poll.js` в `TopicPage` на `topic.reaction`, чтобы у других читателей темы пилюли обновлялись в реальном времени без лишних интервалов.

### 5.4. Уведомления и настройки профиля
- **`src/pages/NotificationsPage.jsx`**:
  - Добавить `post_reaction` в `TYPE_META`, `filterByPrefs` (`notifSettings?.post_reaction?.in_app !== false`) и `renderNotification`:
    - Иконка: миниатюра самой реакции (эмодзи или `<img>` кастомного стикера) поверх круглой подложки.
    - Текст: «**{user}** отреагировал(а) на ваше сообщение в теме **{topic_title}**» + ссылка `/topic/{topic_id}?post={post_id}` (с авто-отметкой прочитанным по клику, как у `reputation_change`).
- **`src/pages/ProfilePage.jsx`**:
  - В `buildAccountForm` и `buildSettingsPatch` добавить ключ `notif_post_reaction` → `settings.notifications.post_reaction.in_app` (по умолчанию `true`), чтобы пользователь мог отключать in-app уведомления о реакциях, как и уведомления о репутации.

### 5.5. Единая админ-панель «Смайлы и реакции»
- **`src/config/adminNavigation.js`**:
  - В группу `forumContent` добавить пункт:
    ```js
    {
      id: 'smilesReactions',
      path: 'smiles',
      title: 'admin.tabs.smiles_reactions',
      icon: 'Smile',
      anyOf: [PERMISSIONS.MANAGE_REACTIONS, PERMISSIONS.MANAGE_FORUM],
    }
    ```
  - Учесть проверку `scripts/check-admin-nav-config.mjs`!
- **`src/components/admin/SmilesReactionsTab/`** (строго семантические компоненты + `SmilesReactionsTab.css` на переменных из `theme-variables.css`, без `react-bootstrap`, Bootstrap-классов и inline-стилей):
  - `SmilesReactionsTab.jsx` — контейнер с двумя подвкладками: **«Реакции на посты»** и **«Смайлы и стикеры»** (по `CONCEPT_Smiles_Customization.md`).
  - Использовать существующие базовые UI-примитивы (`Button`, `ForumModal`, `ConfirmModal`) и семантические CSS-классы (`.smiles-admin-*`), завязанные на `--card-bg`, `--text-color`, `--secondary-color`, `--border-color`, `--primary-color`, `--input-bg` и др. токены тем (`light`, `dark`, `neutral`).
  - `ReactionsManager.jsx`:
    - Левая/верхняя панель групп (`reaction_groups`): создание/переименование (EN/RU), выбор иконки, сортировка вверх/вниз, переключатель `enabled`, удаление группы (с подтверждением, предупреждая если внутри есть реакции).
    - Правая/основная панель элементов (`reaction_items`):
      - Кнопка **«+ Добавить эмодзи»** (встроенный выбор стандартного Unicode-эмодзи + автоподстановка названия/ключевых слов).
      - Кнопка **«+ Загрузить картинку»** (загрузка PNG/GIF/WebP/JPG файла до 5 МБ с превью и заданием названия/ключевых слов).
      - Кнопка **«+ Из пака смайлов»** (выбор уже существующего стикера из `smile_items`, без повторной загрузки файла).
      - Сетка/таблица реакций текущей группы: превью, `label`, `keywords`, переключатель `enabled`, кнопки сортировки, кнопка редактирования и кнопка удаления с `ConfirmModal` (с показом числа постов, где реакция уже использована).

### 5.6. Локализация (`src/i18n/dictionary.js`)
Добавить EN + RU ключи для:
- пикера реакций (`reactions.add`, `reactions.search_placeholder`, `reactions.recent`, `reactions.reacted_by`, `reactions.and_more`, `reactions.empty`),
- вкладок модалки (`post_voters.tab_reactions`, `post_voters.tab_reputation`, `post_voters.reactions_none`),
- уведомлений (`notifications.types.post_reaction`, `notifications.reacted_in_topic`, `profile.notif_post_reaction`),
- админки (`admin.tabs.smiles_reactions`, управление группами/элементами реакций и смайлов).

---

## 6. Этапы внедрения (порядок работ)

1. **Этап 1 — БД, RBAC и миграции (Go):**
   - Добавить `PermUseReactions` и `PermManageReactions` в `backend/internal/auth/permission.go` и `matrix.go` / `role.go` (и в `src/constants/permissions.js`).
   - Написать миграцию `1782000000_post_reactions_schema.go` (коллекции `reaction_groups`, `reaction_items`, `post_reactions`, `post_reaction_notifications`, индексы, обновление ролей, сид базовых групп и Unicode-эмодзи).
2. **Этап 2 — Бэкенд-логика реакций, уведомлений и зачистки удаления (Go):**
   - Реализовать `post_reactions.go` (`GET /reactions/catalog`, `GET /posts/{id}/reactions`, `POST /posts/{id}/reactions`, `decoratePostReactions`, `postReactionWanted`, `INSERT OR IGNORE` в `post_reaction_notifications`).
   - Подключить `decoratePostReactions` в `forum_posts.go` и `user_posts.go`.
   - Добавить `realtimeSignalTopicReaction` в `realtime_signals.go`.
   - Обновить `deletePostHandler`, `deleteTopicPosts`, `movePostsHandler`, `purgeSinglePostForUserDeletion`, `purgeUserProfileVotes` для очистки/переноса `post_reactions` и `post_reaction_notifications`.
   - Реализовать админские CRUD-хендлеры `/admin/reaction-groups*` и `/admin/reaction-items*` (с multipart-загрузкой и audit log).
3. **Этап 3 — Фронтенд: лента темы, пикер и модалка (React):**
   - `src/api/reactions.js` + `src/contexts/ReactionsProvider.jsx`.
   - `PostReactionsBar.jsx`, `ReactionPicker.jsx`, расширение `PostVotersModal.jsx` (вкладки «Реакции» и «Репутация», адаптив под мобильные).
   - Интеграция в `TopicPostCard.jsx` (включая гостевые посты!), `TopicPage.jsx` (оптимистичные обновления + сигнал `topic.reaction`), `TopicModalsContainer.jsx`.
   - Стили в `src/styles/theme-variables.css` и `src/styles/topic-view.css`.
4. **Этап 4 — Уведомления и настройки профиля:**
   - Обновить `NotificationsPage.jsx` (рендер и фильтр `post_reaction`).
   - Обновить `ProfilePage.jsx` (переключатель `notif_post_reaction`).
   - Обновить `src/i18n/dictionary.js`.
5. **Этап 5 — Единая админ-панель «Смайлы и реакции»:**
   - Добавить пункт в `src/config/adminNavigation.js` и вкладку в `AdminPage.jsx`.
   - Реализовать `SmilesReactionsTab` (подвкладка реакций + интеграция модуля смайлов по `CONCEPT_Smiles_Customization.md`).
6. **Этап 6 — Документация и верификация:**
   - Обновить `PROJECT_SPEC.md` и `PROJECT_CONTEXT.md` (новые коллекции, права, маршруты, тип уведомлений).
   - Написать и прогнать тесты и проверки (§7).

---

## 7. Чек-лист приёмки и тестов

### Backend (`go test ./...` + проверка CI-отчёта `origin/ci-report`)
- Постановка и отжатие реакции на чужой обычный пост и на **гостевой пост** (`author_id == ""`).
- **Запрет самореакций:** попытка поставить реакцию на собственный пост отклоняется сервером (`403`).
- **Ролевая модель:** активные авторизованные пользователи (`player`, `moderator`, `admin`, `root`) и **`spectator`** могут ставить реакции; `guest`, `pending`, `banned` и роли без `use_reactions` получают отказ; доступ в закрытую категорию отклонён (`403`/`404`); черновик (`is_draft = true`) отклонён.
- **Анти-спам тест:**
  - User A ставит 🔥 на пост User B → создаётся 1 уведомление `post_reaction`.
  - User A отжимает 🔥 и снова ставит 🔥 (и повторяет после того, как User B архивировал уведомление) → новых уведомлений **0**.
  - User A ставит ❤️ на тот же пост → создаётся 1 новое уведомление для ❤️.
  - User C ставит 🔥 на тот же пост → создаётся 1 уведомление от User C.
- **Изоляция счётчиков:** `posts.reputation`, `users.reputation`, `users.post_count`, `RecomputeUserCounters`, `RecomputePostReputation` не меняются от реакций.
- **Перенос и безвозвратное удаление (без уведомлений):**
  - `DELETE /posts/{id}` безвозвратно удаляет `post_reactions` и `post_reaction_notifications` поста в той же транзакции, уведомления не отправляются.
  - `DELETE /topics/{id}` безвозвратно удаляет `post_reactions` и `post_reaction_notifications` всей темы, уведомления не отправляются.
  - `POST /topics/{id}/posts/move` и `POST /topics/{id}/move` оставляют реакции на постах без изменений (синхронизируя только `topic_id` в БД) и не отправляют уведомлений.
  - Удаление пользователя зачищает его реакции.

### Frontend (`npm run build`, `npm test`, `node scripts/check-admin-nav-config.mjs`, `node scripts/check-i18n-keys.mjs`)
- На собственных постах кнопка добавления реакции (`SmilePlus`) скрыта; на чужих (в т.ч. гостевых) отображается и открывает пикер с поиском, «Часто используемое» и категориями; повторный клик по пилюле снимает реакцию.
- Ховер по пилюле на десктопе показывает список прореагировавших; клик по глазику по умолчанию открывает вкладку «Репутация» (а для гостевых постов / постов без репутации — «Реакции»); long-press на мобиле открывает вкладку «Реакции».
- Выключенная в админке реакция исчезает из пикера, но не ломает отображение на старых постах.
- В новых компонентах (и на посте, и в админ-вкладке «Смайлы и реакции») полностью отсутствуют импорты `react-bootstrap`, inline-стили (`style=`) и Bootstrap-утилиты; все цвета берутся из `theme-variables.css` (проверено в `light`, `dark`, `neutral`).
