# SPEC: Групповые (bulk) действия с пользователями на /admin?tab=users

## 1. Цель

На странице админки `/admin?tab=users` (`src/pages/AdminPage.jsx`, рендер `renderUsers()`) добавить возможность выделять нескольких пользователей и выполнять над ними групповые операции:

- смена роли (bulk change role),
- бан / разбан (bulk ban / unban),
- удаление (bulk delete, soft-delete с опцией удаления контента),
- «выбрать всех на странице» (select all on current page).

Групповые эндпоинты на сервере должны принимать список пользователей, проверять на сервере разрешения и уровень доступа (ранг роли) актора по каждой цели, и возвращать детализированный результат. После действия список пользователей на странице должен корректно перерендериться с новыми ролями/статусами. Чекбокс у строки показывается только для тех пользователей, над которыми текущий актор реально может совершить хотя бы одну групповую операцию (с учётом его прав и роли цели).

## 2. Область изменений (scope / out of scope)

### В scope
- Фронтенд: чекбоксы строк, мастер-чекбокс «все на странице», панель массовых действий, подтверждения, оптимистичные обновления, перерендер таблицы.
- API-клиент: новые bulk-функции в `src/api/admin.js`.
- Бэкенд: новые bulk-эндпоинты с серверными проверками прав и рангов.
- i18n: новые ключи в `src/i18n/dictionary.js` (en / ru).

### Вне scope
- Изменение гейта маршрута (`RequirePermission(auth.PermAdminAccess)` остаётся как у одиночных эндпоинтов: только root + admin). Модераторы с `BAN_USERS`/`DELETE_USERS` не могут достичь этих маршрутов — так же, как и сегодня у одиночных `/admin/users/{id}`.
- Недельный выбор «все пользователи всего форума» — только текущая страница (максимум 30 строк, см. `adminListMaxPerPage = 30`).
- Неограниченная параллельность: обработка списка целиком в одной транзакции/команде, по целям последовательно внутри команды.
## 3. Фронтенд — `src/pages/AdminPage.jsx`

### 3.1 Новое состояние

```text
selectedUserIds: Set<string>   — id выделенных пользователей (только текущая страница)
bulkAction: 'role' | 'ban' | 'unban' | 'delete' | null
bulkPending: boolean           — индикатор выполнения группы запросов
```

### 3.2 Чекбоксы строк и их видимость

Каждой строке таблицы добавляется колонка с чекбоксом в начале (перед аватаром/ником). Чекбокс **рендерится только если** текущий актор имеет право совершить хотя бы одну допустимую операцию над этим пользователем:

- бан, если `hasPermission(BAN_USERS)` и `u.status !== 'banned'` (иначе — разбан);
- разбан, если `hasPermission(BAN_USERS)` и `u.status === 'banned'`;
- удаление, если `hasPermission(DELETE_USERS)`;
- смена роли, если `canChangeRoleOf(u.role_id)` (существующая клиентская зеркальная проверка серверного `checkRoleChange`).

Если ни одно право не применимо к цели — ячейка чекбокса отсутствует (или скрыта), строка не попадает в выборку. Это зафиксировано как клиентское удобство; сервер всё равно перепроверяет каждую цель независимо.

**Защита от себя:** актор не может добавить себя в выделение для бан/разбан/удаления/смены роли own account. Серверные bulk-эндпоинты должны повторять это правило (см. §4.3).

### 3.3 Мастер-чекбокс «Выбрать все на странице»

В заголовке таблицы — чекбокс «Выбрать всех на странице». Выделяет только пользователей текущей страницы (отрендеренные строки, до 30 шт.), у которых чекбокс отображается (т.е. доступные для редактирования этим актором). Страницы за пределами текущей не затрагиваются. Состояние мастер-бокса: выбран / не выбран / неопределён (indeterminate) при частичном выборе.

### 3.4 Панель массовых действий

Когда `selectedUserIds` не пуст — над таблицей (или в тулбаре карточки пользователей) отображается панель:

- Количество выделенных: «Выбрано: N».
- Кнопки действий, показываемые только если у актора есть право на каждую из них:
  - «Сменить роль» — требует `CHANGE_ROLES`.
  - «Забанить» — требует `BAN_USERS` (применимо к выбранным со статусом `active`/`pending`).
  - «Разбанить» — требует `BAN_USERS` (применимо к выбранным со статусом `banned`).
  - «Удалить» — требует `DELETE_USERS`.
- Кнопка «Снять выделение».

Кнопка действия становится активной только если среди выделенных есть хотя бы одна цель, над которой эта операция допустима.

### 3.5 Массовая смена роли

Открывает существующую модалку роли (или обёртку над ней), предзаполненную из `userForm`. Доступные роли для выбора — `assignableRoles` (уже реализовано: без `root`; без `admin`, если актор не root). При сохранении:

- применить к каждому `id` из `selectedUserIds` выбранную роль,
- проверка `canChangeRoleOf` для каждой цели на клиенте перед отправкой (отсеять不可редактируемые),
- серверная проверка `checkRoleChange` + `requireKnownRole` на каждую цель (см. §4.3).

### 3.6 Массовый бан / разбан

Подтверждающая модалка с числом целей и перечником имён (сокращённо, если много). При подтверждении:

- бан: `status: 'banned'` для выбранных с `status !== 'banned'` (и актор не в списке),
- разбан: `status: 'active'` для выбранных со `status === 'banned'`.

Роль не меняется (существующее поведение single-User ban/unban оставляет роль нетронутой — см. комментарий в `banUser`/`unbanUser`).

### 3.7 Массовое удаление

Подтверждающая модалка: число целей, опция «Удалить все сообщения пользователя» (`delete_posts`, применяется ко всем выбранным), список имён (сокращённо). При подтверждении — soft-delete каждой цели (`is_deleted = true`, `status = 'deleted'`, поворот `tokenKey`, очистка email и т.д., как в `adminDeleteUserHandler`).

