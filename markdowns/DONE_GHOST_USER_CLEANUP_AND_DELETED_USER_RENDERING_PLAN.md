# INPROGRESS — План: чистка ghost-юзеров в Firebase + корректное отображение удалённых/гостей

> Рабочий файл. Сначала план и решения владельца, код backend/Firebase НЕ трогаем,
> пока план не согласован. Ветка: `feature/pocketbase-migration`. Дата: 2026-10-13.

## Цель (словами владельца)
1. Почистить Firebase: удалить **все** следы ghost-юзеров
   `aCetMfSLI1RvsSsL56XiF3EIe412` и `BqWoHwU8z2Wx4wzmbCAHTTusU3p1`
   (оба ничего не делали на форуме). Это осознанное решение.
2. PocketBase БД **не трогать** — «самоочистится при миграции».
3. Убедиться, что при удалении юзера диалоги у других участников отображаются
   нормально: тред читается, удалённый участник — плейсхолдер-идентичность
   (единый механизм для постов/миниатюр/DM), отправка ему заблокирована.
   Настраиваемые плейсхолдеры (удалённый / гость) в настройках форума — бэклог.
4. Убедиться, что связанные данные (посты, темы, репутация, маски, подписки,
   уведомления) не дают скрытой поломки отображения при удалении юзера.

---

## A. Что выяснено (подтверждено чтением кода + скриншотами)

### A1. Определение ghost
`users/{uid}` — заглушка: присутствуют только сиротские поля (`readmap`
подколлекция, `last_seen`), **нет** `nickname` / `email` / `role_id`.
См. скриншот `users/aCetMfSLI1RvsSsL56XiF3EIe412`.
Живой Киран — это ДРУГОЙ документ: `users/meYHzulxXTPSWEjsi6kqBSesDoJ3`
(`nickname: "Kieran"`, `post_count: 5`). Ghost — его удалённый предшественник.

### A2. Почему PocketBase получает пустую оболочку (баг M2)
- `buildUserRow` (`backend/tools/migration/importer/users.go:233-236`) —
  **без email аккаунт не импортируется** (`return row, false`). Ghost не имеет
  email → в PB `users` его нет.
- `BuildSocialPlan` (`importer/social.go:216-242`) — участник без импортированной
  учётки помечается `dm_conversation_member_unresolved`, но **тред сохраняется**,
  если резолвится хотя бы один участник (осознанно, стр. 220-224). Roui
  резолвится → создаётся `dm_conversations` + один `dm_members` (Roui), без
  второго участника.
- Итог в рантайме: `listConversations` показывает тред, а
  `loadConversationParticipants` (`pocketbase/dms.go:841-888`, `JOIN users u ON
  u.id = dm.user_id`) не находит второго → inbox рисует «User» без аватара,
  чат не открывается. = M2.

### A3. Почему ghost остался именно в Firebase
- Firebase `onUserDeleted` (`functions/index.js:3215-3289`) при удалении чистит
  ТОЛЬКО: Auth, RTDB presence/status/dm_unread/notifications, `forum_stats`.
  НЕ чистит: `users/{uid}` подколлекции, `posts`, `topics`, `reputation_logs`,
  `topic_subscriptions`, `dms`. Это задокументировано в
  `markdowns/Archive_Claude Review.md:325` (I8).
- PocketBase `adminDeleteUserHandler` (`pocketbase/admin_users.go:360-389`) —
  чистый `txApp.Delete(targetUser)` **без каскадов**. Связи — plain TEXT id, не
  RelationField (`migrations/1766100000_forum_command_layer.go:26-27`,
  `1768300000_topic_read_states.go:46-52`), поэтому FK-каскада на уровне БД нет.
- Правило инцидента 2026-09-30 (`.agent/rules/AGENTS.md:14`): удаление обязано
  уладить денормализованные копии в той же транзакции.

### A4. Что уже «не ломается» (важно для объёма работы)
- `forum_authors.go:19-22, 49-92` — «A missing author is not an error».
  `loadAuthorDisplays` НЕ резолвится → payload не декорируется → фронт падает на
  плейсхолдер (`ui-avatars`, напр. `MembersPage.jsx:439`, `ProfilePage.jsx:745`).
  Пост/тема удалённого автора рендерится, не крашит. ✓
- Маски (`characters`) привязаны к `owner_id`; пост ссылается на `character_id`
  маски. Маска НЕ удаляется вместе с юзером → в постах имя маски сохраняется
  (`forum_authors.go:290`, `applyMask`). ✓ Это ровно то, что просила владелец
  (п.4).

---

## B. Задача 1 — чистка ghost-юзеров ПРИ МИГРАЦИИ (решение 2026-10-13: не живём Firebase)

> **РЕШЕНИЕ ВЛАДЕЛЬЦА (пивот):** прямую чистку живого Firebase **отменяем**
> (сервис-аккаунт `antigravity@aerun-forum` только viewer; удалять из прода нечем
> и не нужно). Вместо этого чистим **дамп/экспорт в момент миграции** — через
> логику импортёра, детерминированно, ревьюится в тестах, без разрушительной
> операции в проде. `scripts/clean-ghost-users.mjs` остаётся как справочный
> инструмент dry-run инвентаризации (не для `--apply` без прав).

### B0. Что импортёр УЖЕ чистит сам (подтверждено чтением кода)
Предикат `userExists(uid)` = `importedUIDs` (`cmd/import-board/main.go:149-161`) —
резолвит uid из PB `users` по колонке `legacy_firebase_uid`. Для ghost (нет email
→ `buildUserRow` вернул `false`, `users.go:233`) это `false`, поэтому ghost
отсеивается на КАЖДОМ пути импорта:

