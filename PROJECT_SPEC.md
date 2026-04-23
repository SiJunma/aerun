# Aerun Forum — Техническая Спецификация Проекта

> Закрытый форум для персонального использования с друзьями, ориентированный на проведение текстовых ролевых игр (ТРПГ).
> Стек: **React + Bootstrap 5 + Firebase (Firestore, Auth, Storage, Cloud Functions)**

---

## 1. Концепция и общий контекст

Форум строится на классической иерархии **Категория → Тема → Сообщение** с расширенной системой «масок» (персонажей), механикой бросков кубиков, репутацией и гибкой системой прав. Доступ закрытый — только одобренные пользователи видят контент. Интерфейс двуязычный (RU / EN).

---

## 2. Архитектура базы данных (Firestore)

### 2.1 Коллекция `users`
```
{
  uid:                  string,          // Firebase Auth UID
  email:                string,          // скрыт от публичного доступа
  nickname:             string,          // отображаемое имя, редактируется юзером
  status_line:          string,          // слоган/статус под ником (свободный текст)
  avatar_url:           string,          // ссылка в Firebase Storage
  root_signature:       string,          // подпись «по умолчанию» для этого профиля
  role_id:              string,          // ref → коллекция roles
  status:               'pending' | 'active' | 'banned',
  reputation:           number,          // денормализованный итог
  post_count:           number,
  registered_at:        Timestamp,
  last_seen:            Timestamp,
  settings: {
    language:           'ru' | 'en',
    timezone:           string,          // IANA, напр. 'Europe/Moscow'
    appearance:        'light' | 'dark' | 'neutral',
    notifications: {
      new_pm:           { email: bool, in_app: bool },
      topic_reply:      { email: bool, in_app: bool },
      reputation_change:{ email: bool, in_app: bool },
      announcements:    { email: bool, in_app: bool }
    }
  }
}
```

### 2.2 Коллекция `roles`
```
{
  role_name:            string,          // 'admin', 'moderator', 'player', любое кастомное
  max_characters_limit: number,          // макс. кол-во масок для роли
  permissions: {
    can_edit_any_post:       bool,
    can_delete_any_post:     bool,
    can_approve_users:       bool,
    can_view_audit_log:      bool,
    can_view_hidden_categories: bool,
    can_see_hidden_dice:     bool,       // видеть результат скрытого броска
    can_edit_hero:           bool,
    can_post_announcements:  bool,
    can_edit_any_topic:      bool        // смена dice_enabled в чужой теме
  }
}
```

### 2.3 Коллекция `characters` (маски)
```
{
  owner_id:     string,       // ref → users
  name:         string,
  avatar_url:   string,       // Firebase Storage
  signature:    string | 'inherit' | '',
    // '' = нет подписи
    // 'inherit' = взять root_signature из профиля
    // иначе = собственная подпись маски
  created_at:   Timestamp
}
```

### 2.4 Коллекция `categories`
```
{
  title:         { ru: string, en: string },
  description:   { ru: string, en: string },
  order:         number,
  allowed_roles: string[],    // ID ролей, которые видят категорию
  topics_count:  number,      // денормализация
  posts_count:   number,      // денормализация
  last_post: {
    post_id:      string,
    topic_id:     string,
    topic_title:  string,
    author_name:  string,
    timestamp:    Timestamp
  }
}
```

### 2.5 Коллекция `topics`
```
{
  category_id:  string,
  title:        string,
  slogan:       string,       // короткий подзаголовок/теги (может быть пустым)
  author_id:    string,
  created_at:   Timestamp,
  dice_enabled: bool,         // разрешены ли кубики в этой теме
  first_post_pinned: bool,    // закрепить первое сообщение на всех страницах темы
  posts_count:  number,       // денормализация
  last_post: {
    post_id:    string,
    author_name:string,
    timestamp:  Timestamp
  }
}
```

