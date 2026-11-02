# Анализ множественных HTTP-запросов при инициализации главной страницы (продакшен)

Дата: 11/1/2026  
Автор: Cline  
Статус: **v3 — все наблюдения — продакшен-факты. StrictMode исключён из объяснений.**
Объект: форум Aerun, живой релиз на VPS (продакшен)

> **Исправления v1 → v3 (результат перепроверки):**
> 1. `heartbeat` ×2 → на самом деле **×3** плюс один скрытый `POST guest/leave`. Общая корневая причина — **двойной `syncUserFromAuthStore`** (п. 4.0 — новая находка).
> 2. «`realtime` ×N — каждый вызов открывает своё SSE-соединение» — **неверно**. PocketBase SDK (v0.28.1) мультиплексирует ВСЕ подписки через ОДИН `EventSource`. Каждый вызов стоит лишь 1 POST-регистрацию + 1 watcher-интервал (п. 4.3).
> 3. `unread-counts` ×2 — **трассировка кода даёт ×1** на холодный старт (п. 4.6). Наблюдаемый продакшен-×2 помечен как **НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ**: текущий код не воспроизводит его, требуется замер с колонкой Initiator / лог сервера (п. 10). Никаких списываний на StrictMode.
> 4. `designs` ×2 — **трассировка кода даёт ×1** (единственный caller, deps `[]`, п. 4.4). Наблюдаемый продакшен-×2 помечен как **НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ**. Реальный подтверждённый дефект здесь — write-only кэш: ЛЮБОЙ повторный mount DesignProvider добавляет +1 fetch.

---

## 1. Контекст

На живом сайте (VPS-релиз, продакшен) при открытии главной страницы залогиненным пользователем в первые 1–2 секунды фиксируется всплеск сетевых запросов. На скриншотах DevTools (Network, Fetch/XHR) видно:

- `auth-refresh`
- `settings`
- `roles`
- `me`
- `heartbeat` (повторяется)
- `status`
- `forum-index` (×2)
- `forum-stats` (×2)
- `unread-counts` (×2 в наблюдениях)
- `realtime` (SSE, включая `25xtkoqluxy9gz`)
- `designs` (×2 в наблюдениях)

Всего в первой секунде доходит до 20–30 запросов, часть из них дублируется.

### Важное уточнение (аксиома аудита v3)

**StrictMode не рассматривается.** Снимки сняты с релиза на VPS; production-сборка не выполняет double-invoke эффектов, поэтому каждая наблюдаемая дупликация (×2, ×3) обязана иметь реальную причину в коде или в сетевой конфигурации. Там, где трассировка кода даёт ×1, а наблюдение — ×2, находка помечается как **НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ** и требует замера (п. 10) — но не списывается на dev-артефакты.

---

## 2. Архитектурный контекст

- **Стек:** React 19 + Vite + PocketBase
- **Точка входа:** `src/main.jsx` — `<StrictMode>` в исходнике, в production-сборке не активен (не источник наблюдаемых дублей)
- **Главная страница:** `src/pages/MainPage.jsx`, обёрнута в `Layout` + `AuthProvider`
- **Клиентский API:** `src/api/pocketbase.js` (`sendApi` на базе `fetch`)
- **Общий опросный ресурс:** `src/api/shared-poll.js` (`sharedPool(name, options)`)

---

## 3. Сводная таблица: реальные частоты на холодном старте участника (продакшен)

Все частоты перепроверены по коду.

