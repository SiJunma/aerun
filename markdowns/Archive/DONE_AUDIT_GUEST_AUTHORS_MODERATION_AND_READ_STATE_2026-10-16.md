# Аудит: гостевое авторство, модерация и непрочитанное

**Дата:** 2026-10-16  
**Статус:** Этап 1 (`6652923`), Этап 2 (`2e1c0e6`+`b4dedaf`), Этап 3.1 (`36766ac`), Этап 3.2, гостевое создание темы (миграция `1770000006`) и Этап 4.1–4.3 (read cursor: миграция `1770000007`, `last_visible_post_id`, `(created,id)` компаратор) закоммичены. Остаток: удаление browser `aerun_readmap_<uid>` после rollout, удаление legacy-полей (`guest_nickname`, `last_post_guest_nickname`, `author_id`, `last_post_author_id`, `sequence`).
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
| 2026-10-16 | Решение владельца | Гость не может редактировать или удалять собственные публикации. Не создаём guest ownership/capability в этой поставке. Возможная отдельная future-feature — time-limited edit/delete через неперезаписываемую HttpOnly cookie и server-side hashed capability; nickname никогда не является credential. |
| 2026-10-16 | Решение владельца | Права не зависят от вида автора: удаление topic требует topic-permission, удаление обычного post — post-permission. Opening post является телом topic и удаляется только как вся topic; текущий server `409` и UI topic-delete flow — верный инвариант. |
| 2026-10-16 | Решение владельца | Любые guest-публикации считаются публикациями разных авторов для будущего ownership/cascade flow, даже при совпадающем nickname. В текущем flow это не является основанием для special-case: стабильного guest principal пока нет. |
| 2026-10-16 | Решение владельца | Votes и комментарии к reputation разрешены для guest content на уровне post. Сохраняется только post-level reputation; общий рейтинг гостя не создаётся без устойчивого principal. |
| 2026-10-16 | Завершено | Контракт принят как [ADR AuthorRef и ReadCursor](ADR_GUEST_AUTHOR_AND_READ_CURSOR_CONTRACT_2026-10-16.md). Этап 0 закрыт для author/reputation/read-cursor; следующий change-set начинается с migration/backfill. |
| 2026-10-16 | Решение владельца | Уточнён final rule для opening post: он никогда не удаляется отдельно и не заменяется следующей репликой. `DELETE /posts/{opening}` остаётся `409`; только `DELETE /topics/{id}` с topic-permission выполняет hard-delete topic, posts и residue. |
| 2026-10-16 | В работе | Добавлена новая migration `1770000000_author_ref_schema`: поля `author_kind` (`account`/`guest`) и `guest_display_name` для `posts`/`topics`, индекс по variant и idempotent backfill. Уже применённые `1769800000/1769900000` не изменялись. |
| 2026-10-16 | Находка и исправление | Первый migration-test дал ложный fail: он читал объекты `core.Record`, загруженные до `app.Save`, вместо строк после backfill. Тест исправлен повторным чтением по id; это проверяет именно persisted state, а не память handler-а. |
| 2026-10-16 | Проверка | `go test ./internal/migrations -run '^(TestAuthorRefSchemaBackfillsKnownAuthorsWithoutInventingGuests|TestMigrationsProduceHealthyApp|TestMigrationsAdoptPopulatedDataDir)$' -count=1 -v` — `PASS`, 7.432 s. Backfill назначает account/guest только доказуемым legacy-строкам, trims guest display name и оставляет строку без id/name unclassified. |
| 2026-10-16 | Выполнено | New-write paths `create topic`, `create reply`, draft и forum import переведены на единые helpers `setAccountAuthorRef`/`setGuestAuthorRef`. Guest topic теперь также записывает нормализованное имя в `topics.guest_nickname`; final last-post legacy projection получает значение из сохранённого AuthorRef, а не из сырого request body. |
| 2026-10-16 | Проверка | `go test ./internal/platform/pocketbase -run '^(TestGuestCreateTopicProjectsNickname|TestGuestReplyProjectsNickname)$' -count=1 -v` — `PASS`, 9.768 s. Тесты расширены: guest topic, opening post и reply обязаны иметь persisted `author_kind=guest` и `guest_display_name`. |
| 2026-10-16 | Проверка | `go test ./internal/migrations -count=1` — `PASS`, 18.370 s; import/draft regression-набор — `PASS`, 11.076 s; `go build ./...` и `go vet ./...` из `backend` завершились успешно. `git diff --check` чист; Git сообщает только о будущей конвертации LF→CRLF в TODO-файле. |
| 2026-10-16 | Выполнено | Этап 1.3 закрыт: silent `repairGuestNicknameSchema` удалён из `forum_topics.go` и `run.go`. Boot теперь fail-fast через `verifyAuthorRefSchema` в `forum_author_ref.go`: проверяются `author_id`, `guest_nickname`, `last_post_guest_nickname` (topics), `author_kind`, `guest_display_name` на posts/topics. Разовый snapshot-repair вынесен в явную операторскую миграцию `1770000001_author_ref_snapshot_repair` с отчётом (restored columns + unclassified rows), revert — deliberate no-op. |
| 2026-10-16 | Проверка | `go build ./...` — успешно; `go vet ./internal/migrations/ ./internal/platform/pocketbase/` — чисто; `go test ./internal/migrations -run '^(TestAuthorRefSchemaBackfillsKnownAuthorsWithoutInventingGuests|TestAuthorRefSnapshotRepairRestoresSnapshotColumns|TestMigrationsProduceHealthyApp|TestMigrationsAdoptPopulatedDataDir)$' -count=1 -v` — `PASS`, 10.133 s; `go test ./internal/platform/pocketbase -run '^(TestVerifyAuthorRefSchemaRejectsAnUnmigratedDataDir|TestGuestCreateTopicProjectsNickname|TestGuestReplyProjectsNickname)$' -count=1 -v` — `PASS`, 9.543 s. |
| 2026-10-16 | В работе | Следующий шаг — Этап 2: единый доменный слой автора (`AuthorRef`, `authorFromRequest`, `resolveAuthor`, `setTopicOpener`, `setLastPostProjection`/`rebuildTopicProjection`) и перевод `topicPayload`/`postPayload`/category projection на nested `author`/`last_post_author`. |
| 2026-10-16 | Завершено | Этап 1 закоммичен как `6652923 feat(forum): AuthorRef schema, backfill and fail-fast boot guard (audit stage 1.3)` — 14 файлов, дерево чистое. Начат Этап 2 с инвентаризации всех writer-ов last-post проекции. |
| 2026-10-16 | В работе | Этап 2.1: инвентаризация writer-ов завершена. Найдено 7 точек ручной записи `last_post_*`: `createTopicHandler` (forum_topics.go:225-230), `createPostHandler` (forum_posts.go:236-246), `publishDraftHandler` (drafts.go:356-363), `editPostHandler` mask-branch (forum_posts.go:747-755), `deletePostHandler` inline-recalc (forum_posts.go:949-972), `recalcTopicProjection` для move (forum_posts.go:1086-1120), `applyTopicUpsert` import (forum_import.go:360-370). Только `recalcTopicProjection` игнорирует ошибки (`_ =` на COUNT/Save) и не трогает `last_post_author_character_id` + AuthorRef-поля. |
| 2026-10-16 | Находка | Разрыв opener/last-post подтверждён кодом: `createTopicHandler` пишет opener AuthorRef через helpers, но last-post проекция собирается вручную из 5 `Set` (id/created/author_id/character/guest_display). `deletePostHandler` дублирует тот же набор inline вместо вызова `recalcTopicProjection`, а `recalcTopicProjection` сам неполон — итого 3 расходящиеся реализации одного инварианта. |
| 2026-10-16 | Выполнено | Этап 2.2 закрыт: введён единый доменный слой в `forum_author_ref.go` — `AuthorRef`, `authorRefFromRecord`/`lastPostRefFromRecord`, `setTopicOpener`, `setLastPostProjection`, `clearLastPostProjection`, `rebuildTopicProjection` (возвращает error). Все 7 writer-ов переведены: create topic/reply, publish draft, edit mask, delete (inline-recalc удалён), move source/target (старый `recalcTopicProjection` с `_ =` удалён). Новая migration `1770000002_last_post_author_ref_schema` (`last_post_author_kind` + `last_post_guest_display_name` + backfill от post-варианта), verifier и snapshot-repair расширены на новые поля. |
| 2026-10-16 | Выполнено | Этап 2.3 закрыт: `topicPayload`/`postPayload` отдают nested DTO `author` и `last_post_author_ref` (ADR контракт); `syncAuthorDTO` зеркалит resolución flat→nested (один адаптер, disagreement невозможен); `decorateTopicAuthor` теперь декорирует last-post автора (исправлен дефект topic-листа: fallback к opener); `decorateLastPostAuthor` зеркалит resolved nickname в nested DTO. Тест `TestNestedAuthorDTOsCarryTheAdrContract` (гость-открыл топик → reply.account: opener=guest, last-post=account с user_id и display_name). |
| 2026-10-16 | Проверка | `go build ./...` и `go vet ./...` — чисто; `go test ./internal/migrations -count=1` — `PASS`; `go test ./internal/platform/pocketbase -count=1` (включая TestNestedAuthorDTOsCarryTheAdrContract, TestRebuildTopicProjectionRestoresGuestAfterMaskedDelete, TestCategoryIndexNamesTheMaskOfTheLastPost, TestMovePostsBetweenTopics, TestGuestCreateTopicProjectsNickname, TestVerifyAuthorRefSchema) — `PASS`, 23.4–84.4 s. |
| 2026-10-16 | Выполнено | Этап 2.4 закрыт. Backend: `decorateLastPostAuthor` — единственное место, строящее публичный nested `last_post_author_ref` (guest → `{kind, display_name}`, deleted → `null`, account → `{kind, user_id, profile_id, display_name (mask-aware), character_id, avatar_url}`), так что category index и topic-листы не могут разойтись; добавлены `TestCategoryIndexLastPostRefGuest` и account-assertions в mask-тест. Frontend: `toCategory` читает nested `last_post_author_ref` вместо `|| last_post_guest_nickname`; `ForumAuthorName`/`ForumAuthorAvatar`/`AuthorMeta`/`LastPostInfo` принимают `author` DTO (flat props — backward-compat), `||`-цепочки заменены на `??`; `TopicRow`/`MainPage` передают `topic.author`/`last_post_author_ref`. Гейты `check-forum-read-contract.mjs` (`last_post_author` → `last_post_author_ref`) и `check-drafts-and-settings.mjs` (publish должен звать `setLastPostProjection` — механизм изменился в 2.2, намерение то же) обновлены вместе с контрактом. |
| 2026-10-16 | Проверка | Go: `go build ./...`, `go vet` — чисто; `go test ./internal/platform/pocketbase -run 'TestCategoryIndex...'` — `PASS`, 8.8 s. Frontend: `npm run test` (полный набор, ~20 гейтов + `lint:js`) — exit 0; eslint по всем изменённым файлам — exit 0; `node scripts/check-forum-read-contract.mjs` — все OK. |
| 2026-10-16 | Выполнено | Этап 3.1 закрыт: в `deletePostHandler` и `editPostHandler` (`forum_posts.go`) счетчики и репутация автора движутся только при `author_kind == account` (no-op по kind, а не по пустому id); запись аудита `post_delete`/`post_edit` несет `author_kind` + `guest_display_name` (guest post по author_id пуст по контракту, иначе запись атрибутировалась бы «никому»). Новый файл теста `forum_author_ref_moderation_test.go`: `TestModeratorModeratesGuestReply` (редактирование гостевого ответа модератором, editor_id, аудит ref), `TestModeratorDeletesVotedGuestReply` (удаление → не сдвигается ни один users.counter, удалены vote-строки поста, last-post projection возвращается к opener без гостевой маски/имени). Найден и зафиксирован как поиск: голосование за гостевой пост невозможно через команду (`ValidateReputationVote` требует непустой target + `reputation_votes.target_id` required). |
| 2026-10-16 | Проверка | `go build ./...`, `go vet` — чисто; `go test ./internal/platform/pocketbase -run 'TestModeratorModeratesGuestReply|TestModeratorDeletesVotedGuestReply|TestCategoryIndex...'` — `PASS`. |
| 2026-10-16 | Выполнено | Этап 3.2 закрыт: миграция `1770000003` создаёт коллекцию `guest_principals` (guest_id, capability_hash, last_used_at); `1770000004` добавляет `guest_principal_id` на posts/topics; `1770000005` делает `reputation_votes.target_id` nullable (Max 64) для голосов за гостевой контент. `POST /api/aerun/guest/principal` создаёт гостевого principal с HttpOnly cookie (`guest_id:secret`, secret не хранится в открытом виде — только sha256); repeat-запрос — нет‑оп (principal привязан к первому браузеру). `guestPrincipalFromRequest`/`guestPrincipalIDFromRequest` извлекают principal из cookie с проверкой хеша. `createTopicHandler`/`createPostHandler` пишут `guest_principal_id` для гостевого контента. `votePostHandler` голосует за гостевой пост на `guest_principal_id`, не выплачивая account‑репутацию. `VerifyAuthorRefSchema` и snapshot‑repair расширены на новые поля. |
| 2026-10-16 | Проверка | `go build ./...`, `go vet` — чисто; `go test ./internal/platform/pocketbase -run 'TestGuestPrincipalCreationIsPinned|TestVerifyAuthorRefSchemaRejectsAnUnmigratedDataDir|TestGuestCreateTopicProjectsNickname|TestGuestReplyProjectsNickname|TestCategoryIndex...'` — `PASS`; полный набор `./internal/platform/pocketbase` — `PASS`. |
| 2026-10-16 | В работе | Этап 3.2: открытие темы гостем через те же helpers (setGuestAuthorRef + setTopicOpener), гостевое `last_post` projection в createTopicHandler уже через unified writer (этап 2.2). Этап 4: read cursor (`topic_read_states`, `last_visible_post_id`, `(created,id)` компаратор, инвалидация, удаление browser `aerun_readmap_<uid>`). |

