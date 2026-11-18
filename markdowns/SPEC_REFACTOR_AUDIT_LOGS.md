# Спецификация: Реорганизация журнала аудита (Audit Log Reorganization)

> **Статус:** Спецификация к реализации  
> **Связанные документы:** [`SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md`](SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md) (Этапы 2–3: CP-2.4 `AuditDetailsModal`, CP-3.5 `AuditTab`, CP-4.1 `useAdminAudit`), [`TODO_THEMEABLE_SPRINT_PLAN.md`](TODO_THEMEABLE_SPRINT_PLAN.md) (Спринт H — темизация вкладки), [`DONE_ADMIN_PAGE_REORGANIZATION.md`](DONE_ADMIN_PAGE_REORGANIZATION.md) (отчёт о Этапе 1)  
> **Порядок:** сначала поведение по этому документу, потом декомпозиция вкладки (CP-3.5), потом темизация (Спринт H). Темизация не начинается, пока поведение не готово: нет смысла переводить в гриды таблицу, чей механизм загрузки будет переписан.

---

## 1. Проблема (как сейчас, сверено с кодом, HEAD `db2d8c4`)

### 1.1 Загрузка: полный перечит 200 записей каждые 15 секунд
`src/api/audit.js` — `subscribeToAuditLogs(200)` через `sharedPoll` с `intervalMs: 15000`: каждые 15 секунд заново запрашивается `/api/aerun/admin/audit-logs?limit=200` целиком. Вкладка Network показывает именно это: `audit-logs?limit=200` четыре раза за ~35 секунд. Обновления по сигналу нет: realtime мёртв (комментарий в `src/api/shared-poll.js` — PocketBase realtime никогда не доставляет события, свежесть всегда даёт интервал).

### 1.2 Серверная пагинация есть, но кнопка «Загрузить ещё» мёртвая — и она вообще не нужна
Сервер умеет всё нужное: `adminListAuditLogsHandler` (`backend/internal/platform/pocketbase/audit.go:75`) принимает `limit`, `cursor` (`created|id`, keyset), `performer_id`, `action_type` и отдаёт `next_cursor`. `getMoreAuditLogs` в `audit.js` курсор использует. Но:
- `subscribeToAuditLogs` отбрасывает `res.next_cursor` — маппит только `items`;
- `poll.subscribe` вызывает колбэк как `(value, error)` (см. `shared-poll.js:279`: `cb(value, error)`), а `AdminPage.jsx:961` принимает колбэк как `(data, lastDoc) => ...` — второй аргумент это ошибка, а не курсор;
- в итоге `lastAuditDoc` всегда `undefined`, а `handleLoadMoreAudit` первым делом делает `if (!lastAuditDoc || !hasMoreAudit) return`.

Кнопка «Загрузить ещё» при этом показана (`hasMoreAudit` ставится из `data.length >= 200`) — и никогда не срабатывает. Дальше первых 200 логов уйти нельзя. Решение: кнопки «Загрузить ещё» не будет вовсе — вместо неё обычная нумерованная пагинация, как в остальных списках форума (см. §5.1).

### 1.3 Фильтр по действиям — дубли и разный регистр
Список строится из загруженных данных: `allActions = [...new Set(auditLogs.map(l => l.action_type))].sort()` (`AdminPage.jsx:2950`), а подпись каждой опции — `auditActionLabel` (`AdminPage.jsx:256`): есть ключ `admin.audit.actions.<type>` в словаре — Title Case из словаря, нет ключа — сырой `action_type` с `_` → пробел, в исходном нижнем регистре. Отсюда два дефекта, видные на скриншоте:
- **Дубли одного понятия:** `topic_delete` → «Topic Deleted» (ключ в словаре есть) и legacy-значение «topic deleted» (ключа нет) — две отдельные опции. То же с «Topic Locked» / «topic locked». В базе лежат строки двух эпох: нынешние snake_case-типы и старые человекочитаемые значения (`user banned`, `user deleted`, `user registered`, `user unbanned`, `user profile edited by admin`, `topic deleted`, `topic locked`).
- **Капслок:** всё, у чего нет ключа в словаре, рендерится нижним регистром (`user banned`, `user deleted`, `user role updated`) — рядом с Title Case подписями (`Topic Deleted`, `Topic Pinned`).

