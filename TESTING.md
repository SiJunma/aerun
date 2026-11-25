# TESTING.md — как тестирован Aerun

> **Статус:** актуально (2026-11-02). Правило: тест должен **исполнять** поведение, а не грепать текст (см. `.agent/rules/AGENTS.md`).

## Два слоя

### Фронтенд (Node, без браузера)
- `npm test` — цепочка из ~30 check-скриптов + `lint:js` (ESLint 9). Каждый скрипт — узкая регрессия конкретного инцидента/контракта.
- Скрипты: `scripts/check-*.mjs` (статические проверки исходников) и `scripts/test-*.mjs` (исполняемые, `node --test`).
- Запуск одного: `npm run test:<name>` (все имена — в `package.json`), например `npm run test:shared-poll`.
- Примеры контрактов под тестом: `first-post-guard`, `topic-delete-cleanup`, `shared-poll` (счёт запросов!), `dm-mutation-state`, `no-firebase-deps`, `no-firebase-storage`, `endpoints` (аудит эндпоинтов), `forum-read-contract`, `admin-role-authority`.
- Новая проверка: создать `scripts/check-<topic>.mjs` / `scripts/test-<topic>.mjs`, добавить `test:<name>` в `package.json` **и** в цепочку `npm test`.

### Бэкенд (Go)
- `cd backend && go test ./... -count=1` — юнит/интеграционные тесты рядом с кодом (`*_test.go`), включая миграции (`migrations_test.go`, спринт-тесты) и HTTP-контракты (httptest-серверы в `internal/platform/pocketbase/*_test.go`). Пакет `internal/platform/pocketbase` выполняется долго (~19 мин на медленной машине) — для него нужен `-timeout 30m` (таймаут Go по умолчанию — 10 мин).
- Локально перед пушем: `gofmt -l .` (должно быть пусто), `go build ./...`, `go vet ./...`. На Windows-ворккрипте следить за CRLF — см. `.agent/rules/commands.md` §Local gofmt must see LF.

## CI — внешний арбитр

`.github/workflows/backend.yml` на каждый push в `backend/**`: gofmt → build → vet → test на чистом Linux-раннере (Go из `go.mod`), отчёт — ветка `ci-report`:

```
git fetch origin ci-report
git show origin/ci-report:report.json
```

Красный отчёт блокирует дальнейшую работу. Фронтенд-цепочка `npm test` в CI не крутится — её гоняют локально перед пушем.
