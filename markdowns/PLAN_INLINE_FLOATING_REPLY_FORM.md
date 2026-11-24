# План спринтов: Инлайн-форма ответа в теме (Inline Reply Composer)

> **Статус:** Рабочий пошаговый план внедрения для исполнителя  
> **Ветка:** `main`  
> **Стек:** React 19 + Vite 7 + Lucide-react + Vanilla CSS tokens + PocketBase / SQLite  
> **Целевые файлы:**  
> - `src/pages/TopicPage.jsx`  
> - `src/components/topic/TopicReplyComposer.jsx`  
> - `src/components/topic/TopicPostCard.jsx`  
> - `src/hooks/topic/useTopicPostAuth.jsx`  
> - `src/hooks/topic/useTopicJumpScroll.js`  
> - `src/components/topic/QuoteSelectionTooltip.jsx` *(новый)*  
> - `src/styles/topic-reply-composer.css` *(новый)*  
> - `src/styles/theme-variables.css`  
> - `src/index.css`  
> - `src/i18n/dictionary.js`  
> - `scripts/check-inline-reply-contracts.mjs` *(новый)*  
> **Основа:** `markdowns/CONCEPT_Inline_Floating_Reply_Form.md`  
> **Референс:** Discourse Docked Composer / Linear Inline Issue Reply / GitHub Discussions

---

## 0. Руководство для исполнителя (Прочти перед началом)

Этот документ представляет собой пошаговую инженерную инструкцию для реализации функционала инлайн-формы ответа в теме форума.

### Что уже сделано в проекте (Ground Truth из `main` @ `58ae2738`):
1. **Компонент формы уже декомпозирован:** Форма ответа выделена в `src/components/topic/TopicReplyComposer.jsx`.
2. **Очистка цитат и работа с выделением:** В `src/hooks/topic/useTopicPostAuth.jsx` уже есть функции `stripQuotes` и извлечение `window.getSelection()`.
3. **Модальные окна проекта:** Все модалки обязаны наследоваться от `src/components/common/ForumModal.jsx`. Использование сырого `react-bootstrap/Modal` категорически запрещено (контролируется `scripts/check-no-raw-modal.mjs`).
4. **Контракты навигации постов:** Скрипт `scripts/check-post-navigation.mjs` (подключён к `npm test` как `test:post-navigation`) принимает два состояния кода: legacy (текущий `main`) — 2 вызова `navigateToCreatedPost(..., newPostId)` и 2 литерала `state: { pendingPostId: tempId }`; и новый контракт после рефактора — хелпер `navigateToCreatedPost` не вызывается (тест его поведения в скрипте условный: пропускается, если хелпер удалён), jump взводится явно в `jumpToCreatedPost` и `handleNavigateToTargetPage` (запись `pendingCreatedPostIdRef.current` + `setAlreadyJumped(false)`), а литерал `state: { pendingPostId: tempId }` ровно один — в общем хелпере `handleNavigateToTargetPage`. Смешанное состояние (например, 1 вызов при новом взведении) скрипт отклоняет. Приоритет created-post в эффекте (приоритет 0) сохраняется в обоих контрактах.
5. **Тестирование:** Вся ветка `main` проходит строгий набор скриптов проверки (`npm test`). После каждого спринта `npm test` и `npm run build` обязаны быть зелёными.

### Ключевые архитектурные правила реализации:
1. **Синглтон формы через `ReactDOM.createPortal`:**  
   Форма ответа `<TopicReplyComposer>` создаётся в дереве React **ровно в одном экземпляре**. При перемещении под пост, на плавающую шторку или обратно в подвал компонент **никогда не размонтируется (`unmount`)**! Монтирование происходит через `ReactDOM.createPortal` в слот нужного поста.
2. **Абсолютный запрет на принудительный скролл (Zero Forced Scroll):**  
   Ни при нажатии кнопки «Цитировать», ни при отправке ответа экран **не должен самовольно срываться вниз**! Пользователь остаётся у того поста, который он читал. При отправке ответа всплывает интерактивный тоаст с возможностью перейти к созданному сообщению по желанию.
3. **Автоматический возврат формы в дефолтное положение (Auto-Reset on Submit):**  
   При успешной отправке сообщения (`onSuccess`) форма очищается, инлайн-слот под постом схлопывается (`height: 0`), а форма через портал возвращается на штатное место внизу страницы (подвал темы). При ошибке отправки форма остаётся на месте под постом.
4. **Межстраничная публикация — тостом, без модалки (Cross-Page Toast):**  
   Если опубликованный пост оказывается на другой странице темы (`targetPage !== currentPage`), система не делает резкий переход `setSearchParams({ page: targetPage })` и не показывает модалку. После подтверждения от сервера (`onSuccess`) пользователь остаётся на текущей странице, а тост «Опубликовано» со ссылкой «перейти к посту ↗». Подробно — Спринт 5 и бриф `BRIEF_Fix_Sprint4_Sprint5_Toasts.md`.
5. **Строгие правила вёрстки и темы форума:**
   - **Никаких инлайн-стилей** (`style={{ ... }}`) в новых и модифицируемых компонентах. **Единственное узкое исключение:** динамические координаты позиционирования (`top`/`left`) компонента `QuoteSelectionTooltip.jsx`, вычисляемые из `getBoundingClientRect()`; любые другие свойства (цвета, фоны, размеры) выносить в инлайн-стили категорически запрещено.
   - **Никаких Bootstrap-утилит** (`d-flex`, `mb-3`, `text-muted`, `border-0`, `p-2` и др.) в новой вёрстке — все стили определяются классами по BEM в `topic-reply-composer.css`.
   - **Никаких новых импортов из `react-bootstrap`**. Кнопки создаются через `<Button>` или семантические теги `<button type="button" className="...">`. Модальные окна — через `<ForumModal>`.
   - **Цвета — строго через токены** из `src/styles/theme-variables.css`. Прямой HEX/RGB в CSS компонентов запрещён. Стили должны гармонично работать во всех трёх темах: `light`, `dark`, `neutral`.

---

## Карта спринтов

