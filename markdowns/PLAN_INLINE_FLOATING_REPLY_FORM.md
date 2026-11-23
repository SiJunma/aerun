# План спринтов: Инлайн и плавающая форма ответа в теме (Inline & Floating Reply Composer)

> **Статус:** Рабочий пошаговый план внедрения для исполнителя  
> **Ветка:** `main`  
> **Стек:** React 19 + Vite 7 + Lucide-react + Vanilla CSS tokens + PocketBase / SQLite  
> **Целевые файлы:**  
> - `src/pages/TopicPage.jsx`  
> - `src/components/topic/TopicReplyComposer.jsx`  
> - `src/components/topic/TopicPostCard.jsx`  
> - `src/hooks/topic/useTopicPostAuth.jsx`  
> - `src/hooks/topic/useTopicJumpScroll.js`  
> - `src/components/modals/CrossPagePostModal.jsx` *(новый)*  
> - `src/components/topic/QuoteSelectionTooltip.jsx` *(новый)*  
> - `src/components/topic/FloatingReplyDrawer.jsx` *(новый)*  
> - `src/styles/topic-reply-composer.css` *(новый)*  
> - `src/styles/theme-variables.css`  
> - `src/languages/dictionary.js`  
> - `scripts/check-inline-reply-contracts.mjs` *(новый)*  
> **Основа:** `markdowns/CONCEPT_Inline_Floating_Reply_Form.md`  
> **Референс:** Discourse Docked Composer / Linear Inline Issue Reply / GitHub Discussions

---

## 0. Руководство для исполнителя (Прочти перед началом)

Этот документ представляет собой пошаговую инженерную инструкцию для реализации функционала плавающей и инлайн-формы ответа в теме форума.

### Что уже сделано в проекте (Ground Truth из `main`):
1. **Компонент формы уже декомпозирован:** Форма ответа выделена в `src/components/topic/TopicReplyComposer.jsx`.
2. **Очистка цитат и работа с выделением:** В `src/hooks/topic/useTopicPostAuth.jsx` уже есть функции `stripQuotes` и извлечение `window.getSelection()`.
3. **Модальные окна проекта:** Все модалки обязаны наследоваться от `src/components/common/ForumModal.jsx`. Использование сырого `react-bootstrap/Modal` категорически запрещено (контролируется `scripts/check-no-raw-modal.mjs`).
4. **Контракты навигации постов:** Скрипт `scripts/check-post-navigation.mjs` проверяет метод `navigateToCreatedPost(tempId, newPostId)` и наличие `state: { pendingPostId: tempId }`. Эти паттерны нельзя ломать!
5. **Тестирование:** Вся ветка `main` проходит строгий набор из 35+ скриптов проверки (`npm test`). После каждого спринта `npm test` и `npm run build` обязаны быть зелёными.

### Ключевые архитектурные правила реализации:
1. **Синглтон формы через `ReactDOM.createPortal`:**  
   Форма ответа `<TopicReplyComposer>` создаётся в дереве React **ровно в одном экземпляре**. При перемещении под пост, на плавающую шторку или обратно в подвал компонент **никогда не размонтируется (`unmount`)**! Монтирование происходит через `ReactDOM.createPortal` в слот нужного поста.
2. **Абсолютный запрет на принудительный скролл (Zero Forced Scroll):**  
   Ни при нажатии кнопки «Цитировать», ни при отправке ответа экран **не должен самовольно срываться вниз**! Пользователь остаётся у того поста, который он читал. При отправке ответа всплывает интерактивный тоаст с возможностью перейти к созданному сообщению по желанию.
3. **Автоматический возврат формы в дефолтное положение (Auto-Reset on Submit):**  
   При успешной отправке сообщения форма очищается, инлайн-слот под постом схлопывается (`height: 0`), а форма через портал возвращается на штатное место внизу страницы (подвал темы).
4. **Межстраничная публикация без резких скачков (Cross-Page Modal):**  
   Если опубликованный пост оказывается на другой странице темы (`targetPage !== currentPage`), система не делает резкий `setSearchParams({ page: targetPage })`, а показывает диалоговое окно `CrossPagePostModal` с предложением перейти или остаться на текущей странице.
