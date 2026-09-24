# Topic View / Просмотр темы — спецификация структуры для темы

## Назначение документа

Этот документ является инструкцией для IDE-агента, который должен пересмотреть React-компоненты **страницы просмотра отдельной темы** и привести их DOM-структуру к стабильной системе классов и `id`, предназначенной для кастомных дизайнов/тем.

Страница Topic View отличается от Forum Index тем, что главным повторяемым элементом здесь является **сообщение (post)**.

Цель — сделать так, чтобы тема могла независимо стилизовать:

- контейнер темы;
- заголовок темы;
- pagination;
- панель действий;
- отдельное сообщение;
- профиль автора;
- тело сообщения;
- метаданные сообщения;
- цитаты;
- вложения;
- подпись;
- реакции;
- кнопки редактирования/цитирования;
- состояния сообщения;
- форму ответа.

В исследованных Rusff/MyBB-страницах отдельные сообщения имеют стабильные идентификаторы вида `p{postId}`, а внутри сообщения встречаются области `.post-author`, `.post-body`, `.post-box`, `.post-content`; также используются классы для состояний вроде `online`. fileciteturn9file1L73-L91 fileciteturn9file5L273-L293

> **Важно:** не копировать старую MyBB/Rusff DOM-структуру буквально. Нужно сохранить полезный структурный принцип, но реализовать его как современный React DOM.

---

# 1. Страница

## `TopicView`

**Описание:** страница просмотра одной темы форума, содержащая заголовок темы, список сообщений, pagination, действия над темой и форму ответа.

Основной корневой контейнер:

```html
<div id="forum-wrapper">
    <div id="forum">
        ...
    </div>
</div>
```

Если `#forum-wrapper` и `#forum` уже являются общими контейнерами для всех страниц форума, не создавать их повторно внутри TopicView.

---

# 2. Верхнеуровневая структура

Рекомендуемая структура:

```text
#forum-wrapper
└── #forum
    ├── #forum-header
    │
    ├── #topic-page
    │   ├── #topic-breadcrumbs-top
    │   ├── #topic-header
    │   │   ├── .topic-title
    │   │   ├── .topic-description
    │   │   └── .topic-meta
    │   │
    │   ├── #topic-actions-top
    │   ├── #topic-pagination-top
    │   │
    │   ├── #topic-posts
    │   │   └── .topic-post
    │   │       ├── .post-author
    │   │       └── .post-body
    │   │
    │   ├── #topic-pagination-bottom
    │   ├── #topic-actions-bottom
    │   ├── #topic-reply
    │   └── #topic-breadcrumbs-bottom
    │
    └── #forum-about
```

Не обязательно создавать каждый блок как отдельный React-компонент. Это именно структурный контракт для темы.

---

# 3. Topic root

## `#topic-page`

Контейнер конкретной страницы темы.

```html
<main id="topic-page">
    ...
</main>
```

Он должен отличать страницу Topic View от Forum Index, Forum View и других страниц.

---

# 4. Breadcrumbs

## `#topic-breadcrumbs-top`

Breadcrumbs над темой.

```html
<nav id="topic-breadcrumbs-top">
    ...
</nav>
```

## `#topic-breadcrumbs-bottom`

Breadcrumbs после содержимого.

```html
<nav id="topic-breadcrumbs-bottom">
    ...
</nav>
```

Рекомендуемые внутренние классы:

```text
.breadcrumb
.breadcrumb-item
.breadcrumb-link
```

---

# 5. Заголовок темы

## `#topic-header`

Основная информация о теме.

```html
<header id="topic-header">
    <h1 class="topic-title">...</h1>
    ...
</header>
```

### `.topic-title`

Название темы.

```html
<h1 class="topic-title">
    ...
</h1>
```

### `.topic-description`

Если у движка существует описание темы:

```html
<div class="topic-description">
    ...
</div>
```

Элемент optional.

### `.topic-meta`

Общая мета-информация:

```html
<div class="topic-meta">
    ...
</div>
```

Например:

- автор темы;
- дата создания;
- количество сообщений;
- статус;
- раздел.

Не добавлять данные, которых нет в текущей модели.

---

# 6. Topic state

Состояния темы должны быть доступны через классы на `#topic-page` или `#topic-header`.

Рекомендуемые классы:

```text
.is-pinned
.is-locked
.is-closed
.is-hidden
.is-subscribed
```

Использовать только реально существующие состояния.

Пример:

