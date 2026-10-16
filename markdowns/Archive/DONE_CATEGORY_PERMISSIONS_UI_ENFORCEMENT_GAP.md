# Настройки разрешений категории: сохранено, но интерфейс им не следует

**Статус:** реализовано (бэкенд + frontend). Категория теперь сужает глобальное право и на сервере, и на клиенте. Выдача права за пределом глобального (scenario 1) не поддерживается — см. §6.  
**Ветка:** `feature/pocketbase-migration` (коммит `eab0609`, локально на 5 коммитов впереди origin)  
**Коммиты/файлы исправления:** `backend/internal/migrations/1769700000_category_permissions_restore.go`, `backend/internal/platform/pocketbase/category_commands.go`, `backend/internal/platform/pocketbase/category_access.go`, `src/api/categories.js`, `src/pages/AdminPage.jsx`  
**Автор отчёта:** Cline (по запросу пользователя)

---

## 1. Что было сделано (исправление бага сохранения)

Была несохраняемость настроек разрешений категории: сохранялось только «просмотр» (`allowed_roles` / `view_forum`), а четыре остальных переключателя молча выбрасывались.

### Бэкенд
- **Миграция `1769700000_category_permissions_restore.go`** — восстанавливает JSON-поле `categories.permissions`, которое было удалено миграцией `1767400000`. Поле хранит за overrides на уровне категории для `create_topic`, `post_reply`, `use_masks`, `use_dice`. `view_forum` по-прежнему управляется через `categories.allowed_roles`.
- **`category_commands.go`**:
  - в `categoryForm` добавлено поле `Permissions map[string][]string`;
  - `createCategoryHandler` валидирует (`validatePermissions`) и сохраняет `permissions`;
  - `updateCategoryHandler` заменяет карту разрешений, когда ключ `permissions` присутствует в форме (`nil` — оставить текущее как есть);
  - `categoryRecordPayload` отдаёт `permissions` в ответе;
  - добавлены helpers `validatePermissions` (проверка role-id против реестра角色, запрет смешивания маркера наследования с реальными ролями, дедупликация) и `decodePermissionsMap` (нормализация хранилища PocketBase в `map[string][]string`).
- **`category_access.go`** — `listAdminCategoriesHandler` теперь включает `"permissions"` в payload админ-списка категорий.

### Frontend API
- **`src/api/categories.js`**:
  - `toCategory` раскодировывает все 5 ключей (`view_forum` через `allowed_roles`, остальные через `toPermissionOverride` из `d.permissions`);
  - `toCategoryPayload` собирает `permissions` обратно, «выключенный» override хранится маркером `[INHERIT_ROLES]`, чтобы не теряться тихо.

### Админ-UI (модалка категории)
- **`src/pages/AdminPage.jsx`**:
  - `catForm.permissions` — стартует как `{}`, блок «переопределения разрешений» всегда виден (счётчик `overrideCount` в заголовке);
  - пять toggle: `view_forum`, `create_topic`, `post_reply`, `use_masks`, `use_dice` с чекбоксами ролей;
  - `toggleCatPermOverride` / `toggleCatPermRole` управляют состоянием;
  - `handleSaveCategory` отправляет `catForm` (включая `permissions`) в `addCategory` / `updateCategory`.

**Итог fix-а:** админ может выставить любые из 5 разрешений на категорию, сервер принимает и хранит их, админ-карточка их показывает. То есть «псевдо-список» разрешений теперь сквозной от формы до БД.
## 2. Чего не хватает: интерфейс не следует этим разрешениям

Проблема, о которой идёт речь: **никто не проверил, учитывает ли клиентский интерфейс_category_-уровневые настройки при рендеринге.** Оказывается — нет.

### Корень проблемы: `hasPermission` не знает про категорию

В `src/contexts/AuthProvider.jsx` (строка ~1010):

```js
const hasPermission = useCallback((perm) => {
  if (effectivePermissions.length > 0) {
    return effectivePermissions.includes(perm);
  }
  // ... fallback на глобальные права роли / гостя
}, [user, profile, roles, effectivePermissions]);
```