### 3.8 Оптимистичное обновление и рендеринг после действия

- При нажатии действия состояние таблицы обновляется оптимистично (статусы/роли строк меняются сразу), выделение сбрасывается.
- Запрос(ы) к серверу выполняются параллельно/последовательно; при ошибке откатить изменения для неудавшихся целей к `before`.
- По успеху: `refreshForumState(true)` (как у одиночных действий), очистка `selectedUserIds`, перерендер таблицы с новыеми бейджами ролей и статусами. Строки, над которыми актор потерял право редактировать, должны лишиться чекбокса при следующем рендере.
- Во время выполнения кнопки массовых действий блокируются (предотвратить повторный submit).

### 3.9 Обработка частичных ошибок

Бulk-эндпоинт возвращает результат по каждой цели (`ok/error`). Фронт должен:

- показать итоговый тост (успешно N из M),
- при частичном провале перечислить неудавшиеся цели (id/ник + причина) или показать сводный тост с кнопкой «Показать ошибки»,
- не_markировать ошибшуюся цель как успешно изменённую.

### 3.10 Новые i18n-ключи (`src/i18n/dictionary.js`, блок `users:`)

Фактические ключи (таблица обновлена в §9.5 — старый проект ниже был историческим):
en / ru см. `src/i18n/dictionary.js`, блоки en:602+ / ru:1472+.

| Код | en | ru |
|---|---|---|
| `table_select` | `Select` | `Выделение` |
| `bulk_selected` | `{count} selected` | `{count} выбрано` |
| `bulk_select_all` | `Select all on this page` | `Выбрать все на странице` |
| `bulk_clear` | `Clear selection` | `Снять выделение` |
| `bulk_change_role` | `Change role` | `Сменить роль` |
| `bulk_ban` | `Ban` | `Забанить` |
| `bulk_unban` | `Unban` | `Разбанить` |
| `bulk_delete` | `Delete` | `Удалить` |
| `bulk_modal_title_role` | `Change role for {count} users` | `Сменить роль у {count} пользователей` |
| `bulk_modal_title_ban` | `Ban {count} users` | `Забанить {count} пользователей` |
| `bulk_modal_title_unban` | `Unban {count} users` | `Разбанить {count} пользователей` |
| `bulk_modal_title_delete` | `Delete {count} users` | `Удалить {count} пользователей` |
| `bulk_modal_users_label` | `Selected users` | `Выбрано пользователей` |
| `bulk_modal_remove_user` | `Remove from selection` | `Убрать из выделения` |
| `bulk_modal_none_left` | `Nobody left selected` | `Никто не остался выбран` |
| `bulk_modal_role_label` | `New role` | `Новая роль` |
| `bulk_modal_delete_posts` | `Also delete all their content` | `Также удалить всё их содержимое` |
| `bulk_modal_delete_warning` | `Their topics and posts will be removed too` | `Их темы и сообщения также будут удалены` |
| `bulk_modal_too_many` | `Selected {count} users — a single request handles at most 100. Please deselect some.` | `Выбрано {count} пользователей — за один запрос обрабатывается не более 100. Снимите часть выделения.` |
| `bulk_do` | `Confirm` | `Подтвердить` |
| `toast_bulk_done` | `Applied to {count} users` | `Применено к {count} пользователям` |
| `toast_bulk_partial` | `Done for {succeeded} users, {failed} failed` | `{succeeded} успешно, {failed} с ошибками` |
| `error_bulk` | `Bulk action failed` | `Ошибка массового действия` |

Исторический проект ключей (не заводился в словарь, оставлен для истории):

| Код | en | ru |
|---|---|---|
| `bulk_column_header` | `Select` | `Выбор` |
| `bulk_select_all` | `Select all on page` | `Выбрать все на странице` |
| `bulk_select_none` | `Select none` | `Снять всё` |
| `bulk_selected` | `Selected: {n}` | `Выбрано: {n}` |
| `bulk_action_role` | `Change role` | `Сменить роль` |
| `bulk_action_ban` | `Ban` | `Забанить` |
| `bulk_action_unban` | `Unban` | `Разбанить` |
| `bulk_action_delete` | `Delete` | `Удалить` |
| `confirm_bulk_ban_title` | `Confirm bulk ban` | `Подтверждение группового бана` |
| `confirm_bulk_ban_message` | `Ban {n} users? They will lose all access.` | `Забанить {n} пользователей? Они потеряют доступ к форуму.` |
| `confirm_bulk_delete_title` | `Confirm bulk delete` | `Подтверждение группового удаления` |
| `confirm_bulk_delete_message` | `Delete {n} accounts? Cannot be undone.` | `Удалить {n} аккаунтов? Это невозможно отменить.` |
| `toast_bulk_done` | `{ok} of {n} updated` | `{ok} из {n} обновлено` |
| `toast_bulk_partial` | `{ok} of {n} updated, {fail} failed` | `{ok} из {n} обновлено, {fail} ошибок` |
| `error_bulk_self` | `You cannot act on your own account` | `Нельзя выполнить действие над своим аккаунтом` |
| `error_bulk_forbidden` | `Not allowed to act on one or more selected users` | `Нет прав на действие над одним или несколькими выбранными пользователями` |
| Код | en | ru |
|---|---|---|
| `bulk_column_header` | `Select` | `Выбор` |
| `bulk_select_all` | `Select all on page` | `Выбрать все на странице` |
| `bulk_select_none` | `Select none` | `Снять всё` |
| `bulk_selected` | `Selected: {n}` | `Выбрано: {n}` |
| `bulk_action_role` | `Change role` | `Сменить роль` |
| `bulk_action_ban` | `Ban` | `Забанить` |
| `bulk_action_unban` | `Unban` | `Разбанить` |
| `bulk_action_delete` | `Delete` | `Удалить` |
| `confirm_bulk_ban_title` | `Confirm bulk ban` | `Подтверждение группового бана` |
| `confirm_bulk_ban_message` | `Ban {n} users? They will lose all access.` | `Забанить {n} пользователей? Они потеряют доступ к форуму.` |
| `confirm_bulk_delete_title` | `Confirm bulk delete` | `Подтверждение группового удаления` |
| `confirm_bulk_delete_message` | `Delete {n} accounts? Cannot be undone.` | `Удалить {n} аккаунтов? Это невозможно отменить.` |
| `toast_bulk_done` | `{ok} of {n} updated` | `{ok} из {n} обновлено` |
| `toast_bulk_partial` | `{ok} of {n} updated, {fail} failed` | `{ok} из {n} обновлено, {fail} ошибок` |
| `error_bulk_self` | `You cannot act on your own account` | `Нельзя выполнить действие над своим аккаунтом` |
| `error_bulk_forbidden` | `Not allowed to act on one or more selected users` | `Нет прав на действие над одним или несколькими выбранными пользователями` |

