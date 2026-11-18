# Спецификация: Реорганизация журнала аудита (Audit Log Reorganization)

> **Статус:** Спецификация к реализации  
> **Связанные документы:** [`SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md`](SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md) (Этапы 2–3: CP-2.4 `AuditDetailsModal`, CP-3.5 `AuditTab`, CP-4.1 `useAdminAudit`), [`TODO_THEMEABLE_SPRINT_PLAN.md`](TODO_THEMEABLE_SPRINT_PLAN.md) (Спринт H — темизация вкладки), [`DONE_ADMIN_PAGE_REORGANIZATION.md`](DONE_ADMIN_PAGE_REORGANIZATION.md) (отчёт о Этапе 1)  
> **Порядок:** сначала поведение по этому документу, потом декомпозиция вкладки (CP-3.5), потом темизация (Спринт H). Темизация не начинается, пока поведение не готово: нет смысла переводить в гриды таблицу, чей механизм загрузки будет переписан.

---

## 1. Проблема (как сейчас, сверено с кодом, HEAD `db2d8c4`)

### 1.1 Загрузка: полный перечит 200 записей каждые 15 секунд
`src/api/audit.js` — `subscribeToAuditLogs(200)` через `sharedPoll` с `intervalMs: 15000`: каждые 15 секунд заново запрашивается `/api/aerun/admin/audit-logs?limit=200` целиком. Вкладка Network показывает именно это: `audit-logs?limit=200` четыре раза за ~35 секунд. Обновления по сигналу нет: realtime мёртв (комментарий в `src/api/shared-poll.js` — PocketBase realtime никогда не доставляет события, свежесть всегда даёт интервал).

### 1.2 Серверная пагинация есть, но кнопка «Загрузить ещё» мёртвая
Сервер умеет всё нужное: `adminListAuditLogsHandler` (`backend/internal/platform/pocketbase/audit.go:75`) принимает `limit`, `cursor` (`created|id`, keyset), `performer_id`, `action_type` и отдаёт `next_cursor`. `getMoreAuditLogs` в `audit.js` курсор использует. Но:
- `subscribeToAuditLogs` отбрасывает `res.next_cursor` — маппит только `items`;
- `poll.subscribe` вызывает колбэк как `(value, error)` (см. `shared-poll.js:279`: `cb(value, error)`), а `AdminPage.jsx:961` принимает колбэк как `(data, lastDoc) => ...` — второй аргумент это ошибка, а не курсор;
- в итоге `lastAuditDoc` всегда `undefined`, а `handleLoadMoreAudit` первым делом делает `if (!lastAuditDoc || !hasMoreAudit) return`.

Кнопка «Загрузить ещё» при этом показана (`hasMoreAudit` ставится из `data.length >= 200`) — и никогда не срабатывает. Дальше первых 200 логов уйти нельзя.

### 1.3 Фильтры — клиентские
Поиск и фильтр по действию гоняются по загруженному массиву (`renderAuditLog`, `filtered`). Список типов действий в фильтре строится из загруженных данных (`allActions` из `auditLogs.map(l => l.action_type)`) — типов, которых нет в первых 200, в фильтре просто нет. Серверные параметры `action_type` / `performer_id` клиентом не используются.

### 1.4 Модалка деталей — сырой дамп
`AdminPage.jsx:3798–3885` рендерит `Object.entries(details)`: i18n-подпись поля (`admin.audit.fields.*`), разрешение ников по id (список `users` + `auditNicknameIndex`) и спец-рендер `changes` (from → to). На живых примерах это даёт:
- пустые поля рендерятся пустыми строками (Guest Name — пустое, хотя автор — аккаунт, а не гость);
- `created` — сырая ISO-строка (`2026-11-12 03:26:38.564Z`);
- id — голые строки без структуры (post_id, topic_id, author_id рядом, без связи);
- нет категории, к которой принадлежит тема.

### 1.5 В лог попадает не то
- `character_updated` / `character_avatar_changed` (`backend/internal/platform/pocketbase/characters.go:534, 687`) пишутся и для собственных масок (`performer == owner`). Собственная маска — самообслуживание, а не модерация.
- В тех же записях нет «что именно изменилось»: только `name` / `owner_id` / `target_id`, без `changes`.
- `post_delete` при массовой чистке пользователя (`backend/internal/platform/pocketbase/admin_user_delete_votes.go:44`) пишется с performer = удаляемый автор, а не админ, который чистит: функция `purgeSinglePostForUserDeletion(txApp, post)` вообще не получает id действующего админа. (Одиночное удаление — `forum_posts.go:986` — корректно: performer = `e.Auth.Id`, `by_author` — флаг.)