5. **Строгие правила вёрстки и темы форума:**
   - **Никаких инлайн-стилей** (`style={{ ... }}`) в новых и модифицируемых компонентах.
   - **Никаких Bootstrap-утилит** (`d-flex`, `mb-3`, `text-muted`, `border-0`, `p-2` и др.) в новой вёрстке — все стили определяются классами по BEM в `topic-reply-composer.css`.
   - **Никаких новых импортов из `react-bootstrap`**. Кнопки создаются через `<Button>` или семантические теги `<button type="button" className="...">`. Модальные окна — через `<ForumModal>`.
   - **Цвета — строго через токены** из `src/styles/theme-variables.css`. Любой прямой HEX/RGB в CSS запрещён. Стили должны гармонично работать во всех трёх темах: `light`, `dark`, `neutral`.

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
│ Спринт 3: Плавающий режим и статус-виджет при скролле (Sticky Dock)    │
│ (Кнопка «В плавающее окно», FloatingDrawer, Pill-бейдж при скролле)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 4: Отмена принудительного скролла и интерактивный тоаст         │
│ (Авто-возврат в подвал, Action Toast со ссылкой [↗ Перейти к посту])   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Спринт 5: Межстраничный диалог публикации (CrossPagePostModal)         │
│ (Диалог выбора перехода/продолжения чтения, сохранение скролла)        │
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
  - `src/App.jsx` (или `index.html` / `main.jsx` для импорта `topic-reply-composer.css`)

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
3. Подключить `topic-reply-composer.css` в `src/styles/topic-view.css` или `src/pages/TopicPage.jsx`.

#### Задача 1.2. Добавление слота в карточку поста (`TopicPostCard.jsx`)
1. В `src/components/topic/TopicPostCard.jsx` в конец разметки поста (сразу после закрывающего тега карточки `article`/`div`) добавить DOM-контейнер для портала:
   ```jsx
   <div 
     id={`inline-reply-slot-${post.id}`} 
     className="inline-reply-slot" 
     data-post-id={post.id} 
   />
   ```
2. Убедиться, что слот находится **снаружи** блока самой карточки поста, чтобы границы и паддинги поста не накладывались на форму ответа.

#### Задача 1.3. Состояние размещения формы и монтирование через Portal в `TopicPage.jsx`
1. В `src/pages/TopicPage.jsx` добавить состояние размещения формы:
   ```javascript
   const [replyPlacement, setReplyPlacement] = useState({
     mode: 'bottom', // 'bottom' | 'inline' | 'floating'
     targetPostId: null,
     targetAuthor: null,
     targetPostNumber: null,
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
   - Заменить прямое монтирование `<TopicReplyComposer>` на `ReactDOM.createPortal`:
     ```jsx
     {portalTargetNode && ReactDOM.createPortal(
       <TopicReplyComposer
         ref={replyRef}
         topic={topic}
         category={category}
         user={user}
         profile={profile}
         settings={settings}
         characters={characters}
         selectedCharacterId={selectedCharacterId}
         setSelectedCharacterId={setSelectedCharacterId}
         setLastSelectedMask={setLastSelectedMask}
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
         t={t}
         placement={replyPlacement}
         onResetToBottom={() => setReplyPlacement({ mode: 'bottom', targetPostId: null, targetAuthor: null, targetPostNumber: null, isCollapsed: false })}
         onSwitchToFloating={() => setReplyPlacement(prev => ({ ...prev, mode: 'floating' }))}
         onToggleCollapse={() => setReplyPlacement(prev => ({ ...prev, isCollapsed: !prev.isCollapsed }))}
       />,
       portalTargetNode
     )}
     ```

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
- [ ] В браузере открыть тему: форма ответа отображается внизу страницы ровно так же, как и раньше, весь функционал отправки работает штатно.

---

## Спринт 2: Инлайн-перемещение по клику «Цитировать» и шапка формы (Inline Relocation & Header)

### Цель спринта
Исключить принудительный скролл вниз при нажатии кнопок «Цитировать» (`Quote`) и цитировании автора. Перемещать форму ответа непосредственно под целевой пост в режиме `inline`. Оснастить форму компактной информативной шапкой с кнопками возврата в подвал («⬇ В конец темы»), сворачивания («✕ Свернуть») и перевода в плавающее состояние.

### Файлы спринта
- **Изменить:**
  - `src/hooks/topic/useTopicPostAuth.jsx`
  - `src/pages/TopicPage.jsx`
  - `src/components/topic/TopicReplyComposer.jsx`
  - `src/styles/topic-reply-composer.css`
  - `src/languages/dictionary.js`

---

### Пошаговые задачи исполнителя

#### Задача 2.1. Модификация хука `useTopicPostAuth.jsx`
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
       targetAuthor: author,
       targetPostNumber: post.post_number,
       isCollapsed: false,
     });
     ```
3. В `handleQuoteAuthor`:
   - Если пост передан или известен контекст — также переводить форму в инлайн под пост, либо если пост не передан — оставлять форму на текущем месте без принудительного резкого скролла страницы вниз.
4. В `TopicPage.jsx` передать `setReplyPlacement` в вызов `useTopicPostAuth(...)`.

