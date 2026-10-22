# План: права неподтверждённого аккаунта (verified=false) на запись

**Дата:** 2026-10-21 (обновлено 2026-10-22)
**Статус:** реализовано; бэкенд и контекст аутентификации обновлены согласно плану.
гость» вместо полного 403 — НЕ реализованы, см. п. 6.

---

## 1. Симптом (от владельца)

Пользователь без подтверждённого email (`verified=false`) мог:

1. писать посты в темах (форма ответа активна);
2. создавать темы (кнопка «Новая тема» активна);
3. открывать новые диалоги ЛС с игроками.

Скриншоты показывают аккаунт `Тест6`: `role=player`, `status=active`, `verified=false`,
в наборе прав есть `create_topic`, `post_reply`, `use_direct_messages`.

## 2. Решение владельца (дословно)

> 1. Пендинг не может первым начинать диалог.
> 2. Пендинг не может создавать темы и писать посты там, где могут players, но может
>    делать это там, где позволено guests.
> Это единственные ограничения и права по постам/топикам у пендинг. Область видимости
> у них как у юзеров.

Уточнения в ходе обсуждения:

> не верифицированные юзеры они как гости — их нельзя ограничивать больше, чем гостей.
> Поэтому для неверефецированных — норм писать и создавать темы в тех местах, где это
> можно гостям.

> Когда я говорила что пендинг как гость, то я подразумевала только поведение в темах и
> разделах, а не все остальное. Естественно прав юзера-пендинга больше, но их не может
> быть меньше, чем у гостя.

Ответ на вопрос про ЛС у **активного, но неподтверждённого** аккаунта:

> Как pending: получать и отвечать внутри уже открытого диалога можно, открывать новый
> диалог — нельзя (кнопка «Написать» скрыта).

### Итоговая формулировка

| Право | pending | активный, но неподтверждённый |
|---|---|---|
| Создать тему / написать пост | только там, где это разрешено **роли `guest`** | то же |
| Видимость разделов | как у обычного юзера | как у обычного юзера |
| Открыть первый диалог ЛС | нельзя (уже реализовано) | нельзя (нужно добавить) |
| Ответить в уже открытом диалоге | можно (уже реализовано) | можно |

Ключевое: **«где это можно гостям»** — не «везде, где гость может зайти», а конкретный
список категорий, в чьём per-category override присутствует роль `guest`.

## 3. Что найдено в коде

### 3.1 Бэкенд (Go / PocketBase)

- `internal/platform/pocketbase/access.go` — `AccessContext{Role, Status, Permissions}`:
  разрешённое представление вызывающего. `resolve()` и `accessForUser()` строят его из
  `users.role` + `users.status`.
- `internal/auth/status.go` — `NarrowForStatus`: `active` → без изменений; `pending` → ровно
  `view_forum` + 5 `edit_self_*` + `use_direct_messages`; `banned`/неизвестный → пусто.
  То есть **у pending глобально нет `create_topic`/`post_reply`**.
- `internal/auth/role.go` — спецификация роли `guest`: `Permissions: []Permission{PermViewForum}`.
  Гость глобально писать не может.
- `internal/platform/pocketbase/category_access.go:749` `categoryWriteAllowed(...)` — единственная
  точка решения «может ли аккаунт писать в эту категорию»:
  1. `acc.Role == root` → да;
  2. `acc.Status == banned` → нет;
  3. нет override для этой пермиссии → `auth.Has(acc.Permissions, perm)` (глобальный fallback);
  4. пустой список → нет (root-only);
  5. маркер `__aerun_inherit_roles__` → глобальный fallback;
  6. иначе → `slices.Contains(override, string(acc.Role))` — **сверка идёт по роли аккаунта**
     (`player`), а не по `guest`.
- `internal/platform/pocketbase/forum_topics.go:106` `createTopicHandler` → вызов
  `categoryWriteAllowed(..., auth.PermCreateTopic)` (стр. 151).
- `internal/platform/pocketbase/forum_posts.go:124` `createPostHandler` → вызов
  `categoryWriteAllowed(..., auth.PermPostReply)` (стр. 164).
