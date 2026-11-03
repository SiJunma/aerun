# Обзор документации и план по BMAD-состоянию проекта

> ✅ **ВЫПОЛНЕНО / ЗАКРЫТО 2026-11-02** — весь план (§4, §8.4) выполнен: созданы `PROJECT_CONTEXT.md`, `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `API.md`, `NEW_INSTANCE.md`, `TESTING.md`, `SECURITY.md`, `MIGRATIONS.md`, `I18N.md`, `RUNBOOK.md`, `.agent/rules/documentation_maintenance.md`; `AGENTS.md` реконструирован под текущий стек. Действующая документация перечислена в карте `PROJECT_CONTEXT.md` §6. Документ перемещён в архив по правилам `.agent/rules/documentation_maintenance.md` §3.

**Дата:** 2026-11-02  
**Проект:** Aerun Forum Engine  
**Путь:** G:\Stacionar\WEB\My Web Sites\forum-Aerun  
**Стек:** Go 1.27 + PocketBase (SQLite) + React 19 + Vite

---

## 1. Что сделано в этой сессии

### Цель
Пометить устаревшие markdown-файлы, которые всё ещё описывают **Firebase** как текущий стек, чтобы ИИ-агенты не использовали их как спецификацию для текущих задач. Проект уже полностью переведён на **Go 1.27 + PocketBase (SQLite)**.

### Изменённые файлы (7 шт.)

| # | Файл | Что добавлено | Зачем |
|---|------|---------------|-------|
| 1 | `.agent/rules/AGENTS.md` | Блок-предупреждение `⚠️ ОТРЕДАКТИВНО / LEGACY FIREBASE` + лейбл в заголовке. Ссылки на несуществующие `PROJECT_CONTEXT.md` / `PROJECT_SPEC.md` заменены на `backend/README.md`, `DEPLOY.md`. | Файл описывает Firebase-эпоху (RTDB, Firestore, Custom Claims) как текущую архитектуру. |
| 2 | `.agent/rules/workflows/setup_new_project.md` | Блок-предупреждение + лейбл `[ОТРЕДАКТИВНО / LEGACY FIREBASE]`. | Инструкция по созданию нового проекта через Firebase Console больше не актуальна. |
| 3 | `.agent/rules/maintenance/updating_smiles.md` | Блок-предупреждение + лейбл `[ОТРЕДАКТИВНО / LEGACY FIREBASE]`. | Синхронизация стикеров через Firebase Storage больше не используется. |
| 4 | `backend/tools/ops/README.md` | Блок-предупреждение + лейбл `[ОТРЕДАКТИВНО / LEGACY FIREBASE]`. | Инструменты нацелены на живой Firebase-проект. Нужны только для завершения миграции. |
| 5 | `backend/tools/migration/README.md` | Блок-предупреждение + лейбл `[ОТРЕДАКТИВНО / LEGACY FIREBASE]`. Ссылка на актуальную схему изменена на `backend/README.md`, `backend/internal/migrations`. | Миграция Firebase → PocketBase уже завершена. |
| 6 | `markdowns/TODO_THEMEABLE_SPRINT_PLAN.md` | Блок-предупреждение + лейбл `[ОТРЕДАКТИВНО / LEGACY FIREBASE]`. Ссылка на актуальную документацию изменена. | Первый абзац называет проект «React + Firebase SPA-форум». |
| 7 | `markdowns/SPEC_POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md` | Блок-предупреждение `⚠️ ОТРЕДАКТИВНО / НЕАКТУАЛЬНАЯ КАРТА МИГРАЦИИ` + лейбл в заголовке. | Карта Firebase → PocketBase Sprint 7 уже отработана; актуальная схема PocketBase сильно отличается. |

### Отменённое изменение
`backend/deploy/README.md` — изначально помечен ошибочно. Это актуальный деплой на ветку `main` (Go + PocketBase). Пометка убрана, файл возвращён к исходному виду.

### Формат предупреждения (во всех файлах)
```
> ⚠️ **ОТРЕДАКТИВНО / ...**
> [описание, почему больше не актуально]
> Проект переведён на **Go 1.27 + PocketBase (SQLite)**.
> **Не использовать как спецификацию для текущих задач.**
> Актуальная документация: [...]
```
И заголовок вида: `# Название файла [ОТРЕДАКТИВНО / ...]`

---

---

## 2. Каких документов реально не хватает (критично)

### 2.1 `PROJECT_CONTEXT.md` и `PROJECT_SPEC.md` (отсутствуют)
В `.agent/rules/AGENTS.md` прямо предписано: *"agents MUST update the corresponding documentation files (PROJECT_CONTEXT.md, PROJECT_SPEC.md, etc.)"*. Но этих файлов **не существует** — старые версии архивированы как Firebase-легаси.

