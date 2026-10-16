# Карта проекций: пользователь vs гость

## 1. Схема данных (целевое состояние)

| Таблица | Колонка | Назначение | Откуда берётся |
|---------|---------|------------|----------------|
| `posts` | `author_id` | id автора (пусто для гостя) | из сессии/claim |
| `posts` | `guest_nickname` | отображаемое имя гостя | из формы `guest_nickname` |
| `posts` | `author_character_id` | маска (если есть) | из формы `character_id` |
| `topics` | `last_post_author_id` | id автора последнего поста | из `posts.author_id` |
| `topics` | `last_post_guest_nickname` | имя гостя последнего поста | из `posts.guest_nickname` |
| `topics` | `last_post_author_character_id` | маска последнего автора | из `posts.author_character_id` |
| `topics` | `last_post_id` | id последнего поста | из `posts.id` |
| `topics` | `last_post_created` | время последнего поста | из `posts.created` |
| `topics` | `posts_count` | счётчик постов | пересчитывается |

> **Важно:** в текущей продакшен-БД у `topics` **нет** колонки `guest_nickname` и **нет** колонки `last_post_guest_nickname`. Есть только `last_post_author_id` и `last_post_author_character_id`. Миграция `1769800000` добавила `guest_nickname` в `posts`, но не в `topics` (или БД восстановлена из старого снапшота).

## 2. Матрица сценариев

### 2.1. Регистрированный пользователь создаёт топик

| Этап | Куда пишется | Значение |
|------|--------------|----------|
| Создание `posts` (открывающий пост) | `posts.author_id` | `uid` пользователя |
| Создание `posts` | `posts.guest_nickname` | `""` (пусто) |
| Создание `posts` | `posts.author_character_id` | id маски или `""` |
| Обновление `topics` | `topics.last_post_author_id` | `uid` |
| Обновление `topics` | `topics.last_post_guest_nickname` | `""` (не трогать) |
| Обновление `topics` | `topics.last_post_author_character_id` | id маски или `""` |
| Чтение на индексе | `categoryForumProjections` → `toCategory` | `last_post_author_id` → ищет nickname в `users` |

### 2.2. Гость создаёт топик

| Этап | Куда пишется | Значение |
|------|--------------|----------|
| Создание `posts` | `posts.author_id` | `""` (пусто) |
| Создание `posts` | `posts.guest_nickname` | `"Имя Гостя"` |
| Создание `posts` | `posts.author_character_id` | `""` |
| Обновление `topics` | `topics.last_post_author_id` | `""` (пусто) |
| Обновление `topics` | **`topics.last_post_guest_nickname`** | **`"Имя Гостя"`** |
| Обновление `topics` | `topics.last_post_author_character_id` | `""` |
| Чтение на индексе | `categoryForumProjections` → `toCategory` | `last_post_author_id == ""` → берёт `last_post_guest_nickname` |

### 2.3. Регистрированный пользователь создаёт пост (ответ)

| Этап | Куда пишется | Значение |
|------|--------------|----------|
| Создание `posts` | `posts.author_id` | `uid` |
| Создание `posts` | `posts.guest_nickname` | `""` |
| Обновление `topics` | `topics.last_post_author_id` | `uid` |
| Обновление `topics` | `topics.last_post_guest_nickname` | `""` (не трогать) |
| Обновление `topics` | `topics.last_post_author_character_id` | id маски или `""` |

### 2.4. Гость создаёт пост (ответ)

| Этап | Куда пишется | Значение |
|------|--------------|----------|
| Создание `posts` | `posts.author_id` | `""` |
| Создание `posts` | `posts.guest_nickname` | `"Имя Гостя"` |
| Обновление `topics` | `topics.last_post_author_id` | `""` |
| Обновление `topics` | **`topics.last_post_guest_nickname`** | **`"Имя Гостя"`** |
| Обновление `topics` | `topics.last_post_author_character_id` | `""` |

## 3. Чтение на фронтенде (цепочка)

```
GET /api/aerun/forum-index
  └── backend: categoryForumProjections()
        └── SQL: читает last_post_author_id, last_post_guest_nickname, last_post_author_character_id из topics
        └── projection["last_post_guest_nickname"] = row.GuestNickname
  └── frontend: toCategory() в src/api/categories.js
        └── last_post_author: d.last_post_author || d.last_post_guest_nickname || undefined
  └── LastPostInfo → AuthorMeta → ForumAuthorName
        └── если last_post_author пуст → deletedDisplayName() → «Deleted user»
```

## 4. Текущие баги (что сломано)

| # | Баг | Где проявляется | Причина |
|---|-----|-----------------|---------|
| 1 | `topics.guest_nickname` отсутствует в БД | Создание гостевого топика: `topic.Set("guest_nickname")` — silent no-op | Миграция 1769800000 добавила колонку в `posts`, но не в `topics` (или БД из старого снапшота) |
| 2 | Нет колонки `topics.last_post_guest_nickname` | Все сценарии гостя | Колонки никогда не existed в схеме topics |
| 3 | При создании гостевого топика ошибка 500: `"Failed to create topic"`, `author_id: "validation_required"` | `createTopicHandler` | Валидация требует `author_id`, но у гостя он пуст — handler не пропускает гостя |
| 4 | При создании гостевого поста ошибка 500: `"Failed to update topic projection"` | `createPostHandler` | Попытка записи в несуществующую колонку или ошибка в транзакции проекции |
| 5 | Фронтенд не подставляет `last_post_guest_nickname` | `toCategory` в `src/api/categories.js` | Было `d.last_post_author` без fallback на гостя |

## 5. Что нужно исправить (план)

### Бэкенд

1. **Миграция/ремонт схемы**: добавить колонку `topics.last_post_guest_nickname` (text, 64) и `topics.guest_nickname` (если её нет) при старте сервера (аналог `repairGuestNicknameSchema`, но для правильной колонки).
2. **`createTopicHandler` (`forum_topics.go`)**:
   - Для гостя: `topic.Set("last_post_author_id", "")`, `topic.Set("last_post_guest_nickname", form.GuestNickname)`, `topic.Set("last_post_author_character_id", "")`.
   - Убедиться, что валидация не требует `author_id` для гостя.
3. **`createPostHandler` (`forum_posts.go`)**:
   - Для гостя: `topic.Set("last_post_author_id", "")`, `topic.Set("last_post_guest_nickname", post.GetString("guest_nickname"))`, `topic.Set("last_post_author_character_id", "")`.
4. **`categoryForumProjections` (`category_access.go`)**:
   - Читать `last_post_guest_nickname` из topics (не `guest_nickname`).
   - Fallback при отсутствии колонки.
5. **Удалить `last_post_topic_posts_count`** из ответа (всегда 0, ошибочное поле).

### Фронтенд

6. **`src/api/categories.js`** (`toCategory`):
   ```js
   last_post_author: d.last_post_author || d.last_post_guest_nickname || undefined,
   ```

## 6. Что отображается на UI после исправления

| Сценарий | Колонка в ответе индекса | Отображение в LastPostInfo |
|----------|-------------------------|---------------------------|
| Пользователь создал топик | `last_post_author: "Arin"`, `last_post_author_id: "uid"` | «Arin» + аватар пользователя |
| Гость создал топик | `last_post_author: "ТестГость"`, `last_post_author_id: ""` | «ТестГость» + аватар-гостя (ui-avatars) |
| Пользователь ответил | `last_post_author: "Arin"` | «Arin» |
| Гость ответил | `last_post_author: "ГостьРеплил"`, `last_post_author_id: ""` | «ГостьРеплил» |