# План: глобальные email-шаблоны (админка форума)

**Трекер прогресса.** Текущий статус: **все шаги завершены (phase 3 — шаги 1–6 done)**.

- [x] **Шаг 1 (J.1–J.2):** миграция `1769300000_forum_email_templates.go` + backfill `{}` для `forumsettings01` + поле `EmailTemplates` в `forum_settings.go` — коммит `facc1c6`.
- [x] **Шаг 2 (J.3):** `email_templates.go` — дефолтная обёртка `defaultEmailWrapper` (порт `wrapEmailTemplate` из `functions/email.js`), дефолты типов, резолвер `loadEmailTemplates` (global > default, fallback при битом JSON) — коммит `078cf7f`.
- [x] **Шаг 3 (J.4):** уведомления через единый резолвер и отправка писем по подписке на тему:
  - Реализованы типы `dm` и `topic_reply` (уведомления об ответе в подписанной теме).
  - Строгий паритет с Firebase: email отправляется **только на первый непрочитанный ответ** в теме (`hasUnreadTopicReply` gate перед созданием нотификации), последующие ответы копятся молча до прочтения пользователем.
  - Уважение настроек пользователя `settings.email_notifications.topic_replies` (проверка как при постановке в очередь, так и воркером перед отправкой).
  - Сниппет с вырезанием BBCode (до 200 рун без разрезания UTF-8 символов), deep link `/topic/{id}?post={post}`.
  - Полноценный multipart/alternative (HTML + Plain text) через `pocketBaseMailSender` и `outbox_events`.
  - Покрыто unit/integration тестами (`topic_reply_email_test.go` — 6 тестов, все зелёные) — коммит `dd43258`.
- [x] **Шаг 4 (J.5):** auth-хуки `OnMailerRecord*Send` (переодевание PB-писем в `loadEmailWrapper(app)`):
  - В `email_templates.go`: реализованы `loadEmailWrapper(app)`, `wrapWithGlobalLayout(app, subject, innerHTML)` (с защитой от повторного оборачивания), `extractBodyContent(html)` (надежный парсинг `<body>...</body>`), `effectiveAppName(app)`.
  - В `forum_settings.go`: исправлен парсинг `types.JSONRaw` для поля `email_templates`, чтобы сохраненные из базы JSON-данные корректно считывались в структуру `forumSettings`.
  - В `mail_templates.go` и `run.go`: реализована функция `registerAuthMailHooks(app)`, перехватывающая `OnMailerRecordVerificationSend`, `OnMailerRecordPasswordResetSend` и `OnMailerRecordEmailChangeSend`. Письма PB переодеваются в глобальный стиль Aerun с подстановкой `{TITLE}` и `{APP_NAME}` и немедленно реагируют на изменение `"wrapper"` в `forum_settings`.
  - Покрыто unit и интеграционными тестами (`email_templates_test.go` и `mail_templates_test.go` — 7 новых тестов, все зелёные).
- [x] **Шаг 5 (J.6):** админка форума — REST API (`GET`/`PUT /api/aerun/admin/email-templates`, `POST .../test`) + UI-форма редактирования глобальной обёртки писем с предпросмотром и отправкой теста на свой email. Реализовано: `backend/internal/platform/pocketbase/admin_email_templates.go` + тесты `admin_email_templates_test.go`, компонент `src/components/admin/EmailTemplatesSettings.jsx` (редактор, предпросмотр в модалке, тестовая отправка, сброс), API-клиент `src/api/admin.js`, локализация EN/RU в `src/i18n/dictionary.js`, аудит-логи.
- [x] **Шаг 6:** отключение Brevo-дублей в Firebase (`functions/index.js`) при окончательном переходе на PocketBase SMTP. Реализовано: константа `FIREBASE_EMAIL_DELIVERY_DISABLED = true`, оба Brevo-вызова (topic_reply в `handlePostNotifications`, DM в `onDmMessageCreated`) за гейтом с логами `[Brevo ... Disabled]`; in-app уведомления (RTDB + Firestore) и счётчики непрочитанного не тронуты; `functions/email.js` помечен DEPRECATED как read-only референс дизайна.

