# План: глобальные email-шаблоны (админка форума)

**Трекер прогресса.** Текущий статус: **phase 2 — реализация идёт**.

- [x] Шаг 1 (J.1–J.2): миграция `1769300000_email_templates.go` + backfill для legacy `forumsettings01` + поле `EmailTemplates` в `forum_settings.go` — `facc1c6`, `078cf7f`.
- [x] Шаг 2 (J.3): `email_templates.go` — `aerunWrap` (порт `wrapEmailTemplate`), дефолты, резолвер `loadEmailTemplates` (global > default, оверлей по типам, fallback при битом JSON) — `078cf7f`.
- [x] Шаг 3 (J.4): уведомления через резолвер — типы `dm` и `topic_reply`; `MailPayload.body_html`; `outbox_dispatch.go` шлёт multipart (HTML + text); ответ в подписанной теме шлёт email по первому непрочитанному ответу (паритет Firebase, guard `settings.email_notifications.topic_replies`, dispatch-time re-check) — см. `notification_email.go`, `topic_reply_email_test.go`.
- [ ] Шаг 4 (J.5): auth-хуки `OnMailerRecord*Send` (переодеть PB-контент в `aerunWrap`; убрать force-overwrite в `configureAuthTemplates`).
- [ ] Шаг 5 (J.6): админка — форма глобального шаблона + `POST /api/aerun/admin/email-templates/test` (recipient = свой емейл).
- [ ] Шаг 6: отключить Brevo-дубли в `functions/index.js` при переходе на Go-отправку.

### Handoff: точка остановки (сессия 08.10.2026)

**Статус: шаг 3 (J.4) ВЫПОЛНЕН ПОЛНОСТЬЮ, ВСЕ ТЕСТЫ ЗЕЛЁНЫЕ, ЗАКОММИЧЕН (см. `git log`). Следующий шаг — шаг 4 (J.5): auth-хуки.**

Что сделано в этой сессии (шаг 3 — уведомления через резолвер + email ответов в теме):
- `messaging/validation.go` + `_test.go`: `MakeTopicReplyDedupeKey(postID, recipientID)` → `topic-reply:first-unread:{post}:{recipient}` (dedupe per-POST: следующая волна непрочитанных после чтения ленты — новый ключ).
- `email_templates.go`: тип `emailTemplateTopicReply="topic_reply"`; плейсхолдеры `phTopicTitle`/`phTopicURL`; `defaultTopicReplyContent` (порт `renderTopicReplyEmail` из `functions/email.js`); `renderEmailFromTemplate(tpl, appName, title, values)` — значения в body экранируются (`html/template`; Go даёт `&#34;`, не `&quot;`), subject сырой.
- Новый `notification_email.go`: `postEmailSnippet` (BBCode-strip, 200 рун), `dmEmailSnippet` (150 рун), `topicReplyEmailEnabled`, `hasUnreadTopicReply` (first-unread gate — проверяется ДО создания текущего notification, иначе ответ заглушил бы собственную почту), `topicEmailURL` (`/topic/{id}?post={post}`), `maybeEnqueueTopicReplyEmail` (enqueue `email:topic_reply` c `BodyHTML`), `topicReplyEmailText`, `topicReplyEmailSkipReason` (re-check тумблера при dispatch).
- `dms.go`: `emailNotificationsPref(user, prefKey)` (обобщённый), `maybeEnqueueDMEmail` рендерится через `loadEmailTemplates` + `renderEmailFromTemplate` + `BodyHTML`.
- `post_notifications.go`: `deliver()` считает `firstUnreadReply` до `createNotification` и для `topic_reply` зовёт `maybeEnqueueTopicReplyEmail` (in-app нотификации — по-прежнему на каждый ответ; email — только на первый непрочитанный; Firebase-паритет).
- `outbox.go`: `MailSender.Send(ctx, payload MailPayload)` (было строки), `MailPayload.BodyHTML`; skip-switch в dispatch знает `email:dm_unread` и `email:topic_reply` (skipped → `status=sent`, `last_error: "skipped: ..."`).
- `outbox_dispatch.go`: `pocketBaseMailSender` шлёт `mailer.Message{Text, HTML}` (PB v0.40.4 multipart/alternative).
- Тесты: новый `topic_reply_email_test.go` (6: enqueue на первом непрочитанном, coalescing/второй без письма, чтение открывает gate, тумблер-off на enqueue, тумблер-off на dispatch, BodyHTML до sender); обновлены `sprint5_test.go` (mock `sentPayloads`), `email_templates_test.go` (+2 теста, `&#34;`), `outbox_dispatch_test.go` (payload-сигнатура).

