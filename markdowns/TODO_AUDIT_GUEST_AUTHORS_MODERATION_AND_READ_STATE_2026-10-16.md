# Аудит: гостевое авторство, модерация и непрочитанное

**Дата:** 2026-10-16  
**Статус:** архитектурный аудит незакоммиченного состояния; код намеренно не менялся.  
**Вердикт:** не наращивать отдельные `*_guest_*` поля. Нужна единая модель *автора контента* и один серверный read-cursor. Текущая попытка с `guest_nickname` полезна как аварийное направление, но в нынешнем виде она создаёт новые расходящиеся проекции.

## Журнал выполнения

| Время (America/New_York) | Статус | Запись |
|---|---|---|
| 2026-10-16 | В работе | Начата реализация плана. Перед любыми изменениями сверяются текущая ветка, чистота дерева, правила репозитория и фактический код; выводы исходного аудита не принимаются как доказательство без повторной проверки. |
| 2026-10-16 | Находка | Рабочее дерево чистое, активная ветка — `main`. Формулировка исходного раздела «незакоммиченного состояния» устарела для текущего checkout; реализация будет опираться на HEAD и отдельно фиксировать несовпадения. |
| 2026-10-16 | Находка | В актуальном коде всё ещё существуют `repairGuestNicknameSchema`, раздельные `guest_nickname`/`last_post_guest_nickname` и browser `aerun_readmap_<uid>` с best-effort серверной записью. Следовательно, приоритеты 1 и 4 остаются актуальными. |
| 2026-10-16 | Решение | Не выполнять schema/API-миграцию до фиксации четырёх продуктовых политик этапа 0. Начат сбор точных call-site и regression-test evidence, чтобы следующий change-set был совместим с legacy-поведением и не расширял модель без подтверждённого требования. |
| 2026-10-16 | Находка | `createTopicHandler` валидирует guest nickname, но записывает его только в `last_post_guest_nickname`; `topics.guest_nickname` остаётся пустым. При финальном обновлении last-post используется исходный `form.GuestNickname`, а не нормализованное значение. Это подтверждает разрыв opener-author / last-post projection. |
| 2026-10-16 | Проверка | `go test ./internal/platform/pocketbase -run '^(TestGuest(CreateTopic|Reply)ProjectsNickname|Test.*(Guest|Unread|Read))' -count=1 -v` завершён успешно: `PASS`, 36.100 s. Набор защищает guest last-post и server unread, но не проверяет `topics.guest_nickname`, nested `AuthorRef`, moderator edit/delete guest reply, opening-post policy и read cursor. |
| 2026-10-16 | Препятствие | Этап 0 требует решения владельца по политике продукта. Нельзя безопасно выбрать его из кода: текущая реализация запрещает ownership гостя по умолчанию, а вопрос удаления opening post и различения гостей влияет на права, каскад и модель данных. До ответа не будут изменены схема, права или публичный API. |

### Реестр решений этапа 0 — ожидает владельца

1. Могут ли гости редактировать/удалять **свои** публикации? Если да, требуется отдельный защищённый owner capability; nickname не будет использоваться как credential.
2. Имеет ли модератор с `delete_others_posts` право удалять opening post гостевой темы, или для этого обязательно `delete_others_topics`?
3. Считаются ли два guest-поста с разными nickname разными авторами для правила удаления темы с replies? Рекомендуемый безопасный ответ: да, без guest ownership capability их следует считать другими авторами.
4. Разрешены ли votes/reputation для guest content на уровне поста? Рекомендуемый ответ: да, без агрегирования общего рейтинга гостя.

## Краткий вывод

У гостя действительно нет `user_id`, но это не означает, что у него нет автора. У поста всегда есть **display identity**, а у зарегистрированного автора дополнительно есть **account principal** — субъект авторизации и счётчиков. Это разные понятия.

Надёжная модель:

