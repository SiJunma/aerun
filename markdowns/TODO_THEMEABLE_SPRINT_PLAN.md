# Themeable DOM Refactoring — рабочий план миграции

> **Актуальный стек**: Go 1.27 + PocketBase (SQLite) + React 19 (обновлено: Ноябрь 2026).
> **Ветка**: `feature/theming`. Источник правды — ветка на GitHub, а не локальные копии.
> **Спецификации DOM**: `markdowns/SPEC_forum-index-theme-dom.md`, `markdowns/SPEC_forum-and-members-theme-dom.md`, `markdowns/SPEC_forum-topic-view-theme-dom.md`, `markdowns/SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md`, `markdowns/SPEC_REFACTOR_PROFILE_PAGE_ARCHITECTURE.md`.

---

## Как пользоваться этим планом (прочти первым)

Этот документ — инструкция для агента-исполнителя (например, Nemotron в Cline). Он устроен так:

1. **Плейбук** — как мигрировать ОДИН компонент, шаг за шагом, чтобы вид не изменился. Прочти его целиком, прежде чем трогать код.
2. **Спринты A–J** — порядок работы. Бери спринты строго по порядку, внутри спринта — компоненты по одному, сверху вниз.
3. **Статус и карта повторяющихся элементов** — что уже чисто, что осталось, где элементы повторяются и чем отличаются.
4. **Справочные мини-спецификации** — целевые DOM для страниц, у которых нет отдельного SPEC-файла.
5. **Журнал ключевых решений** — почему принято так, а не иначе. Подробный журнал правок 2026-11-05…09 вынесен в `markdowns/Archive/THEME_JOURNAL_2026-11-06.md` — в рабочем плане ему не место, но он сохранён.

Правила, которые нельзя нарушать (подробнее — в «Правилах для агентов» в конце):

- **Один компонент за раз.** Закончил компонент — `npm run build` + `npm test`, отчёт, только потом следующий.
- **Вид не меняется.** Миграция — это переезд стилей, а не редизайн. Любое визуальное отличие от состояния до изменений — баг, а не «улучшение».
- **Никаких `isThemeable`-веток.** Семантический DOM — всегда, для всех тем.
- **Bootstrap и инлайн-стили — в именные классы, 1:1.** Значение берётся из оригинала, а не «похожее».
- **Новые токены — только цвета.** Паддинги, размеры, радиусы — литералами в классе.
- **Не трогай бизнес-логику.** Только DOM-атрибуты, классы, теги и CSS.

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

### Единая схема хедеров и сабтайтлов (Ноябрь 2026 — ревизия, supersede старых имён)
> В этом разделе — фактическая схема после ревизии. Где ниже по журналу встречаются старые
> имена (`.category-header` как полоса группы, `.category-head`, `.topic-list-head`,
> `.forum-view-header` и т.п.) — они переименованы этим разделом; исторические записи
> журнала не правятся, но правильные имена теперь только эти.

Сущности «группа» и «список тем» внешне похожи, но это разные блоки. Один класс = разметка,
различия = модификаторы (только состояния), визуальные варианты = отдельные именованные блоки
(не модификаторы), размеры/паддинги/шрифты — литерально в классах, токены — только цветовые.

| Сущность | Класс | Где | Что это |
|---|---|---|---|
| Хедер группы (главная) | `.category-group-header` + `.category-group-title` (h2) | forum-index.css | цветная полоса с названием группы |
| Хедер колонок (главная) | `.category-group-subtitle` | forum-index.css | полоса forum/topics/posts/lastpost, small-caps |
| Хедер страницы (категория + active/new/subs) | `.category-header`, элементы `-heading/-title/-description/-meta/-actions` | forum-view.css | название + описание + контролы (id остаётся `#forum-view-header`) |
| Хедер колонок (категория + active/new/subs) | `.category-subtitle` | forum-view.css | полоса topic/[category]/replies/lastpost; **дизайн = хедер группы** |
| Ячейки колонок (общие атомы) | `.category-col--{forum,topic,topics,posts,replies,category,lastpost}` | forum-index.css | выравнивание/nowrap; используются обоими сабтайтлами |
| Мобильная полоса LAST POST | `.last-post-strip` (единый класс) | topic-row.css | ОДИН класс для `.forum-last-post` (главная + категория) и `.topic-last-post` (списки). Хром полосы (паддинги, компенсирующие margins, фон, бордер, метка, ховер-подсветка) правится только в topic-row.css — страница-файлы его не дублируют. В author-meta.css мета-блок главной скоуплен на `#forum-index` — не убирать скоуп, иначе форс-stretch ссылки снова перебьёт ховер-подсветку на категории/списках |
| Строка категории | `.forum-item--topic` | forum-index.css | вариант `.forum-item`: 3 колонки, без counts-topics |
| Состояние manage | `.has-check` (хедер), `.is-managing` (строка) | — | +фиксированная колонка чекбокса **40px** |

Правила, выверенные со скриншотами деплоя (2026-11-14):
- **Чекбокс-колонка** — константные **32px** + обычный 10px gap и в хедере (`.category-subtitle-check`),
  и в строках (`.forum-item--topic.is-managing`, `.topic-item.is-managing`); `.topic-select` —
  `padding: 0`, ширина колонки и есть визуальная ширина. Ломать «растягивается с колонкой»
  легаси-Table не воспроизводим. Чекбокс — полностью кастомный нативный input
  (`.topic-select-input`: рамка/фон из токенов `--topic-check-*`, белая галка на `--primary-color`).
  На мобильных — «чип» в правом верхнем углу карточки: absolute top/right с подложкой
  `--topic-check-chip-bg` (сильнее в dark).
- **Иконки pinned/locked** — inline в flex-строке заголовка (`.forum-title` — flex+wrap),
  по поведению как буллет: никогда не переносятся на строку выше тайтла.
- **Last Post**: главная — тайтл темы + таймштамп/автор; категория и списки —
  только таймштамп + автор (+ unread dot), тайтл уже в первой колонке
  (`.last-topic-link` на категории не рендерится).
- **Врапается всё, кроме цифр**: тайтл (длинные названия + мини-пагинация), колонка категории
  (`.topic-category a` — `white-space: normal; overflow-wrap: anywhere`), last-post
  (длинные ники/таймштампы). Только counters (`.forum-topics/.forum-posts/.topic-replies`) — nowrap.
- **Название категории в строках списков — без дублей**: на десктопе оно живёт ТОЛЬКО в
  колонке `.topic-category`; на мобильных (колонка скрыта) — в строке статов
  `.topic-mobile-stats`: счётчик слева, категория справа (`.topic-mobile-category`).
  Инлайн-вариант под тайтлом удалён как мёртвый код.
- **Типографика строк категории = TopicRow**: `.forum-item--topic .forum-title` —
  `--topic-title-*` (1rem/700), мини-пагинация регулярного веса, под тайтлом мета
  создания `дата · автор` (`.topic-author`, AuthorMeta `showAvatar={false}`).
- **Мобильные ≤768px**: `.category-subtitle` и `.category-group-subtitle` — `display:none`
  (строки перестраиваются в колонку); хедеры страниц остаются.
- **Средний диапазон ≤993px**: все сетки сужаются согласованно — счётчики 100px→80px,
  первая колонка 260px→220px; чекбокс-колонка остаётся 32px. Варианты: `.forum-item`,
  `.forum-item--topic(.is-managing)`, `.category-group-subtitle`, `.category-subtitle`
  (`+.has-category`, `+.has-check`), `.topic-item` (те же модификаторы). Media-блоки
  стоят ПОСЛЕ базовых правил (та же специфичность — решает порядок в файле).
- **Мини-пагинация** строк — общий компонент `TopicMiniPagination` (TopicRow + строки категории).
- **Токены**: `--category-group-header-*` (полоса группы), `--category-header-*`
  (хедер страницы; description-color по темам), `--category-subtitle-bg/-text` —
  алиасы цветов хедера группы (тема, перекрашивающая полосу, красит и сабтайтл),
  `--forum-view-btn-danger-*` (Delete в toolbar). `--topic-list-head-*` удалены —
  геометрия сабтайтла литерально в классе.
- Обёртки без Bootstrap: `#forum-view` корень категории (`data-forum-id`),
  `#forum-topic-list` > `.topic-list`, `#forum-pagination-bottom` + `.forum-view-pagination`
  (border-top внутри карточки), `.forum-view-error`, `.forum-view-empty-actions`,
  `.forum-view-footer/.forum-view-back`; toolbar — `.management-toolbar-count/-divider/-hint`,
  кнопки `.forum-view-action-btn--secondary/--danger` + `.forum-view-action-label`
  (иконка < 992px, иконка+текст ≥ 992px).

### Структура стилей (куда что класть)

