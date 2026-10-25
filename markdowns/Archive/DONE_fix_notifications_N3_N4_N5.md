# DONE — план фиксов уведомлений (баги N3, N4, N5)

## Статус
`DONE` — все проверки пройдены: gofmt/vet/build бэкенда чистые,
go test ./internal/platform/pocketbase/ — ok (544.661s), ESLint и vite build фронтенда — зелёные.
Исправлено: N3 (уведомление админу о регистрации), N4 (уведомление об изменении репутации), N6 (гость не может создать тему: сервер требует guest_nickname, а фронтенд не отправлял его — добавлено в `createTopic` в `src/api/forum.js`; плюс fallback на `guest_nickname` в шапке темы `TopicPage.jsx` для старых записей),
N5 (чекбокс «уведомить юзера о смене роли» с умолчанием включено).
Плюс параллельный баг: у гостя в гостевой теме слетала айдентики —
forum_authors.go (декораторы читают author.display_name из nested DTO)
+ TopicPage.jsx заголовок темы теперь передаёт author={topic.author} в ForumAuthorName.
## Цель
Восстановить/добавить три сценария уведомлений, которые были на Firebase и пропали/отсутствуют после миграции на PocketBase backend:
1. **N3** — админ не видит уведомление о регистрации нового пользователя (нужно "сообщение админу при регистрации").
2. **N4** — нет уведомления об изменении репутации (из профиля и из темы).
3. **N5** — нет уведомления юзеру о смене роли с чекбоксом "уведомить юзера о смене роли" в Manage User Settings (по умолчанию включено).

## 0. Что уже есть в кодовой базе (опора для фиксов)

| Элемент | Путь | Примечание |
|---------|------|------------|
| Единый серверный создатель уведомлений | `backend/internal/platform/pocketbase/notifications.go:258` | `createNotification(txApp, recipientID, senderID, notifType, title, payload)` — пишет строку в транзакции и публикует realtime-сигнал. Новые типы не могут забыть про сигнал. |
| Регистрация аккаунта | `backend/internal/platform/pocketbase/register.go:83` | `registerHandler` сохраняет пользователя и шлёт верификационную почту, но **не** уведомляет админов. |
| Смена роли админом | `backend/internal/platform/pocketbase/admin_users.go:185` | `adminUpdateUserHandler` меняет `role`/`status`, пишет аудит-лог, но **не** шлёт уведомление целику. |
| Репутация (голос за профиль) | `backend/internal/platform/pocketbase/reputation.go:254` | `voteUserHandler` меняет `users.reputation`, **не** создаёт уведомление целику. |
| Репутация (голос за пост) | `backend/internal/platform/pocketbase/reputation.go` + `run.go:437-440` | `votePostHandler`/`deletePostVoteHandler` — тоже без уведомления. |
| Firebase-эталон N3 | `functions/index.js:2740` (`onUserCreated`) | Шлёт `new_registration` админам (права `approve_users`/`ban_users`/`delete_users` + `root`), payload `{uid, nickname, email, admin_message}`. |
| Фронт: типы уведомлений | `src/pages/NotificationsPage.jsx:21-57` | `TYPE_META` уже содержит `new_registration`, `topic_reply`, `post_quoted`, `reputation_change`, `post_mentioned`. Фильтр по предпочтениям — строки 93-101. |
| Фронт: настройки профиля | `src/pages/ProfilePage.jsx:49,132-135,348-351,386` | Уже есть переключатели `notif_reputation` (`reputation_change`) и `notif_new_registration` (`new_registration`). |
| Словарь переводов | `src/i18n/dictionary.js:343-347` | Уже есть `notif_reputation`, `notif_new_registration`. Для N5 нужно добавить чекбокс + тип `role_change`. |
| Модал управления пользователем | `src/pages/AdminPage.jsx:2664-2743` + `handleSaveUserRole` (стр. 1011) | Туда добавляется чекбокс N5; флаг уходит в `updateUserRole`. |
| Бэкенд-форма смены роли | `backend/internal/platform/pocketbase/admin_users.go:180-183` | `adminUpdateUserForm{ Role, Status }` — добавить поле `NotifyRoleChange *bool`. |