```text
post / topic opener
├── actor_user_id nullable        — account principal; только для account
├── author_kind                   — account | guest
├── guest_display_name nullable   — только для guest, снимок на момент публикации
└── display_character_id nullable — только маска account-автора

read DTO (одна форма для UI)
└── author: { kind, user_id?, character_id?, display_name, avatar_url?, profile_id? }
```

`deleted_account` не следует записывать как ещё один вид автора: это состояние резолвинга account-id, для которого строка `users` больше недоступна. Аватар гостя и удалённого пользователя должен резолвиться централизованно из глобальных настроек, а не подменяться в каждой странице.

Для списка/главной страницы достаточно хранить `topics.last_post_id` и `last_post_created`; автора последнего поста надо получать из этого `posts`-ряда в SQL/read-model. Если при измерении нагрузки окажется нужна денормализация, копируется **ровно один AuthorRef** (`kind`, nullable account id, nullable guest name, character id), а не независимые `last_post_author_id`, `last_post_guest_nickname`, `last_post_author_character_id` с отдельными писателями. У каждой такой проекции должен быть один helper записи и один rebuild-job.

## Что проверено

- `git status`: рабочее дерево содержит незакоммиченные изменения backend/frontend и новые миграции `1769800000`, `1769900000`, тест гостевой проекции и `GUEST_PROJECTION_MAP.md`.
- Просмотрены создания, чтения, изменения и удаления тем/постов; `categoryForumProjections`; `forum_authors`; маршруты; миграции; клиентские мапперы; `topic_read_states` и тесты непрочитанного.
- Запуск `go test ./internal/platform/pocketbase/...` из `backend` не завершился за 60 секунд и был остановлен тайм-аутом без вывода. Это **не** зелёная проверка.
- `git diff --check` выявил trailing whitespace в уже изменённом `markdowns/FINDINGS_CATEGORY_PERMISSIONS_UI_ENFORCEMENT_GAP.md`.

## Текущее поведение и подтверждённые разрывы

| Область | Сейчас | Риск / результат |
|---|---|---|
| Создание guest reply | `posts.author_id = ""`, `posts.guest_nickname` валидируется; topic получает `last_post_guest_nickname`. | Это правильная минимальная семантика для самого поста. |
| Создание guest topic | Имя валидируется, но в `topics.guest_nickname` не записывается; в конце проекции берётся сырое `form.GuestNickname`. | `topicPayload` ожидает `guest_nickname`, а writer его не устанавливает. Имя автора темы и имя первого поста/last post могут разойтись, пробелы обходят нормализацию. |
| Категорийный индекс | SQL читает `last_post_guest_nickname`; frontend использует его fallback-ом для `last_post_author`. | Гостевой last poster на главной может отобразиться после появления столбца. Это лишь частичное исправление, а не единый контракт. |
| Список тем | `topicPayload` не отдаёт `last_post_guest_nickname`; `decorateTopicAuthors` декорирует только opener, не вызывает `decorateLastPostAuthor`. | Последняя реплика в topic list не имеет канонического автора; UI откатывается к `topic.author_name`. Ошибка касается и обычных пользователей/масок, не только гостей. |
| Пересчёт last post | `deletePostHandler` и `recalcTopicProjection` обновляют id/date/account id/guest name, но не обновляют/очищают `last_post_author_character_id`. | После удаления или переноса последнего masked-поста список может показывать маску удалённого автора либо не показать маску реального последнего автора. |
| Миграции | `1769800000` добавляет два поля в topics и одно в posts; down-path удаляет только `guest_nickname`, оставляя `last_post_guest_nickname`. Runtime `repairGuestNicknameSchema` тихо меняет схему при старте и только логирует ошибку. | Миграция несимметрична; applied-migration + snapshot уже не должен лечиться silent runtime-mutation. При ошибке получится работающий сервер с повреждённым контрактом. |
| Модерация guest reply | Для guest `isAuthor == false`; moderator с `edit_others_posts`/`delete_others_posts` проходит ветку «other». Пустой id безопасно игнорируется в user counters. | Редактирование и удаление обычного guest reply логически должны работать; отдельного интеграционного теста нет. |
| Первый пост гостевой темы | `DELETE /posts/:id` намеренно отвечает 409 для первого поста. У moderator нет `delete_others_topics`; удалить тему может admin/root (либо роль с этим правом). | Если «модерировать контент гостя» включает удаление стартового поста, заявленное требование сейчас не выполнено для модератора. Нужна явная продуктовая политика. |
| Каскад guest topic | `countOtherAuthorsInTopic` сравнивает только `author_id`. Для owner guest это пустая строка, поэтому все guest replies считаются тем же «автором», а разные гости неотличимы. | Можно удалить тему с репликами других гостей без `delete_own_topic_with_replies`; это следствие отсутствия author-kind/guest principal. |
| Unread backend | `topic_read_states` и единый `unreadTopicsPredicate` уже есть; index и topic list передают server `unread`. | Это правильная база: badge/feed/index согласованы на сервере. |
| Unread client | `readMap` в localStorage всё ещё обновляется и используется fallback-ом. `apiRecordTopicVisit` глотает ошибку серверной записи, а list handler молча пропускает ошибку `unreadTopicIDs`. | Ошибка API маскируется локальным «прочитано», а устаревший fallback способен снова зажечь точку. Нет гарантии немедленной инвалидации уже загруженного topic list. |
| Read position | Сервер хранит серверное «сейчас», клиент передаёт offset, который сервер не использует. | Гонка: реплика, пришедшая между загрузкой страницы и write `now`, может стать прочитанной без показа. Визуальный offset и серверное состояние различаются. |

