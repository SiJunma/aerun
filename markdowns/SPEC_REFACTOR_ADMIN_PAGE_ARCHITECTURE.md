# Спецификация: Архитектурный рефакторинг панели администратора (Admin View Reorganization)

> **Статус:** Комплексная спецификация архитектуры и интерфейса  
> **Дата обновления:** 18 ноября 2026 г.  
> **Корреляция:** Согласовано с [`DONE_ADMIN_PAGE_REORGANIZATION.md`] (отчёт о Этапе 1) и [`SPEC_forum-and-members-theme-dom.md`]. Темизация внутренностей вкладок — Спринт H в [`TODO_THEMEABLE_SPRINT_PLAN.md`]; реорганизация журнала аудита — [`SPEC_REFACTOR_AUDIT_LOGS.md`].  
> **Целевые файлы:** `src/pages/AdminPage.jsx`, `src/components/layout/Layout.jsx`, `src/config/adminNavigation.js`, `src/components/admin/*`

---

## 1. Концепция и визуальный лейаут (Design & UX Vision)

В отличие от стандартных публичных страниц форума (список тем, просмотр топика, профиль), которые центрируются внутри фиксированного контейнера (`<Container>` с ограничением по ширине), панель управления администратора строится по принципу **современного полноэкранного дашборда (Full-Width Fluid Dashboard)**.

### Референс интерфейса (по макету):
```text
+---------------------------------------------------------------------------------------------------------------+
| World of Aerun   Active Topics (6)   Subscriptions   Members   [Admin]                   (bell) (chat) (Avatar)|
+-------------------+-------------------------------------------------------------------------------------------+
| [=] Admin Dash    |  Role Permissions (RBAC)                                               [+ Create New Role]|
| +---------------+ |  +-------------------------------------------------------------------------------------+  |
| | USER & ACCESS v |  | Role Name        Permissions                                                Actions |  |
| |  o Users      | |  +-------------------------------------------------------------------------------------+  |
| | (o) Roles     | |  | [Admin]          ADMINISTRATIVE PERMISSIONS:                                [Edit]  |  |
| |               | |  |                  [Admin Access] [Approve] [Ban] [Change Roles] ...                  |  |
| | FORUM CONTENTv| |  |                  PROFILE EDITING:                                                   |  |
| |  o Categories | |  |                  [Edit Avatars] [Edit Signatures] ...                               |  |
| |  o Designs    | |  |                  CONTENT MANAGEMENT:                                                |  |
| |               | |  |                  [Close Topics] [Delete Posts] [Move Topics] ...                    |  |
| | SYSTEM      v | |  +-------------------------------------------------------------------------------------+  |
| |  o Settings   | |                                                                                           |
| |  o Audit Log  | |                                                                                           |
| +---------------+ |                                                                                           |
+-------------------+-------------------------------------------------------------------------------------------+
```

### Ключевые принципы организации:
1. **Полноширинный лейаут (Edge-to-Edge Fluid Layout):** Контент панели не зажат в узкий контейнер 1140px, а занимает всю полезную ширину экрана, предоставляя простор для широких матриц разрешений (RBAC), таблиц пользователей и логов аудита.
2. **Сворачиваемый вертикальный сайдбар (Collapsible Sidebar):**
   - Расположен слева. Имеет два состояния на десктопе: развернутый (ширина ~260–280px) и компактный (свернутый до иконок или скрываемый кнопкой `☰`).
   - На мобильных устройствах трансформируется в плавный выезжающий ящик (`Offcanvas Drawer`).
   - Навигация разделена на смысловые группы (`USER & ACCESS`, `FORUM CONTENT`, `SYSTEM`), раскрывающиеся аккордеоном.