| Endpoint | Источник | Реальная частота |
|---|---|---|
| `POST /api/collections/users/auth-refresh` | `AuthProvider.jsx:262-287` → `restoreSession()` | ×1 |
| `GET /api/aerun/settings` | `AuthProvider.jsx` → `getGlobalSettings()` (модульный кэш в `admin.js`) | ×1 |
| `GET /api/aerun/roles` | `AuthProvider.jsx` → `subscribeToRoles()` | ×1 |
| `GET /api/aerun/users/{uid}` | `AuthProvider.jsx:236` → `syncUserFromAuthStore()` → `refreshOwnProfile()` (single-flight) | ×1 |
| `GET /api/aerun/me` | `AuthProvider.jsx:322-326` → `subscribeToEffectivePermissions()` | **×2** — гость → участник, два разных ресурса sharedPool (п. 4.5) |
| `POST /api/aerun/presence/heartbeat` | `AuthProvider.jsx:331-336` | **×3**: гость ×1 + участник ×1 (sync #1) + участник ×1 (sync #2) (п. 4.1) |
| `POST /api/aerun/presence/guest/leave` | переходный эффект `AuthProvider.jsx:~362-376` | **×1** (в v1 отсутствовал) (п. 4.1) |
| `GET /api/aerun/status` | `rtdb-presence.js` → `statusPoll` (общий sharedPool) | ×1 |
| `GET /api/aerun/forum-index` | `AuthProvider.jsx:953-955` → `refreshForumState(true)` | **×2** (п. 4.2) |
| `GET /api/aerun/forum-stats` | там же | **×2** (п. 4.2) |
| `GET /api/aerun/me/unread-counts` | `AuthProvider.jsx:382-400` + `TitleProvider.jsx` → ОДИН общий sharedPoll | **×1 по коду; наблюдение ×2 = НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ** (п. 4.6, п. 10) |
| `GET /api/aerun/designs` | `DesignProvider.jsx:20-28` → `getDesigns()` | **×1 по коду; наблюдение ×2 = НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ. Write-only кэш — подтверждённый дефект** (п. 4.4) |
| `GET /api/realtime` (SSE) | PocketBase SDK — одно соединение на всё приложение | **×1 SSE + 2 POST-регистрации** (п. 4.3) |

---

## 4. Почему дублируются запросы (корневые причины, перепроверено)

### 4.0. ДВОЙНОЙ sync — общая корневая причина (НОВОЕ, главная находка v2)

**Файл:** `src/contexts/AuthProvider.jsx:262-287`

```jsx
useEffect(() => {
  // ...
  pb.authStore.onChange(() => syncUserFromAuthStore());  // триггер №1
  restoreSession().then(() => syncUserFromAuthStore());  // триггер №2
}, []);
```

`restoreSession()` вызывает `pb.collection('users').authRefresh()`. Внутри SDK `authRefresh()` делает `pb.authStore.save(...)` → `onChange` срабатывает **во время** `await`, а затем `.then(...)` вызывает sync ещё раз. Итого **два подряд** `syncUserFromAuthStore()`:

- **sync #1** — через `onChange` (сразу после сохранения токена внутри `authRefresh`);
- **sync #2** — через `.then(...)` после завершения `restoreSession()`.

Каждый sync создаёт НОВЫЕ объекты `user` и `profile` (`setUser({uid: rec.id, ...})`, `setProfile({...rec})`). Даже если данные идентичны, ссылки на объекты меняются → все эффекты, зависящие от `user`/`profile`, перезапускаются. Отсюда:

- второй `initRtdbPresence` → лишний heartbeat (п. 4.1);
- лишние ре-рендеры всего дерева.

**Вывод:** sync должен быть идемпотентным: если данные записи не изменились — не вызывать `setUser`/`setProfile` вовсе.

### 4.1. `heartbeat` ×3 + скрытый `guest/leave` ×1 (поправка v1: считалось ×2)

**Файлы:** `src/contexts/AuthProvider.jsx:331-336` (эффект presence), `:~362-376` (переходный эффект), `src/api/rtdb-presence.js` (`initRtdbGuestPresence` делает `beat()` немедленно при инициализации; `initRtdbPresence` (`:418`) делает `await sendHeartbeat()` немедленно).

Хронология холодного старта участника:

| Шаг | Событие | HTTP |
|---|---|---|
| 1. mount | `user === null` → гостевой путь: `initRtdbGuestPresence()` → немедленный `beat()` | `POST heartbeat` (гость) — №1 |
| 2. sync #1 (onChange) | `setUser(rec)` → новый `user` → presence-эффект перезапускается → участник: `initRtdbPresence()` → немедленный `sendHeartbeat()` | `POST heartbeat` (участник) — №2 |
| 3. переходный эффект | `previousUidRef`: `null → uid`, гость существовал (шаг 1) → `removeRtdbGuestPresence()` | `POST presence/guest/leave` — №3 |
| 4. sync #2 (.then) | новые `user`/`profile` → presence-эффект перезапускается → `initRtdbPresence()` снова | `POST heartbeat` (участник, дубль) — №4 |

**Итог: 4 POST-запроса presence при холодном старте участника** (v1 считал 2). После Фаз 1–2 плана: **1 heartbeat** (участник), 0 guest-запросов.

### 4.2. `forum-index` ×2 / `forum-stats` ×2 — подтверждено (v1 верно)

**Файл:** `src/contexts/AuthProvider.jsx:951-955`

```jsx
const identityKey = `${user?.uid || ''}|${profile?.role_id || ''}|${profile?.status || ''}`;

useEffect(() => {
  refreshForumState(true);
}, [identityKey, refreshForumState]);
```

При инициализации `identityKey` принимает ДВА значения: сначала `'||'` (пока `profile === null`), затем `'uid|role|status'` после sync → эффект срабатывает дважды.

`refreshForumState(true)` вызывает `Promise.all([fetchForumIndex(), fetchForumStats()])` — один логический вызов = 2 параллельных HTTP-запроса.

Двойной вызов `refreshForumState(true)` при монтировании: `force=true` обходит cooldown, а `forumRefreshInFlightRef` ставит второй вызов в очередь → дубли **последовательные, не параллельные**. Итого **4 GET** (2+2) на холодный старт.

### 4.3. `realtime` — ВАЖНАЯ ПОПРАВКА v1: SSE-соединение ОДНО, а не ×N

**Файлы:** `src/api/realtime-signals.js`, `node_modules/pocketbase/dist/pocketbase.esm.js` (v0.28.1), `src/api/rtdb-presence.js`

Проверено по исходникам SDK: `pb.realtime` — синглтон с ОДНИМ `EventSource` (`this.eventSource = new EventSource(buildURL('/api/realtime'))`); все подписки мультиплексируются через `lastSentSubscriptions` и один `clientId`.

**Что РЕАЛЬНО стоит каждый вызов `subscribeToRealtimeSignals()`:**
1. одна SDK-подписка → `POST /api/realtime` (регистрация, передаёт ПОЛНЫЙ список подписок);
2. один `setInterval(5000)` watcher (`CONNECTION_POLL_MS`, `realtime-signals.js`).

Точки вызова (8 мест в коде, все перепроверены grep-ом): `dms.js:154, 233, 391, 500`; `forum.js:191`; `rtdb-notifications.js:62, 99`; `AuthProvider.jsx:1055`. На главной странице активно 2 (dm-unread + AuthProvider) → 2 POST-регистрации + 1 SSE GET.

**Скриншот с 8 GET-запросами к `/api/realtime`** — это НЕ 8 соединений: это переподключения одного EventSource из-за QUIC-ошибки прокси (браузер переоткрывает соединение). Подробнее п. 8 и протокол верификации п. 10.

### 4.4. `designs` — подтверждённый write-only кэш + НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ ×2

**Файлы:** `src/contexts/DesignProvider.jsx:20-28`, `src/api/designs.js`, `src/main.jsx:32` (DesignProvider монтируется один раз на уровне корня)

**Что говорит код (трассировка):**
- `getDesigns()` вызывается ровно из одного места — эффект DesignProvider с deps `[]`.
- `getDesigns()` ПОСЛЕ fetch пишет результат в `_cachedDesigns`, но **никогда его не читает**.
- Холодный старт в продакшене по коду: **×1** fetch.

**Два отдельных факта, которые нельзя смешивать:**
1. **Подтверждённый дефект (кэш write-only):** любой будущий remount DesignProvider (например, при реструктуризации дерева провайдеров) даст повторный fetch вместо кэш-хита. Фикс — чтение кэша (Фаза 3).
2. **НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ (наблюдение ×2 vs код ×1):** по коду продакшен-холодный старт должен давать один fetch. Если на релизе реально видно ×2, причина не в коде DesignProvider — требуются замеры из п. 10 (Initiator, тайминги, лог сервера) для локализации источника.

### 4.5. `me` ×2 — подтверждено (v1 верно)

**Файл:** `src/api/auth-resources.js:474`

```js
export const subscribeToEffectivePermissions = (uid, callback) => {
  const key = uid || 'guest';
  const poll = sharedPool(`effective-permissions:${key}`, {...});
```

При mount `user === null` → создаётся ресурс с ключом `'guest'` → первый GET. После sync `user.uid` известен → создаётся РАЗНЫЙ ресурс `'uid'` → второй GET. Дедупликации нет, т.к. ключи разные. Фикс — гейт на `restored` (Фаза 2).

### 4.6. `unread-counts` — код даёт ×1; наблюдение ×2 = НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ

**Файлы:** `src/contexts/AuthProvider.jsx:382-400`, `src/contexts/TitleProvider.jsx:95-120`, `src/api/dms.js:195, 268-269`

**Полная трассировка кода (production, cold start участника):**
1. `AuthProvider` и `TitleProvider` подписываются на **ОДИН** ресурс `sharedPoll('dm-unread:{uid}')` (TitleProvider через два ветвления эффекта, Navbar через алиас `subscribeToDmUnread = subscribeToUnreadCounts`, `dms.js:269`).
2. Механика `sharedPoll`: второй и последующие подписчики получают кэшированное значение; `start()` выполняет `read()` только для первого подписчика (`shared-poll.js:315-377, 395-410`). Приостановка ресурса (`stop()` при 0 подписчиков) НЕ сбрасывает кэш.
3. Трассировка эффектов при cold start: AuthProvider подписывается первым (fetch №1), TitleProvider в том же коммите подписывается кэш-хитом. Гость→участник не создаёт второй fetch: гость не подписывается вовсе (ветка `if (!user?.uid)`), участник подписывается один раз.
4. **Итог по коду: ×1 GET на холодный старт.**

**Что это значит для аудита:** если на релизе наблюдается ×2 — причина НЕ в дублировании подписок (архитектура здесь корректна). Кандидаты для проверки по п. 10:
- пересоздание эффекта TitleProvider из-за нестабильной зависимости `hasPermission` (переподписка с дропом ресурса до 0 подписчиков невозможна, пока AuthProvider держит подписку, но требует подтверждения таймингами);
- наличие второго сетевого маршрута/прокси-повтора (сеть, не код);
- неточность в исходном наблюдении (два разных ресурса `dm-unread:{uid}` при смене uid в той же сессии — легитимно, но это не cold start).

---

## 5. Что НЕ является багом

| Элемент | Почему не баг |
|---|---|
| **Дублирование подписок `unread-counts`** | Архитектура корректна: AuthProvider + TitleProvider + Navbar сидят на ОДНОМ ресурсе sharedPoll; второй подписчик не делает fetch (`shared-poll.js:395-410`). Наблюдение ×2 — вопрос верификации (п. 10), не кода |
| **sharedPoll для `status`, `effective-permissions`** | Архитектура правильная — второй подписчик одного ресурса не делает лишнего запроса |
| **Периодические опросы** | heartbeat каждые 60 с, status каждые 20 с, unread-counts каждые 15 с — нормальное поведение после инициализации |
| **`refreshForumState(true)` с force** | Обход cooldown здесь НАМЕРЕННЫЙ и нужен для logout/role-change; фиксом не трогать |

---

## 6. ПЛАН РЕАЛИЗАЦИИ (пошаговый, для исполнителя любого уровня)

### 6.0. Общие правила для исполнителя

- Менять ТОЛЬКО файлы и фрагменты, указанные в шагах; ничего не рефакторить «по пути».
- После КАЖДОЙ фазы запускать проверки из п. 6.6. Фаза считается готовой, только если все проверки прошли.
- НЕ менять семантику `force` в `refreshForumState` — обход cooldown там намеренный.
- НЕ удалять существующие эффекты — только гейтить их и делать sync идемпотентным.
- Комментарии в коде писать в стиле существующего кода (пояснение «почему», а не «что»).
- Все регулярки в `scripts/check-*.mjs`, привязанные к deps-массивам, обновлять ВМЕСТЕ с кодом (иначе гейт-скрипты сломают CI).

### 6.1. Фаза 1 — Идемпотентный `syncUserFromAuthStore` (устраняет дубль heartbeat)

**Файл:** `src/contexts/AuthProvider.jsx`

**Шаг 1.1.** Рядом с существующими refs до `syncUserFromAuthStore` (≈строка 236) добавить:

```jsx
// Сигнатура последнего sync: если запись authStore не изменилась, повторный
// sync не должен создавать новые объекты state и перезапускать подписчики.
const lastSyncedSignatureRef = useRef(null);
```

**Шаг 1.2.** В начале тела `syncUserFromAuthStore` (сразу после получения `rec = pb.authStore.record`) добавить гейт:

```jsx
const signature = rec
  ? [rec.id, rec.verified, rec.role_id, rec.status, rec.nickname, rec.settings?.theme].join('|')
  : 'guest';
if (signature === lastSyncedSignatureRef.current) {
  return; // sync идемпотентен: данные не менялись — state не трогаем
}
lastSyncedSignatureRef.current = signature;
```

Примечание для исполнителя: logout (`rec = null`) даёт сигнатуру `'guest'`, которая отличается от любой сигнатуры участника, поэтому гостевой reset выполнится корректно. Если в проекте есть поля, влияющие на UI и меняющиеся отдельно от этих, — включить их в сигнатуру.

**Шаг 1.3.** Проверка: `grep -n "syncUserFromAuthStore" src/contexts/AuthProvider.jsx` — убедиться, что sync вызывается только из двух мест (onChange и `.then`), гейт отсекает второй.

**Результат фазы:** heartbeat участника ×2 → ×1; лишний ре-рендер после restore исчезает.

### 6.2. Фаза 2 — Гейт гостевой фазы на `restored` (устраняет guest-запросы и `/me` ×2)

**Файл:** `src/contexts/AuthProvider.jsx`

**Шаг 2.1.** Рядом с другими `useState` добавить:

```jsx
// Сессия восстановлена: до этого все эффекты, зависящие от идентичности,
// обязаны ждать — иначе они успевают отработать в гостевой фазе и создать
// запросы, которые потом приходится дублировать или отменять.
const [restored, setRestored] = useState(false);
```

**Шаг 2.2.** В КОНЦЕ тела `syncUserFromAuthStore` (после всех веток if/else) добавить:

```jsx
setRestored(true); // идемпотентно: повторный set того же значения — no-op
```

**Шаг 2.3.** Добавить `if (!restored) return;` (или ранний cleanup-возврат) и `restored` в deps для:
- a) эффекта прав (`subscribeToEffectivePermissions`, ≈322-326): deps `[user?.uid, restored]`;
- b) presence-эффекта (≈331-336): deps `[user?.uid, profile, getOrCreateGuestId, restored]`;
- c) эффекта форума по `identityKey` (≈953-955): deps `[identityKey, refreshForumState, restored]`;
- d) переходного эффекта (`previousUidRef`, ≈362-376): deps `[user?.uid, restored]`.

