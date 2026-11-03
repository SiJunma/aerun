# MIGRATIONS.md — правила schema-миграций PocketBase

> **Статус:** актуально (2026-11-02). Каталог: `backend/internal/migrations/` (60+ файлов, sprint-история в именах).

## Железные правила

1. **Append-only.** Применённую миграцию не редактировать. Изменение схемы = новый timestamped-файл.
2. **Именование:** `NNNNNNNNNN_<тема>.go` — монотонный timestamp-префикс (например `1780000000_topic_description.go`); тесты — рядом (`<тема>_test.go` или общий `migrations_test.go`).
3. **Up + Down.** Каждая миграция регистрирует пару `m.Register(up, down)`; down обязан чисто откатывать up (см. образец `1765900000_domain_foundation.go`).
4. **PocketBase разрешён в миграциях** — единственное исключение из правила изоляции наряду с `internal/platform/pocketbase`.
5. **Браузерные правила коллекций оставлять закрытыми** (rules nil / superuser-only): весь доступ — через командный слой.
6. **Индексы и уникальность** задаются в миграции (`collection.AddIndex(..., unique, ...)`), не на клиентах.

## Шаблон

```go
package migrations

import (
    "github.com/pocketbase/pocketbase/core"
    m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
    m.Register(func(app core.App) error {
        collection := core.NewBaseCollection("example")
        collection.Fields.Add(
            &core.TextField{Name: "name", Required: true, Max: 128},
            &core.AutodateField{Name: "created", OnCreate: true},
        )
        collection.AddIndex("idx_example_name", false, "name", "")
        return app.Save(collection)
    }, func(app core.App) error {
        collection, err := app.FindCollectionByNameOrId("example")
        if err != nil {
            return err
        }
        return app.Delete(collection)
    })
}
```

## Применение и откат

- Миграции применяются **автоматически при старте** процесса (`cmd/aerun`) — ни локально, ни на VPS ручной прогон не нужен.
- Перед ручными операциями с БД — бэкап: `python deploy.py db backup` (VPS) или копия `pb_data/` (локально).
- Ручное применение/восстановление: `python deploy.py db migrate` / `db restore --file <backup>.tgz` (спросит подтверждение, остановит сервис) — только по явной просьбе человека.
- Тесты миграций: `cd backend && go test ./internal/migrations/... -count=1`.
