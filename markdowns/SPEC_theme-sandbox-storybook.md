# Custom Theme Sandbox / Storybook для форума

## 1. Цель feature

Нужно добавить в движок форума собственную **Theme Sandbox** ---
изолированную среду для проверки кастомной темы на всех визуально
значимых частях форума.

Основная задача не в visual regression и не в создании отдельной
UI-лаборатории. Задача --- дать дизайнеру полноценную песочницу, в
которой он может взять конкретную кастомную тему и последовательно
проверить, как она выглядит:

-   на всех используемых компонентах;
-   во всех значимых состояниях компонентов;
-   на отдельных частях форума;
-   на полноценных страницах;
-   с тестовыми данными;
-   при кастомизации отдельных сущностей форума;
-   на разных размерах viewport;
-   без необходимости активировать тему для реальных пользователей.

В качестве технической основы можно использовать **Storybook**, но
Storybook здесь должен рассматриваться как внутренний механизм/интерфейс
нашей Theme Sandbox, а не как отдельный продукт или сторонний
пользовательский plugin.

------------------------------------------------------------------------

## 2. Почему Storybook подходит

Storybook хорошо соответствует задаче, потому что позволяет описывать UI
через изолированные stories и показывать:

-   отдельные компоненты;
-   состояния компонентов;
-   композиции компонентов;
-   целые части интерфейса;
-   полноценные страницы;
-   разные наборы mock/test data;
-   разные viewport.

Но стандартный Storybook не должен становиться самостоятельной системой
темизации.

Нужная архитектура должна быть построена вокруг нашей модели кастомных
тем:

``` text
Forum Engine
    │
    ├── Theme definition
    │      ├── variables / tokens
    │      ├── component customization
    │      └── entity-specific customization
    │
    ├── Theme Sandbox
    │      └── Storybook runtime
    │             ├── Variables
    │             ├── Components
    │             ├── Forum sections
    │             ├── Pages
    │             └── Responsive previews
    │
    └── Real forum
           └── Active theme
```

Storybook должен получать **конкретную выбранную тему** и рендерить
stories именно с её конфигурацией.

------------------------------------------------------------------------

# 3. Основной пользовательский сценарий

Основной сценарий:

1.  Пользователь с соответствующим permission открывает список кастомных
    тем.
2.  Выбирает конкретную карточку темы.
3.  Открывает редактирование темы.
4.  Из карточки темы запускает `Theme Sandbox / Storybook`.
5.  Sandbox запускается **с уже выбранной темой**.
6.  Пользователь не выбирает тему внутри Storybook.
7.  Все stories автоматически используют эту тему.
8.  Пользователь проходит по компонентам, состояниям, страницам и
    тестовым данным.
9.  Пользователь изменяет тему в редакторе.
10. Возвращается в Sandbox и проверяет результат.
11. При этом тема остаётся неактивной для реального форума.

Ключевой принцип:

> **Sandbox работает с draft/custom theme, но не активирует её.**

------------------------------------------------------------------------

# 4. Чего НЕ нужно делать

## 4.1. Не нужен Visual Regression

В рамках этой feature не требуется строить систему автоматического
сравнения screenshots.

Не требуется:

-   pixel-by-pixel comparison;
-   baseline screenshots;
-   automatic visual diff;
-   CI visual regression pipeline;
-   автоматическое определение визуальных изменений.

Sandbox предназначен для **ручной визуальной проверки дизайнером**.

В будущем visual regression может быть добавлен отдельно, если появится
такая необходимость.

------------------------------------------------------------------------

## 4.2. Не нужна отдельная UI Laboratory

Не нужно создавать ещё одну самостоятельную систему наподобие отдельного
внутреннего UI-каталога.

Storybook можно использовать как техническую основу интерфейса Sandbox,
потому что он уже решает задачу навигации по stories и изолированного
рендера.

При этом пользовательская модель должна оставаться моделью нашего
форума:

``` text
Theme
  └── Theme Sandbox
        ├── Variables
        ├── Components
        ├── Forum sections
        ├── Pages
        └── Responsive
```

а не:

``` text
Storybook
  └── generic frontend component library
```

------------------------------------------------------------------------

# 5. Структура Theme Sandbox

Предлагаемая структура:

``` text
Theme Sandbox
│
├── Theme Reference
│   └── Variables / Tokens
│
├── Components
│   ├── Buttons
│   ├── Inputs
│   ├── Cards
│   ├── Avatars
│   ├── Badges
│   ├── Tabs
│   ├── Dropdowns
│   ├── Modals
│   ├── Pagination
│   └── ...
│
├── Forum UI
│   ├── Category
│   ├── Category list
│   ├── Topic
│   ├── Post
│   ├── User card
│   ├── User profile
│   ├── Navigation
│   ├── Search
│   ├── Notifications
│   └── ...
│
├── Pages
│   ├── Home
│   ├── Category
│   ├── Topic
│   ├── User profile
│   ├── Search results
│   ├── Notifications
│   └── other supported pages
│
└── Responsive
    └── same stories with different viewport sizes
```

Конкретный набор stories должен определяться реальными компонентами и
страницами текущего форума.

------------------------------------------------------------------------

# 6. Страница Variables / Theme Reference

Обязательная часть Sandbox --- отдельная страница с **полным референсом
используемых theme variables**.

Цель этой страницы --- дать дизайнеру единое место, где можно понять,
какие параметры темы существуют и за что они отвечают.

Например:

``` text
Theme Variables

Colors
├── background
├── surface
├── surface-hover
├── text-primary
├── text-secondary
├── text-muted
├── border
├── accent
├── link
├── success
├── warning
└── danger

Typography
├── font-family
├── font-size-xs
├── font-size-sm
├── font-size-md
├── font-size-lg
├── font-size-xl
├── font-weight-normal
├── font-weight-medium
├── font-weight-bold
└── line-height

Spacing
├── spacing-xs
├── spacing-sm
├── spacing-md
├── spacing-lg
└── spacing-xl

Radius
├── radius-sm
├── radius-md
├── radius-lg
└── radius-full

Shadows
├── shadow-sm
├── shadow-md
└── shadow-lg

Layout
├── content-width
├── sidebar-width
├── header-height
└── ...
```

При этом список не должен быть захардкожен в Storybook отдельно от
движка.

**Источник истины --- система theme tokens/variables самого форума.**

Sandbox должен отображать актуальный набор variables, который реально
используется системой темизации.

Для каждой переменной желательно отображать:

-   имя;
-   текущее значение;
-   тип;
-   краткое назначение;
-   визуальное представление, если применимо;
-   источник/категорию;
-   возможность быстро найти, где она используется, если архитектура
    проекта позволяет.

------------------------------------------------------------------------

# 7. Components

Раздел Components нужен для проверки отдельных UI-компонентов.

Каждый компонент должен иметь meaningful states.

Например для Button:

``` text
Button
├── Default
├── Hover
├── Focus
├── Active
├── Disabled
├── Loading
├── With icon
└── Different sizes
```

Для Input:

``` text
Input
├── Empty
├── Filled
├── Focus
├── Disabled
├── Error
├── Success
└── With helper text
```

Для Post:

``` text
Post
├── Regular
├── Edited
├── With attachments
├── With quote
├── With mentions
├── First post
├── Deleted
├── Moderation state
└── Different user roles/states
```

Набор states должен соответствовать реальному поведению компонентов
форума.

Цель --- не создать искусственный showcase всех возможных CSS-состояний,
а покрыть **реальные состояния продукта**, которые могут визуально
ломаться при кастомизации темы.

------------------------------------------------------------------------

# 8. Forum UI / Composite Stories

Одних атомарных компонентов недостаточно.

Нужны stories для составных блоков форума:

-   category cards;
-   topic lists;
-   post lists;
-   user cards;
-   forum header;
-   navigation;
-   sidebar;
-   breadcrumbs;
-   pagination;
-   notification lists;
-   search results;
-   etc.

Это позволяет увидеть проблемы, которые невозможно заметить на
изолированном Button или Card.

Например:

``` text
Topic List
├── Empty
├── Few topics
├── Many topics
├── Long titles
├── Pinned topics
├── Locked topics
├── Topics with unread state
└── Mixed topic states
```

------------------------------------------------------------------------

# 9. Pages

Обязательно нужны stories для полноценных страниц.

Например:

``` text
Pages
├── Forum Home
├── Category
├── Topic
├── User Profile
├── Search
├── Notifications
├── User Settings
└── ...
```

Каждая page story должна использовать контролируемые тестовые данные.

Важно не копировать production data.

Sandbox должен использовать deterministic fixtures/mocks, чтобы дизайнер
всегда мог открыть один и тот же сценарий.

------------------------------------------------------------------------

# 10. Test Data

Для Theme Sandbox необходимо предусмотреть отдельный набор тестовых
данных.

Он должен позволять проверять не только "красивые" состояния.

Нужно специально иметь edge cases:

-   очень длинные названия;
-   короткие названия;
-   отсутствие изображения;
-   длинные usernames;
-   большое количество постов;
-   отсутствие постов;
-   большое количество категорий;
-   длинные тексты;
-   много badges;
-   несколько уровней вложенности;
-   длинные цитаты;
-   attachments;
-   различные состояния пользователя;
-   различные состояния темы;
-   различные состояния категории;
-   пустые результаты;
-   ошибки;
-   loading states.

Особенно важно предусмотреть сценарии, когда **отдельные категории,
посты, пользователи и темы имеют кастомизированные настройки**.

То есть sandbox должен проверять не только глобальную тему, но и
комбинацию:

``` text
Global Theme
+
Category customization
+
Topic customization
+
User customization
+
Post customization
+
Other entity overrides
```

------------------------------------------------------------------------

# 11. Полноценный Preview форума

Полный preview форума уже частично реализован в продукте.

Не нужно дублировать эту функциональность без необходимости.

Нужно определить границу ответственности:

-   существующий Forum Preview отвечает за preview самого форума;
-   Theme Sandbox отвечает за **систематическую проверку UI при
    конкретной кастомной теме**.

Если существующий preview уже умеет показывать необходимые страницы,
Sandbox должен переиспользовать его page-level rendering, fixtures и
существующие механизмы, а не создавать вторую реализацию тех же страниц.

Предпочтительно строить stories поверх существующих React
components/pages.

------------------------------------------------------------------------

# 12. Responsive testing

Responsive testing является обязательной частью Sandbox.

Дизайнер должен иметь возможность открыть одну и ту же story на разных
viewport.

Минимально стоит предусмотреть:

``` text
Desktop
Tablet
Mobile
```

При этом конкретные breakpoints должны соответствовать breakpoint system
самого форума.

Не следует создавать отдельную систему breakpoint values только для
Storybook.

Storybook должен использовать реальные responsive breakpoints
приложения.

Важно проверять:

-   overflow;
-   wrapping;
-   скрытие/появление элементов;
-   изменение layout;
-   navigation;
-   cards;
-   post layout;
-   typography;
-   длинные usernames;
-   длинные titles;
-   изображения;
-   tables/attachments;
-   модальные окна;
-   sidebar.

------------------------------------------------------------------------

# 13. Выбор темы

Внутри Storybook **не нужен theme switcher**.

Это принципиально.

Тема выбирается до открытия Sandbox --- из карточки конкретной темы.

Пример:

``` text
Theme Cards

┌─────────────────────┐
│ Dark Neon           │
│ [Edit] [Sandbox]    │
└─────────────────────┘

┌─────────────────────┐
│ Minimal Light       │
│ [Edit] [Sandbox]    │
└─────────────────────┘
```

При нажатии `Sandbox`:

``` text
/card/{themeId}/sandbox
        ↓
Storybook
        ↓
ThemeProvider(themeId)
```

В Storybook пользователь уже находится внутри конкретной темы.

Это уменьшает количество состояний, которые нужно поддерживать, и
соответствует пользовательскому сценарию "я сейчас проверяю именно эту
тему".

------------------------------------------------------------------------

# 14. Передача Theme Context

Архитектурно Storybook должен запускаться с context выбранной темы.

Условно:

``` tsx
<ThemeProvider theme={selectedTheme}>
    <Storybook />
</ThemeProvider>
```

Но конкретный механизм должен соответствовать существующей архитектуре
проекта.

Важно:

-   не дублировать theme parsing;
-   не дублировать token resolution;
-   не создавать вторую систему inheritance;
-   не создавать второй источник истины для theme variables;
-   использовать production theme rendering pipeline там, где это
    возможно.