| Файл | Зона ответственности |
|---|---|
| `src/styles/theme-variables.css` | Все семантические токены (`--*`), значения по умолчанию на `body` + переопределения `body[data-theme='dark'/'light'/'neutral']`. Никаких правил layout здесь — только переменные. `body`, а не `:root`: см. «Фикс тёмной темы Категории» в статусе Этапа 2. |
| `src/styles/layout.css` | Каркас: `#forum-wrapper`, `#forum`, `#forum-header`, `#forum-title`, `#forum-nav`, `#forum-user-links`, `#forum-status`, `#forum-announcement`, `#forum-about`, футер. |
| `src/styles/forum-index.css` | Главная: `#forum-index`, `#forum-main`, `.forum-category`, `.category-group-header/.category-group-title`, `.category-group-subtitle`, общие ячейки `.category-col--*` (главная + сабтайтлы списков), `.forum-item` (+`.forum-item--topic` для строк категории), `.forum-last-post`, скелетоны главной. |
| `src/styles/forum-stats.css` | `ForumStats`: `#forum-statistics`, `.forum-stats-card`, `.stats-*`, `.online-*`. |
| `src/styles/forum-view.css` | Страница категории + списки тем: `#forum-view`, `#forum-view-header` + `.category-header(-title/-description/-actions)`, `#forum-actions-top`, `#forum-pagination-*`, `#forum-topic-list`, `.category-subtitle` (+`.has-check/.has-category`), `.forum-view-empty`, `.forum-view-back`, `.management-toolbar*`, `.forum-view-spinner`, `.topic-select-input`, классы скелетонов списка. |
| `src/styles/topic-row.css` | `TopicRow` (общий атом списков): `.topic-item`, `.topic-main/head/title/description/meta`, `.topic-category`, `.topic-replies`, `.topic-last-post`, `.mini-pagination`, `.unread-dot`. |
| `src/styles/author-meta.css` | `AuthorMeta` + `LastPostInfo`: `.author-meta`, `.author-meta__date`, `.author-meta__identity`, `.author-meta__avatar`, `.author-meta__name`, `.last-post-link-meta`, `.last-post-meta`, `.last-post-empty`. |
| `src/styles/forum-pagination.css` | `ForumPagination` (общий атом): `.forum-pagination`, `.page-item/.page-link` состояния. Импортируется только из `main.jsx`; локальный `ForumPagination.css` удалён (был `@import`-редирект). |
| `src/styles/utilities.css` | Остаточные глобальные утилиты (`.cursor-pointer`, `.user-select-none`, `.spin`, `.topic-pinned/.topic-locked` через токены). Management toolbar здесь больше не живёт — переехал в `forum-view.css`. |
| `src/index.css` | Глобальные темы/база + ещё не мигрированные страницы. Новые семантические правила сюда не добавлять. |
| `src/main.jsx` | Порядок импортов: `theme-variables.css` → модульные `src/styles/*.css`. Bootstrap CSS остаётся подключённым до конца миграции. |

### Аудит 2026-11-17: остаток миграции (сверено с `feature/theming`, HEAD `2e574979`)

#### Что уже чисто (0 инлайн-стилей, 0 Bootstrap-утилит, 0 react-bootstrap)
`MainPage`, `CategoryPage`, `TopicPage`, `TopicPostCard`, `TopicHeader`, `TopicActionsBar`, `TopicRow`, `TopicMiniPagination`, `ActiveTopicsPage`, `NewRepliesPage`, `SubscriptionsPage`, `AuthorMeta`, `ForumStats`, `LastPostInfo`, `App.jsx`, `main.jsx` (+ не-UI: `api/`, `hooks/`, `contexts/` кроме `ToastProvider`, `utils/`, `config/`, `i18n/`). Это Этапы 1–2 и ядро Этапа 3.

#### Хвост внутри уже переведённых мест (добить до снятия Bootstrap)
- `ForumPagination.jsx` — `Pagination` из react-bootstrap (6 тегов), утилит 0.
- `ForumBreadcrumbs.jsx` — `Breadcrumb` из react-bootstrap (3 тега).
- `Layout.jsx` — `Container` (2 тега) + 5 утилит. Full-width для `/admin` (CP-1.1) готов; остаток (футер и неадминские страницы) — Спринт B.
- `ForumRoleBadge` / `ForumCharacterBadge` / `ForumAuthorAvatar` — `Badge` / `Image` (1–4 тега).
- `ForumTabs.jsx` — 3 утилиты, `LastPostInfo.jsx` — 3 (`text-muted`, `small`, `me-1`), `ForumStats.jsx` — 2 (`mt-5`, `mb-4`), `TopicHeader.jsx` — 1 (`text-nowrap`), `NewRepliesPage.jsx` — 1.
- `ForumEmptyState.jsx` — ещё на Bootstrap `Card` (Этап 7). `ForumModal.jsx` — обёртка над react-bootstrap `Modal` (9 тегов).
- `Navbar.jsx` — вопреки записи Этапа 1 («устранены инлайн-стили»): 11 `style={{…}}` (бейдж статуса, точка-индикатор, аватар 32px, плейсхолдеры `width: 16` под галочку темы, `cursor: pointer`) + 94 Bootstrap (75 утилит + 19 RB-тегов). Добить отдельным заходом.
- `ScrollButtons.jsx` — мёртвый импорт `Button` из react-bootstrap (не используется).

#### Не начато: полный остаток
Всего: `style={` — 277 в 37 файлах (из них `style={{` — 266; остальное — одиночные `style={…}` с динамикой). Точных Bootstrap-утилит + RB-тегов — 4 596. React-bootstrap импортируют 52 файла. `bootstrap.min.css` всё ещё подключён в `main.jsx:4` — снимать нельзя, пока эти файлы на нём. `index.css` до сих пор несёт 288 hex-значений и Bootstrap-переопределения (живые, не только закомментированные).

| Файл | Inline `style={` | Bootstrap (утилиты + RB-теги) | Таблицы | Статус |
|---|---|---|---|---|
| `pages/AdminPage.jsx` | 52 | 875 | 5 таблиц (81 тег) | не начато |
| `pages/ProfilePage.jsx` | 35 | 763 | 1 (история репутации, 16) | не начато |
| `components/common/RichEditor.jsx` | 20 | 510 | 1 (хоткеи, 4) | не начато, особый случай |
| `pages/NotificationsPage.jsx` | 13 | 218 | — | не начато |
| `components/dm/DirectMessages.jsx` | 33 | 169 | — | не начато |
| `components/profile/SecurityTab.jsx` | 3 | 171 | — | не начато |
| `pages/MembersPage.jsx` | 11 | 149 | 1 (список участников, 20) | не начато |
| `components/common/BBCode.jsx` | 28 | 92 | 1 (пользовательские `[table]`, 10) | особый случай |
| `components/admin/EmailTemplatesSettings.jsx` | 4 | 114 | — | не начато |
| `components/layout/Navbar.jsx` | 11 | 94 | — | хвост Этапа 1 |
| `components/admin/DesignsTab.jsx` | 0 | 102 | — | не начато |
| `pages/DraftsPage.jsx` | 3 | 91 | — | не начато |
| `components/topic/TopicReplyComposer.jsx` | 5 | 89 | — | хвост Этапа 3 |
| `pages/TopicFormPage.jsx` | 0 | 86 | — | не начато |
| `components/auth/RegisterForm.jsx` | 2 | 84 | — | не начато |
| `pages/ConfirmPasswordResetPage.jsx` | 1 | 72 | — | не начато |
| `components/auth/LoginForm.jsx` | 2 | 63 | — | не начато |
| `components/common/ErrorCard.jsx` | 7 | 61 | — | не начато |
| `components/topic/TopicModalsContainer.jsx` | 1 | 61 | — | хвост Этапа 3 |
| `components/modals/TransferRootModal.jsx` | 0 | 55 | — | не начато |
| `components/common/EmailVerificationBanner.jsx` | 0 | 52 | — | не начато |
| `pages/ConfirmVerificationPage.jsx` | 1 | 52 | — | не начато |
| `components/topic/PostInlineEditor.jsx` | 1 | 40 | — | хвост Этапа 3 |
| `components/modals/MovePostsModal.jsx` | 9 | 37 | — | не начато |
| `components/modals/UnsentReplyModal.jsx` | 4 | 36 | — | не начато |
| `components/common/AvatarUploader.jsx` | 6 | 35 | — | не начато |
| `components/common/PostVotersModal.jsx` | 0 | 34 | — | не начато |
| `components/auth/ForgotPasswordForm.jsx` | 0 | 32 | — | не начато |
| `components/common/ReputationHoverPreview.jsx` | 0 | 29 | — | не начато |
| `pages/LoginPage.jsx` | 1 | 29 | — | не начато |
| `components/common/ConnectionStatusBanner.jsx` | 2 | 26 | — | не начато |
| `pages/PendingPage.jsx` | 2 | 25 | — | не начато |
| `components/modals/AuthModal.jsx` | 0 | 24 | — | не начато |
| `pages/RegisterPage.jsx` | 1 | 20 | — | не начато |
| `components/modals/BannedLogoutModal.jsx` | 1 | 19 | — | не начато |
| `components/modals/DeletedLogoutModal.jsx` | 1 | 19 | — | не начато |
| `components/modals/MaintenanceLogoutModal.jsx` | 1 | 19 | — | не начато |
| `pages/BannedPage.jsx` | 2 | 16 | — | не начато |
| `contexts/ToastProvider.jsx` | 4 | 15 | — | не начато |
| `components/common/ConfirmModal.jsx` | 0 | 11 | — | не начато |
| `components/common/ScrollButtons.jsx` | 0 | 10 | — | не начато (+ мёртвый импорт) |
| `components/common/SmilesPicker.jsx` | 3 | 10 | — | не начато |
| `pages/MessagesPage.jsx` | 0 | 10 | — | не начато |
| `components/common/ForumEmptyState.jsx` | 0 | 9 | — | хвост, Этап 7 |
| `components/common/ForumModal.jsx` | 0 | 9 | — | хвост |
| `components/common/RealtimeStatusBanner.jsx` | 0 | 9 | — | не начато |
| `components/common/UnsentReplyNotice.jsx` | 1 | 9 | — | не начато |
| `components/layout/Layout.jsx` | 0 | 7 | — | хвост Этапа 1 |
| `components/modals/MoveTopicsModal.jsx` | 0 | 7 | — | не начато |
| `components/common/ForumPagination.jsx` | 0 | 6 | — | хвост |
| `components/common/ForumRoleBadge.jsx` | 0 | 4 | — | хвост |
| `components/common/ForumBreadcrumbs.jsx` | 0 | 3 | — | хвост |
| `components/common/ForumCharacterBadge.jsx` | 1 | 3 | — | хвост |
| `components/common/ForumTabs.jsx` | 0 | 3 | — | хвост |
| `components/common/LastPostInfo.jsx` | 0 | 3 | — | хвост |
| `components/layout/ForumStats.jsx` | 0 | 2 | — | хвост |
| `components/common/ForumAuthorAvatar.jsx` | 0 | 1 | — | хвост |
| `components/topic/TopicHeader.jsx` | 0 | 1 | — | хвост |
| `pages/NewRepliesPage.jsx` | 0 | 1 | — | хвост |
| `components/common/ForumAuthorName.jsx` | 1 | 0 | — | хвост |
| `components/common/Skeleton.jsx` | 1 | 0 | — | хвост (динамика через пропс) |
| `components/layout/ForumBackground.jsx` | 3 | 0 | — | динамика (opacity), не переводить в статику |