---

### Ретроспектива и архитектурный аудит решений предыдущих агентов

В ходе анализа плана и кодовой базы выявлены срезанные углы и костыли, требующие корректировки архитектуры:

1. **Подмена глобальной обёртки на монолитные HTML-файлы под каждый тип (Главный архитектурный изъян):**
   - *Проблема:* В ТЗ зафиксировано: «Глобальный email-шаблон... Это дизайн/обёртка писем, а не формулировки (формулировки — для будущей разработки)». Однако предыдущий агент зашил `defaultEmailWrapper` как жесткую Go-константу, а в карту `email_templates` положил монолитные куски HTML для `dm` и `topic_reply`.
   - *Последствия:* Если админ меняет в админке дизайн (логотип, цвет плашки, подвал, ссылки), ему пришлось бы менять HTML отдельно в каждом типе нотификаций. А auth-письма в шаге 4 вообще не увидели бы изменений из админки, так как агент планировал вызывать хардкод `aerunWrap(inner)`!
   - *Решение:* Ключ `"wrapper"` в `forum_settings.email_templates` должен стать сущностью первого класса. Вспомогательная функция `loadEmailWrapper(app)` возвращает сохраненную глобальную обёртку (или дефолт). Все типы писем (auth, dm, topic_reply, test) одеваются в этот глобальный wrapper.

2. **Хрупкий строковый хак при перехвате auth-писем (`extractBetween`):**
   - *Проблема:* В старом плане предлагалось резать HTML строки: `extractBetween(e.Message.HTML, "<body", "</body>")`.
   - *Последствия:* Хрупко при наличии атрибутов у `<body>`, пробелов или переносов. Не учитывался заголовок `<title>{TITLE}</title>` обёртки Aerun.
   - *Решение:* Извлекать внутренний контент тела регулярным выражением `(?is)<body[^>]*>(.*?)</body>`, оборачивать через `wrapEmailWithLayout(app, subject, innerHTML)` с подстановкой `{TITLE} = e.Message.Subject`.

3. **Отсутствие API для сохранения шаблонов в админке (Дыра в старом плане):**
   - *Проблема:* В старом плане был придуман только `POST .../test`, но не было спланировано, как админка вообще читает и сохраняет `email_templates`! В `updateGlobalSettingsHandler` поле `email_templates` отсутствовало.
   - *Решение:* Создать пару изолированных защищенных админских эндпоинтов:
     - `GET /api/aerun/admin/email-templates` — отдает текущий эффективный wrapper и флаг `is_custom`.
     - `PUT /api/aerun/admin/email-templates` — валидирует наличие обязательного `{CONTENT}` и сохраняет `"wrapper"` в `forum_settings.email_templates`.
     - `POST /api/aerun/admin/email-templates/test` — отправляет тестовое письмо текущему админу.

4. **Статус email-уведомлений по подписке на тему (`topic_reply`):**
   - *Разъяснение:* Уведомления об ответах в теме **уже полностью реализованы в бэкенде** (шаг 3, коммит `dd43258`). Несоответствие возникло из-за того, что предыдущий агент обновил только заголовок markdown-файла, оставив разделы 1, 2, 3 и 5 старыми, где ошибочно утверждалось, что отправляются только DM и auth. Данный документ теперь приведен в полное соответствие с реальностью.

---

## 1. Проблема и контекст
В production (PocketBase) почтовые шаблоны для авторизации и уведомлений должны иметь единый премиальный стиль форума Aerun:
- В Firebase (`functions/email.js`) существовала верстка `wrapEmailTemplate` + `renderDmNotificationEmail` + `renderTopicReplyEmail`.
- В PocketBase письма авторизации генерируются движком PB в стандартном сером дизайне без шапки и стилей Aerun, а шаблоны из `mail_templates.go` перезаписывались при старте.
- Уведомления (личные сообщения и новые ответы в подписанных темах) теперь отправляются через PocketBase Outbox Worker с единым дизайном.