---

## 2. Цели
1. Одна страница за раз (limit 50), курсорная догрузка работает; «Загрузить ещё» — не мёртвая кнопка.
2. Нет 15-секундного полного перечитывания 200 записей: обновление по событиям, которые панель знает; поллинг — только запасной вариант, с длинным интервалом и только пока вкладка открыта и видима.
3. Фильтры — серверные (`action_type`, `performer_id`); список типов действий в фильтре — фиксированный реестр, а не «что попалось в первые 200».
4. Модалка деталей — структурированная по типу действия (§3); пустые поля не рендерятся; даты форматируются; id всегда в паре с ником.
5. В лог попадает только модерация чужих масок (§4).

---

## 3. Структурированные детали по типам действий

Общие правила для всех записей:
- Шапка модалки единая: кто сделал (ник + id в одном значении), действие, когда сделано (формат через `Timestamp`, не сырая строка). Log ID — внизу мелким, как сейчас.
- Пустое значение не рендерится вообще: ни строки, ни подписи. Поле показывается только когда в нём есть что показать.
- Id без resolved-ника не показывается голым: либо пара «ник + id», либо только ник (если id не резолвится — значит, аккаунт удалён, и это тоже стоит показать как «удалённый аккаунт»).
- Новые подписи — через i18n (`admin.audit.details.*`, EN + RU), как остальные подписи модалки.
- Неизвестный тип действия рендерит текущий сырой дамп (fallback, чтобы новые типы не терялись) + TODO в коде на шаблон.

### 3.1 `post_delete` (одиночное удаление, `forum_posts.go:986`)
Поля сейчас: `post_id`, `topic_id`, `topic_title`, `author_id`, `author_kind`, `guest_display_name`, `created`, `by_author`, `content`.

Целевой набор:
- **Чей пост:** ник + id автора; для гостя — `guest_display_name`, и только тогда. Поле гостевого имени для аккаунтов не показывается вообще.
- **Когда пост создан:** форматированная дата, не сырая строка.
- **Контент:** как сейчас (лог — surviving record удалённого поста, текст обязателен).
- **Тема:** тайтл + id.
- **Категория:** тайтл + id — добавить. Резолвить через `topic.category_id` (один дополнительный read в том же хендлере; тема там уже загружена).
- **Кто удалил и как:** перформер (ник + id, уже есть), флаг `by_author` — «удалён автором» / «удалён модератором».
- **Когда удалено:** форматированная дата действия.

### 3.2 `character_updated` / `character_avatar_changed` (маски, `characters.go:534, 687`)
Целевой набор:
- **Перформер:** ник + id.
- **Целевой юзер:** ник + id владельца маски.
- **Какая маска:** имя + id.
- **Что изменилось:** для `character_updated` — объект `changes` (from → to; рендер уже есть в модалке). Для `character_avatar_changed` — явное значение «аватар обновлён», а не пустой diff.
- Правило §4: свои маски не логируются.

### 3.3 Остальные типы — реестр
Всего типов 39 (по вызовам `recordAuditLog` в бэкенде). Шаблоны — по группам; внутри группы один набор полей:

| Группа | Типы | Целевой набор |
|---|---|---|
| Личность | `password_change`, `email_change`, `provider_unlink`, `nickname_change`, `profile_edit` | Перформер (ник + id), что изменилось (`changes` from → to, где есть) |
| Контент | `post_edit`, `topic_delete`, `topic_title_edit`, `topic_description_edit`, `topic_lock`, `topic_pin`, `topic_move`, `posts_move`, `dm_message_delete`, `reputation_edited`, `reputation_deleted` | Перформер, цель (пост/тема/сообщение: тайтл или начало контента + id), категория/тема где применимо, что изменилось |
| Структура | `role_created`, `role_updated`, `role_deleted`, `category_created`, `category_updated`, `category_deleted`, `category_group_created`, `category_group_updated`, `category_group_deleted`, `design_created`, `design_updated`, `design_deleted`, `settings_updated`, `email_template_updated`, `email_template_test_sent` | Перформер, цель (имя + id), что изменилось (`changes` для updated) |
| Пользователи | `admin_user_update`, `admin_user_delete`, `admin_users_bulk_update`, `admin_users_bulk_delete`, `root_transfer` | Перформер (действующий админ), целевой юзер (ник + id), что изменилось |
| Маски | `character_created`, `character_updated`, `character_deleted`, `character_avatar_changed` | См. §3.2 + §4 |