**Что должно быть в PROJECT_CONTEXT.md:**
- Что такое Aerun, для кого (FRPG / текстовые ролевые игры), ключевая ценность
- Бизнес-правила: маски (personas), кубики (dice), репутация, скрытый контент, права доступа
- Ограничения и архитектурные решения, принятые проектом

**Что должно быть в PROJECT_SPEC.md:**
- Список коллекций PocketBase и их полей (текущая схема, не миграционная)
- API эндпоинты: методы, пути, формат запроса/ответа
- Модель доступа (RBAC): роли, разрешения, кто может что
- Жизненный цикл сущностей: topic → post → delete (hard/soft)

**Почему это критично:** Без этих двух файлов любой ИИ-агент (и новый человек) не знает, какая у вас схема БД сейчас, какие API существуют и какие бизнес-правила действуют. Приходится восстанавливать по коду миграций и исходникам — медленно и ошибчиво.

### 2.2 Актуальная схема БД PocketBase (человекочитаемая)
Есть только миграции в `backend/internal/migrations` (Go-код). Нет описания:

| Коллекция | Поля | Типы | Связи | Правила доступа |
|-----------|------|------|-------|-----------------|
| `users` | ... | ... | ... | ... |
| `topics` | ... | ... | ... | ... |
| `posts` | ... | ... | ... | ... |
| `characters` | ... | ... | ... | ... |
| ... | ... | ... | ... | ... |

### 2.3 Архитектурная спецификация бэкенда (`ARCHITECTURE.md`)
`backend/README.md` описывает запуск и миграции, но нет:
- Структуры пакетов Go (`internal/auth`, `internal/forum`, `internal/messaging`…) — какие написаны, какие pending (Sprint 2+)
- Контрактов API (какие эндпоинты есть, какие запланированы)
- Границ между PocketBase-платформенным кодом и доменным кодом
- Модели домена (сущности, value objects, агрегаты)

### 2.4 Инструкция развертывания нового экземпляра (`NEW_INSTANCE.md` / `SETUP.md`)
Старый `setup_new_project.md` был Firebase-ориентированный. Для PocketBase+Go нет пошаговой инструкции:
- Установка Go, PocketBase
- Инициализация `pb_data`
- Создание суперадмина
- Настройка `.env`
- Первичные миграции
- Развертывание фронтенда

### 2.5 Документация по API контрактам (`API.md`)
Frontend общается с бэкендом через `/api/aerun/*` (PocketBase SDK + кастомные эндпоинты). Нет документации:
- Какие эндпоинты существуют
- Формат запроса/ответа
- Аутентификация (jak funciona PocketBase authStore)
- Idempotency-Key (уже в коде, но не задокументировано для потребителя)

---
---

## 3. Полезно было бы иметь (второстепенно)

| Документ | Зачем |
|----------|-------|
| `TESTING.md` | Какие тесты есть (`npm test`, `go test ./...`), что они покрывают, как добавить новый check-скрипт |
| `SECURITY.md` | Модель угроз, правила доступа PocketBase, обработка конфиденциальных данных (email, пароли) |
| `MIGRATIONS.md` | Как писать новые миграции PocketBase, порядок применения, откат, именование |
| `I18N.md` | Как работает `t()`, где словари (`src/i18n/dictionary.js`), как добавить язык |
| `RUNBOOK.md` | Что делать если упал сервис, как восстановить из бэкапа, как проверить health, логи |

---

## 4. Предложенный план действий (приоритеты)

| Приоритет | Документ | Описание |
|-----------|----------|----------|
| **1 (критично)** | `PROJECT_CONTEXT.md` | Контекст продукта, бизнес-правила, ключевые фичи |
| **2 (критично)** | `PROJECT_SPEC.md` | Функциональная спецификация: схема БД, API, RBAC, жизненный цикл сущностей |
| **3 (высокий)** | `ARCHITECTURE.md` | Архитектура бэкенда, пакеты Go, контракты API, границы домена |
| **4 (высокий)** | `NEW_INSTANCE.md` | Развертывание с нуля на PocketBase+Go |
| **5 (средний)** | `API.md` | Контракты эндпоинтов `/api/aerun/*` |
| **6 (второстепенно)** | `TESTING.md`, `SECURITY.md`, `MIGRATIONS.md`, `I18N.md`, `RUNBOOK.md` | Дополнительная операционная документация |

---

## 5. Контекст проекта (для справки)