## 4. Бэкенд — эндпоинты (`backend/internal/platform/pocketbase/admin_users.go`)

### 4.1 Новые маршруты (в `registerRoutes`, `run.go`)

- `PATCH /api/aerun/admin/users/bulk` — смена роли и/или статуса для списка пользователей.
- `DELETE /api/aerun/admin/users/bulk` — grupovoe soft-удаление.

Оба маршрута: `BindFunc(RequirePermission(auth.PermAdminAccess))` + `BindFunc(enforceIdempotency)` (как одиночные `PATCH/DELETE /admin/users/{id}`).

### 4.2 Тела запросов

**PATCH bulk:**
```json
{
  "ids": ["uid1", "uid2", "..."],
  "role": "moderator",        // опционально
  "status": "banned",         // опционально
  "notify_role_change": true  // опционально, absent = true
}
```
Хотя бы одно из `role` / `status` обязательно. `ids` — непустой массив, разумный лимит (например, не более 100 id на запрос, чтобы не блокировать транзакцию надолго).

**DELETE bulk:**
```json
{
  "ids": ["uid1", "uid2", "..."],
  "delete_posts": false       // опционально
}
```

### 4.3 Серверные проверки (разрешения + уровень доступа)

На каждую цель внутри транзакции/команды выполняются проверки **независимо** (не доверяем клиентскому списку чекбоксов):

1. Актор аутентифицирован и имеет `admin_access` (маршрутный гейт — уже есть).
2. Цель существует и не soft-deleted уже (`isUserDeleted` → 409 conflict).
3. Актор не является целью сам (запрет самобана/самоудаления/смены своей роли через bulk) — 403.
4. Если в теле `role`:
   - у актора есть `PermChangeRoles`,
   - `requireKnownRole(newRole)`,
   - `checkRoleChange(actorRole, targetRole, newRole)` — root может любую (кроме записи `root` напрямую), admin — только строго ниже по рангу, иначе — 403.
5. Если в теле `status === 'banned'`: у актора есть `PermBanUsers`.
6. Если в теле `status === 'active'` (разбан): у актора есть `PermBanUsers`.
7. Если метод `DELETE`: у актора есть `PermDeleteUsers`.

Проверки 4–7 применяются **по целям**: цель, по которой проверка не пройдена, помечается ошибкой в ответе, но не отменяет всю команду (частичный успех допустим). Коды ошибок machine-readable (`forbidden`, `not_found`, `already_deleted`, `self_action`, `invalid_role`, `invalid_status`).

### 4.4 Формат ответа

```json
{
  "processed": 5,
  "succeeded": 4,
  "failed": 1,
  "items": [
    { "id": "uid1", "ok": true, "role": "moderator", "status": "active" },
    { "id": "uid2", "ok": false, "error": "forbidden", "code": "insufficient_rank" }
  ],
  "request_id": "..."
}
```
HTTP 200 при любом исходе (включая部分ные ошибки); 400 — при невалидном теле (отсутствует `ids`, пустой массив, неизвестный статус/роль); 403 — если актор вообще не имеет прав на запрошенный тип операции.

### 4.5 Аудит и уведомления

- Каждое успешное изменение роли/статуса/удаление пишется в аудит (`admin_user_update`, `admin_user_delete`) с `target_id` и acted-by.
- При смене роли — уведомление цели (`role_change`), как у одиночного `PATCH`.
- Рекомендуется одна bulk-запись в аудит + записи по целям, либо только по целям — оставить на усмотрение реализации, но не терять аудит追적.

## 5. Модель доступа и защита (summary)

| Сущность | Клиентская проверка | Серверная проверка |
|---|---|---|
| Видимость чекбокса строки | `canBulkEditUser(u)` — зеркало §4.3 | не требуется (визуальное) |
| Мастер-чекбокс «все на странице» | только доступные строки текущей страницы | не требуется |
| Смена роли | `canChangeRoleOf` + `assignableRoles` | `PermChangeRoles` + `checkRoleChange` + `requireKnownRole` |
| Бан / разбан | `PermBanUsers` | `PermBanUsers` на каждую цель |
| Удаление | `PermDeleteUsers` | `PermDeleteUsers` на каждую цель |
| Самонацеливание | исключить себя из выделения | 403 если `id == actor.id` |

## 6. Файлы для изменения (список, без кода)

