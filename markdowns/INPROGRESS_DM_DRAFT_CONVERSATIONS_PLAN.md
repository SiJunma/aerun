# Драфтовые диалоги ЛС (черновик до первого сообщения)

Статус: **IN PROGRESS — заморозка 2026-10-14 (сессия 1)**.
Файл: `INPROGRESS_DM_DRAFT_CONVERSATIONS_PLAN.md` (переименован из `TODO_...`).
Легенда чекбоксов: `[x]` — закрыт полностью; `[~]` — код сделан, чекпоинт не
закрыт; `[ ]` — не начато/не сделано. Прогресс, находки и план следующей
сессии — в конце файла, раздел «Прогресс сессии 2026-10-14».

Код готов для S1, S2, S3, S5, S7 (+частично S4: хелперы уже в `dms.go`).
Не сделано: доделка S4 (re-check в `createDMHandler` + Go-тест), S6, S8, S9.

## Проблема

Открытие нового диалога прямо сейчас отправляет юзеру системное сообщение
«Conversation started» и уведомляет второго участника, хотя первый участник
ещё ничего не написал. Недопустимо: диалог не должен существовать в БД и быть
виден собеседнику до первого реального сообщения.

## Источники (прочитано перед составлением плана)

- `src/api/dms.js:27-64` — `getOrCreateConversation`: known-список →
  `GET /api/aerun/conversations/peer/{uid}` → при пустом ответе
  `POST /api/aerun/dms` с `text: 'Conversation started'` (L52-63). **Это и есть
  корень проблемы.**
- `src/components/dm/DirectMessages.jsx`:
  - `L155-176` — `subscribeToPeerCard` (шапка чата, статус пира);
  - `L201-207` — эффект автозапуска чата (`mode==='chat'` → `openChat`);
  - `L221-225` — регистрация `activeChatId` в AuthProvider (бейдж непрочитанного);
  - `L227+` — подписка `subscribeToDmMessages(activeChatId, …)`;
  - `L269-286` — `peerInfo` из peer-карты;
  - `L426-465` — `openChat` (done-ref / inflight-ref / `getOrCreateConversation`);
  - `L468-476` — `openInboxConversation` (навигация на `/messages/${peerUid}` →
    тот же `openChat`);
  - `L564-640` — `handleSend` (latch + `sendDmMessage` + append + оба refresh);
  - `L642-668` — `handleConfirmDelete` (optimistic remove + `deleteConversation`);
  - `L686-700` — фильтры `visibleMessages` / `visibleConversations`
    (**`lastMs === null → false` — строка без `lastTimestamp` невидима**);
  - `L792-795` — пустой чат (`dm.empty_chat`), `L982-1033` — композер,
    `L1036+` — ConfirmModal, `L1096+` — строки inbox.
- `src/pages/MessagesPage.jsx`, `src/App.jsx:129-130` — роуты
  `/messages`, `/messages/:uid`; кнопки «Написать ЛС» (профиль, участники)
  просто навигируют на `/messages/:uid`.
- `backend/internal/platform/pocketbase/dms.go`:
  - `createDMHandler` L454-632: конверсация + участники + seed-сообщение
    (L569-598), далее `publishSignal(dm.post)` + `maybeEnqueueDMEmail`
    (L600-621); in-app нотификаций у ЛС нет по дизайну (комментарий L602);
  - `sendDMMessageHandler` L635-810: тот же паттерн signal+email (L783-800);
  - `findConversationWithPeerHandler` L1056-1096 — read-only резолв;
  - `clearConversationHandler` ~L1204 — «удаление» реального диалога;
  - роуты `run.go:450-455`.
- `src/i18n/dictionary.js` — блоки `dm.*` (~L354-361 en, ~L1162-1169 ru).
- `scripts/check-dm-mutation-state.mjs` — гейт контракта «мутация возвращает
  строку, которую записала» для `handleSend`/`handleEdit`/`handleDelete`.
- `markdowns/TESTING_DM_FIX_PLAN.md` — S2: серверный дедуп `POST /dms`
  сознательно НЕ делался (см. «Открытые решения»).
- Правила `.agent/rules/AGENTS.md`: zero silent failures; модуль с рантаймом
  получает тест, который его **исполняет**; бэкенд-изменения верифицируются через
  CI `ci-report`; при противоречии плана и кода — спросить владельца.

## Требования (acceptance criteria)

1. Новый диалог без сообщений виден только открывшему его участнику. Второй
   участник видит диалог только после первого отправленного сообщения.
2. Диалог без сообщений НЕ пишется в БД. Он драфтовый; интерфейс знает о нём
   только из localStorage — этого достаточно, чтобы отрисовать его «созданным,
   но пустым» при навигации и перезагрузке.
3. Оба участника могут независимо открыть драфтовый диалог друг с другом —
   конфликта в БД нет (пишет только первый отправитель). Драфт второго
   участника коннектится/сливается с реальным диалогом из БД.
4. Удаление драфтового диалога — чисто клиентская операция (localStorage),
   ничего не триггерит в БД; его можно спокойно открыть снова.
5. Повторное нажатие «Написать ЛС» переоткрывает тот же драфт, а не создаёт
   копию. Дублирования на клиенте быть не должно.
6. Несколько драфтовых диалогов с разными участниками — норма.
7. Первое уведомление в новом диалоге — **бейдж на иконке ЛС в хедере**
   (счётчик непрочитанного) — срабатывает только когда первое сообщение
   отправлено и диалог создан в БД. Дальше — как обычно. (Под «уведомлением
   для ЛС» здесь и далее всегда понимается бейдж на иконке новых сообщений,
   а не запись на странице уведомлений; in-app записей в `notifications` для
   ЛС нет по дизайну. Realtime-сигнал `dm.post` и DM-емейл — механизм
   доставки.)
8. Текст, набранный в композере ЛС, автосохраняется по тому же принципу,
   что и черновик ответа в теме (`reply_draft_${id}_${uid}` в TopicPage) —
   для реальных и драфтовых диалогов — и восстанавливается при возврате.

