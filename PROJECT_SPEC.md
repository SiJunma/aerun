# PROJECT_SPEC.md — функциональная спецификация Aerun

> **Статус:** актуально (создан 2026-11-02, обновлено 2026-11-25, ветка `main`). Источник истины по полям коллекций — Go-миграции `backend/internal/migrations/` (append-only); по маршрутам — `backend/internal/platform/pocketbase/run.go`.
> При изменении схемы, API или модели доступа обновляйте этот файл в том же коммите (правила: `.agent/rules/documentation_maintenance.md`).

---

## 1. Модель данных (PocketBase / SQLite)

Общие принципы:
- **Браузеру прямой доступ к коллекциям закрыт** (rules = superuser-only); всё общение — через `/api/aerun/*`.
- Миграции append-only: новая миграция = новый timestamped-файл; применённый файл не редактируется.

| Коллекция | Назначение | Ключевые поля (не исчерпывающе) |
|-----------|-----------|--------------------------------|
| `users` | аккаунты | `nickname` (без CRLF), `nickname_normalized` (уник.), `role_id`, `status` (`pending`/`active`/`banned`), `is_deleted` (soft-delete), `avatar`, `avatar_url`, `settings`, `post_count`, `topics_count`, `reputation`, `last_seen`, `email` (опц.), `legacy_firebase_uid` (историч.); чтение superuser-only (`ViewRule=nil`, `ListRule=nil`) |
| `roles` | роли и права | `role_id`, `name`, `rank` (ранг-матрица), `permissions` (JSON-список ключей), `is_system`, `color` |
| `categories` | категории форума | `name`, `slug` (уник.), `description`, `sort_order`, `allowed_roles`, права по постам/темам, bilingual-названия |
| `category_groups` | группы категорий | `name`, `sort_order` |
| `topics` | темы | `category_id`, `author_id`, `title` (без CRLF), `slug`, `description`, `locked`, `pinned`, `posts_count`, `last_post_id`, `last_post_created`, `last_post_author_id` |
| `posts` | посты И черновики | `topic_id`, `author_id`, `content`, `sequence` (порядковый номер в теме), `is_draft` (черновик = пост с этим флагом), `edited`, `editor_id`, автор-маска (`author_ref`), `rolls`, гостевой `nickname` |
| `characters` | маски/персонажи | владелец, имя, аватар, статус/подпись; лимит масок — настройка |
| `designs` | темы оформления | CSS/настройки темы, `default_design_id` |
| `topic_subscriptions` | подписки на темы | `user_id`, `topic_id` (уник.) |
| `topic_read_states` | прочитанность | `user_id`, `topic_id`, `last_read_post_id`, курсор |
| `reputation_votes` | голоса репутации | `voter_id`, цель (post/profile), guest-цель поддержана |
| `audit_logs` | журнал действий | `actor`, `actor_role`, `action_type`, payload, `request_id` |
| `notifications` | in-app уведомления | получатель, `type` (topic_reply и др.), `read`, `archived`, payload |
| `outbox_events` | очередь исходящих email | `event_type`, `audience_id`, `next_attempt_at`, `last_error`, retry-крон |
| `dm_conversations` | диалоги ЛС | участники через `dm_members` |
| `dm_members` | членство в диалоге | `conversation_id`, `user_id`, `sequence`, `cleared_at`, `erased_sequence`, папки/флаги |
| `dm_messages` | сообщения ЛС | `conversation_id`, отправитель, `content`, tombstone-удаление |
| `guest_principals` | cookie-идентичность гостей | гостевой ID, аватар/имя |
| `guest_presence` | присутствие гостей | `first_seen`, `last_seen` = момент последнего клика (15-мин окно онлайна), TTL, чистится кроном |
| `forum_settings` | глобальные настройки | название, темы/дизайн, `email_templates`, `topics_per_page`, флаги dice/reputation/characters/masks, админские секреты (`maxmind_license_key`, `geoip_updated_at`, `google_client_id`, `google_client_secret`, `ip_hash_salt`; правила закрыты, не отдаются в публичный `/settings`) |
| `idempotency_keys` | идемпотентность | `actor`, `key`, `request_hash`, `response_json`, `status`; UNIQUE(actor, key); автоочистка кроном (старше 48ч) |
| `visits` | сессии/визиты | `occurred_at`, `user_id`, `guest_id`, `session_id`, `ip` (90 дней retention), `ip_hash`, `country`, `city`, `device`, `browser`, `os`, `entry_path`, `referrer`, `is_bot`; правила закрыты |
| `topic_visits` | просмотры тем | `topic_id`, `occurred_at`, `user_id`, `guest_id`, `session_id`; правила закрыты |
| `ip_bans` | блокировки IP/подсетей | `ip_or_subnet`, `ip_start`, `ip_end` (16-байтный hex), `reason`, `banned_by`, `created_at`, `expires_at`, `is_active`; правила закрыты |
| `daily_visits_summary` | суточные агрегаты | `date` (PK), `total_visits`, `unique_visitors`, `unique_members`, `unique_guests`, `bot_visits`, `new_registrations`, `posts_count`, `countries_json`, `devices_json`, `entry_paths_json`; правила закрыты |