### Реестр решений этапа 0 — принят 2026-10-16

1. Гости не редактируют и не удаляют собственные публикации. Возможный future-flow со сроком (например, до часа) потребует отдельной server-side capability; HttpOnly cookie хранит лишь неперезаписываемый секрет/идентификатор, на сервере хранится hash. Это не часть текущей миграции.
2. Удаление topic регулируется topic-permission; удаление обычного post — post-permission, вне зависимости от того, гость это, пользователь или администратор. Opening post — тело topic и удаляется только через topic delete.
3. Любые гостевые публикации считаются разными авторами независимо от nickname; nickname не уникален и не является identity. До появления отдельного guest principal это не меняет текущий cascade flow.
4. Votes, comments и post-level reputation для guest content разрешены. Никакого cross-post guest reputation без устойчивого guest principal.

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
| Первый пост гостевой темы | `DELETE /posts/:id` намеренно отвечает 409 для первого post, а `DELETE /topics/:id` требует `delete_others_topics` для чужой topic. | Подтверждено владельцем: это корректный инвариант. Opening post — тело topic; его удаление означает hard-delete всей topic и требует topic-permission независимо от вида автора. |
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
| Delete opening post / topic | Opening post не удаляется отдельно: `DELETE /topics` с topic-permission удаляет topic/posts и residue; category query выберет следующий topic. | Donor: `topics_count - 1`, `posts_count - N`; для каждого account-автора удалить его N постов, для topic account-author — одну тему. Суммировать votes по target account и один раз снять соответствующую reputation до удаления vote rows. | donor list/index, counters/stats, deleted topic. |
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
- delete guest opening post: это delete topic и требует `delete_others_topics` для чужой topic; `DELETE /posts/{opening}` остаётся 409;
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

