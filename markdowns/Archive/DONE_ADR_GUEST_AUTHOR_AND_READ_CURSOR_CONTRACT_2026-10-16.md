# ADR: AuthorRef и ReadCursor

**Дата:** 2026-10-16  
**Статус:** принят для реализации  
**Связанная работа:** [TODO аудита](TODO_AUDIT_GUEST_AUTHORS_MODERATION_AND_READ_STATE_2026-10-16.md)

## Контекст

У guest нет account principal, но у любого опубликованного контента есть
отображаемый автор. Пустой `author_id` не может быть public API-сигналом: он не
различает guest, удалённый account и повреждённую legacy-строку. Аналогично,
timestamp записи read-state не доказывает, какой именно post пользователь видел.

## Решение

### Хранимая модель автора

`posts` и `topics` получают один и тот же `AuthorRef`:

```text
author_kind: account | guest
author_id: nullable account id
guest_display_name: nullable immutable snapshot
author_character_id: nullable mask, допустима только для account
```

Инварианты:

```text
account => author_id != null, guest_display_name == null
guest   => author_id == null, guest_display_name != null
guest   => author_character_id == null
```

В доменном DTO `null` означает отсутствие значения. В переходной PocketBase
schema старый optional text field ещё может физически читаться как `""`, но
пустая строка не служит дискриминатором варианта автора: новый код определяет
тип только по `author_kind`. Существующий `author_id` сохраняет имя на
переходный период.

Первая совместимая migration намеренно оставляет новые поля nullable: это даёт
backfill-у возможность зафиксировать повреждённые legacy rows как unclassified,
а не потерять их или придумать им guest identity. После отчёта/backfill runtime
verifier и command layer обеспечат указанные инварианты для всех новых записей.

`topics.last_post_id` и `topics.last_post_created` остаются указателем на
последний post. Автор последнего сообщения резолвится из post при чтении; любые
временные flat-поля являются совместимым адаптером, не самостоятельным источником
истины.

### Public AuthorRef

Все новые/переведённые read DTO используют одну форму:

```json
{
  "author": {
    "kind": "guest",
    "user_id": null,
    "character_id": null,
    "display_name": "Guest name",
    "avatar_url": "<guest placeholder from settings>",
    "profile_id": null
  },
  "last_post_author": null
}
```

`author.kind` в ответе принимает `account`, `guest` или `deleted_account`.
`deleted_account` — результат резолвинга отсутствующего account, а не
дополнительный persisted author-kind. Для него `user_id` содержит исходный id,
`profile_id` равен `null`, а display/avatar берутся из глобальных settings.

Поле `character_id` меняет display identity account-поста, но не ownership:
`user_id` остаётся id account. Гость не может иметь mask, profile link, account
counter или общий rating.

До удаления legacy-полей сервер временно выдаёт flat-поля из одного adapter-а.
Клиент переводится на nested DTO и не определяет автора через `||`, пустой id или
локальный fallback.

### Авторизация и reputation guest

- Guest не имеет права edit/delete собственного content в текущем flow.
- `edit_others_posts` и `delete_others_posts` действуют на guest post так же,
  как на post account; отсутствие `author_id` не является special-case.
- Votes, комментарии к ним и `posts.reputation` разрешены для guest content.
  Account-level counter и reputation при guest author — строгий no-op по
  `author_kind`.
- Возможный future-flow guest edit/delete ограниченного времени потребует
  отдельного server-side owner capability: неперезаписываемая HttpOnly cookie
  несёт секрет/идентификатор, сервер хранит лишь hash. Nickname не credential.

### ReadCursor

`topic_read_states` хранит позицию, а не время принятия запроса:

```text
user_id, topic_id,
last_read_post_id,
last_read_created,
last_read_post_tiebreak_id
```

Клиент после успешной отрисовки отправляет:

```json
{ "last_visible_post_id": "post-id" }
```

Сервер проверяет принадлежность post указанной topic, сравнивает курсоры по
единому `(created, id)` и продвигает его только вперёд. Ответ возвращает
authoritative cursor и версию для инвалидации. `unread`, `goLast`, mark-all и
topic/index list используют тот же comparator. localStorage read-map может быть
только кратким optimistic cache, но не источником истины.

## Удаление opening post

Opening post является телом topic. Его нельзя удалить отдельно: операция означает
hard-delete всей topic со всеми опубликованными posts и требует topic-permission
(`delete_self_topic`/`delete_others_topics` по subject), независимо от того,
созданы ли topic или post guest, user либо administrator. Следующий post никогда
не повышается до opener-а.

`DELETE /posts/{id}` сохраняет защитный `409` для opening post. UI направляет
пользователя к явному `DELETE /topics/{id}` и сообщает, что будут удалены тема и
её replies. Topic delete в одной транзакции settle-ит `posts_count`, user
counters, votes/reputation, subscriptions и audit согласно правилам hard-delete.

## Последствия

- Новая schema migration/backfill заменяет неявное `author_id == ""` явным
  вариантом author. Строки без account id и guest display name не получают
  молчаливое guest-назначение: их фиксирует отчёт `legacy_unknown`.
- Runtime `repairGuestNicknameSchema` удаляется после migration в пользу
  startup verifier с ясной ошибкой mandatory schema.
- Legacy `guest_nickname` и `last_post_guest_nickname` удаляются только отдельной
  миграцией после backfill и telemetry с нулём legacy rows.