3. **Атомарные поднастройки с собственными кнопками сохранения:**
   - Настройки системы больше не сваливаются в единую простыню из 30 полей.
   - Они разделены на атомарные логические карточки (Общие, Лимиты сообщений, Переключатели фичей, Идентичность и Брендинг, Почтовые шаблоны).
   - **Каждая карточка имеет собственную кнопку сохранения.** Это фундаментально решает проблему конкурентной перезаписи настроек.

---

## 2. Безопасная интеграция в глобальный лейаут (Zero-Regression)

### Проблема
Сейчас в `src/components/layout/Layout.jsx` все страницы принудительно оборачиваются в фиксированный `<Container>`:
```jsx
<main className="forum-main-content">
  <Container>
    {children}
  </Container>
</main>
```
Если изменить этот `<Container>` на `<Container fluid>` глобально — пострадает верстка всех остальных страниц форума. Если оставить как есть — админка будет сжата и не сможет реализовать дизайн со скриншота.

### Архитектурное решение
`Layout.jsx` расширяется поддержкой адаптивного контейнера на основе текущего пути роутера (`location.pathname`):

```jsx
// src/components/layout/Layout.jsx — только условная часть (баннеры, навигация, обёртки опущены)
const isAdminRoute = location.pathname.startsWith('/admin');

{isAdminRoute ? (
  <main className="admin-main-fullwidth">
    <div className="admin-viewport-wrapper">
      {children}
    </div>
  </main>
) : (
  <main className="forum-main-content">
    <Container>
      {children}
    </Container>
  </main>
)}
{!isAdminRoute && (
  <footer id="forum-about" className="forum-about footer-custom py-2 text-center">…</footer>
)}
```

Примечание: класс `.app-wrapper--admin` существует в `src/index.css`, но в `Layout.jsx` не применяется — мёртвое правило, убрать при следующем касании файла. Стили (фактические, `src/index.css`): `.admin-main-fullwidth { flex: 1 1 auto; width: 100%; padding: 0; display: flex; flex-direction: column; }`, `.admin-viewport-wrapper { width: 100%; flex: 1 1 auto; display: flex; flex-direction: column; }`.

#### Почему это безопасно:
- Все публичные страницы (`/`, `/topic/:id`, `/category/:id`, `/profile/:id` и т.д.) продолжают рендериться внутри классического `<Container>`, их разметка не меняется ни на пиксель.
- Маршрут `/admin` получает класс `.admin-main-fullwidth` (100% ширины, нулевые внешние отступы), где монтируется двухколоночный дашборд.

---

## 3. Декларативная структура навигации (`adminNavigation.js`)

Навигация вынесена в декларативный конфиг (план реорга — `markdowns/Archive/ARCHIVED_SPRINT_PLAN_admin_reorg.md`):

```javascript
// src/config/adminNavigation.js
import { PERMISSIONS } from '../constants/permissions.js';

export const ADMIN_NAV_GROUPS = [
  {
    id: 'userManagement',
    title: 'admin.nav.userManagement', // "User & Access" / "Пользователи и Доступ"
    icon: 'Users',
    children: [
      {
        id: 'users',
        path: 'users',
        title: 'admin.tabs.users',
        icon: 'User',
        anyOf: [
          PERMISSIONS.APPROVE_USERS,
          PERMISSIONS.BAN_USERS,
          PERMISSIONS.CHANGE_ROLES
        ]
      },
      {
        id: 'roles',
        path: 'roles',
        title: 'admin.tabs.roles',
        icon: 'Shield',
        anyOf: [PERMISSIONS.MANAGE_ROLES]
      }
    ]
  },
  {
    id: 'forumContent',
    title: 'admin.nav.forumContent', // "Forum Content" / "Контент Форума"
    icon: 'Layers',
    children: [
      {
        id: 'categories',
        path: 'categories',
        title: 'admin.tabs.categories',
        icon: 'FolderTree',
        anyOf: [PERMISSIONS.MANAGE_CATEGORIES]
      },
      {
        id: 'designs',
        path: 'designs',
        title: 'admin.tabs.designs',
        icon: 'Palette',
        anyOf: [PERMISSIONS.MANAGE_DESIGNS]
      }
    ]
  },
  {
    id: 'systemConfig',
    title: 'admin.nav.systemConfig', // "System" / "Система"
    icon: 'Settings',
    children: [
      {
        id: 'settings',
        path: 'settings',
        title: 'admin.tabs.settings',
        icon: 'Sliders',
        anyOf: [PERMISSIONS.MANAGE_FORUM]
        // Подразделы настроек (general, limits, features, identity, email) в конфиге отсутствуют — это работа CP-3.2 (SettingsTab), а не навигации. Ключи `admin.settings.sections.*` в словаре есть.
      },
      {
        id: 'audit',
        path: 'audit',
        title: 'admin.tabs.audit',
        icon: 'FileText',
        anyOf: [PERMISSIONS.VIEW_AUDIT_LOG]
      }
    ]
  }
];
```

