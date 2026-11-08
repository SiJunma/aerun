# Themeable DOM Refactoring — мастер-план и журнал реализации

> **Актуальный стек**: Go 1.27 + PocketBase (SQLite) + React 19 (обновлено: Ноябрь 2026).
> **Спецификации DOM**: `markdowns/SPEC_forum-index-theme-dom.md`, `markdowns/SPEC_forum-and-members-theme-dom.md`, `markdowns/SPEC_forum-topic-view-theme-dom.md`.
> **Как читать этот файл**: верхняя секция `📌 Журнал реализации` — источник правды о текущем состоянии. Разделы «Спринт N» ниже — исходный план/spec; где они расходятся с журналом, прав журнал (см. «Расхождения с исходными спринтами»).

---

## 📌 Журнал реализации и ключевые решения

### Архитектурное решение (Ноябрь 2026)
1. **Полный уход от Bootstrap-классов с `!important`**:
   - Любой элемент должен переопределяться кастомными темами и CSS без специфических войн и необходимости вешать `!important`.
   - Никаких инлайн-стилей: ни `style={{ ... }}`, ни Bootstrap-утилитных классов. Только семантический класс в `src/styles/*.css`, а размер/тень/цвет/зазор — через токены в `src/styles/theme-variables.css`. JSX хранит только данные и state.

2. **Аватар и ник — неделимая единица**:
   -`.author-meta` — `flex-wrap: wrap`: дата может переноситься отдельной строкой.
   - `.author-meta__identity` держит «аватар + ник» как единый flex-блок и сам не разрывается.
   - Ломается только сам ник (`white-space: normal`, `overflow-wrap: anywhere`, `min-width: 0`); аватар всегда на строке, с которой начинается ник (в начале flex-строки, `align-self: flex-start`).
   - Декоративный разделитель (`·`) не рисуется.
   - Размер аватара задаётся CSS-токеном `--author-meta-avatar-size: 20px`, а не магической константой в JSX. HTML-атрибуты `width`/`height` у `<img>` — только для placeholder/CLS, визуальный размер даёт CSS.
   - `ForumAuthorAvatar` больше не рендерит инлайн-стили
   - Compass: не удалять Bootstrap-импорт глобально пока не мигрированы все страницы — другие экраны (TopicPage, Admin, DM, Profile…) ещё на `react-bootstrap`. Удаление `bootstrap.min.css` / `react-bootstrap` — финальный шаг, только после Этапов 3–7.
2. **Семантический DOM первого класса**:
   - Вместо дублирования веток JSX (`isThemeable ? new_markup : old_bootstrap`), компоненты напрямую переводятся на семантический HTML5 (`<main id="forum-main">`, `<section id="forum-category-{id}" class="forum-category">`, `<article id="forum-item-{id}" class="forum-item">`, `<section id="forum-statistics">`), сохраняя точный визуальный вид для стандартных тем (`dark`, `light`, `neutral`).
   - Итоговый вид страниц на этом этапе **не меняется**: Grid заменяет Table, Flex — утилиты, карточки — семантические секции; десктоп и мобильный (≤768px) брейкпоинты повторены 1:1.
3. **Покомпонентный план миграции**:
   - Начинаем с крупных сущностей и переходим к атомарным.
   - Этап 1: Главная страница (`home` / `MainPage`), каркас `Layout`, `Navbar`, `ForumStats`, `LastPostInfo`.
   - Этап 2: Страница категории (`CategoryPage`) + общие атомы списков (`TopicRow`, `ForumPagination`, `ForumEmptyState`-вызовы, management toolbar) + 3 страницы-списка, которые их потребляют (`ActiveTopicsPage`, `NewRepliesPage`, `SubscriptionsPage`). См. «Расхождения» — фактический DOM отличается от исходного Спринта 3/7 в нескольких именах.

### Структура стилей (куда что класть)
| Файл | Зона ответственности |
|---|---|
| `src/styles/theme-variables.css` | Все семантические токены (`--*`), значения по умолчанию на `body` + переопределения `body[data-theme='dark'/'light'/'neutral']`. Никаких правил layout здесь — только переменные. `body`, а не `:root`: см. «Фикс тёмной темы Категории» в статусе Этапа 2. |
| `src/styles/layout.css` | Каркас: `#forum-wrapper`, `#forum`, `#forum-header`, `#forum-title`, `#forum-nav`, `#forum-user-links`, `#forum-status`, `#forum-announcement`, `#forum-about`, футер. |
| `src/styles/forum-index.css` | Главная: `#forum-index`, `#forum-main`, `.forum-category`, `.category-header`, `.forum-item`, `.forum-last-post`, скелетоны главной. |
| `src/styles/forum-stats.css` | `ForumStats`: `#forum-statistics`, `.forum-stats-card`, `.stats-*`, `.online-*`. |
| `src/styles/forum-view.css` | Страница категории + списки тем: `#forum-view`, `#forum-view-header`, `#forum-actions-top`, `#forum-pagination-*`, `#forum-topic-list`, `.topic-list-head`, `.forum-view-empty`, `.forum-view-back`, `.management-toolbar*`, `.forum-view-spinner`, `.topic-select-input`, классы скелетонов списка. |
| `src/styles/topic-row.css` | `TopicRow` (общий атом списков): `.topic-item`, `.topic-main/head/title/description/meta`, `.topic-category`, `.topic-replies`, `.topic-last-post`, `.mini-pagination`, `.unread-dot`. |
| `src/styles/author-meta.css` | `AuthorMeta` + `LastPostInfo`: `.author-meta`, `.author-meta__date`, `.author-meta__identity`, `.author-meta__avatar`, `.author-meta__name`, `.last-post-link-meta`, `.last-post-meta`, `.last-post-empty`. |
| `src/styles/forum-pagination.css` | `ForumPagination` (общий атом): `.forum-pagination`, `.page-item/.page-link` состояния. Импортируется только из `main.jsx`; локальный `ForumPagination.css` удалён (был `@import`-редирект). |
| `src/styles/utilities.css` | Остаточные глобальные утилиты (`.cursor-pointer`, `.user-select-none`, `.spin`, `.topic-pinned/.topic-locked` через токены). Management toolbar здесь больше не живёт — переехал в `forum-view.css`. |
| `src/index.css` | Глобальные темы/база + ещё не мигрированные страницы. Новые семантические правила сюда не добавлять. |
| `src/main.jsx` | Порядок импортов: `theme-variables.css` → модульные `src/styles/*.css`. Bootstrap CSS остаётся подключённым до конца миграции. |

