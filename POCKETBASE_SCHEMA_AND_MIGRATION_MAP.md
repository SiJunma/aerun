# PocketBase schema and migration map (from the Firebase snapshot)

**Status:** working baseline for the import writer (Sprint 7 continuation)
**Source:** `backend/migration-data/stage-1.json` (snapshot `512509de…5746`,
project `aerun-forum`, staged 2026-09-18), `auth-official-2026-09-18.json`,
field inventory `_inventory.json`.
**Target side:** migrations `1765900000…1766500000` in
`backend/internal/migrations`.
**Last reviewed:** 2026-09-26

Этот документ — карта для агента, который будет писать доменный импорт:
что во что превращается, в каком порядке, что пересчитывается, а что не
импортируется вообще. Решения либо уже закреплены в коде, либо помечены
**TODO-решение**.

## 1. Слепок: что вообще есть в Firestore

| Путь | Документов | Судьба при импорте |
|---|---|---|
| `category_groups` | 5 | импорт → `category_groups` |
| `categories` | 15 | импорт → `categories` (+ `allowed_roles`) |
| `roles` | 9 (5 системных + 4 кастомных) | сверка + импорт кастомных verbatim (см. §3) |
| `users` | 12 | импорт → `users` (auth) |
| `users/{uid}/characters` | 9 | импорт → `characters` (коллекция создана 1766600000) |
| `topics` | 34 | импорт → `topics` |
| `posts` | 3123 | импорт → `posts` (последовательность пересчитывается) |
| `topic_subscriptions` | 5 | импорт → `topic_subscriptions` |
| `notifications` | 964 | импорт → `notifications` |
| `reputation_logs` | 403 | импорт → `reputation_logs` |
| `dms` | 9 | импорт → `dm_conversations` |
| `dms/{id}/messages` | 305 | импорт → `dm_messages` |
| `audit_logs` | 247 | импорт → `audit_logs` |
| `settings` | 1 | импорт → `settings` (одна запись) |
| `designs` | 1 | импорт → `designs` (коллекция создана миграцией 1766600000) |
| `forum_stats` | 1 | НЕ импортируется: производная, пересчитывается |
| `guest_activity` | 241 | НЕ импортируется: эфемерное присутствие (устарела ещё в Firebase; живая модель — `guest_presence`, см. §4) |
| `users/{uid}/readmap` | 12 | НЕ импортируется: перестраивается на первом визите |
| `users/{uid}/drafts` | 1 | импорт → `posts` c `is_draft=true` (id дока = topic_id, пара owner+topic сохраняется; см. §4) |
| Auth export (uid-записи) | 21 | мержится с `users` по `legacy_firebase_uid` |

Плюс Storage: `backend/migration-data/storage/{users,smiles}` с манифестом
`storage-manifest.json` — аватары и маски.

## 2. Политика идентификаторов

1. **Все новые записи** получают PocketBase id по канону: 15 символов из
   алфавита `a-z0-9` (PocketBase v0.40 валидирует id паттерном `^[a-z0-9]+$` —
   заглавные буквы отклоняются с `id: Invalid value format.`). Для импорта id
   **выводится**, а не генерируется: `SHA-256(collection space, legacy id)` →
   15 символов в алфавите `a-z0-9` (реализовано в `importer/map.go`).
   Повторный прогон по тому же слепку даёт байт-идентичные id — фундамент
   идемпотентности.
2. **users** — отдельное правило: auth-запись хранит `legacy_firebase_uid`
   (уникальный частичный индекс), поэтому пользователь адресуется и по legacy
   uid, и по derived id.
3. **roles** — ключ роли не derived id, а бизнес-ключ `role_id` (текст,
   уникальный индекс `idx_roles_role_id`): системные роли имеют канонические
   имена (`root/admin/moderator/player/spectator/guest`), кастомные переносят
   свой legacy doc id как `role_id` (напр. `h2u0Tt9eyo1bVhZwg2IN`).
4. **settings** — одна запись, адресуется константой, mapping не нужен.
5. Ссылки между коллекциями после импорта всегда указывают на **новые**
   derived id; маппинг старый→новый лежит в `mapping.json` репетиции и
   является таблицей соответствия для всех последующих прогонов.

