# ARCHITECTURE.md — архитектура Aerun

> **Статус:** актуально (2026-11-02, ветка `main`). Источники истины: код в `backend/`, маршруты — `backend/internal/platform/pocketbase/run.go`, схема — `backend/internal/migrations/`.
> Обновлять при изменении структуры пакетов, границ слоёв или топологии (правила: `.agent/rules/documentation_maintenance.md`).

---

## 1. Общая схема

```
Браузер (React 19 SPA, dist/)
   │  PocketBase SDK (auth) + fetch /api/aerun/* (команды) + SSE (realtime)
   ▼
Caddy (TLS, aerun-world.com)
   │  /api/* и /_* → reverse proxy; остальное — статика dist/ (SPA fallback)
   ▼
Go-процесс (backend/cmd/aerun) — один бинарник, PocketBase встроен
   │  127.0.0.1:8090, systemd aerun.service
   ▼
SQLite (backend/pb_data/ — данные, только через PocketBase core)
```

Фронтенд и бэкенд деплоятся как **один сайт**: статика раздаёт Caddy, API — Go-процесс. На VPS — прод; локально то же самое, но Caddy не нужен (`127.0.0.1:8090` + Vite dev-server).

## 2. Бэкенд: слои и границы

| Пакет | Роль | Правила |
|-------|------|---------|
| `backend/cmd/aerun` | точка входа | Отклоняет CLI-аргументы; конфигурация **только** из переменных окружения (`AERUN_*`, опционально `.env.local` в корне); программный запуск `apis.Serve`, self-probe health, graceful shutdown |
| `backend/internal/config` | разбор/валидация окружения | Отвязан от PocketBase — guardrails тестируются без БД (`AERUN_LISTEN` только loopback, HTTPS в production, `AERUN_ENCRYPTION_KEY` обязателен в production, mail mode `disabled/dashboard/smtp`) |
| `backend/internal/platform/pocketbase` | **единственное место, где разрешён импорт PocketBase** | Все HTTP-хендлеры `/api/aerun/*`, AccessResolver, error contract, идемпотентность, hooks (mail, OAuth, активация), crons (outbox dispatch, DM collector, guest presence cleanup), realtime signals |
| `backend/internal/auth` | домен идентичности | Реестр прав (`permission.go`), rank-матрица ролей, статусы аккаунта; framework-free |
| `backend/internal/forum` | домен форума | Кубики (dice), валидация контента, константы |
| `backend/internal/messaging` | домен ЛС | Валидация сообщений, константы |
| `backend/internal/migrations` | схема | Append-only, timestamped `NNNNNNNNNN_name.go`, up+down; тесты рядом |

**Жёсткая граница:** доменные пакеты (`auth`, `forum`, `messaging`) не импортируют PocketBase. PocketBase разрешён только в `internal/platform/pocketbase` и в миграциях. Планируемые доменные пакеты (`notifications`, `audit`, `storage` — см. `backend/README.md`) добавляются рядом, тоже framework-free.

### 2.1 Поток запроса (команда)

```
HTTP-запрос → assignRequestID (X-Request-ID)
  → errorContractMiddleware (единая форма ошибок)
  → AccessResolver middleware (роль + статус + права из roles / permission matrix)
  → requireLiveAccount (soft-deleted аккаунт отсекается на всей группе)
  → [RequirePermission(key)] — маршрутный гейт
  → [enforceIdempotency] — буферизация тела, 512 KiB cap, ключ (actor, key)
  → handler: бизнес-решения внутри (владение записью, ранг-матрица, верификация email)
  → мутация в транзакции + зачистка денормализованных копий + audit_log
```

Важный паттерн: **владение — свойство записи, а не маршрута**. Если решение зависит от содержимого записи (чей голос, чей пост), оно принимается в хендлере после загрузки записи, а не в route-мидлваре (пример: репутация, `run.go` §Sprint 4).

### 2.2 Фоновые процессы (crons)

- `outbox_dispatch` — доставка исходящих email с retry (`outbox_events.next_attempt_at`).
- `dm_collector` — обслуживание папок/tombstones ЛС.
- `registerGuestPresenceCron` — очистка просроченного гостевого presence.