## Текущее поведение (для контраста)

```
Открыли /messages/:uid
  → openChat (DirectMessages.jsx:426)
  → getOrCreateConversation (dms.js:27)
      known-список → нет
      GET /conversations/peer/{uid} → "" (нет диалога)
      POST /api/aerun/dms { text: 'Conversation started' }   ← СЮДА
  → createDMHandler (dms.go:454): конверсация + участники + seed-сообщение
      + publishSignal('dm.post') получателю + maybeEnqueueDMEmail
  → второй участник видит диалог, пузырь «Conversation started», получает
    счётчик непрочитанного и, возможно, письмо.
```

После фикса ветка `POST` при открытии исчезает целиком: до первого
пользовательского сообщения клиент не делает НИКАКИХ write-запросов.

## Целевая модель

### Драфт-стор (клиент, localStorage)

Новый модуль **`src/api/dm-drafts.js`** (рядом с `dms.js`, конвенция хранения —
как `aerun_readmap_${uid}` в `src/api/auth-resources.js`):

- Ключ: `aerun_dm_drafts_${uid}` — строго по uid аккаунта. Чтение/запись
  только через uid: другой аккаунт физически не видит чужие драфты, драфты
  переживают sign-out и перезагрузку (это данные пользователя, не кэш —
  при signOut НЕ чистить, в отличие от старого `clearAllDmCache`).
- Формат значения — объект, ключ = peerUid:

```json
{
  "uPeer123": {
    "peerUid": "uPeer123",
    "nickname": "Roui",
    "avatar": "/api/avatars/...",
    "createdAt": 1760430000000
  }
}
```

- **Идентичность драфта — детерминированная**: `draft id = 'draft_' + peerUid`.
  Одна пара (я, пир) → ровно один драфт-айди **по построению** (требования 5
  и 6 закрываются структурно, а не проверками). Префикс `draft_` не
  коллизирует с реальными id PocketBase (15 символов без `_`).
  Хелпер: `isDraftId(id) => typeof id === 'string' && id.startsWith('draft_')`.
- API модуля: `listDrafts(uid)`, `getDraft(uid, peerUid)`,
  `upsertDraft(uid, { peerUid, nickname, avatar })` (upsert по peerUid —
  повторный open не плодит копии), `removeDraft(uid, peerUid)`,
  `pruneDrafts(uid, realConversations)` (удалить драфты, у которых пир уже
  есть в реальном списке — механизм слияния, требование 3), `isDraftId(id)`,
  плюс композер-хелперы `loadComposerText`/`saveComposerText`/
  `clearComposerText` (см. «Автосохранение текста композера»).
- Битый JSON → `try/catch` → считать пустым + `console.warn`
  (правило zero silent failures).
- Снапшот `nickname/avatar` берётся в момент создания драфта (из
  `targetProfile` / peer-карты) — только для отрисовки строки в inbox;
  шапка чата и так подтягивается из peer-карты.

### Флоу открытия диалога (требования 1, 2, 5)

`getOrCreateConversation` переписывается в **`resolveConversation`** (без
create-ветки):

```
openChat(peerUid):
  1. done-ref / inflight-ref (существующие, L430-446) — остаются.
  2. known-список: есть реальная конверсация с пиром → вернуть её id
     + pruneDraft(peerUid).
  3. Иначе GET /conversations/peer/{peerUid} (read-only, истина в последней
     инстанции — пагинация списка это уже доказала, см. комментарий dms.js:40):
       - conversation_id непустой → реальный id + pruneDraft(peerUid);
       - пустой → ДРАФТ: upsertDraft(...) → вернуть 'draft_' + peerUid;
       - ОШИБКА сети/сервера → toast + НЕ создавать драфт
         (драфт не должен затенять реальный диалог; zero silent failures).
  4. POST /api/aerun/dms на открытии НЕ делается никогда.
```

### Рендер драфта в чате (требование 1)

Когда `activeChatId` — draft id:

- **Подписка сообщений (эффект L227) гейтится**: вместо
  `GET /api/aerun/dms/draft_x/messages` (403 «not a participant» и тост-спам)
  — явная ветка: `setMessages([])`, `setLoadingChat(false)`,
  `setHasMoreOlder(false)`. Явный сброс обязателен: без него при
  переключении с реального диалога на драфт останется старая лента.
- `markDmRead`, `fetchOlderDmMessages`, `deleteConversation` — пропускаются
  для draft id (`isDraftId` guard). Edit/delete сообщений невозможны —
  сообщений нет.
- Пустой чат уже рисуется (`dm.empty_chat`, L792-795) — это и есть нужный вид.
- `setActiveDmConvId('draft_…')` безвреден: draft id не встречается в
  серверных счётчиках непрочитанного.
- Шапка (имя/аватар/статус) продолжает работать через peer-карту (L155-176).

### Первая отправка из драфта (требования 3, 7)

Ветка в `handleSend` при `isDraftId(activeChatId)`:

```
1. Latch (inflight-ref + idempotency key) — как сейчас, до await.
2. Резолв истины: known-список → GET /conversations/peer/{peerUid}.
   а) Реальный диалог УЖЕ есть (пир успел отправить первым) →
      sendDmMessage(realId, text) — обычная ветка.
   б) Нет → POST /api/aerun/dms { recipient_ids:[peerUid],
      title: nickname пира, text: <реальный текст> } — createDMHandler
      создаёт конверсацию + участников + ПЕРВОЕ настоящее сообщение
      (sequence 1) + publishSignal(dm.post) + maybeEnqueueDMEmail.
3. Успех в обоих случаях:
   - pruneDraft(peerUid); setActiveChatId(realId);
     openChatDoneRef.set(peerUid, realId) — инвалидация драфтового кэша;
   - append ответа в messages (merge по id, сортировка по sequence) —
     контракт check-dm-mutation-state: серверный ответ ЕДИНСТВЕННОЕ, что
     рисует пузырь автора (publishDMSignalToPeers исключает автора);
   - refreshDmMessages(realId) + refreshDmList(myUid) — как сейчас.
4. Неуспех → тост + драфт остаётся, текст в композере НЕ сбрасывается
   до успеха.
```