| След ghost | Где фильтруется | Что делает |
|---|---|---|
| сама заглушка `users/{uid}` | `users.go:233` | не пишется (нет email) |
| голоса `reputation_logs` (voter/target) | `engagement.go:97` | skip + `reputation_vote_account_unresolved` |
| подписки `topic_subscriptions` | `engagement.go:169` | skip + `subscription_user_unresolved` |
| посты/темы/драфты (author) | `forum.go:209,313,378` | skip (топик/пост/драфт) |
| уведомления (recipient) | `social.go:154` | skip + `notification_recipient_unresolved` |
| DM-сообщения (sender=ghost) | `social.go:260` | skip + `dm_message_sender_unresolved` |
| маски `characters` (owner=ghost) | `characters.go:106` | skip + `character_owner_missing` |
| `audit_logs` (performer=ghost) | `social.go:344` | skip |

➡ То есть «чистка дампа при миграции» **почти бесплатна** — 99% следов ghost уже
не проходят `userExists`. Нужна правка ТОЛЬКО для одной дырки (B1).

### B1. Единственная дырка — спасение DM-треда (`social.go:220-242`)
Сейчас: тред импортируется, если резолвится **≥1** участник (`len(known) == 0`
→ skip; иначе тред пишется даже с ghost-участником). Это **осознанное** решение
(комментарий `social.go:220-224`, тест `social_test.go:238-247`): не терять ~8
реальных сообщений живого собеседника из-за одной учётки, которой нет в бэкапе.
➜ Но именно это создаёт оболочку M2 (тред с 1 `dm_members`, без второго →
«User» без аватара, не открывается).

**Развилка (выбор владельца — см. I6):**
- **B1-a (C-a на импорте):** тред пишется только если резолвятся **оба**
  участника. Любой нерезолвлённый (ghost) → весь тред пропускается. Меняет
  осознанное поведение + тест `social_test.go:238-247`. Устраняет M2 полностью,
  но «реальный удалённый до дампа» собеседник тоже потеряет тред.
- **B1-b (C-b на импорте + рантайм-плейсхолдер):** оставить спасение треда как
  есть, а M2 закрыть в рантайме через D1 (плейсхолдер неразрешённого участника)
  + D3 (блокировка отправки). Тогда ghost-тред остаётся как «диалог с
  удалённым», но корректно отображается.

### B2. Инвентаризация следов uid (для справочного dry-run `clean-ghost-users.mjs`)
Для каждого из 2 uid пройти по коллекциям:
- `users/{uid}` — документ + подколлекции `readmap`, `characters`, `drafts`.
- `dms/{A}_{B}` — треды, где uid — участник (`participants` содержит uid) +
  подколлекция `messages`.
- `notifications` где `recipient_uid == uid`.
- `reputation_logs` где `voter_id`/`target_id` == uid (ожидаемо 0 — «ничего не
  делали», но проверить).
- `posts` / `topics` где `author_id == uid` (ожидаемо 0, проверить).
- `topic_subscriptions` где `user_id == uid`.
- `audit_logs` — **НЕ удаляем** (append-only криминалистический лог). Только
  отмечаем.
- RTDB: `status`, `user_presence`, `dm_unread`, `notifications` по uid (если ещё
  живы).
- `forum_stats/global` — **НЕ трогаем вручную** (её двигает `onUserDeleted`);
  ghost и так не должен был попадать в `newest_user`.

### B3. Порядок и безопасность (справочный dry-run; прода не трогаем)
1. Dry-run `clean-ghost-users.mjs`: напечатать каждый путь и число найденного,
   ничего не удалять.
2. Владелец сверяет вывод со скриншотами (ожидаем: 1 users-заглушка
   `aCetMfSLI…` + 1 dm-тред + 1 уведомление + 1 голос-сирота; `BqWoHw…` уже
   удалён; 0 постов/тем).
3. `--apply` **не используется** без прав записи (сервис-аккаунт viewer) и по
   решению I6 не нужен — реальную чистку делает импортёр при миграции.
4. Для миграции: правка импортёра по B1 (I6-a или I6-b), затем `go test
   ./tools/migration/importer/...`.

**Критерий приёмки:** после чистки `users/aCetMfSLI…` и `users/BqWoHw…`
отсутствуют; ни один `dms/*` не ссылается на эти uid.

---

## C. Задача 2 — PocketBase «самоочистится при миграции» (проверка гипотезы)

**Нюанс, который надо зафиксировать:** «самоочистка» верна ТОЛЬКО если удалить
ghost из Firebase **целиком**, включая его DM-треды. Тогда:
- при ре-импорте ghost не попадёт в экспорт → нет `users`, нет `dms` с ним. ✓

**НО:** если тред `Roui_ghost` оставить в Firebase (ghost удалён только из
`users`), импортёр снова создаст оболочку с 1 участником (A2) → M2 вернётся.

➡ **РЕШЕНО (I1 + I2):** для ghost — **C-a** (Задача 1 удаляет и `users`-заглушки,
и `dms`-треды ghost → PB-чистка избыточна, ре-импорт чист, PB-БД не трогаем).
Как **общая политика** (для живых игроков) действует **C-b**: тред остаётся,
пока живёт ≥1 участник; если удалён последний — тред удаляется. При этом для
живых тредов с удалённым собеседником **обязателен** фикс D1 (плейсхолдер в
рантайме) + блокировка отправки (D3).


---

## D. Задача 3 — отображение диалогов с удалённым/гостем (рантайм PB)

