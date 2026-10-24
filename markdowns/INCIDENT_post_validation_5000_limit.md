# Инцидент: Ошибка валидации контента поста «Must be no more than 5000 character(s).»

## Дата
2026-10-24

## Статус
Открыт — не решено

## Описание проблемы
При редактировании поста длиннее 5000 символов сервер возвращает ошибку:
```
{
  "code": "validation_max_text_constraint",
  "message": "Must be no more than 5000 character(s).",
  "params": { "max": 5000 }
}
```

Однако в коде и в схеме коллекции `posts` поле `content` имеет `Max: 65536` (миграция `1766100000_forum_command_layer.go`).

## Воспроизведение
1. Открыть тему в веб-интерфейсе
2. Нажать «Редактировать» на любом посте
3. Ввести контент длиннее 5000 символов
4. Нажать «Сохранить»
5. Получить ошибку `validation_max_text_constraint` с `max: 5000`

## Среда
- Локальная разработка: `http://localhost:5173`, бэкенд `http://localhost:8090`
- Продакшен: `https://aerun-world.com`

## Что проверялось и делалось

### 1. Проверка кода (Go)
- Миграция `1766100000_forum_command_layer.go` определяет поле `content` с `Max: 65536` — ✅ верно
- `forum.ValidatePostContent` в `backend/internal/forum/validation.go` ограничивает `MaxPostContentLen = 65536` — ✅ верно
- Обработчики `createPostHandler` и `editPostHandler` в `forum_posts.go` вызывают `ValidatePostContent` — ✅ верно
- Нигде в коде нет жёсткого лимита 5000 для длины контента поста — ✅ подтверждено

### 2. Проверка схемы в базе данных (локально)
```sql
SELECT fields FROM _collections WHERE name='posts'
```
Поле `content`: `"max": 65536` — ✅ верно

### 3. Проверка миграций в базе
В `_migrations` применены:
- `1770000003_guest_principal_schema.go` (чужая миграция с номером 1770000003)
- `1770000004_guest_principal_content_link.go` (чужая миграция с номером 1770000004)
- `1778828401_fix_post_content_and_author_ref.go` (наша, применена)

### 4. Созданные миграции (удалены, так как номера конфликтовали)
- `1770000003_last_post_author_ref_backfill.go` — удалена, номер занят чужим файлом
- `1770000004_fix_post_content_max.go` — удалена, номер занят чужим файлом
- `1778828401_fix_post_content_and_author_ref.go` — применяется на проде и локально, фиксит `posts.content` Max → 65536 + бэктрепит `last_post_author_ref`

### 5. Перезапуск сервера
- Локально: сервер перезапущен через `npm run dev:backend` — ошибка осталась
- Продакшен: деплой через `deploy.py deploy --only backend --yes`, сервис `aerun.service` перезапущен — ошибка осталась

### 6. Удаление дубликата БД
- Удалена папка `backend/backend/pb_data` (лишняя копия) — не помогло

### 7. Добавление debug-логирования
- В `forum_posts.go` добавлен `fmt.Fprintf(os.Stderr, ...)` в `createPostHandler` и `editPostHandler` перед `txApp.Save(post)` и при ошибке сохранения
- Файл был случайно повреждён, восстановлен из `git checkout`
- Логирование пока не настроено окончательно (требуется доработка)

## Гипотезы (не проверенные)
1. **PocketBase кэширует схему в памяти при старте** и не перезагружает её после `app.Save(collection)` в миграции. Возможно, нужно полностью остановить сервер, удалить WAL-файлы (`data.db-shm`, `data.db-wal`) и запустить заново.
2. **На VPS и локально разные базы данных** — админка PocketBase может показывать одну базу, а API работать с другой.
3. **Есть какой-то промежуточный кэш или прокси** между клиентом и API, который накладывает лимит 5000.
4. **Поле `max_chars_per_post` в настройках форума** = 0 (unlimited), но可能 что-то другое переопределяет лимит на уровне коллекции.

## Что нужно сделать дальше
1. Полностью остановить сервер, удалить `data.db-shm` и `data.db-wal`, запустить заново.
2. Проверить через прямой HTTP-запрос к PocketBase API (без аутентификации через `/api/collections/posts`) реальное значение `max` у поля `content`.
3. Проверить, не накладывает ли frontend лимит 5000 через `maxLength` в `RichEditor`.
4. Если ничего не поможет — создать миграцию с ещё более высоким номером, которая явно пересоздаёт поле `content` с `Max: 65536`.

## Связанные изменения в этом инциденте
- `backend/internal/migrations/1778828401_fix_post_content_and_author_ref.go` — новая миграция (фикс content max + backfill last_post_author_ref)
- `backend/internal/platform/pocketbase/forum_import.go` — TopicUpsert получил поля LastPostAuthorKind/CharacterID/GuestDisplayName
- `backend/tools/migration/importer/cmd/import-board/main.go` — проброс новых полей в TopicUpsert
- `backend/tools/migration/importer/forum.go` — TopicRow/PostRow получили AuthorRef-поля
