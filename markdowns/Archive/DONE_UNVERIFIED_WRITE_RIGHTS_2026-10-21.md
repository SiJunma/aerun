# Архитектурный план: разграничение прав неподтверждённых аккаунтов (Clean Policy Architecture)

**Дата:** 2026-10-21 (обновлено 2026-10-22)  
**Статус:** реализовано; бэкенд и контекст аутентификации обновлены согласно плану.

---

## 1. Проблема и почему старый вариант был «костыльным»

В черновом варианте решения задачи возникли два взаимосвязанных компромисса:
1. **Жёсткий гейт `requireVerified(acc)` (коммит `262c16d`):** возвращал `403 Forbidden` на уровне роутов создания топиков, постов и ЛС. Это отсекало пользователя от возможности писать даже в открытом гостевом разделе (`gostevaya`) и блокировало ответы во входящих диалогах ЛС от стаффа.
2. **Идея с «подменой роли на лету» (`writeRole = RoleGuest`):** попытка в коде сказать `if acc.Status == pending || !acc.Verified { writeRole = guest }`. Это размывает доменную модель: у пользователя нет роли гостя — он зарегистрированный `player` с определённым жизненным циклом. Подмена роли приводит к скрытым состояниям, багам в проверках и усложняет клиентскую синхронизацию.

### Архитектурное разделение понятий (Best Practice)
Вместо манипуляций с ролью разделяются три независимые оси доменной модели:

1. **Роль (Role / Identity):** `player`, `moderator`, `admin`, `root`, кастомные роли («кто ты в сообществе»).
2. **Статус жизненного цикла (Status / Admin Approval):** `pending`, `active`, `banned`, `deleted`. Регулируется форумной настройкой `require_approval` и решениями администрации («допущен ли аккаунт модерацией»).
3. **Состояние верификации (Email Verification):** `verified = true / false`. Подтверждение владения почтовым адресом через письмо или OAuth-провайдер.

---

## 2. Иерархия статусов и матрица состояний

### Принцип приоритета одобрения администрацией (Admin Approval > Email Verification)
Форумная настройка `require_approval` определяет требование премодерации регистрации:
- Если `require_approval == true`, аккаунт при создании получает `status = "pending"`.
- **Даже если пользователь подтвердил email (`verified = true`), аккаунт остаётся `pending` до тех пор, пока администратор явно не одобрит его!** Подтверждение почты не снимает статус ожидания одобрения.
- Если `require_approval == false`, аккаунт при создании получает `status = "active"`, но с `verified = false` (до перехода по ссылке из письма). Пользователь активен, но не верифицирован.

### Матрица состояний обычного пользователя (роль `player` / кастомная роль)

| Статус (`status`) | Email (`verified`) | Состояние аккаунта | Глобальное право записи (`CanPostGlobally`) | Постинг в гостевой зоне (`gostevaya`) | Создание новых ЛС | Ответ в существующих ЛС | Черновики в гостевых темах |
|---|---|---|---|---|---|---|---|
| `pending` | `false` | Ожидает подтверждения email И одобрения админом | **НЕТ** | **ДА** | **НЕТ** | **ДА** | **ДА** |
| `pending` | `true` | Email подтверждён, ожидает одобрения админом | **НЕТ** | **ДА** | **НЕТ** | **ДА** | **ДА** |
| `active` | `false` | Одобрен (или премодерация выкл), email не подтверждён | **НЕТ** | **ДА** | **НЕТ** | **ДА** | **ДА** |
| `active` | `true` | **Полноправный участник форума** | **ДА** | **ДА** | **ДА** | **ДА** | **ДА** |
| `banned` / `deleted` | любое | Заблокирован / удалён | **НЕТ** | **НЕТ** | **НЕТ** | **НЕТ** | **НЕТ** |

> [!NOTE]
> **Исключение для Staff (`root`, `admin`, `moderator`):**  
> Члены администрации всегда обладают `CanPostGlobally = true`, независимо от флага `verified`, чтобы исключить сценарий случайной блокировки управления форумом из-за проблем с почтовым ящиком.