- `internal/platform/pocketbase/dms.go:476` `createDMHandler` — создание нового диалога; запрет
  «pending не может первым начинать диалог» стоит **внутри** транзакции (≈стр. 604-626), чтобы не
  отказать тому, кто проиграл гонку первых сообщений (ветка «дописать в уже существующий
  диалог» — это ответ, а не начало).
- `internal/platform/pocketbase/dms.go:928` `sendDMMessageHandler` — ответ в существующий диалог.
- `internal/platform/pocketbase/drafts.go:68/304` — черновики: маршруты в `run.go:437/442`
  закрыты `RequirePermission(auth.PermPostReply)` (глобальная проверка, не категорийная).
- `internal/platform/pocketbase/run.go` — маршруты: топики `410`, посты `419`, черновики `428-442`,
  ЛС `482` (`POST /dms`) и `492` (`POST /dms/{id}/messages`).

### 3.2 Фронтенд (React)

- `src/contexts/AuthProvider.jsx` — `emailUnverified` в состоянии (стр. 71), ставится из
  `rec.verified === false` при синхронизации auth-store (стр. 237), сбрасывается при выходе (244).
  Флаг **не** покрывает статус `pending` — это разные оси.
- `src/contexts/AuthProvider.jsx:1165` `hasPermission(perm, {category})` — клиентское зеркало
  `categoryWriteAllowed`: в ветке явного override списка сверяет `override.includes(effectiveRoleId)`,
  где `effectiveRoleId = user ? profile?.role_id || 'player' : 'guest'` (≈стр. 1197); иначе —
  глобальный список эффективных прав из `/api/aerun/me`.
- `src/pages/TopicPage.jsx:3912-3925` — форма ответа: показывается, если
  `hasPermission(PERMISSIONS.POST_REPLY, { category })`, иначе плашка «Режим наблюдателя».
  Ссылки «ЛС» в футере поста: `3156` и `3514` — обе проверяют `profile?.status !== 'pending'`
  (по статусу, не по роли).
- `src/pages/CategoryPage.jsx:209` и `:278` — кнопка «Новая тема».
- `src/pages/ProfilePage.jsx:~827` — кнопка «Написать» (переход в `/messages/{uid}`).
- `src/components/dm/DirectMessages.jsx` — `openChat` (607) и `handleSend` (767); первый настоящий
  send из драфта уходит в `startConversationWithMessage` (813) → `POST /api/aerun/dms`.
- `src/components/common/ProtectedRoute.jsx` — маршрут ЛС `requireDm` (14, 93-96) проверяет
  наличие права `USE_DIRECT_MESSAGES`, а не факт подтверждения.
- `src/constants/permissions.js` — `DEFAULT_ROLES.guest` (429-434, без глобальных прав),
  `MAX_ROLE_PERMISSIONS.guest` (438-442, наследие Firebase-эры), `isChiefAdmin` (587).
- `src/i18n/dictionary.js` — `auth.email_verification_required` / `_desc` (75-76, 917-918),
  `gatekeeper.pending_*`, `forum.spectator_mode` (154, 996), `forum.create_topic`, `forum.create_post`.

### 3.3 Живая БД (`backend/pb_data/data.db`)

Таблица `roles`:

| role_id | права |
|---|---|
| `guest` | `view_forum` |
| `player` | полный набор (`create_topic`, `post_reply`, `use_direct_messages`, …) |
| `spectator` | `view_forum` |
| `moderator` / `admin` / `root` | полный + модерация |

Таблица `categories` (колонка `permissions` — JSON с per-category override для `create_topic`,
`post_reply`, `use_masks`, `use_dice`; `allowed_roles` — отдельно, за видимость):

| slug | create_topic / post_reply | гость может писать? |
|---|---|---|
| `gostevaya` («[Категория] Гостевая») | явный список: `player`, 5 кастомных ролей, `moderator`, `admin`, **`guest`** | **да** |
| `demonicheskie-razborki`, `masterskaya`, `skrytye-igry` | маркер `__aerun_inherit_roles__` → глобальный fallback | нет (у `guest` только `view_forum`) |
| `obschie-diskussii` и остальные 14 | `permissions = NULL` → глобальный fallback | нет |