```
┌────────────────────────────────────────────────────────────────────────┐
│ Спринт 1: Архитектура портала и инлайн-слоты (Portal Foundation)       │
│ (Монтирование TopicReplyComposer через ReactDOM.createPortal в слоты)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 2: Инлайн-перемещение и шапка формы (Inline Relocation & Header)│
│ (Клик «Цитировать» без скролла, шапка инлайна, возврат в подвал)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 3: ОТМЕНЁН (решение 2026-11-23 — пин и плавающий режим убраны)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 4: Отмена принудительного скролла и интерактивный тоаст         │
│ (Отмена jump в submitReply и handlePublishDraft, Action Toast, стили)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 5: Межстраничный тост публикации (Cross-Page Toast)             │
│ (Тост после подтверждения сервера, общий хелпер публикации)            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 6: Быстрое цитирование выделения, адаптивность и i18n           │
│ (Tooltip над выделением текста, Bottom Sheet мобилок, скрипт проверок) │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Спринт 1: Архитектура портала и инлайн-слоты (Portal Foundation)

### Цель спринта
Перевести рендеринг формы ответа `<TopicReplyComposer>` в `src/pages/TopicPage.jsx` на архитектуру `ReactDOM.createPortal`. Подготовить слоты монтирования в DOM (дефолтный подвал, инлайн-слоты под каждым постом, слот плавающей шторки), гарантируя, что компонент формы является синглтоном и не пересоздаётся при смене целевого контейнера.

### Файлы спринта
- **Создать:**
  - `src/styles/topic-reply-composer.css`
- **Изменить:**
  - `src/pages/TopicPage.jsx`
  - `src/components/topic/TopicPostCard.jsx`
  - `src/styles/topic-view.css`

---

### Пошаговые задачи исполнителя

#### Задача 1.1. Базовые CSS-классы слотов и контейнеров (`topic-reply-composer.css`)
1. Создать файл `src/styles/topic-reply-composer.css`.
2. Описать базовые классы контейнеров-слотов:
   ```css
   /* Слот под карточкой поста */
   .inline-reply-slot {
     width: 100%;
     transition: height 0.25s ease, opacity 0.2s ease;
   }

   .inline-reply-slot:empty {
     display: none;
   }

   /* Дефолтный слот в подвале темы */
   .bottom-reply-slot {
     width: 100%;
     margin-top: var(--topic-reply-margin-top, 3rem);
   }

   .bottom-reply-slot:empty {
     display: none;
   }

   /* Слот для плавающей шторки внизу экрана */
   .floating-reply-drawer-slot {
     position: fixed;
     bottom: 0;
     left: 0;
     right: 0;
     z-index: 1040;
     pointer-events: none;
   }

   .floating-reply-drawer-slot > * {
     pointer-events: auto;
   }
   ```
3. Подключить `topic-reply-composer.css` в `src/styles/topic-view.css` (`@import './topic-reply-composer.css';`).

#### Задача 1.2. Добавление слота в карточку поста (`TopicPostCard.jsx`)
1. В `src/components/topic/TopicPostCard.jsx` в конец разметки поста (сразу после закрывающего тега карточки `article`) добавить DOM-контейнер для портала:
   ```jsx
   <div 
     id={`inline-reply-slot-${post.id}`} 
     className="inline-reply-slot" 
     data-post-id={post.id} 
   />
   ```
   **Важно:** слот — соседний элемент к `<article>` внутри одного `return (...)`, поэтому `return` надо обернуть во фрагмент `<>...</>` (иначе «Adjacent JSX elements must be wrapped in an enclosing tag»). Скелетон-ветка слота НЕ получает (скелетон рендерится без пропа `post`, `post.id` там недоступен, и ответить на скелетон нельзя) — её не трогать.
2. Убедиться, что слот находится **снаружи** блока самой карточки поста, чтобы границы и паддинги поста не накладывались на форму ответа.

#### Задача 1.3. Состояние размещения формы и монтирование через Portal в `TopicPage.jsx`
1. В `src/pages/TopicPage.jsx` добавить состояние размещения формы:
   ```javascript
   const [replyPlacement, setReplyPlacement] = useState({
     mode: 'bottom', // 'bottom' | 'inline'
     targetPostId: null,
     isCollapsed: false,
   });
   ```
2. Создать мемоизированный селектор целевого DOM-узла портала:
   ```javascript
   const [portalTargetNode, setPortalTargetNode] = useState(null);

   useEffect(() => {
     let target = null;
     if (replyPlacement.mode === 'inline' && replyPlacement.targetPostId) {
       target = document.getElementById(`inline-reply-slot-${replyPlacement.targetPostId}`);
     } else if (replyPlacement.mode === 'floating') {
       target = document.getElementById('floating-reply-drawer-slot');
     }
     
     // Fallback: дефолтный слот внизу темы
     if (!target) {
       target = document.getElementById('bottom-reply-slot');
     }
     setPortalTargetNode(target);
   }, [replyPlacement, posts]);
   ```
3. В разметке `TopicPage.jsx`:
   - Добавить контейнер подвала:
     ```jsx
     <div id="bottom-reply-slot" className="bottom-reply-slot" />
     ```
   - Добавить фиксированный контейнер плавающей шторки:
     ```jsx
     <div id="floating-reply-drawer-slot" className="floating-reply-drawer-slot" />
     ```
   - Заменить прямое монтирование `<TopicReplyComposer>` на `ReactDOM.createPortal`. Список пропсов берется дословно из текущего `TopicPage.jsx:1905–1929` с добавлением новых обработчиков размещения:
     ```jsx
     {portalTargetNode && ReactDOM.createPortal(
       <TopicReplyComposer
         ref={replyRef}
         topic={topic}
         category={topic.category || categories.find((c) => c.id === topic.category_id)}
         user={user}
         profile={profile}
         settings={settings}
         characters={characters}
         selectedCharacterId={selectedCharacterId}
         setSelectedCharacterId={setSelectedCharacterId}
         setLastSelectedMask={handleSelectCharacter}
         replyContent={replyContent}
         setReplyContent={setReplyContent}
         guestNickname={guestNickname}
         setGuestNickname={setGuestNickname}
         submitting={submitting}
         draftSaving={draftSaving}
         hasDraft={!!myDraft}
         handleReply={handleReply}
         handleSaveDraft={handleSaveDraft}
         hasPermission={hasPermission}
         PERMISSIONS={PERMISSIONS}
         computedMaxChars={computedMaxChars}
         lang={lang}
         t={t}
         placement={replyPlacement}
         onResetToBottom={() => setReplyPlacement({ mode: 'bottom', targetPostId: null, isCollapsed: false })}
         onToggleCollapse={() => setReplyPlacement(prev => ({ ...prev, isCollapsed: !prev.isCollapsed }))}
       />,
       portalTargetNode
     )}
     ```
   *(Примечание: передача `setLastSelectedMask={handleSelectCharacter}` обязательна, так как `handleSelectCharacter` в `TopicPage.jsx:420–430` обновляет состояние маски и персонажа).*

---

### Критерии готовности Спринта 1 (Definition of Done)
1. Форма `<TopicReplyComposer>` монтируется в `#bottom-reply-slot` по умолчанию через `createPortal`.
2. Под каждым сообщением в DOM присутствует пустой узел `#inline-reply-slot-${post.id}`.
3. В DOM присутствует узел `#floating-reply-drawer-slot`.
4. Смена `setReplyPlacement({ mode: 'bottom' })` не вызывает ошибок рендеринга и повторного размонтирования формы.
5. Прогон `npm test` и `npm run build` проходит без ошибок.