- **Репозиторий:** `G:\Stacionar\WEB\My Web Sites\forum-Aerun`
- **Ветки:** `main` (актуальная, Go + PocketBase, деплоится на прод), `legacy-firebase` (архив Firebase-эпохи), `feature/*`, `firebase-artifact-cleanup`, `ci-report` (только отчёты CI)
- **CI/CD:** `.github/workflows/backend.yml` (gofmt, go build, go vet, go test) → отчет в ветке `ci-report`
- **Деплой:** `deploy.py` + `backend/deploy/README.md` (Caddy → Go/PocketBase на VPS, systemd)
- **Локальная разработка:** `npm run dev` (фронт, Vite), `npm run dev:backend` (бэкенд, Go)
- **Агентные правила:** `.agent/rules/` (AGENTS.md, commands.md, ui_standards.md и др.)
- **Текущие specs:** `markdowns/SPEC_*.md` (темы, профиль, админка — частично актуальны)

---

## 6. Вывод

Проект уже находится в состоянии, близком к BMAD (есть правила для агентов, спринт-планы, specs по страницам, CI/CD), но **без двух базовых документов** — `PROJECT_CONTEXT.md` и `PROJECT_SPEC.md` — любая работа с ИИ-агентом или новым разработчиком требует восстановления контекста из кода. Создание этих двух документов должно стать первой приоритетной задачей перед дальнейшим развитием спецификаций и архитектуры.

---

## 7. Агентные правила требуют обновления

Помимо помеченных файлов, требуется пересмотр самого содержимого агентских правил в `.agent/rules/`:

| Файл | Проблема | Что нужно обновить |
|------|----------|-------------------|
| `.agent/rules/AGENTS.md` | Описывает Firebase-эпоху как текущую: RTDB-first архитектура, Custom Claims для безопасности, Firestore Security Rules, гостевое присутствие через RTDB | Переписать под PocketBase+Go: правила доступа через PocketBase collection rules, присутствие через PocketBase realtime или опрос, безопасность через PocketBase админ-права и JWT |
| `.agent/rules/.clinerules` | Упоминает шаблоны email через `loadEmailTemplates` и PocketBase — частично актуально, но требует сверки с текущим кодом | Проверить соответствие текущей реализации email-шаблонов |
| `.agent/rules/commands.md` | Ссылается на CI-отчет backend и gofmt/build/vet/test — актуально для Go бэкенда | Оставить, но уточнить пути и команды под текущую структуру |
| `.agent/rules/ui_standards.md` | i18n, темизация, DRY — актуально для React фронтенда | Оставить без изменений |

**Почему это важно для BMAD-состояния:** Агентские правила — это то, по чему ИИ-ассистент принимает решения. Если в `AGENTS.md` заложена логика "всегда используй RTDB для Presence", агент будет предлагать несуществующие в текущем стеке решения. Для корректной работы BMAD-подхода правила должны описывать текущий стек (Go + PocketBase), а не легаси Firebase.
---

## 8. Верификация находок (2026-11-02, вторая сессия)

Все находки этого документа проверены по коду, git и файловой системе. Результат:

### 8.1 Подтверждено ✅

| Находка | Проверка |
|---------|----------|
| 7 файлов помечены `⚠️ ОТРЕДАКТИВНО` | grep по всем 7 файлам — warning-блоки и лейблы на месте |
| `backend/deploy/README.md` возвращён к исходному виду | подтверждено — актуальный деплой-документ, пометки нет |
| Стек Go 1.27 + PocketBase + React 19 + Vite | `backend/go.mod` (go 1.27, pocketbase v0.40.4), `package.json` (react ^19.2.0, vite ^7.3.1, pocketbase ^0.28.1) |
| `PROJECT_CONTEXT.md` / `PROJECT_SPEC.md` отсутствуют | подтверждено; старые версии — `markdowns/Archive/ARCHIVE_PROJECT_CONTEXT.md`, `ARCHIVE_PROJECT_SPEC.md` |
| CI backend.yml → отчёт в `ci-report` | workflow прочитан: gofmt/build/vet/test + publish в `ci-report`, schema `aerun-ci-report/1` |
| `deploy.py`, `npm run dev`, `npm run dev:backend`, `src/i18n/dictionary.js` | всё существует |
| `/api/aerun/*` + `Idempotency-Key` | подтверждено: 125 маршрутов в `run.go`, middleware `enforceIdempotency`, коллекция `idempotency_keys` |
| `.clinerules` существует | подтверждено (`ls -a`; первый `ls -R` не показал dotfiles) |

### 8.2 Расхождения и ошибки ❌