#### Задача 2.2. Шапка инлайн-режима в `TopicReplyComposer.jsx`
1. Принять пропсы `placement`, `onResetToBottom`, `onSwitchToFloating`, `onToggleCollapse` в `TopicReplyComposer.jsx`.
2. Если `placement.mode === 'inline'`, над формой рендерится специальная навигационная шапка:
   ```jsx
   {placement.mode === 'inline' && (
     <div className="topic-reply__inline-bar">
       <div className="topic-reply__inline-info">
         <span className="topic-reply__inline-badge">
           {t('forum.reply_to_post', { number: placement.targetPostNumber || placement.targetPostId })}
         </span>
         {placement.targetAuthor && (
           <span className="topic-reply__inline-author">
             @{placement.targetAuthor}
           </span>
         )}
       </div>
       <div className="topic-reply__inline-actions">
         <button
           type="button"
           className="topic-reply__inline-btn"
           onClick={onSwitchToFloating}
           title={t('forum.dock_to_bottom', 'Закрепить внизу экрана')}
           aria-label={t('forum.dock_to_bottom', 'Закрепить внизу экрана')}
         >
           <Pin size={15} />
           <span className="topic-reply__btn-label">{t('forum.dock_action', 'Закрепить')}</span>
         </button>
         <button
           type="button"
           className="topic-reply__inline-btn"
           onClick={onResetToBottom}
           title={t('forum.move_to_bottom', 'В конец темы')}
           aria-label={t('forum.move_to_bottom', 'В конец темы')}
         >
           <ArrowDownToLine size={15} />
           <span className="topic-reply__btn-label">{t('forum.to_bottom', 'В конец')}</span>
         </button>
         <button
           type="button"
           className="topic-reply__inline-btn topic-reply__inline-btn--close"
           onClick={onToggleCollapse}
           title={t('forum.collapse', 'Свернуть')}
           aria-label={t('forum.collapse', 'Свернуть')}
         >
           <Minimize2 size={15} />
         </button>
       </div>
     </div>
   )}
   ```
3. **Режим свернутого состояния (`placement.isCollapsed === true`):**
   - Если форма свернута под постом, всё тело редактора скрывается, а на его месте отображается компактный Pill-бар:
     ```jsx
     {placement.isCollapsed ? (
       <div className="topic-reply__collapsed-pill">
         <span className="topic-reply__collapsed-text">
           <FilePen size={14} />
           {t('forum.reply_collapsed_draft', 'Ответ сохранен в черновик')}
           {replyContent.trim() && ` (${replyContent.trim().length} ${t('forum.chars', 'знаков')})`}
         </span>
         <div className="topic-reply__collapsed-actions">
           <button
             type="button"
             className="topic-reply__pill-btn"
             onClick={onToggleCollapse}
           >
             {t('forum.expand', 'Развернуть')}
           </button>
           <button
             type="button"
             className="topic-reply__pill-btn topic-reply__pill-btn--danger"
             onClick={onResetToBottom}
           >
             ✕
           </button>
         </div>
       </div>
     ) : (
       /* Стандартный рендер карточки редактора */
     )}
     ```

#### Задача 2.3. Стили инлайн-формы (`topic-reply-composer.css`)
1. Оформить инлайн-шапку с использованием токенов темы:
   ```css
   .topic-reply--inline {
     margin-top: 1rem;
     margin-bottom: 1.5rem;
     border-left: 3px solid var(--primary-color);
     border-radius: var(--topic-reply-card-radius, 6px);
     box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
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
     background-color: var(--nav-bg);
     color: var(--topic-reply-header-text, #ffffff);
     border-top-left-radius: var(--topic-reply-card-radius, 6px);
     border-top-right-radius: var(--topic-reply-card-radius, 6px);
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
     border: 1px solid rgba(255, 255, 255, 0.2);
     color: #ffffff;
     border-radius: 4px;
     padding: 0.25rem 0.5rem;
     font-size: 0.75rem;
     cursor: pointer;
     transition: background-color 0.15s ease, border-color 0.15s ease;
   }

   .topic-reply__inline-btn:hover {
     background-color: rgba(255, 255, 255, 0.15);
     border-color: rgba(255, 255, 255, 0.4);
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

#### Задача 2.4. Локализация (`dictionary.js`)
1. Добавить фразы в `src/languages/dictionary.js`:
   - `forum.reply_to_post`: "Ответ на сообщение #{number}" / "Replying to post #{number}"
   - `forum.dock_to_bottom`: "Закрепить внизу экрана" / "Dock to bottom"
   - `forum.dock_action`: "Закрепить" / "Dock"
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

### Чеклист проверки после Спринта 2
- [ ] Кликнуть «Цитировать» на посте #2: форма открылась под постом #2, страница не улетела вниз.
- [ ] Ввести несколько предложений в текст.
- [ ] Кликнуть «Цитировать» на посте #5: форма переехала под пост #5, введённый ранее текст сохранился, добавилась цитата поста #5.
- [ ] Нажать кнопку «В конец»: форма вернулась в футер темы, текст на месте.
- [ ] `npm test` — все тесты проходят.
- [ ] `npm run lint:js` — 0 ошибок линтера.

---

## Спринт 3: Плавающий режим и статус-виджет при скролле (Sticky Dock & Hybrid Pill)

### Цель спринта
Реализовать режим плавающей шторки (`placement.mode === 'floating'`) в стиле лучших современных платформ (Discourse / Linear) и гибридный мини-виджет, всплывающий внизу экрана, когда форма инлайн уходит из зоны видимости при скролле.

### Файлы спринта
- **Создать:**
  - `src/components/topic/FloatingReplyDrawer.jsx`
  - `src/components/topic/ReplyScrollStatusPill.jsx`
- **Изменить:**
  - `src/pages/TopicPage.jsx`
  - `src/components/topic/TopicReplyComposer.jsx`
  - `src/styles/topic-reply-composer.css`
  - `src/languages/dictionary.js`

---

### Пошаговые задачи исполнителя

#### Задача 3.1. Плавающий режим формы в `TopicReplyComposer.jsx`
1. Когда `placement.mode === 'floating'`:
   - Форма через портал проецируется в `#floating-reply-drawer-slot`.
   - Карточке формы присваивается класс `.topic-reply--floating`.
   - В шапке формы отображается заголовок темы, кнопки свернуть в нижний бар (`— Свернуть`) и вернуть в подвал (`⬇ В подвал`).
   - Добавляется возможность изменения высоты (drag-handle) или переключения режима развернутости.

