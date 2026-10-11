# Forum View + Members View — спецификация структуры DOM для темы оформления

## Назначение

Этот документ предназначен для IDE-агента, который будет рефакторить React-компоненты форума и участников.

Цель — сделать **стабильный DOM API для темы оформления**, а не копировать старую HTML-разметку MyBB/Rusff буквально.

Исходные примеры взяты с двух реальных форумов. На страницах видны одни и те же базовые принципы:

- отдельная страница просмотра форума со списком тем;
- отдельная страница списка участников;
- пагинация сверху и снизу;
- семантические данные внутри строк;
- состояние темы/участника может влиять на оформление;
- аватар и ссылка на профиль являются частью сущности;
- фильтрация и сортировка участников являются самостоятельным блоком.

Старые классы вроде `.tcl`, `.tc2`, `.tc3`, `.tcr`, `.tclcon`, `.byuser`, `.user-avatar`, `.usersname`, `.group4`, `.group6`, `.altstyle`, `.isticky`, `.iclosed` **не должны становиться новым Theme API**.

Bootstrap-классы можно продолжать использовать для внутренней сетки и поведения компонентов, но тема не должна зависеть только от Bootstrap-классов.

---

# 1. Общий принцип

Обе страницы должны использовать общий базовый контейнер:

```text
#forum-wrapper
└── #forum
    ├── #forum-header
    ├── page-specific content
    └── #forum-about
```

Если `#forum-wrapper`, `#forum`, `#forum-header` и `#forum-about` уже существуют в других страницах движка, их нужно переиспользовать.

Не создавать отдельную систему классов только для Forum View / Members View.

---

# 2. Forum View — страница списка тем

## 2.1. Корневой контейнер

Для страницы списка тем использовать:

```html
<div id="forum-view" class="forum-view forum-{id}" data-forum-id="{id}">
```

Рекомендуется:

- `#forum-view` — структурный ID страницы;
- `.forum-view` — семантический класс типа страницы;
- `.forum-{id}` — идентификатор конкретного форума;
- `data-forum-id` — машинно читаемый ID форума.

Не использовать `id="forum_f4"` как публичный API. Старый формат `forum_f{id}` можно временно сохранить только для совместимости со старым JS, если это действительно необходимо.

---

## 2.2. Структура страницы

Рекомендуемая структура:

```text
#forum-view
├── #forum-breadcrumbs-top
├── #forum-header
│   ├── .forum-title
│   ├── .forum-description
│   └── .forum-meta
├── #forum-actions-top
├── #forum-pagination-top
├── #forum-topic-list
│   ├── .topic-list-header
│   └── .topic-list
│       └── .topic-item
├── #forum-pagination-bottom
├── #forum-actions-bottom
└── #forum-breadcrumbs-bottom
```

Не обязательно реализовывать каждый элемент, если движок пока не предоставляет соответствующие данные.

Главное — сохранить стабильную структуру вокруг списка тем.

---

# 3. Заголовок форума

```html
<header id="forum-header">
    <h1 class="forum-title">Название форума</h1>
    <div class="forum-description">Описание форума</div>
    <div class="forum-meta">...</div>
</header>
```

### API

- `.forum-title` — название форума;
- `.forum-description` — описание;
- `.forum-meta` — дополнительная информация, если она есть.

Не заставлять тему искать название через:

```css
#pun-main > h1
```

или через конкретный порядок вложенных элементов.

---

# 4. Пагинация

Пагинация списка тем может находиться сверху и снизу.

```html
<nav id="forum-pagination-top" class="forum-pagination">
    ...
</nav>
```

```html
<nav id="forum-pagination-bottom" class="forum-pagination">
    ...
</nav>
```

Если используется один переиспользуемый React-компонент Pagination, он должен принимать позицию через класс:

```text
.forum-pagination
.is-top
.is-bottom
```

или аналогичный семантический способ.

Тема должна иметь возможность стилизовать верхнюю и нижнюю пагинацию независимо.

---

# 5. Заголовок списка тем

В старой разметке список представляет собой таблицу с колонками:

- Topic;
- Replies;
- Views;
- Last post.