`POST /dms` с настоящим текстом сохраняет существующий серверный контракт
(`createDMForm.Text` обязателен, идемпотентность через `enforceIdempotency`).
Клиентские резолвы (шаг 2) сужают окно гонки, но не закрывают её полностью —
если оба участника отправили первое почти одновременно, сходится сервер:
одна конверсация, оба сообщения (см. «Первая отправка на сервере»).

### Первая отправка на сервере: гонка одновременного создания

Решение владельца (2026-10-14): гонку ловит СЕРВЕР — оба сообщения
сохраняются, диалог остаётся один. Люди не роботы и могут отправить первое
в короткое окно, пока сервер обрабатывает оба запроса; это не ошибка
пользователя, а задача сервера.

Реализация в `createDMHandler` (dms.go:454), внутри той же транзакции,
перед INSERT конверсации:

1. Повторить тот же peer-запрос, что `findConversationWithPeerHandler`
   (L1069-1078): конверсация с этой парой уже есть?
2. Есть → НЕ создавать вторую. Дозаписать сообщение в СУЩЕСТВУЮЩУЮ
   конверсацию тем же путём, что `sendDMMessageHandler` (sequence =
   `messages_count + 1`, обновление `last_message`/`last_message_at`/
   `messages_count`, `last_read_sequence` автора, `publishSignal` +
   `maybeEnqueueDMEmail` получателям) и вернуть 200 с `conversation_id`
   существующей конверсации и своим `message`.
3. Нет → обычное создание (ветка как сейчас).

Оба запроса завершаются успехом: у обоих участников один диалог с двумя
сообщениями. Ветка дозаписи выносится в общий helper
(`appendMessageToConversation(txApp, conv, senderID, text, rolls)`), чтобы
`sendDMMessageHandler` и фолбэк `createDMHandler` не расходились.

Покрытие: Go-тест — два параллельных `POST /dms` на одну пару (разные
idempotency-ключи) → ровно одна конверсация, sequence 1 и 2, оба текста в
ленте, `messages_count == 2`; CI `ci-report` зелёный (правило AGENTS).

### Слияние драфта со реальным диалогом (требование 3)

Три триггера, все ведут к одному состоянию (реальный id, драфт удалён):

1. **Открытие**: `resolveConversation` (шаг 3 выше) — GET peer решает.
2. **Список**: `subscribeToDmList` обновился (10s poll или realtime-сигнал
   `dm.post` — адресован получателю, т.е. как раз второму участнику) →
   `pruneDrafts` по `participants` → в UI строка драфта заменяется реальной.
3. **Чат открыт в момент, когда пир отправил первым**: эффект-наблюдатель —
   если `activeChatId` draft id, а в `conversations` появилась конверсация с
   этим же пиром → `setActiveChatId(realId)` + prune + инвалидация done-ref.
   Текст в композере (`messageText`) живёт в отдельном стейте и переживает
   подмену id.

### Удаление драфта (требование 4)

`handleConfirmDelete` (L642): если `isDraftId(convId)` → только
`removeDraft(uid, peer)` + тост + `setActiveChatId(null)` / навигация в inbox.
**Ни `deleteConversation`, ни `refreshDmList`, ни optimistic-фильтр
`conversations` не нужны** (драфта в `conversations` и нет). Повторное открытие
создаёт драфт заново (тот же id, свежий `createdAt`).

### Автосохранение текста композера (требование 8)

Как в TopicPage (`reply_draft_${id}_${uid}`): текст, набранный в RichEditor,
автосохраняется в localStorage и восстанавливается при возврате в диалог —
для реальных И драфтовых диалогов. Сейчас композер ЛС текста не сохраняет
(plain `useState`) — это новая функция.

- Ключ: `aerun_dm_composer_${convId}_${uid}`, где `convId` — реальный id
  конверсации или draft id (`draft_${peerUid}` детерминирован, так что
  «диалог с пиром» адресуем стабильно).
- Запись: на каждое изменение текста (debounce, как в TopicPage); удаление
  ключа — только после УСПЕШНОЙ отправки (в обеих ветках `handleSend`).
  При неуспехе текст и ключ остаются (шаг 4 флоу отправки).
- Восстановление: при смене `activeChatId` — включая открытие драфта и
  supersede-подмену draft→real: при подмене сохранённый текст переносится
  под новый ключ, чтобы не «потерять» его на границе.
- Хелперы в том же модуле `dm-drafts.js`: `loadComposerText(convId, uid)`,
  `saveComposerText(convId, uid, text)`, `clearComposerText(convId, uid)` —
  тот же try/catch/warn.

### Inbox: строки драфтов (требования 2, 4, 6)

- Источник рендера: `visibleConversations` **после** фильтрации реальных
  строк + драфты из стора, минус `pruneDrafts`-пересечение по пиру; после
  merge весь список сортируется единым ключом свежести (см. «Порядок»).
  ⚠️ Фильтр `visibleConversations` (L694-700) возвращает `false` при
  отсутствии `lastTimestamp` — драфты обязаны добавляться ПОСЛЕ этого
  фильтра (или фильтр получает draft-aware ветку), иначе они не видимы.
- Строка драфта: аватар/ник из снапшота, превью = локализованное
  «Черновик · нет сообщений», дата — `createdAt` (или бейдж «Черновик»),
  без счётчика непрочитанного. Клик → `navigate(/messages/${peerUid})` →
  тот же `openChat` (копия не создаётся — детерминированный id).