#### Задача 3.2. Стили плавающего режима (`topic-reply-composer.css`)
1. Добавить стилизацию плавающей шторки:
   ```css
   .topic-reply--floating {
     width: 100%;
     max-width: 960px;
     margin: 0 auto;
     background-color: var(--card-bg);
     border: 1px solid var(--border-color);
     border-bottom: none;
     border-top-left-radius: 8px;
     border-top-right-radius: 8px;
     box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.25);
     animation: floatingDrawerSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);
   }

   @keyframes floatingDrawerSlideUp {
     from {
       transform: translateY(100%);
     }
     to {
       transform: translateY(0);
     }
   }

   .topic-reply--floating .topic-reply__card {
     border: none;
     border-radius: 0;
     box-shadow: none;
   }
   ```

#### Задача 3.3. Гибридный статус-виджет при скролле (`ReplyScrollStatusPill.jsx`)
1. Создать компонент `src/components/topic/ReplyScrollStatusPill.jsx`.
2. Компонент отслеживает через `IntersectionObserver` видимость инлайн-формы на экране:
   - Если `placement.mode === 'inline'`, форма развернута, но ушла за пределы вьюпорта (пользователь читает другие посты), в правом нижнем углу всплывает аккуратный Pill:
     ```jsx
     <div className="reply-scroll-pill">
       <span className="reply-scroll-pill__title">
         ✏️ {t('forum.reply_in_progress', 'Ответ под постом')} #{placement.targetPostNumber || placement.targetPostId}
       </span>
       <div className="reply-scroll-pill__actions">
         <button
           type="button"
           className="reply-scroll-pill__btn"
           onClick={scrollToInlineForm}
         >
           ↑ {t('forum.to_form', 'К форме')}
         </button>
         <button
           type="button"
           className="reply-scroll-pill__btn reply-scroll-pill__btn--primary"
           onClick={onSwitchToFloating}
         >
           📌 {t('forum.dock', 'Открепить')}
         </button>
       </div>
     </div>
     ```
3. Стилизация виджета в `topic-reply-composer.css`:
   ```css
   .reply-scroll-pill {
     position: fixed;
     bottom: 1.5rem;
     right: 1.5rem;
     z-index: 1030;
     display: flex;
     align-items: center;
     gap: 0.75rem;
     padding: 0.5rem 1rem;
     background-color: var(--card-bg);
     border: 1px solid var(--border-color);
     border-radius: 30px;
     box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2);
     animation: pillFadeIn 0.2s ease-out;
   }

   .reply-scroll-pill__title {
     font-size: 0.85rem;
     font-weight: 500;
     color: var(--text-color);
   }

   .reply-scroll-pill__btn {
     background: transparent;
     border: 1px solid var(--border-color);
     color: var(--text-color);
     border-radius: 16px;
     padding: 0.2rem 0.6rem;
     font-size: 0.75rem;
     cursor: pointer;
   }

   .reply-scroll-pill__btn:hover {
     background-color: var(--primary-color);
     color: #ffffff;
   }
   ```

---

### Критерии готовности Спринта 3 (Definition of Done)
1. Форма умеет переключаться в режим `floating` (шторка внизу окна).
2. Пользователь может свободно скроллить всю страницу вверх и вниз, редактор всегда зафиксирован перед глазами.
3. В инлайн-режиме при уходе формы из зоны видимости экрана появляется статус-виджет с возможностью мгновенного скролла к форме или открепления в шторку.
4. Отсутствуют любые сбросы состояния редактора (текст не теряется).