## Почему флаг сам по себе недостаточен

Флаг `is_guest` рядом с нынешними полями не решает вопрос: всё равно остаётся вопрос, где лежит имя, что означает пустой `author_id`, как отличить deleted account от guest, как формировать avatar/profile link и как пересчитать last-post после delete/move.

Дублировать *всю* структуру гостя также не нужно. Гостю не принадлежат role, reputation, profile, signature и user avatar. Ему нужен лишь неизменяемый display name в content row и централизованный placeholder avatar. Набор display-полей аккаунта должен оставаться динамической проекцией `users`; имя гостя — исторический снимок, потому что другого источника нет.

## Целевая схема

### 1. Запись

Рекомендуемый минимальный вариант для SQLite/PocketBase:

```sql
-- posts
author_kind TEXT NOT NULL CHECK (author_kind IN ('account', 'guest')),
author_user_id TEXT NULL,
guest_display_name TEXT NULL,
display_character_id TEXT NULL,
CHECK (
  (author_kind = 'account' AND author_user_id IS NOT NULL AND guest_display_name IS NULL)
  OR
  (author_kind = 'guest' AND author_user_id IS NULL AND guest_display_name IS NOT NULL)
),
CHECK (display_character_id IS NULL OR author_kind = 'account')

-- topics: тот же AuthorRef только для opener
author_kind, author_user_id, guest_display_name, display_character_id
```

Имена существующих колонок можно сохранить на время миграции (`author_id` как `author_user_id`), но новый код не должен принимать пустую строку как тип. В DTO `null` означает отсутствие значения, а не `""`.

### 2. Last-post read model

Предпочтительный вариант:

```text
topics.last_post_id, topics.last_post_created
    -> JOIN posts AS lp ON lp.id = topics.last_post_id
    -> LEFT JOIN users / characters только для account-ветки
    -> resolveAuthor(lp)
```

Это особенно разумно здесь: `categoryForumProjections` уже выполняет SQL с window function, поэтому join одной известной строки не создаёт N+1. Нужны индексы `posts(id)` (PocketBase PK уже есть) и `posts(topic_id, created DESC, id DESC)` для выбора последнего/пересчёта.

