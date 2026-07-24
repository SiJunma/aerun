24/07/2026

# План: Полное разграничение прав доступа (Security Audit)

## Контекст

В базе данных есть правила `allow read: if true` для категорий, тем и постов — любой может обратиться к Firestore напрямую и получить данные. Содержимое тега `[hide]` сейчас передаётся в браузер и скрывается только визуально на стороне клиента.

---

## Proposed Changes (Предлагаемые изменения)

### 1. Логика тега `[hide]` — Два эксклюзивных режима

Тег `[hide]` поддерживает **один** из трёх вариантов (одновременно нельзя):

| Режим | Синтаксис | Условие показа |
|---|---|---|
| Лимит постов | `[hide=50]` | У пользователя ≥ 50 сообщений |
| Только персонал | `[hide=hidden]` | Только с правом `BYPASS_HIDE_TAGS` |
| Адресный (новый) | `[hide=@uid123]` | Только конкретный пользователь по UID |

> **Модеры и админы с правом `BYPASS_HIDE_TAGS` всегда видят содержимое**, независимо от режима. Автор поста также всегда видит своё скрытое.

**Серверная обработка (`functions/index.js`):** Функция `getSecuredPosts` при формировании ответа пробегает по каждому посту и находит теги `[hide=...]`. Для каждого тега проверяет права текущего пользователя:
- Если пользователь **не** имеет права → физически заменяет содержимое тега на заглушку `[hide_secured type=posts threshold=50][/hide_secured]` с мета-информацией. Реальный текст до клиента не доходит.
- Если имеет право → тег остаётся нетронутым.

---

### 2. Закрытие базы данных (`firestore.rules`)
#### [MODIFY] `firestore.rules`

- **Категории и темы** — перевести на Cloud Functions. Закрыть прямое чтение с клиента:
  ```
  match /categories/{catId} { allow read: if isAdmin(); }
  match /topics/{topicId}   { allow read: if isAdmin(); }
  ```
- **Посты** — закрыть. Все посты читаются только через `getSecuredPosts`:
  ```
  match /posts/{postId} { allow read: if isAdmin(); }
  ```
- **Репутационные логи** — оставить как есть (уже защищены).

---

### 3. Cloud Functions (`functions/index.js`)
#### [MODIFY] `getSecuredPosts`
- В начале функции: получить `category_id` темы и проверить право `view_forum`. Если нет → `permission-denied`, посты не возвращаются.
- После получения постов: запустить BBCode-парсер по каждому посту, обработать `[hide]`-теги (вырезание секрета или передача).

#### [NEW] `getSecuredTopics`
- Принимает `categoryId`, `page`, `pageSize`.
- Проверяет право `view_forum` для категории.
- Возвращает темы с пагинацией.

#### [NEW] `getSecuredCategories`
- Возвращает только те категории, к которым у пользователя есть право `view_forum`.

#### [MODIFY] `getUserPosts`
- Фильтровать посты из закрытых категорий (проверять `category_id` + право `view_forum`).

---

### 4. Сохранение `category_id` и `topic_id` в постах
#### [MODIFY] `src/api/forum.js` → `createPost`, `createTopic`
- При создании поста добавлять поля `category_id` и `topic_id` в документ поста. Это фундамент для будущей системы тегов на темах.

#### [MODIFY] `functions/index.js` → `onPostCreated`
- Обеспечить, что `category_id` корректно попадает в каждый новый пост через триггер.

---

### 5. Модалка и рендер `[hide]` на клиенте
#### [MODIFY] `src/components/common/RichEditor.jsx`
- Добавить **третий режим** в модалку: **Адресный**. 
- Сделать поле ввода **User Friendly**: при вводе никнейма показывать выпадающий список (аватар + никнейм) для быстрого выбора. В тег будет подставляться UID выбранного пользователя.

#### [MODIFY] `src/components/common/BBCode.jsx`
- Добавить обработку синтаксиса `[hide=@uid]` (сверять с `user.uid`).
- Добавить обработку заглушки `[hide_secured]` — рендерить красивый placeholder с информацией о требованиях.

#### [MODIFY] `src/i18n/dictionary.js`
- Добавить ключи: `hide_addressed`, `hide_addressed_label`, `hide_addressed_placeholder`, `hide_not_for_you`.

---

### 6. Обновление клиентских подписок
#### [MODIFY] `src/api/forum.js`
- Заменить `subscribeToCategories` → `fetchSecuredCategories` (Cloud Function).
- Заменить `subscribeToTopicsInCategory` → `fetchSecuredTopics` (Cloud Function с пагинацией).
- Для отображения "новый пост" в теме: оставить лёгкий onSnapshot только на счётчик `posts_count` (если Firestore-правила позволят) или периодический polling 30сек.

---

## Verification Plan

### Автоматическое
- Firestore Security Rules tests: анонимный запрос к `/posts/{postId}` → `permission-denied`.
- Запрос к `getSecuredPosts` без прав на категорию → `permission-denied`.

### Ручное
1. Открыть закрытую категорию без прав → категория не видна.
2. Написать `[hide=50]`, зайти с < 50 постами → DevTools: видна только заглушка, реального текста нет.
3. Написать `[hide=@uid]`, зайти под этим uid → текст виден. Под другим → заглушка.
4. Зайти модератором с `BYPASS_HIDE_TAGS` → все скрытые блоки видны с пометкой.