## 3. Роли: гибкая модель (главный урок прошлой попытки)

Ошибка, на которой споткнулся предыдущий агент: **роли в проекте не являются
фиксированным перечнем**. В legacy-приложении роли строятся в Admin UI
(PROJECT_SPEC.md §5.3, `src/constants/permissions.js`): есть системные роли с
дефолтным набором разрешений, а есть **кастомные**, созданные поверх базовой
роли (`base_role_id`) с произвольным набором разрешений (в пределах
`MAX_ROLE_PERMISSIONS`), своим именем, цветом и лимитом масок.

Слепок подтверждает: 9 документов в `roles` — 5 системных (`admin`, `guest`,
`moderator`, `player`, `spectator`; дока для `root` нет) и 4 кастомных:

| legacy role_id | name | base_role_id | держателей |
|---|---|---|---|
| `H0EuRMeGSBiZjq3AIeo9` | Demon | player | 1 |
| `PYaDjGY5XvWHNEjTswuz` | Anaptix | player | 1 |
| `h2u0Tt9eyo1bVhZwg2IN` | NorthbayСitizen (кириллическая «С»!) | player | 4 |
| `suI1QvXIT0ywatdwCpci` | NorthbayCitizen+ | player | 1 |

Складывать кастомные роли в базовую **нельзя**: `categories.permissions.
view_forum` ссылается на кастомные id напрямую («Скрытые игры» открыта только
роли `PYaDjGY5XvWHNEjTswuz`) — свёртка либо отрежет людям доступ, либо,
наоборот, откроет скрытую категорию всем игрокам.

### 3.1 Целевая модель (закреплена миграцией 1766500000)

- `roles`: `role_id` (unique), `name`, `rank`, `color`, `is_system`,
  `permissions` (Select по `auth.AllPermissionValues()`), **плюс**
  `base_role_id` (текст, не relation — роль должна читаться, даже если
  базовая строка отсутствует в частичном экспорте) и `max_characters_limit`
  (int; 0 = «нет явного лимита», тогда командный слой берёт дефолт
  скомпилированной матрицы). Индекс `idx_roles_base_role_id`.
- `users.role` — теперь **TextField** (не select): select со списком значений
  и был тем самым местом, где кастомную роль «невозможно представить».
  Валидация значения перенесена в командный слой (`admin_users.go` —
  единственный писатель): значение обязано существовать в `roles.role_id`.
- `users.custom_role_id` — системная роль, от которой производна кастомная
  (или пусто). Так «этот аккаунт — стафф?» остаётся отвечаемым из
  скомпилированной матрицы, а ранговая сортировка определена (у кастомной
  роли собственного ранга нет — используется ранг `custom_role_id`).
- `categories.allowed_roles` — JSON-массив role_id, кому видна категория.
  **Контракт (решение владельца, 2026-09-29):** пустой или отсутствующий
  массив = категория видна **только root**; публичная категория обязана
  содержать **явный список всех ролей** (включая `guest`), которым видна.
  Bypass для root — всегда; для `admin` bypassa больше нет (см. план §5.A).
  Импортёр переводит legacy-карту `permissions: {view_forum: [roleId…]}` в
  этот список по правилу: пустая карта или пустой список → **полный список
  всех role_id из `roles`** (публичная категория в legacy-данных), непустой
  список → verbatim. JSON, а не select — по той же причине, что и `users.role`.
- Системные роли сидируются из **скомпилированной матрицы** `internal/auth`
  (миграция 1766000000) и остаются только для чтения. Документы системных
  ролей в слепке **не авторитетны** и не переносятся; расхождение фиксируется
  репетицией как поведенческий diff:

| роль | слепок | матрица | вердикт |
|---|---|---|---|
| `admin` | 37 прав | 37 прав | совпадают, имя `Admin` vs `Administrator` |
| `guest` | 1 право | 1 право | совпадают |
| `moderator` | 22, вкл. `delete_reputation`, `edit_others_*`, `use_direct_messages` | 22, вкл. `view_audit_log` | дрейф в обе стороны — TODO-решение |
| `player` | 13 | 14 (+`view_master_dice`) | матрица — надмножество |
| `spectator` | 3 (`edit_self_avatar`, `edit_self_nickname`, `use_direct_messages`) | 1 (`view_forum`) | legacy шире — TODO-решение |
| `root` | документа нет | 37 | целевая роль, сидируется |