---

## 4. Архитектура атомарных настроек: ликвидация Blind Overwrite

### Причина бага в текущем коде
В старом монолите кнопка «Сохранить» была одна на всю страницу настроек и отправляла весь объект `settings`:
```javascript
// Старый код — отправка ВСЕХ полей сразу
await updateGlobalSettings(settings, user.uid);
```
Если один модератор менял название форума, а второй одновременно менял статус техобслуживания — сохранение первого модератора тихо перезаписывало статус техобслуживания старыми данными.

### Новая концепция: Атомарные карточки настроек
Каждая смысловая группа настроек выделяется в самостоятельный компонент со своим локальным стейтом и **собственной кнопкой «Сохранить»**:

```text
src/components/admin/tabs/SettingsTab/
├── SettingsTab.jsx                 # Главный контейнер настроек с внутренней навигацией
├── GeneralSettingsCard.jsx         # Название форума, язык, приветственное сообщение -> PATCH { forumName, welcomeMessage }
├── LimitsSettingsCard.jsx          # Лимиты символов, постов, тем -> PATCH { maxCharsPerPost, postsPerPage, ... }
├── FeatureTogglesCard.jsx          # Дайсы, репутация, маски, whitelist -> PATCH { enableDice, enableReputation, ... }
├── IdentityAssetsCard.jsx          # Логотип, дефолтные аватары, фоны -> Загрузка файлов и PATCH URL
└── EmailTemplatesSettings.jsx      # Шаблоны писем (уже существует)
```

Каждая карточка сохраняет **только свою часть настроек**:
```javascript
// Пример атомарного сохранения в LimitsSettingsCard.jsx
const handleSaveLimits = async (limitsData) => {
  setSaving(true);
  try {
    await updateGlobalSettingsPartial({
      maxCharsPerPost: limitsData.maxCharsPerPost,
      postsPerPage: limitsData.postsPerPage,
      topicsPerPage: limitsData.topicsPerPage,
      maxPostsPerTopic: limitsData.maxPostsPerTopic,
      maxCharactersPerUser: limitsData.maxCharactersPerUser
    });
    showToast(t('admin.settings.limits_saved'), 'success');
  } finally {
    setSaving(false);
  }
};
```
Это гарантирует, что изменение лимитов никогда не затрет изменения брендинга или флагов техобслуживания, сделанные параллельно.

---

## 5. Полная структура модулей и компонентов To-Be