### 2.6 Коллекция `posts`
```
{
  topic_id:         string,
  category_id:      string,
  author_id:        string,       // реальный UID
  display_name:     string,       // имя маски на момент отправки (заморожено)
  display_avatar:   string,       // аватар маски на момент отправки (заморожен)
  display_signature:string,       // подпись на момент отправки (заморожена)
  text:             string,       // HTML/Markdown (санитизированный)
  created_at:       Timestamp,
  edited_at:        Timestamp | null,
  reputation:       number,       // сумма лайков/дизлайков конкретно этого поста
  dice_data: {                    // null если кубик не бросался
    formula:    string,           // '2d10+5'
    result:     number,
    breakdown:  string,           // '[7, 4] + 5'
    is_hidden:  bool,             // скрытый бросок (виден только автору + can_see_hidden_dice)
    timestamp:  Timestamp
  } | null
}
```

### 2.7 Коллекция `reputation_logs`
```
{
  target_user_id: string,
  sender_user_id: string,
  post_id:        string,     // пост, за который дана репутация
  topic_id:       string,     // тема этого поста
  value:          +1 | -1,
  comment:        string,
  timestamp:      Timestamp
}
// Security Rules: allow create только; update и delete запрещены даже для admin
```

### 2.8 Коллекция `direct_messages` (ЛС)
```
// Диалог — отдельный документ, сообщения — подколлекция
conversations/{conv_id}: {
  participants: string[],     // [uid_a, uid_b]
  last_message: { text, timestamp, sender_id },
  unread_count: { [uid]: number }
}
conversations/{conv_id}/messages/{msg_id}: {
  sender_id: string,
  text:       string,
  created_at: Timestamp
}
```

### 2.9 Коллекция `audit_log`
```
{
  action:     string,   // 'USER_APPROVED', 'POST_DELETED', 'LOGIN_FAILED', 'ROLE_UPDATED', ...
  actor_id:   string,
  target_id:  string,
  details:    string | object,  // старые/новые значения
  ip:         string,           // при доступных событиях
  timestamp:  Timestamp
}
// Security Rules: append-only для всех; update/delete запрещены ВСЕМ (прозрачность)
```

### 2.10 Коллекция `invites`
```
{
  code:       string,   // уникальный ID документа
  created_by: string,
  used_by:    string | null,
  created_at: Timestamp,
  expires_at: Timestamp | null
}
```

### 2.11 Коллекция `announcements`
```
{
  title:      string,
  content:    string,   // Markdown
  author_id:  string,
  date:       Timestamp,
  is_pinned:  bool
}
```

### 2.12 Документ `site_config` (одиночный документ в коллекции `settings`)
```
{
  hero_content:      string,   // «сырой» HTML/CSS (только для admin)
  hero_button_text:  string,
  hero_button_link:  string,
  is_hero_active:    bool
}
```

### 2.13 Коллекция `notifications` (in-app)
```
{
  recipient_id: string,
  type:         'new_pm' | 'topic_reply' | 'reputation' | 'announcement',
  payload:      object,   // ссылки, имена, etc.
  is_read:      bool,
  created_at:   Timestamp
}
```

### 2.14 Техническая коллекция `mail` (Firebase Trigger Email)
```
{
  to:      string,    // email получателя
  message: { subject, html }
}
```

---

## 3. Иерархия и навигация

```
Главная (/)
  ├── Hero-блок (настраивается из Админки)
  ├── Объявления от Мастера (announcements)
  ├── Виджет «Свежие посты» (последние 5–10, real-time)
  ├── Таблица категорий (кол-во тем, кол-во постов, последнее сообщение)
  └── Список участников (Members Directory)

/category/:id       — список тем; слоган, счётчики, последний пост
/topic/:id          — лента сообщений с пагинацией; якоря #post_id
/profile/:uid       — публичный / приватный профиль
/admin              — Административная панель (role == 'admin')
/members            — Все активные участники
```

**Breadcrumbs** на каждой странице, переключаются по языку (RU/EN).

---

## 4. Система масок (Characters)

