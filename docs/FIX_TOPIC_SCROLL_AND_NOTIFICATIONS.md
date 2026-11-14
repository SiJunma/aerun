# Исправление скролла и уведомлений в теме (TopicPage)

**Версия:** 1.1  
**Дата:** 13.11.2026  
**Область:** `src/pages/TopicPage.jsx`, `src/hooks/topic/useTopicJumpScroll.js`, `src/utils/notificationSound.js`  
**Статус:** Реализовано в коде (см. раздел «Готовность»).

---

## 1. Постановка задачи (три проблемы)

| № | Проблема | Ожидаемое поведение |
|---|----------|---------------------|
| 1 | При входе в тему с несколькими непрочитанными постами страница скроллит к **последнему** посту, а не к **первому непрочитанному**. | Скролл к первому посту, который пользователь ещё не читал. Если всё прочитано — к последнему. |
| 2 | При появлении нового ответа от другого участника страница дёргается (скроллит вверх-вниз, останавливается около формы ответа). Нужно: **никакого скролла**, только звук уведомления. | Новый пост добавляется в список, viewport не сдвигается, звучит `playNotificationSound()`. |
| 3 | Счётчик упоминаний (в навигации, title, favicon) не сбрасывается, пока пользователь читает тему — даже если он проскроллил все посты. Сброс происходит только при реальном скролле к посту с упоминанием (когда пост попадает в фокус/viewport). | Счётчик сбрасывается только когда пользователь реально скроллил к посту с упоминанием и он попал в viewport. При просто нахождении в теме счётчик не сбрасывается. При скролле к последнему посту — все упоминания перед ним тоже помечаются прочитанными. |


---

## 2. Состояние кодовой базы (фактический аудит)

### 2.1. Файлы, задействованные в задачах

| Файл | Роль |
|------|------|
| `src/pages/TopicPage.jsx` | Основной компонент темы: рендер постов, эффекты загрузки, живые обновления, marker read. |
| `src/hooks/topic/useTopicJumpScroll.js` | Логика скролла к посту (`post=`, `goLast=1`, hash), `alreadyJumpedRef`, `markTopicRead` при прыжке. |
| `src/api/forum.js` | `normalizePost` — добавляет `created_at_ms` (стр. 43). `normalizeTopic` — `created_at_ms` / `last_post_at_ms` (стр. 25–26). `locateUnreadPost` — заглушка, возвращает `1` (стр. 680–682). |
| `src/utils/notificationSound.js` | `playNotificationSound(volumePercent = 40)` — звуковой сигнал через Web Audio API, требует предварительного пользовательского взаимодействия (`userInteracted`). |
| `src/hooks/topic/useTopicPosts.js` | `readCutoffRef`, `skipNextLoadForPageRef`, `loadedPageRef` — utilisées в Effect 15 и Effect 16b. |

### 2.2. Ключевые эффекты в `TopicPage.jsx` (фактическое состояние после реализации)

**Effect 15 (строки ~1472–1486)** — «Mark topic as read when posts are displayed»:
- Срабатывает при изменении `posts`, `currentPage`.
- Находит последний реальный пост на странице (`lastRealPost`).
- Вызывает `markTopicRead(id, lastMessageIndex, lastRealPost.id)`.
- *Примечание:* сбрасывает локальный read-кursor темы, но глобальный счётчик упоминаний/новых ответов в navbar обновляется отдельно (см. Effect 16b и Effect 12).

**Effect 16b (строки ~1526–1610)** — «Live updates from OTHER readers»:
- Следит за ключом `${id}|${last_post_id}|${posts_count}`.
- При росте `posts_count` (чужий пост): вызывается `playNotificationSound()` (звук в стиле Telegram) **без скролла viewport**.
- Вызывается `scheduleForumStateRefresh()` для обновления категорий/статуса форума.
- *Примечание:* при чужом посте **не** вызывается `refreshUnreadCounts` — новый чужой пост не является «прочтением упоминания», поэтому счётчик упоминаний не должен сбрасываться. Он обновится по следующему 15s тику `subscribeToUnreadCounts`.

**Effect 12 (строки ~1371–1377)** — «Quote notifications subscription»:
- `subscribeToTopicNotifications(user.uid, id, callback)` → `setUnreadQuotes(activeQuotes)`.
- Обновляет локальное состояние `unreadQuotes`.

**Effect IntersectionObserver (строки ~1399–1422)** — «Сброс упоминаний при скролле»:
- При попадании поста с упоминанием/цитатой в viewport — `markNotificationRead(n.id)` + `refreshUnreadCounts(user?.uid)`.
- *Примечание:* это **правильное** поведение — сброс происходит только при реальном скролле к посту, когда он попадает в фокус. При просто нахождении в теме счётчик не сбрасывается. При скролле к последнему посту промежуточные посты с упоминаниями тоже попадают в viewport по очереди и помечаются прочитанными.