Словарь при этом полный для нынешних типов: `admin.audit.actions` содержит 41 ключ (EN + RU), по одному на каждый тип, который пишет нынешний бэкенд. Проблема — не в словаре, а в том, что список строится из данных, а не из реестра, и что fallback рендерит сырьё.

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

### 1.6 Поиск — только по загруженным 200
Поиск сейчас клиентский (`renderAuditLog`, `AdminPage.jsx:2912`): ищет по нику перформера (`performerNickname`), подписи действия, всем строковым значениям `details` (с резолвом id → ник) и id записи. По сути нужные поля уже ищутся — но только внутри загруженных 200 записей: найти старый пост или действие месячной давности нельзя. Плюс поиск ловит голые id и сырые значения `details`, а не структурированные поля (§3).


---

## 2. Цели
1. Обычная нумерованная пагинация (как в остальных списках форума): страница N из M, переход между страницами грузит данные с сервера. Кнопки «Загрузить ещё» нет.
2. Нет 15-секундного полного перечитывания 200 записей: обновление по событиям, которые панель знает; поллинг — только запасной вариант, с длинным интервалом и только пока вкладка открыта и видима.
3. Фильтр по действиям — из фиксированного реестра (§3.3): один пункт на действие, одна подпись, без дублей и без нижнего регистра.
4. Поиск — серверный, по никам (перформер и цель), контенту постов, названиям тем/масок/ролей/категорий и id (§5.3).
5. Модалка деталей — структурированная по типу действия (§3); пустые поля не рендерятся; даты форматируются; id всегда в паре с ником.
6. В лог попадает только модерация чужих масок (§4).

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
Всего типов 41 (по вызовам `recordAuditLog` в бэкенде). Шаблоны — по группам; внутри группы один набор полей:

| Группа | Типы | Целевой набор |
|---|---|---|
| Личность | `password_change`, `email_change`, `provider_unlink`, `nickname_change`, `profile_edit` | Перформер (ник + id), что изменилось (`changes` from → to, где есть) |
| Контент | `post_edit`, `topic_delete`, `topic_title_edit`, `topic_description_edit`, `topic_lock`, `topic_pin`, `topic_move`, `posts_move`, `dm_message_delete`, `reputation_edited`, `reputation_deleted` | Перформер, цель (пост/тема/сообщение: тайтл или начало контента + id), категория/тема где применимо, что изменилось |
| Структура | `role_created`, `role_updated`, `role_deleted`, `category_created`, `category_updated`, `category_deleted`, `category_group_created`, `category_group_updated`, `category_group_deleted`, `design_created`, `design_updated`, `design_deleted`, `settings_updated`, `email_template_updated`, `email_template_test_sent` | Перформер, цель (имя + id), что изменилось (`changes` для updated) |
| Пользователи | `admin_user_update`, `admin_user_delete`, `admin_users_bulk_update`, `admin_users_bulk_delete`, `root_transfer` | Перформер (действующий админ), целевой юзер (ник + id), что изменилось |
| Маски | `character_created`, `character_updated`, `character_deleted`, `character_avatar_changed` | См. §3.2 + §4 |

Фильтр по действию в таблице — из этого реестра (группированный список), а не из загруженных данных:
- одна запись реестра — один пункт фильтра; дублей нет по построению;
- подпись пункта — только из словаря (`admin.audit.actions.<type>`, EN + RU); рендер сырого `action_type` запрещён. Неизвестный тип показывает Title Case гуманизацию через одну центральную функцию и пишется в console как missing-registry warning (это баг словаря, а не вид фильтра);
- legacy-значения нормализуются сервером на чтении (карта ниже); новых строк с legacy-типами не пишется — каждый вызов `recordAuditLog` обязан использовать тип из реестра (проверяется тестом);
- legacy-записи, у которых нет канонического эквивалента (`user banned`, `user unbanned`, `user registered`), остаются отдельными пунктами реестра с пометкой legacy (только чтение, новые строки не пишутся), с нормальными подписями («User Banned», «User Unbanned», «User Registered»).

Карта нормализации legacy → canonical (на чтении, в `auditLogPayload` или в хендлере):
- «topic deleted» → `topic_delete`; «topic locked» → `topic_lock`;
- «user deleted» → `admin_user_delete`;
- «user profile edited by admin» → `admin_user_update`;
- «user role updated» → `admin_user_update`.

Любое другое незамапленное legacy-значение рендерится через центральную Title Case гуманизацию + console warning (правило выше), а не нижним регистром.

---