- Корзина в строке драфта → client-only ветка удаления (см. выше).
- Порядок (решение владельца 2026-10-14): драфты сортируются ВМЕСТЕ с
  реальными диалогами по единому ключу свежести — реальный диалог по
  `last_message_at`, драфт по `createdAt` (играет роль «времени последнего
  сообщения»), весь список DESC. Только что созданный драфт — первая строка
  списка; он НЕ уезжает на дно, сколько бы реальных диалогов ни было.
  Реализация: merge после cleared-фильтра, затем единая сортировка
  (список приходит с сервера отсортированным — клиент пересортировывает).

### Уведомления = бейдж на иконке ЛС (требование 7)

«Уведомление для ЛС» = бейдж на иконке новых сообщений в хедере (счётчик
непрочитанного из `/me/unread-counts`), а не запись на странице уведомлений —
in-app записей в `notifications` у ЛС нет по дизайну (комментарий
`dms.go:602`). Бейдж живёт на серверных строках `dm_members`/
`dm_conversations`; realtime-подталкивание — `publishSignal('dm.post')`;
отдельно email — `maybeEnqueueDMEmail`. Все три вызываются ТОЛЬКО из
`createDMHandler` (L600-621) и `sendDMMessageHandler` (L783-800).

После фикса открытие/удаление драфта не выполняет ни одного write-запроса →
уведомление по построению невозможно до первого реального сообщения.
Требование проверяется гейт-скриптом (S8) + ручным прогоном.

## Изменения по файлам

| Файл | Что делается |
|---|---|
| **`src/api/dm-drafts.js`** (новый) | Драфт-стор: ключ `aerun_dm_drafts_${uid}`, `isDraftId`, `listDrafts`, `getDraft`, `upsertDraft`, `removeDraft`, `pruneDrafts`. Плюс композер-хелперы `loadComposerText`/`saveComposerText`/`clearComposerText` (ключ `aerun_dm_composer_${convId}_${uid}`). Только синхронный localStorage, без зависимостей от `dms.js`. |
| **`src/api/dms.js`** | `getOrCreateConversation` (L27-64) → `resolveConversation`: known → `GET /conversations/peer`, ветка `POST ... text:'Conversation started'` **удаляется полностью** (включая литерал). Добавляется `startConversationWithMessage(peerUid, title, text, idempotencyKey)` → `POST /api/aerun/dms` с реальным текстом, возврат нормализованного `{conversation_id, message}` — контракт «мутация возвращает строку». Остальное не трогается. |
| **`src/components/dm/DirectMessages.jsx`** | 1) `openChat` (L426): `resolveConversation` + draft-fallback (`upsertDraft`), prune при реальном id. 2) Эффект подписки (L227): ветка `isDraftId` → сброс `messages/loadingChat/hasMoreOlder`, ноль сетевых вызовов. 3) `handleSend` (L564): ветка первой отправки из драфта; latch/идемпотентность; очистка ключа композера только при успехе. 4) `handleConfirmDelete` (L642): draft → client-only. 5) Новый эффект supersede (драфт → реальный id + перенос сохранённого текста под новый ключ). 6) Inbox: merge драфтов после `visibleConversations`, единая сортировка по свежести, строка драфта и её удаление. 7) Инвалидация `openChatDoneRef` при prune/supersede. 8) Автосохранение/восстановление текста композера (требование 8). |
| **`src/i18n/dictionary.js`** | Ключи в блоки `dm.*` (ru ~L1162, en ~L354): `dm.draft_badge` («Черновик»/«Draft»), `dm.draft_preview` («Черновик — сообщений нет»/«Draft — no messages yet»), `dm.draft_deleted` («Черновик удален»/«Draft deleted»). |
| **`src/index.css`** | Бейдж/превью строки драфта (небольшой объём, по образцу `.dm-bubble-action`). |
| **`scripts/check-dm-draft-conversations.mjs`** (новый) | Гейт (см. ниже), добавить в `test:`-пайплайн `package.json`. |
| **`scripts/check-dm-mutation-state.mjs`** | Расширить под две ветки `handleSend` (создание из драфта / обычная отправка): сохранить проверки capture/`setMessages`/refresh, **не ослаблять**. |
| **`backend/.../dms.go`** | Обязательно: обработка гонки одновременной первой отправки — в транзакции `createDMHandler` перед INSERT re-check пары; при находке дозапись сообщения в существующую конверсацию (общий helper `appendMessageToConversation`, рефакторинг выноса ветки из `sendDMMessageHandler`). + Go-тест параллельных POST + CI `ci-report`. |

## Тесты и гейты

1. **`scripts/check-dm-draft-conversations.mjs`** — исполняет модули, а не читает
   их (правило AGENTS: definition доказывается только тем, что кто-то его
   дергает):
   - `src/api/dms.js` не содержит литерал `'Conversation started'`;
   - `POST /api/aerun/dms` встречается в `dms.js` только в
     `startConversationWithMessage`, но не в `resolveConversation`;
   - `DirectMessages.jsx`: эффект подписки, `handleConfirmDelete` и вызов
     `markDmRead` защищены `isDraftId(`;
   - `dm-drafts.js` исполняется с shim'ом `global.localStorage`: двойной
     `upsertDraft` одного peer → 1 запись; `removeDraft` убирает; `pruneDrafts`
     убирает драфт, чей пир есть в реальном списке; битый JSON → пустой стор +
     warn; `isDraftId('draft_x') === true`, для реального id — false;
     композер-хелперы: save → load возвращает текст, clear убирает.
2. **`check-dm-mutation-state.mjs`** — зелёный после переработки `handleSend`
   (ветки расширены, проверки не ослаблены).
3. **Бэкенд**: `go test ./internal/platform/pocketbase/ -run DM`
   + новый тест «два параллельных POST /dms на одну пару (разные
   idempotency-ключи) → ровно одна конверсация, sequence 1 и 2, оба текста
   в ленте»; после пуша: `git fetch origin ci-report && git show origin ci-report:report.json`.
4. **Ручной прогон** — матрица ниже (два аккаунта, два браузера/инкогнито).