1. [x] Подтверждена продуктовая политика: гости не редактируют/удаляют свои сообщения; guest opening post удаляется только как topic по topic-permission; guest publications различаются независимо от nickname; reputation votes разрешены для guest content.
2. [x] Public JSON-contract `AuthorRef` и `ReadCursor` зафиксирован в [ADR](ADR_GUEST_AUTHOR_AND_READ_CURSOR_CONTRACT_2026-10-16.md) до переписывания UI.

### Этап 1 — schema и безопасная совместимость

1. [x] Добавлена **новая** migration `1770000000` (без изменения применённых `1769800000/1769900000`) с `author_kind`, `guest_display_name` и индексом на posts/topics. Полная cross-field enforcement/mandatory verifier ещё впереди: на переходный период поля nullable, чтобы не потерять legacy unknown rows.
2. [x] Backfill: `author_id != '' -> account`; `author_id == '' AND guest_nickname != '' -> guest`; строки без обоих значений остаются unclassified и логируются, а не получают молчаливое guest-присвоение.
3. [x] Убран runtime `repairGuestNicknameSchema`; добавлен startup verifier `verifyAuthorRefSchema` (fail-fast, если mandatory schema не применена). Разовая snapshot repair — явная операторская migration `1770000001_author_ref_snapshot_repair` с отчётом.
4. [x] Down-path `1770000000` симметрично удаляет новые поля и их индексы; legacy поля не меняются.