**Текущее поведение:** `loadConversationParticipants` (`dms.go:861-888`) —
`JOIN users u ON u.id = dm.user_id`. Удалённый участник выпадает из peers →
inbox: «User» без аватара (`DirectMessages.jsx:1058-1059`), тред не открывается.

**Целевое поведение:** тред собеседника (Roui) читается; удалённый участник —
с плейсхолдер-идентичностью; отправка ему заблокирована (D3).

### D1. Единая точка плейсхолдера (РЕШЕНО, I3)
Плейсхолдер «удалённый юзер» и «гость» — **единая интерфейсная абстракция**,
используется в постах тем, миниатюрах последних сообщений и DM. Источник данных
(настройка форума с загрузкой картинок) — в бэклоге (D2); **сейчас** — кодовая
заглушка (хардкод), оформленная общим хелпером/компонентом, чтобы потом
подменить только источник.

Реализация заглушки (минимальная, но «единая»):
- Ввести общий хелпер рендера идентичности (имя+аватар), который для
  отсутствующего/неразрешённого `user_id` возвращает локализуемое имя
  («Удалённый пользователь» / «Гость») + плейсхолдер-аватар
  (`ui-avatars?name=?`, как `MembersPage.jsx:439` onError).
- Плечо DM: `loadConversationParticipants` помечает неразрешённого участника
  (нет строки в `users`) как «deleted/unknown» → фронт рисует плейсхолдер через
  тот же общий хелпер. Единая точка — хелпер, а не два независимых патча.
- Плечо постов уже ок (`forum_authors.go` placeholder) — привести к тому же
  хелперу, чтобы плейсхолдеры совпадали.

### D2. Настраиваемая форма плейсхолдеров → **БЭКЛОГ (I5)**
Форма в настройках форума: отдельная картинка-аватар для «удалённый юзер» и для
«гость» (гости пишут в открытых форумах) + дефолт, когда кастом не залит.
Ложится на механизм настроек форума. TODO, не этот спринт.

### D3. Блокировка отправки в диалог с удалённым собеседником (РЕШЕНО, I4)
Если один из участников диалога удалён (нет в `users`):
- Тред остаётся читаемым (история видна), собеседник — плейсхолдер (D1).
- **Отправка новых сообщений в этот диалог блокируется** (UI + backend-гард).
- Без soft-delete: при удалении последнего живого участника тред удаляется (I2).
- Будущая опция (бэклог): при удалении юзера «также удалить все его сообщения».

---

## E. Задача 4 — аудит связанных данных при удалении юзера

Проверить каждый read-путь, джойнящий `users`/`characters`, на «нет краша / нет
битого отображения», когда автора/владельца/участника удалили.

| Коллекция / связь | Что рендерит | Риск при удалении | Статус |
|---|---|---|---|
| `posts.author_id` → users | ник/аватар/роль/репутация поста | плейсхолдер | ✓ ок (`forum_authors.go`) |
| `topics.author_id`, `topics.last_post_author_id` | «кто говорил» в списке/категории | плейсхолдер | ✓ ок (`category_access.go:242`) |
| `posts.author_character_id` → characters | имя маски | маска не удаляется с юзером | ✓ ок (`forum_authors.go:290`) |
| `characters.owner_id` → users | владелец маски | маска-сирота видна в постах | проверить UI профиля/масок |
| `reputation_votes.voter_id`/`target_id` → users | лог репутации | плейсхолдер в ленте логов | **аудит** |
| `topic_subscriptions.user_id` | подписки | висячие (влияние: нет) | ок |
| `notifications.recipient_id` | колокольчик | висячие у получателя | ок |
| `dm_members.user_id` | участник диалога | **M2 — оболочка** | **фикс D1** |
| `forum_stats.total_users` | счётчик | PB считает от users | ✓ пересчёт |
| `users.posts_count/reputation/topics_count` | профиль | исчезают с юзером | ✓ ок (per-user) |

### E1. Что реально требует решения (не «уже ок»)
- **Лог репутации** (`reputation_votes`): если голосовал/целью был удалённый
  юзер — показать плейсхолдер в строке лога (аналог D1-B). Проверить
  `pocketbase/reputation.go` + фронт ленты репутации.
- **Счётчики, пересчитываемые из строк:** при хард-делите реального игрока с
  постами — посты остаются (история), его `users`-счётчики исчезают. Убедиться,
  что `topics.posts_count`/`categories.*`/`posts.reputation` НЕ пересчитываются
  вхолостую от удаления автора и не падают. Инструмент ремонта:
  `tools/migration/importer/cmd/recompute-counters` + `pocketbase.RecomputeUserCounters`
  (идемпотентно, без удалений).
- **Маски-сироты** (`characters.owner_id` = удалён): остаются и работают в
  постах, но проверить, не сломается ли список масок в профиле/пикере.

### E2. Правило, которому следовать (из инцидента 2026-09-30)
Любой путь удаления (Firebase `onUserDeleted` и/или PB
`adminDeleteUserHandler`) обязан в той же транзакции решить судьбу КАЖДОЙ
денормализованной копии: пересчитать / сохранить осознанно / удалить. Никаких
«допилить потом».


---

## F. Предложения по коду (НЕ реализовывать — на согласование)

1. **PB `adminDeleteUserHandler`** (`admin_users.go:373`): добавить каскад в той
   же транзакции ИЛИ ввести soft-delete (`status`) вместо хард-делита для
   аккаунтов с контентом. Хард-делит оставить только для пустышек вроде ghost.