## 3. Модель записи: deny-by-default

- Правила мутаций коллекций закрыты (superuser-only) — единственный supported путь изменения состояния это команды `/api/aerun/*`.
- Права читаются из коллекции `roles` (seed в миграциях); компилированная матрица в `internal/auth` — fallback при отсутствии строки: сломанный lookup деградирует в **deny**, не в allow.
- Гость (неаутентифицированный) имеет baseline `view_forum`; `pending` сужает роль до `view_forum` + self-edit; `banned` отсекается гейтом группы.

## 4. Фронтенд: слои

| Каталог | Роль |
|---------|------|
| `src/api/pocketbase.js` | SDK-клиент и базовый `sendApi` |
| `src/api/backend/command-client.mjs` | обёртка команд `/api/aerun/*` (auth + Idempotency-Key + error contract) |
| `src/api/shared-poll.js` | общий polling: один poll на именованный ресурс, коалесценция, ничего не опрашивает в скрытых табах |
| `src/api/realtime-signals.js` | SSE-подписка на серверные сигналы |
| `src/api/rtdb-*.js` | **исторические имена** (эпоха Firebase RTDB), реализация — PocketBase; переименование по мере правок |
| `src/contexts/` | AuthProvider, ThemeProvider, DesignProvider, I18nProvider, ToastProvider, TitleProvider |
| `src/components/` | admin, auth, common (переиспользуемые), dm, layout, modals, profile, topic |
| `src/pages/` | MainPage, CategoryPage, TopicPage, ProfilePage, MessagesPage, AdminPage, DraftsPage, MembersPage и др. |
| `src/i18n/dictionary.js` | словарь EN/RU, доступ через `t()` |

Правила UI: `.agent/rules/ui_standards.md` (i18n, CSS-переменные, 3 темы, DRY).

## 5. Кросс-доменные механизмы

- **Идемпотентность:** `Idempotency-Key` + `request_hash` → `idempotency_keys` (UNIQUE(actor, key)); ответ сохраняется и переигрывается. Исключение — multipart-загрузки (буферизация тела несовместима с файлами).
- **Error contract:** каждая ошибка `/api/aerun/*` — PocketBase-конверт с `data.{retryable, conflict, forbidden, validation, kind, request_id}`; kinds: `validation`, `conflict`, `forbidden`, `unauthorized`, `not_found`, `rate_limited`, `internal`. Источник: `errors.go`; подробнее в `API.md`.
- **Аудит:** значимые действия пишутся в `audit_logs` с `request_id` и ролью актора; это единственный след hard-удалений.
- **Почта:** только через общий шаблон (`mail_templates.go`), режимы `disabled`/`dashboard`/`smtp`; mail guard запрещает отправку на чужой email через test-эндпоинт.
- **Уведомления:** in-app (`notifications`) + email через outbox; realtime через SSE-сигналы + polling.

## 6. Топология прод-деплоя

- Caddy: TLS `aerun-world.com`, `/api/*` + `/_/*` → `127.0.0.1:8090`, остальное — `dist/` с SPA-fallback (`try_files … /index.html`).
- systemd `aerun.service`, конфиг через `EnvironmentFile=/home/deploy/project/.env` (mode 600, gitignored).
- Конфиги держатся в репозитории: `backend/deploy/aerun.service`, `backend/deploy/Caddyfile` (IaC-правило из `AGENTS.md`).
- Деплой: `deploy.py` (см. `DEPLOY.md`), миграции применяются при старте автоматически.

## 7. Правила для нового кода

1. Новый HTTP-эндпоинт → хендлер в `internal/platform/pocketbase/<domain>.go` + регистрация в `run.go` (группировка по домену, комментарий о причине каждого решения маршрута).
2. Мутация → `enforceIdempotency` по умолчанию; отказ от него — с комментарием-обоснованием (как у multipart).
3. Изменение схемы → новая миграция; применённую не править.
4. Новое право → ключ в `permission.go` (реестр), выдача роли, документирование в `PROJECT_SPEC.md` §2.
5. Любое удаление → перечитать правило «Deletion Must Settle Its Denormalized Copies» в `.agent/rules/AGENTS.md`.