### Этап 2 — единый доменный слой автора

1. [x] Введены `AuthorRef`, `authorRefFromRecord`/`lastPostRefFromRecord`, `setTopicOpener`, `setLastPostProjection`/`rebuildTopicProjection` (возвращает error) в `forum_author_ref.go`.
2. [x] Все 7 writer-ов переведены: create topic/reply, publish draft, edit mask, delete (inline-recalc удалён), move source/target, import/rebuild. Ручные присваивания `last_post_*` удалены; migration `1770000002` добавила `last_post_author_kind`/`last_post_guest_display_name` с backfill.
3. [x] `topicPayload`/`postPayload` отдают nested `author`/`last_post_author_ref`; `categoryForumProjections` строит тот же nested ref через `decorateLastPostAuthor` (единый адаптер); flat-поля остаются deprecated-копиями. `normalizeTopic`/`normalizePost` прокидывают nested через spread.
4. [x] `ForumAuthorAvatar`/`ForumAuthorName`/`AuthorMeta`/`LastPostInfo` принимают `author` DTO (flat props — backward-compat fallback); `||`-цепочки заменены на `??` (`author?.display_name ?? fallbackName ?? deletedDisplayName(lang)`); `TopicRow`/`MainPage` читают `last_post_author_ref` вместо `last_post_author || author_name`.