2. **Firebase `onUserDeleted`** (`functions/index.js:3215`): расширить очистку
   (dm-треды/подколлекции) — но для текущей задачи мы чистим Firebase
   скриптом напрямую (B), т.к. ghost остались именно из-за этой дырки.
3. **Плейсхолдер-идентичность** в `loadConversationParticipants` (D1-B) — единая
   точка для «удалён/гость».

---

## G. Риски
- **Необратимость.** Удаление в проде Firebase + PITR = единственная страховка.
  Обязателен dry-run и сверка выводов до `--apply`.
- **Ре-импорт из грязного Firebase.** Если тред ghost останется — M2 вернётся
  (C). Задача 1 закрывает это только при C-a.
- **`forum_stats/global.newest_user`.** Убедиться, что удаляемый ghost — не
  текущий `newest_user` (иначе триггер переставит, но проверить в dry-run).
- **audit_logs не трогать** — иначе рвётся криминалистическая цепочка.

## H. Чек-лист приёмки
- [x] Dry-run `clean-ghost-users.mjs` (инвентаризация) показал ровно: 1
      users-заглушка (`aCetMfSLI…`) + 1 dm-тред + 1 уведомление + 1 голос-сирота;
      0 постов/тем; `BqWoHw…` уже удалён. (`clean-orphan-dms.mjs` — опц.)
- [x] (отменено — I6-пивот) ~~`--apply` в живом Firebase~~. Чистим дамп при миграции.
- [x] Выбрано решение C-a/C-b (ЗАФИКСИРОВАНО: ghost=C-a, политика=C-b — I1/I2).
- [x] Выбрано B1-b = **I6-b** (ЗАФИКСИРОВАНО): M2 закрываем в рантайме (D1+D3+D4),
      правило импортёра `social.go` НЕ меняем (I6-a отложен как страховка).
- [x] D1 реализован: единый хелпер плейсхолдера; тред собеседника открывается,
      удалённый участник — плейсхолдер (имя+аватар), согласован с постами.
- [x] D3 реализован: отправка в диалог с удалённым собеседником блокируется
      (UI + backend-гард).
- [x] D4 реализовано: вырожденный тред с призраком удаляется из inbox, не
      открывая (проверить, что кнопка удаления доступна при `peers=[]`).
- [x] D2 (форма плейсхолдеров в настройках) — **реализована в рамках I5** (N1+N2):
      секция «Плейсхолдеры идентичности» в `AdminPage.jsx`, загрузка/сброс обоих
      изображений, i18n EN/RU, бэкенд-тест `placeholder_upload_test.go`.
- [x] Аудит E завершён: лог репутации и маски-сироты проверены; при besoin —
      плейсхолдер/ремонт-инструмент.
- [x] Backend-изменения — gofmt/build/vet/test зелёные (`go test
      ./internal/platform/pocketbase/` → ok).
- [x] `PROJECT_CONTEXT.md` / `PROJECT_SPEC.md` / `backend/README.md` обновлены
      (новые поля настроек + эндпоинт `PUT /admin/settings/placeholder/{kind}`).

## I. Решения владельца (ЗАФИКСИРОВАНО 2026-10-13 — код можно писать)

### I1. Firebase: полная зачистка двух ghost-uid → **C-a для ghost**
- Для `aCetMfSLI1RvsSsL56XiF3EIe412` и `BqWoHwU8z2Wx4wzmbCAHTTusU3p1` —
  удалить **все** следы в Firebase (users-заглушки + их dm-треды + подколлекции).
  Эти записи — призраки, корректно не удалённые. PB-БД не трогаем (самоочистится
  при ре-импорте).

### I2. Общее правило жизни диалога → **C-b как политика**
- Тред переписки живёт, **пока существует хотя бы один его участник** на форуме.
- Если удалён второй (последний) участник — диалогу больше некому принадлежать →
  тред удаляется.
- Это общее правило на будущее; конкретно по ghost (I1) — полная зачистка.

### I3. Плейсхолдер аватара/имени → **единая интерфейсная абстракция (сейчас — кодовая заглушка)**
- Плейсхолдер для «удалённый юзер» и для «гость» — это **настройка интерфейса
  форума**, в которой загружаются картинки-аватары. Плюс дефолтный
  плейсхолдер, показываемый, когда кастом не залит.
- Применяется **единообразно**: и в постах тем, и в миниатюрах последних
  сообщений, и в DM.
- **Сейчас (этот спринт):** кодовая заглушка-плейсхолдер (хардкод), оформленная
  как единая точка (общий хелпер/компонент рендера аватара+имени), чтобы потом
  безболезненно подменить источник на настройку форума. НЕ сугубо фронт (D1-A),
  НЕ сугубо backend (D1-B) — один общий механизм отображения.

### I4. Поведение при удалении РЕАЛЬНОГО игрока → оставляем текущее + блокировка отправки
- Посты/темы удалённого игрока **остаются** в темах (история): статы (число
  постов, репутация — без строк репутации на стороне удалённого) сохраняются,
  в постах сохраняется никнейм маски. Ссылки на профиль и на переписку
  удалённого **не рендерятся** (уже ок, `forum_authors.go`).
- Переписка остаётся читаемой, пока живёт ≥1 участник (I2).
- **НО:** в диалоге с удалённым собеседником **блокируется отправка новых
  сообщений** (см. новую подзадачу **D3**).
- В будущем — настройка при удалении юзера: «также удалить все его сообщения».