---

## 3. Доменные правила и политики доступа (Access Policies)

### 3.1. Глобальная возможность записи (`CanPostGlobally`)
На уровне `AccessContext` (Go) и клиентского состояния (React) вводится чистый предикат:
```go
// CanPostGlobally определяет, имеет ли аккаунт право полноценной публикации по форуму.
func (acc AccessContext) CanPostGlobally() bool {
    if isStaff(acc) {
        return true
    }
    return acc.Status == auth.StatusActive && acc.Verified
}
```

### 3.2. Категорийная политика: концепция «Открытой зоны постинга»
Право писать в категорию (`categoryWriteAllowed`) не подменяет роль, а проверяет соответствие субъекта политике категории:

- **Если аккаунт обладает глобальным правом (`acc.CanPostGlobally() == true`):**
  Действует стандартная проверка прав:
  - Если для действия (`create_topic`, `post_reply`) задан явный список ролей (`override`): аккаунт допущен, если его реальная роль (`acc.Role`) присутствует в этом списке.
  - Если override пуст: только root.
  - Если override отсутствует или маркер `__aerun_inherit_roles__`: fallback на глобальные пермиссии аккаунта (`acc.Permissions`).

- **Если аккаунт ограничен (`acc.CanPostGlobally() == false` — pending или unverified):**
  Аккаунт **не имеет права** использовать глобальные разрешения и права своей роли `player`. Он допускается к публикации **исключительно в публичных открытых разделах**.
  Категория признаётся открытой зоной для неподтверждённых аккаунтов тогда и только тогда, когда в её явном списке разрешений (`override`) для данного действия **явно указана роль `guest`**:
  ```go
  if !acc.CanPostGlobally() {
      if !hasOverride {
          return false, nil // нет явного оверрайда — закрыто для ограниченных аккаунтов
      }
      // Разрешено только если категория открыта гостям / публике
      return slices.Contains(override, string(auth.RoleGuest)), nil
  }
  ```

> [!IMPORTANT]
> **Почему это защищает от скрытых багов:**  
> Если администратор создаст категорию с оверрайдом `create_topic: ["player"]` (без `guest`), неподтверждённый или pending пользователь **не сможет** там писать, поскольку его право определяется не ролью `player`, а наличием `guest` в открытой зоне. Это исключает баг случайного допуска в закрытые клубные разделы.

### 3.3. Личные сообщения (DMs)
1. **Создание нового диалога (`POST /api/aerun/dms`):**
   - Разрешено только аккаунтам с `CanPostGlobally() == true`.
   - Проверка выполняется внутри транзакции **после** проверки на гонку первых сообщений (если диалог между этими собеседниками уже существует — это ответ, а не открытие).
   - Если диалога не было и `!acc.CanPostGlobally()`, возвращается понятная ошибка 403:
     - Для `StatusPending`: «a pending account cannot start a conversation; it can only answer one that was started for it».
     - Для `!Verified`: «email verification is required to start a new conversation; you can answer existing conversations».
2. **Ответ в существующем диалоге (`POST /api/aerun/dms/{id}/messages` и дописка через `createDMHandler`):**
   - Разрешён любому участнику диалога, обладающему `PermUseDirectMessages` (у `pending` и `active unverified` это право сохраняется).
   - Жёсткий `requireVerified` из `sendDMMessageHandler` **удаляется**. Стафф может написать первым неодобренному или неверифицированному участнику, и участник может полноценно отвечать.

### 3.4. Черновики (Drafts)
1. **Удаление слепого middleware с роутов:**  
   В `run.go` роуты `PUT /topics/{id}/draft` и `POST /drafts/{id}/publish` сейчас закрыты `RequirePermission(auth.PermPostReply)`. У `pending` этой пермиссии нет, из-за чего он не мог сохранять даже черновик в гостевой теме.
   Глобальный `RequirePermission(auth.PermPostReply)` снимается с этих роутов (остаётся аутентификация и проверка на незаблокированность `requireNotBanned`).
