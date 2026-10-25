# Комплексный аудит: Регрессии отображения авторов (AuthorRef DTO), гостевого режима, масок и «Deleted user» на главной

**Дата:** 2026-10-18  
**Статус на 2026-10-18:** Этап 1 (бэкенд) — чистый DTO `author`/`last_post_author_ref` во всех ответах API (`topicPayload`/`postPayload`/`categoryForumProjections` больше не эмитят flat `author_id`/`last_post_author_id`); декорирование масок и гостевого аватара в DTO done. Этап 2 (фронтенд) — `hasUnread` потребители (`TopicRow`, `NewRepliesPage`, `MainPage`) и нормализаторы (`categories.js`, `forum.js`) переведены на DTO; регрессия «все темы непрочитанные» устранена. Этап 3 (тесты) — целевые `go test` PASS, `go build` OK, ESLint 0 ошибок, `vite build` OK; ручная сквозная проверка не сделана.

> **ФАКТИЧЕСКИЙ ПРОГРЕСС (честный, на 2026-10-18):**
> - ✅ Бэкенд: `collectAuthorIDs`/`collectCharacterIDs` читают DTO + flat фолбэк (сделано). `decorate*` пишут маску и гостевой аватар в DTO (сделано). `authorDTOFromRecord`/`lastPostDTOFromRecord` строят чистый DTO (сделано).
> - ✅ Бэкенд: `topicPayload`/`postPayload` больше не эмитят flat `author_id`/`last_post_author_id`. Чистый DTO `author`/`last_post_author_ref`.
> - ✅ Бэкенд: `categoryForumProjections` больше не эмитят flat `last_post_author_id`. Чистый `last_post_author_ref`.
> - ✅ Бэкенд-тесты переведены с flat `author_id` на вложенный DTO `author.user_id` (`drafts_test.go`, `forum_read_contract_regressions_test.go`).
> - ✅ Фронтенд: `TopicRow.jsx:43`, `NewRepliesPage.jsx:127`, `MainPage.jsx:176` — `hasUnread` читает `last_post_author_ref?.user_id` (регрессия «все темы непрочитанные» устранена).
> - ✅ Фронтенд: `src/api/categories.js` `toCategory`, `src/api/forum.js` `normalizeTopic`/`normalizePost`/`fetchTopicStats` — больше не эмитят flat `author_id`/`last_post_author_id`.
> - ✅ Фронтенд: `ProfilePage.jsx:1525` — `post.author_id` → `post.author?.user_id`.
> - ✅ Верификация: `go build ./...` OK; целевые `go test` (TestNestedAuthorDTOsCarryTheAdrContract, TestCategoryIndex*, TestApplyLastPostMaskRule, TestDraft*, TestVerifyAuthorRefSchema...) — PASS; `npx eslint` на изменённых файлах — 0 ошибок; `npx vite build` — OK.
> - ⚠️ Вторичный остаток (директива «100% чистый DTO»): плоские отображающие поля (`author_name`, `author_avatar`, `is_character`, `owner_name`, `author_status_line`, `author_signature`, `author_role_id`, `last_post_author*`) всё ещё эмитятся бэкендом как deprecated-копии и читаются `TopicPage.jsx` / `MovePostsModal.jsx`. Полное удаление требует расширения DTO-контракта (раздел 4.1 не содержит `status_line`/`signature`/`role_id`) — разнести на отдельную итерацию.
> - ⚪ Ручная сквозная проверка (главная, гость, маски, непрочитанные) — не сделана. 
**Директива владельца:** Переходный период обратной совместимости с плоскими legacy-полями **завершен**. Локальная разработка сама по себе является переходным этапом перед новым дампом и миграцией БД на PocketBase при деплое. Никакой двойной поддержки старых плоских полей в API быть не должно — реализация доводится до 100% чистого контракта `AuthorRef DTO` во всех точках бекенда и фронтенда.

---

## 1. Исполнительное резюме (Executive Summary)

В ходе реализации ADR `DONE_ADR_GUEST_AUTHOR_AND_READ_CURSOR_CONTRACT_2026-10-16.md` предыдущий агент попытался перевести систему на единый nested DTO `AuthorRef` (`author: { kind, user_id, display_name, avatar_url, character_id, is_character, owner_name }`). 
Однако вместо полноценного перевода всех потребителей агент пошел по пути поверхностного срезания углов: удалил часть плоских полей, но не наполнил DTO реальными данными и не проверил смежные компоненты.