### Чеклист проверки после Спринта 3
- [ ] Открыть форму под постом #3, проскроллить вниз до поста #15.
- [ ] Проверить появление мини-виджета внизу экрана.
- [ ] Нажать «К форме» — экран плавно скроллится обратно к посту #3.
- [ ] Нажать «Открепить» — форма переходит в шторку внизу экрана.
- [ ] Проверить сборку `npm run build` и тесты `npm test`.

---

## Спринт 4: Отмена принудительного скролла и интерактивный тоаст публикации (Zero Forced Scroll & Action Toast)

### Цель спринта
Исключить принудительный скролл вниз экрана при отправке ответа на текущей странице (`TopicPage.jsx:submitReply`). Автоматически сбрасывать инлайн-форму в дефолтный подвал, схлопывать слот и выводить интерактивный тоаст с предложением перейти к созданному сообщению по желанию пользователя (с эффектом подсветки `.highlight-new-post` как в ссылках цитат `BBCode.jsx`).

### Файлы спринта
- **Изменить:**
  - `src/pages/TopicPage.jsx`
  - `src/hooks/topic/useTopicJumpScroll.js`
  - `src/contexts/ToastProvider.jsx` (или хелпер тоастов)
  - `src/styles/topic-view.css`
  - `src/languages/dictionary.js`

---

### Пошаговые задачи исполнителя

#### Задача 4.1. Автоматический возврат формы в дефолтное положение при отправке
1. В `src/pages/TopicPage.jsx` в методе `submitReply()` перед отправкой мутации:
   ```javascript
   // 1. Очистка инлайн-размещения и возврат в дефолтный слот в подвале темы
   setReplyPlacement({
     mode: 'bottom',
     targetPostId: null,
     targetAuthor: null,
     targetPostNumber: null,
     isCollapsed: false,
   });
   ```
2. Очистить локальный черновик темы: `localStorage.removeItem(DRAFT_KEY)`.
3. Убедиться, что инлайн-слот под постом `#inline-reply-slot-${postId}` плавно схлопывается и не оставляет пустого места между постами.

#### Задача 4.2. Отмена принудительного скролла на текущей странице
1. В `src/pages/TopicPage.jsx` в ветке `targetPage === currentPage`:
   - Найти места, где ранее принудительно вызывался скролл или взводился безусловный флаг jump-контроллера.
   - **ОТМЕНИТЬ автоматический скролл вниз экрана:** экран читателя должен оставаться на месте!
   - Вместо принудительного скролла отобразить интерактивный тоаст.

#### Задача 4.3. Интерактивный тоаст перехода к посту (`Action Toast`)
1. Реализовать хелпер мягкого скролла к созданному посту:
   ```javascript
   const jumpToPostWithHighlight = useCallback((postId) => {
     const el = document.getElementById(`post-${postId}`);
     if (el) {
       el.scrollIntoView({ behavior: 'smooth', block: 'center' });
       el.classList.add('highlight-new-post');
       setTimeout(() => el.classList.remove('highlight-new-post'), 2500);
     }
   }, []);
   ```
2. Вызывать тоаст при успешной публикации:
   ```javascript
   showToast(
     <div className="action-toast-content">
       <span>{t('forum.post_published', 'Сообщение опубликовано')}</span>
       <button
         type="button"
         className="action-toast-btn"
         onClick={() => jumpToPostWithHighlight(newPostId || tempId)}
       >
         {t('forum.go_to_post', 'Перейти к сообщению ↗')}
       </button>
     </div>,
     'success',
     6000
   );
   ```
3. Стилизовать `action-toast-btn` в `topic-reply-composer.css`:
   ```css
   .action-toast-content {
     display: flex;
     align-items: center;
     justify-content: space-between;
     gap: 1rem;
     width: 100%;
   }

   .action-toast-btn {
     background-color: rgba(255, 255, 255, 0.2);
     border: 1px solid rgba(255, 255, 255, 0.4);
     color: inherit;
     border-radius: 4px;
     padding: 0.25rem 0.6rem;
     font-size: 0.8rem;
     font-weight: 600;
     cursor: pointer;
     white-space: nowrap;
   }

   .action-toast-btn:hover {
     background-color: rgba(255, 255, 255, 0.35);
   }
   ```

#### Задача 4.4. Сохранение контрактов тестов `scripts/check-post-navigation.mjs`
1. Внимательно проверить, что в `TopicPage.jsx` сохранены обязательные вызовы:
   - `navigateToCreatedPost(tempIdRef, newPostId);`
   - Запись `state: { pendingPostId: tempId }`
2. Запустить `node scripts/check-post-navigation.mjs` и убедиться, что тест полностью удовлетворён.

---