- `markdowns/SPEC_BULK_USER_MANAGEMENT.md` — этот документ.
- `src/pages/AdminPage.jsx` — чекбоксы, мастер-бокс, панель действий, обработчики bulk, оптимистичные обновления, перерендер.
- `src/api/admin.js` — новые функции `bulkUpdateUsers(ids, {role, status, notify_role_change})` и `bulkDeleteUsers(ids, {delete_posts})`.
- `backend/internal/platform/pocketbase/admin_users.go` — хендлеры `adminBulkUpdateUsersHandler`, `adminBulkDeleteUsersHandler` с заходом в транзакцию и проверками §4.3.
- `backend/internal/platform/pocketbase/run.go` — регистрация маршрутов `PATCH/DELETE /admin/users/bulk`.
- `src/i18n/dictionary.js` — ключи §3.10 (en / ru).
- Тесты: бэкенд (частичный успех, запрет ранга, самонацеливание, несуществующая цель), фронтенд (видимость чекбоксов, мастер-бокс, откат при ошибке).

## 7. Чек-лист приёма

- [ ] На `/admin?tab=users` у строк появились чекбоксы только для редактируемых актором пользователей; у защищённых/равноправных/чужого ранга — отсутствуют.
- [ ] Мастер-чекбокс выделяет только доступные строки текущей страницы.
- [ ] Массовая смена роли, бан, разбан, удаление применяются ко всем выделенным; таблица перерендеривается с новыми ролями/статусами без перезагрузки страницы.
- [ ] Сервер отклоняет каждую недоступную цель с 403/409, но продолжает обработку остальных; ответ содержит `items` с `ok/error` по целям.
- [ ] Актор не может через bulk забанить/удалить/перевести себя.
- [ ] При частичной ошибке фронт откатывает неудавшиеся строки и показывает сводную ошибку.
- [ ] Аудит и уведомления пишутся для каждой успешной цели.

## 8. Реализация: тонкости и отклонения от спецификации

### 8.1 Подтверждение через модалку, а не инлайн-бар

Вместо инлайн-тулбара с немедленным выполнением actions (`bulkConfirmLabel`, `handleBulkExecute`) реализована полноценная модалка подтверждения (`ForumModal`), зеркальная одиночному действию:

- При клике на «Сменить роль» / «Забанить» / «Разбанить» / «Удалить» открывается модалка с заголовком «Change role for N users» (и analogs для ban/unban/delete).
- Тело модалки — блок **SELECTED USERS** с аватаркой, ником и крестиком `×` у каждого выбранного. Крестик убирает пользователя и из модалки, и из постоянного выделения (строка таблицы разъединяется).
- Блок **NEW ROLE** (только для actions `role`) повторяет одиночную модалку смену роли один в один: карточки ролей в колонку (`flex-column gap-1`, `p-2`, `mb-1`), радиокнопки, выбранная роль подсвечивается. Ниже — чекбокс «Уведомить пользователя о смене роли» (`notify_role_change_label`), включён по умолчанию, флаг уходит в `bulkUpdateUsers` как `notify_role_change`.
- Для `delete` — чекбокс «Также удалить всё их содержимое» с предупреждением `text-danger` снизу.
- Кнопки «Cancel» / «Confirm» (`bulk_do`) в футере; Confirm блокируется пока не выбрана роль (для action `role`).

### 8.2 Выделение сохраняется сквозь пагинацию

Исходная спецификация предполагала сброс `selectedUserIds` при перезагрузке списка (`useEffect(() => setSelectedUserIds(new Set()), [users])`). В реализации этот эффект убран: выделение ключится по `id` пользователя и остаётся при переключении страниц staff-листа и возврате на предыдущую. Это позволяет выбирать пользователей на нескольких страницах и выполнять над ними одну групповую операцию.

### 8.3 Мастер-чекбокс и состояние

Мастер-чекбокс в заголовке таблицы поддерживает три состояния: выбран / не выбран / indeterminate (частичный выбор). Выделяет только доступные для редактирования строки текущей страницы (те, у которых отображается чекбокс строки).

### 8.4 Бэкенд: транзакция и idempotency

Оба эндоинта (`PATCH`/`DELETE /api/aerun/admin/users/bulk`) обёрнуты в `runCommand` — одна транзакция, цели обрабатываются последовательно внутри команды. Каждый хендлер гейтится `RequirePermission(auth.PermAdminAccess)` + `enforceIdempotency` (как одиночные `/admin/users/{id}`: только root + admin). Тело ограничивается `adminBulkBodyBytes = 64 KB`.

### 8.5 Коды ошибок по целям

Машинночитаемые коды в `items[*].code`: `not_found`, `already_deleted`, `self_action`, `forbidden`. HTTP 200 при любом исходе (включая частичные ошибки); 400 — невалидное тело (отсутствует `ids`, пустой массив, неизвестный статус/роль); 403 — актор не имеет прав на запрошенный тип операции вообще. Отказ по одной цели не отменяет остальные (частичный успех допустим).

### 8.6 Аудит и уведомления

Одиночные операции пишут `recordAuditLog` (`admin_user_update` / `admin_user_delete`) с `target_nickname` и прежними значениями рядом с новыми (`old_role` / `old_status`). Bulk-команда пишет РОВНО ОДНО сводное событие `admin_users_bulk_update` / `admin_users_bulk_delete` с действием админа и полным перечнем обработанных целей `{id, nickname, ok, old_role, old_status, code}` — построчных событий по целям нет, иначе операция рассыпается на N фрагментов плюс сводку (§9.7). При смене роли дополнительно создаётся уведомление цели типа `role_change` (как у одиночного `PATCH`).

### 8.7 Файлы изменений