**Шаг 2.4.** Устранить лишний `guest/leave`. Для этого:
- рядом с `previousUidRef` добавить `const guestPresenceStartedRef = useRef(false);`;
- в guest-ветке presence-эффекта, ПЕРЕД `return initRtdbGuestPresence(...)`, установить `guestPresenceStartedRef.current = true;`;
- в переходном эффекте перед `removeRtdbGuestPresence(...)` добавить `if (!guestPresenceStartedRef.current) return;`;
- при входе в участника-ветку переходного эффекта сбросить `guestPresenceStartedRef.current = false;`.

**Шаг 2.5.** ОБНОВИТЬ гейт-скрипты:
- `scripts/check-identity-refresh.mjs:52` содержит регулярку `/\[identityKey, refreshForumState\]/` → заменить на `/\[identityKey, refreshForumState, restored\]/`;
- `grep -rn "refreshForumState\]" scripts/` и `grep -rn "user?.uid, profile" scripts/` — обновить любые утверждения о deps.

**Результат фазы (участник):** 0 guest-heartbeat, 0 guest/leave, 1 member heartbeat, `/me` ×1, forum ×1+×1.
**Результат фазы (гость):** guest-пути выполняются один раз после restore; поведение корректное.

### 6.3. Фаза 3 — `designs`: чтение кэша