Сигнатура `hasPermission(perm)` — **второй аргумент `{ category }` игнорируется**. Проверка идет только против *глобального/эффективного* набора прав пользователя (из `GET /api/aerun/me`). Карта `category.permissions` (overrides категории) клиентом не читается и не сверяется.

То есть `hasPermission(PERMISSIONS.POST_REPLY, { category })` работает ровно как `hasPermission(PERMISSIONS.POST_REPLY)` — категория не учитывается.

### Места вызова, где передаётся `{ category }`, но она 무시вается

| Файл | Строка | Разрешение | Что должно зависеть от категории |
|------|--------|------------|----------------------------------|
| `src/pages/TopicPage.jsx` | 1296 | `post_reply` | кнопка цитирования автора |
| `src/pages/TopicPage.jsx` | 2944 | `post_reply` | кнопка цитирования (пост-менеджмент) |
| `src/pages/TopicPage.jsx` | 3268 | `use_dice` | `showDice` в редакторе ответа |
| `src/pages/TopicPage.jsx` | 3418 | `post_reply` | ссылки управления постами |
| `src/pages/TopicPage.jsx` | 3478 | `post_reply` | кнопка управления постом |
| `src/pages/TopicPage.jsx` | 3833 | `post_reply` | видимость формы ответа (скрыта для зрителей/закрытых тем) |
| `src/pages/TopicPage.jsx` | 3898 | `use_masks` | выпадающий список масок в строке ответа |
| `src/pages/TopicPage.jsx` | 3944 | `use_masks` | горячие клавиши редактора |
| `src/pages/TopicPage.jsx` | 3963 | `use_dice` | `showDice` в редакторе ответа |
| `src/pages/CategoryPage.jsx` | 209, 278 | `create_topic` | кнопка «Новая тема» в категории |
| `src/pages/TopicFormPage.jsx` | 234 | `create_topic` | защита страницы создания темы |
| `src/pages/TopicFormPage.jsx` | 296 | `use_masks` | поле «Представляться как» (маска) |
| `src/pages/TopicFormPage.jsx` | 353 | `use_dice` | `showDice` в редакторе новой темы |
| `src/pages/MovePostsModal.jsx` | 72 | `view_forum` | категория доступна для перемещения постов |
| `src/pages/MoveTopicsModal.jsx` | 19 | `view_forum` | категория доступна для перемещения тем |
| `src/pages/ActiveTopicsPage.jsx` | 76 | `view_forum` | категория видна в активных темах |

### Конкретные сценарии, которые ломаются

1. **Гости могут писать ответы в категории (разрешено админом).**  
   Админ включает `post_reply` для роли `guest`/`spectator` в категории. В интерфейсе форма ответа остаётся скрыта (`!hasPermission(PERMISSIONS.POST_REPLY, { category })` → `true`, т. к. глобально у гостя нет `post_reply`), кнопка цитирования не показывается. *Разрешение выдано, но интерфейс его не следует.*

2. **Запрещено использовать маски в категории.**  
   Админ выключает `use_masks` для категории. В интерфейсе селектор маски („Представляться как“) и горячие клавиши остаются видимыми, т. к. глобально у пользователя `use_masks` есть. *Запрет игнорируется.*

3. **Запрещены кости (даисы) в категории.**  
   Аналогично: `showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}` всегда возвращает глобальный ответ, кости показываются даже там, где админ их запретил.

4. **Запрещено создавать темы в категории.**  
   Кнопка «Новая тема» (`CategoryPage.jsx:209/278`) и защита `TopicFormPage.jsx:234` опираются на глобальное `create_topic`. Категорийный запрет не отражается.

5. **`view_forum` с наследованием (маркер inherit).**  
   Видимость категории на сервере работает корректно (`canViewCategory` в `category_access.go` читает `allowed_roles` + разрешения звонящего), поэтому список категорий публикуется верно. Но клиентские проверки `hasPermission(PERMISSIONS.VIEW_FORUM, { category })` в `ActiveTopicsPage`, `MovePostsModal`, `MoveTopicsModal` не читают категорийную карту — они опираются на глобальное право. Для прав на чтение это менее критично (сервер уже отфильтровал), но семантически вызов с `{ category }` ложно обещает категорийную проверку.