---

## 2. Архитектурные решения

1. **Единая глобальная обёртка (Global Wrapper):**
   - Дефолтная HTML-обёртка из `functions/email.js` компилируется в Go как неизменяемый дефолт (`defaultEmailWrapper`).
   - Администратор форума в админке может переопределить глобальную обёртку (поле `"wrapper"` в JSON-колонке `forum_settings.email_templates`).
   - Обёртка содержит плейсхолдеры: `{TITLE}`, `{APP_NAME}`, `{CONTENT}`.

2. **Приоритет конфигурации:**
   - Если в `forum_settings.email_templates["wrapper"]` сохранен валидный шаблон — используется он.
   - Если поле пустое, повреждено или не содержит `{CONTENT}` — используется встроенный надежный Go-дефолт.
   - Перезапуск сервера никогда не затирает пользовательские настройки в БД.

3. **Авторизационные письма (Верификация, Сброс пароля, Смена email):**
   - PocketBase генерирует тело письма и резолвит токены (`{TOKEN}`).
   - Хуки `OnMailerRecordVerificationSend`, `OnMailerRecordPasswordResetSend`, `OnMailerRecordEmailChangeSend` перехватывают исходящее сообщение:
     - Извлекают внутреннее содержимое тела (`<body>...</body>`).
     - Оборачивают его в глобальную обёртку форума `loadEmailWrapper(app)`.
     - Заполняют `{TITLE}` значением `e.Message.Subject`, а `{APP_NAME}` — именем форума.
   - В результате все системные письма автоматически получают дизайн форума и мгновенно реагируют на изменения шаблона в админке.

4. **Уведомления форума (Личные сообщения и Подписки на темы):**
   - **Личные сообщения (DM):** отправляются только офлайн-пользователям на первое непрочитанное сообщение в диалоге (`maybeEnqueueDMEmail`).
   - **Ответы в теме (Topic Reply):** отправляются подписчикам темы **только на первый непрочитанный ответ** (`maybeEnqueueTopicReplyEmail`). Пока пользователь не зайдет в тему/ленту, повторные письма не шлются.
   - Оба типа писем используют глобальную обёртку и отправляются асинхронно через транзакционный `outbox_events` воркером в формате `multipart/alternative` (HTML + Plain text).

5. **Тестовая почта и Безопасность:**
   - Эндпоинт `POST /api/aerun/admin/email-templates/test`.
   - Доступен строго администраторам (`requireRole("admin")`).
   - Получатель **принудительно фиксируется на email текущего авторизованного администратора** (`e.Auth.Email()`). Произвольный recipient запрещен для предотвращения spam-relay.

---

## 3. Схема данных и API

### 3.1 Хранилище (`forum_settings.email_templates`)
JSON-объект в таблице `forum_settings` (запись `forumsettings01`):
```json
{
  "wrapper": {
    "subject": "",
    "body": "<!DOCTYPE html><html>...{TITLE}...{APP_NAME}...{CONTENT}...</html>"
  },
  "dm": { ... },
  "topic_reply": { ... }
}
```

### 3.2 Резолвер в Go (`email_templates.go`)
- `loadEmailWrapper(app core.App) string` — возвращает эффективную глобальную обёртку.
- `wrapEmailContent(app core.App, title, contentHTML string) string` — оборачивает контент в глобальную обёртку с подстановкой `{TITLE}`, `{APP_NAME}` и `{CONTENT}`.
- `loadEmailTemplates(app core.App) emailTemplates` — загружает карту шаблонов типов.

### 3.3 REST API для админки (`admin_email_templates.go`)
1. `GET /api/aerun/admin/email-templates`
   - Ответ: `{ "wrapper": "...", "is_custom": false, "default_wrapper": "..." }`