### Статус выполнения
- [x] **Этап 1: Главная страница (Home) и каркас Layout** (Выполнено):
  - [x] `src/styles/theme-variables.css` — централизованные CSS-токены для Layout, Forum Categories, Forum Items, Last Post, Statistics.
  - [x] `src/styles/layout.css` — стили для `#forum-wrapper`, `#forum`, `#forum-header`, `#forum-title`, `#forum-nav`, `#forum-user-links`, `#forum-status`, `#forum-announcement`, `#forum-about`. Устранены инлайн-стили.
  - [x] `src/styles/forum-index.css` — стили для главной страницы (`#forum-index`, `#forum-main`, `.forum-category`, `.category-header`, `.category-title`, `.category-content`, `.category-head`, `.forum-item`, `.forum-info`, `.forum-title`, `.forum-description`, `.forum-topics`, `.forum-posts`, `.forum-last-post`, скелетоны). CSS Grid на десктопе, Flex/Cards на мобильных устройствах, без использования `!important`.
  - [x] `src/styles/forum-stats.css` — стили для `#forum-statistics`, `.forum-stats-card`, `.stats-header`, `.stats-grid`, `.stats-item`, `.stat-topics`, `.stat-posts`, `.stat-members`, `.stat-newest-member`, `.online-users-panel`, `.online-indicator-blob`, `.online-user-link`, `.stats-footer`.
  - [x] `src/components/layout/Layout.jsx` — добавлены семантические контейнеры `#forum-wrapper`, `#forum`, `#forum-status`, `#forum-announcement`, `#forum-about`, удалены неиспользуемые компоненты.
  - [x] `src/components/layout/Navbar.jsx` — добавлены `#forum-header`, `#forum-title`, `#forum-nav`, `#forum-user-links`, семантические классы навигации и действий, устранены инлайн-стили.
  - [x] `src/pages/MainPage.jsx` — полностью переведён на семантическую разметку по `SPEC_forum-index-theme-dom.md`. Удалены Bootstrap `Table` и `Card`.
  - [x] `src/components/layout/ForumStats.jsx` — переведён на семантический HTML без Bootstrap `Card`, инлайн-стили перенесены в `forum-stats.css`.
  - [x] `src/components/common/AuthorMeta.jsx` — убран инлайн font-size в пользу `.author-meta`.
  - [x] Проверка: `npm test` (все 35 проверок и linter) и `npm run build` пройдены без ошибок.
  - [x] **Фикс визуальных регрессий Этапа 1 (отчёт по багам главной страницы):**
    - Языки категорий/групп: снято с баг-листа — подтверждено как устаревшая БД без `name_i18n`/`description_i18n`, из-за чего `labelPair()` в `category_labels.go` дублирует legacy-строку в оба языка и `resolveField` корректно показывает RU при `lang=en`. Код менять не требуется.
    - Navbar — название форума (чёрное на чёрном): добавлен семантический токен `--forum-name-color: var(--forum-header-text)` и правило `.forum-name { color: var(--forum-name-color) }` в `layout.css`. Bootstrap `navbar-dark` больше не единственный поставщик цвета бренда.
    - Statistics — заголовок "Forum Statistics" и иконка: `--stats-header-bg` возвращён к тёмному (`var(--nav-bg)`), `--stats-header-text` — к светлому (`#ffffff` на тёмном). `stats-header-icon` переведён с прямого `--badge-bg` на `--stats-header-icon-color`, чтобы акцентный синий не закрашивал текст.
    - Statistics — ссылки "Latest registered" и "Most Active Topics": `.stat-user-default` и `.stats-footer-link` переведены с `--badge-bg` на `--stat-user-default-color` / `--stats-footer-link-color` (`var(--secondary-color)`) + hover-токены `--stat-user-default-hover-color` / `--stats-footer-link-hover-color` (`var(--text-color)`). Вновь зарегистрировавшийся пользователь и ссылка на активные топики больше не синие.
    - Удалены legacy-дубликаты с `!important` из `src/index.css` (2900+): `.forum-stats-card`, `.stats-header`, `.forum-header-text`, `.stats-grid`, `.ms-auto-md`, `.stats-item`, `.online-users-panel`, `.online-indicator-blob`, `.online-user-link`, `.stats-footer` + их theme-оверрайды. Цвета ролей `.online-author-admin` / `.online-author-mod` перенесены в `forum-stats.css` без `!important` (с сохранением `[data-theme='neutral']` перекраса админа).
    - JSX: из `ForumStats.jsx` убран `forum-header-text` класс со span'а заголовка — цвет задаётся только через `.stats-title` и токены.
    - Navbar — дублирующий класс и подчёркивание бренда: в `Navbar.jsx` из `Nav.Link` убраны `nav-link` и Bootstrap `text-warning fw-semibold` — остался только семантический класс (`.nav-active-topics`, `.nav-subscriptions`, `.nav-members`, `.nav-admin`). Стилизация ссылок `#forum-nav a` / `.forum-nav a` переехала в `layout.css` через токены `--nav-link-color / --nav-link-hover-color / --nav-admin-color`. `.forum-brand { text-decoration:none }` + `:hover/:focus { text-decoration:none }` — название форума при наведении больше не подчёркивается (глобальное `a:hover`/`a` в `index.css` давало синий линк с подчёркиванием).
