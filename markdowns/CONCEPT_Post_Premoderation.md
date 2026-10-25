Премодерация постов на форуме — это классическая функция, которую важно встроить **без костылей**, с соблюдением принципов чистой архитектуры (Clean Policy Architecture) и Единого Источника Правды (SSOT), принятых в проекте Aerun.

Ниже представлен системный концепт и архитектурный план реализации премодерации постов для стека **Go / PocketBase + React**.

---

## 1. Архитектурный подход: Флаг `is_approved` и роли модераторов

Вместо создания отдельной таблицы для «черновиков на проверке» или сложной логики со статусами постов, используется модель **видимости постов по флагу состояния**:

1. **База данных (`posts`):** В коллекцию `posts` добавляется булево поле **`is_approved`** (по умолчанию `true` для обычных постов).
2. **Повод для премодерации:** Пост создается с `is_approved = false`, если:
* Категория темы имеет флаг `require_post_approval = true`;
* Или автор поста имеет специальное ограничение (например, `status == 'pending'` или штрафной статус премодерации).


3. **Видимость (API Rules & Access Layer):**
* **Обычные пользователи и гости:** видит только посты, где `is_approved == true`.
* **Автор поста:** видит свой собственный пост даже с `is_approved == false` (с плашкой *«Сообщение находится на проверке модератором»*).
* **Модераторы / Администраторы:** видят все посты (включая `is_approved == false`) с кнопками *«Одобрить»* и *«Отклонить (удалить)»*.



---

## 2. Сценарии использования и UX

### А. Для обычного участника (автора)

* Пользователь отправляет сообщение в категорию с премодерацией.
* Пост сохраняется в БД с `is_approved = false`.
* Пользователь сразу видит свой пост в теме, но с полупрозрачным фоном и бейджем:
`[ ⏳ Сообщение отправлено и ожидает проверки модератором ]`.
* Наполнение счетчиков (постов автора, активности темы) **не происходит** до тех пор, пока пост не будет одобрен.

### Б. Для модератора

* **Прямо в теме (`TopicPage`):** Модератор видит пост на его законном месте с акцентной рамкой и Панелью Одобрения:
`[ 🛡️ Премодерация ]   [ ✅ Одобрить ]   [ 🗑️ Отклонить / Удалить ]`
* **Очередь модерации (`/mod/queue` или вкладка в Админке):** Список всех неотклоненных/неодобренных постов по всему форуму для быстрого батч-одобрения.

---

## 3. Изменения в схеме БД и миграции (Go / PocketBase)

### 3.1. Поля коллекций

1. **Коллекция `categories`:**
* `require_post_approval` (`bool`, default: `false`) — включается ли премодерация для всей категории (например, «Анкеты персонажей» или «Новости»).


2. **Коллекция `posts`:**
* `is_approved` (`bool`, default: `true`, required).
* `approved_by` (`relation` -> `users`, optional) — кто из модераторов одобрил.
* `approved_at` (`autodate` / `datetime`, optional) — когда одобрен.



### 3.2. Логика при создании поста (`createPostHandler` в Go)

```go
// Определяем, требуется ли премодерация для этого поста
category, err := txApp.FindRecordById("categories", topic.GetString("category_id"))
needsApproval := false

if category != nil && category.GetBool("require_post_approval") {
    // Если категория требует проверки и автор не является стаффом
    if !isStaff(acc) {
        needsApproval = true
    }
}

// Если у пользователя статус pending или есть персональное ограничение
if !acc.CanPostGlobally() && !needsApproval {
    // Дополнительные бизнес-правила премодерации
}

post.Set("is_approved", !needsApproval)

```

### 3.3. Обновление статистики темы и пользователя

> **ВАЖНО (SSOT):** Пост с `is_approved = false` **не должен** увеличивать `posts_count` в теме, менять `last_post_id` темы или увеличивать счетчик сообщений пользователя до момента одобрения!

При нажатии «Одобрить»:

1. Устанавливается `is_approved = true`, `approved_by = mod.Id`, `approved_at = now()`.
2. В той же транзакции обновляются `last_post_id` темы и счетчики активности.

---

## 4. Полнотекстовый поиск (FTS5) и Премодерация

В контексте используемого в Aerun поиска на **FTS5**:

* Неодобренные посты (`is_approved = false`) **НЕ должны индексироваться** в таблице `posts_fts` при создании.
* В момент одобрения модератором (`approvePostHandler`) пост добавляется в индекс `posts_fts` внутри той же транзакции.
* При отклонении/удалении — удаляется из FTS5 (если был проиндексирован).

---

## 5. Эндпоинты API и Командный слой (Go)

```go
// Одобрение поста модератором
group.POST("/posts/{id}/approve", approvePostHandler).
    Bind(RequirePermission(auth.PermModeratePosts))

// Отклонение поста (с опциональным указанием причины автору в ЛС)
group.POST("/posts/{id}/reject", rejectPostHandler).
    Bind(RequirePermission(auth.PermModeratePosts))

// Получение очереди постов на модерацию
group.GET("/mod/pending-posts", listPendingPostsHandler).
    Bind(RequirePermission(auth.PermModeratePosts))

```

---

## 6. Frontend Архитектура (React)

1. **Селектор отображения в `TopicPage.jsx`:**
При запросе списка постов темы бэкенд фильтрует неотфильтрованные посты по правилу:
`is_approved = true OR author_id = current_user.id OR is_staff = true`.
2. **Компонент поста (`PostCard.jsx`):**
```jsx
const isPendingApproval = !post.is_approved;

return (
  <div className={`post-card ${isPendingApproval ? 'post-pending-approval' : ''}`}>
    {isPendingApproval && (
      <Alert variant="warning" className="d-flex justify-content-between align-items-center">
        <span>⏳ Сообщение ожидает проверки модератором</span>
        {isStaff && (
          <div className="d-flex gap-2">
            <Button size="sm" variant="success" onClick={handleApprove}>Одобрить</Button>
            <Button size="sm" variant="outline-danger" onClick={handleReject}>Отклонить</Button>
          </div>
        )}
      </Alert>
    )}
    <div className="post-content">{post.content}</div>
  </div>
);

```



---

## Поэтапный план внедрения

1. **Миграция СУБД:** Добавление полей `require_post_approval` в `categories` и `is_approved`, `approved_by`, `approved_at` в `posts`.
2. **Бэкенд-логика:**
* Проверка условий премодерации в `createPostHandler`.
* Исключение `is_approved = false` из пересчета счетчиков темы/пользователя и FTS5-индекса.
* Эндпоинт `/posts/{id}/approve`.


3. **Frontend:**
* Оформление карточки неодобренного поста (для автора и модераторов).
* Добавление переключателя премодерации в настройки категорий в Админке.


4. **Тесты:** Go unit-тесты проверки прав и скрытия постов от сторонних пользователей.