**Верификация — ВСЁ ЗЕЛЁНОЕ:**
- `go test ./internal/... -count=1` (полный) — **ok, все пакеты**: `pocketbase 435.474s`, `messaging 0.789s`, `migrations 17.324s`, `auth/config/forum/importer` — ok.
- Ранее: `go build ./...` ok, `go vet ./internal/...` чисто, `gofmt` применён; точечные прогоны template/snippet (`TestRenderEmailFromTemplate|TestLoadEmailTemplates|TestAerunWrap|TestDefaultTopicReplyTemplate|TestEmailSnippets`), регрессии (`TestDMEmail|TestSprint5|TestOutbox|TestADR6|TestRegisterOutbox|TestQuote*|TestMention*`) — ok.
- Temp-файлы `*_out.txt` удалены, рабочее дерево содержит только осмысленные правки.

**Следующая сессия — план действий:**
1. `git log -1 --stat` убедиться, что шаг 3 закоммичен; `git status` — дерево чистое.
2. Быстро перепроверить перед началом работы: `cd backend && go build ./... && go vet ./internal/...`.
3. Приступить к шагу 4 (J.5): auth-хуки `OnMailerRecord*Send` — извлечь inner-контент PB-шаблона, переодеть в `aerunWrap`; убрать force-overwrite в `configureAuthTemplates` (seed только если пусто); расширить `mail_templates_test.go` золотыми тестами обёртки.
4. Затем шаг 5 (J.6): админка — форма глобального шаблона + `POST /api/aerun/admin/email-templates/test` (recipient принудительно = свой емейл аккаунта).

**Известные тонкости окружения (для будущей сессии):**
- PowerShell 5.1: нет `&&` (использовать `;` или `cmd /c`), `$_` в командах вырезается экранированием — избегать, кириллический вывод в терминал ломает следующий ввод (глюк «сcmd»); длинные тесты → редирект в файл, читать через read_files.
- Редактор: чанки <6000 символов.
- Двойная отправка (Firebase ещё шлёт эти же письма) — осознанно отложено, решается шагом 6 (отключение Brevo-дублей).

## 1. Проблема
В production (PocketBase) почтовые шаблоны для верификации и уведомлений отсутствуют или не согласованы с написанным дизайном:
- `functions/email.js` (Firebase/Brevo) содержит дизайн-обёртку `wrapEmailTemplate` + `renderDmNotificationEmail` + `renderTopicReplyEmail`, но не используется в текущем PocketBase-деплое.
- `backend/internal/platform/pocketbase/mail_templates.go` содержит авторизационные шаблоны, но они устанавливаются в `users` коллецию и перезаписываются при каждом рестарте (`configureAuthTemplates`), ломая редактирование в интерфейсе.
- Уведомления (DМ, ответы) не имеют шаблонов в Go-пути.

## 2. Финальные решения
1. **Единый общий дефолт из коробки.** Красивый шаблон из `functions/email.js` (`wrapEmailTemplate`) сеидится в Go (`mail_templates.go`) как дефолтная обёртка **для всех типов писем**. «Из коробки» форум сразу имеет нормальный шаблон — это обязательно.
2. Глобальный email-шаблон сеидится в админку форума в `forum_settings` (строка `forumsettings01`) как JSON-поле `email_templates` — тот же дефолт, что в файлах, но редактируемый из UI. Это дизайн/обёртка писем, а не формулировки (формулировки — для будущей разработки).
3. Приоритет: дефолт из Go-файлов; если в БД (`forum_settings`) записано — оно всегда «главнее» и никогда не перезаписывается при рестарте (схема как у SMTP).
4. Тестовая почта: единый тип теста + кастомный текст «это тестовое письмо для проверки шаблона, само тело письма системное и не редактируемое.»; поле `Test recipient` ограничено своим собственным емейлом аккаунта (чтобы избежать абуза/спама).
5. Поля `users.VerificationTemplate` / `users.ResetPasswordTemplate` / `users.ConfirmEmailChangeTemplate` скрыты и отключены от редактирования; остаются синхронизируемые копии.
6. В PocketBase UI шаблонов настраивать не нужно; вся конфигурация в админке форума.
7. **Жёсткое правило для любых будущих писем (занесено в `.clinerules`):** любое новое SMTP-письмо (упоминания, цитирование, любые будущие типы) ОБЯЗАНО идти через общий email-шаблон (`loadEmailTemplates` → обёртка). Нельзя «в лоб» слать письмо с собственным HTML/шаблоном в обход общего. Сейчас на почту уходят только: авторизационные (верификация/сброс/email change) и DМ. Упоминаний и цитирования на почту ещё нет — при добавлении они должны подхватывать общий шаблон.