- [x] **Этап 2: Forum View + списки тем (Выполнено, незакоммичено)**: `CategoryPage.jsx` на `<main id="forum-view" data-forum-id>` (`#forum-view-header`, `#forum-actions-top`, `#forum-pagination-top/bottom`, `<section id="forum-topic-list">`, `.topic-list-head`, `.forum-view-empty`, `.forum-view-footer`); удалены `Container/Card/Table/Button`, инлайн `style={{...}}`, Bootstrap-утилиты (`mb-*/vr/d-none/small/fw-bold/user-select-none`); кнопки — `.forum-view-action-btn--primary/--secondary` с `:disabled`, чекбоксы — `<input class="topic-select-input">` вместо `Form.Check` (импорт `react-bootstrap` убран). `TopicRow.jsx` — `<article id="topic-{id}" class="topic-item [is-pinned/is-locked/is-unread/...]" data-topic-id data-category-id>`, нативный checkbox. `ActiveTopicsPage`/`NewRepliesPage`/`SubscriptionsPage` — тот же `#forum-view` каркас (`data-forum-id="active-topics"/"new-replies"/"subscriptions"`), `.forum-view-spinner` вместо `spinner-border`, `ForumEmptyState className="forum-view-empty-state"` вместо `mb-4`. `ForumPagination` — `.forum-pagination` без `mb-0`, CSS в `src/styles/forum-pagination.css` (локальный `ForumPagination.css` удалён — был `@import`-редирект, давал дубль в Vite dev). Новые модули `src/styles/forum-view.css` + `src/styles/topic-row.css`; токены в `theme-variables.css` (Forum View / Topic Row / Pagination / `--management-toolbar-*` для `dark/light/neutral` / loading+empty). `utilities.css`: `.management-toolbar*` переехал в `forum-view.css`, сняты `!important` с `.btn-outline-light/.vr`, `.topic-pinned/.topic-locked` через токены. `index.css`: дубликаты списков удалены; блок `.forum-table*` (~3990–4244) оставлен — пересекается с `MainPage`/`DraftsPage`, удалять отдельным аудитом. Проверка 2026-11-05 (Node v24.14.0): `npm test`+`lint:js` и `npm run build` пройдены; остатков `style={{...}}`/Bootstrap-утилит в файлах Этапа 2 нет. `ForumEmptyState.jsx` ещё на Bootstrap `Card` — Этап 7.
  - [x] **Фикс визуальных регрессий Этапа 2 (сверка со скриншотами 2026-11-05)**: header — больше не карточка: `#forum-view-header` стал flex-строкой (заголовок `.forum-view-heading` слева, `#forum-actions-top` справа, `padding:0`, `border:transparent`, title `--forum-view-title-size: 2.5rem`); `CategoryPage` — actions перенесены внутрь header (как в целевом макете и как было в исходном `d-flex justify-content-between`), остальные списки — `.forum-view-heading` без actions. Шапка списка `.topic-list-head` — тёмная (`var(--nav-bg)`/белый, `1rem/700`, без uppercase), карточка списка без radius/shadow; строки `.topic-item` — `padding: 1.25rem`, как в целевом виде. Проверка после фикса: `npm test`+`lint:js` и `npm run build` пройдены повторно.
  - [x] **Паддинги каркаса (2026-11-05)**: `.forum-main-content` получил верхний паддинг `2rem` (32px) через токен `--forum-main-content-padding-top` (нижний — `--forum-main-content-padding-bottom: 0.5rem`, как старый `py-2`); у `#forum-index` убран верхний/нижний Bootstrap-паддинг (`pt-5 pb-4` → `padding:0` в `forum-index.css`), чтобы они не накладывались друг на друга. `Layout.jsx`: `py-2` убран с `<main>`. Проверка: `npm test`+`lint:js` и `npm run build` пройдены.
  - [x] **Низ страницы категории (2026-11-05)**: карточка списка вернула radius/shadow (`--forum-view-card-radius/--forum-view-card-shadow`); `.forum-view-back` — кнопка с рамкой (`--forum-view-back-border/radius/padding/hover-bg`); закрытые темы — заголовок красным (`--topic-locked-title-color: var(--topic-locked-color)`, `.topic-locked-title` в `TopicRow.jsx`, иконка замка красная без `opacity`). Проверка: `npm test`+`lint:js` и `npm run build` пройдены.
  - [x] **Цвета кнопок по оригиналу (2026-11-05)**: кнопки Forum View переведены на оригинал `btn-primary` / `btn-outline-primary` / `btn-outline-secondary` из `index.css` через токены `--forum-view-btn-primary-*` и `--forum-view-btn-ghost-*` (заливка `--primary-color`/`--bg-color`, призрак `--secondary-color` с hover-заливкой). `--forum-view-back-border` теперь `var(--secondary-color)` (как бордер `btn-outline-secondary`), а не `var(--border-color)` — бледный бордер формы для кнопок не подходит. `dark`: текст на primary/ghost-hover `#0f172a`; `neutral`: `#8c7a6b`/`#fdf6e3` (как `[data-theme='neutral'] .btn-primary/.btn-outline-primary`). `.forum-view-back` hover — заливка `--secondary-color`. Проверка: `npm test`+`lint:js` и `npm run build` пройдены.
  - [x] **Пустая пагинация не рендерится (2026-11-05)**: `<nav id="forum-pagination-top/bottom">` оборачивает `ForumPagination` только при `totalPages > 1` — раньше обёртка рендерилась всегда, а пустой `ForumPagination` возвращал `null`, оставляя пустой `<nav>` с `margin-top: 1rem` (виден в DevTools как `936×0`). Исправлено в `CategoryPage` (top+bottom) и `ActiveTopicsPage` (`!loading && totalPages > 1`); `NewRepliesPage`/`SubscriptionsPage` уже имели guard. Проверка: `npm test`+`lint:js` и `npm run build` пройдены.
  - [x] **Темизация row списка категорий / перенос заголовка последнего топика (2026-11-05)**: в живом DOM `MainPage` уже на семантических `.forum-item/.cat-link/.cat-desc/.forum-mobile-stats/.forum-topics/.forum-posts/.last-topic-link/.last-post-link-meta` и `forum-index.css` (Этап 1, незакоммичен) — Bootstrap-тэги из сырого `<tr><td>`-снимка в коде отсутствуют. `.last-topic-link` больше не обрезается (`white-space: nowrap`/`overflow: hidden`/`text-overflow: ellipsis` → `normal/visible/clip` + `overflow-wrap: anywhere`, `line-height`/`margin-bottom` через `--last-post-title-*`, `color: var(--last-post-title-color)`); лишний mobile-дубль `white-space: normal` убран. `.cat-desc` `line-height` — через `--forum-description-line-height`. Мёртвый `.forum-table*`-блок в `index.css` не тронут (нужен аудит по MainPage/Drafts). Проверка: `npm test`+`lint:js` и `npm run build` пройдены.
  - [x] **AuthorMeta / LastPostInfo: переносимость и неделимость «аватар + ник»**: декоративный `·` и все Bootstrap-утилиты (`d-flex/gap-*/text-muted/fw-semibold/shadow-sm/w-100/me-1/text-decoration-none`) убраны из `AuthorMeta.jsx`/`LastPostInfo.jsx`. DOM: `.author-meta > .author-meta__date + .author-meta__identity { [avatar + .author-meta__name] }` — блок identity не переносится как целое (`flex: 1 1 auto`, `max-width: 100%`), поэтому аватар всегда на строке, с которой начинается ник; ломаться может только сам ник (`white-space: normal`, `overflow-wrap: anywhere`, `min-width: 0` у имени и контейнера). Сама `.author-meta` — `flex-wrap: wrap`, дата и identity при нехватке места могут разнестись по строкам. Все правила перенесены из `topic-row.css`/`forum-index.css` в новый общий `src/styles/author-meta.css`; цвета/отступы/тени — через токены `--author-meta-*`, `--author-name-*`, `--last-post-link-*`, `--last-post-empty-*`. Проверка: в песочнице `npm` отсутствует (`npm: command not found`), `npm test`/`lint:js`/`build` здесь не запускались — нужна проверка на машине с Node.
  - [x] **Мобильная главная: целевой вид last-post полосы (сверка со скриншотами 2026-11-06)**: в живом DOM `.forum-last-post` больше не врезная тонированная панель справа, а полоса во всю ширину под описанием. В `src/styles/author-meta.css` (модуль загружается последним в `main.jsx`, поэтому выигрывает каскад у дубликатов в `forum-index.css` при равной специфичности) добавлен мобильный блок `≤768px`: фон панели — `transparent`, верхняя граница — обычный разделитель строк `var(--forum-item-border)` вместо тонированных `--last-post-mobile-bg/--last-post-mobile-border`; `.author-meta` — `flex-wrap: nowrap` + `align-items: center`, поэтому «Today, 07:46 · [avatar] Arin» именно в одну строку, а не автор отдельной строкой под датой; разделитель даты и автора — типографическая точка `\00B7` через `::after` на `.author-meta__date`; `.author-meta__identity { flex: 1 1 auto; min-width: 0 }` + `.author-meta__name { flex: 1 1 auto; min-width: 0 }` — аватар+ник неделимы, длинный ник переносится внутри себя; `.last-post-link-meta` растянут на всю строку (`width: 100%`, bleed `-4px/-6px` убраны), иначе `fit-content` + отрицательный margin выносили аватар за границу карточки. Дополнительно: `src/main.jsx` — `author-meta.css` перенесён после `forum-pagination.css` (последний компонентный импорт, как отмечено в шапке модуля); `ForumAuthorAvatar.jsx` — `void roundedCircle` чинит `lint:js` (проп сохранён для обратной совместимости, круг — теперь `.author-avatar__img`). Проверка: `npm test` (skipped своё тестовое окружение) — полный прогон дошёл до `lint:js` с одним предсуществующим падением `roundedCircle` (исправлено выше); brace-depth обоих CSS — 0.
  - [x] **Запрет `!important` в нативных стилях (2026-11-06) + доработка полосы**: `!important` убраны из нативных модулей без всяких исключений для медиа-запросов — медиа-брейкпоинт не оправдывает `!important`, он работает только через обычный каскад (специфичность + порядок). Конкретно: в `src/index.css:2873` legacy-дубль `.last-post-link-meta` переведён на токены `var(--last-post-link-padding)` / `var(--last-post-link-margin)` (объявлены в `theme-variables.css`: padding `4px 6px`, margin `-4px -6px`); `.last-post-link-meta` в `author-meta.css` тоже читает `var(--last-post-link-margin, -4px -6px)` вместо хардкода `-4px -6px`. Мобильная точка пересечения на индексе (`≤768px`) переопределяет ТОКЕНЫ (`--last-post-link-padding: 0; --last-post-link-margin: 0`) вместо `width:100%!important` — поэтому кросс-файловая война снимается без `!important`, без `@layer`-костылей и без троттлинга десктопного bleed на `TopicRow`/`CategoryPage` (он там intentional). Дополнительно чинён второй живой виновник «полоса не во всю ширину»: базовое `.forum-item` в `forum-index.css` задаёт `align-items:center` для десктопной grid-строки, и в мобильной колонке это съедало ширину полосы и её `border-top` (на скриншоте бордер останавливается посреди карточки) — в мобильном блоке добавлен `align-items: stretch`, а `last-post-content`/`last-post-link-meta` растянуты (`align-self: stretch; width: 100%`), дабы ссылка шла от начала строки и дата стояла первой. Desktop не тронут: всё — только внутри `@media (max-width: 768px)`.
  - [x] **Диагностика «не видны изменения в рендере» (2026-11-06)**: сравнились скриншот 1 (отрендеренный вид) и живой DOM. Три независимые причины, почему целевой вид не «проявлялся»: (1) **устаревший `dist/`** — в `dist/assets/` лежала сборка от 11:17 (`index-*.css` 11:17), а dev-сервер отдавал свежие CSS (`author-meta.css` 11:41 / curl `:5173` — 200 и актуальное содержимое) — HMR/CSS не кэшируются, но сборка в `dist/` — нет; (2) **музей `!important` в `src/index.css` (~4063–4244)** — `.forum-table td:last-child`, `td:last-child:before`, `.last-topic-link`, `.forum-table .cat-link` с `!important` **не могли сматчиться на семантическом DOM главной** (`.forum-last-post` — `<div>`, а не `<td>` внутри `.forum-table` в новом `MainPage.jsx` на `<article id="forum-item-*">`), поэтому их `!important` не били по целевой странице; (3) **единственное живое пересечение** — голое `.last-post-link-meta` в `index.css:2873-2874` (`padding: 4px 6px !important; margin: -4px -6px !important`) — достигает индекса и разрывает bleed (-4/-6): без него аватар+тень уходят за правую границу карточки, а отступы приподнимают мету над строкой. Исправление: в `src/styles/author-meta.css` две точки пересечения (`.forum-last-post .last-post-link-meta` — `width/margin/padding: 100%/0`) переведены в `@layer author-meta` + `!important` — в каскаде !important резолвится ДО учёта слоёв, поэтому одного слоя мало; оба условия обязательны. Проверка: curl `:5173/src/styles/author-meta.css` отдаёт `width:100%!important` на `.forum-last-post .last-post-link-meta` (200); `git status` подтверждает, что правки в `src/index.css` касаются только этого одного правила и от него не зависли. Для прод-рендера нужен `npm run build` (новая сборка `dist/`).