### 3.2 Статус: закрыто (2026-09-26)

Синхронизировано с гибкой моделью:

- `importer/roles.go`: `BuildRolePlan(plan, systemRows, allowedPermissions)`
  строит `CustomRows` — кастомные роли verbatim (`role_id` = legacy doc id,
  `base_role_id`, `max_characters_limit`, права валидируются по словарю
  `auth.AllPermissionValues()`, неизвестное право → finding
  `custom_role_permission_unknown`); `RolePlan.Upserts()` отдаёт
  системные + кастомные строки писателю (ранг кастомной наследует базовый,
  т.к. `roles.rank` required).
- `importer/compat.go`: `MapUserRole` больше не сворачивает кастомные роли —
  `users.role` = legacy `role_id`, `custom_role_id` = `base_role_id`;
  findings `custom_role_assigned` вместо `…_folded`.
- `platform/pocketbase/role_import.go`: `RoleUpsert` несёт `BaseRoleID` и
  `MaxCharactersLimit`, идемпотентный upsert их сравнивает.
- `cmd/import-roles` с `-ledger` пишет и кастомные роли; проверено на
  чистой rehearsal-базе: первый прогон `created=4 unchanged=6`, второй
  `created=0 updated=0 unchanged=10 changed=false`.
- Тесты обновлены (`TestBuildRolePlan_CustomRolesImportedVerbatim`,
  `TestMapUserRole`), DoD двух одинаковых репетиций воспроизведён
  (mapping/report байт-идентичны).

Особый случай: ~~auth-uid `aCetMfSLI1RvsSsL56XiF3EIe412`~~ — закрыто
(продуктовое решение 2026-09-26): **документ аккаунта без `role_id` —
мёртвая запись и дропается** (у настоящих юзеров роль всегда есть).
Каскад: такие записи уходят в `plan.DroppedUsers`; репутационные логи,
ссылающиеся на них, дропаются вместе с ними. Найминги:
`orphan_user_dropped`, `orphan_reputation_dropped`,
`orphan_auth_record_dropped` (auth-записи без документа профиля).
На слепке 2026-09-18: dropped 1 юзер + 1 репутационный лог, FK-ошибок
больше нет, в маппинге 5148 записей.

---

## 7. Страница «Драфты» (бэкенд готов, фронт — план)

Продуктовое решение 2026-09-26: в дропдауне профиля появляется страница
«Драфты» — все темы, где у юзера есть черновик, с редактированием и
публикацией на месте. Бэкенд-контракт (реализован, миграция 1766700000 +
`internal/platform/pocketbase/drafts.go`, маршруты в `run.go`):

| Маршрут | Что делает |
|---|---|
| `GET /api/aerun/me/drafts` | лента драфтов звонящего: сначала **осиротевшие** (тема удалена/отсутствует, `orphan: true`), затем живые (`topic_title`, `category_id`), каждая группа по `updated DESC` |
| `GET /api/aerun/topics/{id}/draft` | свой драфт в теме или `{"draft": null}` |
| `PUT /api/aerun/topics/{id}/draft` | создать/обновить драфт (upsert по паре author+topic; инвариант «1 драфт на юзера в теме» держит частичный уникальный индекс `idx_posts_drafts_unique`) |
| `DELETE /api/aerun/drafts/{id}` | удалить драфт (только автор; модератор с `moderate_content` — тоже) |
| `POST /api/aerun/drafts/{id}/publish` | атомарная публикация: sequence, снятие `is_draft`, проекции темы в одной транзакции; осиротевший → `409 conflict` |

Семантика для фронта:

- Драфт = пост с `is_draft=true`, `sequence=0`; в ленту постов темы он не
  попадает (`listPosts` фильтрует), счётчики и `last_post_*` не трогает.