- Пользователь создаёт несколько «масок» — персонажей с именем и аватаром.
- **При создании и редактировании поста (или черновика)** выбирает маску из Dropdown.
- Данные маски (`display_name`, `display_avatar`, `display_signature`) **сохраняются в пост** в момент создания или обновления → история игры не изменяется при изменении настроек персонажа в будущем (замороженные данные), но автор может сменить саму маску поста при его редактировании.
- Лимит масок контролируется полем `roles.max_characters_limit`.
- Маски можно архивировать/удалять; старые посты не теряются.
- **Подпись маски**: три варианта — своя, `inherit` (берётся `root_signature` из Users), пусто.

---

## 5. Система репутации

- Под каждым постом кнопки **+** / **−** (открывают модальное окно с полем комментария).
- Запись попадает в `reputation_log` с `post_id` + `topic_id`.
- `users.reputation` обновляется атомарно (Firebase `increment`).
- `posts.reputation` — суммарный рейтинг конкретного поста (как лайки).
- **Ссылка «К посту»** из лога репутации → `/topic/:topic_id?post=post_id`.
- `reputation_logs` — **нельзя редактировать/удалять** напрямую (Firestore Rules), однако при удалении поста соответствующие записи лога очищаются транзакционно.
- В профиле: просмотр истории репутации (кто, за что, сколько, ссылка). 
---

## 6. Бросок кубиков (Dice Roller)

- Включается **per-topic**: поле `topics.dice_enabled` (чекбокс при создании/редактировании темы).
- Виджет в форме написания поста: выбор граней (`d4`, `d6`, `d10`, `d20`, `d100`) + модификатор.
- Результат **генерируется в момент отправки**, фиксируется в `posts.dice_data`.
- `dice_data` — **immutable**: Firestore Rules запрещают изменение этого поля при `update`.
- **Скрытый бросок** (`is_hidden: true`): результат виден только автору поста и ролям с `can_see_hidden_dice == true`. Остальные видят плашку «Скрытый бросок сделан».
- Визуально внутри поста — Bootstrap Alert/Badge с формулой, разбивкой и итогом.

---

## 7. Система доступа и ролей (RBAC)

### Статусы пользователя
- `pending` — зарегистрировался, ждёт одобрения → видит только страницу «На рассмотрении»
- `active` — доступ к форуму
- `banned` — заблокирован

### Регистрация и Whitelist
- После регистрации статус → `pending`.
- **Приглашение**: уникальная ссылка `/?invite=КОД` → сразу `active`.
- Без кода — ждёт одобрения в Админке.

### Роли
- Роли создаются и редактируются **из Админки** (конструктор с чекбоксами прав).
- Встроенные роли: `admin`, `moderator`, `player`. Можно добавлять кастомные (напр. «Мастер игры», «VIP-игрок»).
- Видимость категорий управляется полем `categories.allowed_roles[]`.

---

## 8. Страницы и функциональность

### 8.1 Главная (`/`)
- **Hero-блок**: сырой HTML/CSS из `site_config` (только admin). Поддержка кастомных тегов `<style>`. Управляется флагом `is_hero_active`.
- **Объявления** (`announcements`): Markdown, поддержка закреплённых (`is_pinned`).
- **Виджет «Свежие посты»**: last 5–10 постов со всего форума (real-time через `onSnapshot`). Каждый пункт: автор (маска), название темы, превью текста, время (в часовом поясе смотрящего).
- **Таблица категорий**: Название | Описание | Тем | Постов | Последнее сообщение.

### 8.2 Список тем (`/category/:id`)
- Bootstrap-таблица / карточки тем.
- Для каждой темы: Название, **слоган** (мелким текстом под заголовком), счётчик ответов, последнее сообщение.
- **Пагинация** (Firestore `startAfter` курсоры).

### 8.3 Тема (`/topic/:id`)
- Лента постов с **пагинацией** (предпочтительно — «следующая страница», для ТРПГ).
- При переходе из лога репутации — автоматически открывает нужную страницу, где находится `#post_id`, и прокручивает экран к якорю.
- Форма ответа:
  - Выбор маски (Dropdown `<CharacterSelect />`).
  - Текстовый редактор (с поддержкой Markdown/WYSIWYG — курсив, жирный и т.д.).
  - **Анимированные смайлы**: вставка через панель (шорткоды `[jcdragon...]`).
  - **Счётчик символов** в реальном времени.
  - **Автосохранение черновика** в SessionStorage/localStorage браузера; восстановление при возврате на страницу.
  - **Dice Roller** (`<DiceRoller />`) — видим только если `topic.dice_enabled == true`.