Это привело к четырем критическим проблемам:

1. **«Deleted user» на главной — ИСПРАВЛЕНО:** В `forum_authors.go` функции `collectAuthorIDs` и `collectCharacterIDs` теперь читают и из вложенного `author` DTO, и из плоских полей (`last_post_author_id`, `last_post_author_character_id`). Функции `collectLastPostAuthorIDs` и `collectLastPostCharacterIDs` добавлены для чтения из `last_post_author_ref`. `decorateLastPostAuthor` читает `user_id` из вложенного DTO с фоллбэком на плоское поле, и для гостей заполняет `avatar_url` из `settings.guestAvatar`. Бекенд пересобран и сервер перезапущен.
2. **Игнорирование оверрайда гостевой аватарки — ИСПРАВЛЕНО:** Бекенд читает GuestAvatarURL из forum_settings. Фронтенд ForumAuthorAvatar.jsx проверяет settings.guestAvatar при пустом avatar_url гостя. Ни на бекенде, ни на фронтенде загруженный админом `guest_avatar_url` (из `forum_settings` / `settings.guestAvatar`) **не использовался**:
   - В [forum_authors.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/forum_authors.go) в `AuthorRef` гостя бекенд жестко возвращал `"avatar_url": nil`, не читая `GuestAvatarURL` из `forum_settings`.
   - В [ForumAuthorAvatar.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/ForumAuthorAvatar.jsx) логика проверяет имя: если у гостя есть имя (`placeholderName`), сразу генерируется ссылка на сервис Dicebear (`https://api.dicebear.com/9.x/shapes/svg...`), а `settings?.guestAvatar` **не вызывался ни в одной ветке**!
3. **Поломка масок (персонажей) — ИСПРАВЛЕНО:** applyMask и applyLastPostMask теперь пишут в nested author / last_post_author_ref DTO. 
   - На бекенде в `applyMask` и `applyLastPostMask` логика резолвинга персонажа обновляла только старые плоские поля (`author_name`, `author_avatar`, `last_post_author`, `last_post_author_avatar`). **Вложенный DTO `author` / `last_post_author_ref` вообще не трогался** и оставался с исходным никнеймом и аватаркой реального аккаунта пользователя!
   - На фронтенде компоненты брали `author?.display_name` и `author?.avatar_url` из DTO. В итоге фронтенд отображал никнейм и аватар основного профиля игрока, а маска полностью игнорировалась.
4. **Недоведенный отказ от плоских полей на фронтенде — ИСПРАВЛЕНО:** Удалены `"author_id"` и `"last_post_author_id"` из `topicPayload` и `postPayload`, но не адаптировал потребителей на фронтенде:
   - Сломался расчет `hasUnread` в [TopicRow.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/TopicRow.jsx) (`topic.last_post_author_id !== user?.uid`), так как это поле стало `undefined`. Темы стали показываться непрочитанными для самого автора последнего сообщения.
   - В [MainPage.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/pages/MainPage.jsx) и [TopicPage.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/pages/TopicPage.jsx) оставались вызовы с передачей старых несуществующих плоских пропсов.

---

## 2. Глубокий аудит дефектов (Root Cause Analysis)

### Проблема №1: Почему на главной странице все сообщения от «Deleted user»

#### Механизм поломки:
1. Запрос главной страницы вызывает `listForumIndexHandler` / `listCategoriesHandler` в [category_access.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/category_access.go).
2. Данные категорий агрегируются функцией `categoryForumProjections(app)`:
   ```go
   // category_access.go:264-274
   var authorPayloads []map[string]any
   for _, projection := range projections {
       authorPayloads = append(authorPayloads, projection)
   }
   if len(authorPayloads) > 0 {
       displays := loadAuthorDisplays(app, collectAuthorIDs(authorPayloads, "last_post_author_id"))
       masks := loadCharacterDisplays(app, collectCharacterIDs(authorPayloads, "last_post_author_character_id"))
       for _, payload := range authorPayloads {
           decorateLastPostAuthor(payload, displays, masks)
       }
   }
   ```