- [ ] **Этап 3: Topic View (`TopicPage`)**
  - [x] **Аудит legacy-дубликатов `index.css` (2026-11-06, по запросу «удалить/закомментировать»)**: grep `src --include='*.jsx'` доказал: ни одна страница не рендерит `.forum-table*` / `.forum-table-sub` / `.topic-row-hover` / `.topic-title-link` / `.forum-td-stat` (MainPage, CategoryPage, ActiveTopics, NewReplies и Subscriptions — все на семантическом DOM). Поэтому: (1) весь блок `~3995–4244` (uniform columns, `thead th`, `td`, `.forum-table-sub thead th`, mobile `@media` с `.forum-table`, `.cat-link`, `.cat-desc`, `.forum-mobile-stats`, `td:last-child(:before)`, `.last-topic-link`, `.author-sidebar` mobile, `.author-res-*`, `.post-content`) закомментирован с шапкой «LEGACY … turned OFF» и перечислением новых владельцев (`forum-index.css`, `topic-row.css`, `author-meta.css`, `utilities.css`); внутренние `/* */`-маркеры заменены на `--`, чтобы не рвать внешний комментарий. Живым оставлено: `.hide-on-extra-small-mobile` (TopicPostCard), `.bbcode-media-wrapper`, `.hotkeys-table`, `.dm-*`, `.members-table-*`, `.profile-sidebar-wrapper` — они нужны немигрированным страницам (TopicPage, DM, Members, Profile, Admin) и остаются Bootstrap-переопределениями до Этапа 7. (2) Голый `.last-post-link-meta` + три `!important`-hoverа в `index.css:2873` закомментированы — единственный владелец теперь `author-meta.css` (у него те же правила без `!important`). (3) `.forum-group-card`/`.forum-group-header` закомментированы на одной строке-шапке: `.forum-group-header` не используется нигде, `.forum-group-card` — только скелетон в DraftsPage (Bootstrap Card, не group chrome). (4) В `theme-variables.css` убраны 4 дубля `--last-post-link-margin` из прошлой сессии. Проверка: `grep -c '!important' src/index.css` = 747 (остаток — только Bootstrap-переопределения + закомментированные блоки), живых селекторов `.forum-table*`/`.forum-group-*`/`.last-post-link-meta` в `index.css` нет, brace-depth = 0. Нативных модулей (`src/styles/*.css`) это не коснулось: там `!important` только в комментариях. Для прода нужен `npm run build`.
  - [x] **Бледный внутренний разделитель на мобильной главной (2026-11-06)**: проблема — граница раздела между `.forum-item` и верхняя граница `.forum-last-post` внутри секции имели один и тот же цвет `--forum-item-border` (opaque `--border-color`), поэтому на скриншоте 1 обе линии выглядели одинаково (не видно, где заканчивается одна секция и начинается следующая — вторая линия дублировала первую). Целевой вид (скриншот 2): внешний разделитель остаётся плотным (`--forum-item-border`), внутренний — заметно бледнее. Решение без локальных цветов в CSS: добавлен семантический токен `--forum-last-post-mobile-border: color-mix(in srgb, var(--border-color) 40%, transparent)` в `theme-variables.css` (40% alpha от opaque border-color) — он наследуется всеми темами автоматически через их `--border-color`, без per-theme RGB-переопределений в `[data-theme=...]`. Оба мобильных правила `.forum-last-post` (`forum-index.css` и `author-meta.css`) переведены с `var(--forum-item-border)` на `var(--forum-last-post-mobile-border)`; desktop не затронут (токен используется только внутри `@media (max-width: 768px)`).
  - [x] **Закрытые темы: заголовок больше не краснеет (2026-11-06)**: убрана ветка `.topic-locked-title` (TopicRow.jsx рендерил отдельный класс заголовка для `is_locked`, а `.topic-locked-title a` красил его в `--topic-locked-title-color` = `--topic-locked-color`). Теперь заголовок всегда `.topic-title` и обычный цвет темы; закрытость темы передаётся только красной иконкой замка (`.topic-locked` на `.topic-icon`, без opacity). Токен `--topic-locked-title-color` и правила `.topic-locked-title` удалены.
  - [x] **Мобильный TopicRow: скрыт родитель `.topic-meta`, а не только `.topic-author` (2026-11-06)**: в `@media (max-width: 768px)` прятался только `.topic-meta .topic-author`, но родитель `.topic-meta` оставался в потоке (flex column с `margin-top: 0.25rem`, `gap: 0.25rem`) — пустой контейнер продолжал занимать место. Теперь в мобильном блоке скрыт сам `.topic-meta` (`display: none`); на десктопе он не тронут.
  - [x] **Меньше `.forum-view-title` на мобиле (2026-11-06)**: десктопный размер заголовка страницы (CategoryPage / ActiveTopics / NewReplies / Subscriptions) был `--forum-view-title-size: 2.5rem` (40px) и не уменьшался на ≤768px. Добавлен токен `--forum-view-title-size-mobile: 2rem` (32px) и правило `.forum-view-title { font-size: var(--forum-view-title-size-mobile, 2rem) }` в мобильном блоке `forum-view.css`; десктоп не тронут.
  - [x] **Цвет `.forum-view-description` (2026-11-06)**: светлая тема — `#475569` (Slate 600, как у `--link-color`); эквиваленты в остальных: dark — `#64748b` (Slate 500), neutral — `#6b5a48` (тёплый коричнево-серый, между `--link-color: #8c7152` и `--secondary-color: #5c4b3a`). Используется через токен `--forum-view-description-color` (без локальных цветов в CSS и без `!important`).
  - [x] **Фикс тёмной темы Категории: алиасы резолвились в светлые значения (2026-11-06, скриншоты)**: «General Discussion» чёрным на тёмном фоне планеты, «New Topic» почти невидима, список — белая карточка с светлым текстом (заголовки/даты 64/190 — `--text-color` в светлой теме тёмный). Причина: семантические алиасы (`--forum-view-title-color: var(--text-color)`, `--topic-title-color`, `--forum-view-card-bg: var(--card-bg)`, `--forum-view-btn-primary-bg/-text`, `--topic-count-color` и ~60 таких) жили в `:root` (`<html>`), а тема ставится на `<body data-theme>` (`ThemeProvider.jsx:64`); `var()` на `:root` резолвится против базовых токенов самого `:root` (светлые из `index.css :root`), и алиас запекался в светлый цвет навсегда, не видя `body[data-theme='dark']`. Поэтому тёмная тема и выглядела «сломанной». Исправление: блок дефолтов в `theme-variables.css` переехал с `:root` на `body` (переопределения и так были `[data-theme=...]` на body) — теперь алиас на body резолвится против темовых базовых токенов на том же body; кастомные свойства наследуются потомками, потребители не тронуты. Нелинейные токены (пиксели/шрифты/тени) равнозначно переехали. Проверено по `dist/assets/index-*.css`: `body{...--forum-view-title-color: var(--text-color)...}` + `[data-theme=dark]{--text-color: #f8fafc; --card-bg: #1e293b}`. `npm test` (все тесты + `lint:js`) и `npm run build` пройдены. Побочно это починило те же алиасы на главной, статистике и шапке (`--forum-name-color`, `--category-*-bg`, `--stats-*-bg`).
  - [x] **Цвета Главной (Last Post колонка) не совпадали с целевым (2026-11-06, скриншоты)**: в текущей версии дата/ник в Last Post были ярче (почти белые), чем в целевой, где они приглушены. Причина: в legacy `LastPostInfo` — Bootstrap `text-muted`-линк (muted дата+автор), а в миграции `.last-post-link-meta` и `.author-meta__name` ушли в `--topic-meta-color`/`--author-name-color` (=`--text-color`), а `.last-topic-link` потерял явный цвет ссылки. Починено: `.last-post-link-meta` — `--last-post-meta-color: var(--secondary-color)` (dark — `#94a3b8` Slate 400, как у `--link-color`), `.last-post-link-meta .author-meta__name` тонирует ник тоже в `--last-post-meta-color` (дата/ник одним приглушённым тоном, аватар не красится), `.last-topic-link` — явный `--last-post-title-color: var(--link-color)` как в legacy (на один тон темнее заголовка категории). TopicRow и посты не тронуты: токен берётся из локального scope `.topic-meta`, который в `topic-row.css` переопределяет цвет. Tokens-комментарий в `theme-variables.css` документирует legacy-семантику. Проверка: `npm test` + `npm run build`; в `dist` подтверждено`.last-post-link-meta .author-meta__name{color:…--last-post-meta-color…}` и `.last-topic-link{color:var(--last-post-title-color)}`.
  - [x] **Цвета Главной (уточнение по скриншотам 2026-11-06 — приглушение было не Slate 400, а Slate 500)**: после предыдущего фикса muted-текст остался Slate 400 (`#94a3b8` из `--secondary-color`/`--link-color`), а на целевой картинке все вторичные тексты — Slate 500 (`#64748b`, `.text-muted`-тон), при этом заголовочная полоса — Slate 700 (`#334155`), а заголовок последнего топика — Slate 300 (`#cbd5e1`). В `theme-variables.css` для `body[data-theme='dark']` явно заданы: `--category-head-bg: #334155`, `--category-head-text: #64748b`, `--last-post-meta-color: #64748b`, `--last-post-title-color: #cbd5e1`, `--author-name-color: #64748b`; дефолт `--category-head-bg` переведён с `var(--block-bg)` на `var(--secondary-color)` (у legacy был secondary). Теперь в `dist/assets/index-*.css` видно `[data-theme=dark]{…--category-head-bg: #334155;--category-head-text: #64748b;--last-post-meta-color: #64748b;--last-post-title-color: #cbd5e1;--author-name-color: #64748b…}` и `.category-head{background:var(--category-head-bg);color:var(--category-head-text)}`, `.last-topic-link{color:var(--last-post-title-color)}`. Дефолтные light/neutral значения не менялись. Проверка: `npm test` (все тесты + `lint:js`) и `npm run build` пройдены.
  - [x] **Главная (финальная сверка 2026-11-06)**: заголовок последнего топика в целевой картинке — тот же near-white, что название категории (`#f8fafc`), а не Slate 300. В том же dark-блоке уточнено: `--last-post-title-color: #f8fafc`, `--forum-title-color: #f8fafc`, `--forum-stat-color: #f8fafc`. В `dist` подтверждено `[data-theme=dark]{…--last-post-title-color: #f8fafc;--forum-title-color: #f8fafc;--forum-stat-color: #f8fafc…}` и `.last-topic-link{color:var(--last-post-title-color)}`. Дефолтные light/neutral значения не менялись. `npm test` + `npm run build` пройдены.
  - [x] **Главная (точные цвета от пользователя 2026-11-06)**: `.category-head` — фон `#0e1324`, color `#80848d`; `.last-topic-link` — `#94a3b8`; `.forum-description`, `.cat-desc` и `.author-meta__date > span` — `#b0b0b0` (legacy `.text-muted`); `.last-post-link-meta .author-meta__name` — `#94a3b8`; `--stats-item-muted` — `#b0b0b0`; `.topic-pinned` в dark — `#ffc107`; hover на `.last-post-link-meta` в dark — белый текст внутри. Реализовано через токены, а не hardcoded hex в правилах: в dark-блоке заданы `--category-head-bg: #0e1324`, `--category-head-text: #80848d`, `--last-post-title-color: #94a3b8`, `--last-post-meta-color: #94a3b8`, `--author-name-color: #94a3b8`, `--last-post-name-color: #94a3b8`, `--author-date-color: #b0b0b0`, `--forum-description-color: #b0b0b0`, `--stats-item-muted: #b0b0b0`, `--topic-pinned-color: #ffc107`; правило `.author-meta__date > span` теперь красит дату через `--author-date-color`, `.last-post-link-meta .author-meta__name` — через `--last-post-name-color`; dark-hover в `author-meta.css` красит весь `link + date + nick` в `#ffffff` (внутренний rule `[data-theme='dark'] .last-post-link-meta:hover .author-meta__date > span, .author-meta__name` — иначе дата/ник оставались бы muted на ховере). В `dist/index-D73JR6za.css` подтверждено `[data-theme=dark]{…--category-head-bg: #0e1324;--category-head-text: #80848d;--last-post-title-color: #94a3b8;--last-post-name-color: #94a3b8;--author-date-color: #b0b0b0;--forum-description-color: #b0b0b0;--stats-item-muted: #b0b0b0;--topic-pinned-color: #ffc107…}`, `.topic-pinned{color:var(--topic-pinned-color)}`, `[data-theme=dark] .last-post-link-meta:hover{color:#fff}`, `[data-theme=dark] .last-post-link-meta:hover .author-meta__date>span,[data-theme=dark] .last-post-link-meta:hover .author-meta__name{color:#fff}`, `.category-head{background:var(--category-head-bg);color:var(--category-head-text)}`, `.last-topic-link{color:var(--last-post-title-color)}`, `.author-meta__date>span{color:var(--author-date-color,…)}`, `.last-post-link-meta .author-meta__name{color:var(--last-post-name-color,…)}`. `npm test` (все тесты + `lint:js`) и `npm run build` пройдены.
