# FINDINGS: мигание скелетоном при загрузке топика (goLast / ?post=)

**Дата:** 2026-10-15
**Файл:** `src/pages/TopicPage.jsx`
**Статус:** причина найдена, фикс реализован и проверен (2026-10-15)

## Симптом

При открытии топика по `?goLast=1` или по прямой ссылке `?post=ID` тема сначала
загружается правильно (посты видны, скролл к цели выполнен), после чего интерфейс
мигает: отрендеренный контент прячется за `TopicPageSkeleton`
(`skeleton-jump-placeholder`), а затем перерисовывается заново с повторной
прокруткой и повторной подсветкой поста.

## Корневая причина

`loadPosts` при резолве `?goLast=1` / `?post=ID` записывает вычисленную страницу в
URL через `setSearchParams(..., { replace: true })`
(`TopicPage.jsx:394-403` для `?post=`, `TopicPage.jsx:404-412` для `goLast`).

**React Router v7 генерирует НОВЫЙ `location.key` даже для REPLACE-навигации**
(см. исходники `node_modules/react-router/dist/development/chunk-XOLAXE2Z.js`):

- `replace2()` (стр. 314–325) вызывает `createLocation(history.location, to, state)`;
- `createLocation()` (стр. 226–241) назначает `key: to && to.key || key || createKey()` —
  старый ключ не наследуется, каждый replace получает свежий случайный key;
- `BrowserRouter` (`chunk-2YMDXNOJ.js:271-296`) слушает history и вызывает
  `setState` внутри `React.startTransition`.

TopicPage трактует **каждую** смену `location.key` как новую навигацию:

```js
// TopicPage.jsx:1033-1035
useEffect(() => {
  setAlreadyJumped(false);
}, [id, locationKey, setAlreadyJumped]);
```

Сброс `alreadyJumped` при ещё действующем `goLast=1` / `?post=` (они остаются в
URL) снова делает `isJumping === true`
(`TopicPage.jsx:2675-2684`), CSS
`.topic-jump-loading .topic-content-wrapper { visibility: hidden !important }`
(`index.css:3032`) прячет весь контент, а поверх рисуется `TopicPageSkeleton`.
Это и есть видимая вспышка «контент → скелетон → контент».

## Цепочка событий (сверено с console-логами)

1. URL `?goLast=1`, `currentPage=1`. Эффект `TopicPage.jsx:592` →
   `setPosts([])` → `loadPosts()` → сервер резолвит страницу 4
   (`pageToFetch='last'`).
2. Ответ `loadPosts` содержит `resolvedPage=4` →
   `skipNextLoadForPageRef=4` + `setSearchParams({page: 4, ...}, {replace: true})`
   (`TopicPage.jsx:394-412`), затем `setPosts(data)`.
3. `BrowserRouter` оборачивает обновление навигации в `React.startTransition`,
   а `setPosts` — срочное обновление. Поэтому сначала рендерятся посты со
   **старым** URL — в логах `EFFECT 1049 (Jump) {postsLen: 5, currentPage: 1}`.
   Jump-эффект планирует `setTimeout(tryScroll, 100)` (`TopicPage.jsx:1266`).
4. Затем коммитится transition: URL `?page=4&goLast=1`, `currentPage=4`,
   **новый `location.key`** — в логах `EFFECT 592 {currentPage: 4, skipNext: 4}`
   (refetch пропущен — guard работает) и повторный `EFFECT 1049 {currentPage: 4}`.
5. Смена `location.key` запускает эффект `TopicPage.jsx:1033` →
   `setAlreadyJumped(false)`. Если первый `tryScroll` успел отработать раньше
   (~100 мс; transition может задержаться из-за загрузки постов/картинок — в
   логе видно `[Intervention] Images loaded lazily`), контент уже виден, и
   сброс **возвращает скелетон-оверлей**.
6. Jump-эффект (`TopicPage.jsx:1049`, deps включают `searchParams`,
   `currentPage`, `locationKey`, `readMap` — стр. 1277) пересчитывает цель.
   `fullTargetKey` (`TopicPage.jsx:1238`) теперь другой (другие `targetPage` и
   `locationKey`) → планируется **второй** `tryScroll` → повторный
   `scrollIntoView` (дёрганый скролл) и повторный `highlight-new-post`
   (2-секундная подсветка). Затем `setAlreadyJumped(true)` — контент возвращается.

Сценарий прямой ссылки на пост идентичен: ветка `targetPostId`
(`TopicPage.jsx:394-403`) делает тот же `setSearchParams(replace)` → новый key →
тот же сброс. В логах это ровно видно:
`EFFECT 1049 {currentPage: 1}` → `EFFECT 592 {currentPage: 4, skipNext: 4}` →
`EFFECT 1049 {currentPage: 4}`.
## Опровергнутая гипотеза