> Полные списки полей и правила индексов — в соответствующих файлах миграций (`1765900000_domain_foundation.go` … `1781000005_admin_secrets_settings.go`).

## 2. RBAC — модель доступа

- Права задаются **ключами-строками** (см. `backend/internal/auth/permission.go`, реестр `allPermissions`). Каждая роль несёт список ключей; проверка — `RequirePermission(...)` на маршруте или в хендлере.
- **Ранг-матрица:** операции над другой ролью разрешены, только если ранг вызывающего выше; проверяется в хендлерах (например, смена никнейма).
- **Статус аккаунта** сужает права: `pending`/`banned`/`is_deleted` ограничены (гейт `requireLiveAccount` на всей группе `/api/aerun`), pending может писать только в guest-зоны.
- **Корневая роль (`root`)** передаётся только через команду `POST /admin/transfer-root` (требует root-роль + пароль вызывающего); право `view_raw_ip` (просмотр незамаскированных IP) закреплено исключительно за Chief Admin (Root).
- **Категории:** `allowed_roles` ограничивает видимость; отдельные права на посты/темы категории (split permissions).

Полный список ключей прав (по `permission.go`): `admin_access`, `manage_forum`, `manage_designs`, `manage_roles`, `manage_categories`, `manage_ip_bans`, `approve_users`, `ban_users`, `delete_users`, `change_roles`, `view_audit_log`, `view_visits_dashboard`, `view_raw_ip`, `moderate_content`, `move_topics`, `close_topics`, `pin_topics`, `edit_self_nickname`, `edit_others_nicknames`, `edit_self_avatar`, `edit_others_avatars`, `edit_self_status`, `edit_others_statuses`, `edit_self_signature`, `edit_others_signatures`, `edit_self_profile`, `edit_others_profile`, `edit_self_post`, `edit_others_posts`, `delete_self_post`, `delete_others_posts`, `edit_self_topic`, `edit_others_topics`, `delete_self_topic`, `delete_others_topics`, `delete_own_topic_with_replies`, `view_forum`, `post_reply`, `create_topic`, `use_reputation`, `edit_self_reputation`, `delete_self_reputation`, `edit_others_reputation`, `delete_others_reputation`, `use_masks`, `create_self_mask`, `delete_self_mask`, `create_others_mask`, `edit_others_mask`, `delete_others_mask`, `use_dice`, `view_master_dice`, `use_direct_messages`, `bypass_hide_tags`, `mention_all`.

---

## 3. API — маршруты `/api/aerun/*`

Источник истины: `backend/internal/platform/pocketbase/run.go` (функция `registerRoutes`). Все маршруты проходят middleware: `errorContractMiddleware` → `AccessResolver` → `requireLiveAccount`. Мутации обычно требуют `Idempotency-Key` (кроме multipart-загрузок).

### 3.1 Служебные
- `GET /health` — liveness; `GET /status` — статус + статистика presence.
- `GET /settings` — публичный снапшот настроек (без секретов); `PATCH|PUT /admin/settings` (admin_access); `PUT /admin/settings/placeholder/{kind}` — загрузка identity-placeholder (multipart, без idempotency).
- `GET /admin/secrets`, `PATCH /admin/secrets` (`manage_forum`) — чтение (маскировано) и запись секретов интеграций в БД (MaxMind license key, Google OAuth2, SMTP, IP hash salt); `POST /admin/geoip/download` (`manage_forum`) — скачивание и hot-reload `GeoLite2-City.mmdb` по ключу из БД.