На одном форуме используются английские подписи, на другом русские. Это доказывает, что **текст заголовка колонки не должен быть частью DOM API**.

Новый API:

```text
.topic-list-header
.topic-column
.topic-replies
.topic-views
.topic-last-post
```

Пример:

```html
<div class="topic-list-header">
    <div class="topic-column">Тема</div>
    <div class="topic-replies">Ответов</div>
    <div class="topic-views">Просмотров</div>
    <div class="topic-last-post">Последнее сообщение</div>
</div>
```

Можно использовать `<table>`, CSS Grid или flex.

**Не требуется копировать старую table-based структуру.**

---

# 6. Topic Item — отдельная тема

Каждая тема должна быть отдельной самостоятельной сущностью.

Рекомендуемый корневой элемент:

```html
<article
    id="topic-{topicId}"
    class="topic-item topic-{topicId}"
    data-topic-id="{topicId}">
```

Главный принцип:

> Тема должна стилизоваться независимо от позиции в списке.

Нельзя использовать:

```text
.item1
.item2
.item3
```

для обозначения разных тем.

---

# 7. Состояния темы

Состояние темы должно выражаться отдельными семантическими классами.

Минимальный набор:

```text
.is-sticky
.is-closed
.is-locked
.is-redirect
.is-new
.is-unread
.is-hidden
```

Использовать только те состояния, которые реально существуют в модели движка.

Например:

```html
<article class="topic-item is-sticky">
```

или:

```html
<article class="topic-item is-closed">
```

Не использовать старый `.isticky` / `.iclosed` как единственный API.

Если старый JS зависит от них, на переходный период можно добавить оба:

```html
class="topic-item is-sticky isticky"
```

Но новая тема должна работать через `.is-sticky`.

---

# 8. Внутренняя структура Topic Item

Рекомендуемая структура:

```text
.topic-item
├── .topic-icon
├── .topic-main
│   ├── .topic-title
│   ├── .topic-author
│   ├── .topic-pagination
│   └── .topic-meta
├── .topic-replies
├── .topic-views
└── .topic-last-post
    ├── .last-post-avatar
    ├── .last-post-link
    ├── .last-post-date
    └── .last-post-author
```

---

# 9. Topic icon

В старом DOM есть:

```html
<div class="icon"></div>
```

и он находится внутри `.intd`.

В новом DOM:

```html
<div class="topic-icon" aria-hidden="true"></div>
```

Иконка может показывать:

- новые сообщения;
- нет новых сообщений;
- закрепленную тему;
- закрытую тему;
- другой статус.

Но сама тема не должна зависеть от того, что это именно `div.icon`.

Если иконка имеет отдельные состояния, допускается:

```text
.topic-icon
.is-new
.is-unread
.is-locked
```

---

# 10. Название темы

```html
<div class="topic-main">
    <a class="topic-title" href="...">Название темы</a>
</div>
```

`.topic-title` должен быть единственным стабильным селектором для названия темы.

Не искать название через:

```text
.tcl
.tclcon
a:first-child
```

---

# 11. Автор темы

Старые форумы используют:

```text
.byuser
.byuser-username
```

Новый API:

```text
.topic-author
.topic-author-name
.topic-author-link
```

Пример:

```html
<div class="topic-author">
    <span>Автор:</span>
    <a class="topic-author-link" href="...">
        <span class="topic-author-name">Username</span>
    </a>
</div>
```

Если автор не отображается отдельно, не нужно создавать искусственный элемент только ради класса.

---

# 12. Страницы темы

У длинной темы рядом с названием может отображаться мини-пагинация:

```text
[ 1 2 3 … 26 ]
```

Для нее использовать:

```html
<nav class="topic-pagination">
    ...
</nav>
```

Не использовать `.pagestext` как публичный API.

Если мини-пагинация отсутствует — `.topic-pagination` просто не рендерится.

---

# 13. Replies и Views

Использовать:

```text
.topic-replies
.topic-views
```

Пример:

```html
<div class="topic-replies" data-value="756">
    756
</div>

<div class="topic-views" data-value="18401">
    18401
</div>
```

`data-value` не обязателен, но может быть полезен для JS.

