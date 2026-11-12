# API.md — контракты `/api/aerun/*`

> **Статус:** актуально (2026-11-02). Полный перечень маршрутов — `PROJECT_SPEC.md` §3; источник истины — `backend/internal/platform/pocketbase/run.go` (регистрация) и одноимённые хендлеры. Этот документ описывает **конвенции и контракты**, общие для всех команд.

---

## 1. Общие правила

- **База:** все команды живут под `/api/aerun/` внутри Go-процесса. PocketBase-нативные эндпоинты (`/api/collections/...`) используются фронтендом только для аутентификации (`users` auth) и OAuth2-редиректа; запись в коллекции браузеру запрещена.
- **Аутентификация:** токен PocketBase в заголовке `Authorization` (authStore SDK). Гость — неаутентифицированный запрос с baseline `view_forum`.
- **Middleware на всей группе:** `errorContractMiddleware` → AccessResolver (роль+статус+права) → `requireLiveAccount`.
- **`X-Request-ID`:** каждый ответ несёт `X-Request-ID` (входящий валидный ID эхом, максимум 64 символа `[A-Za-z0-9_.:-]`, иначе свежий случайный); используйте его для корреляции в логах и баг-репортах.
- **Idempotency-Key:** все мутационные маршруты, отмеченные `enforceIdempotency`, требуют заголовок `Idempotency-Key`. Повтор того же запроса с тем же ключом возвращает сохранённый ответ (таблица `idempotency_keys`, UNIQUE(actor, key) + хэш тела `request_hash`). Тело мутации ограничено 512 KiB. **Исключения** (multipart, буферизация невозможна): `PUT /me/avatar`, `PUT /characters/{id}/avatar`, `PUT /admin/settings/placeholder/{kind}`.
- **Пагинация:** там, где есть списки с страницами — `page` / `perPage` (у админ-списка пользователей default и cap = 30).

## 2. Контракт ошибок

Каждая ошибка `/api/aerun/*` — стандартный PocketBase-конверт с машинночитаемым `data`:

```json
{
  "status": 409,
  "message": "human-readable reason",
  "data": {
    "retryable": false,
    "conflict":  true,
    "forbidden": false,
    "validation": false,
    "kind": "conflict",
    "request_id": "01H..."
  }
}
```

| Флаг | Значение для клиента |
|------|----------------------|
| `validation` | запрос некорректен — править payload, вслепую не ретраить |
| `conflict` | запрос валиден, но текущее состояние ресурса отвергает (закрытая тема, повтор ключа идемпотентности) |
| `forbidden` | аутентификация/авторизация не прошла (401/403) |
| `retryable` | повтор того же запроса позже может пройти (5xx, rate limit) |

Значения `kind`: `validation`, `conflict`, `forbidden`, `unauthorized`, `not_found`, `rate_limited`, `internal` (пустые флаги достраиваются middleware по статус-коду, поэтому ошибки, поднятые глубоко в PocketBase, тоже соблюдают контракт). Каждый ответ с ошибкой также содержит версию сборки в логах сервера (`buildVersion`).

## 3. Замечательные контракты отдельных команд

Полные списки маршрутов — в `PROJECT_SPEC.md` §3. Здесь — то, что нужно знать потребителю и что не очевидно из списка маршрутов.

### 3.1 Регистрация и верификация
- `POST /auth/register` — только для гостей. Создаёт аккаунт роли `player` в состоянии `status=pending`, `verified=false`; ответ **никогда** не содержит email, хэш пароля или token key. Конфликты: `409` при дубликате email или никнейма (регистронезависимо и с нормализацией пробелов через `nickname_normalized`); зарезервированные никнеймы (имена ролей, «aerun», «staff», …) отклоняются. Тело больше 64 KiB → `413`. Письмо-верификация отправляется best-effort; вердикт в ответе: `mail_sent` / `mail_error` (`false` с причиной, если SMTP выключен) — UI не имеет права говорить «письмо отправлено», если оно не ушло.
- `POST /auth/resend-verification` — честный resend для вызывающего: `mail_sent=true` только после реальной отправки; `503` + `mail_sent=false`, если почта выключена; `{verified:true}`, если верифицировать уже нечего.

