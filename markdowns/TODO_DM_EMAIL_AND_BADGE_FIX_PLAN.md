# DM: нет email офлайн-получателю + залипший бейдж — находки и план

Дата: 2026-10-14. Ветка: `feature/pocketbase-migration`.

Репорт:
(1) новое ЛС офлайн-участнику — email не пришёл, хотя уведомления включены;
(2) в открытом диалоге сообщения на экране, а бейдж `3` на иконке ЛС не снимается.

Оба вхождения воспроизводятся по коду. Ниже — что проверено и план по шагам.

## 1. Цепочка email (dms.go:117-155, вызовы :617 и :793)

1. Оба send-пути (новый диалог и ответ) зовут `maybeEnqueueDMEmail` в транзакции.
2. Три тихих гейта до очереди: `!dmEmailEnabled` -> return; `isMemberOnline` ->
   return; нет шаблона `dm` -> return. Иначе `enqueueOutboxEvent` с ключом
   `dm:first-unread:{conv}:{recipient}` (outbox.go:45-89).
3. Крон `* * * * *` зовёт `dispatchOutboxOnce` (outbox_dispatch.go:70-108).
   Первый гейт: `if !SMTP.Enabled { return 0 }` (ADR-6) — строки остаются pending.
4. `ProcessBatch` (outbox.go:135-244) перед отправкой проверяет `dmEmailSkipReason`
   (outbox.go:253-303): recipient online / dm mail disabled / already read /
   not a member / conversation gone -> sent + last_error=skipped, письмо НЕ уходит.
5. Сброс дедупа — только в `markConversationReadHandler` (dms.go:1182-1250).
   Без POST /dms/{id}/read новая волна писем НЕ встанет в очередь (UNIQUE ключ).

Настройка: users.settings.email_notifications.dms !== false (default true).
Онлайн — ТОЛЬКО in-process карта onlineMembers + TTL 75s. Закрытый таб без logout
висит онлайн до 75s. Рестарт бэкенда роняет карту целиком.
## 2. Цепочка бейджа

1. Сервер GET /me/unread-counts (notifications.go:499-548): только скаляры.
2. Клиент subscribeToUnreadCounts (dms.js:139-202): conversations ВСЕГДА {}.
3. Пишет last_read одно место: POST /dms/{id}/read из DirectMessages.jsx:287-299.
4. После markDmRead нет refresh, сервер не публикует сигнал. Счётчик при живом
стриме без таймера — только сигнал/возврат вкладки. Скролл не двигает бейдж.
5. У топиков refreshUnreadCounts есть (AuthProvider.jsx), у DM нет — асимметрия.


## 3. Баг 1: кандидаты по вероятности

A. SMTP выключен (самое вероятное). Дефолт dashboard, configureSMTP не трогает
настройки (smtp.go:115-121) — всё решает PB Admin Mail settings. Репо relay не
содержит, deploy.py/aerun.service mail-env не прокидывают. Проверка:
GET /admin/outbox-events?status=pending (run.go:477-478).

B. Дедуп первой волны. Ключ dm:first-unread UNIQUE — одно письмо, пока не
прочитано. Вторая волна без read — корректно без письма. Баг 2 ломает mark-read,
волны слипаются. failed тоже блокирует до чтения.

C. Ложный онлайн: heartbeat 30s + TTL 75s + лаг диспатча 60s. Закрытый таб без
logout ещё ~75s онлайн, скип и на отправке, и на диспатче (sent без письма).

D. Преф/адрес (маловероятно). Битый JSON settings → true. Ключи совпадают
(dms). Пустой Email() → ретраи → failed, видно в last_error.

## 4. Баг 2: причины

1. Главная: mark-read не заставляет счётчики перечитаться (ни пуша, ни пулла).
2. lastReadSeqRef не сбрасывается при смене activeChatId (DirectMessages.jsx:88):
почитали seq 10 → открыли диалог с 3 сообщениями → 3 > 10 false → POST /read не
уходит вообще. Бейдж 3 на скрине похож на этот кейс.
3. Косметика: вычесть открытый диалог нечем — conversations всегда {}.

НЕ причины (проверено): воркер зарегистрирован (run.go:57-59); guard только при
disabled; оба send-пути зовут maybeEnqueueDMEmail; in-app dm не создаются намеренно.

## 5. План фиксов по шагам