### 8.4 Профиль (`/profile/:uid`)
**Два режима**: «Свой» (с редактированием и ЛС) и «Чужой» (публичный).

**Header:**
- Аватар (загрузка через Firebase Storage).
- Никнейм + **статус-слоган** (свободная строка, редактируется юзером).
- Дата регистрации, суммарная репутация (бейдж).
- Кнопка «Написать ЛС» (в чужом профиле).
- Кнопка «Редактировать» (в своём).

**Вкладки (Bootstrap Tabs):**

| Вкладка | Содержимое | Видимость |
|---|---|---|
| Мои персонажи | Карточки масок с аватаром/подписью. Кнопки: создать, редактировать, удалить. Лимит = `role.max_characters_limit`. | Все |
| Репутация | Лог: оценка, от кого, комментарий, ссылка «К посту» | Все |
| Личные сообщения | Список диалогов + окно переписки | Только свой |
| Настройки & Активность | root_signature, appearance, language, timezone, настройки уведомлений, последние 5–10 постов | Только свой |

### 8.5 Список участников (`/members`)
- Таблица: Никнейм, Дата регистрации, Репутация, Кол-во постов.
- Email скрыт от публичного доступа.
- Кнопки: «Профиль», «Написать ЛС».
- Поиск по никнейму, **пагинация**.

### 8.6 Личные сообщения
- Список диалогов (левая колонка), окно переписки (правая).
- Поиск по сообщениям.
- **Бейдж непрочитанных** (красный индикатор в хедере / на вкладке).
- Кнопка «Написать» доступна из: списка участников, публичного профиля, под аватаром в любом посте.
- **Ограничения:** запрещено отправлять новые сообщения удаленным или забаненным пользователям (вместо формы выводится заглушка).
- **Удаление переписки:** пользователь может безвозвратно удалить переписку "для себя". Это скрывает все сообщения до текущего момента. При этом второй собеседник сохраняет всю историю. Если позже написать новое сообщение или получить ответ, переписка для первого пользователя откроется как пустая, начиная с последнего сообщения.


### 8.7 Административная панель (`/admin`)
> Доступно только пользователям с `role == 'admin'`

**Боковое меню:**

| Раздел | Функции |
|---|---|
| **Dashboard** | Статистика: новые юзеры, постов за день |
| **Пользователи** | Таблица с фильтром по статусу. Кнопки: «Одобрить», «Бан», «Сменить роль». Пагинация (10/50/100 на стр.) |
| **Заявки** | Список `pending` пользователей |
| **Роли** | Конструктор ролей: имя, `max_characters_limit`, матрица permissions (чекбоксы) |
| **Категории** | Создание/редактирование: название RU/EN, описание RU/EN, порядок, `allowed_roles[]` |
| **Объявления** | Создание/редактирование Markdown-объявлений, закрепление |
| **Hero-блок** | Редактор с предпросмотром (сырой HTML/CSS, кнопка, флаг `is_hero_active`) |
| **Инвайты** | Генерация пригласительных ссылок |
| **Журнал (Audit Log)** | Бесконечный список событий, поиск по дате/нику. Нельзя изменить/удалить. |
| **Репутация** | Просмотр всех логов (глобально) — для выявления накруток |

---

## 9. Система уведомлений

### Каналы
| Канал | Механизм |
|---|---|
| **Email** | Firebase Trigger Email Extension → SMTP (Gmail/SendGrid/Mailgun). Коллекция `mail`. Используется для: новых ЛС, одобрения аккаунта. Cloud Functions — для рассылки участникам темы при новом посте. |
| **In-App** | Real-time через `onSnapshot` на коллекцию `notifications`. «Колокольчик» в хедере. |
| **Push** | Firebase Cloud Messaging (FCM) — уведомления на телефон/ПК даже при закрытой вкладке |