1. **§5 «Ветки» устарел.** Заявлено: `main` — легаси Firebase, актуальная ветка `feature/pocketbase-migration`. Фактически (git): `main` — актуальная прод-ветка (Go + PocketBase, `origin/main` синхронизирована), миграция уже влита; легаси — ветка `legacy-firebase`. Исправлено в §5 и в `AGENTS.md` (правило Build and Deployment Workflow).
2. **§7 про `AGENTS.md` неточен.** Файл описан как «чисто Firebase-легаси». Фактически это **смесь**: верх (RTDB-first, Custom Claims, Firebase-деплой) — легаси; низ — актуальные PocketBase-правила (CI-отчёт, идемпотентность, семантика удалений HARD/SOFT, shared-poll, DM tombstones, rank-матрица). Удалять файл нельзя — нужна реконструкция: вынести актуальные правила в новые файлы `rules/`, легаси-часть архивировать. До реконструкции `AGENTS.md` сохраняет пометку.
3. **Битые ссылки в правилах (исправлены 2026-11-02):**
   - `.agents/AGENTS.md` (такой папки нет) → `.agent/rules/AGENTS.md`;
   - `markdowns/POST_DELETE_WIPED_TOPIC_INCIDENT.md` → `markdowns/Archive/CLOSED_INCIDENT_POST_DELETE_WIPED_TOPIC.md`;
   - `BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md` → `markdowns/Archive/DONE_BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md` (исправлено в `AGENTS.md`, `commands.md`, `backend/README.md`, `backend/tools/ops/README.md`).
4. **§2.2 уточнение:** отдельной коллекции `drafts` нет — черновики это посты с `is_draft = true` в коллекции `posts` (миграция `1766700000_post_drafts.go`).

### 8.3 Созданная документация (2026-11-02)

| Документ | Содержание |
|----------|-----------|
| `PROJECT_CONTEXT.md` (корень) | продукт, аудитория, фичи, 10 бизнес-правил, архитектурные решения, карта документации |
| `PROJECT_SPEC.md` (корень) | схема БД (21 коллекция), полный список ключей прав из `permission.go`, API `/api/aerun/*` (12 групп маршрутов), жизненный цикл сущностей, контракты |
| `.agent/rules/documentation_maintenance.md` | правила поддержания документации: инвентарь, правило синхронизации с кодом, жизненный цикл `markdowns/`, гигиена ссылок, источники истины, чек-лист завершения задачи |

Дополнительно точечные правки: `AGENTS.md` (актуальные ссылки, ветки, `.agent/` путь) — при этом легаси-блоки RTDB/Custom Claims сохранены до реконструкции (см. ниже).

### 8.4 Обновлённый план (остаток)

| Приоритет | Задача | Статус |
|-----------|--------|--------|
| 1 | `PROJECT_CONTEXT.md` | ✅ создан |
| 2 | `PROJECT_SPEC.md` | ✅ создан |
| 3 | `ARCHITECTURE.md` | ✅ создан (2026-11-02, вторая сессия) |
| 4 | `NEW_INSTANCE.md` | ✅ создан (2026-11-02, вторая сессия) |
| 5 | `API.md` | ✅ создан (2026-11-02, вторая сессия) — конвенции, error contract, идемпотентность, особенности команд; полный перечень маршрутов — `PROJECT_SPEC.md` §3 |
| 6 | `TESTING.md`, `SECURITY.md`, `MIGRATIONS.md`, `I18N.md`, `RUNBOOK.md` | ✅ все пять созданы (2026-11-02, вторая сессия) |
| **новый** | **Реконструкция `.agent/rules/AGENTS.md`**: легаси-Firebase правила (RTDB-first, Custom Claims, Firestore Security Rules, старый деплой) заменить PocketBase-эквивалентами; актуальные правила уже в файле и в `documentation_maintenance.md` | ✅ выполнена (2026-11-02, вторая сессия): снята пометка легаси, RTDB-first → PocketBase-first, Custom Claims → deny-by-default permission model, VPS-раздел переписан под `deploy.py`, битые ссылки исправлены |

### 8.5 Статус после второй сессии (2026-11-02)

План из §4 полностью выполнен. Состояние документации:
- **Живые корневые доки:** `PROJECT_CONTEXT.md`, `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `API.md`, `NEW_INSTANCE.md`, `TESTING.md`, `SECURITY.md`, `MIGRATIONS.md`, `I18N.md`, `RUNBOOK.md` + `README.md`, `DEPLOY.md`, `backend/README.md`, `backend/deploy/README.md`.
- **Агентские правила:** `AGENTS.md` реконструирован под текущий стек и больше не помечен легаси; новое правило `.agent/rules/documentation_maintenance.md` задаёт режим поддержания документации (синхронизация в том же коммите, чек-лист завершения, гигиена ссылок).
- Этот TODO-документ можно считать закрытым: при следующей чистке перенести в `markdowns/Archive/` с префиксом `DONE_`.



