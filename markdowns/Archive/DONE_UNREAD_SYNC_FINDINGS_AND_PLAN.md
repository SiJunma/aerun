# Непрочитанное: рассинхрон badge ↔ индикаторы строк

Два симптома из репорта, оба — одна корневая болезнь: **понятие «непрочитано»
после миграции на PocketBase живёт в ДВУХ несинхронизированных источниках.**

## Симптомы

1. **Badge «непрочитанное» не гаснет сразу.** Открыл тему с главной → тема
   пропала из `/new-replies` и строка погасла, но бейдж в навбаре, таб
   «Новые ответы» и title вкладки висят старым числом. Через несколько секунд
   (15–20с) сами очищаются.

2. **«Пометить все прочитанными» обнуляет счётчик, но строки остаются
   помеченными.** На `/new-replies` нажал «отметить всё прочитанным» → badge =
   0, но темы на главной и в категориях по-прежнему с индикатором новых
   сообщений. Отмечено «возможно баг после миграции».

---

## Корень: два источника истины

| Что | Источник | Кто питает |
|-----|----------|-----------|
| Счётчик `unreadTopicsCount`, фид `/new-replies` | **Серверный** read-state (`topic_read_states`, `unreadTopicsPredicate`) | badge навбара, таб, title, список new-replies |
| Индикаторы строк (`unread-dot`, «К первому непрочитанному») | **Локальный** `readMap` (localStorage + React state) | `TopicRow`, `MainPage`, `LastPostInfo` |

После миграции сервер стал единственным настоящим read-state, но строки на
главной/в категориях всё ещё считают «непрочитано» по локальному `readMap`
(localStorage). Любая операция, которая двигает только один источник — или
двигает оба, но по РАЗНЫМ множествам id — даёт ровно эти симптомы.

---

## Подтверждённые факты из кода

### Индикаторы строк — чистый localStorage
- `src/components/common/TopicRow.jsx:25-36`
  `hasUnread = lastPostMs > unreadFloor(readMap[topic.id], profile?.created_at)`
- `src/pages/MainPage.jsx:160-166` — тот же предикат по `cat.last_post_topic_id`
- `src/components/common/LastPostInfo.jsx` — рисует `unread-dot` по пропу `hasUnread`

### `subscribeToReadMap` — одноразовое чтение, без storage-событий
- `src/api/auth-resources.js:109-123` — читает localStorage **один раз** при
  подписке, `unsubscribe` — noop. Нет `addEventListener('storage')`. Живой
  синхронизации между вкладками/компонентами нет — только React state из
  `setReadMap`.

### `markTopicRead` (AuthProvider.jsx:828-840) — уже с partial-fix
`setReadMap` + `apiRecordTopicVisit` + `refreshUnreadCounts()` +
`refreshUnreadTopics()`. Refresh закрывает симптом №1 (badge). Это уже сделано.

### `markAllRead` (AuthProvider.jsx:853-879) — двигает ОБА, но неполным множеством
`apiMarkAllTopicsRead(ids)` + `setReadMap(ids)` + `apiRecordAllTopicVisits(ids)`
+ `refreshUnreadCounts()` + `refreshUnreadTopics()`.

**НО `ids` — это `unreadTopics.map(t => t.id)`, т.е. только видимый список
серверного `/new-replies` (одна страница, серверно-unread).**

### Серверный предикат (backend/…/notifications.go:583-639)
`unreadTopicsPredicate` = `category_id IN readable AND last_post_author_id != me
AND last_post_created > COALESCE(last_read_at, my_registration)`.

### Серверный read-all (notifications.go:133-180)
`markAllTopicsReadHandler` отмечает **только переданные ids**, 403 на чужую
категорию. Клиент передаёт неполный набор → «фантомно-unread» темы не
трогаются.

---

## Гипотезы root-cause (по симптому)