## 3. Архитектура
### 3.1 Хранилище
- `forum_settings.email_templates` — JSON `{ "<typ>": { "subject": "...", "body": "..." }, ... }` (позволяет добавлять типы без миграции/схемных изменений). `body` — HTML-обёртка из `wrapEmailTemplate` с плейсхолдерами (тема/контент).

### 3.2 Ресолвер
- `loadEmailTemplates(app)` в `mail_templates.go`: читает `forum_settings.email_templates`; если пусто — дефолтные значения из файлов; если заполнено — берёт из БД (никогда не перезаписывает).

### 3.3 Доставка
- Уведомления (DМ сейчас; ответы/цитирование/упоминание — если/когда включатся): шаблон разрешается при постановке в `outbox_events` (dms.go, post_notifications.go) через общий резолвер `loadEmailTemplates`; новый код обязан использовать резолвер (см. `.clinerules`).
- Авторизационные (верификация, сброс, email change): перед отправкой (hook `OnMailerSend` / `OnMailerRecordEmailChangeSend`) проверяем глобальный шаблон; если есть — перезаписываем `Subject`/`HTML`, иначе текущее поведение. Так глобальный шаблон «догоняет» авторизационные письма без ручного редактирования `users`.

### 3.4 Тестовая почта
- Эндпоинт `POST /api/aerun/admin/email-templates/test` (админка, авторизация + роль Админ).
- Тело: кастомный системный текст «это тестовое письмо для проверки шаблона, само тело письма системное и не редактируемое.»
- `recipient` — только свой собственный емейл аккаунта (проверка на бэкенде: отправитель и получатель — тот же email).
- Отправка через тот же путь, что и обычные письма (outbox → worker → PocketBase mailer).

## 4. Файлы, которые будут меняться
- `backend/internal/platform/pocketbase/forum_settings.go`
- `backend/internal/platform/pocketbase/global_settings.go`
- `backend/internal/platform/pocketbase/mail_templates.go`
- `backend/internal/platform/pocketbase/dms.go`
- `backend/internal/platform/pocketbase/post_notifications.go`
- `backend/internal/platform/pocketbase/run.go`
- `src/api/admin.js`

## 5. Процесс реализации (трекер)
| # | Шаг | Статус |
|---|-----|--------|
| 1 | Дефолтная обёртка из `functions/email.js` → `mail_templates.go`; поле `EmailTemplates` в `forumSettings` + seed/миграция | выполнено |
| 2 | Ресолвер `loadEmailTemplates` (global > дефолтные) | выполнено |
| 3 | Внедрение в доставку уведомлений (enqueue разрешает шаблон) | открыто |
| 4 | Внедрение в доставку авторизационных писем (hook `OnMailerSend`) | открыто |
| 5 | Форма админки + тестовая почта (own-email restriction) | открыто |
| 6 | Тесты + финальная проверка | открыто |

## 6. Открытые вопросы
- В каких случаях синхронизировать `users`-поля в явном виде? Пока реализуем через перехват `OnMailerSend` и не трогаем `users`.

## 7. Резерв
Если в будущем нужно контролировать формулировки — добавим отдельные текстовые поля, не затрагивая дизайн-блок.

---
---

# ТЕХНИЧЕСКИЕ НАХОДКИ ДЛЯ РЕАЛИЗАЦИИ (чтобы не терять контекст)

> Этот блок — для агента, который продолжит работу. Здесь точные файлы, функции,
> номера строк, внутренности PocketBase и конкретный план правок. Не надо заново
> исследовать — всё уже собрано.

## A. КАК POCKETBASE РЕНДЕРИТ AUTH-ПИСЬМА (критично для шага 4)