- `markdowns/SPEC_BULK_USER_MANAGEMENT.md` — этот документ.
- `src/pages/AdminPage.jsx` — состояние bulk, чекбоксы строк, мастер-бокс, модалка подтверждения со списком никнеймов и удалением из выделения, оптимистичные обновления с откатом.
- `src/api/admin.js` — `bulkUpdateUsers`, `bulkDeleteUsers`.
- `backend/internal/platform/pocketbase/admin_users.go` — `adminBulkUpdateUsersHandler`, `adminBulkDeleteUsersHandler`, формы `adminBulkUpdateForm`/`adminBulkDeleteForm`, тип `bulkItem`.
- `backend/internal/platform/pocketbase/run.go` — маршруты `PATCH/DELETE /admin/users/bulk`.
- `backend/internal/platform/pocketbase/commands_test.go` — `TestAdminBulkAccessMatrix`, `TestAdminBulkUpdatePartialSuccess`, `TestAdminBulkRoleChange`, `TestAdminBulkDelete`.
- `src/i18n/dictionary.js` — ключи `admin.users.bulk_*` (en / ru).


## 9. Верификация реализации (аудит агента, 2026-11-02)

Отдельный проход по спеке и коду: сверка §3–§8 с фактической реализацией, поиск дыр
и неучтённых сценариев. Часть находок исправлена сразу (см. §9.2), часть оставлена
как осознанный статус или вынесена на решение владельца (см. §9.3).

### 9.1 Что проверено и подтверждено (работает как задумано)