```text
src/
├── navigation/
│   └── adminNavigationConfig.js       # Декларативная карта навигации с проверкой RBAC
│
├── components/admin/
│   ├── AdminSidebar.jsx               # Сайдбар (аккордеоны групп, кнопка [=], Offcanvas)
│   ├── AdminSidebar.css               # Стили для полноширинного дашборда и сайдбара
│   │
│   ├── tabs/
│   │   ├── SettingsTab/               # Атомарные настройки
│   │   │   ├── SettingsTab.jsx
│   │   │   ├── GeneralSettingsCard.jsx
│   │   │   ├── LimitsSettingsCard.jsx
│   │   │   ├── FeatureTogglesCard.jsx
│   │   │   ├── IdentityAssetsCard.jsx
│   │   │   └── EmailTemplatesSettings.jsx
│   │   │
│   │   ├── UsersTab/                  # Пользователи и модерация
│   │   │   ├── UsersTab.jsx
│   │   │   ├── UsersTable.jsx
│   │   │   ├── UsersSearchBar.jsx
│   │   │   └── RootTransferCard.jsx
│   │   │
│   │   ├── RolesTab/                  # Управление ролями (RBAC)
│   │   │   ├── RolesTab.jsx
│   │   │   ├── RolesTable.jsx
│   │   │   └── RolePermissionsPills.jsx (Бейджи прав как на скриншоте)
│   │   │
│   │   ├── CategoriesTab/             # Категории форума
│   │   │   ├── CategoriesTab.jsx
│   │   │   ├── CategoryTreeTable.jsx
│   │   │   └── CategoryPermBadge.jsx
│   │   │
│   │   ├── DesignsTab.jsx             # Вкладка тем оформления
│   │   └── AuditTab/                  # Журнал аудита с серверной пагинацией
│   │       ├── AuditTab.jsx
│   │       ├── AuditFiltersBar.jsx
│   │       └── AuditTable.jsx
│   │
│   └── modals/                        # Изолированные модальные окна
│       ├── RoleEditModal.jsx          # Создание/редактирование роли (матрица прав)
│       ├── CategoryEditModal.jsx      # Категория (двуязычность + переопределения)
│       ├── CategoryGroupModal.jsx     # Группа категорий
│       ├── UserRoleModal.jsx          # Модалка назначения роли
│       ├── AuditDetailsModal.jsx      # Raw details лога
│       ├── BlockedDeleteModal.jsx     # Блокировка удаления заполненной группы
│       └── TransferRootModal.jsx      # Передача роли главного администратора
│
├── hooks/admin/
│   ├── useAdminSettings.js            # Атомарный PATCH настроек и подписка
│   ├── useAdminUsers.js               # On-demand загрузка staff-юзеров
│   ├── useAdminRoles.js               # Синхронизация ролей и матрицы прав
│   ├── useAdminCategories.js          # Категории и группы
│   └── useAdminAudit.js               # Серверная пагинация и фильтры аудита
│
└── pages/
    └── AdminPage.jsx                  # Тонкий координатор лейаута (~120 строк)
```

> **Журнал аудита — отдельный документ.** Поведение логов (серверная пагинация, обновление, фильтры, структурированные детали по типам действий) описано в `markdowns/SPEC_REFACTOR_AUDIT_LOGS.md`. Здесь — только структура: `AuditTab` (CP-3.5), `AuditDetailsModal` (CP-2.4), хук `useAdminAudit` (CP-4.1). Порядок: сначала поведение по новому документу, потом декомпозиция вкладки и темизация по Спринту H.

---

## 6. Детализация компонентов по референсу со скриншота

### 6.1. Сворачиваемый сайдбар `AdminSidebar.jsx`
- Верхняя плашка: иконка меню `☰` + заголовок `Admin Dashboard`.
- Клик по `☰` на десктопе переключает состояние:
  - `expanded` (ширина 260px, видны названия групп и подпунктов).
  - `collapsed` (ширина 68px, видны только иконки групп, всплывающие тултипы при наведении).
- Список пунктов:
  - Активный пункт (например, `Roles`) выделяется голубым/акцентным скругленным контуром (`border: 1.5px solid var(--primary-color)`), как показано на скриншоте.
  - Каждая группа имеет шеврон `v`, позволяющий сворачивать ненужные разделы.

