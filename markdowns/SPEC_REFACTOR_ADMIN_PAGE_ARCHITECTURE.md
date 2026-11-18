# Спецификация: Архитектурный рефакторинг панели администратора (Admin View Reorganization)

> **Статус:** Комплексная спецификация архитектуры и интерфейса  
> **Дата обновления:** 28 октября 2026 г.  
> **Корреляция:** Согласовано с [`ARCHIVED_SPRINT_PLAN_admin_reorg.md`] и [`SPEC_forum-and-members-theme-dom.md`]  
> **Целевые файлы:** `src/pages/AdminPage.jsx`, `src/components/layout/Layout.jsx`, `src/navigation/adminNavigationConfig.js`, `src/components/admin/*`

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
Сейчас в [`src/components/layout/Layout.jsx`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/src/components/layout/Layout.jsx) (строки 58–62) все страницы принудительно оборачиваются в фиксированный `<Container>`:
```jsx
<main className="py-2">
  <Container>
    {children}
  </Container>
</main>
```
Если изменить этот `<Container>` на `<Container fluid>` глобально — пострадает верстка всех остальных страниц форума. Если оставить как есть — админка будет сжата и не сможет реализовать дизайн со скриншота.

### Архитектурное решение
`Layout.jsx` расширяется поддержкой адаптивного контейнера на основе текущего пути роутера (`location.pathname`):

```jsx
// src/components/layout/Layout.jsx
const Layout = ({ children }) => {
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

  return (
    <>
      <ForumBackground />
      <div className={`app-wrapper ${isAdminRoute ? 'app-wrapper--admin' : ''}`}>
        <ConnectionStatusBanner />
        <Navigation />
        
        {/* Стандартные баннеры техобслуживания и верификации */}
        <EmailVerificationBanner />

        <main className={isAdminRoute ? "admin-main-fullwidth" : "py-2"}>
          {isAdminRoute ? (
            <div className="admin-viewport-wrapper">
              {children}
            </div>
          ) : (
            <Container>
              {children}
            </Container>
          )}
        </main>
      </div>
      {!isAdminRoute && <Footer />}
      <ScrollButtons />
    </>
  );
};
```

#### Почему это безопасно:
- Все публичные страницы (`/`, `/topic/:id`, `/category/:id`, `/profile/:id` и т.д.) продолжают рендериться внутри классического `<Container>`, их разметка не меняется ни на пиксель.
- Маршрут `/admin` получает класс `.admin-main-fullwidth` (100% ширины, нулевые внешние отступы), где монтируется двухколоночный дашборд.

---

## 3. Декларативная структура навигации (`adminNavigationConfig.js`)

Коррелируя с [`TODO_SPRINT_PLAN_admin_reorg.md`](file:///c:/Users/Alina/source/repos/SiJunma/aerun/markdowns/TODO_SPRINT_PLAN_admin_reorg.md), навигация выносится в строго типизированный декларативный конфиг:

```javascript
// src/navigation/adminNavigationConfig.js
import { PERMISSIONS } from '../constants/permissions.js';

export const ADMIN_NAV_GROUPS = [
  {
    id: 'userAndAccess',
    title: 'admin.nav.userAndAccess', // "User & Access" / "Пользователи и Доступ"
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
    id: 'system',
    title: 'admin.nav.system', // "System" / "Система"
    icon: 'Settings',
    children: [
      {
        id: 'settings',
        path: 'settings',
        title: 'admin.tabs.settings',
        icon: 'Sliders',
        anyOf: [PERMISSIONS.MANAGE_FORUM],
        // Атомарные подразделы настроек:
        subSections: [
          { id: 'general', title: 'admin.settings.sections.general' },
          { id: 'limits', title: 'admin.settings.sections.limits' },
          { id: 'features', title: 'admin.settings.sections.features' },
          { id: 'identity', title: 'admin.settings.sections.identity' },
          { id: 'email', title: 'admin.settings.sections.email' }
        ]
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

## 7. Пошаговый план внедрения (Action Plan)

### Этап 1: Подготовка полноэкранного лейаута и навигации (Без изменения логики)
1. Добавить поддержку `isAdminRoute` в `Layout.jsx` для разблокировки 100% ширины экрана на `/admin`.
2. Создать `src/navigation/adminNavigationConfig.js` с группами `USER & ACCESS`, `FORUM CONTENT`, `SYSTEM`.
3. Создать `src/components/admin/AdminSidebar.jsx` и стили `AdminSidebar.css` (сворачивание на десктопе, Offcanvas на мобилках, активный контур пунктов).
4. Заменить горизонтальные вкладки `<Nav variant="tabs">` в `AdminPage.jsx` на сайдбар, сохранив текущие `render*` функции.

### Этап 2: Вынос модальных окон
1. Вынести модальные окна `RoleEditModal`, `CategoryEditModal`, `CategoryGroupModal`, `UserRoleModal`, `AuditDetailsModal` в папку `components/admin/modals/`.
2. Устранить костыль `deleteUserPostsRef` в модалке удаления пользователя.

### Этап 3: Декомпозиция вкладок на компоненты
1. `RolesTab`: сверстать таблицу ролей в точности как на скриншоте (группированные бейджи прав, кнопка создания роли сверху).
2. `SettingsTab`: разделить на атомарные карточки с собственными кнопками сохранения.
3. `UsersTab`, `CategoriesTab`, `AuditTab`: вынести в отдельные папки.

### Этап 4: Подключение On-demand хуков и оптимизация
1. Реализовать хуки `useAdminSettings`, `useAdminUsers`, `useAdminRoles`, `useAdminCategories`, `useAdminAudit`.
2. Запускать подписки только при открытии соответствующей вкладки.
3. Провести верификацию и запуск автотестов (`npm test`).