- **Осиротевший** (`orphan: true`): доступны только «Скопировать»
  (клиент читает `content` и сохраняет его как драфт в другую тему через
  `PUT /topics/{newId}/draft`) и «Удалить». Кнопки «Опубликовать» и
  «Перейти в тему» скрыты.
- Редактирование черновика в теме: `GET /topics/{id}/draft` при открытии
  формы ответа; сохранение — `PUT .../draft` с Idempotency-Key.
- Публикация из страницы драфтов: `POST /drafts/{id}/publish`, после 200 —
  показать пост / перейти в тему.

**План по фронтенду (Sprint 8-кандидат):**

1. `src/api/forum.js`: обёртки `listMyDrafts()`, `getTopicDraft(id)`,
   `saveTopicDraft(id, content)`, `deleteDraft(id)`, `publishDraft(id)`
   (транспорт уже готов — `src/api/pocketbase.js`).
2. `src/pages/DraftsPage.jsx`: две секции — «Осиротели» (первой, только
   «Скопировать»/«Удалить») и «В работе» (карточки: заголовок темы,
   превью контента, кнопки «Редактировать» → переход в тему с открытым
   редактором и подставленным черновиком, «Опубликовать»).
3. Дропдаун профиля: пункт «Драфты» (иконка FilePen) со счётчиком.
4. TopicPage: `handleSaveDraft` переводится на `PUT /topics/{id}/draft`;
   `publishDraft` заменяет прямой `createPost` при наличии драфта;
   `deleteDraftPost` (localStorage-версия) удаляется после миграции данных.
5. i18n-ключи `drafts.*` в `src/i18n/dictionary.js` (ru/en).

## 4. Целевая схема PocketBase

Сущности созданы миграциями (или помечены TODO); ниже — контракт, с которым
обязан работать импортёр. Все доменные коллекции — deny-by-default (правила
nil), писатели — только Go-команды (инвариант 2 плана).

### users (auth; 1766000000 + 1766500000 + 1766900000 + 1767000000 + 1767100000 + 1767300000)
`nickname` (req ≤64), `nickname_normalized` (req ≤128, unique partial),
`role` (text req ≤64, валидируется по `roles.role_id`), `custom_role_id`
(≤64), `status` (select, `auth.AllStatusValues()`), `legacy_firebase_uid`
(hidden ≤128, unique partial), `avatar` (file, maxSelect 1, ≤5 MB,
image/jpeg|png|webp|gif), `avatar_url` (≤512), `settings` (JSON ≤256KB),
**счётчики** `posts_count`, `topics_count`, `reputation` (number, onlyInt),
**`last_seen`** (date, 1767300000 — см. ниже).
Публичное правило чтения: `status = "active" || id = @request.auth.id`.
Из слепка: `nickname`, `avatar_url`, `bio`, `birthday`, `contacts`,
`interests`, `location`, `occupation`, `status_line`, `admin_message`,
`last_selected_character_id` — либо явными полями, либо внутрь `settings`
JSON (TODO-решение; текущий выбор репетиции — settings). `role_id` → `role`
(+`custom_role_id` по §3). Счётчики `post_count/topics_count/reputation` —
пересчитать. Auth-мерж: email, `emailVerified`, `metadata.creationTime/
lastSignInTime`, providerData (Google/password); пароли не переносятся
(сброс/линковка — отдельная задача Sprint 7 limits).

**Счётчики (1767100000).** Значения не переносятся из слепка, а выводятся из
строк: `posts_count` — посты автора с `deleted = false` и `is_draft = false`
(та же предикация, что у `topics.posts_count`; черновик постом не считается),
`topics_count` — темы автора с `deleted = false`, `reputation` — сумма
`reputation_votes` с пустым `post_id` (только голоса за профиль; голос за пост
уже учёл в `posts.reputation` при касте). Командный слой двигает их в той же
транзакции, что и сам пост/тему/голос, а `RecomputeUserCounters`
(`tools/migration/importer/cmd/recompute-counters`) пересобирает их из строк —
идемпотентно, без удалений. Это же и починка: счётчик, который двигают только
команды, стартует с нуля, поэтому база, наполненная импортом, имеет верные
колонки и неверные числа до запуска пересчёта.