Шаг 0. Диагностика прода без кода: outbox pending/sent/failed + Mail settings +
journalctl | grep outbox.

Шаг 1. Баг 2 фронт (dms.js, DirectMessages.jsx): markDmRead → refreshUnreadCounts
+refreshDmList; сброс lastReadSeqRef при смене диалога; mark-read при входе.
Проверка: POST /read + GET counts сразу в network.

Шаг 2. Баг 2 сервер (markConversationReadHandler): publishSignal себе после read.
Топик dm.post или новый dm.read — решить до кодирования.

Шаг 3. Косметика: unread_by_conversation в unread-counts, либо удалить мёртвые
ветки вычитания.

Шаг 4. Баг 1 код: Debug-логи трёх тихих return + no-op дедупа. Кейс
failed-блокирует-волну решить и задокументировать.

Шаг 5. Присутствие (опционально): сузить окно ложного онлайна, сначала метрика
скипов из last_error.

Шаг 6. Тесты: backend (сигнал, связка send-read-counts, dedupe+failed), фронт
(POST read+GET counts, длинный→короткий диалог). Приёмка: logout-офлайн → письмо
до 2 мин; открыть диалог → бейдж гаснет сразу.

## 6. Вопросы владельцу — РЕШЕНО 2026-10-14

1. Письмо — одно на волну. ОСТАВИТЬ текущий паритет Firebase, не менять.
2. Скип «стал онлайн до тика» — НЕ СЛАТЬ (текущее поведение оставить), но только
   если это просто. Если упрощение требует возни — слать без перепроверки
   (убрать онлайн-гейт на диспатче, оставить только enqueue-гейт).
3. Сигнал mark-read — РЕШЕНО 2026-10-14: делать семантически чистый вариант,
   отдельный топик `dm.read`. План — в разделе 9 ниже. Консервативный dm.post
   (уже внедрён) заменяется в рамках шага 7.


## 7. Чеклист «письмо не пришло»

1. pending растёт → SMTP выкл; failed → last_error; sent+skipped → причина внутри.
2. skipped online при «точно офлайн» → logout или закрыт таб (75s)?
3. Строки нет → debug-лог maybeEnqueueDMEmail после шага 9.
4. sent без skipped, в ящике пусто → relay/SPF/DKIM, не форум.

## 8. Статус фиксов (баг 2)

DONE 2026-10-14, файлы:
- src/api/dms.js — markDmRead после POST зовёт refreshUnreadCounts(uid) +
  refreshDmList(uid) (best-effort, uid уже в сигнатуре).
- backend/.../dms.go markConversationReadHandler — publishSignal(dm.post)
  читателю после Save (ВРЕМЕННО, заменяется шагом 7 на dm.read; тест
  TestDMReadSignalWakesOnlyTheReader).
- backend/.../dm_read_signal_test.go — новый тест: сигнал доходит до читателя,
  пиру нет.
- scripts/check-dm-mutation-state.mjs — гейт: markDmRead обязан дёргать оба
  refresh (проверено node, eslint чисто).
- backend: build/vet/tests (TestDM*, Sprint5, Outbox, TopicPostSignal) зелёные.

DEFERRED: сброс lastReadSeqRef при смене диалога — по факту он уже сбрасывается
в эффекте подписки треда (DirectMessages.jsx:239) при каждом открытии чата, так
что кейс «короткий диалог после длинного» закрыт существующим кодом. Отдельный
шаг не понадобился.

ЗАПЛАНИРОВАНО (разделы 9-11 ниже): шаг 7 (dm.read), шаг 8 (точка вместо числа),
шаг 9 (debug-логи).

## 9. Шаг 7: чистый топик `dm.read` вместо переиспользованного `dm.post`

РЕШЕНИЕ 2026-10-14: отдельный топик (семантически чистый вариант).
Консервативный `dm.post` себе (уже внедрён в dms.go:1221 + тест
TestDMReadSignalWakesOnlyTheReader) — временный, заменяется этим шагом.