### 6.2. Вкладка ролей `RolesTab.jsx` и компонент `RolePermissionsPills.jsx`
- Верхний бар: слева заголовок раздела `Role Permissions (RBAC)`, справа кнопка `+ Create New Role` (темная скругленная кнопка-пилюля).
- Таблица ролей:
  - Темная шапка: `Role Name`, `Permissions`, `Actions`.
  - В строке роли: слева бейдж роли (например, розовый бейдж `Admin`), в центре — сгруппированные списки бейджей прав:
    - `ADMINISTRATIVE PERMISSIONS:` бейджики `Admin Panel Access`, `Approve Users`, `Ban Users`...
    - `PROFILE EDITING:` бейджики `Edit Others' Avatars`, `Edit Own Nickname`...
    - `CONTENT MANAGEMENT:` бейджики `Close/Open Topics`, `Delete Others' Posts`...
  - Справа — кнопка действия `Edit` / `Delete`.

---

## 7. Чекпоинты реализации и журнал прогресса (Checkpoints & Progress Tracker)

> [!IMPORTANT]
> **Памятка для агентов при переключении контекста:**  
> Всегда проверяйте статус текущего чекпоинта ниже перед началом работы. Если предыдущий чекпоинт помечен как `[x] Завершено`, переходите к следующему `[>] В процессе`. После завершения шага обязательно обновите статус, запишите выполненные действия в «Журнал чекпоинтов» и запустите `npm test`!

### Матрица статусов чекпоинтов

| ID | Чекпоинт | Этап | Статус | Целевые файлы | Проверка |
|---|---|---|---|---|---|
| **CP-1.1** | Адаптация `Layout.jsx` для `/admin` (флюидная ширина, скрытие футера) | Этап 1 | `[x] Завершено` | `src/components/layout/Layout.jsx`, `src/index.css` | `npm test` |
| **CP-1.2** | Декларативный конфиг навигации `adminNavigation.js` и переводы | Этап 1 | `[x] Завершено` | `src/config/adminNavigation.js`, `src/i18n/dictionary.js` | `npm test` |
| **CP-1.3** | Компонент `AdminSidebar.jsx` и стили `AdminSidebar.css` | Этап 1 | `[x] Завершено` | `src/components/admin/AdminSidebar.jsx`, `AdminSidebar.css` | `npm test` |
| **CP-1.4** | Интеграция сайдбара в `AdminPage.jsx` вместо горизонтальных вкладок | Этап 1 | `[x] Завершено` | `src/pages/AdminPage.jsx` | `npm test` |
| **CP-1.5** | Верификация Этапа 1 (адаптивность, навигация, отсутствие регрессий) | Этап 1 | `[x] Завершено` | Все затронутые файлы | `npm test`, `npm run build` |
| **CP-2.1** | Вынос `RoleEditModal.jsx` | Этап 2 | `[ ] Ожидает` | `src/components/admin/modals/RoleEditModal.jsx` | `npm test` |
| **CP-2.2** | Вынос `CategoryEditModal.jsx` и `CategoryGroupModal.jsx` | Этап 2 | `[ ] Ожидает` | `src/components/admin/modals/*` | `npm test` |
| **CP-2.3** | Вынос `UserRoleModal.jsx` и `TransferRootModal.jsx` | Этап 2 | `[ ] Ожидает` | `src/components/admin/modals/*` | `npm test` |
| **CP-2.4** | Вынос `AuditDetailsModal.jsx` и `BlockedDeleteModal.jsx` | Этап 2 | `[ ] Ожидает` | `src/components/admin/modals/*` | `npm test` |
| **CP-2.5** | Устранение `deleteUserPostsRef` в модалке удаления юзера | Этап 2 | `[ ] Ожидает` | `src/pages/AdminPage.jsx`, модалки | `npm test` |
| **CP-2.6** | Верификация Этапа 2 | Этап 2 | `[ ] Ожидает` | Все модальные компоненты | `npm test` |
| **CP-3.1** | `RolesTab`: таблица ролей по макету (группированные бейджи прав) | Этап 3 | `[ ] Ожидает` | `src/components/admin/tabs/RolesTab/*` | `npm test` |
| **CP-3.2** | `SettingsTab`: атомарные карточки с отдельными кнопками сохранения | Этап 3 | `[ ] Ожидает` | `src/components/admin/tabs/SettingsTab/*` | `npm test` |
| **CP-3.3** | `UsersTab`: декомпозиция вкладки пользователей | Этап 3 | `[ ] Ожидает` | `src/components/admin/tabs/UsersTab/*` | `npm test` |
| **CP-3.4** | `CategoriesTab`: декомпозиция категорий и групп | Этап 3 | `[ ] Ожидает` | `src/components/admin/tabs/CategoriesTab/*` | `npm test` |
| **CP-3.5** | `AuditTab`: декомпозиция журнала аудита | Этап 3 | `[ ] Ожидает` | `src/components/admin/tabs/AuditTab/*` | `npm test` |
| **CP-3.6** | Верификация Этапа 3 | Этап 3 | `[ ] Ожидает` | Все вкладки | `npm test`, `npm run build` |
| **CP-4.1** | Создание набора хуков `src/hooks/admin/` | Этап 4 | `[ ] Ожидает` | `src/hooks/admin/*` | `npm test` |
| **CP-4.2** | Подключение On-demand подписок по активной вкладке | Этап 4 | `[ ] Ожидает` | Хуки, вкладки | `npm test` |
| **CP-4.3** | Финальный рефакторинг координатора `AdminPage.jsx` (~120-150 строк) | Этап 4 | `[ ] Ожидает` | `src/pages/AdminPage.jsx` | `npm test` |
| **CP-4.4** | Итоговая верификация и регрессионный прогон | Этап 4 | `[ ] Ожидает` | Полный проект | `npm test`, `npm run build` |