## 4. Правило «только модерация чужих масок»
- `character_updated` (`characters.go:534`) и `character_avatar_changed` (`characters.go:687`): писать строку только когда `e.Auth.Id != rec.GetString("owner_id")`. Свои правки — обычное самообслуживание, не событие аудита.
- На `post_delete` правило НЕ распространяется: собственные удаления логируются намеренно (комментарий в `forum_posts.go`: «EVERY delete is logged... precisely the traffic worth watching»).
- `character_created` / `character_deleted`: тот же принцип предлагается, но решение — при реализации (в обязательный объём этого документа не входит).

---

## 5. Загрузка и обновление (механизм)

### 5.1 Пагинация — обычная, нумерованная, серверная
- Паттерн — как в остальных списках форума: offset-based `page` + `limit` (`src/api/forum.js:288`: «Paging stays offset-based on the server (page + limit)»). Эндпоинт принимает `page` (1-based) и `limit`, отдаёт `items`, `total`, `page`, `total_pages`. Параметр `cursor` и `next_cursor` в ответе уходят (keyset-курсор для журнала не нужен; `getMoreAuditLogs` удаляется).
- Размер страницы: 50. Одна серверная страница = одна страница UI; `ForumPagination` (уже используется в таблице) переключает серверные страницы, а не срезы загруженного массива. `AUDIT_PAGE_SIZE` (сейчас 25) уходит — размер один, 50.
- Счётчик записей — серверный `total` (с учётом фильтров и поиска), а не длина загруженного массива.
- Сдвиг offset при новых записях: пока открыта вкладка, фонового перечита нет (§5.2), поэтому страницы стабильны; любое обновление (действие из панели, возврат на вкладку, ручное) сбрасывает на страницу 1.
- `subscribeToAuditLogs` как polling-подписка уходит: чтение страницы — обычный запрос `getAuditLogs({ page, limit, action_type, performer_id, q })`. `sharedPoll` для журнала больше не используется.

### 5.2 Обновление без 15-секундного перечита
- 15-секундный полный перечит убирается. Триггеры перечита первой страницы:
  - (a) действие выполнено из панели (после любой admin-мутации — перезапросить первую страницу: панель знает, что что-то изменилось);
  - (b) вкладка audit стала видимой (`visibilitychange`) — один перечит;
  - (c) кнопка ручного обновления.
- Поллинг — только запасной: интервал не чаще 60 секунд, только пока вкладка audit открыта и страница видима (`sharedPoll` уже не поллит скрытую вкладку — сохранить это).

### 5.3 Поиск и фильтры
Фильтры:
- `action_type` и `performer_id` — в запрос (сервер их уже поддерживает, `audit.go:75–89`); смена фильтра сбрасывает на страницу 1.
- Список типов в фильтре — из реестра §3.3 (группированный), а не из загруженных данных.

Поиск (`q` в запросе) — серверный, case-insensitive, по полям:
- ник перформера (уже резолвится сервером в `performer_nickname`);
- ник цели: ник автора поста (для `post_*`), ник владельца маски / редактируемого юзера (для `character_*` / `admin_user_*`), ник гостя (`guest_display_name`);
- контент поста (`details.content` — для `post_delete` / `post_edit`);
- название темы (`details.topic_title`), название маски/роли/категории/дизайна (`details.name` / `details.title`);
- id записи (точное совпадение — для вставки id).

Поиск по подписи действия не поддерживается намеренно: подписи локализованы, а фильтр по действию — это выпадающий список.

Реализация: SQL `LIKE` для кириллицы регистр не складывает (SQLite `lower()`/`LIKE` — только ASCII), поэтому совпадение считается в Go (`strings.ToLower` + `Contains` — Unicode-aware) поверх выборки, ограниченной фильтрами без поиска (scan limit 2000 строк); если совпадений больше — UI показывает «показаны первые N, уточните запрос». Ники целей резолвятся тем же батчем, что и ники перформеров (см. `audit.go:130`).

---

## 6. Файлы и шаги