**`useTopicJumpScroll` (строки 50–115)** — скролл к целевому посту:
- При `goLastParam === '1'` ищет **первый** непрочитанный пост через `readCutoffRef.current` (`created_at_ms > cutoff.value`, сортировка по возрастанию).
- Fallback (гость / всё прочитано): `posts[posts.length - 1]` — последний пост.
- `readCutoffRef` передаётся из `useTopicPageCore` (строка 157 в TopicPage.jsx) → `useTopicJumpScroll` (строка 334).

**`useTopicPosts.js` (строка 131)** — `readCutoffRef.current = { topicId, value: toMillis(readCutoff) }` устанавливается при `pageToFetch === 'last' && readCutoff` (т.е. при `?goLast=1`).

### 2.3. Уже существующая инфраструктура (не требовала изменений)

| Элемент | Файл | Роль |
|---------|------|------|
| `playNotificationSound()` | `src/utils/notificationSound.js` | Web Audio API чим, требует `userInteracted` (установлен при первом клике/клавиатуре/скролле) |
| Звук в navbar | `src/components/layout/Navbar.jsx` (строки 75–101) | Звук при росте `totalBadge` (уведомления + DM) |
| Tab title + favicon | `src/contexts/TitleProvider.jsx` | `(N)` в title + бейдж на favicon, подписка на `subscribeToUnreadCounts` |
| Navbar badge | `src/components/layout/Navbar.jsx` | `unreadCounts.notifications` + `unreadTopicsCount` из `useAuth()` |

## 3. Решения по каждой проблеме

### Проблема 1: Скролл к первому непрочитанному посту

**Место правки:** `src/hooks/topic/useTopicJumpScroll.js` (блок `goLastParam === '1'`, строки 62–80) и, при необходимости, `TopicPage.jsx` Effect 16b.

**Логика:**

1. При загрузке темы (или при `?goLast=1`) собрать список постов текущей страницы.
2. Определить «точку отсчёта» прочтения:
   - Если есть `readCutoffRef.current` (сервер вернул cutoff) — использовать его.
   - Иначе — использовать время последнего посещения темы пользователем (из `topic_read_states` / localStorage / контекста).
3. Пройти по постам в порядке возрастания `created_at_ms` и найти **первый** пост, у которого:
   - `!p._isOptimistic`
   - `p.created_at_ms > cutoff` (или `p.id` не в прочитанных)
4. Если такой пост найден — скроллим к `post-{id}`.
5. Если непрочитанных нет — скроллим к последнему посту (текущее поведение).

**Примерный фрагмент (useTopicJumpScroll.js):**

```js
} else if (goLastParam === '1') {
  const cutoff = readCutoffRef?.current;
  let target = null;

  // Ищем ПЕРВЫЙ непрочитанный пост по created_at_ms
  if (cutoff && cutoff.topicId === topicId) {
    target = posts
      .filter((p) => !p._isOptimistic && p.id && p.created_at_ms > cutoff.value)
      .sort((a, b) => a.created_at_ms - b.created_at_ms)[0] || null;
  }

  // Fallback: последний пост на странице (если всё прочитано или нет cutoff)
  if (!target) {
    target = posts.find((p) => !p._isOptimistic && p.id) || posts[posts.length - 1] || null;
  }

  if (target) targetId = `post-${target.id}`;
}
```

**Примечание:** `created_at_ms` уже есть в `normalizePost` (forum.js стр. 43), дополнительных полей с сервера не требуется.

---

### Проблема 2: Нет скролла на чужой ответ + звук

**Место правки:** `src/pages/TopicPage.jsx` Effect 16b (строки 1526–1590) и/или `useTopicJumpScroll.js`.

**Логика:**

1. В Effect 16b, при обнаружении роста `posts_count` (чужий пост), **не вызывать** никакой логики скролла viewport.
2. Добавить вызов `playNotificationSound()`:
   - Импортировать из `src/utils/notificationSound.js`.
   - Учитывать настройки звука пользователя (`profile?.settings?.sound?.enabled !== false`, `volume ?? 40`), по аналогии с `Navbar.jsx` и `DirectMessages.jsx`.
3. Сохранить тихий рефетч `loadPostsRef.current()` — посты должны появиться в списке, но без прыжка экрана.

**Примерный фрагмент (TopicPage.jsx, Effect 16b):**