- [ ] **Этап 4: Members View (`MembersPage`)**
- [ ] **Этап 5: Profile (`ProfilePage`)**
- [x] **Этап 6 (часть): Списки тем (`ActiveTopicsPage`, `NewRepliesPage`, `SubscriptionsPage`) — выполнены в рамках Этапа 2** (см. выше); отдельные id `#active-topics-page` и т.п. не заводились — все списки переиспользуют `#forum-view/#forum-topic-list` с разными `data-forum-id`.
- [ ] **Этап 7: Уведомления, Сообщения, Авторизация, Админка** + удаление Bootstrap (`bootstrap.min.css` из `main.jsx`, `react-bootstrap` из зависимостей) — только после Этапов 3–6.

### Расхождения с исходными спринтами (факт vs план)
> Ветвления `isThemeable ? new : old` нет — семантический DOM всегда (решение Этапа 1). Имена ниже — фактические.

- `CategoryPage`: корень `<main id="forum-view">`; header `#forum-view-header` (не `#forum-header`), title `.forum-view-title`, список `<section id="forum-topic-list">`, шапка `.topic-list-head` + `.topic-col-topic/.topic-col-category/.topic-col-replies/.topic-col-lastpost` (не `.topic-list-header/.topic-column`); пагинация `#forum-pagination-top/bottom` + `.forum-view-pagination`; `#forum-actions-bottom`/`#forum-breadcrumbs-bottom` нет — только `.forum-view-footer/.forum-view-back`.
- `TopicRow`: pinned → `.is-pinned` (не `.is-sticky`); `data-category-id` на article; колонки views нет; mini-pagination — `.mini-pagination` внутри `.topic-head`.
- Списки тем: отдельных `#*-page/#*-list` нет — общий `#forum-view/#forum-topic-list`, различие только `data-forum-id`.