| Файл | Что меняется |
|---|---|
| `src/api/audit.js` | Убрать `subscribeToAuditLogs`/`getMoreAuditLogs` (polling + курсор); обычный запрос страниц `getAuditLogs({ page, limit, action_type, performer_id, q })` |
| `src/pages/AdminPage.jsx` (audit tab + модалка) | `ForumPagination` переключает серверные страницы; фильтр из реестра §3.3; поиск — `q` в запрос; шаблоны деталей по §3, пропуск пустых полей, форматирование дат. При CP-3.5 переезжает в `AuditTab.jsx` без изменения логики |
| `backend/internal/platform/pocketbase/audit.go` | `page`/`limit` + `total`/`total_pages` в ответе (offset, как в остальных списках); `q` (§5.3, Go-side matching, scan limit 2000); нормализация legacy `action_type` на чтении (§3.3); `cursor`/`next_cursor` убрать |
| `src/i18n/dictionary.js` | Ключи `admin.audit.actions.*` для всех типов реестра, включая legacy (`user banned` → «User Banned» и т.д.), EN + RU |
| `backend/internal/platform/pocketbase/characters.go` | Правило §4 + объект `changes` в `character_updated` |
| `backend/internal/platform/pocketbase/forum_posts.go` | Категория (тайтл + id) в `post_delete` (§3.1) |
| `backend/internal/platform/pocketbase/admin_user_delete_votes.go` | Performer в bulk `post_delete` — действующий админ: пробросить его id в `purgeSinglePostForUserDeletion` (сейчас функция его не получает); удаляемый юзер остаётся subject (`author_id`) |

Проверки: `npm run build` + `npm test` (exit 0). Ручная проверка:
- открыть audit, перейти на страницу 2 и обратно на 1 — данные грузятся с сервера, счётчик показывает серверный total;
- в фильтре действий — один пункт на действие, без дублей и нижнего регистра;
- поиск «Арина» находит записи по нику перформера и цели; поиск по слову из контента находит удалённый пост;
- удалить пост из панели — запись появляется без перезагрузки страницы;
- обновить свою маску — записи нет;
- обновить чужую маску модератором — запись есть, с `changes`.

---

## 7. Вне скоупа
- Фильтр по диапазону дат (пока нет; поиск и фильтр по действию покрывают основные сценарии).
- Realtime-стрим (мёртв — см. §1.1).
- Темизация вкладки (Спринт H в плане темизации).

---

## 8. Журнал реализации (Checkpoints & Findings)

### План контрольных точек (Checkpoints)
- [x] **CP-1: Backend fixes & Audit Generation**
  - Маски: логировать `character_updated` и `character_avatar_changed` только для чужих масок (`performer != owner`); в `character_updated` добавлен diff `changes` (from → to), в `character_avatar_changed` флаг `avatar_updated: true`.
  - Удаление постов (`post_delete`): добавлены `category_id` и `category_title` в details (через `topic.category_id`).
  - Массовая чистка постов при удалении пользователя (`purgeSinglePostForUserDeletion`): проброшен действующий админ как `performer_id`, удаляемый пользователь оставлен в `author_id`.
  - Проверка тестов бэкенда (`go test ./...`).
- [x] **CP-2: Backend Audit API**
  - Переход от курсора (`cursor`/`next_cursor`) к серверной offset-пагинации: параметры `page` (1-based, def 1), `limit` (def 50), ответ: `items`, `total`, `page`, `total_pages`.
  - Нормализация legacy `action_type` при чтении и фильтрации: «topic deleted» → `topic_delete`, «topic locked» → `topic_lock`, «user deleted» → `admin_user_delete`, «user profile edited by admin» → `admin_user_update`, «user role updated» → `admin_user_update`.
  - Серверный Unicode-aware поиск `q` (scan limit 2000, совпадение по `performer_nickname`, никам целей, контенту `post_delete`/`post_edit`, названиям тем/масок/категорий, id записи). Пакетный резолв ников целей.
  - Написаны автотесты `TestAuditListAPI_PaginationAndFilters` и `TestAuditListAPI_SearchAndLegacyNormalization` в `audit_api_test.go`, все 13 тестов аудита пройдены.
- [x] **CP-3: Frontend API & i18n Dictionary**
  - `src/api/audit.js`: удалены `subscribeToAuditLogs` (polling) и `getMoreAuditLogs`; добавлен `getAuditLogs({ page, limit, action_type, performer_id, q })` с нормализацией строк.
  - `src/i18n/dictionary.js`: добавлены ключи для legacy-типов («user banned», «user unbanned», «user registered», «topic deleted», «user deleted» и т.д.), ключи деталей `admin.audit.details.*` и групп фильтра `admin.audit.filter_group_*` (EN + RU).
  - Пройдены `scripts/check-audit-action-labels.mjs` и весь набор `npm test`.