2. `PUT /api/aerun/admin/email-templates`
   - Тело: `{ "wrapper": "..." }`
   - Валидация: строка не пустая, содержит обязательный тег `{CONTENT}`.
   - Запись в `forum_settings.email_templates`.
3. `POST /api/aerun/admin/email-templates/test`
   - Отправляет тестовое письмо с текущей обёрткой на email администратора через `app.NewMailClient()`.

---

## 4. Процесс реализации (Трекер)

| # | Шаг | Статус | Описание |
|---|-----|--------|----------|
| 1 | Миграция и поле настроек | **Выполнено** (`facc1c6`) | `1769300000_forum_email_templates.go` + поле `EmailTemplates` в `forum_settings.go`. |
| 2 | Резолвер и базовые шаблоны | **Выполнено** (`078cf7f`) | `email_templates.go`, `defaultEmailWrapper`, тесты `email_templates_test.go`. |
| 3 | Уведомления (DM и Topic Replies) | **Выполнено** (`dd43258`) | `notification_email.go`, `maybeEnqueueTopicReplyEmail`, `hasUnreadTopicReply` gate, `outbox_dispatch.go` multipart HTML, тесты `topic_reply_email_test.go`. |
| 4 | Auth-хуки (Глобальная обёртка для PB) | **Выполнено** | `registerAuthMailHooks`, `loadEmailWrapper`, `wrapWithGlobalLayout`, `extractBodyContent`, тесты `email_templates_test.go` и `mail_templates_test.go`. |
| 5 | Админка: API и Интерфейс | **Выполнено** | Эндпоинты `GET/PUT/POST test` в Go + тесты `admin_email_templates_test.go`, компонент `EmailTemplatesSettings.jsx` в админке с редактором, предпросмотром в модалке, тестовой отправкой и сбросом, полная локализация EN/RU и аудит-логи. Верифицировано в коде: роуты в `run.go:467-469`, компонент подключён в `AdminPage.jsx:1489`, клиент в `src/api/admin.js:329-369`. |
| 6 | Деактивация Brevo в Cloud Functions | **Выполнено** | `FIREBASE_EMAIL_DELIVERY_DISABLED=true` в `functions/index.js:15`; topic_reply-блок за гейтом (`index.js:2539`), DM-блок с ранним return (`index.js:4058`); in-app уведомления и счётчики не тронуты; `functions/email.js` — DEPRECATED референс. |

---

## 5. Детальный план реализации оставшихся шагов

### Шаг 6: Деактивация Brevo в Cloud Functions — **Выполнено**
1. В `functions/index.js`:
   - Добавлена константа `FIREBASE_EMAIL_DELIVERY_DISABLED = true` (строка 15) — единый kill-switch доставки из Firebase.
   - Topic-reply блок в `handlePostNotifications` (~строка 2539): первым условием проверяется kill-switch → лог `[Brevo Topic Reply Disabled]`, Brevo-вызов недостижим; in-app записи RTDB + Firestore выше по коду не тронуты.
   - DM-блок в `onDmMessageCreated` (~строка 4058): ранний return после обновления счётчиков `dm_unread` → лог `[Brevo DM Email Disabled]`; presence/online-проверки и весь Brevo-код ниже недостижимы.
   - Отправка теперь централизованно выполняется PocketBase backend'ом через `outbox_events` и `pocketbase_mail_sender` — дублей нет.
   - `functions/email.js` помечен DEPRECATED — оставлен как read-only референс дизайна, портированного в Go (`email_templates.go`).
2. Тесты и верификация:
   - Скриптовые проверки (`scripts/check-*.mjs`) не затрагивают email-пути — регрессии нет.
   - ESLint: Brevo-импорт и переменные (`sendBrevoEmail`, рендеры) остаются ссылочно используемыми в недостижимых ветках — `no-unused-vars` не срабатывает.

---