### I5. Настраиваемая форма плейсхолдеров → **БЭКЛОГ (не этот спринт)**
- Форма загрузки кастом-картинок «удалён/гость» в настройках форума (D2) — в
  бэклог (когда владелец пойдёт по багам админки). Сейчас — только кодовая
  заглушка из I3.

### I6. ПИВОТ 2026-10-13 — чистка НЕ живого Firebase, а ДАМПА при миграции
- Прямая чистка прода **отменена**: сервис-аккаунт только viewer, да и смысла нет
  — удалять необратимо из живого Firestore ради данных, которые всё равно
  переедет. Вместо этого ghost чистятся **логикой импортёра при миграции**
  (детерминированно, в тестах, без разрушительной операции в проде).
- **Импортёр уже чистит 99%** следов ghost через `userExists` (см. таблицу B0) —
  пользовательские голоса/подписки/посты/уведомления/маски ghost и так отсеются.
  Ноль ожидаемых постов/тем у ghost подтверждает и пользователь («они ничего не
  делали»), и dry-run `clean-ghost-users.mjs`.
- **Остаётся ровно 1 дырка (B1):** спасение DM-треда при ≥1 живом участнике
  (`social.go:220-242`) создаёт оболочку M2.
- **ВЫБРАНО I6-b (решение владельца 2026-10-13):** спасение треда остаётся, M2
  закрывается в **рантайме**, а не в импорте:
  - **D1** — плейсхолдер неразрешённого/удалённого участника (единый хелпер,
    имя+аватар, согласован с постами).
  - **D3** — блокировка отправки в такой диалог (UI + backend-гард).
  - **D4** — тред собеседника читается и **удаляется из UI** (inbox), чтобы
    владелец живой стороны сам убрал мусор. Кнопка удаления в inbox уже
    работает по `conv.id` (`DirectMessages.jsx:1119-1127`, `stopPropagation`),
    т.е. тред с призраком уже удаляется не открывая — но строка выглядит
    сломанной («User», пустой аватар, клик ведёт в `/messages/undefined`).
    D1+фикс открытия делают её корректной, D4 фиксирует возможность удаления.
  - **Почему не I6-a:** I6-b согласуется с общей политикой C-b (I2), решает
    задачу 3/4 (отображение удалённых) для ЛЮБОГО будущего удалённого собеседника
    одним механизмом, а не только для этих двух ghost. Если UI-удаление удобно —
    проблемы с мусорным тредом нет вовсе.
  - I6-a (правило импортёра, `social.go:236` + тест `social_test.go:238-247`)
    **отложен** — как страховка, если рантайм-D1 окажется недостаточно.

### (устаревшие вопросы сняты)
- ~~C-a/C-b~~ → решено (I1 ghost = C-a; общая политика = C-b).
- ~~D1-A/D1-B~~ → решено (I3: единая интерфейсная абстракция, сейчас заглушка).
- ~~хард-/soft-delete~~ → решено (I4: хард-делит оставляем, добавляем блокировку
  отправки, soft-delete не вводим сейчас).
- ~~плейсхолдеры в спринте/бэклог~~ → решено (I5: форма в бэклог, заглушка сейчас).


---

## J. РЕАЛИЗАЦИЯ D1/D3/D4 — дизайн правок (2026-10-13)

Решение **I6-b**: чиним M2 в **рантайме PocketBase + фронте**, импортёр `social.go`
НЕ трогаем. Точные якоря (контекст-стабильно, не зависит от сжатия):

### J1. Backend `backend/internal/platform/pocketbase/dms.go`
1. **loadConversationParticipants (~861)** — `JOIN users` → **LEFT JOIN users**,
   `u.id AS user_id` → `dm.user_id AS user_id`, `COALESCE(u.nickname,'')`,
   `COALESCE(u.avatar_url,'')`.
   Почему: INNER JOIN выбрасывает строку `dm_members` для удалённого юзера
   (orphan после `adminDeleteUserHandler` без каскада; связи — plain TEXT id, не
   RelationField) → `peers=[]` → inbox рисует «User». LEFT JOIN сохраняет строку,
   uid известен, имя/аватар пустые → плейсхолдер на фронте. Покрывает
   **рантайм-удаление**. (Миграционный ghost без строки `dm_members` → peers=[],
   покрывается peer_missing ниже.)
2. **listConversationsHandler (~1002)** — добавить поле
   `"peer_missing": len(peers)==0` к item. Вырожденный тред (единственный
   резолвящийся участник = сам caller) → фронт рисует плейсхолдер и не открывает.
3. **sendDMMessageHandler (~695)** — `if err!=nil||other==nil { continue }` →
   `return forbiddenError("cannot send message to a removed user")`.
   **D3**: блокировка отправки в тред с удалённым собеседником (orphan-строка).

### J2. Frontend `src/components/dm/DirectMessages.jsx` (1057-1066)
- `peerName`: `|| 'User'` → плейсхолдер `(lang==='ru'?'Удалённый пользователь':'Deleted user')`.
- `onClick` строки inbox → guard `if (peerUid) openInboxConversation(conv)`.
  **D4**: вырожденный тред некликабелен (не `/messages/undefined`); удаление —
  через trash `promptDeleteConversation(conv.id)` (уже работает, stopPropagation).

### J3. Тест
- Регресс: тред с orphan `dm_members` → `peer_missing:true`/плейсхолдер; send → 403.

### J4. НЕ в этом спринте (бэклог)
- Настраиваемые плейсхолдеры (форма в настройках форума) — I5.
- soft-delete пользователей.

---

## K. РЕГРЕСС-ТЕСТ — точные сигнатуры и якоря (2026-10-13)