### Чеклист проверки после Спринта 1
- [ ] `npm run build` — сборка проходит без предупреждений.
- [ ] `npm test` — все существующие тесты проекта зелёные.
- [ ] В браузере открыть тему: форма ответа отображается внизу страницы ровно так же, как и раньше, выбор маски через `handleSelectCharacter` и весь функционал отправки работают штатно.

---

## Спринт 2: Инлайн-перемещение по клику «Цитировать» и шапка формы (Inline Relocation & Header)

### Цель спринта
Исключить принудительный скролл вниз при нажатии кнопок «Цитировать» (`Quote`) и цитировании автора. Перемещать форму ответа непосредственно под целевой пост в режиме `inline`. Оснастить форму компактной информативной шапкой с кнопками возврата в подвал («⬇ В конец темы»), сворачивания («✕ Свернуть») и перевода в плавающее состояние. Оформить стили через токены темы без хардкода цветов.

### Файлы спринта
- **Изменить:**
  - `src/styles/theme-variables.css`
  - `src/hooks/topic/useTopicPostAuth.jsx`
  - `src/pages/TopicPage.jsx`
  - `src/components/topic/TopicReplyComposer.jsx`
  - `src/styles/topic-reply-composer.css`
  - `src/i18n/dictionary.js`

---

### Пошаговые задачи исполнителя

#### Задача 2.1. Добавление токенов темы композера (`theme-variables.css`)
1. В `src/styles/theme-variables.css` добавить переменные композера для всех трёх тем (`:root`, `[data-theme='dark']`, `[data-theme='neutral']`):
   ```css
   /* В блоке :root (светлая тема) */
   --topic-reply-header-text: #ffffff;
   --topic-reply-inline-bar-bg: var(--nav-bg);
   --topic-reply-inline-bar-text: var(--topic-reply-header-text);
   --topic-reply-inline-btn-border: rgba(255, 255, 255, 0.2);
   --topic-reply-inline-btn-hover-bg: rgba(255, 255, 255, 0.15);
   --topic-reply-shadow-inline: 0 4px 16px rgba(0, 0, 0, 0.12);
   --topic-reply-shadow-floating: 0 -4px 24px rgba(0, 0, 0, 0.25);
   --topic-reply-shadow-pill: 0 4px 18px rgba(0, 0, 0, 0.2);
   --topic-reply-toast-btn-bg: rgba(255, 255, 255, 0.2);
   --topic-reply-toast-btn-border: rgba(255, 255, 255, 0.4);

    /* В блоке [data-theme='dark'] */
   --topic-reply-header-text: #ffffff;
   --topic-reply-inline-bar-bg: var(--nav-bg);
   --topic-reply-inline-bar-text: var(--topic-reply-header-text);
   --topic-reply-inline-btn-border: rgba(255, 255, 255, 0.2);
   --topic-reply-inline-btn-hover-bg: rgba(255, 255, 255, 0.15);
   --topic-reply-shadow-inline: 0 4px 16px rgba(0, 0, 0, 0.4);
   --topic-reply-shadow-floating: 0 -4px 24px rgba(0, 0, 0, 0.5);
   --topic-reply-shadow-pill: 0 4px 18px rgba(0, 0, 0, 0.4);
   --topic-reply-toast-btn-bg: rgba(255, 255, 255, 0.2);
   --topic-reply-toast-btn-border: rgba(255, 255, 255, 0.4);

   /* В блоке [data-theme='neutral'] */
   --topic-reply-header-text: #ffffff;
   --topic-reply-inline-bar-bg: var(--nav-bg);
   --topic-reply-inline-bar-text: var(--topic-reply-header-text);
   --topic-reply-inline-btn-border: rgba(255, 255, 255, 0.2);
   --topic-reply-inline-btn-hover-bg: rgba(255, 255, 255, 0.15);
   --topic-reply-shadow-inline: 0 4px 16px rgba(0, 0, 0, 0.2);
   --topic-reply-shadow-floating: 0 -4px 24px rgba(0, 0, 0, 0.35);
   --topic-reply-shadow-pill: 0 4px 18px rgba(0, 0, 0, 0.25);
   --topic-reply-toast-btn-bg: rgba(255, 255, 255, 0.2);
   --topic-reply-toast-btn-border: rgba(255, 255, 255, 0.4);
   ```

#### Задача 2.2. Модификация хука `useTopicPostAuth.jsx`
1. В аргументы хука `useTopicPostAuth` добавить параметр `setReplyPlacement`:
   ```javascript
   export const useTopicPostAuth = ({
     // ... существующие параметры ...
     setReplyPlacement,
   }) => {
   ```
2. В `handleQuote`:
   - **УДАЛИТЬ** вызов `scrollToReply(replyRef);`!
   - Вместо скролла активировать инлайн-режим формы под целевым постом:
     ```javascript
     setReplyPlacement({
       mode: 'inline',
       targetPostId: post.id,
       isCollapsed: false,
     });
     ```
> **Исправлено 2026-11-23:** номера поста на объекте поста нет — `post.post_number` не существует, номер считается позиционно в `TopicPage` и в размещение не входит. Атрибуции «ответ на сообщение» нет: ответ не привязан к посту, форма просто переезжает ближе к месту цитаты (решение 2026-11-23).
3. В `handleQuoteAuthor`:
   - Переводить форму в инлайн под пост автора без принудительного скролла страницы вниз.
4. В `TopicPage.jsx` передать `setReplyPlacement` в вызов `useTopicPostAuth(...)`.