- [ ] **CP-4: Frontend Audit Tab**
  - Перевод вкладки аудита в `AdminPage.jsx` на серверную пагинацию (страница 50 записей, `total` из сервера, переключение через `ForumPagination`).
  - Устранение 15-секундного поллинга; обновление по: (a) административному действию, (b) `visibilitychange`, (c) ручной кнопке обновления; запасной тихий поллинг 60с только при активной и видимой вкладке.
  - Удаление кнопки «Загрузить ещё».
  - Фильтр действий по фиксированному структурированному реестру (§3.3) вместо выборки из загруженных данных; группировка, запрет дублей и нижнего регистра.
  - Подключение серверного поиска `q` с дебаунсом.
- [ ] **CP-5: Structured Details Modal & Rows UI**
  - Рефакторинг `AuditDetailsModal`: единая шапка (перформер с ником и id, действие, дата через `Timestamp`), скрытие пустых полей, структурированные шаблоны по группам (§3).
  - Улучшение отображения деталей в колонке таблицы (без голых opaque-хешей, резолв связанных сущностей).
- [ ] **CP-6: Финальная верификация, сборка и отчёт**
  - Запуск `npm test`, `npm run build`, `go test ./...`.
  - Проверка всех сценариев раздела §6.
  - Итоговая фиксация всех попутных находок и состояния в данном журнале.

### Попутные находки (Incidental Findings)
1. В `backend/internal/platform/pocketbase/` отсутствовал изолированный тест-файл генерации аудита — создан `audit_generation_test.go` с проверками правил масок (§4) и атрибуции перформера при purge постов.
2. В `user_soft_delete_test.go` вызов `purgeUserContent` был без параметра перформера — обновлен на передачу `fixAdminID`.
3. В `audit.go` поиск по `action_type` поддержан для канонических и legacy-типов симметрично (`auditActionFilterValues`): при запросе `action_type=topic_delete` находятся и записи эпохи PocketBase, и исторические записи `topic deleted`. В `auditLogPayload` теперь также возвращается `target_nickname`, резолвимый на сервере пакетным чтением.

### Прогресс по чекпоинтам
- **2026-11-18 CP-1 завершён:**
  - `characters.go`: самообслуживание масок больше не засоряет аудит (`e.Auth.Id != owner_id`), для модераторских правок пишутся `changes` (from → to) и `avatar_updated: true`.
  - `forum_posts.go`: в `post_delete` добавлены `category_id` и `category_title`.
  - `admin_user_delete_votes.go`, `admin_user_delete_purge.go`, `admin_users.go`: `purgeSinglePostForUserDeletion` атрибутирует удаление админу (`adminPerformerID`), а не жертве удаления.
  - Тесты: `TestAuditGeneration_CharacterRules`, `TestAuditGeneration_PurgeUserPostDeletePerformer`, `TestEveryDeleteIsAuditedWithItsText` успешно пройдены.
- **2026-11-18 CP-2 завершён:**
  - `audit.go`: переписан `adminListAuditLogsHandler` на offset-пагинацию (`page`, `limit`), возвращает `{ items, total, page, total_pages }`. Keyset-курсор (`cursor`, `next_cursor`) удален.
  - Добавлена нормализация legacy-действий (`topic deleted` → `topic_delete`, `user deleted` → `admin_user_delete` и др.).
  - Реализован серверный Unicode-поиск `q` поверх выборки до 2000 записей (Go-matching с поддержкой кириллицы по перформеру, цели, контенту постов, заголовкам тем/категорий/масок/ролей, log ID).
  - Тесты: написан `audit_api_test.go` (`TestAuditListAPI_PaginationAndFilters`, `TestAuditListAPI_SearchAndLegacyNormalization`), все тесты аудита (13 шт) пройдены (exit 0).
- **2026-11-18 CP-3 завершён:**
  - `src/api/audit.js`: заменен устаревший polling (`subscribeToAuditLogs`) и курсорный `getMoreAuditLogs` на параметризованный `getAuditLogs({ page, limit, action_type, performer_id, q })`.
  - `src/i18n/dictionary.js`: добавлены все недостающие legacy-действия в EN и RU словари, а также ключи `admin.audit.details.*` и `admin.audit.filter_group_*`.
  - Тесты `check-audit-action-labels.mjs` и `npm test` подтверждают полноту словаря и целостность кода.