### Настройки (per user)
```
settings.notifications:
  new_pm:            { email: bool, in_app: bool }
  topic_reply:       { email: bool, in_app: bool }
  reputation_change: { email: bool, in_app: bool }
  announcements:     { email: bool, in_app: bool }

### Логика обработки
- **Deep Links**: Все уведомления, ведущие к сообщениям, используют формат `/topic/:id?post=post_id`. Это инициирует фоновую службу `locatePost` для определения нужной страницы.
- **Lazy Cleanup**: При переходе на удаленный пост система автоматически помечает orphaned-уведомление как прочитанное и выводит информационный тоаст.
- **Smart Read Status**: Уведомления типа `post_quoted` (цитирование) помечаются как прочитанные только в момент попадания процитировавшего сообщения в viewport.
```

### Шаблоны писем
HTML-шаблоны (Handlebars) с логотипом форума, текстом события и ссылкой.

---

## 10. Темизация

| Тема | CSS key | Описание |
|---|---|---|
| `dark` | `data-theme="dark"` | Тёмный фон, светлый текст |
| `light` | `data-theme="light"` | Белый фон, тёмный текст |
| `neutral` | `data-theme="neutral"` | Бежевое/сепия — стиль старой бумаги |

- CSS Variables на уровне `<body data-theme="...">`.
- Выбор хранится в `users.settings.appearance` (никакого localStorage).
- Через React `useEffect` при загрузке применяется к `document.body`.
- Архитектура готова к добавлению новых тем в будущем.

---

## 11. Интернационализация (i18n)

- Словарь в JSON: `{ "ru": { "send": "Отправить", ... }, "en": { "send": "Send", ... } }`.
- Хранение выбранного языка: `users.settings.language` (не localStorage).
- Названия категорий в базе: `{ ru: string, en: string }` (мультиязычный объект).
- Посты игроков не переводятся, системные сообщения — локализованы.
- Breadcrumbs переключаются по языку.

---

## 12. Отображение времени

- Все `Timestamp` в Firestore хранятся в UTC.
- При рендеринге — конвертируются в часовой пояс из `users.settings.timezone` смотрящего.
- Библиотека: `date-fns-tz` или `Intl.DateTimeFormat`.

---

## 13. Пагинация

Применяется везде, где есть список:
- Посты в теме, Темы в категории, Список участников, Таблицы в Админке, Логи аудита, Лента «Свежие посты», История репутации.
- Механизм: Firestore `limit(N)` + `startAfter(lastDoc)`.
- В Админке — выбор: 10 / 50 / 100 элементов на страницу.
- **Навигация по Post ID**: Логика определяет нужную страницу через параметр `?post=ID`. Если пост не найден на текущей странице, вызывается API `locatePost`, который находит нужные `topicId` и `page`, после чего происходит автоматический редирект и скролл.

---

## 14. React-компоненты (ключевые)

| Компонент | Описание |
|---|---|
| `<AuthProvider />` | Контекст авторизации + профиль (language, appearance, timezone) |
| `<GatekeeperScreen />` | Проверяет `status`: pending → заглушка; banned → заглушка; active → форум |
| `<DiceRoller />` | Виджет броска кубика в форме поста |
| `<CharacterSelect />` | Dropdown выбора маски перед отправкой |
| `<Pagination />` | Универсальный компонент пагинации |
| `<Breadcrumbs />` | Навигационная цепочка с i18n |
| `<ReputationModal />` | Модалка «+/-» с полем комментария |
| `<NotificationBell />` | Колокольчик с real-time бейджем |
| `<MarkdownEditor />` | Редактор поста с счётчиком символов и автосохранением |
| `<SmilesPicker />` | Панель выбора анимированных смайлов |
| `<DiceDisplay />` | Блок отображения результата броска внутри поста |
| `<HeroBlock />` | Рендерит `hero_content` через `dangerouslySetInnerHTML` |

---

## 15. Безопасность (Firestore Security Rules — ключевые принципы)