**`last_seen` (1767300000) — восстановленная контрактная колонка.** В legacy
документе она была (`users.last_seen`, все 12 строк слепка), и была НЕ копией
RTDB-присутствия, а отдельными часами: `functions/index.js` писал её из
`last_activity` — «persistent visit timestamp, is NOT reset on logout or idle».
Порт на PocketBase сохранил только «online right now» (in-process карта,
`presenceTTL` 75 с) и потерял «last visit» совсем, поэтому колонка Last Seen на
странице участников показывала `...` постоянно, а не временно.

Почему не `updated`: `updated` — время *редактирования* записи, оно движется на
каждом импорте и каждой записи настроек, то есть для импортированного аккаунта
показывало бы дату импорта. Отвечающая на другой вопрос колонка хуже её
отсутствия — поэтому появилась настоящая.

Пишут её ровно два серверных пути (правила коллекции закрыты, инвариант 2):
`POST /presence/heartbeat` (с троттлингом, см. ниже) и создание аккаунта.
Backfill — из `created`: регистрация это доказуемая активность, то есть честная
нижняя граница, и контракт «никогда не пусто» выполняется сразу для всех
существующих строк. Значение из слепка приезжает через `import-users`
(`users.last_seen` переносится как есть) и применяется **монотонно**
(`lastSeenToWrite`): переигровка дампа умеет только двигать значение вперёд,
поэтому повторный прогон свежего дампа не откатывает аккаунт, активный после
выгрузки. Обоснование — то же, что у `avatarURLToWrite`.

Троттлинг записи (5 минут) — не оптимизация, а требование: браузер бьёт раз в
30 с, то есть без него это 120 обновлений строки на участника в час, каждое
из которых двигает `updated` и шлёт realtime-событие его собственной открытой
странице профиля. Первый бит после простоя пишет всегда (иначе «last seen»
мог бы оказаться раньше самого визита), дальше — раз в интервал.

Backfill сделан одним `UPDATE ... SET last_seen = created`, а не циклом
`app.Save`: сохранение записи прогоняет валидацию, и на базе, предшествующей
контракту идентичности (заполненный фикстур PocketBase — именно такой случай),
`nickname`/`role`/`status` пусты, и миграция падала бы целиком. Копирование
текста колонки форматно-независимо: PocketBase сериализует date через
`types.DateTime.Value()` — один и тот же `DefaultDateLayout` для всех date-колонок,
а нулевое время как `''`.

### roles (1766000000 + 1766500000) — см. §3.1

### Остальные коллекции
`category_groups`, `categories`, `topics`, `posts`, `reputation_logs`,
`notifications`, `topic_subscriptions`, `audit_logs`, `settings`,
`dm_conversations`/`dm_messages`: доменные модели уже есть в
`internal/forum` и `internal/messaging`, но PocketBase-коллекции для
долговременной истории ещё не созданы — следующий шаг перед писателем
домена. `characters` и `designs` созданы миграцией 1766600000.
Репетиция уже считает планы (`rehearsal-map/report.json`), писатель
опирается на `mapping.json`.
Полевые составы — зеркала слепка (§1) плюс правила ниже.

### guest_presence (1766800000) — присутствие гостей
`guest_id` (text req ≤64, unique `idx_guest_presence_guest_id`), `first_seen`,
`last_seen` (datetime, индекс `idx_guest_presence_last_seen`). Коллекция
server-only (все правила nil), как и остальные доменные: единственный писатель
— presence-роуты (`POST /presence/heartbeat`, `POST /presence/guest/leave`),
читатели — `GET /presence/guests` и счётчик `guests_count` в
`GET /presence/online-users` (оба идут через один хелпер, поэтому не могут
разойтись).
Гость — не аккаунт: id генерирует браузер
(`Math.random().toString(36).substring(2) + Date.now().toString(36)`,
lowercase alnum, 18–19 символов) и хранит в `localStorage.guest_id`. Из слепка
коллекция не импортируется: `guest_activity` устарела ещё в Firebase — её
заменила RTDB-нода `guest_presence` ради экономии записи, и та же модель
перенесена сюда.
PII намеренно нет: только id и две метки времени — ни IP, ни user-agent, ни
путей. Окно онлайна 15 минут (как в legacy и в панели статистики), ретенция
1 час (cron-джоб `__aerunGuestPresencePrune__`, `*/10 * * * *`). Heartbeat —
раз в минуту плюс при возврате фокуса во вкладку; leave — `sendBeacon` на
`pagehide` и при логине (аналог `onDisconnect().remove()`).
Анти-спам: id валидируется по форме до записи, а на heartbeat стоит бюджет
30 запросов в минуту на IP — встроенный `Settings().RateLimits` PocketBase в
этом деплое выключен (`Enabled: false`), поэтому защита живёт рядом с данными.