```js
import { playNotificationSound } from '../utils/notificationSound';
// ... внутри Effect 16b, после определения, что пришёл чужой пост:
if (postsCountGrew && !isSubmittingReplyRef.current) {
  // Звук уведомления (если разрешён в настройках)
  const isSoundEnabled = profile?.settings?.sound?.enabled !== false;
  if (isSoundEnabled) {
    playNotificationSound(profile?.settings?.sound?.volume ?? 40);
  }
  // Тихий рефетч — без скролла viewport
  loadPostsRef.current();
}
```

**Важно:** Не вызывать `scrollIntoView`, `window.scrollTo`, `ref.current.scrollTop = ...` и т.п. при прибытии чужого поста. Браузерный scroll anchoring сам удержит позицию компоузера и каретки.

---

### Проблема 3: Сброс счётчика упоминаний только при скролле к посту

**Место правки:** `src/pages/TopicPage.jsx` (Effect 15, Effect 12), `src/hooks/topic/useTopicPageCore.js`, possibly `src/contexts/AuthProvider.jsx`.

**Логика:**

1. **Локальное состояние:** При рендере каждого поста в теме проверять, является ли пост упоминанием/ответом на пользователя (`post.author.user_id === user.uid` или содержит `@username` / цитату). Если да — помечать как непрочитанный локально.
2. **Механизм сброса:** Счётчик сбрасывается только при реальном скролле к посту с упоминанием (IntersectionObserver). При просто нахождении в теме и при прилёте чужого поста (Effect 16b) счётчик не сбрасывается.
3. **При просто нахождении в теме:** Пока компонент `TopicPage` смонтирован и пользователь активен (фокус на окне/вкладке), счётчик не сбрасывается автоматически при маркировке постов как прочитанных Effect 15. Сброс происходит только при реальном скролле к посту с упоминанием (IntersectionObserver).
4. **Статус title/favicon:** Уже работает через `TitleProvider` и `subscribeToUnreadCounts` — обновляются при сбросе упоминаний через `refreshUnreadCounts`.

**Итог:**
- Добавить в `TopicPage.jsx` импорт `playNotificationSound` (если ещё не добавлен).
- В Effect 16b при росте `posts_count` выполнять `scheduleForumStateRefresh()` (если хук доступен) или обновлять локальный счётчик непрочитанных.
- В Effect 15 не сбрасывать `unreadQuotes` / `unreadCount`, пока `document.hasFocus()` и компонент смонтирован.


---

## 4. План реализации (пошагово)

### Этап 1 — Подготовка (анализ и импорты)
1. Прочитать `Navbar.jsx` и layout, чтобы понять, как именно обновляется `document.title` и favicon (где хранится глобальный `unreadCount`).
2. Убедиться, что `profile.settings.sound` доступен в `TopicPage.jsx` (уже деструктурируется через `useAuth` → `settings`).
3. Добавить импорт `playNotificationSound` в `TopicPage.jsx`.

### Этап 2 — Проблема 1: Первый непрочитанный пост
1. В `useTopicJumpScroll.js` изменить блок `goLastParam === '1'`: искать первый пост с `created_at_ms > cutoff.value`, сортируя по возрастанию.
2. Если cutoff отсутствует — искать первый пост, которого нет в прочитанных (имеется в `readCutoffRef` или локальном состоянии).
3. Fallback — последний пост (как сейчас).

### Этап 3 — Проблема 2: Звук вместо скролла
1. В `TopicPage.jsx` Effect 16b добавить вызов `playNotificationSound()` при росте `posts_count` от чужого автора.
2. Убедиться, что при живом рефетче не вызывается `scrollIntoView` / `window.scrollTo` и не меняется `scrollTop`.
3. Опционально: добавить визуальный индикатор «новые сообщения» (без скролла).

### Этап 4 — Проблема 3: Динамический счётчик (уже реализовано)
1. Effect 12 (quote notifications) — `subscribeToTopicNotifications` обновляет локальное состояние `unreadQuotes`.
2. Effect IntersectionObserver — при попадании поста с упоминанием/цитатой в viewport вызывается `markNotificationRead(n.id)` + `refreshUnreadCounts(user?.uid)`. Сброс происходит **только** при реальном скролле к посту.
3. При чужом посте (Effect 16b) **не** вызывается `refreshUnreadCounts` — новый чужой пост не является «прочтением упоминания», счётчик не сбрасывается.
4. При просто нахождении в теме без скролла к посту — счётчик не сбрасывается. Соответствует требованию пользователя.