### 3.2 Аккаунт и профиль
- `GET /me`; `PUT /me/settings`; `PUT /me/avatar` (multipart); `PATCH /me/nickname`; `PATCH /me/profile`.
- `GET /me/auth`; `PUT /me/password`; `PATCH /me/email`; `DELETE /me/auth/{provider}` — отвязка OAuth-провайдера.
- `PATCH /users/{id}/nickname`, `PATCH /users/{id}/profile` — редактирование других (права + ранг-матрица).

### 3.3 Аутентификация и админ-управление
- `POST /auth/register` (rate-limited token bucket 20/мин); `POST /auth/resend-verification`.
- Публичные SPA-маршруты: `/auth/confirm-verification/:token` и `/auth/confirm-password-reset/:token` (панель `/_/*` PocketBase изолирована в Caddy для loopback/admin IP).
- `GET|PATCH|DELETE /admin/users[...]`: список, `{id}`, bulk-обновление, bulk-удаление (admin_access).
- `POST /admin/transfer-root` — передача root-роли (root-роль + пароль вызывающего).

### 3.4 Справочники
- Роли: `GET /roles` (публично, для бейджей), `GET /admin/roles` (manage_roles, с матрицей прав), `POST|PATCH|DELETE /roles[...]`.
- Дизайны: `GET /designs`, `GET /designs/{id}`, `POST|PATCH|DELETE /designs[...]` (manage_designs).
- Группы категорий: `GET|POST|PATCH|DELETE /category-groups[...]` (manage_categories на запись).

### 3.5 Категории и форум-обзор
- `GET /categories` (публично), `GET /admin/categories` (с `allowed_roles`), `POST|PATCH|DELETE /categories[...]` (manage_categories).
- `GET /forum-index` — категории + группы одним ответом; `GET /forum-stats` — totals.

### 3.6 Пользователи и маски
- `GET /users`, `GET /users/search`, `GET /nicknames/check`, `GET /users/{id}` — публичный DTO профиля (без `settings`).
- `GET /users/{id}/characters`, `GET /users/{id}/posts` — вкладки профиля.
- Маски: `GET /characters/{id}`, `POST /me/characters`, `POST /users/{id}/characters` (create_others_mask), `PATCH|DELETE /characters/{id}`, `PUT /characters/{id}/avatar` (multipart).

### 3.7 Presence и гости
- `POST /presence/heartbeat` (принимает `last_active_at` — момент последнего клика; см. `API.md` §3.5), `POST /presence/leave`, `POST /presence/guest/leave` (явный leave при логине/разлогине; закрытие вкладки не удаляет гостя — строка живёт 15 минут от последнего клика), `GET /presence/guests`, `GET /presence/online-users`, `GET /status` (консолидированный снапшот присутствия; перечитывается по SSE `presence.update`).
- `POST /guest/principal` — выдача/подтверждение гостевой cookie-идентичности (`aerun_guest_cap`, с флагом `Secure` при HTTPS).

### 3.8 Темы и посты
- `POST|GET /topics`, `GET /topics/{id}`, `GET /topics/{id}/stats`, `GET /topics/{id}/context`, `PATCH|DELETE /topics/{id}`, `POST /topics/{id}/move` (move_topics).
- `POST|GET /topics/{id}/posts`, `GET|PATCH|DELETE /posts/{id}`, `POST /topics/{id}/posts/move` (move_topics).
- `getPostHandler` проверяет `canViewTopic`, возвращая 404 для недоступных постов; `listUserPostsHandler` фильтрует сообщения по `allowedCategoryIDs`.
- Серверная генерация кубиков (`crypto/rand`) при публикации по тегам `[dice=N]`; заморозка существующих бросков при редактировании (`ValidateRollsFreeze`), отказ при конфликте `roll_id`. Ролевой AST-санитизатор HTML: админам разрешены script/style/iframe, обычным пользователям — строгий whitelist тегов/атрибутов без внешних зависимостей.

### 3.9 Черновики
- `GET /me/drafts`, `GET|PUT /topics/{id}/draft`, `DELETE /drafts/{id}`, `POST /drafts/{id}/publish`.
- Права решаются в хендлере (`categoryWriteAllowed`): pending/unverified могут писать в guest-зоны.

### 3.10 Подписки, прочитанность, репутация, аудит
- `POST /topics/{id}/subscribe`, `POST|DELETE /topics/{id}/unsubscribe` (+ `DELETE /topics/{id}/subscription`), `GET /topics/{id}/subscription`, `GET /me/subscriptions`.
- `POST /topics/{id}/read`, `POST /me/topics/read-all` (без idempotency — идемпотентны по построению).
- Голоса: `POST|DELETE /posts/{id}/vote`, `POST|DELETE /users/{id}/vote`, `PUT|DELETE /reputation/{id}` (use_reputation; владелец записи проверяется в хендлере), `GET /posts/{id}/voters`, `GET /users/{id}/reputation`, `GET /me/votes`.
- `GET /admin/audit-logs` (view_audit_log).