Файлы (в GOMODCACHE, версия зафиксирована в `backend/go.mod` = `v0.40.4`):
`C:\Users\Alina\go\pkg\mod\github.com\pocketbase\pocketbase@v0.40.4\...`

- `mails/record.go` → `resolveEmailTemplate` (~строки 289–302):
  1. резолвит плейсхолдеры фрагмента (`{TOKEN}`, `{APP_NAME}`, `{APP_URL}` …) → `rawBody`;
  2. **ВСЕГДА** оборачивает `rawBody` в `templates.Layout` (generic slate-лейаут PB);
  3. готовый `<html>…<body>rawBody</body></html>` кладёт в `message.HTML`
     **ДО** срабатывания хука `OnMailerRecord*Send`.
- `mails/templates/layout.go` — generic slate-лейаут PB (свой шрифт, `.btn`).
- `mails/templates/html_content.go` → `templates.HTMLBody = {{define "content"}}{{.HTMLContent}}{{end}}`
  — наш фрагмент вставляется verbatim между `<body>` и `</body>`.
- `core/collection_model_auth_templates.go` — дефолтные PB-шаблоны (`defaultVerificationTemplate` и т.д.)
  тоже являются ФРАГМЕНТАМИ (`<p>Hello…</p>`), т.е. PB сам их оборачивает в свой лейаут.

**ВЫВОД (почему дизайн теряется):** PB всегда оборачивает наш фрагмент в свой generic-лейаут.
Применить Aerun-дизайн к auth-письмам можно ТОЛЬКО перехватом в хуке `OnMailerRecord*Send`:
извлечь inner-контент (между `<body>` и `</body>`, где `{TOKEN}` уже resolved в href)
и переодеть в Aerun-обёртку. Плейсхолдеры доступны в момент хука как константы:
`{APP_NAME}` `{APP_URL}` `{TOKEN}`. `{NEW_EMAIL}` — НЕ PB-плейсхолдер, подставляет наш
`bindEmailChangePlaceholder`.

### Текущий код `backend/internal/platform/pocketbase/mail_templates.go`
- Плейсхолдер-константы: `phAppName="{APP_NAME}"`, `phAppURL="{APP_URL}"`, `phToken="{TOKEN}"`, `phNewEmail="{NEW_EMAIL}"`.
- Шаблоны-фрагменты: `verificationTemplate`, `resetPasswordTemplate`, `confirmEmailChangeTemplate` — тип `core.EmailTemplate`, `Body` БЕЗ `<html>`.
- `configureAuthTemplates(app)` (~строки 150–210): reconcile при КАЖДОМ старте. Через
  `renderAuthTemplate` (рендерит `{{ .AppURL }}` через `html/template`) сравнивает с текущим
  значением в `users.authOptions` и **перезаписывает** если отличается. ⇒ ЭТУ перезапись надо убрать/сделать
  только-если-пусто (иначе ломает «БД главнее»). `authTemplateData` несёт `AppURL` (и, при наличии, имя форума).
- `renderAuthTemplate(t core.EmailTemplate, data authTemplateData) (core.EmailTemplate, error)`.
- `bindEmailChangePlaceholder(app)`: `app.OnMailerRecordEmailChangeSend().BindFunc(...)` →
  подставляет `{NEW_EMAIL}` (HTML-escaped) в `e.Message.HTML` и `e.Message.Subject`.
- `substituteNewEmail(content, newEmail string) string` — чистая функция замены.

**Алгоритм auth-шага 4b (предлагаемый):** в соответствующих хуках
`OnMailerRecordVerificationSend` / `OnMailerRecordPasswordResetSend` / `OnMailerRecordEmailChangeSend`
(и/или общем `OnMailerSend`):
`inner := extractBetween(e.Message.HTML, "<body", "</body>")` (токен уже resolved),
затем `e.Message.HTML = aerunWrap(inner)` используя обёртку из резолвера шаблонов.
Учесть: у разных типов письма разные хуки — тип определить по имени хука.

## B. ХРАНИЛИЩЕ И РЕЗОЛВЕР