---

## 8. Журнал выполнения чекпоинтов (Handoff Log)

*(Заполняется агентом по мере выполнения каждого чекпоинта)*

### Текущий статус: Этап 1 успешно завершен. Готов к CP-2.1 (Этап 2: Вынос модальных окон)
- **Активный этап:** Этап 2 — Вынос модальных окон
- **Следующий чекпоинт:** CP-2.1 (`RoleEditModal.jsx`)
- **Текущее состояние кодовой базы:**
  - Полноширинный флюидный лейаут `/admin` активен.
  - Сайдбар с группами `USER & ACCESS`, `FORUM CONTENT`, `SYSTEM` и иконками Lucide работает на десктопе (collapsible 260px/68px) и мобильных (Offcanvas drawer).
  - Горизонтальные вкладки `<Nav variant="tabs">` заменены на сайдбар, переключение вкладок через URL searchParams (`?tab=...`) сохранено без поломок.
  - Тесты `npm test` (88 OK, exit 0; lint 0 ошибок, 15 предсуществующих предупреждений) и сборка `npm run build` зеленые. Этап 1 влит в `feature/theming` (`68bb9bc`, 2026-11-17); `feature/admin-reorg` — страховка до вливания темизации в `main`.

#### Завершенные чекпоинты:
- **CP-1.1: Адаптация `Layout.jsx` для `/admin`:**
  - Дата: 11 ноября 2026 г. (помечено готовым); фактически изменение `Layout.jsx` потерялось при мерже в `feature/theming` и было повторно применено 17 ноября 2026 г. (коммит `eafacd5` на `feature/admin-reorg`, проверено до мержа `68bb9bc`). Отметка от 11 ноября опережала реальность — исправлено здесь 18 ноября 2026 г.
  - Изменения:
    - `src/components/layout/Layout.jsx`: добавлена проверка `isAdminRoute = location.pathname.startsWith('/admin')`, контейнер для админки заменен на полноширинный `<main className="admin-main-fullwidth"><div className="admin-viewport-wrapper">`, футер скрыт на `/admin`. Неадминские маршруты: `<main className="forum-main-content"><Container>` без изменений.
    - `src/index.css`: добавлены классы `.admin-main-fullwidth`, `.admin-viewport-wrapper` (и `.app-wrapper--admin`, который в `Layout.jsx` не применяется — мёртвое правило).
    - Проверка: `npm run lint:js` без ошибок, публичные страницы сохранили `<Container>` и футер.