9.1. Почему отдельный топик, а не фильтр по entity_id.
Сигнал — это `{topic, entity_id, audience_id, at}`, контента нет. Фильтровать
«этот dm.post — про новое сообщение, а этот — про прочтение» по entity_id
(там convID в обоих случаях) клиент НЕ МОЖЕТ — id одинаковые, смысла в них нет.
Различать можно только по topic. Отдельный `dm.read` — единственный честный
разделитель. Прецедент фильтрации по топику уже есть: forum.js:188-191 отбрасывает
`dm.post` целиком и чужие `topic.post` по entity_id (там entity — topicId, у DM
оба кейса несут convID, так что этот приём не переносим).

9.2. Инвентарь подписчиков (все глухи к topic, каждый onEvent = onDelivered):
- dms.js:103 dm-list, :182 unread-counts, :340 dm-messages, :437 peer-card;
- forum.js:187 topic-stats (ЕДИНСТВЕННЫЙ фильтрует: dm.post отбрасывает);
- rtdb-notifications.js:62 user-notifications, :99 topic-notifications.
Вывод: новый топик подхватят ВСЕ перечисленные автоматом (re-read по любому
сигналу) — это безопасно (лишний перечит пустого изменения), кроме одного места:
forum.js:187-191. Туда добавить `if (signalTopic === 'dm.read') return;` рядом
с существующим dm.post-гардом, иначе статистика топика будет перечитываться на
каждое чужое mark-read.

9.3. Точное поведение по ресурсам при `dm.read` (адресован читателю):
- unread-counts (:182): ПЕРЕЧИТАТЬ — это его прямой потребитель (бейдж).
- dm-messages (:340): перечитает тред — безвредно (новых рядов нет, сойдётся на
  том же состоянии); отдельный фильтр по convID не нужен, т.к. сигнал адресован
  только читателю, а открыт у него может быть только его же диалог (чужой тред
  чужой сигнал не получит по audience-правилу).
- dm-list (:103): перечитает инбокс — полезно (превью unread-флага сойдётся).
- peer-card (:437): перечитает карточку — безвредно.
- user/topic-notifications, topic-stats: без изменений (topic-stats — гард!).

9.4. Бэкенд-правки (backend/internal/platform/pocketbase/):
- realtime_signals.go:46 — новая константа `realtimeSignalDMRead = "dm.read"`
  рядом с `realtimeSignalDMPost`, с комментом «read-receipt nudge, addressed to
  the reader; counters-only, never renders content».
- dms.go markConversationReadHandler — заменить `realtimeSignalDMPost` на
  `realtimeSignalDMPost`→`realtimeSignalDMRead` (строка ~1221), коммент обновить:
  «reusing dm.post would wake the thread as if a message arrived; dm.read wakes
  only the counters».
- Тест dm_read_signal_test.go — переименовать в TestDMReadSignalWakesOnlyTheReader
  оставить, ассёрты: топик `dm.read` (а не dm.post), доставка читателю, тишина пиру.
  Плюс явный кейс: тред пира (подписка dm-messages) на `dm.read` НЕ перечитывает
  лишнего — покрывается гардом audience (сигнал вообще не доставляется пиру).

9.5. Фронт-правки:
- forum.js:187-191 — добавить `if (signalTopic === 'dm.read') return;`.
- Больше НИЧЕГО не трогать: все DM-ресурсы подхватят новый топик без изменений
  (их onEvent глух к topic = перечитают). Комменты в dms.js:274-281 («dm.post is
  already published on every send») и dms.go:603-617 — дополнить строкой про
  dm.read, чтобы следующий читатель не решил, что read молчит.
- scripts/check-dm-mutation-state.mjs — гейт: markConversationReadHandler обязан
  публиковать realtimeSignalDMRead (а НЕ realtimeSignalDMPost); forum.js обязан
  отбрасывать оба dm-топика.

9.6. Порядок внедрения (чтобы не мигнуть половиной): сначала фронт-гард в forum.js
(безвреден: топика dm.read пока никто не шлёт), потом бэкенд-константа + замена +
тест, потом гейт в чек-скрипте. Проверка: открыть диалог → POST /read → сигнал
dm.read в логе realtime → GET unread-counts → бейдж гаснет; статистика топика не
дёргается.

9.7. Риски (все закрыты): audience-правило то же (читатель) — утечек нет; старый
тест TestDMPostSignalReachesOnlyItsRecipient не трогаем (он про send-путь);
откат = вернуть одну константу в dms.go.

## 10. Шаг 8: бейдж-кружок вместо счётчика (РЕШЕНИЕ 2026-10-14)