### Критерии готовности Спринта 4 (Definition of Done)
1. При отправке сообщения инлайн-форма схлопывается и возвращается в дефолтный подвал страницы.
2. Экран пользователя **не срывается вниз**.
3. Всплывает тоаст успеха с кнопкой `[Перейти к сообщению ↗]`.
4. При клике на кнопку страница плавно скроллится к сообщению, и оно подсвечивается классом `.highlight-new-post`.
5. Если пользователь не кликает, тоаст мягко исчезает через 6 секунд, чтение темы не прерывается.
6. Скрипт `check-post-navigation.mjs` и `npm test` зелёные.

### Чеклист проверки после Спринта 4
- [ ] Написать ответ на пост #3 в середине страницы и нажать «Отправить».
- [ ] Убедиться, что экран остался на посте #3.
- [ ] Убедиться, что форма под постом #3 исчезла, а в подвале темы появилась чистая форма.
- [ ] Кликнуть в тоасте кнопку «Перейти к сообщению ↗» — экран плавно центрирует новый пост внизу с анимацией подсветки.
- [ ] `npm test` — PASS.

---

## Спринт 5: Межстраничный диалог публикации (CrossPagePostModal)

### Цель спринта
Исключить автоматический срыв пользователя на другую страницу пагинации при публикации ответа (`targetPage !== currentPage`). Реализовать модальное окно `CrossPagePostModal` на базе `ForumModal`, предлагающее пользователю осознанный выбор: перейти к опубликованному сообщению на последней странице темы или продолжить спокойное чтение текущей страницы.

### Файлы спринта
- **Создать:**
  - `src/components/modals/CrossPagePostModal.jsx`
- **Изменить:**
  - `src/pages/TopicPage.jsx`
  - `src/languages/dictionary.js`
  - `src/styles/topic-reply-composer.css`

---

### Пошаговые задачи исполнителя

#### Задача 5.1. Создание компонента `CrossPagePostModal.jsx`
1. Создать файл `src/components/modals/CrossPagePostModal.jsx`.
2. Использовать проектный компонент `src/components/common/ForumModal.jsx` (ни в коем случае не сырой `react-bootstrap/Modal`!):
   ```jsx
   import React from 'react';
   import ForumModal from '../common/ForumModal';
   import Button from '../common/Button';
   import { ArrowRight, CheckCircle2 } from 'lucide-react';

   export const CrossPagePostModal = ({
     show,
     targetPage,
     currentPage,
     onNavigate,
     onClose,
     t,
   }) => {
     return (
       <ForumModal
         show={show}
         onHide={onClose}
         title={t('forum.post_published_title', 'Сообщение успешно опубликовано')}
         size="md"
       >
         <div className="cross-page-modal__content">
           <div className="cross-page-modal__icon">
             <CheckCircle2 size={40} />
           </div>
           <p className="cross-page-modal__text">
             {t('forum.cross_page_desc', {
               current: currentPage,
               target: targetPage,
               defaultValue: `Ваш ответ успешно добавлен в тему. Поскольку вы отвечали со страницы ${currentPage}, новое сообщение размещено на последней странице (страница ${targetPage}).`
             })}
           </p>
           <p className="cross-page-modal__subtext">
             {t('forum.cross_page_question', 'Желаете перейти к опубликованному сообщению прямо сейчас?')}
           </p>
         </div>
         <div className="cross-page-modal__footer">
           <Button
             type="button"
             variant="secondary"
             onClick={onClose}
           >
             {t('forum.stay_on_page', 'Остаться на текущей странице')}
           </Button>
           <Button
             type="button"
             variant="primary"
             onClick={onNavigate}
             rightIcon={<ArrowRight size={16} />}
           >
             {t('forum.go_to_page', `Перейти на страницу ${targetPage}`)}
           </Button>
         </div>
       </ForumModal>
     );
   };

   export default CrossPagePostModal;
   ```

#### Задача 5.2. Интеграция в `TopicPage.jsx`
1. В `TopicPage.jsx` добавить состояние модалки:
   ```javascript
   const [crossPageModal, setCrossPageModal] = useState({
     show: false,
     postId: null,
     targetPage: 1,
     currentPage: 1,
   });
   ```
2. В `submitReply()` при расчете `targetPage !== currentPage`:
   - Сохранить пост в оптимистичную очередь `queueOptimisticPost`.
   - **НЕ ВЫЗЫВАТЬ** немедленный `setSearchParams({ page: String(targetPage) })`!
   - Открыть модальное окно:
     ```javascript
     setCrossPageModal({
       show: true,
       postId: tempId,
       targetPage,
       currentPage,
     });
     ```
3. Обработчик «Перейти»:
   ```javascript
   const handleNavigateToTargetPage = () => {
     setCrossPageModal(prev => ({ ...prev, show: false }));
     setAlreadyJumped(false);
     setSearchParams((prev) => {
       const next = new URLSearchParams(prev);
       next.set('page', String(crossPageModal.targetPage));
       return next;
     }, {
       preventScrollReset: true,
       state: { pendingPostId: crossPageModal.postId }
     });
   };
   ```