Если нагрузочный замер докажет необходимость денормализации, в `topics` остаётся один атомарный `last_post_author_ref` (JSON либо четыре согласованных поля). Он пишется исключительно из post-record через `setLastPostProjection(topic, post)` и восстанавливается `rebuildTopicProjection(topicID)`. Никакой writer не должен вручную присваивать одну часть ref.

### 3. Public DTO

```json
{
  "author": {
    "kind": "guest",
    "user_id": null,
    "character_id": null,
    "display_name": "TestGuest",
    "avatar_url": "<guest placeholder from settings>",
    "profile_id": null
  },
  "last_post_author": { "...same shape..." }
}
```

Для account `user_id` — техническая identity/ownership; `display_name`, avatar и статус резолвятся из текущего account/character профиля. Для отсутствующего account получаем `{ kind: "deleted_account", user_id: originalId, display_name: <setting>, avatar_url: <setting>, profile_id: null }`. UI должен получать только этот DTO и не решать по пустоте id, кого назвать guest/deleted.

### 4. Авторизация гостей

Текущая модель не даёт гостю права редактировать/удалять свой материал, и это безопасный default. Если это будет продуктовой возможностью, нужен не localStorage id, а отдельный непредсказуемый owner capability в HttpOnly cookie/серверной guest-session, хранимый как hash (`guest_owner_id`/`guest_session_hash`). Он используется **только** для ownership checks, никогда не публикуется и не является display-name. Без такого capability нельзя отличить одного гостя от другого.

## Редактирование поста и смена маски

Смена маски — это изменение **display identity аккаунта для конкретного поста**, а не смена его автора: `author_user_id` остаётся прежним. Она допустима только когда редактор — владелец account-поста и имеет право `edit_self_post`; модератор с `edit_others_posts` может изменить текст чужого поста, но не его маску. У guest-поста маски быть не может.

После успешного `PATCH /posts/:id` сервер в одной транзакции обязан выполнить три независимые операции:

```text
1. posts.display_character_id = validated selected mask (or NULL)
2. если post.id == topics.last_post_id:
       заменить topics.last_post_author_ref / invalidate read-model
       → колонка «Последнее сообщение» меняет маску, имя и avatar
3. если post является opening post темы:
       заменить topics.author_ref / invalidate read-model
       → строка автора темы меняет маску, имя и avatar
```

Проверка «opening post» должна быть серверной — через тот же устойчивый порядок `(created, id)`, что list posts; клиентская нумерация страницы не является доказательством. Один пост может одновременно быть opening и last post (тема без ответов), поэтому пункты 2 и 3 не взаимоисключающие.

**Текущее состояние:** `editPostHandler` уже обновляет `last_post_author_character_id`, если редактируемый post является `last_post_id`, но не обновляет `topics.author_character_id`, если изменён первый post. Кроме того, `updateTopicForm` не принимает mask, а клиентский дополнительный `PATCH /topics` несёт только title/lock/pin. Поэтому тема с отредактированным первым постом может показывать новую маску на карточке поста и старую/обычную identity в строке темы — расходящийся read-model.

Целевой API не должен заставлять UI вызывать два несвязанных endpoint-а. Достаточно `PATCH /posts/:id` с nullable `display_character_id`; сервер возвращает:

```json
{
  "post": { "author": { "kind": "character", "display_name": "..." } },
  "topic_projection": {
    "author": { "...": "..." },
    "last_post_author": { "...": "..." }
  }
}
```

Или клиент инвалидирует topic/category/index cache после успешного ответа. Первый вариант даёт немедленный корректный render без ожидания poll; второй приемлем только при едином query-cache и гарантированной инвалидации всех трёх ключей.

## Delete/move: каскад last-post и счётчиков для тем и категорий

Да — это обязательная часть каждой мутации. У last-post две ступени: post меняет проекцию своей темы, а тема участвует в выборе последней темы своей категории.