- `backend/internal/platform/pocketbase/forum_settings.go`:
  - Имя коллекции: `forum_settings` (константа `forumSettingsCollectionName`).
  - ID синглтона: `forumSettingsID` = `"forumsettings01"` (использовать в миграции для seed).
  - `loadForumSettings(app core.App)` — загружает строку в структуру `forumSettings`.
  - `forumSettings` — struct с полями (json-тегами). Сюда добавить поле
    `EmailTemplates string \`json:"email_templates"\`` (JSON-строка). Проверить точное имя/тип структуры перед правкой.
- Новый резолвер (добавить в `mail_templates.go` или новый файл `email_templates.go`):
  - `loadEmailTemplates(app core.App) emailTemplates` — читает `forum_settings.email_templates`;
    если пусто/битый → возвращает дефолт из Go-констант; иначе парсит JSON из БД.
  - Тип `emailTemplates` = `map[string]emailTemplate`, где `emailTemplate struct { Subject string; Body string }`.
  - `Body` в БД — это ОБЁРТКА (порт `wrapEmailTemplate`) с плейсхолдерами контента.

## C. ДОСТАВКА УВЕДОМЛЕНИЙ (DМ сейчас)

- `backend/internal/platform/pocketbase/dms.go`:
  - `maybeEnqueueDMEmail(...)` (~строки 108–175): сейчас формирует plain-text
    `Subject: "New direct message from X"` и `BodyText: "X sent you a message:\n\n<text>"`,
    кладёт `MailPayload` в outbox через `enqueueOutboxEvent`.
    ⇒ Заменить на: разрешить шаблон через `loadEmailTemplates(app)`, отрендерить обёртку,
    класть `Subject`+`BodyHTML`(+`BodyText`) в payload. `enqueueOutboxEvent` принимает `payload any` → JSON.
  - `dmEmailEnabled(user *core.Record) bool` — `user.settings.email_notifications.dms != false` (default true). НЕ трогать.
  - `isMemberOnline(userID, now)` — presence. НЕ трогать.
  - Дедуп-key: `dm:first-unread:{conversationID}:{recipientID}`.
- `backend/internal/platform/pocketbase/outbox.go`:
  - `enqueueOutboxEvent(txApp, dedupeKey, eventType, payload any)` — идемпотентная вставка в `outbox_events`.
  - `MailPayload` struct (~29-34): сейчас `{ RecipientID, ToEmail, Subject, BodyText }`.
    ⇒ РАСШИРИТЬ: добавить `BodyHTML string \`json:"body_html"\``.
  - `NewOutboxWorker()` + `worker.ProcessBatch(...)` — воркер, должен передавать HTML в sender.
- `backend/internal/platform/pocketbase/outbox_dispatch.go`:
  - `pocketBaseMailSender` — адаптер `MailSender` → `app.NewMailClient()`.
  - `Send(ctx, to, subject, body string) error` — сейчас `Text: body`.
    ⇒ Доработать: читать `BodyHTML` из payload; если непусто — `mailer.Message{HTML: bodyHTML, Text: bodyText}`,
       иначе plain-text. Интерфейс `MailSender` (`outbox.go` ~24-26) возможно расширить до
       `Send(ctx, payload MailPayload)` или добавить метод — проверить тесты `dm_email_test.go`.
- `backend/internal/platform/pocketbase/run.go`:
  - Регистрация admin-роутов (~244–320) — добавить `POST /api/aerun/admin/email-templates/test` (auth + admin).
  - Регистрация хуков письма — там же, где сейчас `bindEmailChangePlaceholder(app)`.

## D. МИГРАЦИЯ (новый файл)

Последняя миграция: `1769200000_bilingual_category_labels.go`. Создать следующую:
`backend/internal/migrations/1769300000_forum_email_templates.go` (ПРОВЕРИТЬ max-номер через
`ls backend/internal/migrations`, взять max+1). Регистрация через `migrations.Register(...)`.

Паттерн (аналог `1768700000`/`1768800000`):
- `col, _ := app.FindCollectionByNameOrId("forum_settings")`.
- Если `col.Fields.GetByName("email_templates") == nil` → `col.Fields.Add(&core.JSONField{Name:"email_templates", Required:false})`; `app.Save(col)`.
- Seed ТОЛЬКО если пусто: `record, _ := app.FindRecordById("forum_settings", forumSettingsID)`;
  если `record.GetString("email_templates")==""` → `record.Set("email_templates", <defaultJSON>)`; `app.Save(record)`.
- `revert` — удалить поле (`col.Fields.RemoveByName`).