Идеальная ситуация:

``` text
Production UI
       │
       ▼
Theme Resolver
       │
       ▼
Theme Runtime
       │
       ├── Real Forum
       │
       └── Theme Sandbox / Storybook
```

Тогда то, что дизайнер видит в Sandbox, максимально близко к тому, что
увидит пользователь после активации темы.

------------------------------------------------------------------------

# 15. Draft theme

Sandbox должен поддерживать проверку темы до её активации.

Это означает, что:

``` text
Theme state

Draft
  ↓
Sandbox
  ↓
Designer review
  ↓
Ready
  ↓
Activation
```

Sandbox не должен требовать activation.

Это особенно важно для дизайнеров, которым нужно экспериментировать с
темой, не влияя на production forum.

------------------------------------------------------------------------

# 16. Permissions

Для feature требуется отдельная система разрешений.

Нужно добавить отдельное permission, позволяющее пользователю работать с
конкретной кастомной темой и её Sandbox без предоставления доступа ко
всей административной части.

Например, концептуально:

``` text
themes.sandbox
```

или более granular permissions:

``` text
theme.view
theme.edit
theme.sandbox
theme.activate
```

Конкретные имена должны соответствовать существующей permission
architecture проекта.

Ключевое требование:

> Permission на редактирование/Sandbox не должно автоматически давать
> permission на активацию темы.

------------------------------------------------------------------------

# 17. Role-based access

Permission должно назначаться роли.

Пример:

``` text
Designer role

Theme:
    View        ✓
    Edit        ✓
    Sandbox     ✓
    Activate    ✗

Admin role

Theme:
    View        ✓
    Edit        ✓
    Sandbox     ✓
    Activate    ✓
```

Это позволяет создать специальную роль для дизайнеров.

Дизайнер получает все необходимые возможности для работы над UI, но не
получает возможность:

-   активировать тему;
-   управлять административными настройками, которые ему не нужны;
-   случайно повлиять на production forum.

------------------------------------------------------------------------

# 18. Ограничение доступа к конкретной теме

Желательно предусмотреть возможность дать дизайнеру доступ не просто к
Theme Sandbox вообще, а к определённой карточке темы.

Например:

``` text
Designer A
    └── Theme "Brand Redesign"
          ├── View
          ├── Edit
          └── Sandbox
```

При этом:

``` text
Theme "Default"
Theme "Corporate"
Theme "Experimental"
```

могут быть ему недоступны.

Это позволит безопасно отдавать дизайнеру конкретную тему на
разработку/проверку.

Конкретная модель ACL должна быть согласована с существующей системой
ролей и permissions.

Если текущая permission model не поддерживает object-level access,
feature может потребовать расширение authorization layer для ограничения
доступа по `themeId`.

------------------------------------------------------------------------

# 19. Designer workflow

Целевой workflow:

``` text
Admin / Theme Manager
        │
        ▼
Create Theme
        │
        ▼
Assign Theme access to Designer
        │
        ▼
Designer opens Theme Card
        │
        ├── Edit Theme
        │
        └── Open Sandbox
                  │
                  ▼
             Storybook
                  │
        ┌─────────┼──────────┐
        ▼         ▼          ▼
    Variables  Components  Pages
        │         │          │
        └─────────┼──────────┘
                  ▼
          Responsive testing
                  │
                  ▼
           Designer review
                  │
                  ▼
            Theme ready
                  │
                  ▼
       Authorized user activates
```

------------------------------------------------------------------------

# 20. Без доступа в Admin

Отдельная ценность этой feature --- дизайнер не должен обязательно
получать доступ в полноценную Admin Area.

Например:

``` text
Designer
   ↓
Theme Cards
   ↓
Specific Theme
   ├── Edit
   └── Sandbox
```

При этом:

``` text
Admin Area
   ✗
Theme Activation
   ✗
Other administrative settings
   ✗
```

Таким образом, дизайнер получает достаточный набор инструментов для
работы, но permission boundary остаётся минимальным.

------------------------------------------------------------------------

# 21. Это должна быть наша собственная разработка

Не следует делать эту feature зависимой от стороннего пользовательского
plugin.

Storybook может использоваться как open-source технический инструмент
внутри frontend architecture, но:

-   интеграция с темами;
-   Theme Cards;
-   permissions;
-   access control;
-   запуск Sandbox;
-   theme context;
-   test data;
-   forum-specific stories;
-   entity customization;
-   routing;
-   UX;
-   связь с редактором темы

должны быть частью самого forum engine.

То есть для пользователя это должна быть **нативная функция движка**:

``` text
Forum Engine
└── Themes
    ├── Theme Editor
    ├── Theme Cards
    └── Theme Sandbox
```

а не:

``` text
Forum Engine
└── External Storybook plugin
```

------------------------------------------------------------------------

# 22. Рекомендуемая техническая архитектура

Высокоуровнево:

``` text
                     ┌────────────────────┐
                     │     Theme Model    │
                     │ tokens / overrides │
                     └─────────┬──────────┘
                               │
                         Theme Resolver
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
                 ▼                           ▼
        ┌─────────────────┐        ┌──────────────────┐
        │   Forum Runtime │        │  Theme Sandbox   │
        │                 │        │                  │
        │ Production UI   │        │ Storybook        │
        │                 │        │                  │
        └─────────────────┘        └────────┬─────────┘
                                            │
                         ┌──────────────────┼──────────────────┐
                         ▼                  ▼                  ▼
                    Components           Pages             Fixtures
```

Ключевой архитектурный принцип:

**Storybook не должен знать бизнес-логику темизации больше, чем
необходимо для запуска Theme Runtime.**

Он должен использовать реальные компоненты форума.

------------------------------------------------------------------------

# 23. Stories должны быть ближе к production

Не следует создавать отдельные "storybook versions" компонентов.

Плохо:

``` text
ProductionButton
StorybookButton
```

Предпочтительно:

``` text
Button
 └── stories
```

И аналогично:

``` text
Post
 ├── production rendering
 └── Storybook stories
```

Stories должны рендерить те же React components, которые используются в
реальном форуме.

------------------------------------------------------------------------

# 24. Fixtures должны быть централизованы

Желательно создать reusable fixtures:

``` text
fixtures/
├── users
├── categories
├── topics
├── posts
├── themes
├── notifications
└── pages
```

Например:

``` ts
fixtures.users.longUsername
fixtures.posts.withAttachments
fixtures.topics.longTitle
fixtures.categories.withManyTopics
```

Это позволит использовать одни и те же данные в разных stories и не
плодить случайные mock objects.

------------------------------------------------------------------------

# 25. Entity-specific customization

Особое внимание нужно уделить случаям, когда кастомизация применяется не
только глобально.

Например:

``` text
Theme
│
├── Global variables
│
├── Category overrides
│
├── Topic overrides
│
├── User overrides
│
└── Post/UI overrides
```

Sandbox должен позволять проверить комбинации таких overrides.

Пример story:

``` text
Topic Page / Customized Topic

Global Theme:
    Dark

Category:
    custom accent

Topic:
    custom header

User:
    custom avatar/card style

Post:
    custom background
```

Это важно, потому что визуальная проблема может появиться только в
комбинации нескольких уровней кастомизации.

------------------------------------------------------------------------

# 26. Test matrix

Для планирования stories желательно сформировать matrix:

  Уровень            Что проверяем
  ------------------ ----------------------------------------
  Variables          все theme tokens
  Component          базовый rendering
  Component states   реальные состояния
  Composite UI       комбинации компонентов
  Forum sections     category/topic/post blocks
  Pages              полноценные страницы
  Test data          edge cases
  Entity overrides   category/topic/user/post customization
  Responsive         desktop/tablet/mobile
  Empty states       отсутствие данных
  Loading states     загрузка
  Error states       ошибки
  Long content       overflow/wrapping
  Realistic data     максимально приближенные сценарии

Эта matrix должна стать частью acceptance criteria feature.

------------------------------------------------------------------------

# 27. Acceptance Criteria

## Theme Sandbox

-   [ ] Из карточки темы можно открыть Theme Sandbox.
-   [ ] Sandbox запускается с конкретной выбранной темой.
-   [ ] Внутри Sandbox нет theme switcher.
-   [ ] Sandbox не активирует тему.
-   [ ] Draft theme можно полноценно проверять.
-   [ ] Используются реальные production React components.