## Матрица проверки требований

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | A открывает `/messages/B` (диалога нет) | Пустой чат, ни одного пузыря; у B диалога нет (в DevTools только `GET peer`, ни одного POST) |
| 2 | A открыл драфт → ушёл на главную → F5 | Драфт на месте и пуст; в localStorage `aerun_dm_drafts_A`; в БД ничего |
| 3а | A и B открыли драфты друг с другом, A отправил первым | У обоих реальный диалог с сообщением A; драфт B исчез (при открытии/по списку) |
| 3б | B держит драфт открытым, когда A отправил | Чат B сам переключается на реальный id, сообщение A видно, текст B в композере цел |
| 4 | A удалил драфт → открыл снова | Тост успеха, в БД ноль write-запросов, драфт создан заново |
| 5 | Двойной клик «Написать ЛС», повторный клик из профиля, две вкладки | Всегда одна строка и один id `draft_<peer>` |
| 6 | Драфты с B и C одновременно | Две независимые строки; удаление одной не трогает другую |
| 7 | Полный цикл: драфт → первое сообщение | Бейдж на иконке ЛС у B загорается только ПОСЛЕ отправки (при открытии/удалении драфта — никогда); email B — тоже только после |
| 7б | Оба открыли драфты, оба отправили почти одновременно | Ровно один диалог у обоих, оба сообщения в ленте (серверная конвергенция) |
| 8 | Набрал текст в композере → ушёл на главную / F5 → вернулся | Текст восстановлен (для драфта и реального диалога); после успешной отправки очищен; после неудачной остался |

## Спринты

Формат как в `TESTING_DM_FIX_PLAN.md`: пункт не закрывается без чекпоинта.

- [~] **S1. Драфт-стор + композер-хелперы — КОД ГОТОВ.** Новый
  `src/api/dm-drafts.js` (драфт-стор + `loadComposerText`/`saveComposerText`/
  `clearComposerText` + `isDraftId`/`draftIdFor`) + гейт
  `scripts/check-dm-draft-conversations.mjs` (исполняющая проверка модуля,
  12 проверок зелёные), скрипт добавлен в `package.json` под именем
  **`test:dm-draft-conversations`** (план предлагал `test:dm-drafts` —
  взято более точное имя, отклонение зафиксировано) и влит в `test`.
  Чекпоинт: `node scripts/check-dm-draft-conversations.mjs` зелёный —
  ВЫПОЛНЕНО; `npm test` целиком — НЕ гонялся (осталось в S9).

- [~] **S2. Открытие диалога без записи в БД — КОД ГОТОВ.**
  `getOrCreateConversation` → `resolveConversation` (create-ветка и
  `POST ... text:'Conversation started'` удалены из КОДА, включая
  `getConversationId` — 0 использований в репо), draft-fallback в `openChat`
  (`upsertDraft` + `setDrafts` при draft id, prune-состояние при реальном),
  гейт эффекта подписки (`isDraftId` → `setMessages([])`/`setLoadingChat(false)`/
  `setHasMoreOlder(false)` + полный сброс рефов, `return () => {}`), guard'ы
  `markDmRead` (явный `!isDraftId(activeChatId)`), `fetchOlderDmMessages`
  (`handleLoadOlder`), гидратация `listDrafts(myUid)` на маунте.
  Чекпоинт: DevTools-прогон (только `GET peer`, ни одного `POST`), F5,
  `npm test` + `lint:js` — НЕ гонялись целиком; `npx eslint` на изменённых
  файлах — зелёный.
  - Существующие done/inflight-ref'ы (D4) остаются; **не** возвращать
    старый D4-баг: эффект L201 может сработать дважды — оба раза драфт-ид
    детерминирован, дубля нет. Закрыто структурно (upsert по peer).

- [~] **S3. Первая отправка из драфта (клиент) — КОД ГОТОВ.** Ветка
  `handleSend` при `isDraftId`: re-resolve через `resolveConversation`
  (пир мог отправить первым → обычная `sendDmMessage`) либо
  `startConversationWithMessage` (новая функция в `dms.js`, возвращает
  `{conversation_id, message}` после `normalizeDmMessage`); prune +
  `setActiveChatId(real)` + инвалидация `openChatDoneRef`; очистка ключа
  композера ТОЛЬКО по успеху (`clearComposerText` в try). Добавлен
  supersede-эффект (пир отправил первым → перенос текста под новый ключ,
  prune, смена id) и эффекты автосохранения (restore по смене `activeChatId`
  + запись с debounce 400ms) — по сути S7 тоже сделан здесь.
  `check-dm-mutation-state.mjs` зелёный БЕЗ правок (regex матчится).
  Чекпоинт: сценарии 3а/3б вручную — НЕ гонялись;
  **осталось: расширить `check-dm-mutation-state.mjs`** (ветка
  `startConversationWithMessage`, гейт `isDraftId`) — требование «расширить,
  не ослабить». Серверная защита от гонки — отдельно, S4.