```html
<main id="topic-page" class="is-pinned is-locked">
```

Не создавать отдельный уникальный CSS-класс для каждого состояния, если состояние можно выразить через `.is-*`.

---

# 7. Topic ID

Если тема имеет стабильный ID, рекомендуется добавить его через `id` и `data-*`:

```html
<main
    id="topic-page"
    class="topic topic-30"
    data-topic-id="30">
```

Если ID используется в URL/anchor и должен быть стабильным, можно дополнительно использовать:

```html
id="topic-30"
```

Но не создавать конфликтующие `id`.

### Рекомендуемый вариант

```html
<main
    id="topic-page"
    class="topic topic-30"
    data-topic-id="30">
```

Где:

- `#topic-page` — структурный селектор;
- `.topic` — тип сущности;
- `.topic-30` — адресная стилизация конкретной темы;
- `data-topic-id` — данные.

---

# 8. Topic actions

Действия над темой:

```html
<div id="topic-actions-top">
    ...
</div>
```

и при необходимости:

```html
<div id="topic-actions-bottom">
    ...
</div>
```

Например:

- ответить;
- подписаться;
- редактировать;
- закрыть;
- закрепить;
- переместить;
- удалить.

Кнопки должны иметь семантические классы.

Например:

```text
.topic-action-reply
.topic-action-subscribe
.topic-action-edit
.topic-action-lock
.topic-action-pin
.topic-action-move
.topic-action-delete
```

Использовать только доступные текущему пользователю действия.

---

# 9. Pagination

Для pagination:

```html
<nav id="topic-pagination-top">
    ...
</nav>
```

и:

```html
<nav id="topic-pagination-bottom">
    ...
</nav>
```

Внутренние классы:

```text
.pagination
.pagination-item
.pagination-link
.pagination-current
.pagination-prev
.pagination-next
```

Не делать pagination частью `.topic-post`.

---

# 10. Список сообщений

## `#topic-posts`

Контейнер всех сообщений темы.

```html
<section id="topic-posts">
    ...
</section>
```

Каждое сообщение является отдельной сущностью.

---

# 11. Post

## `.topic-post`

Каждый post:

```html
<article
    id="post-{postId}"
    class="topic-post post-{postId}"
    data-post-id="{postId}">
```

Например:

```html
<article
    id="post-581776"
    class="topic-post post-581776"
    data-post-id="581776">
```

В старой структуре Rusff сообщения используют идентификатор вида `p581776` и класс `.post`; этот принцип полезно сохранить на уровне стабильного идентификатора, но использовать более явный современный контракт. fileciteturn9file5L273-L294

Если приложение уже использует anchor вида `#p123`, можно сохранить его для URL-совместимости, но это не должно мешать новому theme API.

---

# 12. Post states

Состояния отдельного сообщения:

```text
.is-first
.is-topic-starter
.is-edited
.is-deleted
.is-hidden
.is-highlighted
.is-selected
.is-new
```

Использовать только существующие состояния.

Например:

```html
<article
    class="topic-post post-63 is-first is-topic-starter">
```

В исследованных страницах первый пост может дополнительно иметь признаки `firstpost` и `topic-starter`; это хороший пример состояния, которое в новом API лучше выразить через `.is-first` и `.is-topic-starter`. fileciteturn9file1L75-L79

---

# 13. Post layout

Рекомендуемая структура:

```text
.topic-post
├── .post-header
│   ├── .post-number
│   ├── .post-date
│   ├── .post-permalink
│   └── .post-actions
│
├── .post-container
│   ├── .post-author
│   └── .post-body
│       ├── .post-content
│       ├── .post-attachments
│       └── .post-signature
│
└── .post-footer
    ├── .post-reactions
    └── .post-links
```

Главная идея:

**author и body должны быть двумя явно различимыми областями сообщения.**

В исследованном Rusff DOM `.post-author` и `.post-body` уже являются отдельными областями сообщения. fileciteturn9file1L77-L91

---

# 14. Post header

## `.post-header`

Верхняя строка сообщения.

```html
<header class="post-header">
    ...
</header>
```

Рекомендуемые классы:

```text
.post-number
.post-date
.post-permalink
.post-actions
```

### `.post-number`

Номер сообщения.

```html
<a class="post-number">...</a>
```

### `.post-date`

Дата/время публикации.

Лучше использовать:

```html
<time class="post-date" datetime="...">
    ...
</time>
```

### `.post-permalink`