### Что НЕ входит в пробел (корректно, не трогать)
- `ProfilePage.jsx:1573, 1613` — `hasPermission(PERMISSIONS.POST_REPLY)` **без** категории. Это глобальная проверка возможности подписи/возможности ответа в профиле, а не категорийное правило — категорию там передавать не надо.
- `BBCode.jsx:690/720` — `hasPermission(PERMISSIONS.BYPASS_HIDE_TAGS)`, глобальная админская операция.
- `ProtectedRoute`, `Navbar`, `TitleProvider`, `AdminPage` навигация — глобальные права доступа к разделам админки, категория не при чём.


## 3. Дополнительно: на сервере тоже нет категорийной проверки записи

Хотя вопрос был про интерфейс, стоит отметить смежный пробел на бэкенде, чтобы не ложить полную ответственность на frontend:

- `POST /api/aerun/topics` (`run.go:378`) закрыт `RequirePermission(auth.PermCreateTopic)` — проверяется **глобальное** `create_topic`, не categoría.
- `POST /api/aerun/topics/{id}/posts` (`run.go:387`) закрыт `RequirePermission(auth.PermPostReply)` — проверяется **глобальное** `post_reply`, не categoría.

`createTopicHandler` (`forum_topics.go:94`) и `createPostHandler` (`forum_posts.go:119`) не обращаются к `categories.permissions`. Так что даже если исправить только интерфейс, сервер всё равно будет ориентироваться на глобальные права при записи. Полная сквозная работа требовала бы категорийной проверки и в `createTopicHandler` / `createPostHandler` (или отдельного мидлвари), но это уже выходит за рамки заявленного вопроса про UI — отмечено для полноты картины.

## 4. Что нужно сделать (рекомендации)

1. **Сделать `hasPermission` категорически-aware** (`src/contexts/AuthProvider.jsx`):
   - либо изменить сигнатуру на `hasPermission(perm, { category })` и, когда передана категория, проверять в первую очередь `categories.find(c => c.id === category)?.permissions?.[perm]` (если override `undefined`/`null` — наследовать/global право; если массив — пользователь должен быть в списке ролей или иметь глобальное право, в зависимости от выбранной семантики);
   - либо добавить отдельный хелпер `hasCategoryPermission(perm, category)` и перевести на него все сайты из п.2.

2. **Обновить все UI-вызовы** из таблицы в п.2, чтобы они действительно учитывали категорию (особенно `post_reply` — форма ответа/цитирование, `use_masks`, `use_dice`, `create_topic`).

3. **Рассмотреть серверную категорийную проверку** для `createTopicHandler` и `createPostHandler` (в дополнение к глобальному `RequirePermission`), чтобы право, выданное админом в категории, действительно работало при записи, а не только рендерилось.

4. **Добавить parity-тест / скрипт** (упоминалось в `DONE_TOPIC_OPEN_READS_AND_DRAFT_SAFETY_PLAN.md:924`): клиентские `hasPermission(...{ category })` должны соответствовать полям `categories.permissions` и серверной логике, чтобы регрессия не wiederholилась.

## 5. Ссылки на код

- `src/contexts/AuthProvider.jsx:1010` — `hasPermission(perm)` (игнорирует категорию)
- `src/api/categories.js:158–182` — чтение/запись `permissions` категории (`toCategory` / `toCategoryPayload`)
- `src/pages/AdminPage.jsx:88, 133, 518, 558–599, 637, 2607–2648` — админ-форма разрешений категории (уже работает)
- `backend/internal/migrations/1769700000_category_permissions_restore.go` — поле `categories.permissions`
- `backend/internal/platform/pocketbase/category_commands.go` — валидация и сохранение `permissions`
- `backend/internal/platform/pocketbase/category_access.go:55` — `canViewCategory` (серверная проверка чтения, работает)
- `backend/internal/platform/pocketbase/run.go:378,387` — глобальные `RequirePermission` для создания тем и ответов (без категорийной проверки)


## 6. Реализовано (закрытие пробела UI enforcement)

### Семантика (почему так)

Категорийное переопределение — **десисвный фактор**. Оно может и **выдавать** право тому, у кого его нет глобально (гостю/спектатору), и **запрещать** тому, у кого оно есть глобально (модератору, игроку), если роль не внесена в список категории. Исключение — root, который всегда проходит.