## Variables

-   [ ] Есть отдельная страница Variables / Theme Reference.
-   [ ] Отображаются все актуальные theme variables.
-   [ ] Variables берутся из существующей theme system.
-   [ ] Нет второго источника истины для tokens.

## Components

-   [ ] Есть каталог используемых компонентов.
-   [ ] Для компонентов представлены реальные UI states.
-   [ ] Проверяются edge cases.

## Forum UI

-   [ ] Есть stories составных блоков форума.
-   [ ] Есть category/topic/post/user scenarios.
-   [ ] Проверяются entity-specific customizations.

## Pages

-   [ ] Есть stories полноценных страниц.
-   [ ] Используются deterministic test fixtures.
-   [ ] Покрыты ключевые пользовательские сценарии.

## Responsive

-   [ ] Stories можно проверять на desktop.
-   [ ] Stories можно проверять на tablet.
-   [ ] Stories можно проверять на mobile.
-   [ ] Используются реальные breakpoints приложения.

## Permissions

-   [ ] Есть отдельное permission для Theme Sandbox.
-   [ ] Permission может назначаться роли.
-   [ ] Можно разрешить Edit + Sandbox без Activate.
-   [ ] Designer не получает автоматически доступ к Admin Area.
-   [ ] По возможности доступ ограничивается конкретным themeId.

## Integration

-   [ ] Sandbox использует production Theme Runtime.
-   [ ] Sandbox не дублирует существующий Forum Preview без
    необходимости.
-   [ ] Storybook интегрирован как часть движка.
-   [ ] Нет обязательной зависимости от стороннего forum/theme plugin.

------------------------------------------------------------------------

# 28. Что не входит в первую версию

Чтобы feature не разрослась за пределы задачи, в MVP не обязательно
включать:

-   visual regression;
-   screenshot comparison;
-   автоматический visual QA;
-   CI visual testing;
-   theme switcher внутри Sandbox;
-   отдельный UI design system продукт;
-   автоматическое сравнение draft и active theme;
-   автоматическую оценку "качества" темы;
-   публикацию/активацию темы из Storybook.

Это можно рассматривать как будущие расширения.

------------------------------------------------------------------------

# 29. Возможные будущие расширения

Архитектуру желательно сделать такой, чтобы позже можно было добавить:

``` text
Theme Sandbox
│
├── Current MVP
│   ├── Variables
│   ├── Components
│   ├── Pages
│   └── Responsive
│
├── Future
│   ├── Shareable preview URL
│   ├── Comment/review mode
│   ├── Designer annotations
│   ├── Visual regression
│   ├── Screenshot snapshots
│   ├── Theme diff
│   └── Automated theme validation
```

Но эти возможности не должны быть обязательными для первоначальной
реализации.

------------------------------------------------------------------------

# 30. Итоговая концепция

Feature стоит рассматривать не как "добавим Storybook в форум", а как:

> **Theme Sandbox --- встроенная в forum engine среда для полного
> ручного тестирования конкретной кастомной темы на реальных
> компонентах, состояниях, страницах, тестовых данных и responsive
> layouts без её активации.**

Storybook при этом является подходящим техническим фундаментом, потому
что предоставляет удобную модель stories, изоляции и viewport testing.

Но ownership должен оставаться у нашего движка:

``` text
                 Forum Engine
                      │
             ┌────────┴────────┐
             │                 │
        Theme System       Theme Sandbox
             │                 │
             │             Storybook
             │                 │
             └────────┬────────┘
                      │
                Real Components
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
    Components      Pages        Fixtures
        │             │             │
        └─────────────┼─────────────┘
                      ▼
             Designer Validation
```

Главный UX-принцип:

> **Designer получает доступ к конкретной теме → редактирует её →
> открывает Sandbox → проверяет весь форум → возвращает изменения на
> доработку, не имея права активировать тему.**

Главный технический принцип:

> **Sandbox должен использовать тот же Theme Runtime и те же React
> components, что и production forum.**

Главный permission-принцип:

> **Edit/Sandbox и Activate --- независимые разрешения.**

Именно эта комбинация позволит использовать Sandbox как полноценную
рабочую среду для дизайнеров, не превращая их доступ в административный
доступ ко всему форуму.