#### Пересчёт админки 2026-11-18 (реорг влит, HEAD `68bb9bc`)

Метод пересчёта (повторить той же логикой): `style={` — буквальный подсчёт вхождений; Bootstrap — токены классов из `className` по префиксам утилит Bootstrap 5 (`d-*`, `flex-*`, `gap-*`, `m-*/p-*`, `text-*`, `bg-*`, `border*`, `rounded*`, `fw-*`, `fs-*`, `btn*`, `form-*`, `table*`, `card*`, `modal*`, `nav*`, `row`/`col`, `container*` и т.п.) плюс JSX-теги, импортированные из `react-bootstrap` в том же файле. Прямое сравнение с числами 2026-11-17 некорректно (там был ручной список токенов); инлайн-счётчики совпали (52/0/4) — реорг инлайн-стили не трогал, только обёртку.

| Файл | Inline `style={` | Bootstrap (утилиты + RB-теги) | Таблицы | Статус |
|---|---|---|---|---|
| `pages/AdminPage.jsx` | 52 | 701 (591 + 110) | 5 (`<Table hover responsive>`, 81 тег) | реорг влит; внутренности не начаты |
| `components/admin/DesignsTab.jsx` | 0 | 67 (49 + 18) | — | реорг влит; сетка на Bootstrap `Row`/`Col`/`Card` |
| `components/admin/EmailTemplatesSettings.jsx` | 4 | 109 (93 + 16) | — | реорг влит; не начато |
| `components/admin/AdminSidebar.jsx` | 0 | 3 (только `Offcanvas`/`OverlayTrigger`/`Tooltip`, утилит 0) | — | обёртка готова |
| `components/layout/Layout.jsx` | 0 | 7 (2 `Container` + 5 утилит футера) | — | full-width для `/admin` готов (CP-1.1); остаток — хвост Этапа 1 (Спринт B) |
| `components/modals/TransferRootModal.jsx` | 0 | 43 (38 + 5) | — | не начато (модалка админки) |

Готово после реорга: сайдбар и навигация (`AdminSidebar`, конфиг навигации, тест `test:admin-nav-config`), полноширинный лейаут (`Layout.jsx`, CP-1.1), система `.admin-card` на переменных темы (0 hex в `AdminSidebar.css`). Не начато: все 5 таблиц и внутренности табов — см. Спринт H.

#### Два бага из аудита — ИСПРАВЛЕНО в `2e574979`

- **Баг A — список дополнительных BBCode подчёркивался при редактировании.** Причина: пункты overflow-меню RichEditor — это `<a class="dropdown-item">`, а `.post-content a` их подчёркивает, когда редактор стоит внутри поста. Исправлено скоупленными правилами `.editor-overflow-dropdown-menu .dropdown-item` и `.post-content .editor-overflow-dropdown-menu .dropdown-item` в `src/index.css` (без `!important`). Глобальное правило `.post-content a` не тронуто.
- **Баг B — линия цитаты в тёмной теме слишком светлая.** Причина: `.bbcode-quote` брал `var(--primary-color)`, а в тёмной теме это почти белый `#f1f5f9`. Исправлен новым цветовым токеном `--quote-border-color` (светлая `#1e293b` / тёмная `#334155` / нейтральная `#666`) в `src/styles/theme-variables.css`; нейтральный оверрайд `border-left-color` удалён как лишний.

#### Правило 1. Уход от жёстких HTML-таблиц к гибким гридам
Layout-таблицы (`<Table>` из react-bootstrap и голые `<table>`) больше не используются для раскладки страниц. Паттерн замены — тот же, что уже применён на главной/категории/топике: CSS grid с колонками (`forum-index.css`, `forum-view.css`, `topic-row.css`), на ≤768px — перестройка в карточки, а не горизонтальный скролл таблицы. Инвентарь таблиц (всего 131 тег в 5 файлах):
- `AdminPage.jsx` — 5 таблиц (81 тег): пользователи, роли, группы категорий, категории (с инлайн-редактированием строк), аудит-лог. Все — в гриды/карточки, по одной таблице за заход; `table-active` у редактируемой строки → state-класс `.is-editing`. Таблицы — `<Table hover responsive>` (это горизонтальный скролл на мобильных, а не адаптив); лежат внутри `.admin-card` (обёртка уже готова, мигрировать таблицу, а не карточку). Пересчитано 2026-11-18 — без изменений.
- `MembersPage.jsx` — 1 таблица (20 тегов): список участников. В грид; `data-label` для мобильной вёрстки сохранить как есть (он уже есть и работает как подписи ячеек в карточном виде); `.members-table-*` (`index.css:507–566`) переезжает в новый модуль стилей.
- `ProfilePage.jsx` — 1 таблица (16 тегов): история репутации. В грид/список.
- `RichEditor.jsx:1546–1553` — таблица хоткеев в модалке (4 тега). В `<dl>`/грид, не в `<table>`.
- `BBCode.jsx:1080–1124` — единственное место, где `<table>` остаётся: рендер пользовательских `[table]/[tr]/[td]` из постов. Это не layout, а контент пользователя — таблицу не убирать, а переводить её классы (`bbcode-tr`, `bbcode-td`) с Bootstrap-утилит на свои и убирать инлайн `tableStyle`/`tdStyle` (параметры из поста — через CSS-переменные/санитизацию, отдельным подходом, не 1:1 в классы).

#### Правило 2. В токены — только цвета (обязательно для новых токенов)
Уже записано в «Единой схеме хедеров» («токены — только цветовые», размеры/паддинги — литерально в классах), но файл этому не следует. Факт на 2026-11-17: `theme-variables.css` — 380 определений, 298 уникальных имён; из них цветовых — 144, геометрии (паддинги/зазоры/размеры/радиусы/тени/opacity/font-size/weight/line-height/letter-spacing) — 154. То есть почти половина токенов — геометрия, которую по правилу там быть не должно. Базовые токены (`--primary-color`, `--border-color`, `--link-color` и др.) вообще живут не здесь, а в `index.css:1–115` — при переносе цветов это учитывать.
- Новые токены — только цвета (включая цвет текста/фона/бордера; тень — цветовая часть через токен, геометрия тени — литерально в правиле). Новые `--*-size`, `--*-padding`, `--*-radius`, `--*-gap` не заводить.
- Существующие геометрические токены — заморозить: не удалять одним махом (сломается рендер), новые не добавлять, при касании файла переводить значение литерально в класс и удалять токен.
- Дефекты токенов к исправлению при следующем касании файла: дубль `--topic-post-skeleton-footer-border` (строки 316–317, идентичные); `--forum-view-btn-ghost-hover-text` дважды внутри `[data-theme='dark']` с конфликтующими значениями (`#f1f5f9`, затем `#0f172a` — работает только за счёт порядка, первое значение равно цвету hover-фона, т.е. невидимый текст при перестановке); нет базового определения у `--last-post-name-color` (только dark `:415` и neutral `:477`) и `--author-date-color` (только dark `:416`); 7 цветовых токенов названы не как цвета (`--category-head-text`, `--category-subtitle-text`, `--forum-footer-text`, `--forum-view-btn-ghost-text`, `--forum-view-btn-primary-text`, `--stats-item-muted`, `--stats-item-text`).
- Хардкод hex/rgb вне `theme-variables.css` (в `src/styles/*.css`): `author-meta.css` — 8 (`:161–162` `#edeef0`/`#1e293b`, `:168`, `:178` `#ffffff` — живые), `topic-view.css` — 3 (`:513` `#6c757d`, `:515` `#fff`, `:1196` `#198754`) + 17 `rgba()/rgb()` (в основном тени `rgba(0,0,0,…)`, но и нейтральные литералы `:448,452,1060–1062`), `layout.css` — 4 (`:120` `#f59e0b`, `:141` `#ffc107`, `:142`, `:150` `#000000`), `forum-stats.css` — 1 (`:196` `#b91c1c`), `utilities.css` — только fallback в `var()` (безопасно). Чистые (0 hex): `forum-breadcrumbs.css`, `forum-index.css`, `forum-pagination.css`, `forum-view.css`, `topic-row.css`.