- [~] **S4. Сервер: гонка одновременной первой отправки — ЧАСТИЧНО,
  ЗАМОРОЗКА ЗДЕСЬ.** Сделано в `backend/internal/platform/pocketbase/dms.go`:
  1) хелпер **`findPairConversationID(app, user, peer)`** — тот же SQL, что у
  `findConversationWithPeerHandler`, вынесенный чтобы эндпоинт и re-check не
  расходились; 2) хелпер **`appendMessageToConversation(txApp, conv, senderMem,
  senderNick, cleanText, rolls)`** — единая реализация «дозаписи в
  существующую конверсацию»: проверки других участников (removed/banned/
  live-право `use_direct_messages`), `sequence = messages_count + 1`, правка
  `last_message`/`last_message_at`/`messages_count`, `last_read_sequence`
  автора, `publishSignal(dm.post)` + `maybeEnqueueDMEmail`; 3)
  `sendDMMessageHandler` переведён на этот хелпер (тело ~L833-891 бывшего
  inline-кода удалено, дублирование устранено). `go build ./...` зелёный.
  **ОСТАЛОСЬ (точки входа найдены, порядок ниже):**
  - в `createDMHandler` после цикла валидации `recipientUsers` (~L525) и ПЕРЕД
    `// 1. Create dm_conversations record.` (~L527): `if len(recipients)==1` →
    `findPairConversationID(txApp, e.Auth.Id, recipients[0])`; при непустом id →
    `FindRecordById(conv)` + `FindFirstRecordByFilter(dm_members …user_id=e.Auth.Id)`
    → `appendMessageToConversation(...)` → `return 200 {conversation_id, sequence,
    message, request_id}` (ветка INSERT не выполняется);
  - перевести `findConversationWithPeerHandler` (~L1063, СНАЧАЛА перечитать
    весь хендлер — правило AGENTS про контекст-хаки) на `findPairConversationID(e.App, …)` —
    сейчас хелпер НЕ используется, SQL продублирован;
  - Go-тест по образцу `sprint5_test.go` L400+ (`TestSprint5DMConcurrency`):
    два goroutine, `POST /dms` player→player2 и player2→player, разные
    Idempotency-Key → assert: 1 конверсация, sequence {1,2}, оба текста в
    ленте, `messages_count==2`. Имя теста обязано содержать `DM`
    (`go test … -run DM`).
  Чекпоинт: сценарий 7б; `go test ./internal/platform/pocketbase/ -run DM`
  зелёный; CI `ci-report` зелёный после пуша.

- [~] **S5. Inbox: строки драфтов, единая сортировка, client-only удаление —
  КОД ГОТОВ.** `inboxRows` собирается ПОСЛЕ `visibleConversations`
  (draft-строки иначе отсеялись бы фильтром `lastMs === null`), защита от
  дубля «пир уже в реальном списке», единая сортировка `_sort` DESC
  (реальный = `lastTimestamp`, драфт = `createdAt`) — свежий драфт первая
  строка; строка драфта: бейдж `dm.draft_badge` (CSS `.dm-draft-badge`) +
  италик-превью `dm.draft_preview` (`.dm-draft-preview`), дата `createdAt`,
  без счётчика непрочитанных; `handleConfirmDelete` draft-ветка
  (только localStorage, ноль запросов, инвалидация done-ref, чистка ключа
  композера); draft-вариант ConfirmModal (заголовок/текст); i18n ru+en
  (`draft_badge`/`draft_preview`/`draft_deleted` — последний подключён к
  тосту `t('dm.draft_deleted')`); prune на каждом обновлении списка +
  гидратация `listDrafts` на маунте (F5, требование 2).
  Чекпоинт: сценарии 2/4/6 вручную — НЕ гонялись; `npm test` — не гонялся.

- [ ] **S6. Дедуп повторных открытий (требование 5).** Частично заложено:
  `openChatDoneRef` инвалидируется в `handleConfirmDelete` (`delete`),
  `handleSend` (set real id) и supersede-эффекте (set real id).
  **Открытая находка: в колбэке `subscribeToDmList` при
  `setDrafts(pruneDrafts(...))` done-ref НЕ инвалидируется** — после prune
  может остаться устаревший `draft_*` id; для открытого чата это чинит
  supersede-эффект (краткий пустой рендер → подмена), для закрытого — при
  навигации возможен такой же кадр. Решение: удалять из done-ref всех
  pruned-пиров прямо в колбэке (или сверять с `listDrafts`). Далее проверить
  все пути: двойной клик, повторный клик из профиля/участников, две вкладки,
  открытие из inbox.
  Чекпоинт: сценарий 5 — всегда одна строка, один id.

- [~] **S7. Автосохранение композера (требование 8) — КОД ГОТОВ (в составе
  S3).** Wiring `loadComposerText`/`saveComposerText`/`clearComposerText` в
  `DirectMessages.jsx`: restore по смене `activeChatId` (включая открытие
  драфта), запись debounce 400ms, перенос текста под новый ключ при supersede
  draft→real, очистка только после успешной отправки, чистка ключа вместе с
  удалением драфта и при clear реального диалога.
  Чекпоинт: сценарий 8 вручную (F5/навигация/supersede/неудачная отправка) —
  НЕ гонялся; `npm test` — не гонялся.

- [ ] **S8. Бейдж на иконке ЛС (требование 7) — НЕ НАЧАТ.** Дописать в
  `check-dm-draft-conversations.mjs` source-shape проверки:
  - `src/api/dms.js` не содержит литерал `'Conversation started'` —
    **ОБЯЗАТЕЛЬНО после `stripComments`** (готовый stripComments есть в
    `check-dm-mutation-state.mjs`): в `dms.js` он остался в комментариях
    (конвенция «comment quotes the offending expression»), проверка сырого
    текста даст ложный срабатыватель;
  - `POST /api/aerun/dms` встречается в `dms.js` только внутри
    `startConversationWithMessage` и НЕ в `resolveConversation` (вырезать
    тела функций regex-ом, как это делает `check-dm-mutation-state.mjs`);
  - `DirectMessages.jsx`: эффект подписки, `handleConfirmDelete` и вызов
    `markDmRead` защищены `isDraftId(` (все три уже есть в коде);
  - по коду `openChat` и `handleConfirmDelete`: открытие/удаление драфта не
    вызывает write-API (в `openChat` — только `resolveConversation`, в
    draft-ветке удаления — `removeDraft`/`clearComposerText`, до
    `return;` нет `deleteConversation`/`refreshDmList`);
  - плюс прогнать ручной сценарий 7 (два аккаунта: бейдж и email у B —
    только после первой реальной отправки; при открытии/удалении драфта —
    никогда).
  Чекпоинт: сценарий 7 зелёный, `npm test` зелёный.