Ссылка на конкретное сообщение:

```html
<a class="post-permalink" href="#post-123">
    ...
</a>
```

Если permalink одновременно отображает дату, всё равно желательно иметь отдельный семантический класс.

---

# 15. Post actions

## `.post-actions`

Действия над конкретным сообщением.

Например:

```text
.post-action-reply
.post-action-quote
.post-action-edit
.post-action-delete
.post-action-report
.post-action-share
```

Не добавлять классы для функций, которых нет.

---

# 16. Author

## `.post-author`

Профиль автора сообщения.

В старой структуре эта область уже является отдельным блоком и содержит список полей автора. fileciteturn9file1L78-L88

Рекомендуемая структура:

```text
.post-author
├── .author-status
├── .author-name
├── .author-rank
├── .author-avatar
├── .author-custom-fields
├── .author-post-count
├── .author-reputation
└── .author-meta
```

---

# 17. Author states

Состояние online/offline:

```html
<div class="post-author is-online">
```

или:

```html
<div class="post-author is-offline">
```

Не использовать одновременно старые классы `.online` и `.offline` как единственный theme API.

В исходных форумах online часто добавляется непосредственно на `.post-author`. fileciteturn9file5L275-L282

---

# 18. Author name

## `.author-name`

```html
<a class="author-name" href="...">
    ...
</a>
```

Не использовать `.pa-author` как единственный публичный класс.

Если нужна обратная совместимость:

```html
<a class="pa-author author-name">
```

Но новый `.author-name` должен быть стабильным theme API.

---

# 19. Avatar

## `.author-avatar`

```html
<div class="author-avatar">
    <img src="..." alt="...">
</div>
```

Не делать avatar зависимым от порядкового класса вроде `.item2`.

В старых страницах avatar часто находится внутри `.pa-avatar item2`; `item2` не должен переноситься в новый theme API. fileciteturn9file1L81-L83

---

# 20. Author fields

Пользовательские поля профиля должны иметь семантическую структуру.

Например:

```html
<div class="author-custom-fields">
    ...
</div>
```

Отдельные поля:

```text
.author-field
.author-field-name
.author-field-value
```

Если поле имеет известный системный тип:

```text
.author-post-count
.author-reputation
.author-currency
```

Но не придумывать такие классы для неизвестных динамических полей.

---

# 21. Post body

## `.post-body`

Основная область сообщения:

```html
<div class="post-body">
    ...
</div>
```

В старой структуре внутри неё находится `.post-box`, а затем `.post-content`. fileciteturn9file5L291-L294

Новый API должен быть проще:

```text
.post-body
└── .post-content
```

Дополнительные контейнеры можно оставлять только если они нужны текущему layout или функциональности.

---

# 22. Post content

## `.post-content`

Содержимое сообщения:

```html
<div class="post-content">
    ...
</div>
```

Это должен быть основной контейнер пользовательского текста/HTML сообщения.

**Важно:** не навешивать на `.post-content` layout-классы Bootstrap, которые становятся обязательными для темы.

---

# 23. Quotes

Цитаты должны иметь собственный семантический класс:

```html
<blockquote class="post-quote">
    ...
</blockquote>
```

Если цитата имеет автора:

```text
.post-quote
.quote-author
.quote-content
.quote-link
```

Если приложение поддерживает ссылку на исходный пост, она должна быть отдельным:

```text
.quote-link
```

В старых форумах для quote используются отдельные скрипты и классы, но theme API не должен зависеть от конкретной реализации этих скриптов. fileciteturn9file2L116-L128

---

# 24. Attachments

Если сообщение поддерживает вложения:

```html
<div class="post-attachments">
    ...
</div>
```

Каждое вложение:

```html
<div class="post-attachment">
    ...
</div>
```

Дополнительные классы:

```text
.attachment-image
.attachment-file
.attachment-link
```

Использовать только если соответствующий тип существует.

---

# 25. Signature

Подпись:

```html
<div class="post-signature">
    ...
</div>
```

Она должна быть отдельной от `.post-content`.

Это позволяет теме полностью скрывать или переоформлять подпись:

```css
.post-signature {
    ...
}
```

---

# 26. Reactions

Если у движка есть реакции:

```html
<div class="post-reactions">
    ...
</div>
```

Каждая реакция:

```html
<button class="post-reaction">
    ...
</button>
```

Можно дополнительно использовать:

```text
.is-active
.is-selected
```

для текущего состояния реакции.