#### Карта повторяющихся элементов: где повторяется, чем отличается
Один элемент — один владелец (компонент + один CSS-модуль). Модификатор — только расположение/состояние, не новый вид. Различия между страницами — в данных и модификаторах, а не в дублировании разметки.

| Элемент | Владелец | Где повторяется | Отличия по страницам |
|---|---|---|---|
| Хлебные крошки | `ForumBreadcrumbs.jsx` + `forum-breadcrumbs.css` (`.forum-breadcrumbs`) | `TopicHeader`, `CategoryPage`, `ActiveTopicsPage`, `NewRepliesPage`, `SubscriptionsPage`, `TopicPage`, `AdminPage`, `DraftsPage`, `MembersPage`, `NotificationsPage`, `ProfilePage`, `TopicFormPage` | Только на странице топика — обёртка `.forum-breadcrumbs__wrapper` + модификатор `.forum-breadcrumbs--topic`; везде иначе — голый `.forum-breadcrumbs`. Внутри — всё ещё react-bootstrap `Breadcrumb` (хвост). |
| Пагинация | `ForumPagination.jsx` + `forum-pagination.css` (`.forum-pagination`) | Списки (`CategoryPage`, `ActiveTopicsPage`, `NewRepliesPage`, `SubscriptionsPage`), топик (`TopicHeader`, `TopicActionsBar`), `AdminPage`, `MembersPage`, `NotificationsPage`, `ProfilePage` | `.forum-pagination-view` — full-width centered row для списков (только `Active/NewReplies/Subscriptions` уже переведены на него; `CategoryPage` до сих пор с обёрткой `<nav id="forum-pagination-bottom" class="forum-view-pagination">` — перевести на модификатор). `.forum-pagination-topic` — компактная строка внутри хедера топика. Внутри — всё ещё react-bootstrap `Pagination` (хвост). |
| Хедер страницы | `.category-header` (+ `#forum-view-header`) в `forum-view.css` | `CategoryPage` + 3 списка тем (один и тот же корень `#forum-view`, различие — `data-forum-id`: id категории vs `active-topics`/`new-replies`/`subscriptions`) | Actions внутри хедера — только на `CategoryPage`; описание — только у категории; у списков — только заголовок. Не путать с `.category-group-header` главной — это другая сущность (полоса группы, см. «Единую схему хедеров»). |
| Сабтайтл (шапка колонок) | `.category-subtitle` (`forum-view.css`) / `.category-group-subtitle` (`forum-index.css`) | Списки + категория / главная | Один дизайн (алиасы `--category-subtitle-bg/-text` на цвета хедера группы), но два класса: `.category-subtitle` — для страниц списков, `.category-group-subtitle` — для групп главной. На ≤768px оба `display:none`. |
| Строка топика | **ДВА владельца — дублирование, зафиксировать как долг.** `TopicRow.jsx` (`.topic-item`, `topic-row.css`) vs инлайн-разметка в `CategoryPage.jsx:344` (`.forum-item--topic`, `forum-index.css`) | `TopicRow` — `ActiveTopicsPage`, `NewRepliesPage`, `SubscriptionsPage`. `.forum-item--topic` — только `CategoryPage` (скелетон — `:250`) | Общее: чекбокс `.topic-select/.topic-select-input` + `.is-managing`, мини-пагинация, иконки pinned/locked инлайн в заголовке, unread-логика, `AuthorMeta` (создание: дата · автор). Различия: `TopicRow` — `.topic-main/.topic-head`, заголовок `h6.topic-title`, есть колонка `.topic-category` (+ `.topic-mobile-category` в мобильных статах), `.topic-replies` с `data-label`, `.topic-last-post.last-post-strip`, `data-topic-id` + `data-category-id`, `.topic-meta` скрывается на мобильных целиком. `.forum-item--topic` — заголовок `h3.forum-title`, ссылка `.cat-link`, колонки категории нет (страница и есть категория), мобильные статы `.forum-mobile-stats`, `data-topic-id` без `data-category-id`. В `CategoryPage.jsx:387` комментарий «same as the TopicRow reference render» — эталоном считается `TopicRow`; при следующем касании категории — свести к одному компоненту, а не править оба места. |
| Строка форума (главная) | `.forum-item` (`forum-index.css`) | Только `MainPage` | Похожа на строку топика внешне (заголовок + счётчики + last post), но другая сущность: форум, а не топик. Есть описание, счётчики topics/posts, нет мини-пагинации и unread-логики топиков. С `.forum-item--topic` не объединять — вариант `--topic` это строка топика, а не форума. |
| Last Post / AuthorMeta | `AuthorMeta.jsx` + `LastPostInfo.jsx` + `author-meta.css` (`.author-meta`, `.last-post-strip`) | `MainPage`, `CategoryPage` (через обе строки топиков), `TopicRow` | Главная: тайтл темы + дата/автор. Категория и списки: только дата + автор (`.last-topic-link` не рендерится, тайтл уже в первой колонке). Мобильная полоса — единый класс `.last-post-strip`; хром правится только в `topic-row.css`. |
| Management toolbar | `.management-toolbar-*` (`forum-view.css`) | `CategoryPage` + 3 списка | Один компонент; чекбокс-колонка — константа 32px + 10px gap в хедере и строках; на мобильных — «чип» в правом верхнем углу карточки. |
| Карточка поста | `.topic-post` (`topic-view.css`) | Только `TopicPage` (`TopicPostCard.jsx`) | Повторов нет. Остаток Этапа 3 — не карточка, а `TopicReplyComposer` / `PostInlineEditor` / `TopicModalsContainer` (контракты `.topic-reply*` / `.topic-post-editor*` уже готовы в CSS). |
| Пустое состояние | `ForumEmptyState.jsx` (8 страниц: `MainPage`, `CategoryPage`, `ActiveTopicsPage`, `NewRepliesPage`, `SubscriptionsPage`, `DraftsPage`, `NotificationsPage`, `ProfilePage`) | Везде одинаковый вызов с `className="forum-view-empty-state"` | Внутри — всё ещё Bootstrap `Card` (Этап 7). |
| BBCode / RichEditor | `BBCode.jsx`, `RichEditor.jsx` | Посты, композер ответа, редактор поста, форма новой темы | Отдельный воркстрим, не «перевести в классы 1:1»: часть инлайн-стилей — данные пользователя (`[color]`, `[size]`, параметры `[table]`/`[td]`, свотчи палитры, динамическая ширина), часть Bootstrap-утилит (92 в `BBCode.jsx`) — в рендере пользовательского контента, снятие `bootstrap.min.css` сломает посты, пока они не заменены. |

#### Порядок следующих шагов (обновлено 2026-11-17)

Новый порядок — спринты A–J ниже в этом документе (старая нумерация Этапов 1–7
отображена в разделе спринтов). Коротко:

1. **Спринт A** — хвост Этапа 3 (ReplyComposer / PostInlineEditor / TopicModalsContainer) + сведение строк категории к одному `TopicRow` + пагинация категории.
2. **Спринт B** — хвост Этапа 1: общие атомы (Pagination, Breadcrumbs, Layout, бейджи/аватар, Tabs, EmptyState, Modal, Navbar, ScrollButtons).
3. **Спринт C** — MembersPage.
4. **Спринт D** — NotificationsPage + DraftsPage + TopicFormPage (по одной).
5. **Спринт E** — DirectMessages + MessagesPage.
6. **Спринт F** — Auth + служебные страницы (Login/Register/Pending/Banned + формы).
7. **Спринт G** — BBCode + RichEditor (отдельный воркстрим, контент пользователя — не 1:1-конверсия).
8. **Спринт H** — AdminPage + DesignsTab + EmailTemplatesSettings. ПОСЛЕДНИМ: реорг влит в `feature/theming` (HEAD `68bb9bc`); начинать с инвентаря в подразделе «Пересчёт админки 2026-11-18».
9. **Спринт I** — ProfilePage + SecurityTab. ПОСЛЕДНИМ: сначала реорг по `SPEC_REFACTOR_PROFILE_PAGE_ARCHITECTURE.md`, темизация — по финальному DOM.
10. **Спринт J** — снятие Bootstrap (`bootstrap.min.css` из `main.jsx`, `react-bootstrap` из зависимостей) + финальная проверка.

Цифры остатка выше — на 2026-11-17, HEAD `1598c0c`; инлайн-счётчики перепроверены 2026-11-17 на HEAD `2e574979` — без изменений. Админка пересчитана отдельно 2026-11-18 (HEAD `68bb9bc`) — см. подраздел «Пересчёт админки 2026-11-18».

### Расхождения с исходными спринтами (факт vs план)
> Ветвления `isThemeable ? new : old` нет — семантический DOM всегда (решение Этапа 1). Имена ниже — фактические.

- `CategoryPage`: корень `<main id="forum-view">`; header `#forum-view-header` (не `#forum-header`), title `.category-header-title`, список `<section id="forum-topic-list">`, шапка `.category-subtitle` + `.category-col--topic/.category-col--category/.category-col--replies/.category-col--lastpost` (не `.topic-list-header/.topic-column`); пагинация `#forum-pagination-top/bottom` + `.forum-view-pagination`; `#forum-actions-bottom`/`#forum-breadcrumbs-bottom` нет — только `.forum-view-footer/.forum-view-back`.
- `TopicRow`: pinned → `.is-pinned` (не `.is-sticky`); `data-category-id` на article; колонки views нет; mini-pagination — `.mini-pagination` внутри `.topic-head`.
- Списки тем: отдельных `#*-page/#*-list` нет — общий `#forum-view/#forum-topic-list`, различие только `data-forum-id`.