**Файл:** `src/api/designs.js`, функция `getDesigns` (≈85-95).

В начало функции добавить:

```js
if (_cachedDesigns) return _cachedDesigns; // read path для уже записанного кэша
```

Проверить: мутации дизайнов идут через `notifySubscribers` → refetch — кэш их не заблокирует.

### 6.4. Фаза 4 (опционально, после стабилизации 1–3) — realtime hub

Цель: 2 POST-регистрации на главной → 1. Реализация: module-level hub в `realtime-signals.js` — `Set` колбэков, единственная внутренняя SDK-подписка, один watcher. Подробные шаги — отдельная задача, не блокирует Фазы 1–3.

### 6.5. Фаза 5 — QUIC (серверная настройка, без кода)

`ERR_QUIC_PROTOCOL_ERROR 200 (OK)` на `/api/realtime`: одно SSE-соединение несёт ВСЕ подписки, его обрыв рвёт всё сразу и порождает шторм переподключений. Рекомендации:
- в Cloudflare отключить HTTP/3/QUIC для маршрута `/api/realtime` (Rule → отключить HTTP/3, либо проксировать SSE через TCP);
- проверить `proxy_read_timeout` и буферизацию nginx-прокси (для SSE требуется `X-Accel-Buffering: no`).

### 6.6. Проверки после каждой фазы (обязательный чек-лист)