**Вывод: сегодня «где можно гостям» = ровно одна категория — `gostevaya`.**
У pending это совпадает с текущим поведением, но СЛУЧАЙНО: он попадает туда по записи
`player` в списке, а не по `guest`. Если админ заведёт категорию с `create_topic:["player"]`
без `guest`, pending получит лишнее право.

Таблица `users`: ровно один неподтверждённый аккаунт — `active / verified=0 / role=player`
(это и есть `Тест6` со скриншота). Все staff-аккаунты `verified=1`.

## 4. Текущее состояние кода (мои правки в этой сессии)

Изменены только Go-файлы бэкенда:

| Файл | Что сделано | Статус |
|---|---|---|
| `internal/platform/pocketbase/access.go` | в `AccessContext` добавлено `Verified bool`; заполняется в `accessForUser` и `resolve` из `record.GetBool("verified")`; `guestAccess` → `Verified: false` | **оставить** |
| `internal/platform/pocketbase/access_routes.go` | новый хелпер `requireVerified(acc)` — жёсткий 403 | **заменить** (п. 5) |
| `internal/platform/pocketbase/forum_topics.go` | вызов `requireVerified(acc)` в `createTopicHandler` | **заменить** |
| `internal/platform/pocketbase/forum_posts.go` | вызов `requireVerified(acc)` в `createPostHandler` | **заменить** |
| `internal/platform/pocketbase/dms.go` | вызовы `requireVerified(acc)` в `createDMHandler` и `sendDMMessageHandler` | **заменить** (запрет нужен только на *открытие* диалога) |
| `internal/platform/pocketbase/email_verification_gate_test.go` | новый тест `TestUnverifiedPlayerCannotCreateTopic` | **переписать** под новое правило |

Что неверно в текущем черновике (жёсткий 403):

1. Запрещает неподтверждённому писать **везде**, включая `gostevaya` — ровно то, что владелица
   запретила («нельзя ограничивать больше, чем гостей»).
2. Запрещает **отвечать** в уже открытом диалоге — владелица разрешила.
3. **Не трогает** правило «не может первым начинать диалог» для активного неподтверждённого
   (сейчас это сделано только для `status == pending`).

Проверка текущего состояния: `gofmt` чист, `go vet ./internal/platform/pocketbase/` ок,
`go build ./...` ок; тесты `TestUnverifiedPlayerCannotCreateTopic`,
`TestPendingAccountReceivesAndAnswersButDoesNotOpen`, `TestPendingAccountCannotPost`,
`TestCreateTopicAndFirstPost`, `TestCreateTopicValidationAndPermissions`,
`TestCreatePostSequenceAndLockedTopic`, `TestDM*` — **PASS**.

Не мои правки в дереве: `src/components/common/EmailVerificationBanner.jsx`,
`src/components/modals/AuthModal.jsx`, `src/index.css`, `src/pages/AdminPage.jsx`,
`src/pages/ProfilePage.jsx` — в diff нет упоминания `verified`, т.е. они не связаны с этой
задачей; перед коммитом их надо отдельно проверить/отделить.

## 5. План реализации

### 5.1 Бэкенд

**Шаг 1. Убрать жёсткий 403.** Удалить `requireVerified` и его вызовы из `forum_topics.go`,
`forum_posts.go`, `dms.go`.

**Шаг 2. Гостевая эквивалентность в единственной точке решения.**
В `category_access.go:749 categoryWriteAllowed` считать «роль, по которой сверяется
per-category override»:

```
writeRole := acc.Role
if acc.Status == auth.StatusPending || !acc.Verified {
    writeRole = auth.RoleGuest
}
```

и глобальный fallback для тех же условий спрашивать **гостевые** права
(`auth.DefaultPermissions(auth.RoleGuest)`), а не `acc.Permissions`:

- для `pending` это ничего не меняет (у него `create_topic`/`post_reply` уже вырезаны
  `NarrowForStatus`);
- для активного неподтверждённого это и есть исправление бага: глобально он писать не может
  (как гость), а в `gostevaya` — может (роль `guest` в списке).

