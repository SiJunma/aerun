# Концепт: Удалённый пользователь (Deleted User) — профиль, посты, репутация, ЛС

**Дата:** 2026-10-18  
**Статус:** В реализации (бэкенд-ядро готово, сборка чистая)

## Прогресс реализации (2026-10-19)

### Сделано (бэкенд)
- `auth.StatusDeleted = "deleted"` — вне `AllStatuses()`, т.е. deny-by-default
  через `NarrowForStatus`; в фильтры/селекты не попадает.
- Миграция `1770000009_user_soft_delete`: `users.is_deleted` (Bool).
- `isUserDeleted()` — предикат по `status == "deleted"` OR `is_deleted`
  (работает и без новой колонки); `verifyDeletedUserSchema` на старте.
- `adminDeleteUserHandler` — soft-delete в одной транзакции
  (`is_deleted=true`, `status="deleted"`, `nickname_normalized=""`),
  повторное удаление → 409; `delete_posts` из body или `?delete_posts=1`.
- `purgeUserContent` — хард-удаление тем/постов/голосов через те же
  `purgeTopicResidue`/`deleteTopicPosts`/выплаты репутации, что и обычные
  удаления; audit `post_delete` с `reason=admin_user_delete_delete_posts`.
- `getUserProfileHandler` — `role: "Deleted"` + `deleted: true` для удалённого;
  `getPeerCardHandler` — `deleted: true`.
- `checkNicknameHandler`/`registerHandler`/`applyNickname`/`searchUsersHandler` —
  удалённые игнорируются (ник reusable).
- `voteUserHandler`/`votePostHandler` — 403 на удалённого.
- `createDMHandler`/`appendMessageToConversation` — 403 на удалённого.
- `clearConversationHandler` — hard-drop диалога, если все остальные участники
  удалены/без строк (`deleted: true` в ответе).
- Auth-хук — вход/refresh удалённого → 403.
- `loadAuthorDisplays`/`decorate*` — удалённый автор: запеченные имя/аватар,
  `Role="Deleted"`, `deleted:true`/`author_deleted:true`, без масок.

### Осталось
- [x] Списки: `listUsersHandler` скрывает deleted (публичная доска — живые), `adminListUsersHandler` показывает с `deleted: true` и фильтром `status=deleted`.
- [x] Живые сессии удалённого: `requireNotBanned` теперь отказывает с 403 на любую мутацию (пост/тема/почта) — сессия мёртва.
- [x] Go-тесты: soft-delete + delete_posts + vote/DM-блоки + nickname-reuse + вход-блок + clear-drop + миграция — `PASS`.
- [x] Фронт (пп. 10–13概念та + чекбокс delete_posts).
- [x] `npm run build` — проходит.
- [x] Скрипты-контракты — все `check-*.mjs` проходят (EXIT=0).
- [x] `npm run build` — проходит.
- [x] `go build ./...` — чисто.
- [x] Go-тесты soft-delete — все 6 `PASS`; `TestDeletedStatusIsStoredButNotAssignable`, `TestAllStatusValues`, `TestMigratedUsersCollectionHoldsIsDeleted` — `PASS`.
- [ ] Полный `go test ./internal/...` выполняется в фоне (длительный набор, ключевые тесты уже зелёные).

## Фронтенд (пп. 10–13概念та) — ВЫПОЛНЕНО
- `src/api/auth-resources.js`: `normalizeUserProfile` добавляет `deleted: rec.deleted ?? false`.
- `ProfilePage.jsx`: `isDeletedProfile` из `viewedProfile.deleted`; в `isLimitedProfile`; инфоблок `profile.account_deleted` + запеченное имя; кнопка ЛС скрыта; `fetchUserPosts` не вызывается; вкладка account скрыта.
- `TopicPage.jsx`: `onClick` у имени автора убран для `post.author.deleted`; кнопка ЛС (`profile.pm`) скрыта для `post.author.deleted` (оба места).
- `DirectMessages.jsx`: `subscribeToPeerCard` считает `card.deleted` → `peerStatus='deleted'`; форма ответа уже скрыта для non-active peers.
- `AdminPage.jsx`: состояние `deleteUserPosts`; чекбокс `admin.users.delete_posts_label` в диалоге удаления пользователя; `deleteUser(uid, user.uid, { deletePosts: deleteUserPosts })`; сброс флага при открытии/закрытии модала.
- `src/api/admin.js`: `deleteUser(uid, performerId, { deletePosts })` отправляет тело `{ delete_posts }` и пишет аудит.
- `src/i18n/dictionary.js`: ключи `delete_posts_label` / `delete_posts_hint` (en + ru); `profile.account_deleted` (en + ru).