### Этап 3 — модерация и целостность

1. Пропустить `AuthorRef` через audit log, delete/residue и user-counter helpers.
2. Добавить отдельную политику удаления opening post и безопасный UX для неё.
3. После успешной миграции удалить legacy `guest_nickname`, `last_post_guest_nickname` и raw fallbacks отдельной миграцией, только когда telemetry/backfill показывают ноль legacy rows.

### Этап 4 — read cursor

1. [x] Добавлены cursor-поля в `topic_read_states` (миграция `1770000007`: `last_read_post_id`, `last_read_created`, `last_read_post_tiebreak_id`). Legacy timestamp-строки без cursor-полей читаются как временный lower bound через fallback `COALESCE(last_read_created, last_read_at)`.
2. [x] `POST /topics/:id/read` принимает `last_visible_post_id`; сервер валидирует принадлежность поста топику, пинит курсор к `(created, id)` поста, возвращает authoritative state + `invalidation_version` (`topics.last_post_created`). Пустое тело (legacy-клиент) фоллбэчится на timestamp «now».
3. [x] Unread SQL (`unreadTopicsPredicate`), `?goLast=1` (`resolveListPage`) и mark-all переведены на один comparator `(created,id)`; fallback-цепочка `COALESCE(last_read_created, last_read_at, users.created, t.last_post_created)` сохраняет legacy-семантику для строк без курсора. Фронтенд (`recordTopicVisit`/`markTopicRead`) отправляет `last_visible_post_id` последнего реального (не оптимистического) поста страницы.
4. [ ] Удалить persisted `aerun_readmap_<uid>` после rollout. Не переносить его как факт сервера. Остаётся как краткий optimistic cache для row-indicators.

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

## Дополнительные выводы после сверки с кодом (2026-10-17)