### ✅ Спринт 0 — ВЕРДИКТ (данные VPS, аккаунт после миграции)
Фантом-гипотеза **опровергнута**. Замер сразу после «прочитать всё»:
- `unread_topics: 3` (НЕ обнулился) + `server unread feed total = 3`
- `rendered-as-unread ids = []` (на главной точек нет)
- `PHANTOMS = 0`, `readMap entries = 22`

**Корень (подтверждён):** `mark-all` отработал **частично**. Клиент шлёт
серверу `unreadTopics.map(t => t.id)` — это снимок ОДНОЙ страницы серверного
new-replies. Сервер помечает присланное → badge падает, но 3 реально-
непрочитанные темы в снимок не попали → `unread_topics` остаётся 3. На главной
их не видно (они не `last_post` своих категорий), а в `CategoryPage` горят.
readMap/localStorage не виноваты.

**Следствие:** оба бага — одна причина. `mark-all`/`mark-one` двигают read-state
по **клиентскому снимку**, а не по серверной истине. Сервер должен сам решать,
что читать (`all:true`), и возвращать полный список отмеченных `ids`, чтобы
скрытые темы погасли и в `CategoryPage`.


### Симптом №1 (badge не гаснет сразу) — подтверждён и закрыт
Badge/tab/title рендерят последний **полл** `/me/unread-counts` (15с) и
`subscribeToUnreadTopics` (20с). Запись read-state их не инвалидировала.
Fix: `refreshUnreadCounts()` + `refreshUnreadTopics()` в `markTopicRead` и
`markAllRead`. Уже применено.

### Симптом №2 (mark-all гаснет счётчик, но строки висят) — ПОДТВЕРЖДЁН по коду
Механизм — «фантомно-unread» тема T, и он выводится прямо из кода:

- `src/pages/NewRepliesPage.jsx:125-131` — кнопка mark-all шлёт
  `unreadTopics.map(t => t.id)`, где `unreadTopics` — это серверный список
  `/new-replies` (tab NEW = серверно-непрочитанные), **дополнительно
  перефильтрованный по локальному `readMap`** (`unreadFloor(readMap[t.id])`).
- Тема T: серверно **прочитана** (`last_read_at` свежий → нет в `/new-replies`
  и не в `unreadTopicsCount`), но localStorage `readMap[T]` пуст/устарел (кэш из
  Firestore-эпохи, который миграция на `topic_read_states` не тронула).
- Тогда T отсутствует в серверном списке → не попадает в `ids` → `markAllRead`
  не двигает `readMap[T]` → `TopicRow`/`MainPage` (`lastPostMs > registration-floor`)
  рисуют T непрочитанной. Badge при этом = 0 (серверно T прочитана).

Именно этот сценарий даёт «badge=0, а индикатор висит, и переживает reload».
Вариант «пагинация не покрыла все» отброшен: он бы НЕ обнулил серверный badge,
а в репорте badge обнулился.

**Вывод:** индикаторы строк должны читать серверный read-state, а localStorage
`readMap` — только fallback. Спринт 1+2.

---

## Решение (подтверждено)
Уходим от localStorage ПОЛНОСТЬЮ. Единственный источник read-state — сервер
(`topic_read_states`). Локальный `readMap` в AuthProvider наполняется С СЕРВЕРА,
localStorage больше не участвует (Спринт 3 удаляем).

Стратегия: потребители (`TopicRow`, `MainPage`, `LastPostInfo`, `TopicPage`
`?goLast`) УЖЕ читают `readMap[id]`. Менять их почти не нужно — нужно лишь
поменять ИСТОЧНИК `readMap` с localStorage на серверный ответ. Так предикат
непрочитанности остаётся в одном месте, а `topicPayload`/проекции остаются
чистыми (им не надо тащить userId). Формат значения `readMap[id]` привести к
совместимому (timestamp ms или `{timestamp, offset}` — уточнить по потребителям).

---

## План правок (спринты)