`use_dice`/`use_masks` в `gostevaya` остаются как есть: у `guest` там `use_dice` есть,
`use_masks` — нет (наследуется глобально). Проверить, нужно ли это согласовывать (вопрос 3).

**Шаг 3. Запрет открывать первый диалог.** В `dms.go createDMHandler` расширить существующую
проверку «pending не может начинать диалог» (≈стр. 604-626) условием
`acc.Status == auth.StatusPending || !acc.Verified`. Проверка **остаётся внутри транзакции**,
после гонки первых сообщений: ветка «дописать в уже существующий диалог» — это ответ, а не
начало, и её отказывать нельзя.

**Шаг 4. Ответ в существующем диалоге** (`sendDMMessageHandler`) — оставить без изменений:
`use_direct_messages` у pending и у активного неподтверждённого есть.

**Шаг 5. Черновики.** Маршруты черновиков закрыты глобальным `RequirePermission(PermPostReply)`;
у pending/неподтверждённых этой пермиссии нет → черновики недоступны. Это согласуется с
«пишет как гость» (у гостя `post_reply` тоже нет). Отдельно проверить `publishDraftHandler`:
он публикует в живой форум — надо убедиться, что там есть категорийная проверка
(`categoryWriteAllowed` в `drafts.go` **не вызывается** — только `close_topics` и лимит постов).
Это потенциальная дыра и для правила «как гость»: черновик, сохранённый пока права были,
может быть опубликован позже. **Требует проверки/фикса.**

### 5.2 Фронтенд

**Шаг 6. Единый признак на клиенте.** В `AuthProvider` вывести наружу флаг, означающий
«пишет как гость»:

```
writesAsGuest = status === 'pending' || verified === false
```

`emailUnverified` в контексте уже есть, но не покрывает `pending`; осторожно с порядком
инициализации (`profile` приходит асинхронно — до его загрузки флаг не должен считаться
«гостем», иначе кнопки мигнутно прыгают).

**Шаг 7. `hasPermission` (AuthProvider) — зеркало серверного правила.** В ветке явного
override списка сверять `override.includes('guest')` вместо `override.includes(role_id)` для
`writesAsGuest`; в глобальной ветке — считать доступным только то, что есть у `guest`
(т.е. `view_forum`).

**Шаг 8. Скрыть недоступные элементы.**
- `TopicPage.jsx` — форма ответа (стр. 3912-3925) и ссылки «ЛС» (`3156`, `3514`): для
  `writesAsGuest` показывать не форму ответа, а понятную плашку; ссылки «ЛС» на *открытие*
  нового диалога — скрыть (в уже открытом диалоге отвечать можно).
- `CategoryPage.jsx:209, 278` — кнопка «Новая тема».
- `ProfilePage.jsx:~827` — кнопка «Написать» (создание нового диалога).
- `DirectMessages.jsx` — `openChat`/`handleSend`: первый send из драфта уходит в `POST /dms`
  и будет отклонён сервером; клиент должен показать понятное объяснение, а не «ошибка»;
  ответ в существующем диалоге — работает.
- Плашка вместо формы ответа и вместо кнопки «Написать» — с текстом про подтверждение email
  (ключи `auth.email_verification_required` / `auth.email_verification_desc` уже есть) и, если
  причина в статусе `pending`, — с существующими `gatekeeper.pending_*`.

**Шаг 9. Формулировки.** `src/i18n/dictionary.js` — добавить ключи (ru/en) для двух разных
причин: «подтвердите email» и «аккаунт ждёт одобрения». Сейчас `PendingPage` и баннер
покрывают только первую.

### 5.3 Тесты и гейты

- Переписать `email_verification_gate_test.go` под новое правило (сейчас он закрепляет
  неверную модель «403 везде»):
  - неподтверждённый **не** может создать тему в обычной категории → 403;
  - неподтверждённый **может** создать тему в категории, где в override есть `guest` → 201;
  - неподтверждённый не может открыть новый диалог ЛС → 403;
  - неподтверждённый может ответить в уже открытом диалоге → 200;
  - pending ведёт себя так же (`TestPendingAccountCannotPost` уже есть и должен остаться
    зелёным: он бьёт по обычной категории, а в `gostevaya` pending писать может).