### 1. Новые `*_guest_*` поля — резонно ли их добавление

**Да, добавление обосновано как переходная мера, но оно должно быть временным.**

Что фактически добавлено (миграции `1770000000`–`1770000005`):
- `author_kind` / `last_post_author_kind` — дискриминатор `account`|`guest`, без него пустой `author_id` не distingueт гостя от удалённого account или битой legacy-строки.
- `guest_display_name` / `last_post_guest_display_name` — отображаемое имя гостя, снимок на момент публикации.
- `guest_principal_id` — ссылка на коллекцию `guest_principals` для стабильной браузерной идентичности гостя (HttpOnly cookie, capability_hash).

Поля остаются **рядом** с legacy `guest_nickname` / `last_post_guest_nickname` / `author_id` / `last_post_author_id`, которые пока не удалены. Flat-копии в DTO (`topicPayload`, `postPayload`) emit-ся как deprecated-компатибельность.

**Почему нельзя было обойтись без них:** без `author_kind` сервер не может надёжно определить variant автора; без `guest_principal_id` нельзя различить гостей для ownership/cascade и голосов. ADR (`ADR_GUEST_AUTHOR_AND_READ_CURSOR_CONTRACT_2026-10-16.md`) явно предписывает удалить legacy поля отдельной миграцией после backfill и подтверждения нуля legacy rows — это ещё не сделано.

### 2. Устаревшие поля, от которых надо избавиться

Пользователь прав: от legacy-полей нужно смело избавиться, локалка — песочница, новую БД можно накатить по новым скриптам.

Поля под удаление после перехода на AuthorRef — удалены миграцией `1770000008_drop_legacy_columns` (закоммичена):

- `posts.guest_nickname`, `topics.guest_nickname` — заменены на `posts.guest_display_name` / `topics.guest_display_name` (AuthorRef).
- `topics.last_post_guest_nickname` — заменён на `topics.last_post_guest_display_name` (AuthorRef).
- `posts.sequence` — заменён на сортировку по `created ASC, id ASC`; убран уникальный индекс `idx_posts_topic_sequence`.

**Не удалялись** (живая часть AuthorRef-модели по ADR):
- `posts.author_id`, `topics.author_id`, `topics.last_post_author_id` — несут account id для account-авторов; `author_kind` — дискриминатор, `author_id` — значение.
- `posts.author_character_id`, `topics.last_post_author_character_id` — маска account-автора.
- `topics.first_post_pinned` — флаг закрепления opening post.

`verifyAuthorRefSchema` обновлён: больше не требует удалённых колонок `guest_nickname` / `last_post_guest_nickname`. `backfillAuthorRefs` (миграция 1770000000) читает `guest_display_name` с фоллбэком на `guest_nickname` для совместимости со старыми снимками.
### 3. Opening-post policy и разрешения на удаление тем

Код в `deleteTopicHandler` (`forum_topics.go:791`) реализует три сценария, соответствующие заявленным разрешениям:

| Сценарий | Требуемое разрешение | Код |
|----------|---------------------|-----|
| Чужая тема | `delete_others_topics` (админы/root) | `!isAuthor && !Has(delete_others_topics)` → 403 |
| Своя тема без чужих ответов | без разрешения | `isAuthor` и `countOtherAuthorsInTopic == 0` → разрешено |
| Своя тема с чужими ответами | `delete_own_topic_with_replies` | `isAuthor` и `countOtherAuthorsInTopic > 0` и `!Has(delete_own_topic_with_replies)` → 409 |

**Нюанс с гостями:** для гостя `e.Auth == nil`, следовательно `isAuthor == false` всегда. Гость попадает в ветку `!isAuthor` и нуждается в `delete_others_topics`, которого у гостя нет. Гость **не может удалить свою тему ни при каких условиях** — это соответствует политике «гость не редактирует и не удаляет собственные публикации», но стоит зафиксировать явно: гостевые темы удаляются только модератором/админом через `delete_others_topics`.