### Спринт 0 — Подтверждение (без изменения поведения)
- [ ] Убедиться в «фантоме»: сравнить localStorage `readMap[T]` с серверным
      `last_read_at` для «зависшей» темы (одноразово, перед удалением LS).

### Спринт 1 — Серверный readMap (backend + источник)
- [ ] Backend: endpoint `/api/aerun/me/topic-read-states` →
      `{ [topic_id]: last_read_at_ms }` для категорий, доступных пользователю.
      Тот же read-state, что и `unreadTopicsPredicate` (единый источник).
- [ ] `subscribeToReadMap` (auth-resources.js): читать endpoint вместо LS.
- [ ] `apiRecordTopicVisit` / `apiRecordAllTopicVisits`: убрать запись в LS.
- [ ] Backend-тест: ответ endpoint == предикат new-replies/счётчика.

### Спринт 2 — mark-one / mark-all двигают правильное множество
- [ ] `markTopicRead`: после записи refresh readMap с сервера (счётчик закрыт).
- [ ] Серверный read-all: отмечать ВСЕ непрочитанные пользователя (не клиентский
      набор ids).
- [ ] `markAllRead`: refresh readMap с сервера → строки гаснут без reload.

### Спринт 3 — Cleanup localStorage
- [ ] Удалить `readMap` из localStorage, storage-события, `getReadMapKey`.
- [ ] Обновить README/ADR: один источник истины для непрочитанного.

---

## Спринт 0 — Вердикт (прогон на VPS, после «прочитать все»)

```
unread-counts        = { unread_topics: 3, ... }   ← сервер НЕ обнулился
server feed total    = 3                            ← согласовано со счётчиком
rendered-as-unread[] = []                            ← на главной точек нет
PHANTOMS             = 0                            ← фантом-гипотеза ОПРОВЕРГНУТА
readMap entries      = 22
```

**Вывод (единственный, без переосмыслений):** `read-all` отработал
**частично**. Он отмечает только те id, что прислал клиент — а клиент шлёт
снимок полла `subscribeToUnreadTopics` (пагинированный, 1 страница). 3 реально
непрочитанные темы в снимок не попали → остались непрочитаны на сервере → и
горят в CategoryPage (на главной их не видно, т.к. они не `last_post_*` своих
категорий). Баг №1 (badge) и №2 (строки) — одна причина: **read-all доверяет
неполному клиентскому списку вместо того, чтобы сервер резолвил множество
сам.**

## Правки

### ✅ Спринт 1 (backend) — СДЕЛАНО
`notifications.go` `markAllTopicsReadHandler`: добавлено поле `all`. При
`all:true` сервер сам резолвит множество через `unreadTopicIDs(e)` (тот же
предикат, что фид и счётчик) и отмечает **все** непрочитанные темы, а не
присланный клиентом снимок. Обратная совместимость сохранена: без `all`
работает прежняя ветка по `topic_ids`.

### ✅ Спринт 1 (frontend) — СДЕЛАНО
`apiMarkAllTopicsRead(uid)` шлёт `{ all: true }` (без `topic_ids`).
`AuthProvider.markAllRead` больше НЕ принимает значимый `topicIds` (параметр
`_topicIds` игнорируется — сигнатура сохранена ради контракт-теста), двигает
локальный `readMap` по **серверному** `res.ids` (полный набор) и дёргает
`refreshUnreadCounts()` + `refreshUnreadTopics()`. Итог: «отметить всё» теперь
гасит badge, список и строки в категориях без reload — по одному источнику.

### Спринт 2+ — без изменений (строки на серверном источнике)
Остаются как в плане ниже.

### ✅ Спринт 3 (backend) — главный индекс несёт серверный `unread` — СДЕЛАНО
`listForumIndexHandler` (category_access.go): резолвит множество непрочитанных
тем вызывающего через **тот же** `unreadTopicIDs(e)`, что фид и бейдж
(`unreadSet`, guarded `e.Auth != nil`), и проставляет на каждую категорию
`item["unread"] = last_post_topic_id ∈ unreadSet`. Гостю флаг не отдаётся
(остаётся absent) — клиент различает «сервер сказал: прочитано» и «нет ответа».