#### Задача 2.3. Шапка инлайн-режима в `TopicReplyComposer.jsx`
1. Принять пропсы `placement`, `onResetToBottom`, `onToggleCollapse` в `TopicReplyComposer.jsx` (`onSwitchToFloating` мёртв — плавающего режима нет).
2. Если `placement.mode === 'inline'`, над формой рендерится специальная навигационная шапка:
   ```jsx
   {placement.mode === 'inline' && !placement.isCollapsed && (
     <div className="topic-reply__header-controls">
       <Button
         type="button"
         variant="ghost"
         size="sm"
         onClick={onToggleCollapse}
         leftIcon={<Minimize2 size={16} />}
       >
         {t('forum.collapse', 'Свернуть')}
       </Button>
       <Button
         type="button"
         variant="ghost"
         size="sm"
         onClick={onResetToBottom}
         leftIcon={<ArrowDownToLine size={16} />}
       >
         {t('forum.to_bottom', 'В конец')}
       </Button>
     </div>
   )}
   ```
> Контролы лежат внутри `.topic-reply__header`, а не отдельной полосой над ним. Ghost-кнопки на тёмном хедере — через scoped-override в `topic-reply-composer.css` на inline-токенах (белый текст, см. Спринт 2 v4). Бейджа «Ответ на сообщение #N» и автора нет — атрибуция удалена решением 2026-11-23.
3. **Режим свернутого состояния (`placement.isCollapsed === true`):**
   ```jsx
   {placement.isCollapsed ? (
     <div className="topic-reply__collapsed-pill">
       <FilePen size={16} className="topic-reply__collapsed-pill-icon" />
       <span className="topic-reply__collapsed-pill-text">
         {t('forum.reply_collapsed_draft', 'Ответ сохранен в черновик')}
         {replyContent.trim() && ` (${replyContent.trim().length} ${t('forum.chars_short', 'знаков')})`}
       </span>
       <Button type="button" variant="ghost" size="sm" onClick={onToggleCollapse}>
         {t('forum.expand', 'Развернуть')}
       </Button>
       <Button type="button" variant="secondary" size="sm" onClick={onResetToBottom}>
         {t('forum.to_bottom', 'В конец')}
       </Button>
     </div>
   ) : (
     /* Стандартный рендер карточки редактора */
   )}
   ```

#### Задача 2.4. Стили инлайн-формы без хардкода цветов (`topic-reply-composer.css`)
1. Оформить инлайн-шапку строго через CSS-токены (без `#ffffff` и `rgba`):
   ```css
   .topic-reply--inline {
     margin-top: 1rem;
     margin-bottom: 1.5rem;
     border-left: 3px solid var(--primary-color);
     border-radius: var(--topic-reply-card-radius);
     box-shadow: var(--topic-reply-shadow-inline);
     animation: inlineReplySlideDown 0.25s ease-out;
   }

   @keyframes inlineReplySlideDown {
     from {
       opacity: 0;
       transform: translateY(-8px);
     }
     to {
       opacity: 1;
       transform: translateY(0);
     }
   }

   .topic-reply__inline-bar {
     display: flex;
     align-items: center;
     justify-content: space-between;
     padding: 0.5rem 1rem;
     background-color: var(--topic-reply-inline-bar-bg);
     color: var(--topic-reply-inline-bar-text);
     border-top-left-radius: var(--topic-reply-card-radius);
     border-top-right-radius: var(--topic-reply-card-radius);
     font-size: 0.875rem;
   }

   .topic-reply__inline-actions {
     display: flex;
     align-items: center;
     gap: 0.5rem;
   }

   .topic-reply__inline-btn {
     display: inline-flex;
     align-items: center;
     gap: 0.35rem;
     background: transparent;
     border: 1px solid var(--topic-reply-inline-btn-border);
     color: var(--topic-reply-inline-bar-text);
     border-radius: 4px;
     padding: 0.25rem 0.5rem;
     font-size: 0.75rem;
     cursor: pointer;
     transition: background-color 0.15s ease, border-color 0.15s ease;
   }

   .topic-reply__inline-btn:hover {
     background-color: var(--topic-reply-inline-btn-hover-bg);
     border-color: var(--topic-reply-inline-btn-border);
   }

   .topic-reply__collapsed-pill {
     display: flex;
     align-items: center;
     justify-content: space-between;
     padding: 0.6rem 1rem;
     background-color: var(--card-bg);
     border: 1px solid var(--border-color);
     border-radius: 20px;
     margin-top: 0.75rem;
     margin-bottom: 0.75rem;
     font-size: 0.85rem;
     color: var(--text-color);
   }
   ```

#### Задача 2.5. Локализация (`dictionary.js`)
1. Добавить фразы в `src/i18n/dictionary.js`:
   - `forum.move_to_bottom`: "В конец темы" / "To bottom"
   - `forum.to_bottom`: "В конец" / "Bottom"
   - `forum.collapse`: "Свернуть" / "Collapse"
   - `forum.expand`: "Развернуть" / "Expand"
   - `forum.reply_collapsed_draft`: "Ответ свернут" / "Reply minimized"
   - `forum.chars`: "знаков" / "chars"

---

### Критерии готовности Спринта 2 (Definition of Done)
1. Клик на кнопку «Цитировать» под любым постом разворачивает форму ответа прямо под данным постом.
2. Экран пользователя **не скроллится принудительно вниз**.
3. В шапке формы отображается `Ответ на сообщение #N (@Автор)`.
4. Кнопка «В конец темы» мгновенно возвращает форму в штатный подвал страницы с сохранением введённого текста.
5. Кнопка «Свернуть» сворачивает форму в аккуратный чип под постом.
6. При повторном клике «Цитировать» на другом посте текст цитаты дописывается в существующий драфт, а форма перемещается под новый пост.
7. Все цвета шапки и кнопок инлайна читаются во всех трёх темах (`light`, `dark`, `neutral`), прямой HEX/RGB в `topic-reply-composer.css` отсутствует.

### Чеклист проверки после Спринта 2
- [ ] Кликнуть «Цитировать» на посте #2: форма открылась под постом #2, страница не улетела вниз.
- [ ] Ввести несколько предложений в текст.
- [ ] Кликнуть «Цитировать» на посте #5: форма переехала под пост #5, введённый ранее текст сохранился, добавилась цитата поста #5.
- [ ] Нажать кнопку «В конец»: форма вернулась в футер темы, текст на месте.
- [ ] `npm test` — все тесты проходят.
- [ ] `npm run lint:js` — 0 ошибок линтера.

---

## Спринт 3: Плавающий режим — ОТМЕНЁН