По дефолту у гостя и спектатора нет права создавать темы и писать посты. Если админ специально включил право в категории — гость получает возможность писать там, даже если глобально у него нет `post_reply`. Это сделано намеренно: обратная схема (сначала включить у роли, затем выключать в каждой категории отдельно) была бы плохим UX.

Обратная сторона той же монеты: если админ явно перечислил роли в категории, то все, кто не в списке, получают отказ — даже при наличии глобального права. Это не лазейка, а защита: категория может сузить доступ.

### Бэкенд
- `backend/internal/platform/pocketbase/category_access.go` — в публичный список категорий (`listForumIndexHandler`) добавлено поле `permissions` (`decodePermissionsMap(c.Get("permissions"))`), чтобы AuthProvider видел карту разрешений каждой категории. Ранее поле отдавалось только в админском списке (`listAdminCategoriesHandler`), поэтому клиент не знал о категорийных overrides и не мог проинициализировать `hasPermission`.
- `backend/internal/platform/pocketbase/category_access.go` — добавлен хелпер `categoryWriteAllowed(app, acc, categoryID, perm)`:
  1. root — всегда разрешено; banned — всегда запрещено.
  2. глобальное право (из `/me`, суженное по статусу) — разрешено.
  3. явный список ролей категории для `perm` — разрешено членам списка, даже без глобального права.
  4. отсутствие/пустой список/маркер наследования (`__aerun_inherit_roles__`) — fallback на глобальный результат (шаг 2).
- `backend/internal/platform/pocketbase/forum_topics.go` (`createTopicHandler`) — проверяется `categoryWriteAllowed(..., PermCreateTopic)` → 403 "You cannot create topics in this category.".
- `backend/internal/platform/pocketbase/forum_posts.go` (`createPostHandler`) — проверяется `categoryWriteAllowed(..., PermPostReply)` по `topic.category_id` → 403 "You cannot post in this category.".
- `backend/internal/platform/pocketbase/run.go` — убран глобальный `RequirePermission` с `POST /topics` и `POST /topics/{id}/posts`; право теперь решается внутри хендлеров категорически-aware, чтобы категория могла выдать право тому, у кого его нет глобально.

Обе проверки **расширяют** глобальное право: категория может выдать действие_account-у, у которого его нет глобально, но не может отнять у того, у кого оно есть глобально (если только не запрещено явно в категории).

### Фронтенд
- `src/api/categories.js` — константа `INHERIT_ROLES` (`__aerun_inherit_roles__`, байт-в-байт как `auth.CategoryInheritMarker`) теперь экспортируется.
- `src/contexts/AuthProvider.jsx` — `hasPermission(perm, { category } = {})` учитывает категорийное переопределение: при явном не-наследующем списке ролей член в списке → `true` (даже без глобального права), не в списке → `false`; пустой список — только для root. **`view_forum` исключён**: сервер уже отфильтровал категории через `canViewCategory` перед отправкой клиенту, поэтому если категория есть в клиентском списке — доступ подтверждён сервером и клиент возвращает `true` без дополнительных проверок. Это исправляет баг, когда пустая категория показывалась как "access denied".

**Гостевая роль:** для неавторизованного пользователя (`user === null`) категорийная проверка использует роль `'guest'` (а не `'player'`), чтобы категорийный список ролей (например, `["guest", "player", ...]`) соответствовал реальному гостю. `categories` добавлен в зависимости `useCallback`.
- Все существующие точки вызова (`TopicPage`, `CategoryPage`, `TopicFormPage`, `ActiveTopicsPage`, `MovePostsModal`, `MoveTopicsModal`) уже передавали `{ category }` (объект категории), поэтому автоматически начали учитывать категорию — отдельных правок в компонентах не требуется.

### use_masks и use_dice на фронтенде
- `TopicPage.jsx` форма ответа: выпадающий список маски показывается только если `hasPermission(PERMISSIONS.USE_MASKS, { category })`; `showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}` скрывает кости при запрете.
- `TopicPage.jsx` редактирование поста: выпадающий список маски показывается только если автор + `hasPermission(PERMISSIONS.USE_MASKS, { category })`; `showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}`.
- `TopicFormPage.jsx` создание темы: поле «Представляться как» (маска) показывается только если `hasPermission(PERMISSIONS.USE_MASKS, { category })`; `showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}`.
- **Сброс преффила маски:** в `TopicPage.jsx` и `TopicFormPage.jsx` при загрузке/смене категории, если `use_masks` запрещён, `selectedCharacterId` сбрасывается на `''` и вызывается `setLastSelectedMask('')`, поэтому ответ/тема постится от имени основного аккаунта, даже если маска была preselected в другой теме.