### Как продолжать в следующей сессии
1. `git status` + `git --no-pager diff --stat HEAD` — Этапы 1–2 не закоммичены (HEAD=`911bf01`).
2. Node (Git Bash): `export PATH="$PATH:/c/nvm4w/nodejs:/c/Users/Alina/AppData/Local/nvm"` → `node v24.14.0`, `npm 11.9.0`. PowerShell-строка с `%NVM_HOME%` в Git Bash не работает.
3. Следующий шаг — Этап 3 (`TopicPage`, 3681 строка): только DOM/CSS, ноль бизнес-логики; читать файл целиком; после каждого блока `npm test` + `npm run build`.
4. Перед чисткой `index.css` — `grep` по `src --include='*.jsx'`: `.forum-table*` и `.empty-state-*` пересекаются с немигрированными страницами.
5. Новые токены — только `theme-variables.css`, новые правила — только `src/styles/*.css`; `grep -n '!important' src/styles/*.css` должен давать только комментарии.

---

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

```
<div id="admin-page" class="admin-page">
  <nav id="admin-breadcrumbs">...</nav>
  <header id="admin-header">
    <h1 class="page-title">...</h1>
  </header>
  <nav class="admin-tabs">
    <button class="admin-tab [is-active]" data-tab="users">...</button>
    <button class="admin-tab [is-active]" data-tab="categories">...</button>
    <button class="admin-tab [is-active]" data-tab="roles">...</button>
    <button class="admin-tab [is-active]" data-tab="designs">...</button>
    <button class="admin-tab [is-active]" data-tab="settings">...</button>
    <button class="admin-tab [is-active]" data-tab="audit">...</button>
  </nav>
  <div id="admin-content" class="admin-tab-content">
    <!-- Active tab content -->
    
    <!-- Users tab -->
    <div class="admin-users-tab">
      <div class="admin-users-filters">...</div>
      <div class="admin-users-list">
        <div class="admin-user-item" data-user-id="{uid}">...</div>
      </div>
    </div>
    
    <!-- Categories tab -->
    <div class="admin-categories-tab">
      <div class="admin-category-groups">
        <div class="admin-category-group" data-group-id="{id}">...</div>
      </div>
      <div class="admin-categories-list">
        <div class="admin-category-item" data-category-id="{id}">...</div>
      </div>
    </div>
    
    <!-- Designs tab -->
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
    
    <!-- Settings tab -->
    <div class="admin-settings-tab">...</div>
    
    <!-- Audit tab -->
    <div class="admin-audit-tab">
      <div class="audit-log-list">
        <div class="audit-log-item">...</div>
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