### Правила преобразования (важно)

- **Времена**: ISO-строки слепка → datetime; автополя `created/updated`
  перезаписывать нельзя — исторические даты держим в явных
  application-полях (план: «preserve historical dates»).
- **Денормализованные снапшоты** (`author_name`, `author_avatar`,
  `author_role_id`, `author_status_line`, `last_post_*`): переносим,
  но все id через маппинг, а аватарные URL — на новые storage-ссылки.
- **Аватары (`avatar` + `avatar_url`, миграция 1767000000)**: файл лежит
  в PocketBase (`pb_data/storage/<collectionId>/<recordId>/`), а
  `avatar_url` хранит **независимый от хоста** путь
  `/api/files/<collectionId>/<recordId>/<file>`, а не абсолютный URL: при
  смене домена строки остаются валидными, а фронт резолвит их через
  `VITE_POCKETBASE_URL` (`src/api/avatars.js`). Байты переносятся
  `import-avatars` из верифицированного экспорта Sprint 0 с проверкой md5
  по `storage-manifest.json`. Доступ к файлу — по ViewRule коллекции
  (`apis/file.go`), поэтому аватар активного аккаунта публичен, а
  pending/banned — нет. Денормализованные копии (`author_avatar`,
  `last_post_author_avatar`) получают **тот же путь**: писатель контента
  копирует `users.avatar_url` автора, а не разыменовывает файл.
- **Счётчики и производные** (`posts_count`, `topics_count`, `views`,
  `reputation`, `last_post_*`, `unread`, `forum_stats`): пересчитываются,
  никогда не переносятся (в слепке уже есть расхождения кэша:
  `post_count cached=335 actual=333`, `reputation cached=7 actual=6` —
  нормальный класс mismatch).
- **post sequence**: per-topic монотонная нумерация по `created_at`
  (+tie-break по doc id); 3123 поста уже разведены репетицией
  (`post_sequence_recomputed`).
- **rolls** (кубики), `payload` (уведомления), `details` (аудит),
  `settings` — JSON-блобы без нормализации.
- **dms**: `participants` (массив uid), `clearedAt`/`unread` (карты по uid)
  → реляционная форма (строки участников); счётчики пересчитать.
- **drafts**: драфт = будущий пост (`users/{uid}/drafts/{topicId}`, id дока =
  topic_id, is_draft=true, пост-совместимые поля). Импортёр кладёт их в
  bucket `Drafts` с составным legacy id `uid/drafts/topicId` в пространстве
  постов (без коллизий), FK-валидация проверяет автора, тему и пару
  owner/topic из пути; finding `draft_imported_as_post`. Требования к
  писателю домена: (1) `posts` обязана иметь частичный уникальный индекс
  `unique(author_id, topic_id) where is_draft = true` — это сохраняет
  legacy-инвариант «один драфт на юзера в теме»; (2) драфт не получает
  sequence и не участвует в posts_count/last_post_*/reputation до публикации;
  (3) команда `publishDraft` атомарно присваивает sequence и снимает
  is_draft; (4) денормализованные `author_*` в драфте пересчитать, а не
  переносить устаревшие.
- **characters**: коллекция `characters` создана миграцией 1766600000
  (owner_id, name, status_line, signature, avatar_url, исторические
  created_at/updated_at; server-only). Сворачивание в `users.settings`
  (поведение репетиции `character_docs_folded_into_user_settings: 9`) —
  компромисс analysis-стадии, писатель импортирует их в собственную
  коллекцию.