Собиран по мелким кускам, контекст-стабильно. Кусок K1 — сигнатуры хелперов:
- `seedIdentityFixtures(t testing.TB, app *tests.TestApp) map[string]string` — http_test.go:94
- `createTestUser(t testing.TB, app *tests.TestApp, id, email, nickname string, role auth.Role, status auth.Status) string` — http_test.go:107
- `seedSecondPlayer(t testing.TB, app *tests.TestApp) (string, string)` — sprint5_test.go:22  (возвращает id, token)

Кусок K2 — паттерн прямого сидирования треда (образец: `account_isolation_test.go:395-426`):
- Получить коллекции: `app.FindCollectionByNameOrId("dm_conversations")`,
  `...("dm_members")`.
- Создать запись: `rec := core.NewRecord(coll); rec.Set("conversation_id", id); ...`
  `app.Save(rec)`.
- Удалить `users`-запись (симуляция рантайм-удаления, чтобы получить orphan-строку
  `dm_members`): `rec, _ := app.FindRecordById("users", uid); app.Delete(rec)`.
- Таблица/ответ списка декодируется из JSON-тела `listConversationsHandler`
  (`GET /api/aerun/dm/conversations`) — массив items, у каждого `peer_missing`
  (bool), `participants`, `participant_names`, `participant_avatars`.

### K3. Что должен ассертить регресс-тест (2 кейса + D3)
- **Case B — рантайм-удалённый реальный юзер (orphan-строка `dm_members` осталась):**
  удалить `users/{uid}` → `listConversations` для собеседника: тред виден,
  `peers` содержит 1 участника с пустым ником → `peer_missing:false`, история
  читается (LEFT JOIN не выбросил строку). `sendDMMessageHandler` → **403**
  (`cannot send message to a removed user`).
- **Case C — вырожденный тред (только строка вызывающего, второго участника нет):**
  `listConversations` → `peer_missing:true`. Фронт рисует плейсхолдер и НЕ
  открывает (`/messages/undefined` невозможен), только удаление через trash.
- **Контроль (оба участника живы):** `peer_missing:false`, send → 200.

---

## L. СТАТУС РЕАЛИЗАЦИИ (2026-10-13, закругление по просьбе владельца)

Решения владельца зафиксированы: **I6-b** (M2 закрываем в рантайме, импортёр
`social.go` НЕ трогаем) + D1/D3/D4 + чистка перенесена в миграцию (Firebase
прод не трогаем). Ветка `feature/pocketbase-migration`.

### L1. СДЕЛАНО в коде (правки стоят, ещё НЕ закоммичены)
- **Backend `dms.go`:**
  - `loadConversationParticipants` — INNER→**LEFT JOIN** + `COALESCE` на
    nickname/avatar → корень M2 (orphan-строка удалённого участника больше не
    выпадает из выдачи). ✅
  - `listConversationsHandler` — поле ответа **`peer_missing: len(peers)==0`**. ✅
  - `sendDMMessageHandler` — отправка удалённому → **`forbiddenError("cannot
    send message to a removed user")`** (D3). ✅
  - `gofmt` применён, `go build ./...` и `go vet ./...` чистые (проверено ранее).
- **Frontend `DirectMessages.jsx`:**
  - `openInboxConversation` — guard от `undefined` (нет навигации в
    `/messages/undefined`) (D4). ✅
  - inbox-строка — плейсхолдер имени вместо «User»
    (`Удалённый пользователь` / `Deleted user`) (D1). ✅
  - клик по строке — guard `if (peerUid)`; удаление через trash `conv.id`
    (`stopPropagation`) уже работает. ✅

### L2. ОСТАЛОСЬ (единственный незавершённый пункт — регресс-тест J3/K)
- Написать `TestInboxDeletedPeerPlaceholder` (или дописать в
  `dm_inbox_participants_test.go`) по якорям K1–K3: сидировать тред, удалить
  `users/{uid}` → ассерт `peer_missing` + плейсхолдера + send 403; контрольный
  кейс — оба живы → 200.
- Затем: `go test ./internal/platform/pocketbase/ -run <TestName>`, `gofmt -w`,
  `go vet`, коммит.
- Замечание для следующей сессии: **НЕ читать всё за раз** (контекст сжимается и
  уходит в петлю). Писать тест сразу по K1–K3, компилятор/`go test` укажут на
  неточности сигнатур.

### L3. Задок. бэклог (вне этого спринта, см. I4/I5 + Archive_Claude Review I8)
- `onUserDeleted` (functions/index.js) чистит только Auth/RTDB/forum_stats —
  не чистит users-подколлекции/posts/topics/reputation_logs/subscriptions/dms.
- `adminDeleteUserHandler` — чистый delete без каскадов (связи plain TEXT id).
- Настраиваемые плейсхолдеры «удалён/гость» в настройках форума (форма загрузки).
- soft-delete пользователей; «удалить все сообщения юзера» при удалении.
- Каскад-чистка `dm_members` при удалении юзера (чтобы orphan-строки не копились).



---

## M. ИТОГ: что уже сделано в коде, что осталось (зафиксировано 2026-10-13)

### M1. Правки УЖЕ применены (3 файла, build+vet чистые на момент сдачи)