| Правило | Назначение |
|---|---|
| Только `active` пользователи читают/пишут | Gatekeeper на уровне базы |
| `reputation_log` — только `create` | Нельзя изменить/удалить запись репутации |
| `audit_log` — только `create` | Нельзя «подчистить хвосты» |
| `posts.dice_data` — immutable при `update` | Нельзя «перебросить» кубик |
| `characters` — только owner_id | Нельзя редактировать чужих персонажей |
| `email` поле в `users` — только admin + owner | Email скрыт от всех остальных |
| `hero_content` — только `role == admin` | Только админ вставляет HTML |
| Видимость топиков/постов — по `categories.allowed_roles` | RBAC для категорий |
| `reputation_log.sender_user_id` — совпадает с Auth UID | Нельзя ставить репутацию от чужого имени |
| `Profile Privacy` | Принудительная задержка рендеринга постов и репутации до проверки прав доступа к категории | Предотвращение утечки контента из закрытых разделов при инициализации страницы |

### 15.1 Обеспечение приватности на стороне клиента (Privacy Hardening)
Для предотвращения кратковременного отображения («мигания») контента из закрытых категорий (например, при просмотре профиля гостем), на странице профиля реализована следующая логика:
- **Default Hidden**: Любой элемент, требующий проверки прав (посты, логи репутации), по умолчанию считается «проверяемым» (`loading`).
- **Skeleton State**: Пока асинхронная проверка прав (загрузка метаданных темы/категории) не завершена, вместо контента отображается скелетон.
- **Strict Verification**: Контент (текст поста, комментарий к репутации) рендерится только после получения явного подтверждения `hasPermission(VIEW_FORUM)`.

---

## 16. UX-специфика

- **Автосохранение черновика поста**: SessionStorage браузера; восстанавливается при возврате на страницу.
- **Счётчик символов**: отображается в реальном времени в форме написания поста.
- **Статус Online**: зелёный кружок на аватаре (Firebase Realtime Database Presence / Firestore `last_seen`).
- **Адаптивность**: Bootstrap 5 grid, мобильное бургер-меню, таблицы → карточки на мобильных.
- **Hero-блок**: `max-height` + адаптивные шрифты, чтобы кастомный HTML не ломал мобильный экран.
- **Статус-слоган**: короткая строка под никнеймом (свободный текст, редактируется в профиле).
- **Слоган темы**: поле `slogan` — короткая подпись под заголовком в списке тем (теги, фраза или пусто).
- **Online-статус**: присутствие через Firebase Realtime DB.
- **403 Forbidden**: страница для попытки доступа без прав.

---

## 17. Firebase-инфраструктура

| Сервис | Использование |
|---|---|
| **Firebase Auth** | Google Sign-in + Email/Password |
| **Firestore** | Основная БД всего приложения |
| **Firebase Storage** | Аватары пользователей и масок, Hero-изображения |
| **Cloud Functions** | Рассылка email при новых постах, каскадная логика |
| **FCM** | Push-уведомления на устройства |
| **Trigger Email Extension** | Транзакционные письма (одобрение, ЛС и т.д.) |
| **Firebase Hosting** | Хостинг React-приложения |

> **Тарифный план**: Firebase Blaze (Pay-as-you-go) — необходим для Cloud Functions и отправки почты. Для небольшого форума остаётся в пределах бесплатных лимитов.

---

## 18. TO-DO (полный список фич)

### Аутентификация и доступ
- [ ] Firebase Auth (Google + Email/Password)
- [ ] Gatekeeper — проверка `status` при входе
- [ ] Система инвайтов (коллекция `invites`)
- [ ] Страница «Ожидайте одобрения»
- [ ] Страница «403 Forbidden»

### Форумная структура
- [ ] CRUD категорий (Admin)
- [ ] CRUD тем (с полями `slogan`, `dice_enabled`)
- [ ] Лента постов в теме с пагинацией
- [ ] Автоматическое обновление счётчиков (`topics_count`, `posts_count`, `last_post`) при публикации

### Маски (Characters)
- [ ] CRUD масок в профиле (с проверкой лимита)
- [ ] `<CharacterSelect />` в форме поста
- [ ] Заморозка `display_name / display_avatar / display_signature` в посте
- [ ] Логика наследования подписи (`inherit` / своя / пусто)