## 5. Карта зависимостей: порядок импорта

Импорт выполняется строго по уровням; каждый уровень ссылается только на уже
импортированные. Foreign keys репетиция проверяет по производным id.

```
L0  roles (системные из матрицы + кастомные verbatim)      [§3]
L1  users (auth-мерж + профиль)                            ← legacy_firebase_uid
L1  settings (одна запись), designs
L2  category_groups
L3  categories (group_id → L2; allowed_roles → L0)
L4  characters (owner_id → L1)                             [1766600000]
L5  topics (category_id → L3; author_id → L1; author_character_id → L4)
L6  posts (topic_id → L5; author_id → L1; sequence пересчёт)
L7  reputation_logs (voter/target/post/topic → L1/L5/L6)
L7  topic_subscriptions (user/topic → L1/L5, unique-пара)
L7  notifications (recipient → L1)
L8  dm_conversations (participants → L1) → dm_messages (sender → L1)
L9  audit_logs (performer/actor → L1) — импортируется последним,
    т.к. details хранит ссылки на всё сразу
Пересчёт/постобработка: счётчики users/categories/topics, forum_stats,
last_post_* во всех проекциях, валидация storage-файлов по манифесту.
```

Контроль целостности: репетиция (`import-rehearse`) уже валидирует FK и
репортит `foreignKeyErrors: null` на текущем слепке; писатель обязан
сохранять эту проверку и вести `legacy_firebase_uid`/per-record mapping
таблицы как чекпоинты (Sprint 7, задача 2).

## 6. Итоги верификации спринтов 6–7 (2026-09-26)

**Sprint 6 (frontend adapter):**
- `src/` чист от runtime-импортов Firebase (проверено grep по `from 'firebase'`
  — совпадения только в `scripts/` и `tools/migration`, что допустимо);
  `firebase.js` — no-op фасад.
- Реализовано: `src/api/pocketbase.js` (SDK + Idempotency-Key + ApiError),
  presence через heartbeat, миграция всех `src/api/*` на `/api/aerun/*`,
  AuthProvider на `pb.authStore`, регистрация через `/api/aerun/auth/register`.

**Sprint 7 (migration tooling, analysis stage):**
- `node --test backend/tools/migration/snapshot.test.mjs` — 4/4 pass.
- `go test ./...` в `backend/` — все пакеты ok (auth, config, forum,
  messaging, migrations, platform/pocketbase, tools/migration/importer).
- DoD воспроизведён на текущем слепке: два прогона
  `import-rehearse` (`migration-data/verify-a`, `verify-b`) дали
  **байт-идентичные** `mapping.json` и `report.json` (fc: no differences).
- Отчёт репетиции: 5149 записей в маппинге, FK-ошибок нет;
  skipped: designs 1, forum_stats 1, guest_activity 241, user_drafts 1,
  user_readmap 12 — всё объяснимо (§1).

**Открытые хвосты (не блокируют, но должны быть закрыты до писателя):**
1. ~~Синхронизировать importer/roles.go с гибкой моделью ролей~~ — закрыто
   2026-09-26 (§3.2).
2. ~~Коллекции `characters` и `designs`~~ — закрыто: миграция 1766600000
   (`characters`: owner_id/name/status_line/signature/avatar_url +
   исторические даты; `designs`: css/js/theme/welcome_message; server-only,
   уникальный индекс «одна активная design»). ~~Осталось: `user_drafts`~~ —
   закрыто 2026-09-26: драфты импортируются в `posts` c `is_draft=true`
   (см. §4, правило drafts).
3. Решения по дрейфу системных ролей moderator/spectator/player (§3.1) —
   продуктовое, до финального cutover.
4. Auth: перенос паролей невозможен — план сброса/линковки провайдеров.
5. Писатели домена: collections из §4 «остальные» + импорт данных по §5.
6. Мусор в рабочей копии вычищен 2026-09-26 (`zzz_debug_test.go`,
   `_out.txt`); закоммитить изменения `1766500000`, `1766600000`,
   `role_import.go`, `importer/`.