Владелец: «можно вообще без счётчика — просто красная точка, что есть
непрочитанные; когда прочитает все — снимать. Так будет проще?»

10.1. Ответ: ДА, проще — и убирает целый класс проблем. Что отпадает:
- мёртвое вычитание открытого диалога (Navbar.jsx:60-69, TitleProvider.jsx:47-50)
  удаляется вместо починки — вычитать больше нечего;
- per-conv map `unread_by_conversation` (шаг 3 из раздела 5) НЕ НУЖНА вообще;
- вопрос «3 — это три сообщения или три диалога» исчезает;
- серверный ответ не меняется: `total_unread_messages > 0` уже есть, это и есть
  условие точки (`has_unread = total > 0`).

10.2. Что МЕНЯЕТСЯ (только рендер, данные те же):
- Navbar.jsx:203-211 — вместо `{dmUnread > 99 ? '99+' : dmUnread}` рисовать точку
  (пустой Badge pill без числа, minWidth ~10px, aria-label «есть непрочитанные»).
  Условие показа то же: `dmUnread > 0`. Переменная `dmUnread` остаётся числом
  внутри (нужна звуку: `totalBadge > prev` в :94-100 — звук срабатывает на РОСТ,
  точке рост тоже виден, логику звука НЕ трогать).
- TitleProvider.jsx:47-50 — `dmCount` заменить на `hasDmUnread = total > 0 ? 1 : 0`
  (вкладке число всё равно нужно: `(N)` в title; N = notifications + topics +
  hasDmUnread-как-1 — вкладка покажет «есть ЛС» как +1, это честно для точки).
  Мёртвую ветку `conversations[activeDmConvId]` удалить вместе с деструктуризацией
  `conversations` (контракт subscribeToUnreadCounts при этом НЕ менять — поле
  `conversations: {}` остаётся для совместимости, просто никто не читает).
- Звук (Navbar :75-100): оставить на totalBadge — точка тоже даёт рост 0→N→0,
  ложных срабатываний не добавляется.
- i18n: добавить aria-label «есть непрочитанные ЛС» (ru/en) — точка без числа
  должна читаться скринридером.

10.3. Что НЕ меняется: markDmRead+refresh (шаг 1), dm.read-сигнал (шаг 7),
серверный unread-counts, звук, колокольчик уведомлений (там число остаётся —
решение только про ЛС).

10.4. Тесты: чек-скрипт — гейт «DM-бейдж не рендерит число» (нет `99+`/интерполяции
числа в DM-Badge); TitleProvider — hasDmUnread boolean. Ручная приёмка: есть
непрочитанные → точка; открыл диалог → точки нет сразу (шаги 1+7 уже дают).

10.5. Риск: пользователи привыкли к числу. Смягчение — тултип «N новых» оставить?
РЕШЕНО: нет, точка без числа (решение владельца). Title вкладки число сохраняет
как +1.

## 11. Шаг 9: Debug-логи тихих гейтов (РЕШЕНО 2026-10-14 — делать)

11.1. Места (все — молчаливые return без следа):
- dms.go maybeEnqueueDMEmail: (a) `!dmEmailEnabled` (b) `isMemberOnline`
  (c) нет шаблона `dm`. Добавить `txApp.Logger().Debug(...)` с conv, recipient,
  причиной — поведение НЕ менять.
- outbox.go enqueueOutboxEvent no-op при совпадении dedupe_key (вторая волна в
  непрочитанном диалоге) — Debug «suppressed by dedupe».
- outbox.go dmEmailSkipReason — там уже возвращается строка причины в last_error,
  логировать нечего, только убедиться что `skipped: recipient online` etc.
  пишутся (пишутся — outbox.go:253-303).
11.2. Уровень Debug (не Info): путь горячий (каждое ЛС), в прод-логе не шуметь;
найти можно включением debug или grep pb_data/logs.
11.3. Тест: backend-ассёрт, что maybeEnqueueDMEmail при онлайн-получателе НЕ
создаёт строку И пишет лог? Лог ассёртить хрупко — ограничиться существующим
countOutboxByKey==0 (уже покрыто TestDMEmailSkippedWhenRecipientOnline) +
коммент в коде. Гейт в чек-скрипт не нужен (Go-сторона).
11.4. Порядок: после шагов 7-8, отдельным коммитом (только логи, ноль поведения).