### Как продолжать в следующей сессии

1. Источник правды — ветка `feature/theming` на GitHub, HEAD=`68bb9bc` (2026-11-18, реорг админки влит). Работай из настоящего клона ветки (`git pull` перед началом); локальные копии и zip-снимки без git-контроля — не источник правды, не верить им.
2. Node (машина Алины, Git Bash): `export PATH="$PATH:/c/nvm4w/nodejs:/c/Users/Alina/AppData/Local/nvm"` → `node v24.14.0`, `npm 11.9.0`. PowerShell-строка с `%NVM_HOME%` в Git Bash не работает.
3. Статус тестов на HEAD `68bb9bc`: `npm run build` — OK; `npm test` — exit 0, 88 OK, lint 0 ошибок, 15 предсуществующих предупреждений. (На HEAD `2e574979` было 80 OK и падал `test:account-status-axis` — починен в `b8f36780` вместе с CSS-дубликатами.)
4. Перед чисткой `index.css` — `grep` по `src --include='*.jsx'`: `.forum-table*` и `.empty-state-*` пересекаются с немигрированными страницами.
5. Новые токены — только `theme-variables.css`, новые правила — только `src/styles/*.css`; `grep -n '!important' src/styles/*.css` должен давать только комментарии.

---

## Исполнительный плейбук: как мигрировать ОДИН компонент

> Этот раздел — главный. Если спринт и плейбук расходятся, прав плейбук.

### Шаг 0. Возьми ровно один компонент

- Один компонент = один JSX-файл (+ его CSS-модуль, если он есть) или один логический блок внутри большого файла (например, один таб админки).
- Не бери два компонента за раз, не «заодно» правишь соседние файлы. Контекст теряется именно так.
- Прочти спринт целиком, потом SPEC этой страницы (если есть), потом сам файл.

### Шаг 1. Зафиксируй, как выглядит «до»

- Открой страницу в трёх темах (`dark` / `light` / `neutral`) и на трёх ширинах (десктоп, ≤993px, ≤768px), если есть живой стенд. Нет стенда — читай CSS как спецификацию: итоговые computed-стили элемента = истина.
- Выпиши для компонента: что видно, какие состояния есть (hover, focus, disabled, active, unread, empty, loading, error), какие элементы прячутся на мобиле.
- Если сомневаешься, как выглядит элемент, — не гадай: напиши в отчёте, что не удалось сверить. Угаданный стиль — это переделка глазами Алины.

### Шаг 2. Составь инвентарь: что именно переезжает

В файле компонента выполни `grep` и выпиши в отчёт (короткой таблицей, не прозой):

- `style={{...}}` — каждый инлайн-стиль с его значениями;
- Bootstrap-утилиты в `className` — каждый класс;
- `react-bootstrap` — каждый импортированный компонент и каждый его JSX-тег;
- `<table>` / `<Table>` — каждая таблица;
- `id` и `className`, которые уже есть и используются в JS или CSS (их нельзя молча удалять).

### Шаг 3. Переведи Bootstrap-правила в значения

Bootstrap-класс — это не магия, а готовое CSS-правило. Бери значение из `bootstrap.min.css` / `src/index.css` и переноси литерально. Опорная таблица (самое частое):

| Было | Становится (значение — в класс, литерально) |
|---|---|
| `m-0..5`, `mt-*/mb-*/ms-*/me-*/mx-*/my-*` | `margin[-*]`: `0 / 0.25rem / 0.5rem / 1rem / 1.5rem / 3rem` |
| `p-0..5`, `pt-*/pb-*/ps-*/pe-*/px-*/py-*` | `padding[-*]`: та же шкала |
| `d-none / d-block / d-flex / d-grid / d-inline-flex` | `display: none / block / flex / grid / inline-flex` |
| `flex-row / flex-column`, `flex-wrap`, `flex-grow-1 / flex-shrink-0` | `flex-direction / flex-wrap / flex` — теми же значениями |
| `justify-content-start/center/end/between/around` | `justify-content: flex-start / center / flex-end / space-between / space-around` |
| `align-items-start/center/end/baseline/stretch` | `align-items` — теми же значениями |
| `gap-0..5` | `gap`: шкала отступов |
| `text-start / text-center / text-end` | `text-align: left / center / right` |
| `text-muted` | `color: var(--secondary-color)` (в этом проекте muted — secondary, см. журнал) |
| `text-decoration-none` | `text-decoration: none` |
| `fw-light / fw-normal / fw-medium / fw-semibold / fw-bold` | `font-weight: 300 / 400 / 500 / 600 / 700` |
| `fs-6..1` | `font-size`: `1rem / 1.25rem / 1.5rem / 1.75rem / 2rem / 2.5rem` |
| `small` | `font-size: 0.875rem` |
| `rounded / rounded-1/2/3 / rounded-circle / rounded-pill` | `border-radius: 0.375rem / 0.25rem / 0.5rem / 1rem / 50% / 50rem` |
| `border / border-top/...` | `border[-*]: 1px solid var(--border-color)` — цвет сверяй с оригиналом, не гадай |
| `shadow-sm / shadow` | `box-shadow`: значение из Bootstrap (`0 .125rem .25rem rgba(0,0,0,.075)` / `0 .5rem 1rem rgba(0,0,0,.15)`) |
| `w-100 / h-100` | `width / height: 100%` |
| `text-truncate` | `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` |
| `visually-hidden` | полный набор правил visually-hidden, а не `display: none` |
| `btn / btn-primary / btn-outline-primary / btn-outline-secondary / btn-danger / btn-sm / btn-lg` | именной класс кнопки: цвета — из `index.css` (`.btn-primary` и др.) через токены; размеры — литерально (`padding`, `font-size`, `border-radius`) |
| `Card / Card.Body / Card.Header` | `section`/`div` с тем же `border / border-radius / background / padding` |
| `Form.Control / Form.Select / Form.Check` | нативный `input`/`select`/кастомный чекбокс по образцу `.topic-select-input` |
| `Modal` | `ForumModal` (обёртка; сам `ForumModal` мигрируется в спринте B) |
| `Badge` | именной класс бейджа с цветом по роли/состоянию через токены |
| `Table` | см. шаг 6 — таблицы не переводятся 1:1 |

Если класса нет в таблице — открой `bootstrap.min.css`, найди его правило и скопируй значения. Не подбирай «на глаз».

### Шаг 4. Вынеси в именной класс

- Один элемент — один именной класс в духе готовых модулей (`forum-view.css`, `topic-row.css`, `author-meta.css`): `.members-search-input`, `.notification-item`, `.dm-message-content`. Не `.item1`, не `.custom-1`.
- Все значения — литерально из шага 3. Не округляй, не «улучшай».
- Специфичность — плоская: один-два класса, `(0,1,0)`–`(0,2,0)`. Без `!important` в нативных модулях — никогда, даже в медиа-запросах (каскад решается порядком правил, см. журнал).
- Состояния — модификаторами: `.is-active`, `.is-unread`, `.is-read`, `.is-managing`, `.is-editing`. Состояние — это класс, а не новый элемент.
- JSX-структуру не меняй без нужды. Теги меняются только если этого требует концепт: `<table>` → grid-разметка (шаг 6), `Card` → `section`/`article`, `Button` → `<button class="...">`. Поведение (обработчики, state, API) не трогается вообще.
- Класс, который уже используется в JS (`document.querySelector`, `getElementById`) или в другом CSS, — не удаляй и не переименовывай молча. Добавь новый рядом, старый убери только когда убедился, что его никто не ищет.
- Новый CSS — в модуль своей страницы (`src/styles/*.css`), а не в `src/index.css`. В `index.css` новые семантические правила не добавляются.

### Шаг 5. Цвета — через токены, и сверь все три темы

- Каждый цвет в новом классе — через токен (`var(--...)`). Hex напрямую в правиле — нельзя (кроме случаев, где hex — само значение токена).
- Новый токен — только цвет. Паддинги, размеры, радиусы, тени, шрифты — литералами в классе, не токенами. Существующие геометрические токены заморожены: новые не создавать.
- Токены живут на `body`, не на `:root` (алиасы на `:root` запекаются в светлые значения — см. журнал, «Фикс тёмной темы Категории»). Дефолт — в `body { ... }` в `theme-variables.css`, переопределения — в `body[data-theme='dark'/'light'/'neutral']`.
- Сверь каждый цвет в трёх темах: значение в `light` — дефолт, в `dark` и `neutral` — переопределение. Оригинал — в `index.css` (`:root` и `[data-theme]`-блоки) и в Bootstrap-правилах. Если в одной теме цвет «поплыл» — ищи, какой токен не переопределён, а не добавляй локальный hex.
- Проверь состояния: `hover`, `focus`, `disabled`, `active` — у каждого цвета есть своё значение в оригинале, и оно тоже переезжает в токен/класс.

### Шаг 6. Таблицы — в гриды, а не 1:1

- `<table>`/`<Table>` для раскладки — не переводится класс-в-класс. Она заменяется grid-разметкой по образцу `forum-index.css` / `forum-view.css` / `topic-row.css`:
  - колонки таблицы → `grid-template-columns` с теми же ширинами (фиксированные колонки — фиксированными значениями, как чекбокс-колонка 32px);
  - `thead` → полоса заголовков колонок в духе `.category-subtitle` (тот же дизайн — цветная полоса, small-caps);
  - состояние редактирования строки (`table-active` и подобные) → state-класс, например `.is-editing`;
  - на ≤768px таблица не скроллится горизонтально — она перестраивается в карточки (каждая строка — карточка, подписи полей — через `data-label` или отдельные лейблы).