Не использовать `.tc2` и `.tc3` как Theme API.

---

# 14. Last Post

Последнее сообщение темы — отдельный семантический блок.

```text
.topic-last-post
├── .last-post-avatar
├── .last-post-link
├── .last-post-date
└── .last-post-author
```

Пример:

```html
<div class="topic-last-post">
    <a class="last-post-avatar" href="/profile/5">
        <img src="..." alt="">
    </a>

    <div class="last-post-info">
        <a class="last-post-link" href="/topic/16#post-581782">
            12-09-2026 10:43:25
        </a>

        <a class="last-post-author" href="/profile/5">
            Hardy Knight
        </a>
    </div>
</div>
```

Тема должна иметь возможность отдельно стилизовать:

- аватар;
- ссылку на последнее сообщение;
- дату;
- автора.

---

# 15. Topic row identity

Для каждого topic item желательно:

```html
id="topic-{topicId}"
data-topic-id="{topicId}"
```

Например:

```html
<article
    id="topic-16"
    class="topic-item topic-16"
    data-topic-id="16">
```

`topic-{id}` позволяет теме сделать индивидуальный стиль конкретной темы, если это когда-нибудь потребуется.

Но нельзя строить основную логику темы на конкретных ID.

---

# 16. Forum View — итоговая рекомендуемая структура

```text
#forum-view.forum-view.forum-{id}
├── #forum-breadcrumbs-top
├── #forum-header
│   ├── .forum-title
│   ├── .forum-description
│   └── .forum-meta
├── #forum-actions-top
├── #forum-pagination-top
├── #forum-topic-list
│   ├── .topic-list-header
│   │   ├── .topic-column
│   │   ├── .topic-replies
│   │   ├── .topic-views
│   │   └── .topic-last-post
│   │
│   └── .topic-list
│       └── .topic-item
│           ├── .topic-icon
│           ├── .topic-main
│           │   ├── .topic-title
│           │   ├── .topic-author
│           │   └── .topic-pagination
│           ├── .topic-replies
│           ├── .topic-views
│           └── .topic-last-post
│               ├── .last-post-avatar
│               ├── .last-post-link
│               ├── .last-post-date
│               └── .last-post-author
├── #forum-pagination-bottom
├── #forum-actions-bottom
└── #forum-breadcrumbs-bottom
```

---

# 17. Members View — страница списка участников

Для страницы участников использовать отдельный корневой контейнер:

```html
<div id="members-page" class="members-page">
```

Не использовать `#pun-userlist` как новый Theme API.

Можно временно сохранить старый ID для совместимости со старым JS, но новый React DOM должен использовать:

```text
#members-page
```

---

# 18. Структура Members View

Рекомендуемая структура:

```text
#members-page
├── #members-breadcrumbs-top
├── #members-header
│   └── .members-title
├── #members-pagination-top
├── #members-filters
│   ├── .members-search
│   ├── .members-group-filter
│   ├── .members-sort
│   ├── .members-sort-direction
│   └── .members-filter-actions
├── #members-list
│   ├── .members-list-header
│   └── .member-list
│       └── .member-item
├── #members-pagination-bottom
└── #members-breadcrumbs-bottom
```

---

# 19. Members title

```html
<header id="members-header">
    <h1 class="members-title">Участники</h1>
</header>
```

`.members-title` — стабильный селектор для заголовка.

---

# 20. Members pagination

Использовать:

```text
#members-pagination-top
#members-pagination-bottom
.members-pagination
```

Если используется общий Pagination component, можно использовать:

```text
.members-pagination.is-top
.members-pagination.is-bottom
```

---

# 21. Search / Filter block

В исходных форумах блок фильтрации содержит:

- поиск по имени;
- фильтр по группе;
- сортировку;
- направление сортировки;
- кнопку отправки.

На одном из примеров поле имени отсутствует в конкретной странице, но на другом форуме оно есть. Поэтому поле username должно быть **опциональным**, а не обязательным для каждой конфигурации.

Рекомендуемая структура:

```text
#members-filters
├── .members-search
│   ├── .members-filter-label
│   └── .members-search-input
├── .members-group-filter
│   ├── .members-filter-label
│   └── .members-group-select
├── .members-sort
│   ├── .members-filter-label
│   └── .members-sort-select
├── .members-sort-direction
│   ├── .members-filter-label
│   └── .members-sort-direction-select
└── .members-filter-actions
```

Пример:

```html
<form id="members-filters">
    <div class="members-search">
        <label class="members-filter-label" for="members-search-input">
            Имя
        </label>
        <input
            id="members-search-input"
            class="members-search-input"
            name="username"
            type="text">
    </div>

    <div class="members-group-filter">
        <label class="members-filter-label" for="members-group-select">
            Группа
        </label>
        <select
            id="members-group-select"
            class="members-group-select"
            name="group">
        </select>
    </div>

    <div class="members-sort">
        <label class="members-filter-label" for="members-sort-select">
            Сортировать по
        </label>
        <select
            id="members-sort-select"
            class="members-sort-select"
            name="sort">
        </select>
    </div>

    <div class="members-sort-direction">
        <label class="members-filter-label" for="members-sort-direction-select">
            Направление
        </label>
        <select
            id="members-sort-direction-select"
            class="members-sort-direction-select"
            name="direction">
        </select>
    </div>

    <div class="members-filter-actions">
        <button class="members-filter-submit" type="submit">
            Найти
        </button>
    </div>
</form>
```

---

# 22. Не привязывать тему к тексту фильтров

На разных форумах подписи отличаются:

- `Username` / `Имя`;
- `User group` / `Группа`;
- `Sort by` / `Сортировать по`;
- `Last visit` / `Последний визит`;
- разные названия пользовательских групп.

Поэтому тема должна стилизовать:

```text
.members-filter-label
.members-search-input
.members-group-select
.members-sort-select
.members-sort-direction-select
.members-filter-submit
```

а не искать элементы по тексту `<label>`.

---

# 23. Members list

В старом DOM список представляет собой таблицу:

```text
Username
Title
Respect
Posts
Registered
Last Visit
```

В новом API:

```text
#members-list
├── .members-list-header
└── .member-list
    └── .member-item
```

Каждый участник — самостоятельная сущность.

---

# 24. Member Item

Рекомендуемый корневой элемент:

```html
<article
    id="member-{userId}"
    class="member-item member-{userId} group-{groupId}"
    data-user-id="{userId}"
    data-group-id="{groupId}">
```

Можно использовать `<div>`, если `<article>` не подходит текущей архитектуре.

Обязательная идея:

> Один пользователь = один независимый DOM entity.

Не использовать `.group4`, `.group6` как единственный API.

Новый вариант:

```text
.member-item
.group-{groupId}
```

---

# 25. Состояния Member Item

Минимально полезные состояния:

```text
.is-online
.is-offline
.is-hidden
```

Если движок поддерживает другие состояния, их можно добавлять отдельно.

Например:

```html
<article class="member-item group-6 is-online">
```

Онлайн-статус не должен определяться через наличие старого `.isonline`.

---

# 26. Структура Member Item

Рекомендуется:

```text
.member-item
├── .member-user
│   ├── .member-avatar
│   ├── .member-online-indicator
│   └── .member-name
├── .member-title
├── .member-reputation
├── .member-posts
├── .member-registered
└── .member-last-visit
```

---

# 27. Member avatar

Старый DOM использует:

```text
.user-avatar
.avatar-image
```

Новый API:

```text
.member-avatar
```

Пример:

```html
<a class="member-avatar" href="/profile/370">
    <img src="..." alt="Remington Slater">
</a>
```

Если аватар технически реализован через `background-image`, это допустимо. Важно, чтобы внешняя тема могла найти аватар через `.member-avatar`.

---

# 28. Online indicator

В старом DOM онлайн-статус представлен `.isonline`.

Новый API:

```text
.member-online-indicator
```

Пример:

```html
<span
    class="member-online-indicator"
    aria-label="Онлайн">
</span>
```

И состояние пользователя:

```text
.member-item.is-online
.member-item.is-offline
```

Тема должна иметь возможность стилизовать и строку, и сам индикатор.

---

# 29. Username

```text
.member-name
```

Пример:

```html
<a class="member-name" href="/profile/370">
    Remington Slater
</a>
```

Не использовать `.usersname` как новый API.

---

# 30. User title / status

Старые форумы называют эту колонку по-разному:

- Title;
- Статус.

Новый API должен быть нейтральным:

```text
.member-title
```

Это именно пользовательское звание/статус, а не группа пользователя.

Не смешивать:

```text
.member-title
```

и:

```text
.member-group
```

Группа — отдельная сущность.

---

# 31. Group

Группа пользователя нужна прежде всего для состояния и CSS.

На корневом элементе:

```html
data-group-id="{groupId}"
class="member-item group-{groupId}"
```

При необходимости можно иметь:

```html
<span class="member-group">...</span>
```

Но если название группы не выводится пользователю, отдельный `.member-group` не нужен.

Важно: тема не должна зависеть от того, что конкретно означает `group-4` или `group-6`.

---

# 32. Reputation

Использовать:

```text
.member-reputation
```

Не использовать `.relation` как новый API.

Пример:

```html
<div class="member-reputation">
    +4547
</div>
```

---

# 33. Posts

Использовать:

```text
.member-posts
```

Не использовать `.num_posts` как новый API.

---

# 34. Registration date

Использовать:

```text
.member-registered
```

Дата должна быть самостоятельным элементом.

---

# 35. Last visit

Использовать:

```text
.member-last-visit
```

Например:

```html
<div class="member-last-visit">
    Today
</div>
```

или:

```html
<div class="member-last-visit">
    Сегодня
</div>
```

Язык текста не должен влиять на DOM API.

---

# 36. Members list header

Рекомендуемые классы:

```text
.members-list-header
.member-column-user
.member-column-title
.member-column-reputation
.member-column-posts
.member-column-registered
.member-column-last-visit
```

Можно использовать более короткие варианты:

```text
.member-name
.member-title
.member-reputation
.member-posts
.member-registered
.member-last-visit
```

в header и item, если архитектура движка это допускает.

Главное — не использовать `.tcl`, `.tc2`, `.tc3` и `.tcr`.

---

# 37. Итоговая структура Members View

```text
#members-page
├── #members-breadcrumbs-top
├── #members-header
│   └── .members-title
├── #members-pagination-top
├── #members-filters
│   ├── .members-search
│   │   ├── .members-filter-label
│   │   └── .members-search-input
│   ├── .members-group-filter
│   │   ├── .members-filter-label
│   │   └── .members-group-select
│   ├── .members-sort
│   │   ├── .members-filter-label
│   │   └── .members-sort-select
│   ├── .members-sort-direction
│   │   ├── .members-filter-label
│   │   └── .members-sort-direction-select
│   └── .members-filter-actions
│       └── .members-filter-submit
├── #members-list
│   ├── .members-list-header
│   └── .member-list
│       └── .member-item
│           ├── .member-user
│           │   ├── .member-avatar
│           │   ├── .member-online-indicator
│           │   └── .member-name
│           ├── .member-title
│           ├── .member-reputation
│           ├── .member-posts
│           ├── .member-registered
│           └── .member-last-visit
├── #members-pagination-bottom
└── #members-breadcrumbs-bottom
```

---

# 38. Общие data attributes

Для этих страниц желательно использовать `data-*` для сущностей.

## Forum

```text
data-forum-id
```

## Topic

```text
data-topic-id
```

## Member

```text
data-user-id
data-group-id
```

Эти значения не нужно кодировать только в CSS-классах.

Например:

```html
<div
    class="member-item group-6"
    data-user-id="370"
    data-group-id="6">
```

---

# 39. Индивидуальные IDs

Допустимый шаблон:

```text
#topic-{topicId}
#member-{userId}
```

Это полезно для:

- прямого CSS;
- JS;
- accessibility;
- поиска конкретной сущности;
- отладки.

Не делать IDs на основе позиции:

```text
#topic-1
#topic-2
#topic-3
```

если это просто порядковый номер.

ID должен быть ID сущности.

---

# 40. Что НЕ переносить из старой разметки как Theme API

Не использовать в новой архитектуре как основной API:

```text
#pun-viewforum
#pun-userlist
#pun-main
#forum_f{id}

.tcl
.tc2
.tc3
.tcr
.tclcon
.intd

.item1
.item2
.item3

.altstyle
.isticky
.iclosed
.inew

.icon
.byuser
.byuser-username

.user-avatar
.avatar-image
.usersname
.isonline

.group1
.group2
.group4
.group5
.group6

.user_title
.relation
.num_posts
.registered
.last_visit

.pagelink
.pagestext
```

Это старые технические/презентационные хуки.

Если существующий JS движка всё ещё использует некоторые из них, допустимо временно оставить их вместе с новым API.

Например:

```html
<article
    class="topic-item is-sticky isticky altstyle"
    data-topic-id="89">
```

Но новый CSS темы должен использовать:

```css
.topic-item.is-sticky { ... }
```

а не:

```css
.isticky { ... }
```

---

# 41. Tables vs CSS Grid/Flex

Исходные форумы используют `<table>` для списков тем и участников.

Это не означает, что новый React engine должен повторять table-based DOM.

Допустимы:

- CSS Grid;
- Flexbox;
- `<table>`;
- комбинация семантических контейнеров.

Выбор должен зависеть от текущей архитектуры движка.

Требование только одно:

> Семантические классы и структура сущностей должны оставаться стабильными независимо от способа визуальной раскладки.

---

# 42. Bootstrap

Bootstrap можно использовать внутри компонентов.

Например:

```html
<div class="row">
    <div class="col">...</div>
</div>
```

Это нормально.

Но Theme API должен быть:

```text
.topic-item
.topic-title
.topic-replies
.topic-views
.member-item
.member-avatar
.member-name
...
```

а не:

```text
.row
.col
.d-flex
.justify-content-between
```

Иными словами:

> Bootstrap отвечает за реализацию компонента, `forum-*` / `topic-*` / `member-*` отвечают за публичный API темы.

---

# 43. Accessibility

При рефакторинге не ухудшать accessibility.

Для аватаров:

```html
<img alt="Username">
```

или пустой `alt`, если имя уже находится рядом и изображение декоративное.

Для online indicator желательно:

```html
aria-label="Онлайн"
```

Для пагинации:

```html
<nav aria-label="Пагинация">
```

Для заголовков таблицы/списка при использовании `<table>` сохранять `scope="col"`.

---

# 44. Backward compatibility

Перед удалением старых классов проверить JS-код проекта.

Особенно искать обращения к:

```text
#pun-viewforum
#pun-userlist
.tcl
.tcr
.post
.user-avatar
.usersname
.isonline
.isticky
.iclosed
.inew
```

Если функциональность зависит от них, не удалять их сразу.

Лучший переходный вариант:

```html
<article
    id="topic-89"
    class="topic-item is-sticky isticky"
    data-topic-id="89">
```

После миграции JS на новый API старые классы можно удалить отдельным этапом.

---

# 45. Требования к React-компонентам

Агент должен разделять:

1. данные;
2. семантическую DOM-структуру;
3. Bootstrap/layout;
4. визуальную тему.

Не зашивать стили конкретного форума в компонент.

Например, компонент темы должен знать:

```js
topic.id
topic.title
topic.author
topic.replies
topic.views
topic.lastPost
topic.isSticky
topic.isClosed
topic.isNew
```

и на основании этого формировать стабильный DOM.

Он не должен знать:

- какие цвета использует конкретная тема;
- какие отступы нужны конкретному дизайну;
- нужно ли делать тему таблицей, карточкой или горизонтальной строкой.

---

# 46. Theme API — Forum View

Минимальный публичный API:

### Structural IDs

```text
#forum-view
#forum-header
#forum-pagination-top
#forum-topic-list
#forum-pagination-bottom
#forum-actions-top
#forum-actions-bottom
#forum-breadcrumbs-top
#forum-breadcrumbs-bottom
```

### Semantic classes

```text
.forum-view
.forum-title
.forum-description
.forum-meta

.topic-list-header
.topic-list
.topic-item
.topic-icon
.topic-main
.topic-title
.topic-author
.topic-author-name
.topic-author-link
.topic-pagination
.topic-replies
.topic-views
.topic-last-post

.last-post-avatar
.last-post-link
.last-post-date
.last-post-author
```