### ✅ Спринт 3 (frontend) — главная читает серверный флаг — СДЕЛАНО
- `src/api/categories.js` `toCategory`: пробрасывает `unread` только когда
  сервер прислал boolean (иначе absent — тот же контракт, что на бэкенде).
- `src/pages/MainPage.jsx`: серверный `cat.unread` имеет приоритет
  (`serverUnread ?? localStorage-предикат`), localStorage остался фолбэком для
  payload без флага, за теми же `!!user` / role / own-post гейтами.

Итог Спринта 3: индикаторы на главной и «Пометить всё» теперь опираются на
один серверный предикат, как badge и `/new-replies` — три поверхности, один
источник истины.

---

## Definition of Done
- [x] «Пометить всё прочитанным» на `/new-replies`: badge=0, список пуст, И
      главная+категории без индикаторов — без reload. *(Спринт 1 закрывает)*
- [x] Открытие темы гасит её индикатор сразу (не через 15с). *(partial-fix #1)*
- [x] «Фантомно-unread» тема (серверно прочитана) не висит после reload.
- [x] `check-forum-read-contract` (13/13 OK), eslint (EXIT=0) и backend
      read-contract тесты зелёные (`go test` 13/13 PASS, вкл.
      `TestMarkAllTopicsReadClearsTheBadge`).

## Заметки
- Вариант A (идеал) = полный per-row серверный флаг, localStorage убран.
- Вариант C (прагматичный) = серверный `last_read_at` primary + localStorage
  fallback. Рекомендую C как основу.
- Вариант B (только mark-all двигает больше) НЕ лечит фантомы — временный
  костыль, если Спринт 1 отложен.

---

## Результат Спринта 0 (VPS, после миграции, до правки первого бага)

Запущено сразу после «Пометить всё прочитанным», БЕЗ reload:

```
readMap key = aerun_readmap_4rabsn981lslz41 | entries = 22
me.created = N/A
unread-counts = {unread_topics: 3, unread_notifications: 0, ...}
server unread feed total = 3
rendered-as-unread ids = []      ← на главной unread-dot не горит
PHANTOMS = 0
```

### Интерпретация — ГИПОТЕЗА «фантом-localStorage» ОПРОВЕРГНУТА
- `unread_topics = 3` **после** нажатия «прочитать все» ⇒ **mark-all не добил
  сервер**. Read-all отработал по НЕПОЛНОМУ набору ids.
- `PHANTOMS = 0` ⇒ сервер и readMap не расходятся в сторону «сервер чист,
  строка горит». Проблема не в localStorage-фантоме.
- `rendered-as-unread = []` ⇒ эти 3 темы не последние посты категорий, поэтому
  на ГЛАВНОЙ их индикатора нет. Симптом №2 («строки висят») живёт в
  **CategoryPage**, а не на главной.

### Новый корневой диагноз
Оба симптома = **mark-all / mark-one двигают read-state по неверному/неполному
множеству id**, и badge и строки читают это НЕДОДВИНУТОЕ состояние:
- badge №1 не гаснет сразу → был отсутствующий refresh (уже исправлено).
- строки/счётчик №2 → mark-all шлёт `ids` из `unreadTopics` (страница/полл),
  а не полный серверный набор непрочитанного ⇒ 3 темы остаются серверно
  непрочитанными и продолжают «гореть» в категориях.

**Следующий шаг (Спринт 1):** сделать серверный read-all, который отмечает ВСЕ
непрочитанные темы пользователя сам (не полагаясь на клиентский список ids),
и/или отдать per-row `last_read_at`, чтобы строки читали тот же источник, что
и счётчик.