«Множественные вызовы `loadPosts` вызывают рефетч и из-за этого скелетон» —
**неверно**. После записи `page=4` в URL третьего `loadPosts called` в логах нет:
guard `skipNextLoadForPageRef` работает (видно `skipNext: 4` при
`currentPage: 4`). Двойные пары `EFFECT 592` / `loadPosts` в начале — это
**StrictMode в dev** (второй вызов с атрибуцией `installHook.js:1` — React
DevTools). Он удваивает сетевой запрос, гонку выигрывает второй fetch
(`activeFetchIdRef`), к продовой вспышке отношения не имеет.

## Рекомендации по фиксу

Суть: **не считать «информационную» запись `page=N` (резолв прыжка) новой
навигацией**.

1. **Основной вариант.** В эффекте `TopicPage.jsx:1033` сбрасывать
   `alreadyJumped` не по `location.key`, а по «прыжковому intent»: сбрасывать,
   только если сменились `id` или значения `post` / `goLast` / `hash`
   относительно последнего завершённого прыжка (хранить
   `{id, post, goLast}` в ref последнего jump-коммита). Тогда
   `?post=X → ?post=X&page=4` и `?goLast=1 → ?page=4&goLast=1` **не** сбросят
   флаг, а переход на другой топик / другую ссылку — сбросят.
2. Это же уберёт дублирующий `tryScroll` (второй таймер, второй
   `scrollIntoView` / `highlight`) — симптом той же причины.
3. **Контракт регрессионного теста** `scripts/check-golast-overlay.mjs`
   нужно сохранить:
   - `alreadyJumpedRef.current` писается **только** внутри `setAlreadyJumped`;
   - `isJumping` выводится как `needsJump && !alreadyJumpedRef.current`.
   Фикс это сохраняет — меняется только триггер сброса.
4. Отдельная мелочь: StrictMode-дубли запросов в dev (можно добавить cleanup,
   инкрементирующий `activeFetchIdRef`, чтобы отменять «переживший» mount-двойной
   вызов). К продовой вспышке отношения не имеет, опционально.

## Затронутые файлы

| Файл | Роль |
|---|---|
| `src/pages/TopicPage.jsx:394-412` | запись `page=N` в URL при резолве прыжка (`setSearchParams` replace) |
| `src/pages/TopicPage.jsx:1033-1035` | сброс `alreadyJumped` по `location.key` — источник сброса оверлея |
| `src/pages/TopicPage.jsx:1049-1277` | jump-эффект; `fullTargetKey` (1238) включает `locationKey` → дублирующий `tryScroll` |
| `src/pages/TopicPage.jsx:2675-2684` | `isJumping` → оверлей `TopicPageSkeleton` |
| `src/index.css:3032` | `.topic-jump-loading` скрывает контент |
| `scripts/check-golast-overlay.mjs` | регрессионный тест, контракт которого нужно придерживаться |

## Как проверить фикс

1. `npm run test:golast-overlay` — контракт оверлея не сломан.
2. Вручную (dev и prod-сборка):
   - открыть топик по ссылке `?goLast=1` — контент не должен исчезать после
     первого появления;
   - открыть прямую ссылку `?post=ID` — то же самое;
   - в console не должно быть повторного `EFFECT 1049` с уже завершённого
     прыжка и второго `tryScroll`-скролла;
   - переход по ссылке на другой топик и внутренние переходы `post=` между
     топиками по-прежнему должны перезапускать jump (сброс флага нужен именно
     для них).

## Что сделано (фикс применён в src/pages/TopicPage.jsx)

1. Эффект сброса `alreadyJumped` (были строки 1033-1035) больше не зависит от
   `location.key`. Теперь сброс происходит только при изменении «прыжкового
   intent»: `id` топика, `searchParams.get('post')`,
   `searchParams.get('goLast')` или `location.hash`. Текущий intent хранится в
   `lastJumpIntentRef`. Информационная запись `page=N` (резолв `?goLast=1` /
   `?post=ID` через `setSearchParams(..., { replace: true })`) не меняет
   intent, therefore не сбрасывает флаг и не возвращает скелетон-оверлей.
   Переход на другой топик / на другую ссылку `post=` по-прежнему сбрасывает
   флаг и перезапускает jump.
2. Убран `locationKey` из `fullTargetKey` (была строка 1238) и из зависимостей
   jump-эффекта — больше нет ложных дублей `tryScroll` из-за смены `location.key`
   при replace-навигации.
3. Удалён дублирующий вызов `useLocation()` (стр. 1016); `location`/`hash`
   берутся из уже существующего `useLocation()` на стр. 87-88.

Контракт регрессионного теста `scripts/check-golast-overlay.mjs` сохранён:
- `alreadyJumpedRef.current` пишется только внутри `setAlreadyJumped`;
- `isJumping = needsJump && !alreadyJumpedRef.current` без изменений.

Проверено:
- `npm run test:golast-overlay` — OK (оба утверждения проходят).
- `npx eslint src/pages/TopicPage.jsx` — без замечаний.
- `npm run build` — продакшен-сборка успешна.