**Backend `backend/internal/platform/pocketbase/dms.go`**
- `loadConversationParticipants` (~867): INNER JOIN → **LEFT JOIN** + `COALESCE(nickname,'')`/`COALESCE(avatar,'')`. Осиротевшая строка `dm_members` (реальный удалённый юзер) больше не выпадает — остаётся с пустым ником → история читается.
- `listConversationsHandler` (~1020): в item добавлен флаг **`peer_missing: len(peers) == 0`**. Различает два кейса: M2-оболочку миграции (строки `dm_members` для ghost нет → `peers=[]` → `peer_missing=true`) от осиротевшей строки runtime-удалённого (`peers=1`, ник пустой → `peer_missing=false`).
- `sendDMMessageHandler` (~696): гард отправки — если `other == nil` (собеседник удалён) → отказ вместо молчаливого пропуска. **D3 (backend-часть).**

**Frontend `src/components/dm/DirectMessages.jsx`**
- `openInboxConversation` (~467): guard от `undefined` — не навигируем в `/messages/undefined`. **D4.**
- Строка inbox (~1063): если `peerUid` не резолвится → имя-плейсхолдер «Удалённый пользователь» вместо «User». **D1 (имя).**
- Guard клика `if (peerUid)` (~1069): клик по вырожденной строке не открывает пустоту (удаление треда уже работает по `conv.id` через `promptDeleteConversation`). **D4.**

### M2. СДЕЛАНО в этой сессии (2026-10-13) — регресс-тест + единый аватар-плейсхолдер

1. **Регресс-тест (J3) ✅** — `backend/internal/platform/pocketbase/dm_deleted_peer_test.go`
   (`TestInboxDeletedPeerPlaceholder`). Эталон сидирования — `account_isolation_test.go:405`
   (прямой `core.NewRecord` в `dm_conversations`+`dm_members`), хелперы `seedIdentityFixtures`/
   `seedSecondPlayer`/`createTestUser`. Три подкейса, все зелёные:
   - **Case B (runtime-удалён):** сид треда на 2 участника → `app.Delete(users-record)` второго
     → список собеседника: `peer_missing=false`, `participants=[peer]`, `participantNames[peer]=""`
     (present-but-empty), `participantAvatars[peer]` есть; `GET .../messages` → 200 (история
     читается); `POST .../messages` → **403** (D3).
   - **Case C (ghost-оболочка):** тред только с `dm_members` вызывающего → `peer_missing=true`,
     `participants=[]`.
   - **Контроль (оба живы):** `peer_missing=false`, ник резолвится в «PlayerTwo», send → 200.
   - Проверено: `gofmt`, `go vet`, полный пакет `go test ./internal/platform/pocketbase/` — `ok`.
2. **Аватар-плейсхолдер (I3, D1-остаток) ✅ — единая точка `src/utils/identity.js`:**
   - `deletedDisplayName(lang)` — локализуемое имя «Удалённый пользователь» / «Deleted user».
   - `placeholderAvatarUrl(seed, size)` — единый `ui-avatars?name=U&background=666&color=fff`
     (серый «U», не DiceBear-«Guest»), одинаковый во всех поверхностях.
   - Подключён в **постах/миниатюрах** (`ForumAuthorName`: пустое имя → `deletedDisplayName`;
     `ForumAuthorAvatar`: нет имени → `placeholderAvatarUrl`; живой без фото по-прежнему
     DiceBear-by-name) и в **DM** (`DirectMessages.jsx`: inbox-строка имя+аватар, шапка чата,
     баббл — все через хелперы, инлайновый `ui-avatars`/`default-avatar` убран).
   - Признак кейса — **отсутствие имени** (forum_authors.go не декорирует удалённого → нет
     `author_name`), а не пустой id: живой участник без аватара сохраняет свои инициалы.
   - Форма загрузки кастом-плейсхолдеров в настройках форума → **бэклог (I5).**
3. **Коммит** правок — см. историю (dms.go + DirectMessages.jsx + ForumAuthorName/Avatar +
   identity.js + dm_deleted_peer_test.go + этот план).

### M3. Принципы, зафиксированные решениями владельца
- **I6-b:** M2 лечим в рантайме (плейсхолдер + блокировка + удаление), импортёр (`social.go`) НЕ трогаем. Правило «оба участника» (I6-a) — отложенная страховка.
- Общая политика C-b (I2): диалог живёт, пока существует ≥1 участник; удаление мусорного треда — через UI.
- PocketBase БД не чистим вручную (I1-часть: чистка перенесена в момент миграции дампа; прямая чистка Firebase отменена).

- PocketBase БД не чистим вручную (I1-часть: чистка перенесена в момент миграции дампа; прямая чистка Firebase отменена).

---

## N. ТОЧКА ОСТАНОВКИ I5 (сессия 2026-10-13, коммит для переноса на другую машину)

> Коммит сделан по просьбе владельца БЕЗ прогона тестов (gofmt/go vet/go test/
> eslint не запускались в этой сессии; `go build ./...` чистый — прогнан здесь же).

### N1. В КОММИТЕ (бэкенд- и API-половина I5; правки из прошлой сессии, в рабочем дереве)
- **Миграция `backend/internal/migrations/1769400000_identity_placeholder_settings.go` (новый):**
  на singleton `forum_settings` добавляет FileField `deleted_avatar`/`guest_avatar`
  (5 MB, jpeg/png/webp/gif) + Text `deleted_avatar_url`/`guest_avatar_url` (Max 512);
  `ensureField` (идемпотентно), нормализация ссылок в `""`, revert убирает 4 колонки.
- **Handler `backend/internal/platform/pocketbase/placeholder_upload.go` (новый):**
  `PUT /api/aerun/admin/settings/placeholder/{kind}` (kind = `deleted`|`guest`),
  дублирует паттерн `/me/avatar`: `readAvatarUpload` (2 MB) → `avatarFileName`
  (сниффинг байтов) → запись файла → перезапись `*_avatar_url` через
  `AvatarFilePath`; аудит `settings_updated`; повторная загрузка = replace.
  Unknown kind → 400. Двойная проверка `PermAdminAccess` внутри хендлера.