## 1. Баг N3 — уведомление админу о регистрации нового пользователя

### Симптом
Зашли от админа после регистрации тестового аккаунта — в ленте уведомлений нет строки о новой регистрации (как было на Firebase). Ожидается also "сообщение админу при регистрации".

### Причина
`registerHandler` (`register.go:83`) создаёт запись пользователя и шлёт письмо верификации, но не создаёт уведомлений администраторам. На Firebase это делал триггер `onUserCreated` (`functions/index.js:2740`).

### Исправление (бэкенд)
1. В `registerHandler`, **после** успешного `e.App.Save(record)`, в том же запросе (или отдельной транзакции) создать уведомления типа `new_registration` для всех администраторов.
   - Получатели: аккаунты с ролью `root` и `admin` (и/или пользователи, у которых есть права управления пользователями — `approve_users`/`ban_users`/`delete_users`, по аналогии с Firebase). Точный набор уточнить через roles collection / матрицу прав; минимальный жизнеспособный вариант — `root` + `admin`.
   - Отправитель: только что зарегистрированный пользователь (`record.Id`).
   - Тип: `new_registration`.
   - Заголовок: `"New registration"` / `"Новая регистрация"`.
   - Payload: `{ uid, nickname, email?, admin_message? }` — по.Firebase-эталону; `admin_message` — опциональное сообщение админу (пока пустое/null, если не приходит из формы регистрации; оставить поле в структуре для совместимости).
2. Ошибка создания уведомления **не должна ломать регистрацию** (besteffort, как в Firebase `onUserCreated` — лог + продолжение), потому что регистрация уже завершена.
3. Не отправлять уведомление самому себе, если регистрирует администратор (опционально).

### Исправление (фронтенд)
- Ничего нового не требуется: `NotificationsPage.jsx` уже рендерит `new_registration` (`TYPE_META` стр. 22-28, `filterByPrefs` стр. 99). Убедиться, что `labelKey: 'notifications.types.new_registration'` есть в словаре (добавить перевод, см. раздел 6).

## 2. Баг N4 — уведомление об изменении репутации

### Симптом
Изменение репутации из профиля пользователя и из темы не порождает уведомления целику.

### Причина
`voteUserHandler` (`reputation.go:254`) и `votePostHandler` изменяют `users.reputation` и сохраняют голос, но не вызывают `createNotification` для целика. На Firebase аналогичное делало `onReputationLogCreated`.

### Исправление (бэкенд)
1. В `voteUserHandler` после `txApp.Save(targetUser)` создать уведомление:
   - Получатель: целевой пользователь (`targetUser.Id`).
   - Отправитель: голосовавший (`e.Auth.Id`).
   - Тип: `reputation_change`.
   - Заголовок: `"Reputation changed"` / `"Изменение репутации"`.
   - Payload: `{ voter_id, target_id, value, delta, post_id: '', topic_id: '', comment }`.
   - Уважать предпочтение целика `settings.notifications.reputation_change.in_app` (если `false` — не создавать). Читается сервером перед созданием.
2. То же самое в `votePostHandler` / `deletePostVoteHandler`:
   - Получатель: автор поста.
   - Payload: добавить `post_id`, `topic_id`.
3. При изменении знака голоса (редактирование существующего голоса) уведомление тоже создаётся. При полном удалении голоса — не создавать (рекомендация).

### Исправление (фронтенд)
- Уже поддерживается: `TYPE_META.reputation_change` (стр. 39-43), `filterByPrefs.reputation_change` (стр. 98), переключатель `notif_reputation` в профиле. Добавить иконку для `reputation_change` в `TYPE_META` (сейчас комментарий "Dynamic icon") — опциональная полировка.

## 3. Баг N5 — уведомление юзеру о смене роли с чекбоксом

### Симптом
Админ меняет роль пользователю в Manage User Settings, но пользователь об этом не узнаёт.