> **Решение 2026-11-23:** пин и плавающий режим убраны полностью и не реализуются. Закреплённый композер занимал около 90% высоты экрана, а в плавающем режиме шапка с кнопками вообще не рендерилась (контролы были привязаны к `mode === 'inline'`), так что открепиться было невозможно — ловушка без выхода. Спринт 3 не выполняется; файлы `src/components/topic/FloatingReplyDrawer.jsx` и `src/components/topic/ReplyScrollStatusPill.jsx` не создаются, режим `placement.mode === 'floating'` не вводится. Размещение формы — только `{mode: 'bottom' | 'inline', targetPostId, isCollapsed}`.

---

## Спринт 4: Отмена принудительного скролла и интерактивный тоаст публикации (Zero Forced Scroll & Action Toast)

### Цель спринта
Исключить принудительный скролл вниз экрана при отправке ответа на текущей странице (`submitReply`) и при публикации черновика (`handlePublishDraft`). Заменить безусловное взведение jump-контроллера на интерактивный тоаст с кликабельным переходом `[↗ Перейти к сообщению]`. Подсветка — существующим классом `.highlight-new-post` (`src/index.css`); класс `.highlight-target-post` в CSS не определён и не используется

### Файлы спринта
- **Изменить:**
  - `src/pages/TopicPage.jsx`
  - `src/hooks/topic/useTopicJumpScroll.js`
  - `src/index.css`
  - `src/styles/topic-reply-composer.css`
  - `src/i18n/dictionary.js`

---

### Пошаговые задачи исполнителя

#### Задача 4.1. Автоматический возврат формы в дефолтное положение при успехе отправки
1. В `src/pages/TopicPage.jsx` в `submitReply()` перенос формы в подвал темы производить **в блоке `onSuccess`** (после подтверждения от сервера):
   ```javascript
   // Внутри onSuccess:
   setReplyPlacement({
     mode: 'bottom',
     targetPostId: null,
     isCollapsed: false,
   });
   ```
   *(При ошибке `onError` форма остаётся под постом, а введённый текст восстанавливается — пользователь может исправить ошибку и повторить отправку).*
2. Очистить локальный черновик темы: `localStorage.removeItem(DRAFT_KEY)` в `onSuccess`.
3. Убедиться, что инлайн-слот под постом `#inline-reply-slot-${postId}` плавно схлопывается и не оставляет пустого места между постами.

#### Задача 4.2. Отмена принудительного скролла на текущей странице в `submitReply` и `handlePublishDraft`
Конкретные места в кодовой базе `main` @ `58ae2738`, которые ранее взводили принудительный скролл:
1. `src/pages/TopicPage.jsx:1085`: `pendingCreatedPostIdRef.current = newPostId` в `onSuccess` у `submitReply`.
2. `src/pages/TopicPage.jsx:1079`: безусловный вызов `navigateToCreatedPost(tempIdRef, newPostId)` в `onSuccess` у `submitReply`.
3. `src/pages/TopicPage.jsx:1042, 1089`: `setAlreadyJumped(false)` снимает защёлку, после чего эффект в `useTopicJumpScroll.js` (~строки 58–110) выполняет `scrollIntoView` к `post-${newPostId}` с приоритетом 0.
4. В публикации черновика `handlePublishDraft`:
   - `src/pages/TopicPage.jsx:731`: `pendingCreatedPostIdRef.current = tempId` до аппенда;
   - `src/pages/TopicPage.jsx:838`: безусловный `navigateToCreatedPost(tempId, newPostId)`;
   - `src/pages/TopicPage.jsx:898`: прямая запись `pendingCreatedPostIdRef.current = newPostId` после успеха.

**Новая логика для той же страницы (`targetPage === currentPage`):**
1. В `onSuccess` у `submitReply` и в `handlePublishDraft` при публикации на той же странице:
   - **НЕ записывать** `pendingCreatedPostIdRef.current = newPostId`;
   - **НЕ вызывать** `setAlreadyJumped(false)`;
   - **НЕ вызывать** `navigateToCreatedPost(...)` безусловно в основном потоке успеха.
2. Экран читателя остаётся ровно на том месте, где он читал/отвечал.
3. Jump-контроллер взводится **только по явному действию пользователя**: клик по кнопке `[↗ Перейти к сообщению]` в Action Toast.

#### Задача 4.3. Интерактивный тоаст перехода к посту (`Action Toast`)
1. Реализовать хелпер мягкого перехода к созданному сообщению:
   ```javascript
   const jumpToCreatedPost = useCallback((postId) => {
     pendingCreatedPostIdRef.current = postId;
     setAlreadyJumped(false);
     const el = document.getElementById(`post-${postId}`);
     if (el) {
       el.scrollIntoView({ behavior: 'smooth', block: 'center' });
       el.classList.add('highlight-new-post');
       setTimeout(() => el.classList.remove('highlight-new-post'), 2500);
     }
   }, []);
   ```
2. Показывать тоаст при успешной публикации на текущей странице (в `submitReply` и `handlePublishDraft`):
   ```javascript
   showToast(
     <div className="action-toast-content">
       <span>{t('forum.post_published', 'Сообщение опубликовано')}</span>
       <button
         type="button"
         className="action-toast-btn"
         onClick={() => jumpToCreatedPost(newPostId || tempId)}
       >
         {t('forum.go_to_post', 'Перейти к сообщению ↗')}
       </button>
     </div>,
     'success',
     6000
   );
   ```
3. Стилизовать `action-toast-btn` в `topic-reply-composer.css` через токены (без прямого `rgba`):
   ```css
   .action-toast-content {
     display: flex;
     align-items: center;
     justify-content: space-between;
     gap: 1rem;
     width: 100%;
   }

   .action-toast-btn {
     background-color: var(--topic-reply-toast-btn-bg);
     border: 1px solid var(--topic-reply-toast-btn-border);
     color: inherit;
     border-radius: 4px;
     padding: 0.25rem 0.6rem;
     font-size: 0.8rem;
     font-weight: 600;
     cursor: pointer;
     white-space: nowrap;
     transition: background-color 0.15s ease;
   }

   .action-toast-btn:hover {
     background-color: var(--topic-reply-toast-btn-border);
   }
   ```