- **`run.go` (~260):** роут зарегистрирован с `RequirePermission(PermAdminAccess)`,
  БЕЗ `enforceIdempotency` (multipart > 512 KB лимита конверта).
- **`forum_settings.go`:** поля `DeletedAvatarURL`/`GuestAvatarURL` в структуре +
  чтение в `loadForumSettings`.
- **`global_settings.go`:** публичный snapshot отдаёт `deletedAvatar`/`guestAvatar`;
  PATCH принимает оба ключа (пустая строка = сброс на дефолт, как logoUrl).
- **`src/api/admin.js`:** `DEFAULT_GLOBAL_SETTINGS.deletedAvatar/guestAvatar` +
  `uploadIdentityPlaceholder(kind, blob)` (multipart PUT, обновляет кэш и шлёт
  подписчикам — форум сразу видит новую картинку).
- **`src/utils/identity.js`:** хелпер `identityAvatar({name, avatar, customPlaceholder, size})`
  (приоритет: свой аватар → кастомный плейсхолдер → дефолт); `deletedDisplayName(lang, name)`
  принимает кастомное имя из настроек.

### N2. ОСТАЛОСЬ → ВЫПОЛНЕНО (сессия 2026-10-14, фронтенд-половина I5/D2)

> Все пункты закрыты: UI-форма в `AdminPage.jsx` (секция «Плейсхолдеры
> идентичности», загрузка/сброс), `customPlaceholder` проброшен через
> `identityAvatar` во все рендер-места (`ForumAuthorAvatar`, `DirectMessages`
> inbox/шапка/баббл), i18n EN/RU, бэкенд-тест `placeholder_upload_test.go`
> (upload→файл+snapshot, access matrix, не-изображение→400, неверный kind→400,
> сброс через PATCH), check-скрипт `scripts/check-identity-placeholder.mjs`
> (в `npm test`), документация (`PROJECT_CONTEXT.md`/`PROJECT_SPEC.md`/
> `backend/README.md`). Гонки: gofmt/build/vet/`go test ./internal/platform/
> pocketbase/` зелёные; `lint:js`, `test:endpoints`, `test:jsx-comments`,
> `test:dm-mutation-state`, `test:identity-placeholder` зелёные.

<(исходный список — для истории)>
1. **UI-форма (D2) в `AdminPage.jsx` `renderSettings`:** секция загрузки двух
1. **UI-форма (D2) в `AdminPage.jsx` `renderSettings`:** секция загрузки двух
   плейсхолдеров. Готовые кирпичи: `AvatarUploader` (onUpload получает
   `(blob, filename) => …`, повторяет паттерн ProfilePage.jsx:1595) +
   `uploadIdentityPlaceholder`. Якоря вставки: после блока `logoUrl`
   (~строка 1144) или после секции `backgrounds` (~1231). Сброс к дефолту —
   отдельной кнопкой через `updateGlobalSettings({deletedAvatar:''})`.
2. **Подключить `customPlaceholder` в рендер-места** (источник — `settings` из
   `useAuth()`, AuthProvider подписан на `getGlobalSettings`):
   - `ForumAuthorAvatar.jsx` (~42-49): при пустом `fallbackName` →
     `identityAvatar({customPlaceholder: settings.deletedAvatar, …})`;
   - `DirectMessages.jsx`: inbox-строка (~1086), шапка чата (~712), баббл (~804);
   - `ForumAuthorName.jsx` (~19): имя через `deletedDisplayName(lang, settings.deletedLabel?)`
     — если имя тоже настраивается; иначе оставить локализованный дефолт.
3. **i18n `src/i18n/dictionary.js`:** ключи `admin.settings.*` для секции
   (EN-блок ~787, RU-блок ~1595): заголовок секции, названия двух картинок, help.
4. **Backend-тест `placeholder_upload_test.go`** по образцу `avatar_upload_test.go`:
   upload → файл + `/api/files/`-ссылка в snapshot; access matrix (аноним 401,
   player 403, root 200); не-изображение → 400; неверный kind → 400; сброс через
   PATCH `{"deletedAvatar":""}`.
5. **Гонки перед слитием:** `gofmt -w`, `go build ./...`, `go vet ./...`,
   `go test ./internal/platform/pocketbase/`; `npm run lint:js`;
   `npm run test:endpoints` (роут зарегистрирован — аудит должен совпасть);
   `npm run test:jsx-comments`; по желанию check-скрипт
   `scripts/check-identity-placeholder.mjs` (рендер-места используют
   `identityAvatar`, инлайновый `ui-avatars` в DM/форуме отсутствует).
6. **Документация** (правило AGENTS.md): `PROJECT_CONTEXT.md`/`PROJECT_SPEC.md` —
   новые поля настроек и эндпоинт.

### N3. Решения/ограничения, зафиксированные в этой сессии
- Фактический потолок загрузки — **2 MB** (`avatarUploadMaxBodyBytes` из
  avatar_upload.go), хотя FileField декларирует 5 MB: хендлер переиспользует
  `readAvatarUpload`. Так же у юзер-аватара — оставить, задокументировать.
- Файлы плейсхолдеров публичны (`Protected=false`, как logo): плейсхолдер —
  часть форума, которую должен видеть и гость.
- Правки из N1 лежали в рабочем дереве ещё до этой сессии; сама сессия
  только читала код (никаких новых правок в код кроме этого раздела нет).