- Исключение — единственное: `[table]` в BBCode — это контент пользователя, а не раскладка. Там `<table>` остаётся, а инлайн-стили ячеек переводятся на CSS-переменные (см. спринт G).

### Шаг 7. Адаптив — три ширины, без «потом»

- Проверяй каждую мигрированную страницу на трёх ширинах: десктоп (>993px), планшет (≤993px), мобильный (≤768px).
- Что прячется на мобиле — `display: none` в мобильном блоке того же файла (пример: `.category-subtitle` на ≤768px). Что перестраивается — grid → одна колонка; что становится чипом — как чекбокс manage-режима в правом верхнем углу карточки.
- Длинные строки (ники, названия тем, даты) — `overflow-wrap: anywhere` + `min-width: 0` у flex-детей, иначе текст выдавит карточку. Цифры и счётчики — `white-space: nowrap`.
- Media-блоки — ПОСЛЕ базовых правил в том же файле (та же специфичность — решает порядок).
- Сетки на ≤993px сужаются согласованно (образец: счётчики 100px→80px, первая колонка 260px→220px, чекбокс-колонка остаётся 32px).

### Шаг 8. Проверка компонента — что значит «готово»

После каждого компонента, до перехода к следующему:

1. `npm run build` — обязательно, exit 0.
2. `npm test` — цепочка до конца. Если падает проверка, которой не было в списке известных падений (см. «Как продолжать»), — это твоё, чини. Падение в уже известном месте — не твоё, зафиксируй в отчёте.
3. `grep` по изменённым файлам: не осталось `style={{`, Bootstrap-утилит из шага 3 и `react-bootstrap`-импорта (если спринт требует их убрать).
4. `git diff --stat` — только файлы этого компонента (+ его CSS-модуль, + токены, если добавлял). Соседние файлы в diff — признак, что ты взял лишнего.
5. Отчёт (коротко): что сделано, по каким правилам сверялся, что не проверено глазами. Визуальная сверка глазами — за Алиной после аудита, не за тобой.

Компонент НЕ готов, если: build красный; остался инлайн/Bootstrap там, где спринт требует убрать; цвет в одной из тем «поплыл»; на мобиле что-то вылезает за карточку; diff задел соседний компонент.

### Шаг 9. Ловушки — прочитай до начала работы

- **`.post-content a` подчёркивает всё.** Правило `.post-content a { text-decoration: underline }` бьёт и по ссылкам в тексте поста, и по любым `<a>` внутри редактора (см. баг с overflow-меню BBCode, починен в `2e574979`). Элементы внутри `.post-content`, которые не ссылки, — только скоупленными селекторами, без ослабления глобального правила.
- **React-bootstrap рендерит `<a>`.** `Dropdown.Item`, `Nav.Link`, `Pagination.Item` по умолчанию — это `<a>`. Проверяй, во что рендерится компонент, прежде чем стилизовать его как кнопку.
- **Глобальные `a` в `index.css`.** `a { text-decoration: none }` и `a:hover` действуют на всё. Новый класс ссылки должен явно задавать своё `text-decoration` и `color`, иначе его перебьёт глобальное правило.
- **Порядок импортов в `main.jsx`.** Модуль, импортированный позже, выигрывает при равной специфичности. Новый CSS — в конец списка компонентных импортов, если он должен перебивать дубликаты.
- **Токены на `body`.** См. шаг 5: `:root` запекает светлые значения.
- **Мёртвые импорты.** `ScrollButtons.jsx` импортировал `Button` из react-bootstrap и не использовал. После миграции проверяй `grep react-bootstrap` — пустой импорт тоже считается остатком.
- **Legacy-блок `.forum-table*` в `index.css`.** Закомментирован, но частично жив для немигрированных страниц. Не удаляй и не раскомментируй без отдельного аудита.
- **Чекбокс-колонка — 32px + 10px gap.** Константа, см. журнал. Не «резиновая».
- **Мини-пагинация — общий компонент.** `TopicMiniPagination` один на всех; не изобретай вторую.
- **Маски и аватары.** `ForumAuthorAvatar` / маски рендерятся в нескольких местах; меняешь класс — проверь все места.

---
## Спринты: порядок и шаги

> Цифры в скобках — остаток на 2026-11-17 (инлайн `style={` / Bootstrap-утилиты + react-bootstrap-теги, по аудиту; инлайн перепроверены на HEAD `2e574979`). Админка пересчитана 2026-11-18 (HEAD `68bb9bc`) — цифры в Спринте H свежие, метод в подразделе «Пересчёт админки 2026-11-18». Утилиты для страниц авторизации — приближённые, перепроверь `grep` перед работой.
> Соответствие старой нумерации: Этап 1 (главная+каркас) — готов, кроме хвоста (спринт B). Этап 2 (категория+списки) — готов. Этап 3 (топик) — готов, кроме хвоста (спринт A). Этап 4 Members — спринт C. Этап 5 Profile — спринт I (последним). Этап 6 списки — готовы. Этап 7 (уведомления/сообщения/auth/админка + снятие Bootstrap) — спринты D, E, F, H, J.

### Спринт A — Хвост Этапа 3: редактор топика

Файлы: `src/components/topic/TopicReplyComposer.jsx` (5 / 89), `src/components/topic/PostInlineEditor.jsx` (1 / 40), `src/components/topic/TopicModalsContainer.jsx` (1 / 61). Плюс сведение строк категории и пагинации (ниже).
SPEC: `markdowns/SPEC_forum-topic-view-theme-dom.md`. Контракты `.topic-reply*` / `.topic-post-editor*` уже готовы в CSS.

Шаги — строго по одному:
1. **TopicReplyComposer** — редактор ответа под постом: инлайн и утилиты в именные классы; тулбар и кнопки — по шагу 3 плейбука. Сам `RichEditor` внутри не трогать (спринт G).
2. **PostInlineEditor** — редактор внутри `.post-content`. Ловушка: overflow-меню и mask-picker внутри поста (см. шаг 9 плейбука — баг уже починен, не сломай его своими правилами).
3. **TopicModalsContainer** — модалки топика на `ForumModal` (сам `ForumModal` мигрируется в спринте B — здесь только замена вызовов).
4. **Сведение строк категории к одному `TopicRow`.** `CategoryPage.jsx:344` рендерит строки топиков инлайн как `.forum-item--topic`, а `TopicRow.jsx` (`.topic-item`) — эталон (см. карту повторяющихся элементов). Переведи `CategoryPage` на `TopicRow`, скелетон `:250` — тоже. Комментарий `:387` «same as the TopicRow reference render» после сведения удалить вместе с дублем.
5. **Пагинация категории.** `<nav id="forum-pagination-bottom" class="forum-view-pagination">` → `ForumPagination className="forum-pagination-view"` (модификатор уже есть, см. карту).

Критерий готовности: в трёх файлах — 0 `style={{`, 0 `react-bootstrap`; строки категории — один компонент; `npm run build` + `npm test` без новых падений.

### Спринт B — Хвост Этапа 1: общие атомы

Порядок внутри спринта — сверху вниз, не перемешивать:
1. **ForumPagination.jsx** — react-bootstrap `Pagination` (6 тегов) → нативные `button`/`a` с `.forum-pagination` (CSS уже есть в `forum-pagination.css`). Модификаторы `.forum-pagination-view` / `.forum-pagination-topic` не трогать — это только расположение.
2. **ForumBreadcrumbs.jsx** — react-bootstrap `Breadcrumb` (3 тега) → `nav` + `ol`/`li` с `.forum-breadcrumbs` (CSS уже есть). Модификатор `--topic` — только расположение.
3. **Layout.jsx** — `Container` (2 тега) + 5 утилит (`small`, `fw-medium`, `py-2`, `text-center`, `mb-0`) → семантические `div`.
4. **ForumRoleBadge / ForumCharacterBadge / ForumAuthorAvatar** — `Badge` / `Image` (1–4 тега) → `span`/`img` с классами; цвета ролей — через токены.
5. **ForumTabs.jsx** — 3 утилиты → класс.
6. **ForumEmptyState.jsx** — Bootstrap `Card` → `section` с классом. Используется на 8 страницах — проверь все места вызова.
7. **ForumModal.jsx** — обёртка над react-bootstrap `Modal` (9 тегов) → нативный `<dialog>` или `div`-модалка с тем же видом (оверлей, центрирование, закрытие по Esc и клику вне). Проверь все вызовы (мобильное меню RichEditor, TopicModalsContainer).
8. **Navbar.jsx** (11 / 94) — самый большой атом, делать последним в спринте: status badge, индикатор, аватар 32px, плейсхолдеры `width: 16`, `cursor: pointer`; цвета ссылок — через токены `--nav-*`.
9. **ScrollButtons.jsx** — убрать мёртвый импорт `Button` из react-bootstrap (логики — 0 строк).

Критерий готовности: `grep -r "react-bootstrap" src/components/common src/components/layout` — 0; в `Navbar.jsx` — 0 `style={{`.

### Спринт C — MembersPage

Файл: `src/pages/MembersPage.jsx` (11 / 149, 1 таблица).
SPEC: `markdowns/SPEC_forum-and-members-theme-dom.md`, разделы 17–37 + мини-спецификация в приложении.