- **CP-1.2: Декларативный конфиг навигации `adminNavigation.js` и переводы:**
  - Дата: 11 ноября 2026 г. (имена групп и хелперов в исходной записи неверны — исправлено 18 ноября 2026 г.)
  - Изменения:
    - `src/config/adminNavigation.js`: создан декларативный конфиг с группами `userManagement`, `forumContent`, `systemConfig`, привязкой иконок Lucide, прав доступа (`anyOf`) и вспомогательными функциями `filterNavByPermissions`, `findGroupForTab`, `collectVisibleTabPaths`. (Файл лежит в `src/config/`, а не в `src/navigation/`; TypeScript не используется — plain JS + JSDoc.)
    - `src/i18n/dictionary.js`: добавлены ключи для `admin.nav.*` и `admin.settings.sections.*` на английском и русском языках.
    - Проверка: `npm run lint:js` без ошибок.
- **CP-1.3: Компонент `AdminSidebar.jsx` и стили `AdminSidebar.css`:**
  - Дата: 11 ноября 2026 г.
  - Изменения:
    - Создан `src/components/admin/AdminSidebar.jsx`: поддержка десктопного режима сжатия (68px/260px), мобильного Offcanvas ящика, аккордеонов групп с запоминанием состояния, акцентных рамок активных пунктов.
    - Расширен `src/components/admin/AdminSidebar.css`: стили для темной и светлой темы с использованием переменных форума. Сайдбар зафиксирован (`position: sticky; top: 56px; height: calc(100vh - 56px)`), снабжен независимым скроллом нав-панели и не скроллится вместе со страницей.
    - Проверка: `npm run lint:js` без ошибок.
- **CP-1.4: Интеграция сайдбара в `AdminPage.jsx`:**
  - Дата: 11 ноября 2026 г.
  - Изменения:
    - `src/pages/AdminPage.jsx`: удалены устаревшие горизонтальные табы `<Nav variant="tabs">` и глобальный `<Container className="py-5">`, заменены на двухколоночный дашборд `.admin-dashboard-layout` со встроенным сайдбаром, мобильным тулбаром и контентной зоной.
    - Добавлены состояния `sidebarCollapsed` и `mobileSidebarOpen`.
    - Сохранены все вызовы `renderSettings()`, `<DesignsTab />`, `renderUsers()`, `renderRoles()`, `renderCategories()`, `renderAuditLog()`.
    - Проверка: AST-проверки `check-admin-empty-state.mjs`, `check-admin-form-validation.mjs`, `check-admin-role-authority.mjs` пройдены.
- **CP-1.5: Верификация Этапа 1:**
  - Дата: 11 ноября 2026 г.
  - Проверка: `npm run build` успешен (0 ошибок), полный прогон `npm test` успешен (88 OK, exit 0; lint 0 ошибок, 15 предсуществующих предупреждений).

---

## 9. Пошаговые инструкции по реализации (Action Plan Details)