- [ ] **S9. Регресс — НЕ НАЧАТ.** Полный `npm test`, `npm run lint:js`,
  `cd backend && gofmt -l . && go vet ./... && go test ./internal/platform/pocketbase/`,
  ручной прогон всей матрицы (требования 1–8, включая 7б) + старые
  DM-сценарии (edit/delete/tombstone, clear, бейдж непрочитанного).
  После пуша: `git fetch origin ci-report && git show origin ci-report:report.json`.
  Чекпоинт: всё зелёное + статус этого файла → `DONE_...` с датой и
  результатами S1–S9.

## Edge cases (спроектировано, проверить при приёмке)

- **Пир удалён/забанен, открыт драфт:** peer-карта уже блокирует композер
  (L988-991); если отправить вслед за тем — `createDMHandler` откажет на
  `ValidateParticipants` → тост, драфт и текст сохраняются.
- **Ошибка `GET peer` при открытии:** не создавать драфт, показать toast —
  иначе драфт затенит реальный диалог (zero silent failures).
- **Две вкладки:** ключ детерминирован, запись — upsert по peer; last-write-wins,
  дубли невозможны по построению. `storage`-event — опциональный nice-to-have,
  не требуется.
- **Смена аккаунта:** стор читается только по uid текущего профиля — чужие
  драфты недоступны; драфты переживают sign-out (это данные пользователя).
- **Старые диалоги с seed-сообщением «Conversation started»** остаются в БД как
  история — не трогаем.
- **Пагинация inbox:** `GET peer` — источник истины при открытии (уже
  задокументировано в `dms.js:40`), known-список — только оптимизация.
- **`visibleConversations` фильтрует строки без `lastTimestamp`** — драфты
  добавляются после фильтра (см. раздел Inbox).
- **Ключ композера и удаление:** удаление драфта и clear реального диалога
  чистят и ключ композера («начать заново» = начать заново) — дефолт,
  подтвердить при S7.

## Решения (зафиксированы владельцем, 2026-10-14)

1. **Гонка одновременной первой отправки — задача сервера.** Клиентские
   резолвы сужают окно, но гонку закрывает сервер: в транзакции
   `createDMHandler` re-check пары; при находке — дозапись сообщения в
   существующую конверсацию. Итог: одна конверсация, оба сообщения
   сохранены (см. «Первая отправка на сервере», спринт S4). Это отменяет
   прежнее решение S2 из `TESTING_DM_FIX_PLAN.md` («серверный дедуп НЕ
   делаем») — оно касалось дублей при повторных открытиях, а не
   параллельного первого письма.
2. **Сортировка драфтов в inbox — единая со списком диалогов.** Свежесть
   реального диалога = `last_message_at`, свежесть драфта = `createdAt`,
   весь список DESC. Драфты не уезжают на дно: только что созданный драфт —
   первая строка списка.
3. **Автосохранение текста композера — включено в план** (требование 8):
   тот же принцип, что черновик ответа в теме, для реальных и драфтовых
   диалогов.

## Не входит в план (non-goals)

- Серверное хранение драфтов, синхронизация между устройствами/браузерами.
- In-app уведомления для ЛС (их нет по дизайну — `dms.go:602`).
- Изменение формата/поведения реальных диалогов, tombstone, clear, бейджей.
- Массовая чистка старых seed-сообщений.

## Критерии готовности

- 8 требований из матрицы пройдены вручную двумя аккаунтами (включая
  сценарий 7б — одновременная первая отправка).
- `npm test` (весь пайплайн, включая новый гейт) и `npm run lint:js` зелёные;
  Go-тесты гонки + CI `ci-report` зелёный.
- В `src/api/dms.js` нет `'Conversation started'`; открытие диалога не
  выполняет write-запросов; бейдж на иконке ЛС и email — только с первого
  реального сообщения; параллельная первая отправка сходится к одному
  диалогу с двумя сообщениями.
- Статус этого файла → `DONE_DM_DRAFT_CONVERSATIONS_PLAN.md` с датой и
  результатами S1–S9 (конвенция репозитория).








## Прогресс сессии 2026-10-14 (заморозка, сессия 1)

Рабочая ветка: `feature/pocketbase-migration`. Коммит-хэш заморозки —
см. `git log` (коммит `feat(dm): draft conversations until first message…`).

### Что сделано (код в рабочем дереве, закоммичено)

| Файл | Изменение |
|---|---|
| `src/api/dm-drafts.js` **(новый)** | Драфт-стор: `DRAFT_PREFIX`/`COMPOSER_PREFIX`, `isDraftId`, `draftIdFor`, `listDrafts`, `getDraft`, `upsertDraft`, `removeDraft`, `pruneDrafts`, `loadComposerText`, `saveComposerText`, `clearComposerText`. Только синхронный `globalThis.localStorage`, heal битого JSON через warn. |
| `src/api/dms.js` | `getOrCreateConversation` → `resolveConversation` (без create-ветки; `removeDraft` при реальном id; `draftIdFor` при пустом; ошибка сети бросается); новая `startConversationWithMessage(peerUid, title, text, idempotencyKey)` → `POST /api/aerun/dms` с реальным текстом, возврат `{conversation_id, message}` (normalizeDmMessage). Удалены `getConversationId` и литерал из кода. |
| `src/components/dm/DirectMessages.jsx` | Импорты dm-drafts; state `drafts`; `openChat` на `resolveConversation` + upsert/prune; гейт эффекта подписки по `isDraftId` (пустая лента + сброс); guard'ы `markDmRead`/`handleLoadOlder`; prune на каждом апдейте списка + гидратация `listDrafts` на маунте; supersede-эффект (draft→real с переносом текста); эффекты композера (restore + debounce 400ms); `handleSend` с веткой первой отправки (resolve → `sendDmMessage` либо `startConversationWithMessage`, prune/смена id/инвалидация done-ref, `clearComposerText` только по успеху); `handleConfirmDelete` draft-ветка (client-only, ноль запросов, чистка done-ref и ключа композера); `inboxRows` (merge после `visibleConversations`, единая сортировка DESC); строка драфта (бейдж + превью); draft-вариант ConfirmModal; тост `t('dm.draft_deleted')`. |
| `src/i18n/dictionary.js` | `dm.draft_badge`, `dm.draft_preview`, `dm.draft_deleted` (ru + en). |
| `src/index.css` | `.dm-draft-badge`, `.dm-draft-preview`. |
| `scripts/check-dm-draft-conversations.mjs` **(новый)** | Исполняющий гейт модуля (fake localStorage): 12 проверок — isDraftId, идемпотентность upsert, пер-аккаунтная изоляция, coexistence, prune, битый JSON, композер-хелперы. |
| `package.json` | `test:dm-draft-conversations` + вставка в цепочку `test`. |
| `backend/.../dms.go` | Добавлены `findPairConversationID(app, user, peer)` и `appendMessageToConversation(txApp, conv, senderMem, senderNick, cleanText, rolls)`; `sendDMMessageHandler` переведён на общий хелпер (inline-дубль удалён). |