### 3.11 ЛС
- `POST|GET /dms`; `GET /conversations/peer/{peerId}`; `GET /peers/{id}` (карточка корреспондента).
- `POST|GET /dms/{id}/messages`; `POST /dms/{id}/read`; `POST /dms/{id}/clear` (скрыть у себя); `DELETE /dms/{id}` (папка «Удалённые» → полное стирание, когда не видно никому).
- `PATCH|DELETE /dm-messages/{id}` — авторство/membership проверяются в хендлере.

### 3.12 Уведомления и outbox
- `GET /me/notifications`; `PATCH /me/notifications/{id}/read`; `POST /me/notifications/read-all`; `POST /me/notifications/archive-all`; `PATCH /me/notifications/{id}/archive`; `GET /me/unread-counts`.
- `GET /admin/outbox-events`, `POST /admin/outbox-events/{id}/retry` (view_audit_log).
- Шаблоны почты: `GET /admin/email-templates`, `PUT /admin/email-templates`, `POST /admin/email-templates/test` (admin_access).

### 3.13 Аналитика посещений и IP-контроль
- `POST /telemetry/visit`: сбор визитов и сессий (30 мин окно durable touch-дедупликации в памяти + БД, GeoIP, User-Agent, боты).
- `GET /admin/analytics/dashboard?period=today|7d|30d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD`: сводка KPI (сравнение с равным по длине предыдущим периодом), почасовая гистограмма, динамика по дням, топы стран/устройств/путей (без `/admin*`) (`view_visits_dashboard`).
- `GET /admin/analytics/topics?period=today|7d|30d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD`: статистика просмотров и уникальных читателей тем (`view_visits_dashboard`).
- `GET /admin/analytics/visits`: постраничный лог визитов с фильтрами (вкл. `period`/`from`/`to`) и поиском; маскирование IP при отсутствии `view_raw_ip` (`view_visits_dashboard`).
- `GET /admin/analytics/ip-dossier`: досье IP-адреса с историей, привязанными аккаунтами и статусом бана (`view_visits_dashboard`).
- `GET /admin/analytics/suspicious`: детекция мультиаккаунтов, всплесков регистраций (24ч), частой смены IP и наплывов гостей (`view_visits_dashboard`).
- `GET /admin/users/{id}/ips`: последние 10 IP-адресов активности участника для карточки пользователя (`view_visits_dashboard`, маскируется без `view_raw_ip`).
- `POST /admin/ip-bans`, `POST /admin/ip-bans/{id}/unban`, `GET /admin/ip-bans`: управление банами по IP/подсети (`manage_ip_bans`, запись в `audit_logs`).

## 4. Жизненный цикл сущностей

- **Аккаунт:** register (pending) → верификация → active; ban / soft-delete (`is_deleted`); root передаётся только через transfer-root.
- **Тема/пост:** создание → редактирование (фиксируется `editor_id`) → HARD delete (audit_log — единственный след; денормализованные копии зачищаются в той же транзакции).
- **Черновик:** пост с `is_draft` → publish превращает в обычный пост.
- **ЛС:** clear (персональное скрытие) → delete (папка «Удалённые») → окончательное стирание только сообщений, невидимых всем участникам (tombstone-семантика).
- **Репутация:** голос → правка/отзыв владельцем записи; агрегаты пересчитываются (`RecomputeUserCounters`), exactly-once.
- **Outbox:** событие → доставка SMTP с retry (`next_attempt_at`) → ручной retry через admin-маршрут.

## 5. Контракты и соглашения

- **Ошибки:** единый error-contract (middleware `errorContractMiddleware`), в ответе присутствует `request_id`.
- **Идемпотентность:** `Idempotency-Key` + `request_hash`; повтор возвращает сохранённый ответ. Не применяется к multipart (`/me/avatar`, `/characters/{id}/avatar`, placeholder).
- **Аутентификация:** PocketBase auth (email/password + Google OAuth2); токен в `Authorization`.
- **Realtime:** SSE/сигналы (`realtime_signals`) + клиентский polling через `src/api/shared-poll.js`.