```text
post mutation
  ├── source topic: его last post мог исчезнуть/смениться
  ├── target topic: его last post мог появиться/смениться
  └── category index: в каждой затронутой категории мог смениться topic-лидер
```

Сейчас category last-post и counters не хранятся в `categories`: `categoryForumProjections()` вычисляет их SQL-запросом по живым `topics` (`COUNT(*)` и `SUM(topics.posts_count)`). Это устраняет отдельный writer для categories, но только если topic projection пересобрана корректно и клиентский кэш инвалидирован после commit.

| Операция | Серверная транзакция | Счётчики и затронутые категории | Инвалидация клиента |
|---|---|---|---|
| Delete reply | Если удалён last post — rebuild source topic по `(created,id)`, включая полный AuthorRef. | `source.posts_count - 1`; category source при следующем read пересчитывает `posts_count`. Author's `users.posts_count - 1` только для account. Удалить votes, а их net sum снять с `users.reputation` target account. | topic, список этой категории, forum index, unread views. |
| Delete opening post / topic | Удалить topic/posts и residue; category query выберет следующий topic. | Donor: `topics_count - 1`, `posts_count - N`; для каждого account-автора удалить его N постов, для topic account-author — одну тему. Суммировать votes по target account и один раз снять соответствующую reputation до удаления vote rows. | donor list/index, counters/stats, deleted topic. |
| Move reply A → B | Переместить post и связанные refs/votes; rebuild **обеих** тем. | `A.posts_count - 1`, `B.posts_count + 1`; суммарный category posts count не меняется, если категория одна, иначе donor −1/recipient +1. User post count **и reputation** не меняются; vote rows только получают новый `topic_id`. | оба topic, обе category lists, index. |
| Move whole topic C1 → C2 | Last-post AuthorRef самой темы и `topic.posts_count` не меняются; меняется `category_id`. | C1: `topics −1`, `posts − topic.posts_count`; C2 получает те же значения. User post/topic counters и reputation не меняются. | обе category lists/index и counters/stats. |

`rebuildTopicProjection(topicID)` должен возвращать ошибку и в одном месте устанавливать/очищать полный ref **и** точный `posts_count`: `last_post_id`, `(created,id)`, `author_kind`, account id, guest name и character id. Любая ошибка должна откатить delete/move целиком. Это же правило относится к репутационным votes и account counters; пересчёт user reputation обязан давать тот же результат, что command layer.

Нельзя обновлять category-счётчики арифметикой в браузере или отдельной отложенной задачей. Источник — запрос по committed `topics`; после commit надо только инвалидировать category/index/stats cache. Если впоследствии category counters будут материализованы ради производительности, они становятся отдельной денормализованной проекцией и обязаны обновляться в **той же** транзакции с `topics.posts_count`, с idempotent rebuild-job и тестом donor/recipient.

**Текущее состояние:** `movePostsHandler` вызывает `recalcTopicProjection` для обеих тем, что верно по направлению, но helper игнорирует ошибки и не обновляет `last_post_author_character_id`; delete последнего post имеет ту же неполную пересборку. Поэтому donor/recipient topic может получить правильные id/date, но старую маску в «Последнем сообщении», а category index унаследует эту ошибку.

Ответ любой такой мутации должен возвращать `affected_topic_ids` и `affected_category_ids` (либо сервер должен публиковать эквивалентный realtime invalidation event). Это контракт инвалидации, не источник истины. Браузер не должен сам вычислять последний post категории: это требует полного порядка всех тем.

## Модерация: требуемый контракт

Модерация должна адресовать **post id**, не автора. Для guest отсутствующий account id — обычный case:

- edit чужого guest post: `edit_others_posts`; проставить moderator/editor и audit event;
- delete чужого guest reply: `delete_others_posts`; удалить votes/проекции/счётчики в одной транзакции;
- delete гостевого opening post: это delete topic, и право должно быть отдельно решено (`delete_others_topics` либо специально сформулированное moderation policy);
- audit log хранит `author_ref` (kind + nullable user id + guest display name), а не лишь пустой `author_id`.