### Требование
- Чекбокс в модале "Manage User Settings" (User Edit Modal): "уведомить юзера о смене роли".
- По умолчанию чекбокс **включён (checked)**.
- Если роль меняется **без** галочки — уведомления не будет.
- Если с галочкой — создаётся уведомление целику о смене роли.

### Исправление (бэкенд)
1. `backend/internal/platform/pocketbase/admin_users.go`:
   - В `adminUpdateUserForm` добавить поле `NotifyRoleChange *bool \`json:"notify_role_change"\``.
   - В `adminUpdateUserHandler`, внутри транзакции, после `targetUser.Set("role", role)` и `txApp.Save(targetUser)`:
     - Если `form.Role != nil` **и** `form.NotifyRoleChange == nil || *form.NotifyRoleChange == true` (отсутствие поля = treated as true / default checked, чтобы не ломать старых клиентов), создать уведомление:
       - Получатель: целевой пользователь (`targetUser.Id`).
       - Отправитель: админ (`e.Auth.Id`).
       - Тип: `role_change` (новый тип).
       - Заголовок: `"Your role has been changed"` / `"Ваша роль изменена"`.
       - Payload: `{ target_id, old_role, new_role, changed_by }`.
2. Статус (`form.Status`) — уведомление не привязывать (только роль, по ТЗ).

### Исправление (фронтенд)
1. `src/pages/AdminPage.jsx`:
   - В `userForm` добавить поле `notifyRoleChange` (инициализировать `true`).
   - В `handleOpenUserModal` (стр. 1005) сбрасывать `notifyRoleChange: true` при открытии модала.
   - В User Edit Modal (стр. 2664-2743), после группы смены роли, добавить `Form.Check`:
     - label: `t('admin.users.notify_role_change_label')` ("уведомить юзера о смене роли").
     - `checked={userForm.notifyRoleChange}`, `onChange` обновляет `userForm.notifyRoleChange`.
   - В `handleSaveUserRole` (стр. 1011) передать `userForm.notifyRoleChange` в `updateUserRole(...)`.
2. `src/api/users.js` (функция `updateUserRole`) — добавить отправку поля `notify_role_change` в теле запроса.
3. Словарь `src/i18n/dictionary.js` — добавить ключ `admin.users.notify_role_change_label` (en/ru).
4. `NotificationsPage.jsx` — добавить `TYPE_META.role_change` (иконка, например `User` из lucide, цвет `warning` или `primary`, `labelKey: 'notifications.types.role_change'`) и `filterByPrefs` для `role_change` (по умолчанию true, фильтр опционален).

## 4. Словарь переводов (дополнить `src/i18n/dictionary.js`)

Секция `profile.notifications` (уже частично есть):
- `notif_reputation` — есть (en/ru).
- `notif_new_registration` — есть (en/ru).

Добавить:
- `admin.users.notify_role_change_label`:
  - en: "Notify user about role change"
  - ru: "Уведомить пользователя о смене роли"
- `notifications.types.role_change` (для NotificationsPage):
  - en: "Role changed"
  - ru: "Изменение роли"
- Проверить/дополнить `notifications.types.new_registration` и `reputation_change` в секции `notifications.types` (если там нет своего блока — используются `labelEn`/`labelRu` из `TYPE_META`, но перевод через `t()` предпочтительнее).


## 5. Список файлов к правке

### Бэкенд (Go)
1. `backend/internal/platform/pocketbase/register.go` — `registerHandler`: после `Save(record)` создать уведомления `new_registration` админам (besteffort).
2. `backend/internal/platform/pocketbase/reputation.go` — `voteUserHandler` (+ `votePostHandler` при необходимости): создать уведомление `reputation_change` целику с уважением `settings.notifications.reputation_change.in_app`.
3. `backend/internal/platform/pocketbase/admin_users.go`:
   - `adminUpdateUserForm`: поле `NotifyRoleChange *bool`.
   - `adminUpdateUserHandler`: при смене роли и флаге — уведомление `role_change` целику.