```bash
node scripts/check-identity-refresh.mjs
node scripts/test-shared-poll.mjs
node scripts/test-inflight-guard.mjs
npm run build
```

Плюс ручная проверка в продакшен-сборке (DevTools → Network, фильтр XHR): открыть главную страницу залогиненным и убедиться, что за первые 2 секунды нет гостевого heartbeat, нет дублей forum-index/forum-stats, нет двух `/me`.

---

## 7. Вывод (обновлено)

«Взрыв» запросов = комбинация:
1. Двойной `syncUserFromAuthStore` (onChange + .then) — новые объекты state на каждый sync → дубли presence.
2. Двухфазная инициализация без гейта — гостевые эффекты (`/me`, heartbeat, форум) успевают сработать до восстановления сессии.
3. Write-only кэш designs — remount → refetch.
4. Realtime: НЕ «×N соединений» (поправка v1) — одно соединение, но по 1 POST-регистрации и 1 watcher на каждый вызов; скриншот с 8 GET — шторм переподключений из-за QUIC.

Наибольший эффект дают Фазы 1–2 (устраняют 4 лишних presence-запроса, гостевую фазу `/me` и половину форумных дублей). Фаза 3 — одна строка. Фазы 4–5 — по остаточному принципу.

---

## 8. Привязка к скриншоту (переписано)