### State classes

```text
.is-sticky
.is-closed
.is-locked
.is-redirect
.is-new
.is-unread
.is-hidden
```

---

# 47. Theme API — Members View

### Structural IDs

```text
#members-page
#members-header
#members-pagination-top
#members-filters
#members-list
#members-pagination-bottom
#members-breadcrumbs-top
#members-breadcrumbs-bottom
```

### Semantic classes

```text
.members-page
.members-title

.members-pagination

.members-search
.members-search-input
.members-group-filter
.members-group-select
.members-sort
.members-sort-select
.members-sort-direction
.members-sort-direction-select
.members-filter-label
.members-filter-actions
.members-filter-submit

.members-list-header
.member-list
.member-item
.member-user
.member-avatar
.member-online-indicator
.member-name
.member-title
.member-reputation
.member-posts
.member-registered
.member-last-visit
```

### State classes

```text
.is-online
.is-offline
.is-hidden
```

---

# 48. Что нужно проверить после рефакторинга

## Forum View

- [ ] Название форума имеет `.forum-title`.
- [ ] Описание форума имеет `.forum-description`, если оно есть.
- [ ] Список тем находится внутри `#forum-topic-list`.
- [ ] Каждая тема имеет `.topic-item`.
- [ ] Каждая тема имеет `data-topic-id`.
- [ ] Название темы имеет `.topic-title`.
- [ ] Replies имеют `.topic-replies`.
- [ ] Views имеют `.topic-views`.
- [ ] Last post имеет `.topic-last-post`.
- [ ] Аватар последнего автора имеет `.last-post-avatar`.
- [ ] Дата последнего сообщения имеет `.last-post-date`.
- [ ] Автор последнего сообщения имеет `.last-post-author`.
- [ ] Sticky/closed/new состояния представлены семантическими `.is-*`.
- [ ] Пагинация имеет стабильный API.
- [ ] Нет зависимости темы от `.tcl/.tc2/.tc3/.tcr`.

## Members View

- [ ] Страница имеет `#members-page`.
- [ ] Фильтры находятся внутри `#members-filters`.
- [ ] Search является опциональным.
- [ ] Group filter имеет `.members-group-select`.
- [ ] Sort имеет `.members-sort-select`.
- [ ] Sort direction имеет `.members-sort-direction-select`.
- [ ] Список находится внутри `#members-list`.
- [ ] Каждый пользователь имеет `.member-item`.
- [ ] Каждый пользователь имеет `data-user-id`.
- [ ] Группа доступна через `data-group-id`.
- [ ] Аватар имеет `.member-avatar`.
- [ ] Username имеет `.member-name`.
- [ ] Online state представлен `.is-online/.is-offline`.
- [ ] Posts имеют `.member-posts`.
- [ ] Reputation имеет `.member-reputation`.
- [ ] Registration date имеет `.member-registered`.
- [ ] Last visit имеет `.member-last-visit`.
- [ ] Нет зависимости темы от `.group4/.group6/.usersname/.relation/.num_posts`.

---

# 49. Главный принцип для IDE-агента

Не пытаться сделать новый DOM похожим на старый MyBB только визуально.

Нужно перенести **модель интерфейса**, а не старую техническую разметку.

На странице форума основная сущность:

```text
Forum → Topic → Last Post
```

На странице участников:

```text
Members Page → Filters → Member
```

Каждая сущность должна иметь:

- стабильный semantic class;
- ID сущности через `data-*`;
- состояния через `.is-*`;
- внутренние semantic classes для важных частей.

В результате пользовательская тема должна иметь возможность написать, например:

```css
#forum-view .topic-item { ... }

#forum-view .topic-item.is-sticky { ... }

#forum-view .topic-title { ... }

#forum-view .topic-last-post { ... }

#members-page .member-item { ... }

#members-page .member-item.is-online { ... }

#members-page .member-avatar { ... }

#members-page .member-name { ... }
```

и полностью управлять внешним видом страниц **без знания внутренней реализации React-компонентов и без зависимости от Bootstrap/MyBB legacy classes**.