2. **Категорийная валидация внутри хэндлеров:**  
   И в `upsertDraftHandler`, и в `publishDraftHandler` вызывается единая проверка:
   ```go
   allowed, err := categoryWriteAllowed(txApp, acc, topic.GetString("category_id"), auth.PermPostReply)
   ```
   - В гостевой теме (`gostevaya`) `categoryWriteAllowed` вернёт `true` → черновик сохраняется и публикуется.
   - В закрытых темах `categoryWriteAllowed` вернёт `false` → 403 Forbidden.
   - Это одновременно закрывает известную уязвимость (публикация старого черновика в закрытую тему).

---

## 4. План реализации по шагам

### 4.1. Бэкенд (Go / PocketBase)

#### Шаг 1. Расширение `AccessContext` (`internal/platform/pocketbase/access.go`)
- Добавить метод `(acc AccessContext) CanPostGlobally() bool`:
  ```go
  func (acc AccessContext) CanPostGlobally() bool {
      if isStaff(acc) {
          return true
      }
      return acc.Status == auth.StatusActive && acc.Verified
  }
  ```
- В `isStaff(acc)` убедиться, что `RoleRoot`, `RoleAdmin`, `RoleModerator` считаются персоналом.

#### Шаг 2. Корректировка `categoryWriteAllowed` (`internal/platform/pocketbase/category_access.go`)
- При `!acc.CanPostGlobally()` проверять исключительно наличие `auth.RoleGuest` в явном оверрайде категории (`slices.Contains(override, string(auth.RoleGuest))`).
- Никакой подмены `acc.Role = guest`.

#### Шаг 3. Чистка `forum_topics.go` и `forum_posts.go`
- Удалить вызовы `requireVerified(acc)` из `createTopicHandler` и `createPostHandler`.
- Решение полностью делегируется `categoryWriteAllowed`, который корректно пропустит запросы в открытые гостевые зоны и отклонит в остальных.

#### Шаг 4. Точечный гейт на открытие ЛС (`internal/platform/pocketbase/dms.go`)
- Удалить вызов `requireVerified(acc)` из начала `createDMHandler` и из `sendDMMessageHandler`.
- Внутри `createDMHandler` (после проверки существования диалога в транзакции, где ранее проверялся только `StatusPending`):
  ```go
  if !acc.CanPostGlobally() {
      if acc.Status == auth.StatusPending {
          return 0, nil, forbiddenError(
              "a pending account cannot start a conversation; it can only answer one that was started for it")
      }
      return 0, nil, forbiddenError(
          "email verification is required to start a new conversation; you can answer existing conversations")
  }
  ```

#### Шаг 5. Черновики (`run.go` и `drafts.go`)
- В `run.go` на роутах черновиков заменить `RequirePermission(auth.PermPostReply)` на стандартную проверку авторизации.
- В `upsertDraftHandler` и `publishDraftHandler` внедрить вызов `categoryWriteAllowed(..., auth.PermPostReply)`.

---

### 4.2. Фронтенд (React / UI)

#### Шаг 6. Единые признаки в `AuthProvider.jsx`
- В контекст `AuthProvider` передаются структурированные флаги:
  - `emailUnverified`: `rec.verified === false` (уже есть);
  - `isPendingApproval`: `profile?.status === 'pending'`;
  - `canPostGlobally`: `isStaffRole(profile?.role_id) || (profile?.status === 'active' && profile?.verified === true)`;
- Обновить клиентскую реализацию `hasPermission(perm, { category })`:
  Для прав записи (`PERMISSIONS.CREATE_TOPIC`, `PERMISSIONS.POST_REPLY`):
  - Если передан `category`:
    - При `!canPostGlobally`: проверять `cat?.permissions?.[perm]?.includes('guest')`. Если да — `true`, иначе `false`.
    - При `canPostGlobally`: проверять по обычной схеме (`override.includes(effectiveRoleId)` либо глобальные права).