### Ограничения (см. §3 рекомендаций из отчёта)
- Parity-тест / скрипт (§4 п.4 отчёта) не добавлен — остаётся на будущее.
- Гостя в админ-модалке редактирования прав показывало все права игрока, потому что `base_role_id` у гостя пуст и код падал на 'player'. Исправлено в `src/pages/AdminPage.jsx`:
  1. `handleOpenRoleModal` — права гостя фильтруются через `MAX_ROLE_PERMISSIONS['guest']` при открытии модалки.
  2. Рендеринг чекбоксов — `currentBaseRole` для гостя определяется как `'guest'`, а не `'player'`, поэтому показываются только права из `MAX_ROLE_PERMISSIONS['guest']` (VIEW_FORUM, POST_REPLY, USE_DICE).

- Гость не мог создать тему, даже с категорийным грантом на `create_topic`, потому что:
  1. Маршрут `POST /topics/{id}/posts` и `POST /topics` в `run.go` были обернуты в `RequirePermission` без `allowGuest`, и клиентская страница создания темы (`/category/:id/new-topic`) была обёрнута в `ProtectedRoute requirePosting` без `allowGuest`. Гостя редиректило на главную перед тем, как он мог отправить форму.
  2. Исправлено: убран глобальный `RequirePermission` с роутов, добавлен `allowGuest` к ProtectedRoute для new-topic, и в `TopicFormPage.jsx` добавлена категорийная проверка `hasPermission(PERMISSIONS.CREATE_TOPIC, { category })` перед сабмитом.
  3. Гость теперь может указать гостевой никнейм (`guest_nickname`) в форме ответа/создания темы — он сохраняется в `localStorage` под ключом `aerun_guest_nickname` и предзаполняется при повторном посещении. Сервер хранит `guest_nickname` в колонке `posts.guest_nickname` и использует его как `author_name` при рендере (вместо "Deleted user").
- Гость теперь может публиковать посты в категории с grant:
  - Миграция `1769800000_post_guest_nickname.go` добавляет колонку `guest_nickname` (текст, 64) в коллекцию `posts`.
  - Миграция `1769900000_post_author_id_optional.go` делает `posts.author_id` необязательным (Required: true → false), чтобы гость мог publicar без аккаунта.
  - Клиент отправляет `guest_nickname` в `createPost` (`src/api/forum.js`, `src/pages/TopicPage.jsx`).
  - Последний введенный никнейм гостя запоминается в `localStorage` под ключом `aerun_guest_nickname` и подставляется в поле «Ваш никнейм» при повторном открытии формы ответа.
  - Бэкенд (`createPostHandler` в `forum_posts.go`) для гостя: `author_id = ""`, сохраняет `guest_nickname`, не вызывает `adjustUserPostCount` и `dispatchPostNotifications` (нет аккаунта).
- Добавлен серверный интеграционный тест `TestCategoryWritePermissionGranting` в `backend/internal/platform/pocketbase/forum_commands_test.go` (9 саб-тестов): проверяет, что категорийное переопределение — десисвный фактор:
  - spectator (только `view_forum` глобально) не может создать тему/ответить без grant категории → 403;
  - spectator может создать тему/ответить с grant категории → 201;
  - игрок с глобальным правом может создать тему в категории без переопределения → 201;
  - игрок с глобальным правом **не может** создать тему в категории, где явно запрещено (не в списке) → 403;
  - модератор с глобальным правом **не может** создать тему/ответить в категории, где не в списке → 403;
  - модератор в списке категории → 201.

### §3 (дополнительно из отчёта) — серверная категорийная проверка записи
Реализовано полностью:  в  используется в  () и  (). Глобальный  убран с роутов  и , чтобы категория могла выдать право тому, у кого его нет глобально.