Шаги:
1. Фильтры (поиск / сортировка / направление) — `form` с именными классами (`.members-search-input`, `.members-sort-select`, ...).
2. Таблица участников → grid (`.member-item` как `article`, `data-user-id` / `data-group-id`, `.is-online` / `.is-offline`). Образец — шаг 6 плейбука.
3. Пагинация сверху/снизу — `ForumPagination`; breadcrumbs — `ForumBreadcrumbs`.
4. Мобильная версия — карточки, а не скролл.

Ловушки: `.members-table-*` в `index.css:507–566` живёт для этой страницы — переносить в модуль, а не удалять молча; `data-label` для мобильных подписей.

### Спринт D — NotificationsPage + DraftsPage + TopicFormPage (по одной)

1. **NotificationsPage.jsx** (13 / 218): табы `user`/`admin`; `.notification-item` + `.is-read` / `.is-unread` + `.notification-{type}`; mark-all-read / delete-all; пагинация. Мини-спецификация в приложении.
2. **DraftsPage.jsx** (3 / 91): карточки черновиков (Bootstrap `Card` → `section`; legacy `.forum-group-card` — проверить, прежде чем трогать). Поведение не трогать: Guest-автор никогда, маска сохраняется при публикации.
3. **TopicFormPage.jsx** (0 / 86): форма создания темы; `RichEditor` внутри — не трогать сам редактор (спринт G); submit/cancel.

### Спринт E — DirectMessages + MessagesPage

Файлы: `src/components/dm/DirectMessages.jsx` (33 / 169), `src/pages/MessagesPage.jsx` (0 / 10).
Мини-спецификация в приложении.

Шаги: `.dm-container`, режимы inbox/chat; список диалогов (`.is-active` / `.is-unread`, unread-badge); сообщения sent/received; ввод + отправка; мобильный переход sidebar↔chat.

### Спринт F — Auth + служебные страницы

Файлы: `src/pages/LoginPage.jsx` (1 / ~21), `src/pages/RegisterPage.jsx` (1 / ~17), `src/pages/PendingPage.jsx` (2 / ~16), `src/pages/BannedPage.jsx` (2 / ~13), `src/components/auth/LoginForm.jsx` (2 / ~51), `src/components/auth/RegisterForm.jsx` (2 / ~61).
Мини-спецификации в приложении.

Шаги: `.auth-card` / `.auth-form` / `.auth-field` / `.auth-submit` / `.auth-link`; white wall (`whitelistMode` + `maintenance-message`); `.system-page` / `.system-card` / `.system-title` / `.system-message` / `.system-actions`.

### Спринт G — BBCode + RichEditor (отдельный воркстрим)

Файлы: `src/components/common/BBCode.jsx` (28 / 92, 4 raw `<table>`), `src/components/common/RichEditor.jsx` (20 / 510, 1 таблица hotkeys).

Правило спринта: это рендер пользовательского контента, а не раскладка. Здесь нет 1:1-конверсии — менять только то, что не меняет вид постов.

Шаги:
1. `[table]` в BBCode: `<table>` остаётся (контент!), инлайн `tableStyle`/`tdStyle` — на CSS-переменные/санитизацию.
2. `[quote]` уже на токене `--quote-border-color`; инлайн-стиль цвета заголовка цитаты (`BBCode.jsx:694`, `style={{ color: 'var(--primary-color)' }}`) — в токен.
3. Таблица хоткеев в RichEditor → `<dl>`/grid (шаг 6 плейбука).
4. Overflow-меню (56 пунктов) — `<a>` против `as="button"`: решить, не сломав `.post-content a` (см. шаг 9). То же — для mask-picker.
5. Тулбар, кнопки форматирования, состояния disabled/active — по плейбуку.

### Спринт H — AdminPage (ПОСЛЕДНИМ)

Файлы: `src/pages/AdminPage.jsx` (52 / 701, 5 таблиц, 81 тег), `src/components/admin/DesignsTab.jsx` (0 / 67), `src/components/admin/EmailTemplatesSettings.jsx` (4 / 109), `src/components/modals/TransferRootModal.jsx` (0 / 43, модалка передачи рута, вызывается из админки).
SPEC: `markdowns/SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md` + мини-спецификация в приложении (целевой DOM — Спринт 12). Свежие цифры и метод пересчёта — подраздел «Пересчёт админки 2026-11-18».

Реорг ВЛИТ в `feature/theming` (HEAD `68bb9bc`, мерж `68bb9bc`). Ветка `feature/admin-reorg` больше не направление работы — сверяться не с чем, работать только здесь. Отчёт о том, что построено, — `markdowns/DONE_ADMIN_PAGE_REORGANIZATION.md`; структура и Этапы 2–4 — `markdowns/SPEC_REFACTOR_ADMIN_PAGE_ARCHITECTURE.md`.

Что уже готово (не трогать, не переделывать):
- Обёртка: двухколоночный лейаут `#admin-page.admin-dashboard-layout`, `AdminSidebar` (десктопный collapsible-сайдбар + мобильный Offcanvas), конфиг навигации (`src/config/adminNavigation.js`, `src/navigation/adminNavigationConfig.js`), тест `test:admin-nav-config`.
- Полноширинный лейаут: `Layout.jsx` — для `/admin` рендерит `.admin-main-fullwidth` + `.admin-viewport-wrapper`, футер скрыт (CP-1.1, проверено).
- Карточки: общая система `.admin-card` (`__header`/`__body`/`__footer`/`__title`, модификатор `--spacing`) в `src/components/admin/AdminSidebar.css` — на переменных темы (`var(--card-bg)` и т.д.), hex нет. Поверхности уже лежат внутри `.admin-card` — мигрировать содержимое, а не карточку. Вторую карточную систему не изобретать.
- `AdminSidebar.jsx`: 0 инлайн-стилей, 0 Bootstrap-утилит. Остались только 3 RB-тега (`Offcanvas`, `OverlayTrigger`, `Tooltip`) — их замена на свои компоненты входит в этот спринт, в конце, а не в начале.

Что осталось (этот спринт, по одному табу за раз):
- 5 таблиц `<Table hover responsive>` → гриды/карточки (шаг 6 плейбука): users, roles, category groups, categories (с инлайн-редактированием строк), audit log. `responsive` у `<Table>` — это горизонтальный скролл на мобильных, а не адаптив: цель — перестройка в карточки на ≤768px, без скролла таблицы. `table-active` у редактируемой строки → state-класс `.is-editing`. Audit log — только разметка таблицы; поведение (пагинация, обновление, детали) — отдельный документ `markdowns/SPEC_REFACTOR_AUDIT_LOGS.md`, до темизации таба.
- Табы по одному: users (массовое выделение чекбоксами — поведение сохранить), roles (редактор ролей), categories (группы + категории, инлайн-редактирование), audit log, settings, designs, email templates.
- `DesignsTab`: сетка дизайнов сейчас на Bootstrap `Row`/`Col`/`Card` (`Row className="g-4"`, `Col md={6} lg={4}`, `Card shadow-sm h-100`) → свой грид + `.admin-card`. Целевой DOM в приложении исправлен: `.design-card` там больше нет.
- `EmailTemplatesSettings`: формы шаблонов (`Card`/`Alert`/`Form` из react-bootstrap) → свои классы.
- Модалки админки (`TransferRootModal` и диалоги удаления/передачи из `AdminPage`) — в конце спринта, вместе с заменой `Offcanvas`/`Tooltip` в сайдбаре.

Ловушки (не сломать):
- Проверки authority в `AdminPage.jsx` (`canChangeRoleOf`, перепроверка цели при сохранении, `assignableRoles`) — это зеркало серверной матрицы из `admin_users.go`; при переписывании разметки редактора ролей логику не трогать, только классы. Тест `test:admin-role-authority` должен оставаться зелёным после каждого таба.
- `fetchAdminUsers` — вызовы чтения персонала оставить как есть (тест `test:forum-read-contract`).
- Табы переключаются через конфиг навигации (`adminNavigation.js`); не возвращать табы в `AdminPage` (старый `Nav` удалён реоргом).
- После каждого таба: `npm run build` + `npm test` + визуальная проверка таба (десктоп + ≤768px).

### Спринт I — ProfilePage (ПОСЛЕДНИМ)

Файлы: `src/pages/ProfilePage.jsx` (35 / 763, 1 таблица), `src/components/profile/SecurityTab.jsx` (3 / 171) — цифры по СТАРОМУ DOM.
SPEC: `markdowns/SPEC_REFACTOR_PROFILE_PAGE_ARCHITECTURE.md` — governing document for the new DOM. Мини-спецификация в приложении (Спринт 6) описывает старый DOM и переписывается после реорга.

Сначала — реорг профиля по SPEC (Preview + Edit Dashboard, диспетчер ~120 строк, табы по §5.2, атомарное сохранение по §5.3), потом — темизация по финальному DOM. Не темизировать старый DOM: табы overview / reputation / characters / posts / settings / security после реорга не существуют в прежнем виде (соответствие старых табов новым — §5.2 SPEC).

Полноширинный дашборд профиля — на общем механизме с админкой: классы `.admin-main-fullwidth` / `.admin-viewport-wrapper`, условие `isAdminRoute || isProfileEditDashboard` в `Layout.jsx`; новых full-width классов не заводить.

Темизация (по финальному DOM): предпросмотр — карточка + табы about / characters / reputation / posts; дашборд — сайдбар + атомарные карточки (account, characters, preferences, notifications, security, moderation). Reputation history → grid. Формы настроек: поведение сида по серверным значениям не трогать. Аватар — загрузка отдельным эндпоинтом (не смешивать с профилем).

### Спринт J — Снятие Bootstrap