4. Обработчик «Остаться на текущей странице»:
   ```javascript
   const handleStayOnCurrentPage = () => {
     setCrossPageModal(prev => ({ ...prev, show: false }));
     showToast(
       <div className="action-toast-content">
         <span>{t('forum.published_on_target_page', { page: crossPageModal.targetPage })}</span>
         <button
           type="button"
           className="action-toast-btn"
           onClick={handleNavigateToTargetPage}
         >
           {t('forum.go_to_page_short', `Стр. ${crossPageModal.targetPage} ↗`)}
         </button>
       </div>,
       'info',
       7000
     );
   };
   ```

---

### Критерии готовности Спринта 5 (Definition of Done)
1. При ответе с архивной страницы пользователь остаётся на текущей странице, скролл не срывается.
2. Всплывает `CrossPagePostModal`.
3. Клик «Остаться на текущей странице» закрывает окно и оставляет пользователя читать тему дальше.
4. Клик «Перейти на страницу N» переключает пагинатор и мягко центрирует созданный пост.
5. Правило `scripts/check-no-raw-modal.mjs` и `scripts/check-post-navigation.mjs` соблюдены на 100%.

### Чеклист проверки после Спринта 5
- [ ] Зайти на страницу 1 многостраничной темы (всего 3 страницы).
- [ ] Нажать «Цитировать» и отправить ответ.
- [ ] Убедиться, что не произошел внезапный переход на страницу 3.
- [ ] В открывшейся модалке нажать «Остаться на текущей странице» — пользователь остался на странице 1, появился тоаст с быстрой ссылкой.
- [ ] Повторить тест и нажать «Перейти» — открылась страница 3, пост подсвечен.
- [ ] `npm test` — все тесты зелёные.

---

## Спринт 6: Быстрое цитирование выделения, адаптивность и i18n (Quote Tooltip & Hardening)

### Цель спринта
Реализовать всплывающий тултип цитирования при выделении мышкой фрагмента сообщения (`QuoteSelectionTooltip`), оптимизировать форму под мобильные экраны (< 768px), завершить локализацию и создать автоматический скрипт проверки контрактов `scripts/check-inline-reply-contracts.mjs`.

### Файлы спринта
- **Создать:**
  - `src/components/topic/QuoteSelectionTooltip.jsx`
  - `scripts/check-inline-reply-contracts.mjs`
- **Изменить:**
  - `src/components/topic/TopicPostCard.jsx`
  - `src/styles/topic-reply-composer.css`
  - `src/languages/dictionary.js`
  - `package.json` (добавление скрипта в `npm test`)

---

### Пошаговые задачи исполнителя

#### Задача 6.1. Всплывающий тултип быстрого цитирования (`QuoteSelectionTooltip.jsx`)
1. Создать компонент `src/components/topic/QuoteSelectionTooltip.jsx`.
2. Компонент слушает событие `mouseup`/`selectionchange` внутри контейнера поста:
   - Если пользователь выделил от 3 до 2000 символов внутри `.post-content`, вычисляются экранные координаты выделения (`range.getBoundingClientRect()`).
   - Над выделенной фразой всплывает компактная кнопка с иконкой цитаты:
     ```jsx
     <button
       type="button"
       className="quote-selection-tooltip"
       style={{ top: tooltipCoords.top, left: tooltipCoords.left }}
       onMouseDown={(e) => {
         e.preventDefault(); // чтобы не сбросить выделение
         handleQuoteSelection(post, selectedText);
       }}
     >
       <Quote size={14} />
       <span>{t('forum.quote_selection', 'Цитата')}</span>
     </button>
     ```
3. При клике в форму ответа конкатенируется только выделенный текст, обернутый в BB-код цитаты, и форма активируется под данным постом.
4. Выделение в браузере очищается (`window.getSelection().removeAllRanges()`).

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
       display: none; /* скрываем текст кнопок, оставляя только иконки */
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
1. Создать скрипт проверки контрактов:
   - Проверяет наличие контейнеров слотов `#inline-reply-slot-`, `#bottom-reply-slot`, `#floating-reply-drawer-slot`.
   - Проверяет использование `createPortal` в `TopicPage.jsx`.
   - Проверяет отсутствие сырого `react-bootstrap/Modal` в `CrossPagePostModal.jsx`.
   - Проверяет отсутствие инлайн-стилей `style={{` в новых компонентах.
   - Проверяет наличие всех новых ключей в `dictionary.js`.
2. Подключить запуск скрипта в `package.json` в цепочку `npm test`.

---

### Критерии готовности Спринта 6 (Definition of Done)
1. Выделение текста в любом сообщении вызывает аккуратный тултип «💬 Цитата».
2. Клик по тултипу отправляет в форму только выделенный фрагмент и разворачивает инлайн-форму под постом.
3. На мобильных устройствах композер гармонично адаптируется в Bottom Sheet.
4. Скрипт `check-inline-reply-contracts.mjs` внедрен и отдаёт PASS.
5. `npm test` и `npm run build` полностью зелёные.