8 GET к `https://aerun-world.com/api/realtime` с `net::ERR_QUIC_PROTOCOL_ERROR 200 (OK)`:

- это ОДНО SSE-соединение SDK, которое браузер многократно переоткрывает из-за QUIC-ошибки прокси;
- «8 потоков» ≠ «8 подписчиков»; количество вызовов `subscribeToRealtimeSignals` влияет на POST-регистрации, а не на SSE-соединения.

Приоритет: сначала Фазы 1–2 (клиентские дубли), затем QUIC (Фаза 5). Если QUIC не чинить, шторм переподключений останется даже после Фаз 1–3.

---

## 9. Связанные документы и чек-лист валидации

- `markdowns/Archive/ARCHIVE_ENDPOINT_PAYLOAD_AUDIT.md` — аудит эндпоинтов и фиксация payloads (исторический документ; его вывод об удвоении подлежит ревизии по протоколу п. 10, не списывать на dev-артефакты)
- `scripts/test-shared-poll.mjs` — проверка, что ресурсы sharedPool не дублируют запросы
- `scripts/test-inflight-guard.mjs` — тест single-flight для `refreshForumState`
- `scripts/check-identity-refresh.mjs` — гейт-скрипт: требует deps `[identityKey, refreshForumState]` (обновить при Фазе 2!)

### Чек-лист после всех фаз (ручная проверка, DevTools, прод-сборка)