#### Задача 4.4. Сохранение контрактов тестов `scripts/check-post-navigation.mjs` и стили подсветки
1. **Новый контракт `scripts/check-post-navigation.mjs`:**  
   После рефактора `navigateToCreatedPost` нигде не вызывается: его guard требует `location.state.pendingPostId === tempId`, а это состояние после отказа от предмутационного `setSearchParams` не выставляется — вызывать хелпер из обработчиков тоста/модалки нельзя. Вместо этого скрипт проверяет: `jumpToCreatedPost` и `handleNavigateToTargetPage` ставят `pendingCreatedPostIdRef.current` и вызывают `setAlreadyJumped(false)`, а литерал `state: { pendingPostId: tempId }` ровно один — в общем хелпере `handleNavigateToTargetPage`. Если хелпер `navigateToCreatedPost` удалён из `useTopicJumpScroll.js`, тест его поведения в скрипте пропускается (условная проверка). Смешанное состояние (например, один вызов `navigateToCreatedPost` при новом взведении) скрипт отклоняет: либо legacy 2 вызова + 2 литерала, либо новый контракт целиком.
2. **Файл `useTopicJumpScroll.js`:**  
   Остаётся в списке файлов спринта. Сам внутренний алгоритм эффекта и приоритет созданного поста не меняются — меняется только то, кто инициирует взведение `pendingCreatedPostIdRef.current`.
3. **Поддержка класса `.highlight-target-post` в `src/index.css`:**  
   Класс `.highlight-target-post` выставляется jump-контроллером (`useTopicJumpScroll.js:104`), `useTopicNavigation.js:14` и `useTopicModalState.js:193`, но ранее отсутствовал в CSS. В `src/index.css` добавить правило рядом с `.highlight-new-post`:
   ```css
   .highlight-new-post,
   .highlight-target-post {
     animation: highlight-fade 1s cubic-bezier(0.4, 0, 0.2, 1);
   }
   ```

---

### Критерии готовности Спринта 4 (Definition of Done)
1. При отправке ответа и публикации черновика на текущей странице экран пользователя **не срывается вниз**.
2. Инлайн-форма схлопывается и возвращается в подвал темы только при успешном ответе от сервера (`onSuccess`). При ошибке форма остаётся под постом с набранным текстом.
3. Всплывает тоаст успеха с кнопкой `[Перейти к сообщению ↗]`.
4. Клик по кнопке тоаста плавно центрирует созданный пост с анимацией подсветки.
5. Правила `.highlight-new-post` и `.highlight-target-post` зарегистрированы в `src/index.css`.
6. Скрипт `node scripts/check-post-navigation.mjs` и полный `npm test` зелёные.

### Чеклист проверки после Спринта 4
- [ ] Написать ответ на пост #3 в середине страницы и отправить: экран остался на посте #3.
- [ ] Опубликовать черновик на текущей странице: экран не срывается вниз, всплывает Action Toast.
- [ ] Проверить ошибку отправки (например, отключив сеть): форма осталась под постом, текст не сбросился.
- [ ] Кликнуть в тоасте кнопку «Перейти к сообщению ↗»: экран плавно скроллится к сообщению, работает подсветка.
- [ ] `node scripts/check-post-navigation.mjs` — PASS.
- [ ] `npm test` — PASS.

---

## Спринт 5: Межстраничный тост публикации (Cross-Page Toast)

> **Решение 2026-11-23 (изменение плана):** модалка `CrossPagePostModal` отменена — межстраничная публикация делается тостом, а не диалогом. Файл `src/components/modals/CrossPagePostModal.jsx` не создаётся. Точный спек — бриф `BRIEF_Fix_Sprint4_Sprint5_Toasts.md`; этот раздел — его краткое изложение, при расхождении побеждает бриф.

### Цель спринта
Исключить автоматический переход на другую страницу пагинации при публикации ответа (`submitReply`) или публикации черновика (`handlePublishDraft`), когда `targetPage !== currentPage`. Пользователь остаётся на текущей странице; после подтверждения сервера (`onSuccess`) показывается короткий тост «Опубликовано» со ссылкой «перейти к посту ↗». Переход — только по явному клику в тосте.

### Файлы спринта
- **Изменить:**
  - `src/pages/TopicPage.jsx`
  - `src/i18n/dictionary.js`
  - `src/styles/topic-reply-composer.css`

---

### Пошаговые задачи исполнителя

#### Задача 5.1. Общий хелпер межстраничной публикации
1. Вынести общий хелпер (один на `submitReply` и `handlePublishDraft`; в брифе назван `goToCreatedPostOnPage`): взводит jump на реальный серверный `postId`, снимает защёлку `setAlreadyJumped(false)` и делает `setSearchParams` на целевую страницу с литералом `state: { pendingPostId: tempId }`.
2. Литерал `state: { pendingPostId: tempId }` — **ровно один во всей кодовой базе**, в общем хелпере (требование `scripts/check-post-navigation.mjs`; оба старых литерала в `submitReply` и `handlePublishDraft` удаляются).
3. До ответа сервера: оптимистичный пост ставится в очередь (`queueOptimisticPost`), но `setSearchParams` НЕ вызывается и тост НЕ показывается. При ошибке — никакого тоста и никакой навигации.

#### Задача 5.2. Тост межстраничной публикации
1. В `onSuccess` (ответ и черновик), когда `targetPage !== currentPage`: тост `info`, 7000 мс — текст `forum.post_published` («Опубликовано») и ссылка `forum.go_to_post` («перейти к посту ↗»), вызывающая общий хелпер с `{tempId, postId: newPostId, targetPage}`.
2. Ссылка тоста — единственный путь на целевую страницу. Без клика пользователь остаётся там, где был.
3. Публикация черновика на стыке страниц (переполнение последней страницы) и случай «пока писался черновик, другие добавили сообщения» покрываются тем же общим хелпером, отдельных веток не делать.

#### Задача 5.3. Словарь и стили
1. Ключи `forum.post_published` («Опубликовано» / «Published», с точкой в значении) и `forum.go_to_post` («перейти к посту ↗» / «Go to post ↗») — в `src/i18n/dictionary.js`, ru + en. Номер страницы в тосте не показывается нигде; ключи `forum.published_on_target_page` и `forum.go_to_page_short` удалены (коммит `f4e57dd`).
2. Стили `.action-toast-content` / `.action-toast-link` — в `topic-reply-composer.css` через токены (ссылка — `var(--link-color)`, подчёркнутая, текст тоста — `font-weight: 400`).

---

### Критерии готовности Спринта 5 (Definition of Done)
1. При ответе с не-последней страницы пользователь остаётся на текущей странице, скролл не срывается.
2. Тост появляется **только после успешного подтверждения сервером** (`onSuccess`). При ошибке отправки тоста нет.
3. Клик «перейти к посту ↗» переключает страницу, взводит `pendingCreatedPostIdRef.current = realPostId` и плавно центрирует созданный пост.
4. Публикация черновика на стыке страниц обрабатывается тем же общим хелпером.
5. `scripts/check-post-navigation.mjs` зелёный по новому контракту: ровно один литерал `state: { pendingPostId: tempId }` — в общем хелпере.