**Важно про единый дефолт:** пакет `migrations` почти наверняка НЕ может импортировать
`internal/platform/pocketbase` (слои/циклы). Тогда дефолт-JSON хранить в двух местах синхронно
(константа в миграции + Go-дефолт в `mail_templates.go`) ИЛИ вынести общий дефолт в отдельный
низкоуровневый пакет, который импортируют оба. Проверить при реализации.

## E. АДМИНКА (frontend)

- `src/api/admin.js` — API-клиент. Добавить `testEmailTemplate()` → `POST /api/aerun/admin/email-templates/test`.
- Форма глобального email-шаблона (рядом с настройками форума/SMTP в админ-панели):
  - редактор обёртки (textarea/HTML) + предпросмотр;
  - кнопка «Отправить тестовое письмо» → шлёт только на email текущего аккаунта;
  - доступ только админам.
- Найти компонент настроек форума/SMTP в `src/` (grep `email_templates`, `smtp`, `forum_settings`,
  `AdminPage`, `SettingsPage`) — точный путь определить при реализации.

## F. ТЕСТОВАЯ ПОЧТА (backend)

- `POST /api/aerun/admin/email-templates/test` (auth + роль admin).
- Тело письма: кастомный системный текст «это тестовое письмо для проверки шаблона, само тело
  письма системное и не редактируемое.» — подставить в текущий шаблон.
- `recipient` — ПРИНУДИТЕЛЬНО email текущего аккаунта (`e.Auth`), входящий recipient игнорировать
  (защита от абуза).
- Отправка через тот же путь (outbox → worker → PocketBase mailer) либо напрямую `app.NewMailClient()`.

## G. ЖЁСТКОЕ ПРАВИЛО (уже в `.clinerules`)

Любое новое SMTP-письмо ОБЯЗАНО идти через общий резолвер `loadEmailTemplates` → обёртку.
Нельзя слать письмо с собственным HTML в обход общего шаблона.
Сейчас на почту уходят ТОЛЬКО: авторизационные (verification/reset/email-change), уведомлении об ответе в теме (подписка) и DМ.
Упоминаний/цитирования на почту пока НЕТ — при добавлении подхватывать общий шаблон.

## H. ТЕСТЫ

- `mail_templates_test.go` — golden-тесты auth-шаблонов (расширить под обёртку).
- `dm_email_test.go` (~106–270) — тесты ДМ-письма; при смене payload (`body_html`) обновить.
- Новый тест резолвера: пустой `email_templates` → дефолт; заполненный → из БД (не перезатирается).

## I. ЧТО ПРОВЕРИТЬ ПРИ СТАРТЕ РЕАЛИЗАЦИИ

1. Точное имя/тип структуры `forumSettings` и метода `loadForumSettings` в `forum_settings.go`.
2. Поддерживает ли `MailSender`/`ProcessBatch` HTML — иначе расширить интерфейс + обновить `dm_email_test.go`.
3. Могут ли миграции импортировать пакет `pocketbase` (единый дефолт) — почти наверняка НЕТ.
4. Max-номер миграции (взять +1).
5. Сигнатуры хуков PB: `app.OnMailerRecordVerificationSend`, `OnMailerRecordPasswordResetSend`,
   `OnMailerRecordEmailChangeSend`, общий `OnMailerSend`.

## J. ПОРЯДОК РЕАЛИЗАЦИИ (детально)

1. Миграция: `email_templates` (JSONField) + seed дефолта. (D)
2. `forum_settings.go`: поле `EmailTemplates string`. (B)
3. `mail_templates.go`/`email_templates.go`: порт `wrapEmailTemplate` → Go `aerunWrap(inner)`;
   Go-дефолт шаблона; резолвер `loadEmailTemplates`. (A,B)
4. DМ: `dms.go` рендерит через резолвер; расширить `MailPayload` (`body_html`); `outbox_dispatch.go` шлёт HTML. (C)
5. Auth: хуки `OnMailerRecord*Send` — извлечь inner, переодеть в `aerunWrap`; убрать перезапись `users`
   в `configureAuthTemplates` (оставить seed-только-если-пусто). (A)
6. Админка: форма + тест (own-email). (E,F)
7. Тесты + `go build ./...`. (H)

---
*Тех-блок сохранён из сессии анализа. Статус: phase 1 — код ещё НЕ начат (сначала согласовать B/A/C).*