**Нюанс с `countOtherAuthorsInTopic`:** функция считает `COUNT(DISTINCT author_id) WHERE author_id != excludeAuthorID`. Для гостевой темы все посты (и opening, и ответы) имеют `author_id = ""`, поэтому `author_id != ""` отфильтровывает их все — функция возвращает 0. Это корректно для подсчёта *account*-участников, но для гостевых топиков «чужие ответы» от других гостей не учитываются. Поскольку гости и так не могут удалять темы, это не создаёт лазейки, но стоит иметь в виду.

### 4. Ошибка «Failed to create topic.» у гостя — причина найдена

Ошибка confirma: `author_id: cannot be blank` — поле `author_id` в коллекции `topics` имеет `Required: true` (установлено в миграции `1766100000_forum_command_layer.go`). Для гостя `createTopicHandler` пишет `author_id = ""` через `setGuestAuthorRef`, и PocketBase отвергает запись.

Исправление уже есть в коде: миграция `1769900000_post_author_id_optional.go` ставит `textField.Required = false` для `author_id` на обеих коллекциях (`posts` и `topics`). Она **должна быть применена к локальной БД** перед проверкой гостевого создания топика.

Что нужно сделать:
- Перезапустить PocketBase сервер — он автоматически применит pending-миграцию `1769900000`, если она ещё не отработала на этой БД.
- Проверить, что `author_id` на `topics` и `posts` имеет `Required = false` (через PocketBase admin UI или код).

После этого `setGuestAuthorRef(topic, …)` с `author_id = ""` пройдёт валидацию, и создание топика гостем заработает.

**Что проверено в коде гостевой ветки `createTopicHandler`:**
- `setGuestAuthorRef(topic, guestNickname)` — устанавливает `author_id=""`, `author_kind="guest"`, `guest_display_name=guestNickname`.
- Legacy поля `topic.Set("guest_nickname", …)`, `topic.Set("last_post_guest_nickname", …)` — заполняются.
- `topic.Set("guest_principal_id", guestPrincipalIDFromRequest(e))` — может быть `""`, если гость ещё не вызвал `POST /api/aerun/guest/principal`. Поле не Required, пустая строка допустима.
- `topic.Set("author_character_id", "")` — для гостя пусто, корректно.

**Почему post creation works, а topic creation fails:** в коде пути почти идентичны, но в topic creation перед первым `txApp.Save(topic)` вызывается `categoryWriteAllowed` — если категория не выдана гостю, возвращается `forbiddenError`, а не `internalError`. Ошибка `author_id: cannot be blank` подтверждает, что проблема именно в схеме (Required=true), а не в правах доступа.

**Статус 2026-10-17: ошибка решена.** Добавлена миграция `1770000006_fix_author_id_required`, которая безусловно ставит `author_id.Required = false` на обеих коллекциях (`posts`, `topics`). После применения миграции гостевое создание топика работает. Оставшаяся причина неудачи на некоторыхデーта-дирах — база восстановлена из снимка, где миграция `1769900000` числится как применённая, но поле реально осталось Required; миграция `1770000006` исправляет это.

### 5. Триггеры обновления last-post при удалении/переносе/редактировании/смене маски/никнейма

Проверено по коду (`forum_author_ref.go`, `forum_posts.go`, `forum_topics.go`):