Не привязывать theme API к конкретному плагину реакций.

В исследованном источнике реакции реализованы дополнительными скриптами, что является примером того, почему базовый DOM должен оставаться независимым от конкретного плагина. fileciteturn9file3L168-L194

---

# 27. Post footer

## `.post-footer`

Нижняя часть сообщения:

```html
<footer class="post-footer">
    ...
</footer>
```

Рекомендуемые области:

```text
.post-reactions
.post-links
```

---

# 28. Post links

## `.post-links`

Ссылки и действия внизу сообщения:

```text
.post-link
.post-link-reply
.post-link-quote
.post-link-edit
.post-link-report
```

Не дублировать действие в DOM без необходимости. Если кнопка reply уже находится в `.post-actions`, нижняя ссылка должна существовать только если она реально есть в UI.

---

# 29. Reply form

## `#topic-reply`

Форма ответа в тему.

```html
<section id="topic-reply">
    ...
</section>
```

Если форма закрыта/недоступна, не ломать структуру страницы.

Рекомендуемые внутренние классы:

```text
.reply-header
.reply-form
.reply-editor
.reply-actions
.reply-submit
```

Если текущий редактор использует Bootstrap или сторонний компонент, его внутреннюю структуру не обязательно переписывать полностью. Достаточно предоставить стабильный внешний wrapper.

---

# 30. Topic-specific controls

Если тема поддерживает:

- опрос;
- подписку;
- уведомления;
- закладки;
- теги;
- специальные действия;

они должны находиться в отдельных семантических блоках, а не смешиваться с `.post-content`.

Например:

```text
.topic-poll
.topic-subscription
.topic-tags
.topic-bookmark
```

Использовать только реально существующие функции.

---

# 31. Data attributes

Рекомендуемые данные:

```html
data-topic-id="30"
data-post-id="581776"
data-user-id="545"
data-group-id="6"
```

Правило:

- `data-*` — идентификаторы и данные;
- `class` — типы и состояния;
- `id` — уникальный адрес/структурный anchor.

Не использовать `data-*` как замену всем CSS-классам.

---

# 32. Уникальные идентификаторы

Для сообщений:

```text
#post-{postId}
```

Для темы:

```text
#topic-page
```

Для структурных блоков:

```text
#topic-header
#topic-actions-top
#topic-pagination-top
#topic-posts
#topic-pagination-bottom
#topic-actions-bottom
#topic-reply
#topic-breadcrumbs-top
#topic-breadcrumbs-bottom
```

Не создавать `id` на каждый внутренний элемент без необходимости.

---

# 33. Recommended React components

Желательная архитектура:

```text
TopicView
├── ForumHeader
├── TopicBreadcrumbs
├── TopicHeader
├── TopicActions
├── TopicPagination
├── TopicPosts
│   └── TopicPost
│       ├── PostHeader
│       ├── PostAuthor
│       ├── PostBody
│       │   ├── PostContent
│       │   ├── PostAttachments
│       │   └── PostSignature
│       └── PostFooter
├── TopicPagination
├── TopicActions
├── TopicReply
├── TopicBreadcrumbs
└── ForumAbout
```

Не требуется дробить существующий React-код на десятки компонентов только ради этой схемы. Если компонент уже хорошо организован, можно оставить его как есть и привести его DOM к контракту.

---

# 34. Public Theme API

Следующие селекторы считаются публичным API страницы Topic View.

## Структурные ID

```text
#topic-page
#topic-header
#topic-actions-top
#topic-pagination-top
#topic-posts
#topic-pagination-bottom
#topic-actions-bottom
#topic-reply
#topic-breadcrumbs-top
#topic-breadcrumbs-bottom
```

## Topic

```text
.topic
.topic-title
.topic-description
.topic-meta
```

## Post

```text
.topic-post
.post-header
.post-number
.post-date
.post-permalink
.post-actions
.post-body
.post-content
.post-footer
.post-links
```

## Author

```text
.post-author
.author-status
.author-name
.author-rank
.author-avatar
.author-custom-fields
.author-post-count
.author-reputation
.author-meta
```

## Content

```text
.post-quote
.quote-author
.quote-content
.quote-link
.post-attachments
.post-attachment
.post-signature
.post-reactions
.post-reaction
```

## Reply

```text
.reply-header
.reply-form
.reply-editor
.reply-actions
.reply-submit
```

## States

