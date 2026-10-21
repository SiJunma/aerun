# Themeable DOM Refactoring — мастер-план для агентов

## Оглавление

1. [Контекст и цель](#1-контекст-и-цель)
2. [Архитектурные решения](#2-архитектурные-решения)
3. [Текущая структура проекта](#3-текущая-структура-проекта)
4. [Спецификации по страницам — что уже есть](#4-спецификации-по-страницам--что-уже-есть)
5. [Спецификации по страницам — что нужно создать](#5-спецификации-по-страницам--что-нужно-создать)
6. [Спринт 0 — Инфраструктура](#спринт-0--инфраструктура)
7. [Спринт 1 — Layout, Navbar, общий каркас](#спринт-1--layout-navbar-общий-каркас)
8. [Спринт 2 — Forum Index (MainPage)](#спринт-2--forum-index-mainpage)
9. [Спринт 3 — Forum View (CategoryPage + TopicRow)](#спринт-3--forum-view-categorypage--topicrow)
10. [Спринт 4 — Topic View (TopicPage)](#спринт-4--topic-view-topicpage)
11. [Спринт 5 — Members View (MembersPage)](#спринт-5--members-view-memberspage)
12. [Спринт 6 — Profile (ProfilePage)](#спринт-6--profile-profilepage)
13. [Спринт 7 — Списки тем: Active Topics, New Replies, Subscriptions](#спринт-7--списки-тем-active-topics-new-replies-subscriptions)
14. [Спринт 8 — Уведомления (NotificationsPage)](#спринт-8--уведомления-notificationspage)
15. [Спринт 9 — Создание темы (TopicFormPage)](#спринт-9--создание-темы-topicformpage)
16. [Спринт 10 — Личные сообщения (MessagesPage + DirectMessages)](#спринт-10--личные-сообщения-messagespage--directmessages)
17. [Спринт 11 — Аутентификация и служебные страницы](#спринт-11--аутентификация-и-служебные-страницы)
18. [Спринт 12 — Админка (AdminPage + DesignsTab)](#спринт-12--админка-adminpage--designstab)
19. [Спринт 13 — Themeable CSS базовый файл](#спринт-13--themeable-css-базовый-файл)
20. [Спринт 14 — Theme API Reference документация](#спринт-14--theme-api-reference-документация)
21. [Спринт 15 — Интеграционное тестирование](#спринт-15--интеграционное-тестирование)
22. [Зависимости между спринтами](#зависимости-между-спринтами)
23. [Общие правила для агентов](#общие-правила-для-агентов)

---

# 1. Контекст и цель

Aerun Forum — это React + Firebase SPA-форум с системой кастомных дизайнов. Администраторы создают дизайны (CSS + JS), которые инжектятся на страницу через `DesignProvider`.

**Проблема:** текущий DOM построен целиком на Bootstrap-компонентах (`Card`, `Table`, `Row`, `Col`, `Badge`) без семантических классов и стабильных `id`. Кастомный CSS не может надёжно стилизовать форум, т.к. нет публичного DOM API.

**Цель:** перестроить DOM всех страниц форума так, чтобы при активном кастомном дизайне рендерилась стабильная семантическая разметка с `id`, `class` и `data-*` атрибутами, описанная в спецификациях `markdowns/`. Это позволит CSS-темам полностью переоформлять форум без знания внутренней React-реализации.

**Стратегия безопасности:** существующие 3 встроенные темы (`dark`, `light`, `neutral`) **не изменяются**. Новая семантическая разметка активируется **только** при работе с кастомным дизайном. Тестируем через уже существующий механизм `?preview_design=`.

---

# 2. Архитектурные решения

## 2.1. Themeable — это НЕ встроенная тема

`Themeable` **не** добавляется в `BUILTIN_THEMES = ['dark', 'light', 'neutral']`. Он не появляется как вариант выбора рядом с dark/light/neutral.

**Themeable** — это каркас (engine), который активируется автоматически, когда пользователь выбирает кастомный дизайн. В будущем возможны разные каркасы (например, «classic», «modern», «minimal»), поэтому механизм должен быть спроектирован как выбираемый framework, а не жёстко привязанный к одному варианту.

## 2.2. Механизм активации

```
Пользователь выбирает кастомный дизайн (в профиле или через админку)
→ DesignProvider находит design в Firestore
→ DesignProvider инжектит CSS/JS
→ ThemeProvider устанавливает на <body>:
     data-theme-engine="themeable"
     data-theme="dark"  (или другая базовая тема — base fallback)
→ Компоненты через хук useThemeable() узнают, что нужно рендерить семантическую разметку
```

Когда custom design не активен (стандартная тема dark/light/neutral):
- `data-theme-engine` **отсутствует** на `<body>`
- Компоненты рендерят текущий JSX без изменений
- Никакого влияния на существующий UI

## 2.3. Что меняется в компонентах

При `isThemeable === true` компоненты добавляют:
1. **Семантические `id`** на структурные контейнеры (`#forum-wrapper`, `#forum-main`, `#topic-page`, etc.)
2. **Семантические `class`** на все значимые элементы (`.forum-item`, `.topic-item`, `.post-author`, etc.)
3. **`data-*` атрибуты** на сущности (`data-topic-id`, `data-post-id`, `data-user-id`, etc.)
4. **State-классы** (`.is-pinned`, `.is-locked`, `.is-online`, `.is-new`, `.is-unread`, etc.)

Bootstrap-классы **сохраняются** для внутреннего layout. Семантические классы добавляются **рядом**, не вместо.

Пример:
```jsx
// До (сейчас):
<tr className="topic-row-hover">

// После (при isThemeable):
<article id="topic-42" className="topic-item topic-42 is-pinned topic-row-hover"
         data-topic-id="42">
```

## 2.4. Файловая структура

Новые файлы:
```
src/
  hooks/
    useThemeable.js          ← хук для проверки isThemeable
  styles/
    themeable.css             ← базовые стили для [data-theme-engine="themeable"]
    utilities.css             ← существующий файл
markdowns/
  THEMEABLE_SPRINT_PLAN.md    ← этот документ
  theme-api-reference.md      ← итоговая справка Theme API (создаётся в спринте 14)
```

---

# 3. Текущая структура проекта

## 3.1. Система тем

| Файл | Назначение |
|------|-----------|
| `src/contexts/ThemeProvider.jsx` | Устанавливает `data-theme` на `<body>`, управляет dark/light/neutral |
| `src/contexts/DesignProvider.jsx` | Загружает кастомные дизайны из Firestore, инжектит CSS/JS через `<style>` и `<script>` |
| `src/components/admin/DesignsTab.jsx` | UI админки для создания/редактирования дизайнов |
| `src/index.css` | 4062 строки — все стили, CSS-переменные для 3 тем |
| `src/styles/utilities.css` | Утилитарные стили |

## 3.2. Все страницы форума

| Маршрут | Файл | Размер | Сложность DOM-рефакторинга |
|---------|------|--------|---------------------------|
| `/` | `pages/MainPage.jsx` | 231 стр. | Средняя |
| `/category/:id` | `pages/CategoryPage.jsx` | 392 стр. | Средняя |
| `/topic/:id` | `pages/TopicPage.jsx` | **3681 стр.** | **Высокая** ⚠️ |
| `/members` | `pages/MembersPage.jsx` | 345 стр. | Средняя |
| `/profile/:uid` | `pages/ProfilePage.jsx` | **1802 стр.** | **Высокая** |
| `/admin` | `pages/AdminPage.jsx` | **2032 стр.** | Средняя |
| `/active-topics` | `pages/ActiveTopicsPage.jsx` | 106 стр. | Низкая |
| `/new-replies` | `pages/NewRepliesPage.jsx` | 206 стр. | Низкая |
| `/subscriptions` | `pages/SubscriptionsPage.jsx` | 144 стр. | Низкая |
| `/notifications` | `pages/NotificationsPage.jsx` | 687 стр. | Средняя |
| `/category/:id/new-topic` | `pages/TopicFormPage.jsx` | 326 стр. | Низкая |
| `/messages`, `/messages/:uid` | `pages/MessagesPage.jsx` | 77 стр. | Низкая |
| `/login` | `pages/LoginPage.jsx` | 67 стр. | Минимальная |
| `/register` | `pages/RegisterPage.jsx` | 60 стр. | Минимальная |
| `/pending` | `pages/PendingPage.jsx` | 57 стр. | Минимальная |
| `/banned` | `pages/BannedPage.jsx` | 45 стр. | Минимальная |

## 3.3. Общие компоненты (layout и common)

| Файл | Назначение | Изменения нужны |
|------|-----------|----------------|
| `components/layout/Layout.jsx` | Общий каркас: Navbar + main + footer | **Да** — `#forum-wrapper`, `#forum`, `#forum-about` |
| `components/layout/Navbar.jsx` | Навигация | **Да** — `#forum-nav`, `#forum-title`, `#forum-user-links` |
| `components/layout/ForumStats.jsx` | Статистика внизу главной | **Да** — `#forum-statistics`, `.stat-*` |
| `components/layout/ForumBackground.jsx` | Фоновое изображение | Нет |
| `components/common/ForumBreadcrumbs.jsx` | Хлебные крошки | **Да** — `id`, `.breadcrumb-item`, `.breadcrumb-link` |
| `components/common/ForumPagination.jsx` | Пагинация | **Да** — `id`, `.pagination-item`, `.pagination-current` |
| `components/common/TopicRow.jsx` | Строка темы в списке | **Да** — `.topic-item`, `.topic-title`, `.is-*` |
| `components/common/LastPostInfo.jsx` | Блок последнего сообщения | **Да** — `.last-post-*` |
| `components/common/AuthorMeta.jsx` | Мета автора | **Да** — `.topic-author`, `.topic-author-name` |
| `components/common/ForumAuthorAvatar.jsx` | Аватар автора | **Да** — `.author-avatar` |
| `components/common/ForumAuthorName.jsx` | Имя автора | **Да** — `.author-name` |
| `components/common/ForumRoleBadge.jsx` | Бейдж роли | **Да** — `.author-rank` |
| `components/common/BBCode.jsx` | Рендер BB-кода | Нет (внутри `.post-content`) |
| `components/common/RichEditor.jsx` | Редактор сообщений | Нет (внутри `.reply-editor`) |
| `components/common/Timestamp.jsx` | Компонент даты/времени | Минимально — `.post-date` |
| `components/dm/DirectMessages.jsx` | Личные сообщения | **Да** — `.dm-*` классы |
| `components/auth/LoginForm.jsx` | Форма входа | Да — `.login-form` |
| `components/auth/RegisterForm.jsx` | Форма регистрации | Да — `.register-form` |
| `components/profile/SecurityTab.jsx` | Таб безопасности профиля | Да — `.profile-security` |

---

# 4. Спецификации по страницам — что уже есть

Существуют 3 подробные спецификации в `markdowns/`:

| Спецификация | Покрывает |
|-------------|----------|
| `forum-index-theme-dom-spec.md` | **Forum Index** — главная страница (`/`). Категории, форумы, статистика |
| `forum-and-members-theme-dom-spec.md` | **Forum View** — страница категории (`/category/:id`) + **Members View** — участники (`/members`) |
| `forum-topic-view-theme-dom-spec.md` | **Topic View** — просмотр темы (`/topic/:id`) |

Эти спецификации являются **основным источником истины** для DOM-контракта. Агент ОБЯЗАН прочитать соответствующую спецификацию перед началом работы над компонентом.

---

# 5. Спецификации по страницам — что нужно создать

Для страниц, **не** покрытых существующими спецификациями, агент должен следовать общим принципам из раздела 1 файла `forum-index-theme-dom-spec.md` и нижеприведённым мини-спецификациям в этом документе.

Страницы, для которых нужны DOM-спецификации (мини-спецификации приведены ниже в спринтах):

1. **Profile** (`/profile/:uid`) — профиль пользователя
2. **Active Topics** (`/active-topics`) — активные темы
3. **New Replies** (`/new-replies`) — новые ответы / непрочитанные
4. **Subscriptions** (`/subscriptions`) — подписки
5. **Notifications** (`/notifications`) — уведомления
6. **Topic Form** (`/category/:id/new-topic`) — создание темы
7. **Messages** (`/messages`, `/messages/:uid`) — личные сообщения
8. **Login** (`/login`) — вход (также «белая стена для гостей» при `whitelistMode`)
9. **Register** (`/register`) — регистрация
10. **Pending** (`/pending`) — ожидание подтверждения
11. **Banned** (`/banned`) — заблокирован
12. **Admin** (`/admin`) — панель администратора
13. **Members** (`/members`) — список участников
14. **Drafts** (`/drafts`) — список черновиков 

---

# Спринт 0 — Инфраструктура

## Цель
Создать базовую инфраструктуру: хук `useThemeable`, атрибут `data-theme-engine`, пустой CSS-файл. После этого спринта ни один компонент ещё не изменён, но механизм переключения работает.

## Файлы

### [НОВЫЙ] `src/hooks/useThemeable.js`

```js
// Хук, который компоненты используют для определения режима themeable
// Возвращает { isThemeable: boolean, engineName: string | null }
//
// isThemeable = true когда DesignProvider имеет activeDesign !== null
// engineName = "themeable" (в будущем возможны другие каркасы)
//
// Использование в компоненте:
//   const { isThemeable } = useThemeable();
//   return (
//     <div id={isThemeable ? "forum-main" : undefined}
//          className={`existing-class ${isThemeable ? 'forum-main' : ''}`}>
//   );
```

Реализация:
- Импортирует `useDesign` из `DesignProvider`
- Возвращает `{ isThemeable: !!activeDesign, engineName: activeDesign ? 'themeable' : null }`

### [ИЗМЕНИТЬ] `src/contexts/ThemeProvider.jsx`

Добавить логику:
- Когда `DesignProvider.activeDesign !== null` → установить `document.body.setAttribute('data-theme-engine', 'themeable')`
- Когда `activeDesign === null` → `document.body.removeAttribute('data-theme-engine')`
- Координация: `ThemeProvider` должен получать информацию об `activeDesign`. Варианты:
  - (a) Импортировать `useDesign` в `ThemeProvider`
  - (b) Вынести эту логику в `DesignProvider` (он уже знает про `activeDesign`)
  - **Рекомендация: вариант (b)** — добавить `data-theme-engine` прямо в `DesignProvider.jsx`, рядом с существующей логикой инжекта CSS/JS

### [ИЗМЕНИТЬ] `src/contexts/DesignProvider.jsx`

В `useEffect` где инжектится CSS/JS, добавить:
```js
if (activeDesign) {
  document.body.setAttribute('data-theme-engine', 'themeable');
  // ... existing CSS/JS injection ...
} else {
  document.body.removeAttribute('data-theme-engine');
  // ... existing cleanup ...
}
```

### [НОВЫЙ] `src/styles/themeable.css`

Пустой файл-заготовка. Все стили за selector `[data-theme-engine="themeable"]`. Будет наполнен в спринте 13.

```css
/* Themeable Engine — базовые стили для кастомных дизайнов */
/* Все правила ниже действуют ТОЛЬКО при data-theme-engine="themeable" */

[data-theme-engine="themeable"] {
  /* CSS-переменные для кастомных тем будут добавлены позже */
}
```

### [ИЗМЕНИТЬ] `src/main.jsx`

Добавить `import './styles/themeable.css';` после импорта `index.css`.

## Критерий готовности
- При активном custom design на `<body>` появляется `data-theme-engine="themeable"`
- При стандартной теме (dark/light/neutral) атрибута нет
- `useThemeable()` возвращает `{ isThemeable: true }` при custom design
- Визуально ничего не изменилось — ни для стандартных тем, ни для custom designs

---

# Спринт 1 — Layout, Navbar, общий каркас

## Цель
Привести `Layout.jsx`, `Navbar.jsx`, `ForumStats.jsx`, `ForumBreadcrumbs.jsx`, `ForumPagination.jsx` к стабильной DOM-структуре. Эти компоненты общие для ВСЕХ страниц.

## Целевая структура (при `isThemeable`)

```
<div id="forum-wrapper">
  <div id="forum">
    <ForumBackground />
    <header id="forum-header">
      <div id="forum-title">              ← логотип + название форума
        <a class="forum-logo">...</a>
        <span class="forum-name">...</span>
      </div>
      <nav id="forum-nav">                ← навигационные ссылки
        <a class="nav-link nav-home">...</a>
        <a class="nav-link nav-members">...</a>
        <a class="nav-link nav-active-topics">...</a>
        ...
      </nav>
      <div id="forum-user-links">         ← ссылки пользователя
        <a class="user-profile">...</a>
        <a class="user-notifications">...</a>
        <a class="user-messages">...</a>
        <a class="user-settings">...</a>
        <a class="user-logout">...</a>
      </div>
    </header>
    <div id="forum-announcement">...</div>  ← welcomeMessage, только на главной
    <div id="forum-status">...</div>        ← maintenance banner, verification banner
    <main>                                  ← каждая страница добавит свой id через children
      {children}
    </main>
    <footer id="forum-about">              ← copyright, ссылки
      ...
    </footer>
  </div>
</div>
```

## Файлы

### [ИЗМЕНИТЬ] `src/components/layout/Layout.jsx`

**Текущий DOM:**
```
<>
  <ForumBackground />
  <div className="app-wrapper">
    <ConnectionStatusBanner />
    <Navigation />
    ...maintenance banner...
    ...email verification banner...
    ...welcome message...
    <main className="py-2"><Container>{children}</Container></main>
  </div>
  <footer className="footer-custom py-2">...</footer>
  <ScrollButtons />
</>
```

**Что изменить при `isThemeable`:**
- Обернуть всё в `<div id="forum-wrapper">` → `<div id="forum">`
- `<Navigation />` обернуть в `<header id="forum-header">`
- Banners → `<div id="forum-status">`
- Welcome message → `<div id="forum-announcement">`
- Footer → `<footer id="forum-about">`
- **Bootstrap-классы и `<Container>` сохраняются** для layout, добавляются семантические id/class

**Что НЕ менять при `!isThemeable`:**
- Весь текущий JSX остаётся без изменений

### [ИЗМЕНИТЬ] `src/components/layout/Navbar.jsx`

- На корневой `<Navbar>` (Bootstrap) добавить: при isThemeable id не ставить на Navbar (Bootstrap уже контролирует его), но внутренние блоки снабдить id
- Блок с логотипом/названием форума → `id="forum-title"`, `.forum-logo`, `.forum-name`
- Навигационные ссылки → каждая получает семантический класс: `.nav-home`, `.nav-members`, `.nav-active`, `.nav-search`, `.nav-new-replies`, `.nav-subscriptions`, `.nav-admin`
- Блок пользовательских ссылок (профиль, уведомления, тема, выход) → `id="forum-user-links"`, внутренние элементы: `.user-profile`, `.user-notifications`, `.user-messages`, `.user-theme-picker`, `.user-logout`

### [ИЗМЕНИТЬ] `src/components/layout/ForumStats.jsx`

- Обернуть в `<section id="forum-statistics">`
- Каждый показатель → семантический класс:
  - `.stat-topics` — всего тем
  - `.stat-posts` — всего сообщений
  - `.stat-members` — всего участников
  - `.stat-newest-member` — последний зарегистрированный
  - `.stat-online` — онлайн
  - `.stat-visitors` — посетители

### [ИЗМЕНИТЬ] `src/components/common/ForumBreadcrumbs.jsx`

- Добавить props: `position` (`"top"` | `"bottom"`) и `pagePrefix` (строка, напр. `"forum"`, `"topic"`, `"members"`)
- При `isThemeable` рендерить `id="{pagePrefix}-breadcrumbs-{position}"` на `<nav>`
- Внутренние элементы: `.breadcrumb-item`, `.breadcrumb-link`

### [ИЗМЕНИТЬ] `src/components/common/ForumPagination.jsx`

- Добавить prop `paginationId` (строка, напр. `"forum-pagination-top"`)
- При `isThemeable` рендерить `id={paginationId}` на контейнере
- Внутренние элементы: `.pagination-item`, `.pagination-link`, `.pagination-current`, `.pagination-prev`, `.pagination-next`

## Критерий готовности
- При `isThemeable`: в DOM видны `#forum-wrapper`, `#forum`, `#forum-header`, `#forum-title`, `#forum-nav`, `#forum-user-links`, `#forum-about`
- При `!isThemeable`: DOM идентичен текущему
- Визуально ничего не поломано ни для одной темы

---

# Спринт 2 — Forum Index (MainPage)

## Спецификация
**Основной источник:** `markdowns/forum-index-theme-dom-spec.md`

## Файлы

### [ИЗМЕНИТЬ] `src/pages/MainPage.jsx`

**Текущий DOM (упрощённо):**
```
<div className="pt-5 pb-4">
  {groups.map(group => (
    <Card className="forum-group-card bg-transparent">
      <div className="forum-group-header"><h4>{group.title}</h4></div>
      <Table hover responsive className="forum-table forum-table-sub">
        <thead><tr>...</tr></thead>
        <tbody>
          {categories.map(cat => (
            <tr>
              <td>link + description</td>
              <td>topics count</td>
              <td>posts count</td>
              <td>last post info</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  ))}
  <ForumStats />
</div>
```

**Целевой DOM при `isThemeable`:**
```
<div id="forum-index" class="forum-index">
  <nav id="forum-breadcrumbs-top">...</nav>
  
  <main id="forum-main">
    <!-- Каждый group → section.forum-category -->
    <section id="forum-category-{groupId}" 
             class="forum-category category-{groupId}"
             data-category-id="{groupId}">
      <header class="category-header">
        <h2 class="category-title">{group.title}</h2>
      </header>
      <div class="category-content">
        <!-- Каждая категория в группе → article.forum-item -->
        <article id="forum-item-{catId}" 
                 class="forum-item forum-item-{catId} [is-new] [is-unread]"
                 data-forum-id="{catId}">
          <div class="forum-icon">...</div>
          <div class="forum-info">
            <h3 class="forum-title"><a href="/category/{catId}">...</a></h3>
            <div class="forum-description">...</div>
          </div>
          <div class="forum-topics" data-value="{N}">{N}</div>
          <div class="forum-posts" data-value="{N}">{N}</div>
          <div class="forum-last-post">
            <div class="last-post-avatar">...</div>
            <a class="last-post-link" href="...">...</a>
            <time class="last-post-date">...</time>
            <a class="last-post-author" href="...">...</a>
          </div>
        </article>
      </div>
    </section>
  </main>
  
  <section id="forum-statistics">...</section>
  <nav id="forum-breadcrumbs-bottom">...</nav>
</div>
```

**Маппинг терминов:**
- В коде `group` → в спецификации `category` (группа категорий)
- В коде `category` → в спецификации `forum-item` (подфорум внутри категории)

### [ИЗМЕНИТЬ] `src/components/common/LastPostInfo.jsx`

- Добавить prop `contextClass` (`"forum-last-post"` или `"topic-last-post"`)
- При `isThemeable` обернуть в `<div class="{contextClass}">`
- Внутри: `.last-post-avatar`, `.last-post-link`, `.last-post-date`, `.last-post-author`

## Критерий готовности
- Чек-лист из раздела 48 `forum-and-members-theme-dom-spec.md` → Forum View → все пункты проходят
- Главная страница визуально и функционально работает при обеих режимах

---

# Спринт 3 — Forum View (CategoryPage + TopicRow)

## Спецификация
**Основной источник:** `markdowns/forum-and-members-theme-dom-spec.md`, разделы 2-16

## Файлы

### [ИЗМЕНИТЬ] `src/pages/CategoryPage.jsx`

**Целевой DOM при `isThemeable`:**
```
<div id="forum-view" class="forum-view forum-{categoryId}" data-forum-id="{categoryId}">
  <nav id="forum-breadcrumbs-top">...</nav>
  <header id="forum-header">
    <h1 class="forum-title">{category.title}</h1>
    <div class="forum-description">{category.description}</div>
  </header>
  <div id="forum-actions-top">
    <!-- кнопки управления: новая тема, manage -->
  </div>
  <nav id="forum-pagination-top" class="forum-pagination is-top">...</nav>
  <div id="forum-topic-list">
    <div class="topic-list-header">
      <div class="topic-column">...</div>
      <div class="topic-replies">...</div>
      <div class="topic-views">...</div>
      <div class="topic-last-post">...</div>
    </div>
    <div class="topic-list">
      <!-- pinned topics -->
      <!-- regular topics -->
    </div>
  </div>
  <nav id="forum-pagination-bottom" class="forum-pagination is-bottom">...</nav>
  <div id="forum-actions-bottom">...</div>
  <nav id="forum-breadcrumbs-bottom">...</nav>
</div>
```

### [ИЗМЕНИТЬ] `src/components/common/TopicRow.jsx`

**Критически важный компонент** — используется на 4 страницах: CategoryPage, ActiveTopicsPage, NewRepliesPage, SubscriptionsPage.

**Текущий DOM:** `<tr className="topic-row-hover">` с `<td>` внутри

**Целевой DOM при `isThemeable`:**
```
<article id="topic-{topicId}" 
         class="topic-item topic-{topicId} [is-sticky] [is-locked] [is-new] [is-unread]"
         data-topic-id="{topicId}">
  <div class="topic-icon">...</div>
  <div class="topic-main">
    <a class="topic-title" href="/topic/{id}">{title}</a>
    <div class="topic-author">
      <a class="topic-author-link" href="/profile/{authorId}">
        <span class="topic-author-name">{authorName}</span>
      </a>
    </div>
    <nav class="topic-pagination"><!-- mini-pagination --></nav>
  </div>
  <div class="topic-replies" data-value="{N}">{N}</div>
  <div class="topic-views" data-value="{N}">{N}</div>
  <div class="topic-last-post">
    <a class="last-post-avatar" href="/profile/{id}"><img ...></a>
    <a class="last-post-link" href="/topic/{id}">...</a>
    <time class="last-post-date" datetime="...">...</time>
    <a class="last-post-author" href="/profile/{id}">...</a>
  </div>
</article>
```

**ВАЖНО**: При `isThemeable` компонент должен рендерить `<article>` вместо `<tr>`. Это значит, что страницы, использующие TopicRow, должны при `isThemeable` рендерить контейнер как `<div class="topic-list">` вместо `<Table>`. Сам TopicRow должен определять через prop или хук, какой элемент рендерить.

**State-классы на `.topic-item`:**
- `topic.is_pinned` → `.is-sticky`
- `topic.is_locked` → `.is-locked`
- `hasUnread` → `.is-unread` / `.is-new`

### [ИЗМЕНИТЬ] `src/components/common/AuthorMeta.jsx`
- При `isThemeable` добавить `.topic-author`, `.topic-author-name`, `.topic-author-link`

## Критерий готовности
- Чек-лист из раздела 48 `forum-and-members-theme-dom-spec.md` → Forum View → все пункты проходят
- Все 4 страницы, использующие TopicRow, работают корректно

---

# Спринт 4 — Topic View (TopicPage)

## Спецификация
**Основной источник:** `markdowns/forum-topic-view-theme-dom-spec.md`

## ⚠️ Предупреждение

**TopicPage.jsx — 3681 строка, 172KB.** Самый большой и сложный файл проекта. Содержит огромное количество бизнес-логики: посты, черновики, реакции, цитирование, редактирование, модерация, real-time подписки, пагинация, голоса, уведомления.

**Правила для агента:**
1. **ТОЛЬКО DOM-изменения.** Ноль изменений в бизнес-логике, state management, API-вызовах, useEffect, обработчиках событий.
2. Перед началом — полностью прочитать файл и понять его структуру.
3. Каждый пост в JSX найти и обернуть семантическими элементами.
4. Тестировать после каждого блока изменений.

## Целевой DOM при `isThemeable`

### Корневой контейнер темы
```
<main id="topic-page" 
      class="topic topic-{topicId} [is-pinned] [is-locked] [is-closed]"
      data-topic-id="{topicId}">
```

### Заголовок темы
```
<header id="topic-header">
  <h1 class="topic-title">{topic.title}</h1>
  <div class="topic-description">{topic.description}</div>
  <div class="topic-meta">
    <!-- автор, дата создания, количество сообщений, статус -->
  </div>
</header>
```

### Breadcrumbs и пагинация
```
<nav id="topic-breadcrumbs-top">...</nav>
<div id="topic-actions-top">
  <button class="topic-action-reply">...</button>
  <button class="topic-action-subscribe">...</button>
  ...
</div>
<nav id="topic-pagination-top">...</nav>
```

### Список постов
```
<section id="topic-posts">
  <article id="post-{postId}" 
           class="topic-post post-{postId} [is-first] [is-topic-starter] [is-edited] [is-deleted]"
           data-post-id="{postId}" data-user-id="{authorId}">
    
    <header class="post-header">
      <a class="post-number">#{N}</a>
      <time class="post-date" datetime="...">{date}</time>
      <a class="post-permalink" href="#post-{id}">⟶</a>
      <div class="post-actions">
        <button class="post-action-quote">...</button>
        <button class="post-action-edit">...</button>
        <button class="post-action-delete">...</button>
        <button class="post-action-report">...</button>
      </div>
    </header>
    
    <div class="post-container">
      <div class="post-author [is-online] [is-offline]" 
           data-user-id="{id}" data-group-id="{roleId}">
        <div class="author-status"><!-- online dot --></div>
        <a class="author-name" href="/profile/{uid}">{name}</a>
        <div class="author-rank">{role badge}</div>
        <div class="author-avatar"><img src="..." alt="..."></div>
        <div class="author-custom-fields">
          <div class="author-field">
            <span class="author-field-name">...</span>
            <span class="author-field-value">...</span>
          </div>
        </div>
        <div class="author-post-count">{N}</div>
        <div class="author-reputation">{N}</div>
      </div>
      
      <div class="post-body">
        <div class="post-content">
          <!-- user HTML content (BBCode rendered) -->
          <!-- blockquote.post-quote внутри контента -->
        </div>
        <div class="post-attachments">
          <div class="post-attachment">...</div>
        </div>
        <div class="post-signature">...</div>
      </div>
    </div>
    
    <footer class="post-footer">
      <div class="post-reactions">
        <button class="post-reaction [is-active]">...</button>
      </div>
      <div class="post-links">
        <a class="post-link-reply">...</a>
        <a class="post-link-quote">...</a>
      </div>
    </footer>
  </article>
</section>
```

### Нижняя часть
```
<nav id="topic-pagination-bottom">...</nav>
<div id="topic-actions-bottom">...</div>
<section id="topic-reply">
  <div class="reply-header">...</div>
  <form class="reply-form">
    <div class="reply-editor"><!-- RichEditor --></div>
    <div class="reply-actions">
      <button class="reply-submit">...</button>
    </div>
  </form>
</section>
<nav id="topic-breadcrumbs-bottom">...</nav>
```

## State-классы

**На `#topic-page`:**
- `topic.is_pinned` → `.is-pinned`
- `topic.is_locked` → `.is-locked`

**На `.topic-post`:**
- Первый пост → `.is-first`
- Автор совпадает с автором темы → `.is-topic-starter`
- `post.edited_at` → `.is-edited`

**На `.post-author`:**
- `isUserOnline(uid)` → `.is-online` / `.is-offline`

## Критерий готовности
- Чек-лист из раздела 38 `forum-topic-view-theme-dom-spec.md`
- Все посты рендерятся, цитаты работают, реакции работают, пагинация работает
- Форма ответа работает
- Якоря `#post-{id}` работают для навигации

---

# Спринт 5 — Members View (MembersPage)

## Спецификация
**Основной источник:** `markdowns/forum-and-members-theme-dom-spec.md`, разделы 17-37

## Файлы

### [ИЗМЕНИТЬ] `src/pages/MembersPage.jsx`

**Целевой DOM при `isThemeable`:**
```
<div id="members-page" class="members-page">
  <nav id="members-breadcrumbs-top">...</nav>
  <header id="members-header">
    <h1 class="members-title">{t('nav.members')}</h1>
  </header>
  <nav id="members-pagination-top" class="members-pagination is-top">...</nav>
  <form id="members-filters">
    <div class="members-search">
      <label class="members-filter-label" for="members-search-input">...</label>
      <input id="members-search-input" class="members-search-input" ...>
    </div>
    <div class="members-sort">
      <label class="members-filter-label">...</label>
      <select class="members-sort-select">...</select>
    </div>
    <div class="members-sort-direction">
      <label class="members-filter-label">...</label>
      <select class="members-sort-direction-select">...</select>
    </div>
    <div class="members-filter-actions">
      <button class="members-filter-submit">...</button>
    </div>
  </form>
  <div id="members-list">
    <div class="members-list-header">...</div>
    <div class="member-list">
      <article id="member-{userId}" 
               class="member-item member-{userId} group-{groupId} [is-online] [is-offline]"
               data-user-id="{userId}" data-group-id="{roleId}">
        <div class="member-user">
          <a class="member-avatar" href="/profile/{uid}"><img ...></a>
          <span class="member-online-indicator" aria-label="Online"></span>
          <a class="member-name" href="/profile/{uid}">{nickname}</a>
        </div>
        <div class="member-title">{role name}</div>
        <div class="member-reputation">{N}</div>
        <div class="member-posts">{N}</div>
        <div class="member-registered"><time>...</time></div>
        <div class="member-last-visit"><time>...</time></div>
      </article>
    </div>
  </div>
  <nav id="members-pagination-bottom" class="members-pagination is-bottom">...</nav>
  <nav id="members-breadcrumbs-bottom">...</nav>
</div>
```

**Примечание:** MembersPage поддерживает два вида: table и stacked (карточки). При `isThemeable` оба варианта должны использовать одинаковые семантические классы. Тема сама решает через CSS как отображать.

## Критерий готовности
- Чек-лист из раздела 48 `forum-and-members-theme-dom-spec.md` → Members View

---

# Спринт 6 — Profile (ProfilePage)

## Мини-спецификация (нет отдельного markdown-файла)

ProfilePage — вторая по сложности страница (1802 строки). Содержит множество табов: обзор, репутация, персонажи, посты, настройки, безопасность.

### Целевой DOM при `isThemeable`

```
<div id="profile-page" class="profile-page profile-{uid}" 
     data-user-id="{uid}" data-group-id="{roleId}">
  <nav id="profile-breadcrumbs-top">...</nav>
  
  <header id="profile-header">
    <div class="profile-avatar"><img ...></div>
    <div class="profile-info">
      <h1 class="profile-name">{nickname}</h1>
      <div class="profile-role">{role badge}</div>
      <div class="profile-status-line">{status_line}</div>
      <div class="profile-online-indicator [is-online] [is-offline]">...</div>
    </div>
    <div class="profile-stats">
      <div class="profile-stat-posts">{post_count}</div>
      <div class="profile-stat-topics">{topics_count}</div>
      <div class="profile-stat-reputation">{reputation}</div>
      <div class="profile-stat-registered"><time>...</time></div>
      <div class="profile-stat-last-seen"><time>...</time></div>
    </div>
    <div class="profile-actions">
      <!-- кнопки: написать сообщение, репутация, подписаться -->
    </div>
  </header>
  
  <div id="profile-content">
    <nav class="profile-tabs">
      <button class="profile-tab [is-active]" data-tab="overview">...</button>
      <button class="profile-tab [is-active]" data-tab="reputation">...</button>
      <button class="profile-tab [is-active]" data-tab="characters">...</button>
      <button class="profile-tab [is-active]" data-tab="posts">...</button>
      <button class="profile-tab [is-active]" data-tab="settings">...</button>
    </nav>
    <div class="profile-tab-content">
      <!-- содержимое активного таба -->
    </div>
  </div>
</div>
```

### State-классы
- `.is-online` / `.is-offline` — на `#profile-page` или `.profile-online-indicator`
- `.is-own-profile` — если пользователь смотрит свой профиль
- `.is-banned` — если профиль заблокирован

### Публичный Theme API

```
#profile-page
#profile-header
#profile-content

.profile-page
.profile-avatar
.profile-name
.profile-role
.profile-status-line
.profile-stats
.profile-stat-posts
.profile-stat-topics
.profile-stat-reputation
.profile-stat-registered
.profile-stat-last-seen
.profile-actions
.profile-tabs
.profile-tab
.profile-tab-content
```

---

# Спринт 7 — Списки тем: Active Topics, New Replies, Subscriptions

## Мини-спецификация

Эти 3 страницы имеют одинаковую структуру — список тем с TopicRow. После спринта 3 TopicRow уже поддерживает семантическую разметку. Здесь нужно добавить обёртки страниц.

### ActiveTopicsPage

```
<div id="active-topics-page" class="active-topics-page topic-list-page">
  <nav id="active-topics-breadcrumbs-top">...</nav>
  <header id="active-topics-header">
    <h1 class="page-title">{t('stats.top_discussed')}</h1>
    <div class="page-description">{t('stats.top_discussed_desc')}</div>
  </header>
  <div id="active-topics-list" class="topic-list-container">
    <div class="topic-list-header">...</div>
    <div class="topic-list">
      <!-- TopicRow components (already themed from Sprint 3) -->
    </div>
  </div>
  <nav id="active-topics-breadcrumbs-bottom">...</nav>
</div>
```

### NewRepliesPage

```
<div id="new-replies-page" class="new-replies-page topic-list-page">
  <nav id="new-replies-breadcrumbs-top">...</nav>
  <header id="new-replies-header">
    <h1 class="page-title">...</h1>
    <div class="page-actions">
      <button class="mark-all-read-btn">...</button>
    </div>
  </header>
  <nav class="page-tabs">
    <button class="page-tab [is-active]" data-tab="all">...</button>
    <button class="page-tab [is-active]" data-tab="new">...</button>
  </nav>
  <nav id="new-replies-pagination-top">...</nav>
  <div id="new-replies-list" class="topic-list-container">
    <div class="topic-list">...</div>
  </div>
  <nav id="new-replies-pagination-bottom">...</nav>
</div>
```

### SubscriptionsPage

```
<div id="subscriptions-page" class="subscriptions-page topic-list-page">
  <nav id="subscriptions-breadcrumbs-top">...</nav>
  <header id="subscriptions-header">
    <h1 class="page-title">...</h1>
    <div class="page-description">...</div>
  </header>
  <nav id="subscriptions-pagination-top">...</nav>
  <div id="subscriptions-list" class="topic-list-container">
    <div class="topic-list">...</div>
  </div>
  <nav id="subscriptions-pagination-bottom">...</nav>
</div>
```

---

# Спринт 8 — Уведомления (NotificationsPage)

## Мини-спецификация

```
<div id="notifications-page" class="notifications-page">
  <nav id="notifications-breadcrumbs-top">...</nav>
  <header id="notifications-header">
    <h1 class="page-title">...</h1>
    <div class="page-actions">
      <button class="mark-all-read-btn">...</button>
      <button class="delete-all-btn">...</button>
    </div>
  </header>
  <nav class="notifications-tabs">
    <button class="notification-tab [is-active]" data-tab="user">...</button>
    <button class="notification-tab [is-active]" data-tab="admin">...</button>
  </nav>
  <nav id="notifications-pagination-top">...</nav>
  <div id="notifications-list">
    <article class="notification-item notification-{type} [is-read] [is-unread]"
             data-notification-id="{id}">
      <div class="notification-icon">...</div>
      <div class="notification-content">
        <div class="notification-title">...</div>
        <div class="notification-message">...</div>
        <time class="notification-date">...</time>
      </div>
      <div class="notification-actions">
        <button class="notification-mark-read">...</button>
        <button class="notification-delete">...</button>
      </div>
    </article>
  </div>
  <nav id="notifications-pagination-bottom">...</nav>
</div>
```

### State-классы
- `.is-read` / `.is-unread` на `.notification-item`
- `.notification-{type}` — type класс: `notification-topic_reply`, `notification-reputation_change`, etc.

---

# Спринт 9 — Создание темы (TopicFormPage)

## Мини-спецификация

```
<div id="topic-form-page" class="topic-form-page">
  <nav id="topic-form-breadcrumbs-top">...</nav>
  <header id="topic-form-header">
    <h1 class="page-title">{t('topic.create_topic')}</h1>
  </header>
  <form id="topic-form" class="topic-form">
    <div class="topic-form-field topic-form-title">
      <label class="topic-form-label">...</label>
      <input class="topic-form-input">
    </div>
    <div class="topic-form-field topic-form-description">
      <label class="topic-form-label">...</label>
      <input class="topic-form-input">
    </div>
    <div class="topic-form-field topic-form-character">
      <!-- character selector -->
    </div>
    <div class="topic-form-editor">
      <!-- RichEditor -->
    </div>
    <div class="topic-form-actions">
      <button class="topic-form-submit">...</button>
      <button class="topic-form-cancel">...</button>
    </div>
  </form>
</div>
```

---

# Спринт 10 — Личные сообщения (MessagesPage + DirectMessages)

## Мини-спецификация

```
<div id="messages-page" class="messages-page">
  <div id="dm-container" class="dm-container [dm-mode-inbox] [dm-mode-chat]">
    <!-- Inbox mode -->
    <div class="dm-sidebar">
      <div class="dm-sidebar-header">...</div>
      <div class="dm-conversation-list">
        <div class="dm-conversation [is-active] [is-unread]" 
             data-conversation-id="{id}" data-user-id="{uid}">
          <div class="dm-conversation-avatar">...</div>
          <div class="dm-conversation-info">
            <span class="dm-conversation-name">...</span>
            <span class="dm-conversation-preview">...</span>
            <time class="dm-conversation-date">...</time>
          </div>
          <span class="dm-conversation-unread-badge">...</span>
        </div>
      </div>
    </div>
    
    <!-- Chat mode -->
    <div class="dm-chat">
      <div class="dm-chat-header">
        <div class="dm-chat-user">...</div>
      </div>
      <div class="dm-chat-messages">
        <div class="dm-message [dm-message-sent] [dm-message-received]" 
             data-message-id="{id}">
          <div class="dm-message-avatar">...</div>
          <div class="dm-message-content">...</div>
          <time class="dm-message-date">...</time>
        </div>
      </div>
      <div class="dm-chat-input">
        <div class="dm-chat-editor">...</div>
        <button class="dm-chat-send">...</button>
      </div>
    </div>
  </div>
</div>
```

---

# Спринт 11 — Аутентификация и служебные страницы

## Мини-спецификации

### LoginPage
```
<div id="login-page" class="login-page auth-page">
  <div class="auth-card">
    <form class="login-form auth-form">
      <div class="auth-field auth-email">...</div>
      <div class="auth-field auth-password">...</div>
      <button class="auth-submit login-submit">...</button>
      <a class="auth-link auth-forgot-password">...</a>
    </form>
    <div class="auth-footer">
      <a class="auth-link auth-register-link">...</a>
    </div>
  </div>
</div>
```

### RegisterPage
```
<div id="register-page" class="register-page auth-page">
  <div class="auth-card">
    <form class="register-form auth-form">
      <div class="auth-field auth-nickname">...</div>
      <div class="auth-field auth-email">...</div>
      <div class="auth-field auth-password">...</div>
      <button class="auth-submit register-submit">...</button>
    </form>
    <div class="auth-footer">
      <a class="auth-link auth-login-link">...</a>
    </div>
  </div>
</div>
```

### LoginPage — White Wall for Guests (`whitelistMode` + `showMaintenanceMessage`)
```
<div class="system-page">
  <div class="system-card">
    <div class="alert alert-warning maintenance-message">...сервисное сообщение техработ (опционально)...</div>
    <div class="login-form">...</div>
  </div>
</div>
```

### PendingPage
```
<div id="pending-page" class="pending-page system-page">
  <div class="system-card">
    <h2 class="system-title">...</h2>
    <p class="system-message">...</p>
    <div class="system-actions">...</div>
  </div>
</div>
```

### BannedPage
```
<div id="banned-page" class="banned-page system-page">
  <div class="system-card">
    <h2 class="system-title">...</h2>
    <p class="system-message">...</p>
    <div class="system-actions">...</div>
  </div>
</div>
```

---

# Спринт 12 — Админка (AdminPage + DesignsTab)

## Мини-спецификация

Админка менее приоритетна для кастомизации пользовательскими темами, но должна быть адресуемой через CSS (администратор может захотеть стилизовать её под свой форум).

Навигация админки — боковой сайдбар со СГРУППИРОВАННЫМИ разделами, а не плоский ряд табов (реализовано в `INPROGRESS_SPRINT_PLAN_admin_reorg.md`). Разделы, к которым у посетителя нет доступа, не отрисовываются вовсе, и группа, у которой не осталось ни одного доступного раздела, исчезает вместе с ними.

```
<div id="admin-page" class="admin-page">
  <div id="admin-breadcrumbs" class="admin-breadcrumbs">...</div>
  <header id="admin-header" class="admin-header">
    <h1 class="admin-page-title">...</h1>
  </header>
  <div class="row admin-layout">
    <div class="col-lg-3 admin-sidebar-column">
      <!-- На узких экранах это Offcanvas-drawer, на широких — статичная колонка.
           Разметка навигации существует в DOM ровно в одном экземпляре. -->
      <nav id="admin-sidebar" class="admin-nav">
        <div class="admin-sidebar-group [is-open|is-collapsed]" data-group="userManagement">
          <button class="admin-sidebar-group-header" aria-expanded="true">...</button>
          <ul class="admin-sidebar-list">
            <li class="admin-nav-item">
              <button class="admin-nav-link [is-active]" data-tab="users" aria-current="page">...</button>
            </li>
          </ul>
        </div>
      </nav>
    </div>
    <div id="admin-content" class="col-lg-9 admin-content">
      <!-- Active section content -->

      <!-- Users section -->
      <div class="admin-users-tab">
        <div class="admin-users-filters">...</div>
        <div class="admin-users-list">
          <div class="admin-user-item" data-user-id="{uid}">...</div>
        </div>
      </div>

      <!-- Categories section -->
      <div class="admin-categories-tab">
        <div class="admin-category-groups">
          <div class="admin-category-group" data-group-id="{id}">...</div>
        </div>
        <div class="admin-categories-list">
          <div class="admin-category-item" data-category-id="{id}">...</div>
        </div>
      </div>

      <!-- Designs section -->
      <div class="admin-designs-tab">
        <div class="admin-designs-settings">...</div>
        <div class="admin-designs-list">
          <div class="design-card" data-design-id="{id}">
            <div class="design-card-name">...</div>
            <div class="design-card-status">...</div>
            <div class="design-card-actions">...</div>
          </div>
        </div>
      </div>

      <!-- Settings section -->
      <div class="admin-settings-tab">...</div>

      <!-- Audit section -->
      <div class="admin-audit-tab">
        <div class="audit-log-list">
          <div class="audit-log-item">...</div>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

# Спринт 13 — Themeable CSS базовый файл

## Цель
Создать `src/styles/themeable.css` — полноценный файл базовых стилей, которые действуют только при `[data-theme-engine="themeable"]`.

## Содержимое

1. **CSS-переменные** — расширенный набор переменных для кастомных тем:
   - Все существующие переменные из `:root` / `[data-theme]` (наследуются)
   - Дополнительные переменные для новых элементов:
     - `--forum-header-bg`, `--forum-header-text`
     - `--category-header-bg`, `--category-header-text`
     - `--topic-item-bg`, `--topic-item-hover-bg`
     - `--post-author-bg`, `--post-body-bg`
     - `--post-header-bg`, `--post-footer-bg`
     - и т.д.

2. **Базовые стили** для каждого семантического контейнера:
   - Layout: `#forum-wrapper`, `#forum`, `#forum-header`, `#forum-about`
   - Forum Index: `#forum-main`, `.forum-category`, `.forum-item`
   - Forum View: `#forum-view`, `.topic-item`
   - Topic View: `#topic-page`, `.topic-post`, `.post-author`, `.post-body`
   - Members: `#members-page`, `.member-item`
   - и т.д.

3. **Reset Bootstrap конфликтов** — где Bootstrap-классы мешают семантическому layout, переопределить их за `[data-theme-engine="themeable"]`

4. **Responsive breakpoints** — мобильные стили для семантических контейнеров

## Принцип
Этот файл — **минимальный**, работающий скелет. Он не должен навязывать конкретный дизайн. Он обеспечивает, что при активном themeable-каркасе форум выглядит «адекватно по умолчанию», а кастомный CSS поверх него может полностью переоформить любой элемент.

---

# Спринт 14 — Theme API Reference документация

## Цель
Создать `markdowns/theme-api-reference.md` — полный справочник Theme DOM API для дизайнеров.

## Содержимое

1. **Введение** — что такое Theme API, как работает, как подключать CSS/JS
2. **Полный список селекторов** по страницам:
   - Structural IDs
   - Semantic classes
   - State classes
   - Data attributes
   - Entity-specific IDs/classes
3. **CSS-переменные** — полный список с описанием и значениями по умолчанию
4. **Примеры** — 3-5 примеров кастомных CSS-тем (смена цветовой палитры, смена layout, скрытие элементов, etc.)
5. **Гайд для дизайнеров** — пошаговая инструкция «как создать свой дизайн»
6. **Чек-лист** — полный чек-лист проверки DOM-контракта

---

# Спринт 15 — Интеграционное тестирование

## Чек-лист

### Стандартные темы (dark / light / neutral)
- [ ] Все 17 страниц визуально идентичны состоянию до рефакторинга
- [ ] Нет лишних `id` или семантических классов в DOM
- [ ] Нет CSS-конфликтов от `themeable.css`
- [ ] Bootstrap layout не нарушен

### Themeable с пустым CSS
- [ ] Все 17 страниц отображаются корректно
- [ ] Семантические `id` и `class` присутствуют в DOM
- [ ] `data-*` атрибуты присутствуют на сущностях
- [ ] State-классы переключаются корректно (`.is-pinned`, `.is-online`, etc.)

### Themeable с тестовым CSS
- [ ] Кастомный CSS успешно стилизует элементы по семантическим классам
- [ ] Кастомный JS может обращаться к элементам по `id` и `data-*`

### Функциональность
- [ ] Все ссылки работают
- [ ] Пагинация работает на всех страницах
- [ ] Breadcrumbs работают
- [ ] Real-time обновления работают (новые посты, уведомления)
- [ ] Подписки работают
- [ ] Реакции работают
- [ ] Цитирование работает
- [ ] Редактирование/удаление постов работает
- [ ] Модерация работает
- [ ] Создание темы работает
- [ ] Личные сообщения работают
- [ ] Профиль: все табы работают
- [ ] Админка: все табы работают
- [ ] Preview mode (`?preview_design=`) работает

### Мобильная вёрстка
- [ ] Все страницы корректно отображаются на мобильных устройствах
- [ ] Адаптивная навигация работает
- [ ] Таблицы/списки корректно скроллятся

### Accessibility
- [ ] `aria-label` на интерактивных элементах не ухудшен
- [ ] `alt` на аватарах сохранён
- [ ] Семантические HTML-элементы (`<nav>`, `<header>`, `<main>`, `<footer>`, `<article>`, `<section>`) используются корректно

---

# Зависимости между спринтами

```
Спринт 0 (Инфраструктура)
    ↓
Спринт 1 (Layout, Navbar, каркас)
    ↓
    ├── Спринт 2 (Forum Index)
    ├── Спринт 3 (Forum View + TopicRow) ─→ Спринт 4 (Topic View)
    ├── Спринт 5 (Members View)
    └── Спринт 6 (Profile)
            ↓
    Спринт 7 (Active/New/Subs) ← зависит от спринта 3 (TopicRow)
    Спринт 8 (Notifications)
    Спринт 9 (Topic Form)
    Спринт 10 (Messages)
    Спринт 11 (Auth + служебные)
    Спринт 12 (Admin)
            ↓
    Спринт 13 (CSS)
    Спринт 14 (Docs)
            ↓
    Спринт 15 (Тестирование)
```

**Параллельно** можно выполнять:
- Спринты 2, 3, 5, 6 — после спринта 1
- Спринты 7-12 — после спринта 3 (TopicRow готов)
- Спринты 13, 14 — после завершения всех DOM-спринтов

---

# Общие правила для агентов

## Что ДЕЛАТЬ

1. **Читать спецификацию** перед началом работы. Для страниц с подробной спецификацией в `markdowns/` — читать соответствующий файл целиком. Для остальных — следовать мини-спецификации из этого документа.

2. **Использовать хук `useThemeable()`** для определения, нужна ли семантическая разметка. Пример:
   ```jsx
   const { isThemeable } = useThemeable();
   
   return (
     <div 
       id={isThemeable ? "forum-view" : undefined}
       className={`existing-class ${isThemeable ? 'forum-view' : ''}`}
     >
   ```

3. **Сохранять Bootstrap-классы** — они отвечают за внутренний layout и не должны удаляться. Семантические классы добавляются РЯДОМ:
   ```jsx
   // Правильно:
   className="row forum-item forum-item-25"
   
   // Неправильно:
   className="forum-item forum-item-25"  // удалён row — layout сломан
   ```

4. **Добавлять `data-*` атрибуты** на все сущности:
   - `data-category-id`, `data-forum-id`, `data-topic-id`, `data-post-id`, `data-user-id`, `data-group-id`

5. **Добавлять state-классы** на основании реальных данных из модели. Не изобретать несуществующие состояния.

6. **Проверять обратную совместимость** — если существующий JS ищет элементы по классу, не удалять этот класс. Можно добавить новый рядом.

7. **Тестировать при обоих режимах** — убедиться, что при `!isThemeable` UI идентичен текущему.

## Что НЕ делать

1. **НЕ менять бизнес-логику** — ноль изменений в state management, API-вызовах, useEffect, обработчиках событий, маршрутизации.

2. **НЕ удалять существующие CSS-классы** без проверки, что они не используются в JS или CSS.

3. **НЕ использовать Bootstrap-классы как Theme API** — тема не должна стилизоваться через `.row`, `.col`, `.card`, `.btn`. Эти классы для внутреннего layout.

4. **НЕ копировать старую MyBB/Rusff разметку** — не использовать `.tcl`, `.tc2`, `.isticky`, `.pa-author`, `.item1` и подобные. Подробный список запрещённых классов в каждой спецификации.

5. **НЕ использовать порядковые классы** — `.item1`, `.item2`, `.item3` для сущностей с собственным ID.

6. **НЕ привязывать тему к тексту** — подписи колонок, лейблы фильтров, названия групп могут быть на разных языках. Тема стилизует по классу, не по тексту.

7. **НЕ рендерить пустые контейнеры** — если элемент не имеет данных (нет описания, нет вложений, нет подписи), не создавать пустой `<div class="forum-description"></div>`. Если данных нет — элемент не рендерится.

8. **НЕ запускать `npm run build`, `firebase deploy`** и подобные команды. Только модификация кода.