Для `author_kind=guest` account-level `users.posts_count`, `users.topics_count` и `users.reputation` — strict no-op по типу автора, а не по случайной пустой строке. Однако **репутация гостевого поста должна быть доступна**: `posts.reputation` и vote rows сохраняются, а список оценок открывается с карточки поста. Это даёт оценку конкретного контента без выдуманного user profile. Если нужен общий рейтинг гостя между разными постами, сначала требуется стабильный guest principal/capability; один nickname для этого небезопасен.

## Unread: целевая модель

`topic_read_states` — верное направление, но timestamp «в момент write» не является подтверждением того, что пользователь увидел конкретный пост. Заменить/дополнить его cursor-ом:

```text
topic_read_states(user_id, topic_id,
                  last_read_post_id,
                  last_read_created,
                  last_read_post_tiebreak_id)
```

Клиент после успешной отрисовки посылает id последнего фактически показанного post. Сервер проверяет принадлежность теме и монотонно продвигает cursor (никогда назад). Unread predicate сравнивает `(last_post_created, last_post_id)` с этим cursor; один и тот же порядок `created, id` используется в list, goLast и rebuild projection. Так исключается гонка «новая реплика между GET и mark-read». Для legacy/перехода timestamp остаётся fallback с явной миграцией.

Клиент:

- не делает localStorage источником истины; локальное состояние — только короткий optimistic cache, который заменяется ответом сервера;
- не глотает ошибку `POST /read`: откат optimistic state, toast/retry и диагностический log;
- после write инвалидирует ключи `topic-read-state:<user>`, `topics:*`, `forum-index:<user>` через общий query/poll cache, а не надеется на навигацию/следующий таймер;
- server handler не должен скрывать ошибку `unreadTopicIDs`; отсутствие `unread` допустимо только для anonymous DTO.

## План миграции

### Этап 0 — зафиксировать решения

1. Подтвердить продуктовую политику: могут ли гости редактировать свои сообщения; может ли модератор удалять guest opening post; считаются ли разные гости «другими авторами» при каскаде; разрешены ли reputation votes для guest content.
2. Зафиксировать public JSON-contract `AuthorRef` и `ReadCursor` как ADR/API schema до переписывания UI.

### Этап 1 — schema и безопасная совместимость

1. Добавить **новую** миграцию (не изменять уже применённые `1769800000/1769900000`) с `author_kind`, nullable account id и guest display name на posts/topics, constraints/indexes.
2. Backfill: `author_id != '' -> account`; `author_id == '' AND guest_nickname != '' -> guest`; строки без обоих значений — отдельный отчёт/`legacy_unknown`, не молчаливое guest-присвоение.
3. Убрать runtime `repairGuestNicknameSchema`; заменить startup verifier, который fail-fast с понятной диагностикой, если mandatory schema не применена. Разовая snapshot repair — явная operator migration/command с отчётом.
4. Исправить down-path новых миграций симметрично либо явно объявить migration irreversible.

### Этап 2 — единый доменный слой автора

1. Ввести `AuthorRef`, `authorFromRequest`, `resolveAuthor`, `setTopicOpener`, `setLastPostProjection`/`rebuildTopicProjection`.
2. Провести через них create topic, create reply, edit mask, delete last post, move post, publish draft, import/rebuild. Удалить ручные присваивания `last_post_*`.
3. Перевести `topicPayload`, `postPayload`, category projection и frontend normalizers на nested `author`/`last_post_author`; временно можно отдавать deprecated flat fields из одного adapter-а.
4. Перевести `ForumAuthorAvatar`, `ForumAuthorName`, `AuthorMeta`, `LastPostInfo`, `TopicRow`, `MainPage` на DTO; убрать `||`-цепочки и логику «empty id = Deleted user» из компонентов.

### Этап 3 — модерация и целостность