### Чеклист проверки после Спринта 5
- [ ] Открыть страницу 1 многостраничной темы, отправить ответ: автоматического перехода на страницу 2/3 нет, появился тост «Опубликовано» со ссылкой.
- [ ] В тосте нажать «перейти к посту ↗»: открылась последняя страница, целевой пост плавно отцентрирован.
- [ ] Проверить падение запроса (симуляция ошибки): тост не появляется, сообщение об ошибке в тоасте.
- [ ] `node scripts/check-post-navigation.mjs` — PASS.
- [ ] `npm test` — все тесты зелёные.


## Спринт 6: Быстрое цитирование выделения, адаптивность и i18n (Quote Tooltip & Hardening)

### Цель спринта
Реализовать всплывающий тултип цитирования при выделении мышкой фрагмента сообщения (`QuoteSelectionTooltip`), оптимизировать форму под мобильные экраны (< 768px), завершить локализацию и создать скрипт проверки контрактов `scripts/check-inline-reply-contracts.mjs`.

### Файлы спринта
- **Создать:**
  - `src/components/topic/QuoteSelectionTooltip.jsx`
  - `scripts/check-inline-reply-contracts.mjs`
- **Изменить:**
  - `src/components/topic/TopicPostCard.jsx`
  - `src/styles/topic-reply-composer.css`
  - `src/i18n/dictionary.js`
  - `package.json`

---

### Пошаговые задачи исполнителя

#### Задача 6.1. Всплывающий тултип быстрого цитирования (`QuoteSelectionTooltip.jsx`)
1. Создать компонент `src/components/topic/QuoteSelectionTooltip.jsx`.
2. Компонент отслеживает выделение текста внутри `.post-content`:
   - Если выделено от 3 до 2000 символов, вычисляются координаты `range.getBoundingClientRect()`.
   - Над выделенной фразой всплывает компактная кнопка с иконкой цитаты:
     ```jsx
     <button
       type="button"
       className="quote-selection-tooltip"
       style={{ top: tooltipCoords.top, left: tooltipCoords.left }}
       onMouseDown={(e) => {
         e.preventDefault();
         handleQuoteSelection(post, selectedText);
       }}
     >
       <Quote size={14} />
       <span>{t('forum.quote_selection', 'Цитата')}</span>
     </button>
     ```
   *(Динамические координаты `top`/`left` — единственное разрешённое исключение из запрета инлайн-стилей; оформление внешнего вида кнопки выполнено строго в CSS).*
3. При клике в форму ответа конкатенируется выделенный текст, очищенный от цитатных пирамид (`stripQuotes`), обёрнутый в BB-код `[quote]`, и форма активируется инлайн под этим постом.

#### Задача 6.2. Мобильная адаптивность (< 768px)
1. В `topic-reply-composer.css` для экранов мобильных устройств:
   ```css
   @media (max-width: 768px) {
     .topic-reply--floating {
       max-width: 100%;
       border-radius: 12px 12px 0 0;
       max-height: 75vh;
       overflow-y: auto;
     }

     .topic-reply__inline-bar {
       flex-wrap: wrap;
       gap: 0.5rem;
     }

     .topic-reply__btn-label {
       display: none;
     }

     .reply-scroll-pill {
       bottom: 1rem;
       right: 1rem;
       left: 1rem;
       justify-content: space-between;
     }
   }
   ```

#### Задача 6.3. Скрипт проверки контрактов `scripts/check-inline-reply-contracts.mjs`
1. Создать скрипт проверки:
   - Проверяет наличие контейнеров слотов `#inline-reply-slot-`, `#bottom-reply-slot`, `#floating-reply-drawer-slot`.
   - Проверяет монтирование `<TopicReplyComposer>` через `createPortal` в `TopicPage.jsx`.
   - Проверяет отсутствие сырого `react-bootstrap/Modal` в `CrossPagePostModal.jsx`.
   - Проверяет отсутствие инлайн-стилей `style={{` во всех новых компонентах, **за исключением** динамических координат `top`/`left` в `QuoteSelectionTooltip.jsx`.
   - Проверяет наличие всех добавленных языковых ключей в `dictionary.js`.
2. Подключить запуск скрипта в `package.json` в цепочку `npm test`.

---

### Критерии готовности Спринта 6 (Definition of Done)
1. Выделение текста в любом сообщении вызывает тултип «💬 Цитата».
2. Клик по тултипу отправляет в форму только выделенный фрагмент и разворачивает инлайн-форму под постом.
3. На мобильных устройствах композер гармонично адаптируется в Bottom Sheet.
4. Скрипт `check-inline-reply-contracts.mjs` внедрен и отдаёт PASS.
5. Полный цикл проверок `npm test` и `npm run build` зелёный.

### Чеклист проверки после Спринта 6
- [ ] Выделить фрагмент текста внутри поста мышкой → появился тултип «Цитата».
- [ ] Нажать на тултип → в форме появилась цитата только выделенного фрагмента.
- [ ] Проверить отображение во всех 3 темах: `light`, `dark`, `neutral`.
- [ ] Проверить на мобильной ширине 375px в инструментах разработчика.
- [ ] `node scripts/check-inline-reply-contracts.mjs` — PASS.
- [ ] `npm test` — все тесты зелёные.

---

## 7. Сводная таблица правил и проверок

| Правило | Где проверять | Команда / Скрипт |
|---|---|---|
| **Синглтон формы (React Portal)** | `TopicPage.jsx` | `node scripts/check-inline-reply-contracts.mjs` |
| **Слоты инлайн-ответа** | `TopicPostCard.jsx` | `node scripts/check-inline-reply-contracts.mjs` |
| **Zero Forced Scroll (ответ)** | `TopicPage.jsx:submitReply` | Ручной E2E-сценарий + `check-post-navigation.mjs` |
| **Zero Forced Scroll (черновик)** | `TopicPage.jsx:handlePublishDraft` | Ручной E2E-сценарий + `check-post-navigation.mjs` |
| **Межстраничная публикация (тост)** | `TopicPage.jsx` (общий хелпер) | Ручной E2E-сценарий + `check-post-navigation.mjs` |
| **Контракт навигации постов** | `TopicPage.jsx`, `useTopicJumpScroll.js` | `node scripts/check-post-navigation.mjs` |
| **Без инлайн-стилей** (кроме координат тултипа) | Новые JSX-файлы | `node scripts/check-inline-reply-contracts.mjs` |
| **Без Bootstrap-утилит** | Новые JSX-файлы | `node scripts/check-inline-reply-contracts.mjs` |
| **Цвета из theme-variables** | `topic-reply-composer.css` | Ручной визуальный аудит (Light/Dark/Neutral) |
| **Общая сборка фронтенда** | Vite build | `npm run build` |
| **Линтер фронтенда** | ESLint | `npm run lint:js` |
| **Регрессия всех тестов** | Весь проект | `npm test` |