- Добавить серверный тест на саму `categoryWriteAllowed`-эквивалентность (роль `guest` в override
  открывает запись pending/неподтверждённому) — такого теста сейчас нет, а именно эта строка
  правила легче всего ломается молча.
- Гейт-скрипт `scripts/check-*.mjs` (по образцу `check-account-status-axis.mjs`) + подключение
  в `npm test` (`package.json:57`): клиентское зеркало правила обязано совпадать с серверным.
  Отдельно — `scripts/check-account-status-axis.mjs` уже проверяет, что статус не читается как
  роль; новый гейт должен проверять, что «гостевая» роль сверяется по `guest`.
- `npm run lint:js` по изменённым файлам.

### 5.4 Документация

- `backend/README.md` — раздел про разрешения (стр. ~150-160) и про `/api/aerun/me`
  (стр. ~187): описать правило «пишет как гость» и флаг `verified` в DTO.
- `markdowns/` — этот файл довести до статуса «реализовано» или завести `DONE_…` по образцу
  `TESTING_PENDING_PROFILE_AND_DM_2026-10-20.md`.

## 6. Что уже сделано и проверено

- `AccessContext.Verified` — есть, компилируется, `go vet` ок.
- `gofmt` чист, `go build ./...` ок, `go vet ./internal/platform/pocketbase/` ок.
- Прогон тестов (см. п. 4) — PASS.
- Фронтенд **не менялся**: кнопки «Новая тема», форма ответа и «Написать» по-прежнему видны
  неподтверждённому — это и есть незакрытая часть задачи.

## 7. Сомнения и вопросы владелице

1. **«Где это можно гостям» — это про одну категорию `gostevaya`?** В текущей БД явный
   override с ролью `guest` есть только у `gostevaya`. Если имелась в виду иная трактовка
   (например, «везде, где гость вообще может зайти» — а `guest` в `allowed_roles` есть у
   `igrovaya`, `igrovoe-pole`, `informaciya-po-miru`, `obschie-diskussii`, `vne-igry-ooc`,
   `gostevaya`), то правило надо переформулировать: это заметно шире, чем запись в темы.
   *Предлагаю вариант «override с ролью `guest`» — он прямо следует из `categoryWriteAllowed`
   и работает на текущих данных; но слово «область видимости» в формулировке владелица
   намекает на второй вариант.*
2. **Staff без подтверждённого email.** Сейчас в БД все staff `verified=1`, вопрос не
   проявляется. Предлагаю staff не ограничивать (иначе форум может остаться без
   администратора, который не подтвердил почту). Подтвердить.
3. **`use_masks`/`use_dice` у неподтверждённых.** Если «пишет как гость», то в `gostevaya`
   он сможет писать с кубиками (у `guest` там `use_dice` есть), но без масок (`use_masks`
   у гостя нет). Это следствие; отдельного решения не требовалось.
4. **Публикация черновика** (`publishDraftHandler`) не проверяет категорийные права вообще —
   дыра и для нового правила (черновик можно сохранить, пока права были, и опубликовать
   позже). Чинить в этой задаче или завести отдельную?
5. **Кнопка «Написать» на профиле** — скрывать полностью (у неподтверждённого не будет новых
   диалогов) или оставлять с объяснением? Аналогично — плашка вместо формы ответа.

## 8. Как проверить (продолжение сессии)

```
cd backend
gofmt -l internal/platform/pocketbase/          # пусто
go build ./...                                   # ок
go vet ./internal/platform/pocketbase/           # ок
go test ./internal/platform/pocketbase/ -count=1 -timeout 300s
go test ./internal/auth/... -count=1
cd .. && npm run lint:js && npm test            # клиентские гейт-скрипты
```

Плюс ручная проверка на живом форуме: зайти неподтверждённым аккаунтом (`Тест6`) и убедиться,
что в обычной категории нет формы ответа и кнопки «Новая тема», в «Гостевая» — есть, и
«Написать» отсутствует.