Фильтр по действию в таблице — из этого реестра (группированный список), а не из загруженных данных.

---

## 4. Правило «только модерация чужих масок»
- `character_updated` (`characters.go:534`) и `character_avatar_changed` (`characters.go:687`): писать строку только когда `e.Auth.Id != rec.GetString("owner_id")`. Свои правки — обычное самообслуживание, не событие аудита.
- На `post_delete` правило НЕ распространяется: собственные удаления логируются намеренно (комментарий в `forum_posts.go`: «EVERY delete is logged... precisely the traffic worth watching»).
- `character_created` / `character_deleted`: тот же принцип предлагается, но решение — при реализации (в обязательный объём этого документа не входит).

---

## 5. Загрузка и обновление (механизм)

### 5.1 Пагинация
- Начальная страница: limit 50 (не 200).
- `subscribeToAuditLogs` возвращает `{ logs, nextCursor }`, а не только массив; `AdminPage` сохраняет `lastAuditDoc` из ответа, а не из второго аргумента колбэка.
- «Загрузить ещё»: `getMoreAuditLogs(lastAuditDoc, 50)`; кнопка скрывается, когда `next_cursor` пуст. Клиентская пагинация (`ForumPagination`) остаётся поверх загруженного набора.
- Ответ сервера не меняется (тот же `items` + `next_cursor`); `adminListAuditLogsHandler` трогать не нужно.

### 5.2 Обновление без 15-секундного перечита
- 15-секундный полный перечит убирается. Триггеры перечита первой страницы:
  - (a) действие выполнено из панели (после любой admin-мутации — перезапросить первую страницу: панель знает, что что-то изменилось);
  - (b) вкладка audit стала видимой (`visibilitychange`) — один перечит;
  - (c) кнопка ручного обновления.
- Поллинг — только запасной: интервал не чаще 60 секунд, только пока вкладка audit открыта и страница видима (`sharedPoll` уже не поллит скрытую вкладку — сохранить это).

### 5.3 Фильтры
- `action_type` и `performer_id` — в запрос (сервер их уже поддерживает, `audit.go:75–89`).
- Список типов в фильтре — из реестра §3.3 (группированный), а не из загруженных данных.
- Текстовый поиск — по загруженному набору, как сейчас (серверный поиск — вне скоупа, см. §7).

---

## 6. Файлы и шаги

| Файл | Что меняется |
|---|---|
| `src/api/audit.js` | Подписка возвращает курсор; limit по умолчанию 50; фильтры в запрос; триггеры обновления (§5.2) |
| `src/pages/AdminPage.jsx` (audit tab + модалка) | Сохранение `lastAuditDoc`, Load More, серверные фильтры; шаблоны деталей по §3, пропуск пустых полей, форматирование дат. При CP-3.5 переезжает в `AuditTab.jsx` без изменения логики |
| `backend/internal/platform/pocketbase/characters.go` | Правило §4 + объект `changes` в `character_updated` |
| `backend/internal/platform/pocketbase/forum_posts.go` | Категория (тайтл + id) в `post_delete` (§3.1) |
| `backend/internal/platform/pocketbase/admin_user_delete_votes.go` | Performer в bulk `post_delete` — действующий админ: пробросить его id в `purgeSinglePostForUserDeletion` (сейчас функция его не получает); удаляемый юзер остаётся subject (`author_id`) |

Проверки: `npm run build` + `npm test` (exit 0). Ручная проверка:
- открыть audit, нажать «Загрузить ещё» — подгружаются записи старше первых 50;
- удалить пост из панели — запись появляется без перезагрузки страницы;
- обновить свою маску — записи нет;
- обновить чужую маску модератором — запись есть, с `changes`.

---

## 7. Вне скоупа
- Серверный полнотекстовый поиск по логам; фильтр по диапазону дат (пока клиентский, по загруженному набору).
- Realtime-стрим (мёртв — см. §1.1).
- Темизация вкладки (Спринт H в плане темизации).