### Что проверено на момент заморозки (все команды зелёные)

```
node scripts/check-dm-draft-conversations.mjs   → [OK] 12 checks passed
node scripts/check-dm-mutation-state.mjs        → все OK (без правок)
npx eslint src/components/dm/DirectMessages.jsx → EXIT=0
npx eslint src/api/dms.js src/api/dm-drafts.js src/i18n/dictionary.js → EXIT=0
cd backend && go build ./...                    → пусто (OK)
```

**НЕ гонялось:** полный `npm test`, `npm run lint:js` целиком, `go vet`,
`go test` (включая существующие DM-тесты после рефакторинга
`sendDMMessageHandler`), CI `ci-report`, ручная матрица требований 1–8.


### Находки сессии (важно для продолжения)

1. **Гонку на сервере закрывает не только re-check, но и `forumCommandMu`**
   (`idempotency.go` L203): командные транзакции одного процесса
   сериализуются, поэтому второй `POST /dms` гарантированно видит
   закоммиченную конверсацию первого внутри своей транзакции — re-check
   детерминирован в топологии «один процесс» (целевая по плану §1).
   На уровне БД backstop — `UNIQUE(conversation_id, sequence)`; **UNIQUE на
   пару участников НЕТ**, так что кросс-процессный дубль-создание теоретически
   возможен (как и до плана) — вне топологии, фиксировать нечего, но знать.
2. **`getConversationId` удалён** — grep по репо: 0 использований (проверено
   перед удалением, правило AGENTS про use-site).
3. **`sendApi` бросает `ApiError`** (сеть и `!res.ok`, `pocketbase.js` L56-92)
   → при ошибке `GET peer` `resolveConversation` бросает → `openChat` ловит и
   показывает тост, **драфт НЕ создаётся**. Edge-case «ошибка при открытии»
   закрыт конструктивно (проверить вручную в S9).
4. **Гидратация обязательна**: `drafts` state стартует пустым — после F5
   строки драфтов не появились бы без `listDrafts(myUid)` на маунте
   (реализовано в эффекте подписки на список).
5. **`check-dm-mutation-state.mjs` проходит без правок** поверх нового
   `handleSend` (обе ветки содержат `= await sendDmMessage(` и `setMessages(`).
   Расширение плана (S3/S8) остаётся сделать, НЕ ослабляя текущие проверки.
6. **Ловушка гейта `'Conversation started'`**: литерал остался в
   комментариях `dms.js`/`dm-drafts.js`/`DirectMessages.jsx` (конвенция —
   комментарий цитирует нарушение). Source-shape проверка S8 **обязана
   идти после `stripComments`** — иначе ложный срабатыватель.
7. **Открытая находка S6**: prune в колбэке `subscribeToDmList` не
   инвалидирует `openChatDoneRef` (см. спринт S6) — краткий кадр пустого
   чата при навигации; supersede-эффект спасает, но лучше чистить done-ref
   для pruned-пиров.
8. **Существующий Go-тест** `TestFindConversationWithPeerDoesNotDuplicate`
   (`dm_inbox_participants_test.go` L256) и все DM-тесты после рефакторинга
   `sendDMMessageHandler` ещё не гонялись — первым делом в S4/S9.
9. **Инструментальная ловушка (для следующей сессии):** вставки в редактор
   файлов >~6000 символов молча обрезаются — `dm-drafts.js` пришлось
   пересобирать частями. Крупные правки — кусками, после каждой сверять
   `wc -l`/`tail`.

### План следующей сессии (свежий порядок)

1. **Доделать S4** (точки входа в разделе S4 выше): re-check в
   `createDMHandler` → рефактор `findConversationWithPeerHandler` на хелпер →
   Go-тест параллельных POST → `gofmt -l . && go vet ./... &&
   go test ./internal/platform/pocketbase/ -run DM` → затем весь пакет.
2. **S6**: инвалидация done-ref при prune в колбэке подписки + ручные
   пути дедупа (двойной клик, профиль, две вкладки, inbox).
3. **S8**: расширить `check-dm-draft-conversations.mjs` (точный список
   проверок в спринте S8) + расширить `check-dm-mutation-state.mjs` (ветка
   `startConversationWithMessage` / `isDraftId`) — оба гейта зелёные.
4. **S9**: полный `npm test` + `lint:js` + Go-тесты + ручная матрица 1–8
   (два аккаунта) + старые DM-сценарии; пуш и `ci-report`; статус файла →
   `DONE_DM_DRAFT_CONVERSATIONS_PLAN.md` (переименовать, убрав `INPROGRESS_`).

### Проверочные команды (одна строка на запуск)

```bash
node scripts/check-dm-draft-conversations.mjs && node scripts/check-dm-mutation-state.mjs && npm run lint:js
cd backend && gofmt -l . && go vet ./... && go test ./internal/platform/pocketbase/ -run DM
git fetch origin ci-report && git show origin ci-report:report.json
```