Только когда `grep` даёт 0 по всем трём проверкам:

- `grep -r "react-bootstrap" src/` — 0;
- `grep -r "style={{" src/` — 0;
- Bootstrap-утилиты из шага 3 плейбука в `className` — 0.

Шаги:
1. Убрать `bootstrap.min.css` из `src/main.jsx`.
2. Убрать `bootstrap` и `react-bootstrap` из `package.json` (`package-lock.json` — пересобрать через `npm install` на машине Алины, не руками).
3. Прогон: `npm test` + `npm run build`; финальный чек-лист (раздел ниже).

---
## Зависимости между спринтами

```
Спринт A (хвост топика)
    ↓
Спринт B (общие атомы)
    ↓
Спринт C (Members)
    ↓
Спринт D (Notifications / Drafts / TopicForm)
    ↓
Спринт E (DM)
    ↓
Спринт F (Auth + служебные)
    ↓
Спринт G (BBCode / RichEditor — можно параллельно с C–F, не пересекается)
    ↓
Спринт H (Admin — реорг влит в feature/theming)
    ↓
Спринт I (Profile)
    ↓
Спринт J (снятие Bootstrap)
```

---
# 4. Спецификации по страницам — что уже есть

Существуют 3 подробные спецификации в `markdowns/`:

| Спецификация | Покрывает |
|-------------|----------|
| `SPEC_forum-index-theme-dom.md` | **Forum Index** — главная страница (`/`). Категории, форумы, статистика |
| `SPEC_forum-and-members-theme-dom.md` | **Forum View** — страница категории (`/category/:id`) + **Members View** — участники (`/members`) |
| `SPEC_forum-topic-view-theme-dom.md` | **Topic View** — просмотр темы (`/topic/:id`) |

Эти спецификации являются **основным источником истины** для DOM-контракта. Агент ОБЯЗАН прочитать соответствующую спецификацию перед началом работы над компонентом.

---

# 5. Спецификации по страницам — что нужно создать

Для страниц, **не** покрытых существующими спецификациями, агент должен следовать общим принципам из раздела 1 файла `SPEC_forum-index-theme-dom.md` и нижеприведённым мини-спецификациям в этом документе.

Страницы, для которых нужны DOM-спецификации (мини-спецификации приведены в приложении «Справочные мини-спецификации»):

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

---

## Справочные мини-спецификации (целевые DOM)

Целевые DOM из исходных спринтов 5–12. Рамка `isThemeable` в них — устаревшая: семантический DOM теперь всегда, веток нет. Имена классов — фактические, сверены с журналом; где мини-спецификация расходится с кодом, прав код и карта повторяющихся элементов в аудите.

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

> СТАТУС 2026-11-18: описывает СТАРЫЙ DOM (один экран, табы overview / reputation / characters / posts / settings). По `SPEC_REFACTOR_PROFILE_PAGE_ARCHITECTURE.md` страница перестраивается в два режима (Preview + Edit Dashboard) — после реорга этот раздел переписать под новый DOM; темизация (Спринт I) идёт по новому DOM, а не по этому. Цифра «1802 строки» тоже устарела (сейчас ~2228).

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

Навигация панели построена на полноэкранном дашборде с двухколоночным лейаутом (`admin-dashboard-layout`), адаптивным сайдбаром (`AdminSidebar`: десктопный collapsible-сайдбар + мобильный Offcanvas drawer) и семантическими BEM-классами.

Статус 2026-11-18 (реорг влит, HEAD `68bb9bc`): обёртка готова — сайдбар, навигация, full-width (`Layout.jsx`, CP-1.1), система `.admin-card`. Содержимое табов — ещё таблицы `<Table hover responsive>` (5 штук, 81 тег); целевые классы ниже (`.admin-user-item`, `.admin-category-item` и т.д.) пока НЕ существуют в коде — их создаёт этот спринт, не искать их в текущей разметке.

```html
<div id="admin-page" class="admin-dashboard-layout">
  <!-- Десктопный сайдбар (>=992px) -->
  <aside id="admin-sidebar" class="admin-sidebar [admin-sidebar--collapsed | admin-sidebar--expanded]">
    <div class="admin-sidebar__header">
      <button class="admin-sidebar__toggle-btn" aria-label="Toggle sidebar">...</button>
      <h2 class="admin-sidebar__title">...</h2>
    </div>
    <nav class="admin-sidebar__nav" aria-label="...">
      <div class="admin-sidebar__group [is-collapsed | is-open]" data-group="{groupId}">
        <button class="admin-sidebar__group-header" aria-expanded="[true|false]">
          <span class="admin-sidebar__group-title">
            <svg class="admin-sidebar__group-icon">...</svg>
            <span>...</span>
          </span>
          <svg class="admin-sidebar__group-chevron [admin-sidebar__group-chevron--collapsed]">...</svg>
        </button>
        <div class="admin-sidebar__group-items">
          <button class="admin-nav-item [admin-nav-item--active is-active]" data-tab="{tabPath}">
            <span class="admin-nav-item__icon"><svg>...</svg></span>
            <span class="admin-nav-item__label">...</span>
          </button>
        </div>
      </div>
    </nav>
  </aside>

  <!-- Мобильный Offcanvas drawer (<992px) -->
  <div class="offcanvas offcanvas-start admin-offcanvas">
    <div class="offcanvas-header admin-offcanvas__header">
      <div class="offcanvas-title admin-offcanvas__title">...</div>
      <button class="btn-close">...</button>
    </div>
    <div class="offcanvas-body admin-offcanvas__body">
      <nav class="admin-sidebar__nav">
        <!-- Та же структура групп и элементов .admin-sidebar__group -->
      </nav>
    </div>
  </div>

  <!-- Основная область контента -->
  <div class="admin-dashboard-content">
    <!-- Мобильная плашка переключения меню (<992px) -->
    <div class="admin-mobile-toggle-bar">
      <button class="admin-mobile-toggle-btn" aria-label="...">
        <svg class="admin-mobile-toggle-icon">...</svg>
        <span>...</span>
      </button>
      <span class="admin-mobile-toggle-current">...</span>
    </div>

    <div class="admin-dashboard-body">
      <nav id="admin-breadcrumbs" class="forum-breadcrumbs">...</nav>

      <!-- Active tab content -->

      <!-- Settings tab -->
      <div class="admin-settings-tab">...</div>

      <!-- Designs tab -->
      <div class="admin-designs-tab">
        <div class="admin-designs-settings">...</div>
        <div class="admin-designs-list">
          <div class="admin-card" data-design-id="{id}">
            <div class="admin-card__header">
              <div class="admin-card__title">...</div>
              <div class="admin-card__status">...</div>
            </div>
            <div class="admin-card__body">...</div>
            <div class="admin-card__footer">...</div>
          </div>
        </div>
      </div>

      <!-- Users tab -->
      <div class="admin-users-tab">
        <div class="admin-users-filters">...</div>
        <div class="admin-users-list">
          <div class="admin-user-item" data-user-id="{uid}">...</div>
        </div>
      </div>

      <!-- Roles tab -->
      <div class="admin-roles-tab">...</div>

      <!-- Categories tab -->
      <div class="admin-categories-tab">
        <div class="admin-category-groups">
          <div class="admin-category-group" data-group-id="{id}">...</div>
        </div>
        <div class="admin-categories-list">
          <div class="admin-category-item" data-category-id="{id}">...</div>
        </div>
      </div>

      <!-- Audit tab -->
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

---

## Финальный чек-лист (бывший спринт 15)

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

---

## Правила для агентов

> Этот раздел заменяет старые «Общие правила» (isThemeable-ветки, «сохранять Bootstrap-классы», «не запускать build») — те правила устарели и противоречат журналу.

### Что ДЕЛАТЬ

1. **Читать плейбук, спринт и SPEC** перед началом работы над компонентом.
2. **Один компонент за раз.** После него — `npm run build` + `npm test` + короткий отчёт.
3. **Семантический DOM всегда.** `id` на структурных контейнерах, `data-*` на сущностях (`data-topic-id`, `data-post-id`, `data-user-id`, `data-group-id`, `data-category-id`, `data-forum-id`), state — классами `.is-*` по реальным данным из модели.
4. **Значения — литерально из оригинала** (Bootstrap / `index.css`). Не округлять, не «улучшать».
5. **Цвета — через токены; новые токены — только цвета.** Геометрия — литералами в классе.
6. **Проверять три темы и три ширины** (десктоп / ≤993px / ≤768px).
7. **Если не можешь сверить вид — напиши в отчёте**, что не сверено. Не гадай.

### Что НЕ делать

1. **НЕ менять бизнес-логику** — ноль изменений в state management, API-вызовах, useEffect, обработчиках событий, маршрутизации.
2. **НЕ использовать `!important`** в нативных модулях (`src/styles/*.css`) — никогда, даже в медиа-запросах.
3. **НЕ переписывать файл целиком и НЕ брать два компонента за раз.**
4. **НЕ удалять классы/`id`, которые ищет JS или CSS**, без проверки.
5. **НЕ добавлять новые правила в `src/index.css`** и новые токены геометрии.
6. **НЕ запускать `firebase deploy`** и подобные команды. `npm run build` и `npm test` — можно и нужно.
7. **НЕ придумывать новые состояния/классы** без данных из модели.
8. **НЕ привязывать тему к тексту** — подписи и лейблы бывают на разных языках; тема стилизует по классу, не по тексту.
9. **НЕ рендерить пустые контейнеры** — нет данных, нет элемента.