| Область | Подтверждение |
|---|---|
| Маршруты и гейты | `run.go:328–329`: `PATCH/DELETE /admin/users/bulk` гейтятся `RequirePermission(auth.PermAdminAccess)` + `enforceIdempotency`, как одиночные `/admin/users/{id}` (§4.1). `enforceIdempotency` буферизует тело и резолвит `claim.Actor = e.Auth.Id`. |
| Самопроверка на сервере | `claim.Actor` — это `e.Auth.Id`, т.е. `id == claim.Actor` в bulk-хендлерах корректно ловит самонацеливание (§4.3 п.3). |
| Проверки по целям | `not_found`, `already_deleted`, `self_action`, `forbidden` (`checkRoleChange` — ранги, запрет записи `root`, запрет назначения admin не-root'ом). Частичный успех, HTTP 200 (§4.3–4.4). |
| Удаление | Мягкое удаление повторяет single-хендлер: `is_deleted`, `status=deleted`, release `nickname_normalized`/`email`, `RefreshTokenKey()` (смерть сессий), `markUserDMErasesForever`, аудит с `delete_posts`. |
| Аудит и уведомления | Одиночные: `admin_user_update`/`admin_user_delete` с `target_nickname` и `old_role`/`old_status`. Bulk: РОВНО ОДНО сводное событие `admin_users_bulk_update`/`admin_users_bulk_delete` на команду — без построчных событий по целям (§9.7); уведомление `role_change` только при фактической смене роли и с флагом (§4.5). |
| Клиентское зеркало | `canBulkEditUser` исключает себя; чекбокс только при BAN_USERS/DELETE_USERS/canChangeRoleOf; `canChangeRoleOf`/`assignableRoles` зеркалят `checkRoleChange`. |
| i18n | Все используемые ключи `admin.users.bulk_*` существуют в en и ru; `t(key, 'строка')` корректно трактуется как fallback в `I18nProvider`. |
| Тесты | `go test ./internal/platform/pocketbase/ -run TestAdminBulk` — ok (AccessMatrix, UpdatePartialSuccess, RoleChange, Delete); `go vet` — ok; `npx eslint src/pages/AdminPage.jsx` — ok; `npx vite build` — ok. |

### 9.2 Находки, исправленные в ходе аудита

| № | Серьёзность | Где | Проблема | Исправление |
|---|---|---|---|---|
| 1 | критично | `AdminPage.jsx` `handleRemoveFromBulkSelection` | Инвертированная логика: в `bulkModalExcluded` выполнялся `next.delete(id)` вместо `next.add(id)` — набор исключений никогда не наполнялся (маскировалось тем, что id параллельно удалялся из `selectedUserIds`). | `next.add(id)`; набор исключений снова осмыслен; попутно снимок синхронизируется. |
| 2 | критично | `AdminPage.jsx` модалка bulk | Межстраничное выделение (§8.2) было «слепым»: чипы искались через `users.find` (только текущая страница) → выбранные на других страницах пользователи НЕ отображались и не могли быть исключены из подтверждения; заголовок считал только `bulkSelected` (текущая страница) → «Забанить 2 пользователей» при реально затрагиваемых N>2; `bulkAnyBanned`/`defaultBulkRoleId` тоже были странично-локальны. | Введён снимок выделения `bulkSelectionSnap` (id → `{id, nickname, avatar_url, role_id, status}`), обновляемый в `toggleBulkUser`/`toggleBulkAll`/`handleRemoveFromBulkSelection` и сбрасываемый по успеху. Чипы модалки, счётчик заголовка (`effectiveBulkIds.length`), `bulkAnyBanned` и `defaultBulkRoleId` читают снимок (с fallback на текущую страницу). |
| 3 | критично | `AdminPage.jsx` мастер-чекбокс | `indeterminate={bulkAny && !bulkAll}` — no-op: React не мапит проп `indeterminate` на DOM-свойство (в react-dom 19 это имя отсутствует; атрибут не отражается). Промежуточное состояние не отображалось никогда. | Состояние выставляется через ref-callback: `el.indeterminate = bulkAny && !bulkAll`. |
| 4 | средне | `admin_users.go` оба bulk-хендлера | Не было верхнего лимита `len(ids)`: §4.2 обещал «не более 100», но 64 KB тело допускало ~1700 id — одна транзакция (особенно с `delete_posts` + `purgeUserContent`) растягивалась на всю таблицу. | Константа `adminBulkMaxIDs = 100`; `bulkIDsFromForm` → 400 «too many ids: at most 100 per request». |
| 5 | средне | `admin_users.go` | Дубликаты id в `ids`: двойной `Save`, двойная запись аудита, задвоение в `processed`/`succeeded`; в delete-проходе второй встреченный дубль читался как `already_deleted` — фантомная ошибка в `items`. | `dedupeIDs` (сохранение первого порядка) внутри `bulkIDsFromForm`; пустой после дедупликации список → 400. |
| 6 | низко | `AdminPage.jsx` `handleBulkConfirm` | `setSelectedUserIds(new Set())` был в `finally` — выделение стиралось даже при полном провале запроса (500/сеть), админу пришлось бы заново расставлять галочки. | Очистка выделения и снимка перенесена в успешную ветку (полный или частичный успех); при исключении выбор сохраняется для повторной попытки. |
| 7 | низко | `AdminPage.jsx` откат | При частичном провале delete строки возвращались в конец массива `[...next, ...restored]`, теряя исходный порядок таблицы. | Восстановление по исходным индексам из `before` (`splice(Math.min(idx, out.length), 0, u)`). |
| 8 | низко | `admin_users.go` комментарий | Комментарий формы утверждал «Exactly one of Role / Status must be present», тогда как код (и §4.2) допускает оба сразу — валидный сценарий «переролить список и тут же забанить одним проходом». | Комментарий приведён в соответствие с фактическим контрактом. |



### 9.3 Находки, оставленные без правок (осознанный статус / нужно решение владельца)

- **A — РЕАЛИЗОВАНО во второй волне, см. §9.5.** (была: главная дыра модели доступа.) Бан/разбан и удаление НЕ имеют ранговой проверки цели — ни в bulk, ни в одиночных эндпоинтах. Админ может забанить/удалить другого админа, и даже root: понизить root нельзя (`checkRoleChange`), но забанить — можно; разбанить его сможет другой админ, а единственный root может оказаться «за бортом» без возможности вернуться самостоятельно. Это сознательное упрощение §3.2/§5 (чекбоксы ban/delete завязаны только на право актора), но противоречит формулировке §1 «с учётом ранга роли цели». Рекомендация: серверный guard «цель строго ниже актора по рангу; root иммунен» для `status`-изменений и `DELETE` — единым решением для single и bulk (менять только bulk значило бы плодить расхождение).
- **B — РЕАЛИЗОВАНО во второй волне, см. §9.5.** Одиночный `PATCH /admin/users/{id}` не имеет self-check: через него админ может банить сам себя (bulk защищён, single — нет). Рекомендация: тот же per-target `self_action` в single-хендлере.
- **C.** Снимок выделения может устареть (ник/роль/статус изменены другим админом, пока галочки «висят» между страницами или табами); выделение не сбрасывается при переключении табов. Сервер перепроверяет каждую цель, так что это только косметика чипов — приемлемо.
- **D — РЕАЛИЗОВАНО во второй волне, см. §9.5.** Если админ наберет >100 целей через несколько страниц, сервер вернёт 400 и весь optimistic-состояние откатится; фронт не предупреждает заранее. Возможное улучшение: клиентский счётчик-подсказка у панели действий.
- **E — РЕАЛИЗОВАНО во второй волне, см. §9.5 (таблица §3.10 обновлена).** Таблица §3.10 историческая: фактические имена ключей отличаются (`bulk_clear` вместо `bulk_select_none`; `bulk_modal_title_*` вместо `confirm_bulk_*`; `toast_bulk_done` с `{count}`; `error_bulk` вместо `error_bulk_self`/`error_bulk_forbidden`). Актуальный набор — `src/i18n/dictionary.js` (блоки en:602+, ru:1472+). Старые имена ключей в словаре не заводились.
- **F — РЕАЛИЗОВАНО во второй волне, см. §9.5.** Чипы в модалке используют `bg-white` — в тёмной теме будут выглядеть как светлые вставки. Тот же паттерн уже используется в `RichEditor.jsx` и карточке аудита, поэтому оставлено для единообразия; при появлении дизайн-токена для поверхностей — заменить.
- **G.** §3.9 требовала перечисление неудачных целей; реализация показывает сводный тост с числами (`toast_bulk_partial`) — допустимый по тексту спеки вариант («или показать сводный тост»). При желании можно добавить раскрытие списка `items[*].code`.

### 9.4 Файлы изменений (этап верификации)

- `src/pages/AdminPage.jsx` — находки 1–3, 6–7: снимок выделения, корректный excluded-набор, indeterminate через ref, очистка выделения только при прошедшем запросе, восстановление порядка строк при откате.
- `backend/internal/platform/pocketbase/admin_users.go` — находки 4, 5, 8: `adminBulkMaxIDs`, `dedupeIDs`/`bulkIDsFromForm`, выверенный комментарий формы.
- `markdowns/SPEC_BULK_USER_MANAGEMENT.md` — этот раздел §9.



## 9.5 Вторая волна доработок (2026-11-02, по решению владельца)

Решения владельца по пунктам §9.3 и их реализация.

### A. Ранговый guard для бан/разбан/удаление — РЕАЛИЗОВАНО

Новый серверный helper `checkUserTargetAuthority(txApp, actorRole, targetRole)` в `admin_users.go`:

- цель должна быть рангом **СТРОГО ниже** актора — админ не может забанить/удалить равного админа. Сознательно строже общей staff-матрицы `staff_authority.go` (та разрешает равных для переименования/правки): бан и удаление — необратимые враждебные действия;
- **root как цель неприкосновенен ни для кого** — `the chief admin account cannot be banned, unbanned or deleted`: ни для админа, ни для самого root'а. Роль root передаётся только через transfer-процедуру;
- неразрешимый ранг актора (deny-by-default `rankFor`) — отказ.

Применён в четырёх местах:

| Место | Поведение при отказе |
|---|---|
| bulk PATCH (статус) | per-item `forbidden`, остальные цели продолжаются |
| bulk DELETE | per-item `forbidden`, остальные цели продолжаются |
| single `PATCH /admin/users/{id}` | 403 на весь запрос |
| single `DELETE /admin/users/{id}` | 403 на весь запрос |

Клиентское зеркало для ранга бан/удаления НЕ добавлялось: ранги приходят из публичного реестра ролей, а чекбокс строки может «промахнуться», если ранги изменились, пока открыта вкладка. Серверная проверка — авторитетная; фронт показывает per-item отказ в частичном тосте (тот же подход, что §3.2 фиксирует для остальных случаев).

### B. Self-check в single-эндпоинтах — РЕАЛИЗОВАНО

Пояснение исходной находки: bulk-эндпоинты проверяли `id == claim.Actor` (нельзя действовать на свой аккаунт), а одиночный `PATCH /admin/users/{id}` такой проверки не имел — через него админ мог забанить/разбанить самого себя, что bulk-панель не позволяла. Теперь одиночные эндпоинты защищены так же:

- `PATCH`: статус-изменение на себя → 403 «you cannot ban or unban your own account»;
- `DELETE`: удаление себя → 403 «you cannot delete your own account»;
- смена собственной роли была закрыта и раньше (`checkRoleChange`: ранг цели не строго ниже).

### C. Клиентское предупреждение о >100 целях — РЕАЛИЗОВАНО

- `adminBulkMaxIds = 100` в `AdminPage.jsx` зеркалит серверный `adminBulkMaxIDs`;
- при `effectiveBulkIds.length > 100` модалка подтверждения показывает красное предупреждение (`bulk_modal_too_many`, en/ru), кнопка Confirm заблокирована;
- при превышении сервер всё равно отвечает 400 и optimistic-состояние откатывается — двойная защита.

### D. Фикс `bg-white` чипов — РЕАЛИЗОВАНО

Чипы выбранных пользователей в модалке подтверждения теперь на нейтральной полупрозрачной поверхности `rgba(var(--bs-gray-rgb), 0.08)` вместо `bg-white` — корректно в светлой и тёмной темах. (Аналогичные `bg-white` в `RichEditor.jsx` и карточке аудита оставлены как есть — вне scope этой спеки.)

### E. Таблица §3.10 обновлена

Таблица i18n-ключей §3.10 приведена к фактическому набору из `src/i18n/dictionary.js` (включая новый `bulk_modal_too_many`); исторический проект ключей сохранён ниже под соответствующим заголовком.

### Тесты (вторая волна)

Новый файл `backend/internal/platform/pocketbase/admin_users_rank_test.go`:

- `TestAdminBulkRankGuard` — админ не может bulk-банить/удалять root (per-item `forbidden`, HTTP 200, `succeeded:0`), не может действовать на равного админа; root действует на модератора (строго ниже — разрешено, `succeeded:1`);
- `TestAdminUserTargetAuthority` — single PATCH/DELETE: админ не может банить/удалять root и самого себя; root не может банить/удалять себя (403).

### Файлы изменений (вторая волна)

- `backend/internal/platform/pocketbase/admin_users.go` — `checkUserTargetAuthority` + применение в bulk update/delete и single PATCH/DELETE.
- `backend/internal/platform/pocketbase/admin_users_rank_test.go` — новый файл тестов.
- `src/pages/AdminPage.jsx` — `adminBulkMaxIds`, предупреждение >100 в модалке, блокировка Confirm, фикс чипов.
- `src/i18n/dictionary.js` — ключ `bulk_modal_too_many` (en / ru).
- `markdowns/SPEC_BULK_USER_MANAGEMENT.md` — §3.10 (таблица ключей) и этот раздел §9.5.

## 9.6 Третья волна: предпросмотр объёма удаления (2026-11-02)

Диалоги удаления с включённой опцией «удалить всё их содержимое» теперь показывают,
СКОЛЬКО именно контента будет стёрто — столько тем и сообщений, сколько реально
принадлежит выбранным аккаунтам (то же множество строк, которое удаляет
`purgeUserContent`: темы с `author_id = цели` и сообщения с `author_id = цели`).

### Бэкенд: новый read-only эндпоинт

- `POST /api/aerun/admin/users/content-counts` — тело `{"ids": [...]}`, ответ
  `{ "items": [{ "id", "topics", "posts" }], "request_id" }`.
- Подсчёт живой, из БД (`CountRecords` по `author_id`), а не по денормализованным
  счётчикам `topics_count`/`posts_count` — те поддерживаются командами и могут
  дрейфовать, а решение об удалении должно опираться на фактические строки.
- Гейт: `RequirePermission(auth.PermAdminAccess)` (root + admin) — счётчики
  раскрывают объём авторства, поэтому маршрут не публичный. Read-only: без
  `runCommand` и без Idempotency-Key.
- Тело переиспользует контракт bulk: дедупликация `dedupeIDs` и лимит
  `adminBulkMaxIDs = 100` (`bulkIDsFromForm`), 400 на пустой список.

### Фронтенд: ленивый подсчёт в обоих диалогах

- **Одиночное удаление** (`ConfirmModal`, kind `delete-user`): в `confirmState`
  добавлено поле `uid`; когда админ ставит чекбокс «Delete all posts by this
  user», эффект запрашивает счётчики для этого аккаунта и показывает строку
  `delete_posts_count` («Это безвозвратно удалит N тем(ы) и M сообщени(й)...»).
  Пока идёт запрос — `delete_posts_counting` («Подсчёт тем и сообщений…»).
- **Bulk-удаление** (модалка подтверждения): при `bulkAction === 'delete'` и
  включённом `bulkDeletePosts` запрашиваются счётчики по ВСЕМУ выделению
  (`effectiveBulkIds`, включая строки с других страниц) и суммируются; вывод —
  `bulk_delete_posts_count` под красным предупреждением.
- Подсчёт ленивый и отменяемый: эффект с `alive`-флагом, повторный запрос только
  при смене ключа (`deleteCountUid` / `bulkCountKey` — join id'ов). Сброс — при
  снятии чекбокса и при закрытии модалки.

### i18n (новые ключи `admin.users`, en / ru)

| Код | en | ru |
|---|---|---|
| `delete_posts_counting` | `Counting topics and posts…` | `Подсчёт тем и сообщений…` |
| `delete_posts_count` | `This will permanently delete {topics} topic(s) and {posts} post(s) authored by this user.` | `Это безвозвратно удалит {topics} тем(ы) и {posts} сообщени(й) этого пользователя.` |
| `bulk_delete_posts_count` | `This will permanently delete {topics} topic(s) and {posts} post(s) across the selected users.` | `Это безвозвратно удалит {topics} тем(ы) и {posts} сообщени(й) выбранных пользователей.` |

Замечание о границах цифр: сообщения ДРУГИХ авторов внутри удаляемых тем тоже
погибают вместе с темой, но в превью не считаются — показывается авторский
контент, соответствующий формулировке подсказки («каждая тема и сообщение этого
пользователя»). Если владельцу нужен полный охват (с чужими сообщениями в темах
цели), счётчик расширяется отдельным запросом по `topic_id IN (...)`.

### Тесты

`backend/internal/platform/pocketbase/admin_users_content_counts_test.go` —
`TestAdminUsersContentCounts`: подсчёт фикстуры (1 тема, 1 сообщение у игрока,
нули у аккаунта без контента), 401 для гостя, 403 для игрока, 400 на пустой
`ids`.

### Файлы (третья волна)

- `backend/internal/platform/pocketbase/admin_users.go` — `adminUsersContentCountsHandler`.
- `backend/internal/platform/pocketbase/run.go` — маршрут `POST /admin/users/content-counts`.
- `src/api/admin.js` — `fetchUsersContentCounts`.
- `src/pages/AdminPage.jsx` — состояния превью, эффекты подсчёта, вывод в обоих диалогах.
- `src/i18n/dictionary.js` — три новых ключа (en / ru).
- `backend/internal/platform/pocketbase/admin_users_content_counts_test.go` — новый файл тестов.
- `markdowns/SPEC_BULK_USER_MANAGEMENT.md` — этот раздел §9.6.

## §9.7 Аудит: никнеймы целей и сводка массовых действий (четвёртая волна)

Требование владельца: при удалении, бане и смене роли события в аудит-логе
должны называть цели по никнеймам и показывать действие админа — без
реконструкции по id и без обращения к контексту.

### Per-target события (только одиночные операции)

`admin_user_update` / `admin_user_delete` одиночных хендлеров дополнены полями:

| Поле | Значение |
|---|---|
| `target_nickname` | никнейм цели на момент действия (для удалённых — «запечённый» никнейм, он не стирается при soft-delete) |
| `old_role` / `old_status` | значения ДО записи; рядом с `role`/`status` они отличают бан от разбана и показывают, с какой роли на какую переводили |

Никнейм снимается с записи ДО мутаций, так что содержимое события не зависит
от того, что мягкое удаление сохраняет отображаемый никнейм.

**Bulk-команда построчных событий НЕ пишет.** Первая версия этой волны
писала и per-target записи, и сводку — операция из 4 целей рассыпалась на
5 строк лога. Исправлено: одна bulk-команда = одна строка аудита.

### Сводное событие на bulk-команду (единственное событие операции)

Каждая bulk-команда пишет ОДНО событие целиком за операцию:

- `PATCH /admin/users/bulk` → `admin_users_bulk_update`:
  `{ role, status, notify_role_change, processed, succeeded, failed, targets }`;
- `DELETE /admin/users/bulk` → `admin_users_bulk_delete`:
  `{ delete_posts, processed, succeeded, failed, targets }`.

`targets` — полный перечень обработанных целей, по одной записи на каждую:
`{id, nickname, ok, old_role, old_status}` для успешных и обработанных
отказов (`old_role`/`old_status` — значения на момент загрузки записи) и
`{id, nickname, ok, code}` с кодом отказа (`self_action`, `forbidden`,
`already_deleted`); `{id, ok, code: "not_found"}` — без никнейма, аккаунт не
найден. Список покрывает ВСЕ переданные id, а не только успешные: попытка,
отклонённая целиком — ровно то, что ищет аудитор, поэтому сводка пишется
безусловно.

### i18n и отображение

`admin.audit.actions.admin_users_bulk_update` / `..._delete` в en и ru —
обязательны, `scripts/check-audit-action-labels.mjs` отвергает непереведённые
и осиротевшие метки. Новые ключи полей `admin.audit.fields.*`:
`target_nickname`, `old_role`, `old_status`, `role`, `notify_role_change`,
`delete_posts`, `targets`, `processed`, `succeeded`, `failed`. Вкладка аудита
рендерит `targets` как JSON — структура уже читаема.

### Тесты

`backend/internal/platform/pocketbase/admin_users_audit_test.go` —
`TestAdminUserAuditCarriesNicknames`: одиночный бан (никнейм + old/new
status), одиночное удаление с purge, bulk role change (ЕДИНСТВЕННАЯ сводка с
2 успехами и 1 отказом, прежние роль/статус в записях целей, ноль per-target
записей от bulk), bulk бан, bulk delete с purge (ноль per-target записей).

### Файлы (четвёртая волна)

- `backend/internal/platform/pocketbase/admin_users.go` — обогащённые одиночные записи; bulk-команда пишет единственную сводку.
- `src/i18n/dictionary.js` — 2 ключа actions + 10 ключей fields (en / ru).
- `backend/internal/platform/pocketbase/admin_users_audit_test.go` — новый файл тестов.
- `markdowns/SPEC_BULK_USER_MANAGEMENT.md` — этот раздел §9.7.