### Фронтенд (React/JS)
4. `src/pages/AdminPage.jsx` — чекбокс в User Edit Modal, `userForm.notifyRoleChange`, передача в `updateUserRole`, инициализация в `handleOpenUserModal`.
5. `src/api/users.js` (функция `updateUserRole`) — добавить `notify_role_change` в тело запроса (точный путь к функции уточнить при реализации).
6. `src/pages/NotificationsPage.jsx` — `TYPE_META.role_change`, опционально `filterByPrefs.role_change`.
7. `src/i18n/dictionary.js` — ключи `admin.users.notify_role_change_label`, `notifications.types.role_change` (en/ru).

### Не трогать
- `notifications.go` (`createNotification`) — оставляем как единую точку создания, новые типы используют её.
- `ProfilePage.jsx` — настройки репутации и регистрации уже есть, не трогать.

## 6. Критерий приёмки (Definition of Done)

- [x] **N3** (код готов): после регистрации любого аккаунта админ (root + роли с `approve_users`/`ban_users`/`delete_users`) видит в `/notifications` строку "Новая регистрация" с ником, email и `admin_message` нового пользователя; регистрация не ломается, если уведомление не удалось создать. `gofmt`/`vet`/`build` чистые.
- [x] **N4** (код готов): после изменения репутации пользователя (голос в профиле) и после голоса за пост в теме целевой пользователь получает уведомление `reputation_change`. Если у пользователя выключено `notif_settings.reputation_change.in_app` — уведомление не создаётся. `gofmt`/`vet`/`build` чистые.
- [x] **N5** (код готов, бэкенд-тесты — в фоне): в модале смены роли есть чекбокс "уведомить юзера о смене роли", по умолчанию включён. При смене роли с галочкой целевой пользователь получает `role_change`; без галочки — не получает. Флаг передаётся на бэкенд и хранится в `adminUpdateUserForm.NotifyRoleChange`. ESLint чист, `vite build` зелёный, контракт `check-account-status-axis.mjs` зелёный.
- [x] backend: `go build ./...` проходит; `go test ./internal/platform/pocketbase/` — ok (544.661s).
- [x] фронт: `npm run build` — зелёный (9.3s).
- [x] Все новые строки переведены en/ru (notify_role_change_label, role_change, role_changed_to).

## 7. Предложенный порядок реализации

1. Создать ветку от текущего состояния (перед началом — зафиксировать базу: `git status` чисто).
2. N5 (бэкенд): поле `NotifyRoleChange` + уведомление `role_change` в `admin_update_user_handler`.
3. N5 (фронт): чекбокс в модале, передача флага, переводы, `TYPE_META.role_change`.
4. N4 (бэкенд): уведомление `reputation_change` в `voteUserHandler` (и `votePostHandler`).
5. N3 (бэкенд): уведомление `new_registration` админам в `registerHandler`.
6. Прогнать бэкенд-тесты и фронтенд-сборку, проверить вручную все три сценария.
7. Переименовать файл в `DONE_*` / закрыть задачу.

## 8. Риски и открытые вопросы

- **N3 получатели**: Firebase брал роли по правам `approve_users`/`ban_users`/`delete_users`. В PocketBase нужно решить: брать по ролям (`root`/`admin`) или по правам из `roles` collection. Рекомендация для старта — `root` + `admin`, уточнить на реализации.
- **N4 серверный гейт предпочтений**: чтение `settings` целика внутри транзакции добавляет `get()` — приемлемо (одна запись на голос). Альтернатива — создавать всегда, пусть фронт фильтрует (как сегодня делает `filterByPrefs`). За серверный гейт.
- **N5 старые клиенты**: поле `notify_role_change` может отсутствовать — трактовать как `true` (default checked), чтобы не сломать поведение.
- **Тип `role_change`**: новый, не существует нигде (`grep role_change` — 0 результатов). Добавляем впервые.

Связанные документы: `backend/README.md` (маршруты API), `.agent/rules/AGENTS.md` (правило "Zero Silent Failures" — каждое уведомление должно иметь заголовок, сигнал и лог при ошибке), `markdowns/TODO_THEMEABLE_SPRINT_PLAN.md` (спринт 8 — Уведомления).