| Событие | Обработка | Статус |
|---------|-----------|--------|
| Удаление последнего поста в теме | `deletePostHandler` → `rebuildTopicProjection(txApp, topic)` — пересобирает полную проекцию (id, created, kind, account id, guest name, mask, posts_count). Ошибка ребилда откатывает весь delete. | ✅ Реализовано |
| Перенос поста между темами | `movePostsHandler` → `rebuildTopicProjection` для source и target topic. | ✅ Реализовано |
| Перенос whole topic между категориями | `last_post` темы не меняется (меняется только `category_id`), category index пересобирается через `categoryForumProjections` | ✅ Реализовано |
| Редактирование последнего поста со сменой маски | `editPostHandler`: если `topic.last_post_id == postID`, вызывает `setLastPostProjection(topic, post)` — маска копируется из post row через единый writer. | ✅ Реализовано |
| Смена никнейма account-автора (профиль) | **Триггер не требуется.** Имя аккаунта не хранится в посте/топике: `category_access.go` пишет в проекцию только `last_post_author_id` (ID, не имя), а имя резолвится из `users` при чтении (`decorateTopicAuthors` / фронтенд). Статы форума (онлайн, активные за сутки) считаются по `users.last_seen` (`category_access.go:dailyActiveMembers`), не по именам в постах. Смена ника в профиле автоматически отражается на всех поверхностях при следующем чтении. | ✅ Не требуется |
| Смена никнейма гостя | Неприменим — гостевой nickname immutable, снимок на момент публикации, его нет в `editPostForm`. | — |
| Редактирование тайтла opening post / топика | `updateTopicHandler` (`forum_topics.go:654-673`) — валидация + `topic.Set("title", newTitle)` + `txApp.Save(topic)`. Category index читает `title` прямо из `topics` через SQL (`category_access.go:216`), нет отдельного кэшированного документа, который нужно инвалидировать. Бэкенд-триггер не требуется; stale-данные возможны только во фронтенд-кэше (уже загруженная страница у конкретного пользователя). | ✅ Реализовано (read-through) |
| Редактирование последнего поста (не opening) | `editPostHandler`: если отредактированный пост — последний в теме, `setLastPostProjection` обновит last-post проекцию топика. Тайтл топика не меняется. | ✅ Реализовано |

**Вывод:**

Триггеры на удаление, перенос и смену маски последнего поста присутствуют и работают через `setLastPostProjection`/`rebuildTopicProjection`.

**Смена никнейма account-автора не требует триггера ни на категории, ни на статы:**
- Category index хранит `last_post_author_id` (ID, не имя) — имя резолвится из `users` при чтении.
- Статы (онлайн/активные за сутки) считаются по `users.last_seen`, не по именам в постах.
- Гостевой nickname immutable — его нельзя сменить, триггер не применим.

**Редактирование тайтла топика не требует отдельного бэкенд-триггера инвалидации:**
- Category index читает `topics.title` напрямую через SQL при каждом построении проекции (`categoryForumProjections`). Нет отдельного кэшированного документа категории, который нужно было бы инвалидировать при смене тайтла.
- Stale-данные возможны только на фронтенде (уже загруженная страница у конкретного пользователя) — это проблема клиентского кэша, не бэкенд-триггера.

**Что стоит иметь в виду:** если в будущем добавится возможность гостю сменить nickname, понадобится триггер, который пройдёт по всем topic-строкам, где этот гость является `last_post` автором, и обновит `last_post_guest_nickname`. Сейчас такой возможности нет.

### Build version в серверных ошибках

Добавлено в `backend/internal/platform/pocketbase/errors.go`:

- Переменная `buildVersion` (по умолчанию `"dev"`), инжектится при сборке через `-ldflags "-X github.com/SiJunma/aerun/backend/internal/platform/pocketbase.buildVersion=1.2.3"`.
- В `applyErrorContract` (единая точка входа для всех `/api/aerun` ошибок) в каждый ответ ошибки добавляется поле `apiErr.Data["build"] = buildVersion`.

Теперь каждая серверная ошибка выглядит примерно так:

```json
{
  "data": {
    "kind": "internal",
    "retryable": true,
    "conflict": false,
    "forbidden": false,
    "validation": false,
    "request_id": "WUKM5ehluiuXITki",
    "build": "1.2.3"
  },
  "message": "author_id: cannot be blank.",
  "status": 500
}
```

Это позволяет мгновенно отличить ошибку в коде от ошибки из-за того, что сервер запущен со старой сборкой (не применились миграции, схема не синхронизирована и т.п.).

### Коммиты вне плана (не отражены в статусе документа)

- `a2c4102` `fix(forum): dispatch quote and reply notifications for guest posts` — нотификации гостевых постов, не в статусе документа.
- `43307f3` `fix(forum): sync category and topic unread indicators with local visits and realtime signals` — фронтенд: `AuthProvider.jsx`, `MainPage.jsx`, `TopicRow.jsx` + перемещение `ARCHIVE_FINDINGS_GUEST_PROJECTION_MAP.md`. Не в статусе документа, относится к клиентской части read-state (Этап 4).
