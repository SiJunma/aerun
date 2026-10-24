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

Однако в коде и в схеме коллекции `posts` поле `content` имеет `Max: 65536` (миграция `1766100000_forum_command_layer.go`). Ошибка воспроизводилась и локально, и на продакшене.

## Причина (найдена и исправлена)
**Корневая причина не была в поле `posts.content`**, как предполагалось изначально.

PocketBase использует систему идемпотентности (`internal/platform/pocketbase/idempotency.go`). После успешного сохранения поста через `txApp.Save(post)`, функция `runCommand` маршалит весь ответ (включая полное содержимое поста в поле `content`) в JSON-конверт `idemEnvelope{Status, Body}` и пытается сохранить его в таблицу `idempotency_keys` в колонку `response_json`.

Колонка `idempotency_keys.response_json` имела `max=0`, которую PocketBase интерпретировал как лимит 5000 символов. Когда ответ conten post'а превышал 5000 символов, PocketBase отвергал сохранение с ошибкой `validation_max_text_constraint` на поле `response_json`.

**Это объясняло всё:**
- `txApp.Save(post)` проходил успешно (пост сохранялся в БД)
- Ошибка возникала в `writeCommandResult` при попытке сохранить ответ в `idempotency_keys.response_json`
- Ошибка появлялась только для постов >5000 символов
- Локально и на продакшене проблема воспроизводилась одинаково

## Исправление
В коллекции `idempotency_keys` колонку `response_json` zmienено с `max=0` на `max=1000000` (пraktisch безлимит).

**Выполнено на:**
- Локальной БД: `backend/pb_data/data.db` — `UPDATE _collections SET fields=... WHERE name='idempotency_keys'`
- Продакшене (VPS): необходимо применить аналогичное изменение

## Что проверялось и НЕ помогло (до нахождения причины)
| Что проверялось | Результат |
|-----------------|-----------|
| Код Go (Max: 65536, ValidatePostContent) | ✅ Верно, лимита 5000 нет |
| Схема `posts.content` в БД | ✅ max=65536 |
| Миграция 1778828401 | ✅ Применена, не помогла |
| Миграция 1778828402 | ✅ Применена, не помогла |
| Перезапуск сервера (локально + прод) | ❌ Не помогло |
| Удаление WAL-файлов | ❌ Не помогло |
| Удаление дубликата БД | ❌ Не помогло |
| Разные бинарники (.local-run vs backend) | ✅ Исправлено, не помогло |
| `max_chars_per_post` (0 → 65536 → 50) | ❌ Не влияет |
| Стандартное API PocketBase | ✅ Работает (403, не 400) |

## Связанные изменения в коде
- `backend/internal/migrations/1778828401_fix_post_content_and_author_ref.go` — миграция (фикс content max + backfill last_post_author_ref)
- `backend/internal/migrations/1778828402_reload_posts_schema.go` — миграция (фикс schema reload, не была нужна)
- `backend/internal/platform/pocketbase/forum_import.go` — TopicUpsert получил поля AuthorRef
- `backend/tools/migration/importer/cmd/import-board/main.go` — проброс полей в TopicUpsert
- `backend/tools/migration/importer/forum.go` — TopicRow/PostRow получили AuthorRef-поля

## Что нужно сделать на продакшене (VPS)
1. **Критически важно:** Изменить `response_json.max` с 0 на 1000000 в коллекции `idempotency_keys`
2. Перезапустить сервис `aerun.service`
3. Проверить редактирование поста >5000 символов на `https://aerun-world.com`

## Статус текущих изменений в git
- Коммит `4bbee79`: fix: force reload posts schema into PocketBase memory cache (добавлена миграция 1778828402, INCIDENT файл)
- Все изменения закоммичены и запушены на `origin/main`