```text
.is-first
.is-topic-starter
.is-edited
.is-deleted
.is-hidden
.is-highlighted
.is-selected
.is-new
.is-online
.is-offline

.is-pinned
.is-locked
.is-closed
.is-subscribed
```

---

# 35. Bootstrap

Bootstrap может оставаться внутри реализации.

Например:

```html
<article class="topic-post row post-123">
```

допустимо, если `topic-post` является стабильным классом темы.

Но тема не должна рассчитывать на:

```css
.row { ... }
.col-md-3 { ... }
.card { ... }
.btn { ... }
```

как на свой API.

Главный селектор должен быть:

```css
.topic-post { ... }
.post-author { ... }
.post-body { ... }
```

---

# 36. Что НЕ переносить из старого MyBB/Rusff

Не копировать буквально:

```text
.punbb
#pun-viewtopic
.post
.pa-author
.pa-title
.pa-avatar
.pa-posts
.pa-fld1
.pa-fld2
.pa-fld3
.pa-fld4
.pa-fld5
.item1
.item2
.post-box
```

Некоторые из этих классов могут быть оставлены временно ради обратной совместимости, но новый theme API должен использовать семантические классы.

Например, вместо:

```html
<li class="pa-avatar item2">
```

использовать:

```html
<div class="author-avatar">
```

А вместо:

```html
<li class="pa-posts">
```

использовать:

```html
<div class="author-post-count">
```

Смысл структуры сохраняется, но API становится понятным и независимым от конкретной версии движка.

---

# 37. Обратная совместимость

Перед изменением проверить:

1. текущие React-компоненты Topic View;
2. существующие props;
3. модель Topic;
4. модель Post;
5. модель User;
6. permissions;
7. существующие действия над сообщением;
8. редактор ответа;
9. quote/reply functionality;
10. permalink/anchor functionality;
11. реакции;
12. attachments;
13. пользовательские поля;
14. существующий CSS;
15. JavaScript, который ищет `.post`, `.post-author`, `.post-content` и другие классы.

Если старый класс используется функциональным JavaScript, не удалять его сразу.

Можно временно сделать:

```html
<article class="post topic-post post-123">
```

или:

```html
<div class="pa-avatar author-avatar">
```

Но новые классы должны стать основным API для будущей темы.

---

# 38. Проверка после изменений

После переработки проверить:

### Topic

- название темы отображается;
- breadcrumbs работают;
- pagination работает;
- topic actions работают;
- состояния темы отображаются.

### Posts

- все сообщения отображаются;
- первый пост корректно определяется;
- автор отображается;
- avatar отображается;
- пользовательские поля отображаются;
- дата и permalink работают;
- post content отображается;
- quotes работают;
- attachments работают;
- signature работает;
- reactions работают;
- действия сообщения работают.

### Reply

- форма ответа отображается;
- editor работает;
- submit работает;
- permissions учитываются;
- закрытая тема не показывает/не позволяет недоступные действия.

### Theme API

Проверить наличие:

```text
#topic-page
#topic-header
#topic-posts
.topic-post
.post-author
.post-body
.post-content
```

и уникальных:

```text
#post-{postId}
```

для каждого сообщения.

---

# 39. Главный принцип

**Каждое сообщение — независимая стилизуемая сущность.**

Тема должна иметь возможность написать, например:

```css
.topic-post {
    ...
}

.post-author {
    ...
}

.post-body {
    ...
}

.post-123 {
    ...
}

.post-123 .author-avatar {
    ...
}
```

без знания того, какой Bootstrap layout используется внутри React.

При этом React-компоненты, Bootstrap и внутренняя реализация могут изменяться, пока сохраняется публичный DOM-контракт.

---

# 40. Связь с другими спецификациями

Эта спецификация относится только к:

# Topic View / Просмотр темы

Она должна использовать общие правила из спецификации:

```text
Forum Index / Главная страница форума
```

В дальнейшем аналогичным образом должны быть описаны:

```text
Forum View / Список тем
Member List
Member Profile
Search
Private Messages
Login
Registration
User Settings
```

Каждый документ должен описывать **отдельную страницу**, её назначение и публичный Theme DOM API.

В результате все страницы форума смогут использовать единую систему:

```text
#forum
    #forum-header
    ...
    #forum-main

        #topic-page
            #topic-header
            #topic-posts
                .topic-post
                    .post-author
                    .post-body
```

а кастомная тема сможет стилизовать движок без зависимости от конкретной React/Bootstrap реализации.