### Этап 5 — Проверка
1. Открыть тему с несколькими непрочитанными постами → убедиться, что скролл к первому непрочитанному.
2. Открыть тему в одном окне, отправить ответ из другого → убедиться, что нет скролла, звук играет.
3. Находясь в теме, получить упоминание → счётчик вNavbar/title **не** обновляется до скролла к посту с упоминанием (обновляется только после реального скролла в фокус).

---

## 5. Ответы на открытые вопросы / риски

| Вопрос | Ответ / допущение |
|--------|-------------------|
| Есть ли у постов флаг `is_read`? | Нет явно — непрочитанность определяется через `created_at_ms` и `readCutoffRef` (время последнего визита). |
| Где глобальный `unreadCount`? | Скорее всего в `AuthProvider.jsx` или контексте уведомлений; требует уточнения при реализации Этапа 1. |
| Будет ли звук блокироваться браузером? | `playNotificationSound` требует `userInteracted` (клик/клавиатура/скролл), установленного при первом взаимодействии с окном. |
| Не сломает ли отказ от скролла UX для автора? | Автор своего ответа скроллится через `navigateToCreatedPost` / `pendingCreatedPostIdRef` — это отдельный путь, не затронутый Effect 16b. |

---

## 6. Связанные файлы и контракты

- `scripts/check-first-post-guard.mjs` — контракт `isTopicFirstPost`.
- `scripts/check-forum-read-contract.mjs` — контракт `markTopicRead` / `readCutoffRef`.
- `scripts/check-golast-overlay.mjs` — контракт `goLast=1` и `alreadyJumped`.
- `scripts/check-post-navigation.mjs` — контракт `navigateToCreatedPost`.

---

## 7. Заключение

Все три проблемы локализуются в `TopicPage.jsx` и `useTopicJumpScroll.js`. Инструментарий уже есть в репозитории (`created_at_ms`, `playNotificationSound`, `markTopicRead`, `readCutoffRef`, `subscribeToTopicNotifications`). Реализация требует точечных правок без переработки архитектуры.

## 8. Исправление регрессии: двойной скролл при публикации своего поста (13.11.2026)

**Симптом:** при публикации своего ответа на той же странице экран дёргался трижды — к оптимистичному посту, к форме ответа и снова к подтверждённому посту.

**Причина:** в `TopicPage.jsx` (`handleReplySubmit` и `handlePublishDraft`, ветка same-page) после добавления оптимистичной строки делался прямой `scrollIntoView` к `post-{tempId}` через `setTimeout(..., 50)`. После ответа сервера унифицированный контроллер `useTopicJumpScroll` (`pendingCreatedPostIdRef` + `navigateToCreatedPost`) делал ещё один скролл — уже к реальному `post-{newPostId}`.

**Исправление:** убраны оба прямых скролла к оптимистичному placeholder-у (`src/pages/TopicPage.jsx`). Скролл автора своего поста теперь идёт только через контроллер `useTopicJumpScroll` / `navigateToCreatedPost` / `pendingCreatedPostIdRef` (как зафиксировано в разделе 5): один скролл — к подтверждённому посту после ответа сервера; при публикации черновика — один скролл контроллером к оптимистичной строке, повторного дёргания после реконсиляции нет.

**Проверка:** `npm run test:golast-overlay` — OK, `npm run test:forum-read-contract` — OK, `npx eslint src/pages/TopicPage.jsx` — OK.

## 9. Исправление регрессии: скролл к центру длинного поста (13.11.2026)

**Симптом:** при скролле к посту (после публикации, перехода по `?post=`, `#post-`, `?goLast=1`, ссылке на сообщение, редактировании) экран позиционировал пост по центру вьюпорта (`block: 'center'`). Для длинных постов это означало, что верх поста уходил за верхнюю границу экрана, а читать приходилось с середины текста.

**Исправление:** везде, где делается скролл к посту в теме, `block: 'center'` заменён на `block: 'start'` — пост прижимается к верхнему краю вьюпорта, его начало всегда видно:

- `src/hooks/topic/useTopicJumpScroll.js` — скролл к целевому посту (`post=`, `#post-`, `goLast`, `pendingCreatedPostIdRef`)
- `src/hooks/topic/useTopicModalState.js` — скролл к посту после редактирования
- `src/hooks/topic/useTopicNavigation.js` — `scrollToPost` (дефолт `block` с `'center'` на `'start'`)
- `src/pages/TopicPage.jsx` — скролл к посту черновика после обновления
- `src/components/common/BBCode.jsx` — скролл к посту по ссылке на сообщение

**Проверка:** `npm run test:golast-overlay` — OK, `npm run test:forum-read-contract` — OK, `npx eslint` по всем изменённым файлам — 0 ошибок.