### 3.2 Email verification gate (контентные мутации)
Создание темы, ответ, открытие ЛС и отправка сообщения в ЛС дополнительно требуют подтверждённого email (`users.verified = true`). Отказ: `403`, сообщение «this account's email is not verified; confirm it before posting or messaging». Освобождены по построению: гости (нет почтового ящика), staff (`root`/`admin`/`moderator`) и `pending`-аккаунты — pending может **отвечать** в начатом с ним диалоге, но не открывать новый (проверка живёт внутри транзакции ЛС, где разрешается гонка за первое сообщение).

### 3.3 Настройки аккаунта
- `PUT /me/settings` — полная замена `users.settings` владельцем: JSON-объект ≤256 KiB, ≤8 уровней вложенности. Banned → `403`; pending сохраняет legacy self-service права.
- `GET /admin/users` — `admin_access` (root/admin; модератор получает `403`). Фильтры `page`, `perPage`, `status`. Payload — явный whitelist (`id`, `nickname`, `role`, `status`, `verified`, `avatar_url`, `created`, `updated`, `post_count`, …), без приватных полей.
- `POST /admin/transfer-root` — единственный способ передать root-роль: требуется root-роль вызывающего **и его пароль**; обычная запись роли root отклоняется для всех.

### 3.4 Прочее
- Публичный профиль (`GET /users/{id}`) и список участников (`GET /users`) — это DTO без `users.settings` и приватных полей; браузерный SDK-доступ к `users` закрыт намеренно.
- Reputation edit/delete (`PUT|DELETE /reputation/{id}`) гейтится только `use_reputation`, а решение принимает хендлер по владельцу записи: ключи `edit/delete_self_reputation` / `edit/delete_others_reputation` применяются после загрузки записи (`voter_id`).
- `POST /dms/{id}/clear` — персональное скрытие; `DELETE /dms/{id}` — перемещение в папку «Удалённые»; окончательное стирание сообщения происходит только когда оно больше не видно ни одному участнику.
- Read-маркировка (`POST /topics/{id}/read`, `POST /me/topics/read-all`) идемпотентна по построению (перезапись одной строки тем же значением) и **не** требует `Idempotency-Key`.

### 3.5 Presence и активность
- `POST /presence/heartbeat` принимает `last_active_at` — момент последнего активного клика/нажатия клавиши клиента (unix millis, unix seconds или RFC3339). Сервер считает «онлайн» ровно **15 минут от последнего клика**, а не от последнего heartbeat-тика; тик без нового клика онлайн не продлевает. Значение клампится в окно `[now−15m, now]` (будущее → `now`, stale → краю окна), отсутствие поля у старых клиентов трактуется как `now`. Та же семантика у гостевого heartbeat (`guest_id` + `last_active_at`): `guest_presence.last_seen` = момент последнего клика.
- `users.last_seen` (профиль, список участников, 24-ч активность) записывается временем последнего **клика**, а не момента выбывания из онлайна: при выбывании по 15-мин таймауту в колонку пишется точное время последнего клика; троттлинг записи 5 минут; мгновенно — при логине, пробуждении и разлогине.
- `POST /presence/leave` (member) и `POST /presence/guest/leave` — явное снятие с учёта при логине/разлогине. **Закрытие вкладки не удаляет гостя**: строка живёт, пока не истечёт 15-мин окно от последнего клика (аналог `onDisconnect().remove()` не используется сознательно).
- Изменения состава онлайна (вход, выбывание по таймауту, смена никнейма, admin delete/ban) публикуют SSE-сигнал **`presence.update`** (debounce 2 с, без данных); клиенты перечитывают `GET /status` по этому nudge. **Регистрация нового аккаунта** также публикует `presence.update` (регистрация двигает `totalUsers` и `newestUser` в `GET /forum-stats` до первого heartbeat) — клиенты перечитывают форумную статистику по этому nudge.

## 4. Клиентская обёртка

- Фронтенд вызывает команды через `src/api/backend/command-client.mjs`: подставляет токен, `Idempotency-Key`, нормализует error-contract.
- Polling только через `src/api/shared-poll.js` (`sharedPoll(name, ...)`) — см. правило «A subscription is not a timer» в `.agent/rules/AGENTS.md`.
- Realtime: `src/api/realtime-signals.js` (SSE) с fallback на polling.