#### Шаг 7. Адаптация интерфейсов страниц
1. **Страница темы (`TopicPage.jsx`):**
   - В темах категории `gostevaya`: форма ответа активна для всех (включая pending и unverified).
   - В остальных категориях для `!canPostGlobally` форма ответа заменяется на информационную плашку с чётким разделением причин:
     - Если `isPendingApproval && !emailUnverified`: *«Ваш аккаунт ожидает подтверждения модератором. Вы можете общаться в Гостевом разделе.»*
     - Если `emailUnverified`: *«Для участия в обсуждениях этого раздела подтвердите email. [Отправить письмо повторно]. Вы можете общаться в Гостевом разделе.»*
2. **Страница категории (`CategoryPage.jsx`):**
   - Кнопка «Новая тема» активна в гостевом разделе; в остальных разделах скрывается для `!canPostGlobally` с подсказкой при наведении/в шапке.
3. **Профиль пользователя (`ProfilePage.jsx`):**
   - Кнопка «Написать» (создание нового диалога) для `!canPostGlobally` блокируется/скрывается с подсказкой («Открытие новых диалогов недоступно до подтверждения email / одобрения аккаунта»).
4. **Центр сообщений (`DirectMessages.jsx`):**
   - Пользователь видит существующие диалоги и может отправлять сообщения. Попытка создать новый диалог выводит понятное уведомление, а не техническую ошибку.
5. **Страница ожидания (`PendingPage.jsx`):**
   - Исправить логику кнопки «Проверить статус»: не перенаправлять на главную страницу при `verified === true`, если `settings.requireApproval === true` и `profile.status === 'pending'`. Отображать: *«Email подтверждён. Ожидайте одобрения администратором»*.

---

## 5. Тестирование и гейты верификации

### 5.1. Бэкенд-тесты (`go test`)
1. **Тесты категорийной политики (`email_verification_gate_test.go` и `category_access_test.go`):**
   - Активный неподтверждённый игрок (`active`, `verified=false`) создаёт тему в обычной категории → 403 Forbidden.
   - Активный неподтверждённый игрок создаёт тему в `gostevaya` (`guest` в override) → 201 Created.
   - Pending игрок (`pending`, `verified=false` или `verified=true`) создаёт тему в `gostevaya` → 201 Created.
   - Pending игрок создаёт тему в категории с override `["player"]` (без `guest`) → 403 Forbidden.
2. **Тесты личных сообщений (`dms_test.go`):**
   - Неподтверждённый аккаунт пытается создать новый диалог → 403 Forbidden с понятным текстом.
   - Стафф создаёт диалог с неподтверждённым аккаунтом → 201 Created.
   - Неподтверждённый аккаунт отвечает в созданном стаффом диалоге → 200 OK.
3. **Тесты черновиков (`drafts_test.go`):**
   - Сохранение и публикация черновика в гостевой теме для pending/unverified → 200 OK.
   - Сохранение и публикация черновика в обычной теме для pending/unverified → 403 Forbidden.

### 5.2. Фронтенд-тесты и линтинг
- `npm run lint:js`
- `npm test` (включая проверку целостности осей ролей и статусов `scripts/check-account-status-axis.mjs`).

---

## 6. Резюме архитектурных преимуществ

1. **Никакой подмены данных:** Роль пользователя остаётся `player`, статус — `pending` или `active`, флаг `verified` отражает реальность.
2. **Полная прозрачность:** Вся логика опирается на понятную доменную функцию `CanPostGlobally()` и проверку наличия маркера открытой зоны (`guest`) в категории.
3. **Устойчивость к изменению настроек форума:** Любые переключения `require_approval` корректно обрабатываются матрицей состояний без дополнительных условий.
4. **Безупречный UX:** Пользователю больше не нужно выходить из системы, чтобы написать в гостевой теме, а стафф может связаться с новым участником в ЛС до его полной верификации.