### Репутация
- [ ] `<ReputationModal />` под постом
- [ ] Атомарный `increment` в `users.reputation_score` и `posts.reputation_score`
- [ ] Лог репутации в профиле со ссылками на посты
- [ ] Immutable rules для `reputation_log`

### Кубики
- [ ] `<DiceRoller />` (d4/d6/d10/d20/d100 + модификатор)
- [ ] Привязка результата к посту (`dice_data`)
- [ ] Immutable rule для `dice_data`
- [ ] `<DiceDisplay />` в посте
- [ ] Скрытые броски + `can_see_hidden_dice`
- [ ] Чекбокс `dice_enabled` при создании/редактировании темы

### Профиль
- [ ] Header: аватар, ник, статус-слоган, дата, репутация
- [ ] Вкладка «Персонажи» с лимитом и CRUD
- [ ] Вкладка «Репутация»
- [ ] Вкладка «ЛС»
- [ ] Вкладка «Настройки»: signature, appearance, language, timezone, notifications
- [ ] Публичный / приватный вид
- [ ] Загрузка аватара в Firebase Storage

### Личные сообщения
- [ ] Список диалогов + окно переписки (real-time)
- [ ] Поиск по сообщениям
- [ ] Badge непрочитанных
- [ ] Кнопка «Написать» из 3 мест

### Главная
- [ ] Hero-блок (сырой HTML, управление из Админки)
- [ ] Лента объявлений (`announcements`)
- [ ] Виджет «Свежие посты»
- [ ] Таблица категорий со статистикой

### Участники
- [ ] Страница `/members` с пагинацией и поиском

### Уведомления
- [ ] `<NotificationBell />` с real-time бейджем
- [ ] In-app уведомления (коллекция `notifications`)
- [ ] Email уведомления (Trigger Email + Cloud Functions)
- [ ] Push (FCM)
- [ ] Настройки уведомлений в профиле (per-event, per-channel)

### Темизация и i18n
- [ ] CSS Variables (dark / light / neutral)
- [ ] Выбор темы из профиля
- [ ] Словарь i18n (ru / en)
- [ ] Переключатель языка в Navbar
- [ ] Мультиязычные поля в `categories`
- [ ] Breadcrumbs с i18n

### Время
- [ ] Хранение UTC, конвертация в часовой пояс смотрящего

### Редактор поста
- [ ] Markdown / WYSIWYG
- [ ] Счётчик символов (real-time)
- [ ] Автосохранение черновика в браузере

### Пагинация
- [ ] Firestore `startAfter` для всех списков
- [ ] Логика «открыть нужную страницу по якорю post_id»

### Администрирование
- [ ] Dashboard со статистикой
- [ ] Управление пользователями (Ban/Approve/Role)
- [ ] Конструктор ролей (RBAC)
- [ ] Управление категориями и видимостью
- [ ] Управление объявлениями
- [ ] Редактор Hero-блока
- [ ] Система инвайтов
- [ ] Journal (Audit Log) — append-only

### Смайлы (Animated Emoji System)
- [x] Регистрация смайлов в `src/config/smiles.js`
- [x] Компонент `<SmilesPicker />` с поддержкой Popper.js и ResizeObserver
- [x] Парсинг шорткодов `[имя_смайла]` в BBCode
- [x] Рендеринг смайлов без декораций и с `vertical-align: middle`

### RBAC + Security Rules
- [x] Проверка прав перед рендерингом кнопок
- [x] Firestore Rules для всех коллекций
- [x] Запрет клиентского обновления `post_count` и `reputation`
- [x] Видимость категорий через `allowed_roles`
- [x] Принудительная проверка прав (Skeleton-first) на странице профиля для устранения утечек данных

### Инфраструктура
- [x] Firebase Hosting + `firebase.json`
- [x] Cloud Functions (email-рассылки, инкремент счетчиков, репутация)
- [x] FCM setup
- [x] Trigger Email Extension
- [x] Firebase Storage rules