## Фронтенд (пп. 10–13概念та) — ВЫПОЛНЕНО
- `src/api/auth-resources.js`: `normalizeUserProfile` добавляет `deleted: rec.deleted ?? false`.
- `ProfilePage.jsx`: `isDeletedProfile` из `viewedProfile.deleted`; в `isLimitedProfile`; инфоблок `profile.account_deleted` + запеченное имя; кнопка ЛС скрыта; `fetchUserPosts` не вызывается; вкладка account скрыта.
- `TopicPage.jsx`: `onClick` у имени автора убран для `post.author.deleted`; кнопка ЛС (`profile.pm`) скрыта для `post.author.deleted` (оба места).
- `DirectMessages.jsx`: `subscribeToPeerCard` считает `card.deleted` → `peerStatus='deleted'`; форма ответа уже скрыта для non-active peers.
- `AdminPage.jsx`: состояние `deleteUserPosts`; чекбокс `admin.users.delete_posts_label` в диалоге удаления пользователя; `deleteUser(uid, user.uid, { deletePosts: deleteUserPosts })`; сброс флага при открытии/закрытии модала.
- `src/api/admin.js`: `deleteUser(uid, performerId, { deletePosts })` отправляет тело `{ delete_posts }` и пишет аудит.
- `src/i18n/dictionary.js`: ключи `delete_posts_label` / `delete_posts_hint` (en + ru); `profile.account_deleted` (en + ru).

## Проблема

При удалении пользователя (adb-действием админа) происходит хард-удалёние записи из коллекции `users`.  
Далее при открытии его профиля (`GET /api/aerun/users/{id}` → 404) страница профиля "срется":  
- посты пользователя остаются (хранят `author_id`), но ссылка на профиль ведёт в никуда  
- репутация, посты, кнопка ЛС, форма ответа — рендерятся на `undefined`  
- нельзя отличить "ещё загружается" от "пользователь удалён"

## Решение: Soft-delete с флагом

### 1. Бэкенд: флаг удалённости пользователя

В коллекцию `users` добавляется поле `is_deleted` (boolean, по умолчанию `false`).

**Удаление пользователя** (`adminDeleteUserHandler`) больше НЕ делает `txApp.Delete(targetUser)`.  
Вместо этого в одной транзакции:
- устанавливает `targetUser.Set("is_deleted", true)`
- устанавливает `targetUser.Set("status", "deleted")`
- **Очищает `targetUser.Set("nickname_normalized", "")`** — освобождает уникальность ника, чтобы новая регистрация под тем же ником была возможна (UNIQUE индекс частичный: `nickname_normalized != ''`)
- **Оставляет `nickname` как есть** — запеченный ник отображается на профиле удалённого пользователя
- пишет audit log `admin_user_delete`
- остальные данные (avatar_url, reputation, posts_count) **остаются** — они запекаются и показываются на профиле

### 2. GET /api/aerun/users/{id} (getUserProfileHandler)

- Если запись не найдена — 404 (как раньше).
- Если найдена и `is_deleted == true` — возвращает профиль **со статусом deleted** и флагом `deleted: true`, а не 404.  
  Поля: `id`, `nickname`, `role: "Deleted"`, `status: "deleted"`, `deleted: true`, `avatar`, `avatar_url`, `reputation`, `posts_count`, `created_at`, `settings` (суженые, как для чужого).
- Если найдена и `is_deleted == false` — как раньше.

### 3. GET /api/aerun/peers/{id} (getPeerCardHandler)

- Для deleted пользователя возвращает `nickname`, `avatar`/`avatar_url`, `status: "deleted"`, `deleted: true` — чтобы чат-шапка могла отобразить заглушку и понять, что писать нельзя.

### 4. POST /api/aerun/users/{id}/vote (voteUserHandler)

- Если цель `is_deleted == true` — `forbiddenError("cannot vote for a deleted user")`.  
  Новые голоса на профиль удалённого пользователя блокируются на сервере.

### 5. GET /api/aerun/nicknames/check (checkNicknameHandler)

- При проверке уникальности ника **игнорировать записи с `is_deleted == true`** (добавить условие `is_deleted != true` в запрос).  
  Это позволяет новому пользователю зарегистрироваться под ником, который носил удалённый аккаунт.

### 6. POST /api/aerun/dm/conversations (createDMHandler)

- Если любой из получателей `is_deleted == true` — отказ с 403/409. Новый диалог с удалённым пользователем создать нельзя.

### 7. POST /api/aerun/dm/conversations/{id}/messages (sendDMMessageHandler)

- Если собеседник в диалоге `is_deleted == true` — отказ. В existing диалог с удалённым писать нельзя.

### 8. Удаление диалога с удалённым

- Если один из участников диалога удалён (`is_deleted == true`), а второй удаляет диалог ("clear for me" / delete) — диалог удаляется из базы, так как живых читателей не остаётся.

### 9. Посты с масками удалённого пользователя