| Endpoint | До | После |
|---|---|---|
| heartbeat | ×3 | ×1 |
| guest/leave | ×1 | ×0 |
| me | ×2 | ×1 |
| forum-index | ×2 | ×1 |
| forum-stats | ×2 | ×1 |
| unread-counts | ×1 по коду (наблюдение ×2 — п. 10) | ×1 подтверждён замером |
| designs | ×1 по коду (наблюдение ×2 — п. 10) | ×1 подтверждён замером + кэш работает |
| realtime SSE | 1 + reconnect-шторм | 1 (после Фазы 5 — без шторма) |

---

## 10. Протокол верификации наблюдений (п. 10)

Назначение: отличить реальный дефект кода от расхождения «код ×1 vs наблюдение ×2» и локализовать причину. Применяется к `unread-counts` (п. 4.6), `designs` (п. 4.4) и `/api/realtime` (п. 4.3, п. 8). Выполняется на прод-релизе, НЕ в dev-сборке.

### 10.1. Замер 1 — DevTools Network с колонкой Initiator

1. Открыть `https://aerun-world.com` в инкогно-вкладке (чистый кэш), войти участником.
2. DevTools → Network → Fetch/XHR. Включить колонки **Initiator** и **Time** (правый клик по заголовку таблицы).
3. Очистить лог (🚫) и перезагрузить страницу (Ctrl+Shift+R).
4. Для каждого дублирующегося запроса записать: `endpoint`, `Initiator` (файл:строка), `Start Time`, `Time`.

**Интерпретация для `unread-counts`:**
- Инициаторы обоих запросов = `dms.js` (одна точка, `sharedPoll('dm-unread:{uid}')`) И ТАЙМИНГИ совпадают в пределах ~100 мс → несовместимо с кодом; искать сетевой повтор (п. 10.3).
- Инициаторы различаются (например, `TitleProvider.jsx` и `Navbar.jsx`) → в продакшен-сборке маппинг строки не прямой; смотреть `shared-poll.js` в стеке. Если оба входят через один `read()` → сетевой повтор.
- Разные временные окна (> 2 с) → не cold start; возможен рефetch по `refreshUnreadCounts` после действия — это не баг инициализации.

**Интерпретация для `designs`:**
- Один запрос с Initiator → `DesignProvider.jsx` — ожидаемо (×1 по коду).
- Два запроса → сравнить Initiator и тайминги. Если оба → mount DesignProvider, проверять дерево провайдеров на уровне App (`main.jsx:32`) — remount возможен только при изменении структуры, чего в релизе быть не должно. Это несовместимо с кодом → сетевой повтор (п. 10.3).

### 10.2. Замер 2 — лог сервера (PocketBase / nginx)

1. На VPS: `grep -c "unread-counts" <логPocketBase>` и `grep -c "designs"` за один cold start-интервал (например, 5-минутное окно после перезапуска).
2. Если логов два на один init — определить, дошли ли оба до PocketBase:
   - оба дошли → источник повторов на стороне клиента/сети между браузером и сервером;
   - дошел один → наблюдение ×2 в DevTools было неточным (например, двойное логирование ответа).

### 10.3. Замер 3 — сетевой повтор (прокси/VPS)

1. Проверить Cloudflare/nginx: включён ли retry-on-error или HTTP/3/QUIC для статических/API-маршрутов (см. п. 8 — QUIC-ошибка уже подтверждена для `/api/realtime`).
2. Повторить замер п. 10.1 с отключённым HTTP/3 (или через другой канал) — если ×2 исчезает, причина в прокси-повторах, а не в коде.

### 10.4. Правило записи результата

| Результат замера | Классификация | Действие |
|---|---|---|
| Код ×1 = наблюдение ×1 | Норма | Обновить таблицу п. 3, снять метку расхождения |
| Код ×1, наблюдение ×2, Initiator один и тот же | Сетевой повтор | Внести в п. 8 (инфраструктура), Фаза 5 |
| Код ×1, наблюдение ×2, Initiator различаются | Дефект кода (новая ветка) | Открыть новый пункт аудита с трассировкой Initiator-файла |
| Замер не проводился | НЕВЕРИФИЦИРОВАННОЕ РАСХОЖДЕНИЕ | Оставить метку; не считать закрытым |