---

## 12. Журнал выполнения и решений

### 12.1. Решения (зафиксировано до и по ходу работы)

| Дата | Решение | Источник |
|---|---|---|
| 2026-11-23 | Форма ответа реализуется как **синглтон через `ReactDOM.createPortal`**, исключая unmount/remount и сброс состояния редактора | Архитектурный выбор |
| 2026-11-23 | При нажатии «Цитировать» принудительный скролл вниз **отменяется**, форма монтируется инлайн под целевым постом | Концепт |
| 2026-11-23 | При отправке ответа форма **автоматически возвращается в подвал темы** в `onSuccess`, инлайн-слот схлопывается | Концепт |
| 2026-11-23 | На текущей странице при отправке экран **не срывается вниз**; безусловное взведение jump-контроллера отменено в `submitReply` и `handlePublishDraft`, показывается Action Toast со ссылкой `[↗ Перейти к сообщению]` | Бриф / Сверка |
| 2026-11-23 | При отправке на другой странице (`targetPage !== currentPage`) резкий переход отменяется; модалка `CrossPagePostModal` открывается только после подтверждения сервера (`onSuccess`), клик «Перейти» взводит jump на реальный `postId` | Бриф / Сверка |
| 2026-11-23 | Все модалки строятся строго на базе `ForumModal` (прямой `react-bootstrap/Modal` запрещён правилом `check-no-raw-modal.mjs`) | Правило репозитория |
| 2026-11-23 | Стили оформляются в `topic-reply-composer.css` на базе токенов из `theme-variables.css`, без прямого HEX/RGB и классов Bootstrap | Правило репозитория |
| 2026-11-23 | Инлайн-стили запрещены везде, кроме динамических экранных координат (`top`/`left`) в `QuoteSelectionTooltip.jsx` | Бриф / Сверка |
| 2026-11-23 | Скролл при явном нажатии «Сохранить черновик» (`TopicPage.jsx:698`, `scrollIntoView` к сохранённому черновику с `.highlight-new-post`) — отдельное действие по запросу пользователя, план его не затрагивает | Архитектурный выбор |
| 2026-11-23 | Пин и плавающий режим убраны полностью (Спринт 3 отменён); ответ не привязан к посту, атрибуция «ответ на сообщение» удалена, размещение — `{mode, targetPostId, isCollapsed}` | Решение пользователя |
| 2026-11-23 | Межстраничная публикация — тостом, не модалкой: `CrossPagePostModal` отменён, см. бриф `BRIEF_Fix_Sprint4_Sprint5_Toasts.md` | Решение пользователя |
| 2026-11-23 | Образец `post.post_number` в задаче 2.2 неверен: номера на объекте поста нет, номер считается позиционно в `TopicPage` | Сверка с кодом |

### 12.2. Проверка плана (2026-11-23 — сверка с `main` @ `58ae2738`)

В план внесены следующие исправления по результатам сверки с кодовой базой:
1. **Назван реальный механизм принудительного скролла (Спринт 4):** зафиксированы конкретные строки `TopicPage.jsx:1042, 1079, 1085, 1089` и `useTopicJumpScroll.js:58–110`, безусловный скролл отменён в `onSuccess` и перенесён на клик в тоасте.
2. **Модалка межстраничной публикации перенесена в `onSuccess` (Спринт 5):** исключено открытие модалки до подтверждения сервером; обработчик перехода взводит `pendingCreatedPostIdRef.current` с реальным ID поста и сохраняет обязательный литерал `state: { pendingPostId: tempId }`.
3. **Разрешено узкое исключение для инлайн-стилей (Спринт 6):** динамические координаты `top`/`left` тултипа выделения согласованы с правилами оформления и гейт-скриптом.
4. **Покрыта публикация черновика `handlePublishDraft` (Спринты 4–5):** устранён принудительный скролл на текущей странице (`TopicPage.jsx:731, 838, 898`) и задействован общий хелпер межстраничной публикации при переполнении последней страницы.
5. **Устранён хардкод цветов в образцах CSS (Спринты 2–3):** введены токены `--topic-reply-inline-bar-*`, `--topic-reply-shadow-*` в `theme-variables.css` для всех трёх тем.
6. **Исправлен проп в образце портала (Спринт 1):** указан `setLastSelectedMask={handleSelectCharacter}` из `TopicPage.jsx:1915`.
7. **Уточнены системные детали:**
   - добавлена регистрация `.highlight-target-post` в `src/index.css`;
   - пиллу `ReplyScrollStatusPill` назначен `z-index: 1051` (выше кнопок скролла `1050`);
   - сброс размещения перенесён в `onSuccess`;
   - скрипт `check-post-navigation` подключён к `package.json` как `test:post-navigation`.
8. **Контракт `check-post-navigation` переведён на двойной (коммит `0b3cf2b7d`):** скрипт принимает legacy (2 вызова `navigateToCreatedPost` + 2 литерала) или новый контракт (взведение в `jumpToCreatedPost`/`handleNavigateToTargetPage` + ровно 1 литерал); формулировки §0, задачи 4.4 и DoD спринта 5 приведены к новому контракту. Токен `--topic-reply-header-text` определён во всех трёх блоках тем (`#ffffff`; `--nav-bg` тёмный везде, поэтому белый текст подходит всем темам).

### 12.3. Журнал выполнения (заполняет исполнитель по спринтам)

| Дата | Спринт | Что сделано (коммит) | Как проверено |
|---|---|---|---|
| | Спринт 1: Архитектура портала и инлайн-слоты | | |
| | Спринт 2: Инлайн-перемещение и шапка формы | | |
| 2026-11-23 | Спринт 3: Плавающий режим и статус-виджет — ОТМЕНЁН | Решение пользователя | — |
| | Спринт 4: Отмена принудительного скролла и тоаст | | |
| | Спринт 5: Межстраничный тост публикации | | |
| | Спринт 6: Quote Tooltip, адаптивность и i18n | | |