### Чеклист проверки после Спринта 6
- [ ] Выделить фрагмент текста внутри поста мышкой → появился тултип «Цитата».
- [ ] Нажать на тултип → в форме появилась цитата только выделенного фрагмента.
- [ ] Проверить отображение во всех 3 темах: `light`, `dark`, `neutral`.
- [ ] Проверить на мобильной ширине 375px в инструментах разработчика.
- [ ] `node scripts/check-inline-reply-contracts.mjs` — PASS.
- [ ] `npm test` — все 36+ тестов зелёные.

---

## 7. Сводная таблица правил и проверок

| Правило | Где проверять | Команда / Скрипт |
|---|---|---|
| **Синглтон формы (React Portal)** | `TopicPage.jsx` | `node scripts/check-inline-reply-contracts.mjs` |
| **Слоты инлайн-ответа** | `TopicPostCard.jsx` | `node scripts/check-inline-reply-contracts.mjs` |
| **Zero Forced Scroll** | `TopicPage.jsx` | Ручной сценарий E2E + контракты `useTopicJumpScroll` |
| **Межстраничная модалка** | `CrossPagePostModal.jsx` | `node scripts/check-no-raw-modal.mjs` |
| **Контракт навигации постов** | `TopicPage.jsx` | `node scripts/check-post-navigation.mjs` |
| **Без инлайн-стилей** | Новые JSX-файлы | `node scripts/check-inline-reply-contracts.mjs` |
| **Без Bootstrap-утилит** | Новые JSX-файлы | `node scripts/check-inline-reply-contracts.mjs` |
| **Цвета из theme-variables** | `topic-reply-composer.css` | Ручной визуальный аудит (Light/Dark/Neutral) |
| **Общая сборка фронтенда** | Vite build | `npm run build` |
| **Линтер фронтенда** | ESLint | `npm run lint:js` |
| **Регрессия всех тестов** | Весь проект | `npm test` |

---

## 12. Журнал выполнения и решений

### 12.1. Решения (зафиксировано до и по ходу работы)

| Дата | Решение | Кто / источник |
|---|---|---|
| 2026-11-23 | Форма ответа реализуется как **синглтон через `ReactDOM.createPortal`**, исключая unmount/remount и сброс состояния редактора | Архитектурный выбор |
| 2026-11-23 | При нажатии «Цитировать» принудительный скролл вниз **отменяется**, форма монтируется инлайн под целевым постом | Пользователь / Концепт |
| 2026-11-23 | При отправке ответа форма **автоматически возвращается в подвал темы**, инлайн-слот схлопывается | Пользователь / Концепт |
| 2026-11-23 | На текущей странице при отправке экран **не срывается вниз**; показывается интерактивный Action Toast со ссылкой `[↗ Перейти к сообщению]` | Пользователь / Концепт |
| 2026-11-23 | При отправке на другой странице (`targetPage !== currentPage`) резкий переход отменяется, показывается модалка выбора `CrossPagePostModal` | Пользователь / Концепт |
| 2026-11-23 | Все модалки строятся строго на базе `ForumModal` (прямой `react-bootstrap/Modal` запрещён правилом `check-no-raw-modal.mjs`) | Правило репозитория |
| 2026-11-23 | Стили оформляются в `topic-reply-composer.css` на базе переменных из `theme-variables.css`, без инлайн-стилей и классов Bootstrap | Правило репозитория |

### 12.2. Проверка плана (2026-11-23 — сверка с `main`)

Подтверждено в кодовой базе ветки `main`:
1. Компонент `TopicReplyComposer.jsx` уже изолирован и готов к расширению пропсами `placement`, `onResetToBottom`, `onSwitchToFloating`.
2. В `useTopicPostAuth.jsx` уже есть логика очистки цитат `stripQuotes` и заготовка под выделение `window.getSelection()`.
3. Контракты тестов `check-post-navigation.mjs` и `check-unsent-reply-rescue.mjs` учтены и защищены от поломок.
4. План полностью декомпозирован на 6 последовательных изолированных спринтов и готов к передаче исполнителю.

### 12.3. Журнал выполнения (заполняет исполнитель по спринтам)

| Дата | Спринт | Что сделано (коммит) | Как проверено |
|---|---|---|---|
| | Спринт 1: Архитектура портала и инлайн-слоты | | |
| | Спринт 2: Инлайн-перемещение и шапка формы | | |
| | Спринт 3: Плавающий режим и статус-виджет | | |
| | Спринт 4: Отмена принудительного скролла и тоаст | | |
| | Спринт 5: Межстраничный диалог публикации | | |
| | Спринт 6: Quote Tooltip, адаптивность и i18n | | |

