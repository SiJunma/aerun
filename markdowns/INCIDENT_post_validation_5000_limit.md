# Инцидент: Ошибка валидации контента поста «Must be no more than 5000 character(s).»

## Дата
2026-10-24

## Статус
РЕШЕНО ✅

## Описание проблемы
При редактировании поста длиннее 5000 символов сервер возвращал ошибку:
```
{
  "code": "validation_max_text_constraint",
  "message": "Must be no more than 5000 character(s).",
  "params": { "max": 5000 }
}
```

Аналогичная проблема с личными сообщениями >1024 символов:
```
{
  "code": "validation_max_text_constraint",
  "message": "Must be no more than 1024 character(s).",
  "params": { "max": 1024 }
}
```

## Причина (найдена и исправлена)
**Корневая причина не была в поле `posts.content`.**

PocketBase использует систему идемпотентности (`internal/platform/pocketbase/idempotency.go`). После успешного сохранения поста через `txApp.Save(post)`, функция `runCommand` маршалит весь ответ (включая полное содержимое поста в поле `content`) в JSON-конверт `idemEnvelope{Status, Body}` и пытается сохранить его в таблицу `idempotency_keys` в колонку `response_json`.

Колонка `idempotency_keys.response_json` имела `max=0`, которую PocketBase интерпретировал как **лимит 5000 символов**. Когда ответ с постом превышал 5000 символов, PocketBase отвергал сохранение с `validation_max_text_constraint` на поле `response_json` — несмотря на то, что сама запись поста уже была успешно записана в БД.

Аналогично, колонка `dm_conversations.last_message` имела `max=1024`, что блокировало длинные личные сообщения.

## Исправление
Создана миграция `1778828403_fix_idempotency_and_dm_max.go`, которая меняет:
- `idempotency_keys.response_json`: `max=0` → `max=1000000`
- `dm_conversations.last_message`: `max=1024` → `max=1000000`

## Что проверялось и НЕ помогло (до нахождения причины)
| Что проверялось | Результат |
|-----------------|-----------|
| Код Go (`posts.content` Max: 65536, `ValidatePostContent`) | ✅ Верно, лимита 5000 нет |
| Схема `posts.content` в БД | ✅ max=65536 |
| Перезапуск сервера (локально + прод) | ❌ Не помогло |
| Удаление WAL-файлов | ❌ Не помогло |
| Удаление дубликата БД | ❌ Не помогло |
| Разные бинарники (.local-run vs backend) | ✅ Исправлено, не помогло |
| `max_chars_per_post` (0 → 65536 → 50) | ❌ Не влияет |
| Стандартное API PocketBase (`/api/collections/posts/records/{id}`) | ✅ Работает (403 "Only superusers", не 400 validation) |

## Связанные изменения в коде
- `backend/internal/migrations/1778828401_fix_post_content_and_author_ref.go` — миграция (фикс `posts.content` max + backfill `last_post_author_ref`)
- `backend/internal/migrations/1778828402_reload_posts_schema.go` — миграция (форсированный `app.Save()`, не была нужна)
- `backend/internal/migrations/1778828403_fix_idempotency_and_dm_max.go` — **основная миграция исправления** (`response_json.max` 0→1000000, `last_message.max` 1024→1000000)
- `backend/internal/platform/pocketbase/forum_import.go` — TopicUpsert получил поля AuthorRef
- `backend/tools/migration/importer/cmd/import-board/main.go` — проброс полей в TopicUpsert
- `backend/tools/migration/importer/forum.go` — TopicRow/PostRow получили AuthorRef-поля

## Что нужно сделать на продакшене (VPS)
1. Применить миграцию `1778828403` (она уже задеплоена с кодом, нужно перезапустить сервер)
2. Перезапустить сервис `aerun.service` на VPS
3. Проверить редактирование поста >5000 символов и отправку длинного ЛС на `https://aerun-world.com`

## Git
- Все изменения закоммичены и запушены на `origin/main`