### Этап 1: Подготовка полноэкранного лейаута и навигации (Без изменения логики)
1. **CP-1.1: `Layout.jsx` и CSS для `/admin`:**
   - В `src/components/layout/Layout.jsx`: определить `isAdminRoute = location.pathname.startsWith('/admin')`.
   - Если `isAdminRoute`: рендерить `<div className="admin-viewport-wrapper">{children}</div>` внутри `<main className="admin-main-fullwidth">`, скрыть `<footer className="footer-custom ...">`.
   - Если обычный маршрут: сохранить `<main className="forum-main-content"><Container>{children}</Container></main>` и футер.
   - Стили в `src/index.css`: `.admin-main-fullwidth { flex: 1 1 auto; width: 100%; padding: 0; display: flex; flex-direction: column; }`, `.admin-viewport-wrapper { width: 100%; flex: 1 1 auto; display: flex; flex-direction: column; }`.
2. **CP-1.2: Декларативный конфиг навигации `adminNavigation.js`:**
   - Создать `src/config/adminNavigation.js` со структурой групп `userManagement`, `forumContent`, `systemConfig` (plain JS + JSDoc, `anyOf` вместо одного `permission`, хелперы `filterNavByPermissions`, `findGroupForTab`, `collectVisibleTabPaths`).
   - Добавить ключи перевода в `src/i18n/dictionary.js` (`admin.nav.userManagement`, `admin.nav.forumContent`, `admin.nav.systemConfig`, `admin.settings.sections.*`).
3. **CP-1.3: Компонент сайдбара `AdminSidebar.jsx` и стили `AdminSidebar.css`:**
   - Поддержка двух состояний на десктопе: `expanded` (260px) и `collapsed` (68px), переключатель `☰`.
   - Мобильный режим: выезжающий `Offcanvas` (Bootstrap).
   - Стилизация активного пункта: акцентный скругленный контур `border: 1.5px solid var(--primary-color)`.
   - Шевроны раскрытия групп.
   - Фильтрация по правам — один раз, на странице (`filterNavByPermissions` в `AdminPage.jsx`); сайдбар только рендерит уже отфильтрованное дерево.
4. **CP-1.4: Интеграция сайдбара в `AdminPage.jsx`:**
   - Заменить горизонтальные `<Nav variant="tabs">` на двухколоночный контейнер: слева `AdminSidebar`, справа рабочая область.
   - Убрать локальный фиксированный `<Container className="py-5">` из `AdminPage.jsx`, сохранив внутренний `render*` контент.
5. **CP-1.5: Проверка и тестирование Этапа 1:**
   - Запуск `npm test`.
   - Проверка, что ни один другой роут (`/`, `/topic/*`, `/profile/*`) не изменился.

### Этап 2: Вынос модальных окон
1. **CP-2.1 - CP-2.4:**
   - Создать `src/components/admin/modals/`.
   - Вынести модалки в изолированные файлы, строго используя `ForumModal` (требование `scripts/check-no-raw-modal.mjs`).
   - Сохранять соответствие AST-проверкам `scripts/check-admin-form-validation.mjs` и `scripts/check-admin-role-authority.mjs`.
2. **CP-2.5: Устранение `deleteUserPostsRef`:**
   - Заменить императивный `ref` на декларативный стейт в форме удаления пользователя.
3. **CP-2.6: Проверка Этапа 2 (`npm test`).**

### Этап 3: Декомпозиция вкладок на компоненты
1. **CP-3.1:** `RolesTab` с рендером бейджей прав по группам как на скриншоте.
2. **CP-3.2:** `SettingsTab` с разделением на независимые карточки (устранение blind overwrite).
3. **CP-3.3 - CP-3.5:** Вынос `UsersTab`, `CategoriesTab`, `AuditTab`.
4. **CP-3.6: Проверка Этапа 3 (`npm test`, `npm run build`).**

### Этап 4: Подключение On-demand хуков и оптимизация
1. **CP-4.1:** Создание `src/hooks/admin/` (`useAdminSettings`, `useAdminUsers`, `useAdminRoles`, `useAdminCategories`, `useAdminAudit`).
2. **CP-4.2:** On-demand активация подписок и загрузки данных.
3. **CP-4.3 - CP-4.4:** Финализация `AdminPage.jsx`, запуск полного набора проверок.