- Пост хранит `author_id` (основной аккаунт) и `author_character_id` (маска).  
- Если основной аккаунт `is_deleted == true`, отображаем имя/аватар **удалённого основного аккаунта** (не придумываем имя маски, не показываем маску как живого пользователя).  
- Роль автора в посте → `Deleted`.

### 9. loadAuthorDisplays / декорирование авторов

- Для deleted автора: `Nickname` = запеченный `nickname` из записи (как был при жизни аккаунта), `Role = "Deleted"`, `AvatarURL` = загруженный аватар пользователя (если был) или пусто, `Reputation` и `PostsCount` = запеченные значения из записи.

## 10. Фронтенд: страница профиля удалённого пользователя

`ProfilePage.jsx` получает `viewedProfile` из `subscribeToUser`.  
Когда `viewedProfile?.deleted === true`:

- Заголовок страницы / `<h2>` → запеченный ник + `(Удалён)` / `(Deleted)`.
- Аватар: если `viewedProfile.avatar_url` не пуст — показываем его; иначе — дефолтная аватарка (сторонний ресурс, dicebear/identity как для удалённого автора в постах).
- Инфоблок: только текст "Этот аккаунт удалён" / `This account has been deleted`. Статуса, роли, локации и прочего — нет.
- **Posts: N, Reputation: N** — запеченные значения из `viewedProfile.posts_count` / `viewedProfile.reputation` (как на целевом скриншоте).
- Все вкладки (posts, stats, characters, about, reputation, security) — **скрыты**.
- Кнопка ЛС (PM) / DirectMessages — **не рендерится**.
- Кнопки +/- репутации, голосование — **не рендерятся**.
- Кнопка редактирования профиля — **не рендерится**.
- `fetchUserPosts` — **не вызывается** (`if (isDeletedProfile) return`).

## 11. Фронтенд: посты удалённого пользователя

В темах/постах, где автор `is_deleted`:
- Ссылка на профиль автора — **скрыта** (никакой кликабельной ссылки на удалённый профиль).
- Кнопка ЛС (PM) у поста — **скрыта**.
- Роль автора — тег `Deleted`.
- Аватар: загруженный или дефолтный.
- Имя: запеченный `nickname` из записи (как был при жизни аккаунта).

## 12. Фронтенд: репутация и голоса

- Кнопки +/- репутации у постов/профиля удалённого пользователя — **скрыты** (сервер тоже блокирует, см. п.4).

## 13. Фронтенд: ЛС

- Открытые прежде диалоги с удалённым участником **сохраняются** (история читается).
- Кнопка "написать" / форма ответа в диалоге с удалённым — **скрыта**.
- Новый диалог с удалённым — нельзя создать (сервер блокирует, п.5).

## Границы ответственности

- Хард-удалёние постов/тем остаётся без изменений (посты удалённого пользователя остаются, если не выбран чекбокс удаления постов).
- Репутация, накопленная до удаления, остаётся запеченной (не откатывается автоматически).
- Сервер не откатывает голоса, уже отданные до удаления; блокирует только новые.
- Повторная регистрация под ником удалённого пользователя — разрешена (при удалении очищается `nickname_normalized`, и `checkNicknameHandler` игнорирует удалённые записи).

## Чекбокс «удалить все посты пользователя» при удалении аккаунта

### UI (AdminPage.jsx)

В диалоге подтверждения удаления пользователя добавляется чекбокс:
- `Удалить все посты этого пользователя` / `Delete all posts by this user`
- По умолчанию **отключён** (выбрано «удалить только аккаунт»).

### Контракт API

`DELETE /api/aerun/admin/users/{id}` принимает тело `{ delete_posts: boolean }` (или query-параметр `?delete_posts=1`).

### Бэкенд (adminDeleteUserHandler)

При получении флага `delete_posts == true`, в той же транзакции, что и soft-delete аккаунта:
1. Находит все `topics`, где `author_id == targetUserId` — удаляет их (хард-remove тем и всех постов в них).
2. Находит все `posts`, где `author_id == targetUserId` и не в удалённых темах — удаляет их.
3. Удаляет `reputation_votes`, где `voter_id == targetUserId` (голоса, отданные этим пользователем) и где `target_id == targetUserId && post_id == ''` (голоса в репутацию этого пользователя).
4. Пишет audit log `admin_user_delete` с пометкой `delete_posts: true`.
5. Soft-delete аккаунта: `is_deleted = true`, `status = 'deleted'`, `nickname_normalized = ''`.

При `delete_posts == false` (по умолчанию):
- Только soft-delete аккаунта (`is_deleted = true`, `status = 'deleted'`, `nickname_normalized = ''`).
- Посты остаются, автор помечается как `Deleted` с запеченным ником.

### Семантика

- «Удалить только аккаунт» — профиль становится страницей с запеченным ником и пометкой удалён, посты остаются.
- «Удалить все посты» — полное удаление контента пользователя (темы, посты, связанные голоса репутации) плюс soft-delete аккаунта.