1. Пропустить `AuthorRef` через audit log, delete/residue и user-counter helpers.
2. Добавить отдельную политику удаления opening post и безопасный UX для неё.
3. После успешной миграции удалить legacy `guest_nickname`, `last_post_guest_nickname` и raw fallbacks отдельной миграцией, только когда telemetry/backfill показывают ноль legacy rows.

### Этап 4 — read cursor

1. Добавить cursor-поля в `topic_read_states`; backfill существующих timestamp-строк как временный lower bound.
2. Изменить `POST /topics/:id/read` на `last_visible_post_id`; сервер валидирует пост и возвращает authoritative state + invalidation version.
3. Переписать unread SQL, `?goLast=1`, mark-all и topic/index DTO на один comparator `(created,id)`.
4. Удалить persisted `aerun_readmap_<uid>` после rollout. Не переносить его как факт сервера.

## Обязательная тестовая матрица

### Author/read-model

- guest создаёт тему; topic page, category list, main index и create response показывают одинаковые nick/avatar;
- account, character, guest и deleted account имеют корректный `AuthorRef` на всех четырёх поверхностях;
- reply меняет last author; delete/move последнего reply восстанавливает предыдущие account/character/guest ref;
- автор редактирует маску обычного reply: меняется post card, а last-post колонка меняется только когда этот reply последний;
- автор редактирует маску opening post: меняется post card и `topic.author` в строке темы; для темы без replies одновременно обновляется и last-post колонка;
- moderator может изменить текст чужого post, но получает 403 при попытке сменить его mask; guest post вообще не принимает `display_character_id`;
- удаление последнего account/character/guest reply пересобирает тему и category index без старых mask/name/avatar;
- перенос reply между темами, включая разные категории, пересобирает source и target topics, а donor и recipient category получают верный latest topic после invalidation;
- перенос whole topic между категориями сохраняет её last-post author, но меняет last-post колонку обеих категорий;
- delete/move проверяет `topics.posts_count`, динамические category `topics_count/posts_count`, account user post/topic counters и reputation: delete откатывает сумму удалённых votes, move её сохраняет; guest не создаёт фиктивный user counter, но сохраняет post-level reputation;
- ошибка rebuild projection откатывает delete/move целиком: недопустим moved/deleted post с прежней last-post проекцией.
- migration/backfill/rebuild идемпотентны и не создают строк без валидного author variant.

### Модерация

- moderator редактирует и удаляет guest reply: 200, audit сохраняет guest ref, нет попытки изменить user counters/reputation пустому id;
- moderator не может/может удалить guest opener ровно по принятой политике; ответ и UI совпадают;
- guest topic с reply другого guest корректно требует cascade-right, если гости считаются разными авторами;
- удаление last guest post не оставляет mask/name/avatar от удалённого last post.

### Unread

- visit topic делает `unread=false` в `GET /topics`, `GET /forum-index`, unread-count и new-replies без reload;
- ошибка mark-read не прячется local optimistic state и видна пользователю/логам;
- post, созданный между load и mark-read, остаётся unread;
- два устройства, read-all и category access дают один и тот же set;
- tests проверяют DOM marker, а не только JSON endpoint.

## Приоритет до merge текущих изменений

1. Не merge-ить runtime schema repair как постоянное решение.
2. Не merge-ить guest поддержку без интеграционных тестов moderator edit/delete guest reply и guest opening-post policy.
3. Исправить единый writer/rebuilder last-post (включая character id) либо временно не использовать маску в last-post DTO.
4. Исправить topic-list contract: сервер обязан вернуть last-post `AuthorRef`, а не рассчитывать, что клиент подменит его opener-ом.
5. После этого выбрать: короткий совместимый patch или сразу Этапы 1–2. При заявленной цели «сделать правильно» рекомендуется сразу начать с ADR + новой schema migration, а не расширять `GUEST_PROJECTION_MAP.md` ещё одним полем.