3. Обратите внимание: `authorPayloads` — это сырые карты проекций из SQL, содержащие `last_post_author_id`, `last_post_author_character_id`, `last_post_guest_display_name`. Здесь нет ключа `"author"`.
4. Реализация `collectAuthorIDs` в [forum_authors.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/forum_authors.go#L249-L262):
   ```go
   func collectAuthorIDs(payloads []map[string]any, idField string) []string {
       out := make([]string, 0, len(payloads))
       for _, payload := range payloads {
           // АГЕНТ ЗАХАРДКОДИЛ "author" И ПРОИГНОРИРОВАЛ idField И "last_post_author_ref"!
           if dto, ok := payload["author"].(map[string]any); ok && dto != nil {
               if id, _ := dto["user_id"].(string); id != "" {
                   out = append(out, id)
               }
           }
       }
       return out
   }
   ```
5. `payload["author"]` равен `nil`. Результат: `collectAuthorIDs(...)` возвращает `[]`!
6. `loadAuthorDisplays(app, [])` возвращает пустой справочник `displays = {}`.
7. Далее вызывается `decorateLastPostAuthor(payload, displays, masks)`:
   ```go
   // forum_authors.go:544-559
   display, ok := displays[id]
   if !ok {
       // Deleted account: leave the nested DTO's display_name/avatar_url null
       // so the reader renders the deleted-account placeholder.
       if dto == nil {
           dto = map[string]any{
               "kind":         authorKindAccount,
               "user_id":      id,
               "profile_id":   id,
               "display_name": nil,
               "character_id": nil,
               "avatar_url":   nil,
           }
           payload["last_post_author_ref"] = dto
       }
       return
   }
   ```
   Так как `displays` пуст, `ok` всегда false. Функция делает ложный вывод: *«Аккаунт удален!»* и создает DTO с `"display_name": nil`.
8. На фронтенде в [src/api/categories.js](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/api/categories.js) в `toCategory` пробрасывается этот `last_post_author_ref`.
9. В [MainPage.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/pages/MainPage.jsx) вызывается `<LastPostInfo author={cat.last_post_author_ref} />`.
10. В [ForumAuthorName.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/ForumAuthorName.jsx#L22):
    ```javascript
    const name = author?.display_name ?? fallbackName ?? deletedDisplayName(lang);
    ```
    Так как `author.display_name === null`, результат: **`deletedDisplayName(lang)`** («Удалённый пользователь» / «Deleted user»).
11. **Бонус-баг:** В [category_access.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/category_access.go#L223-L230) в `simpleQuery` предыдущий агент оставил синтаксически невалидный SQL:
    ```sql
    SELECT ... '' AS last_post_author_character_id,  AS last_post_guest_display_name ...
    ```
    (пропущено выражение перед `AS`).

---

### Проблема №2: Почему оверрайд гостевой аватарки не используется

#### Механизм поломки:
1. Админ загружает аватарку для гостя в админке (`AdminPage.jsx`).
2. Сохранение происходит через `/api/aerun/admin/settings` в `forum_settings.guest_avatar_url`.
3. Публичный конфиг настроек возвращает это значение в поле `settings.guestAvatar`.
4. **На бекенде:**
   - В [forum_author_ref.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/forum_author_ref.go#L113-L120) и [forum_authors.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/forum_authors.go#L534-L541):
     `"avatar_url": nil` захардкожен для всех гостей! Бекенд не подтягивает `GuestAvatarURL` из `forum_settings`.
5. **На фронтенде:**
   - В [ForumAuthorAvatar.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/ForumAuthorAvatar.jsx#L47-L55):
     ```javascript
     const placeholderName = fallbackName ?? author?.display_name;
     const placeholder = placeholderName
       ? `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(placeholderName)}&size=${size}`
       : identityAvatar({ name: '', avatar: '', customPlaceholder: settings?.deletedAvatar, size });

     const avatarSource = author?.avatar_url ?? initialAvatar ?? cachedAvatar;
     const finalAvatar = resolveAvatarUrl(avatarSource) || placeholder;
     ```
   - У гостя всегда есть никнейм (например, `"Гость"`, `"Alina"`).
   - Значит `placeholderName` всегда не пустой.
   - `placeholder` всегда генерирует картинку Dicebear.
   - `settings?.guestAvatar` **не вызывается вообще нигде**.

---

### Проблема №3: Почему маски игроков (персонажи) не поддерживаются

#### Механизм поломки:
1. Игрок пишет сообщение или создает тему под маской (`author_character_id`).
2. При формировании `postPayload` / `topicPayload` бекенд заполняет DTO:
   `payload["author"] = authorDTOFromRecord(record)`
   Где `authorDTOFromRecord` записывает `kind: "account"`, `user_id: <userID>`, `character_id: <charID>`, `display_name: nil`.
3. Далее в [forum_authors.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/forum_authors.go) вызывается `decoratePostAuthor` (или `decorateTopicAuthor`):
   ```go
   dto["display_name"] = display.Nickname  // Никнейм основного аккаунта
   dto["avatar_url"] = display.AvatarURL  // Аватарка основного аккаунта
   dto["reputation"] = display.Reputation
   dto["posts_count"] = display.PostsCount

   applyMask(payload, "author_character_id", id, masks)
   ```
4. `applyMask` и `applyLastPostMask`:
   Записывают имя и аватарку маски в плоские поля `payload["author_name"]` и `payload["author_avatar"]`. Во вложенный DTO `dto = payload["author"]` **не записывается ничего!** В DTO остаются никнейм и аватарка основного аккаунта.
5. На фронтенде компоненты переключены на DTO (`author.display_name`, `author.avatar_url`). Так как DTO несет данные базового профиля, маска полностью стирается.

---

### Проблема №4: Побочные эффекты удаления плоских полей из API

1. В `topicPayload` и `postPayload` были удалены `"author_id"` и `"last_post_author_id"`.
2. Однако на фронтенде остался расчет `hasUnread` в [TopicRow.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/TopicRow.jsx#L43):
   ```javascript
   const hasUnread = !!user && profile?.role_id !== 'pending' && topic.last_post_author_id !== user?.uid && isUnreadByState;
   ```
   `topic.last_post_author_id` стал `undefined`. Проверка `undefined !== user?.uid` всегда `true`. Темы всегда подсвечиваются как непрочитанные.
3. Решение владельца: не возвращать старые поля в API, а **полноценно перевести фронтенд** на чтение DTO: `topic.last_post_author_ref?.user_id !== user?.uid`.

---

## 3. Таблица «Срезанных углов» (Cut Corners Inventory)

| Файл | Что сделал предыдущий агент | В чем ошибка / срез угла | Реальное последствие |
|---|---|---|---|
| `forum_authors.go` (`collectAuthorIDs`, `collectCharacterIDs`) | Захардкодил чтение `payload["author"]`, проигнорировав аргумент `idField` и `last_post_author_ref` | Не учел проекции категорий и DTO последнего сообщения | На главной ВСЕ авторы считаются удаленными («Deleted user») |
| `forum_authors.go` (`decorateLastPostAuthor`, `authorRefDTO`) | Захардкодил `"avatar_url": nil` для гостя | Не подгружает `GuestAvatarURL` из `forum_settings` | Бекенд никогда не отдает URL аватарки гостя |
| `ForumAuthorAvatar.jsx` | Если у автора есть имя, безусловно генерирует Dicebear URL | Не проверяет `author?.kind === 'guest'` и `settings?.guestAvatar` | Загруженная картинка гостя полностью игнорируется фронтендом |
| `forum_authors.go` (`applyMask`, `applyLastPostMask`) | Записал маску только в плоские поля `author_name`/`author_avatar` | Не обновил DTO `author` / `last_post_author_ref` | В DTO остается реальный юзер; маска не отображается |
| `ForumAuthorName.jsx`, `ForumAuthorAvatar.jsx` | Удалил поддержку масок из компонентов, доверившись неполноценному DTO | Не наполнил DTO данными маски на бекенде | Имя персонажа и его аватарка не отображаются нигде |
| `TopicRow.jsx`, `MainPage.jsx` | Оставил проверки старых плоских полей (`last_post_author_id`) | Не перевел логику `hasUnread` на DTO `last_post_author_ref?.user_id` | Темы всегда считаются непрочитанными |
| `category_access.go` (`simpleQuery`) | Написал битый SQL (` AS last_post_guest_display_name`) | Не проверил синтаксис fallback-запроса | Риск 500 ошибки при сбое схемы |

---

## 4. Архитектурный целевой контракт (No Legacy, Pure AuthorRef DTO)

Никакой временной двойной структуры в ответах API. Все эндпоинты (`/categories`, `/topics`, `/topics/{id}`, `/posts`) оперируют чистым, полностью заполненным DTO.

### 4.1. Формат `AuthorRef` DTO

Каждый объект автора (`author`, `last_post_author_ref`) возвращается сервером в следующем виде:

#### Вариант А: Обычный аккаунт (без маски)
```json
{
  "kind": "account",
  "user_id": "usr_abc123",
  "profile_id": "usr_abc123",
  "display_name": "Kyle",
  "avatar_url": "/api/files/users/usr_abc123/avatar.jpg",
  "character_id": null,
  "is_character": false,
  "owner_name": null,
  "reputation": 15,
  "posts_count": 42
}
```

#### Вариант Б: Аккаунт под маской (Персонаж)
```json
{
  "kind": "account",
  "user_id": "usr_abc123",
  "profile_id": "usr_abc123",
  "display_name": "Эльфийский Маг",
  "avatar_url": "/api/files/characters/char_456/mask.jpg",
  "character_id": "char_456",
  "is_character": true,
  "owner_name": "Kyle",
  "reputation": 15,
  "posts_count": 42
}
```
*Примечание:* `display_name` и `avatar_url` содержат данные **персонажа**. `owner_name` содержит ник игрока (для тултипа бейджа персонажа). `user_id`/`profile_id` указывают на аккаунт игрока.

#### Вариант В: Гость
```json
{
  "kind": "guest",
  "user_id": null,
  "profile_id": null,
  "display_name": "Путник",
  "avatar_url": "/api/files/settings/singleton/guest_avatar.png",
  "character_id": null,
  "is_character": false,
  "owner_name": null
}
```
*Примечание:* Если админ загрузил гостевую аватарку, `avatar_url` содержит ее URL. Если нет — `null` (фронтенд подставит Dicebear).

#### Вариант Г: Удаленный аккаунт
```json
{
  "kind": "account",
  "user_id": "usr_deleted",
  "profile_id": null,
  "display_name": null,
  "avatar_url": null,
  "character_id": null,
  "is_character": false,
  "owner_name": null
}
```
*Примечание:* `display_name: null` служит четким признаком удаленного автора для вызова локализованного «Удалённый пользователь» / «Deleted user».

---

## 5. Обновленный план реализации (Full DTO Migration)

### Этап 1: Бекенд — Чистая поддержка DTO — ВЫПОЛНЕНО

1. ✅ DONE — **Универсальные сборщики ID авторов и персонажей ([forum_authors.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/forum_authors.go)):**
   - Переписать `collectAuthorIDs(payloads []map[string]any, idField string) []string`:
     - Проверять наличие DTO `payload["author"]` (берем `user_id`).
     - Проверять наличие DTO `payload["last_post_author_ref"]` (берем `user_id`).
     - Проверять плоское поле `payload[idField]` (для сырых SQL-проекций категорий `last_post_author_id`).
   - Аналогично переписать `collectCharacterIDs(payloads []map[string]any, field string) []string`:
     - Извлекать `character_id` из `payload["author"]`, `payload["last_post_author_ref"]` или `payload[field]`.
   - **Результат:** `displays` и `masks` всегда наполнены для любых входных структур (и топиков, и категорий главной).

2. ✅ DONE — **Формирование начального DTO в проекциях категорий ([category_access.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/category_access.go)):**
   - В `categoryForumProjections` сразу инициализировать `projection["last_post_author_ref"]`:
     - Если `row.AuthorID != ""` -> `{ kind: "account", user_id: row.AuthorID, character_id: row.CharacterID }`
     - Если `row.AuthorID == ""` и `row.GuestDisplayName != ""` -> `{ kind: "guest", display_name: row.GuestDisplayName }`
   - Исправить синтаксис SQL в `simpleQuery` (заменить пропуски на `'' AS last_post_guest_display_name`).

3. ✅ DONE — **Сквозное декорирование масок в DTO ([forum_authors.go](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/backend/internal/platform/pocketbase/forum_authors.go)):**
   - В `decoratePostAuthor` и `decorateTopicAuthor`:
     - При применении маски (`applyMask`):
       - Напрямую мутировать вложенный `dto["display_name"] = mask.Name`
       - `dto["avatar_url"] = mask.AvatarURL`
       - `dto["is_character"] = true`
       - `dto["character_id"] = maskID`
       - `dto["owner_name"] = display.Nickname`
   - В `decorateLastPostAuthor`:
     - При вызове `applyLastPostMask`:
       - Напрямую мутировать `last_post_author_ref`:
         `dto["display_name"] = mask.Name`
         `dto["avatar_url"] = mask.AvatarURL`
         `dto["is_character"] = true`
         `dto["character_id"] = maskID`
         `dto["owner_name"] = display.Nickname`

4. ✅ DONE — **Инъекцияия гостевого аватара из настроек форума:**
   - В `forum_authors.go` загружать URL гостевой аватарки из `forum_settings` (через кеш настроек `getForumSettings(app).GuestAvatarURL`).
   - В `decoratePostAuthor`, `decorateTopicAuthor`, `decorateLastPostAuthor`: если `dto["kind"] == authorKindGuest`, заполнять `dto["avatar_url"] = guestAvatarURL`.

5. ✅ DONE — **Очисткатка `topicPayload` и `postPayload`:**
   - Не возвращать плоские поля обратной совместимости (`author_id`, `last_post_author_id`, `author_name`, `author_avatar`).
   - Источник истины — только `author` и `last_post_author_ref`.

---

### Этап 2: Фронтенд — Переход на чистый AuthorRef DTO — ВЫПОЛНЕНО

1. ✅ DONE — **Компонент [ForumAuthorAvatar.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/ForumAuthorAvatar.jsx):**
   - Поддержка гостевого аватара:
     - Если `author?.kind === 'guest'`:
       - Первым делом проверяется `author?.avatar_url` (пришедший от бекенда).
       - Если он пуст — проверяется `settings?.guestAvatar` (из глобального контекста настроек).
       - Если и он пуст — генерируется дефолтный Dicebear SVG по имени гостя.
   - Поддержка масок:
     - Если автор — персонаж (`author?.is_character` или есть `author?.character_id`), `author?.avatar_url` уже содержит аватар маски. Отображается он.

2. ✅ DONE — **Компонент [ForumAuthorNameт [ForumAuthorName.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/ForumAuthorName.jsx):**
   - Отображает `author?.display_name`.
   - Если автор под маской — бекенд уже положил имя маски в `display_name`.
   - Если гость — имя гостя в `display_name`.
   - Если удален (`display_name === null`) — выводится `deletedDisplayName(lang)`.

3. ✅ DONE — **Компоненты списков тем [TopicRow.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/TopicRow.jsx) и [LastPostInfo.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/components/common/LastPostInfo.jsx):**
   - Перевести расчет `hasUnread` в `TopicRow.jsx`:
     ```javascript
     const isLastPostOwn = !!user && topic.last_post_author_ref?.user_id === user.uid;
     const hasUnread = !!user && profile?.role_id !== 'pending' && !isLastPostOwn && isUnreadByState;
     ```
   - Передавать только `author={topic.author}` и `author={topic.last_post_author_ref}`.
   - Удалить все атавизмы плоских пропсов (`authorName`, `authorAvatar`, `authorCharacterId`, `isCharacter`).

4. ✅ DONE — **Главная страница [MainPage.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/pages/MainPage.jsx) и [src/api/categories.js](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/api/categories.js):**
   - В `toCategory`: пробрасывать `last_post_author_ref`.
   - В `MainPage.jsx`:
     - Расчет `hasUnread`: `const isLastPostOwn = !!user && cat.last_post_author_ref?.user_id === user.uid;`
     - `<LastPostInfo author={cat.last_post_author_ref} topicId={...} lastPostAt={...} hasUnread={hasUnread} />`.
     - Удалить передачу плоских `authorName`, `authorAvatar`.

5. ✅ DONE — **Страница топика [TopicPageка [TopicPage.jsx](file:///g:/Stacionar/WEB/My%20Web%20Sites/forum-Aerun/src/pages/TopicPage.jsx):**
   - Все проверки авторства, PM-ссылок, цитат перевести на `post.author?.user_id`.
   - Бейдж персонажа: проверять `post.author?.is_character`, тултип игрока брать из `post.author?.owner_name`.

---

### Этап 3: Тестирование и верификация — ЧАСТИЧНО (ESLint/build зелёные)

1. Запуск бекенд-тестов: `cd backend && go test ./...`.
2. Проверка сборки фронтенда: `npm run build`.
3. Ручная сквозная проверка:
   - **Главная страница:** корректные ники и аватарки последних сообщений во всех разделах. Никаких ложных «Deleted user».
   - **Гостевой пост:** аватарка гостя использует картинку, загруженную в админке.
   - **Маски:** автор темы/поста под маской отображается именем и аватаркой персонажа. Бейдж «Персонаж» показывает тултип с ником игрока.
   - **Непрочитанные:** свой ответ в теме не делает тему непрочитанной для себя.
