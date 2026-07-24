import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Button, Form, Dropdown, Table } from 'react-bootstrap';
import ForumModal from './ForumModal';
import {
  Bold, Italic, Underline, Strikethrough, Link as LinkIcon, Image as ImageIcon,
  Quote, Undo, Redo, Palette, ALargeSmall, Columns, Dices, Clapperboard,
  Youtube, EyeOff, Minus, Smile, AlignLeft, AlignCenter, AlignRight,
  AlignJustify, Keyboard, MoreHorizontal, Superscript, Subscript, HelpCircle, Code
} from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import SmilesPicker from './SmilesPicker';

const RichEditor = forwardRef(({
  value, onChange, placeholder, rows = 6, minHeight, id = 'rich-editor',
  maxLength, autoFocus, showDice = false, isEdit = false, hideDiceType = false,
  showHide = true, smilesDropDirection = "up", smilesFullWidth = true, onSubmit,
  hideHotkeysButton = false
}, ref) => {
  const { lang, t } = useI18n();

  const textareaRef = useRef(null);
  const containerRef = useRef(null);
  const toolbarContainerRef = useRef(null);
  const [editorWidth, setEditorWidth] = useState(0);

  // Responsive Toolbar state
  const [visibleGroupIds, setVisibleGroupIds] = useState([]);
  const [overflowGroupIds, setOverflowGroupIds] = useState([]);

  // Modals state
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [linkData, setLinkData] = useState({ text: '', url: 'https://' });
  const [imageData, setImageData] = useState({ alt: '', url: 'https://', width: '' });
  const [showDiceModal, setShowDiceModal] = useState(false);
  const [diceData, setDiceData] = useState({ sides: 6, type: 'normal' });
  const [showHideModal, setShowHideModal] = useState(false);
  const [hideData, setHideData] = useState({ threshold: '10', type: 'posts' });
  const [showColumnsModal, setShowColumnsModal] = useState(false);
  const [columnsData, setColumnsData] = useState({ count: 2, stack: '768' });
  const [showHotkeysModal, setShowHotkeysModal] = useState(false);
  const [showSmilesModal, setShowSmilesModal] = useState(false);
  const [showAbbrModal, setShowAbbrModal] = useState(false);
  const [abbrData, setAbbrData] = useState({ text: '', title: '' });

  useImperativeHandle(ref, () => ({
    openHotkeysModal: () => setShowHotkeysModal(true)
  }));

  // Undo/Redo history
  const [history, setHistory] = useState([value || '']);
  const [historyIndex, setHistoryIndex] = useState(0);

  const latestValueRef = useRef(value || '');
  useEffect(() => {
    latestValueRef.current = value || '';
  }, [value]);

  const lastHistoryPushTime = useRef(0);
  const isInternalUpdate = useRef(false);

  useEffect(() => {
    if (value === undefined || value === null) return;

    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }

    const currentTip = history[historyIndex] || '';
    if (value !== currentTip) {
      setHistory([value]);
      setHistoryIndex(0);
      lastHistoryPushTime.current = Date.now();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      const textarea = textareaRef.current;
      textarea.focus();
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);

      setTimeout(() => {
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }

    const updateWidth = () => {
      if (containerRef.current) {
        setEditorWidth(containerRef.current.offsetWidth);
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    const observer = new ResizeObserver(updateWidth);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', updateWidth);
      observer.disconnect();
    };
  }, [autoFocus]);

  const addToHistory = (newValue, forceNewSnapshot = true) => {
    let newHistory = history.slice(0, historyIndex + 1);
    const now = Date.now();

    if (!forceNewSnapshot && newHistory.length > 1 && (now - lastHistoryPushTime.current < 1500)) {
      newHistory[newHistory.length - 1] = newValue;
      setHistory(newHistory);
      return;
    }

    if (newHistory[newHistory.length - 1] !== newValue) {
      newHistory.push(newValue);
      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      lastHistoryPushTime.current = now;
    }
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const prevValue = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      onChange({ target: { value: prevValue } });
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const nextValue = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      onChange({ target: { value: nextValue } });
    }
  };

  const insertText = (before, after = '', type = '') => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const currentScrollTop = textarea.scrollTop;
    const selected = text.substring(start, end);

    let replacement = '';
    
    // Auto-populate tags for common block types if they aren't provided
    if (type === 'quote' && !before) {
      before = '[quote]';
      after = '[/quote]';
    } else if (type === 'spoiler' && !before) {
      const defaultTitle = lang === 'ru' ? 'Спойлер' : 'Spoiler';
      before = `[spoiler="${defaultTitle}"]`;
      after = '[/spoiler]';
    } else if (type === 'bullet' && !before) {
      before = '[list]\n[*] ';
      after = '\n[/list]';
    }
    
    const blockTags = ['quote', 'spoiler', 'bullet', 'columns', 'code', 'list', 'hr', 'table'];
    const isBlock = blockTags.includes(type) || (before.startsWith('[code]') || before.startsWith('[html]') || before.startsWith('[table]') || before.startsWith('[list]'));

    let preText = text.substring(0, start);
    let postText = text.substring(end);

    if (isBlock) {
      if (start > 0) {
        let i = start - 1;
        while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
        
        let newStart = i + 1;
        
        // Count trailing newlines
        let nlCount = 0;
        let j = newStart - 1;
        while (j >= 0 && (text[j] === '\n' || text[j] === '\r')) {
          nlCount++;
          j--;
        }
        
        if (nlCount === 0) {
          replacement = '\n' + before + (selected || '') + after;
        } else if (nlCount > 1) {
          // Collapse multiple newlines to one
          replacement = before + (selected || '') + after;
          // Trim the extra newlines from preText
          preText = text.substring(0, j + 2); 
        } else {
          replacement = before + (selected || '') + after;
        }
      } else {
        replacement = before + (selected || '') + after;
      }
    } else if (type === 'size') {
      replacement = `[size=${before}]${selected || (lang === 'ru' ? 'размер' : 'size')}[/size]`;
    } else if (type === 'color') {
      replacement = `[color=${before}]${selected || (lang === 'ru' ? 'цвет' : 'color')}[/color]`;
    } else {
      replacement = before + selected + after;
    }

    const newValue = preText + replacement + postText;

    let newHistory = history.slice(0, historyIndex + 1);
    if (newHistory[newHistory.length - 1] !== text) newHistory.push(text);
    if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
    newHistory.push(newValue);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    lastHistoryPushTime.current = Date.now();

    onChange({ target: { value: newValue } });

    setTimeout(() => {
      textarea.focus();
      let cursorStart, cursorEnd;

      if (selected.length === 0) {
        if (type === 'bullet') {
          cursorStart = start + (replacement.includes('\n[list]') ? 1 : 0) + '[list]\n[*] '.length;
          cursorEnd = cursorStart;
        } else if (type === 'quote') {
          cursorStart = start + (replacement.startsWith('\n') ? 1 : 0) + '[quote]'.length;
          cursorEnd = cursorStart;
        } else if (type === 'spoiler') {
          const defaultTitle = lang === 'ru' ? 'Спойлер' : 'Spoiler';
          cursorStart = start + (replacement.startsWith('\n') ? 1 : 0) + `[spoiler="${defaultTitle}"]`.length;
          cursorEnd = cursorStart;
        } else if (before && after) {
          cursorStart = start + (replacement.startsWith('\n') ? 1 : 0) + before.length;
          cursorEnd = cursorStart;
        } else {
          cursorStart = start + replacement.length;
          cursorEnd = cursorStart;
        }
      } else {
        cursorStart = start + replacement.length;
        cursorEnd = cursorStart;
      }

      textarea.setSelectionRange(cursorStart, cursorEnd);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const closeModalWithFocus = (setModalFn) => {
    setModalFn(false);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 10);
  };

  // Responsive logic for toolbar overflow
  useEffect(() => {
    const groups = [
      { id: 'style', priority: 1, width: 215 },
      { id: 'history', priority: 2, width: 85 },
      { id: 'smiles', priority: 3, width: 45 },
      { id: 'links', priority: 4, width: 45 },
      { id: 'typography', priority: 5, width: 100 },
      { id: 'align', priority: 6, width: 145 },
      { id: 'inserts', priority: 7, width: 160 },
      { id: 'media', priority: 8, width: 85 },
      { id: 'advanced', priority: 9, width: (showHide ? 45 : 0) + (showDice && !isEdit ? 45 : 0) + 75 }
    ];

    const manualButtonWidth = 45;
    const moreButtonWidth = 50;
    const padding = 16; // Toolbar padding
    
    let availableWidth = editorWidth - manualButtonWidth - padding;
    if (availableWidth < 0) availableWidth = 0;

    const totalNeeded = groups.reduce((acc, g) => acc + g.width, 0);
    
    if (totalNeeded <= availableWidth) {
      setVisibleGroupIds(groups.map(g => g.id));
      setOverflowGroupIds([]);
    } else {
      availableWidth -= moreButtonWidth;
      let visible = [];
      let overflow = [];
      let currentWidth = 0;
      
      for (const group of groups) {
        if (currentWidth + group.width <= availableWidth) {
          visible.push(group.id);
          currentWidth += group.width;
        } else {
          overflow.push(group.id);
        }
      }
      setVisibleGroupIds(visible);
      setOverflowGroupIds(overflow);
    }
  }, [editorWidth, isEdit, showDice, showHide]);

  const handleKeyDown = (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isAlt = e.altKey;
    const isShift = e.shiftKey;

    if (isCtrl && e.code === 'KeyZ') {
      e.preventDefault();
      if (isShift) handleRedo(); else handleUndo();
      return;
    }
    if (isCtrl && e.code === 'KeyY') {
      e.preventDefault();
      handleRedo();
      return;
    }
    if (isCtrl && e.code === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (isCtrl && e.code === 'Slash') {
      e.preventDefault();
      setShowHotkeysModal(true);
      return;
    }

    if (isCtrl && !isAlt && !isShift) {
      switch (e.code) {
        case 'KeyB': e.preventDefault(); insertText('[b]', '[/b]'); break;
        case 'KeyI': e.preventDefault(); insertText('[i]', '[/i]'); break;
        case 'KeyU': e.preventDefault(); insertText('[u]', '[/u]'); break;
        case 'KeyS': e.preventDefault(); insertText('[s]', '[/s]'); break;
        case 'KeyL': e.preventDefault(); insertText('[left]', '[/left]'); break;
        case 'KeyR': e.preventDefault(); insertText('[right]', '[/right]'); break;
        case 'KeyE': e.preventDefault(); insertText('[center]', '[/center]'); break;
        case 'KeyJ': e.preventDefault(); insertText('[justify]', '[/justify]'); break;
        case 'KeyK': e.preventDefault(); setShowLinkModal(true); break;
        case 'KeyG': e.preventDefault(); insertText('', '', 'spoiler'); break;
        case 'KeyH': e.preventDefault(); setShowHideModal(true); break;
        case 'KeyQ': e.preventDefault(); insertText('', '', 'quote'); break;
        case 'BracketLeft': e.preventDefault(); insertText('[code]', '[/code]', 'code'); break;
        case 'BracketRight': e.preventDefault(); insertText('[html]', '[/html]', 'html'); break;
        default: break;
      }
    }

    if (isAlt && !isCtrl && !isShift) {
      switch (e.code) {
        case 'KeyV': e.preventDefault(); insertText('[video]', '[/video]'); break;
        case 'KeyI': e.preventDefault(); setShowImageModal(true); break;
        case 'KeyH': e.preventDefault(); insertText('[hr]', '', 'hr'); break;
        case 'KeyT': e.preventDefault(); insertText('[table]\n[tr][td]', '[/td][/tr]\n[/table]', 'table'); break;
        case 'KeyL': e.preventDefault(); insertText('[left]', '[/left]'); break;
        case 'KeyR': e.preventDefault(); insertText('[right]', '[/right]'); break;
        default: break;
      }
    }

    if (isCtrl && isShift) {
      switch (e.code) {
        case 'KeyD': e.preventDefault(); insertText('[added]', '[/added]'); break;
        case 'KeyA': e.preventDefault(); insertText('[info]', '[/info]'); break;
        case 'KeyM': e.preventDefault(); insertText('', '', 'bullet'); break;
        default: break;
      }
    }

    if (isShift && e.key === 'Tab') {
      e.preventDefault();
      insertText('    ', '');
    }
  };

  const handleTextChange = (e) => {
    const newValue = e.target.value;
    onChange(e);
    addToHistory(newValue, false);
  };

  const handleLinkSubmit = (e) => {
    e.preventDefault();
    const capturedLinkData = { ...linkData };
    setShowLinkModal(false);
    setLinkData({ text: '', url: 'https://' });
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      const selected = text.substring(start, end);
      const { url, text: linkText } = capturedLinkData;
      if (!url) return;
      
      const replacement = `[url=${url}]${linkText || selected || 'link'}[/url]`;
      const newValue = text.substring(0, start) + replacement + text.substring(end);

      let newHistory = history.slice(0, historyIndex + 1);
      if (newHistory[newHistory.length - 1] !== text) newHistory.push(text);
      newHistory.push(newValue);
      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
      
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      lastHistoryPushTime.current = Date.now();

      isInternalUpdate.current = true;
      onChange({ target: { value: newValue } });

      textarea.focus();
      const newCursorPos = start + replacement.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const openAbbrModal = () => {
    const textarea = textareaRef.current;
    const selected = textarea ? textarea.value.substring(textarea.selectionStart, textarea.selectionEnd) : '';
    setAbbrData({ text: selected, title: '' });
    setShowAbbrModal(true);
  };

  const handleAbbrSubmit = (e) => {
    e.preventDefault();
    const capturedAbbrData = { ...abbrData };
    setShowAbbrModal(false);
    setAbbrData({ text: '', title: '' });
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      const selected = text.substring(start, end);
      const { title, text: abbrText } = capturedAbbrData;
      if (!title) return;
      
      const replacement = `[abbr="${title}"]${abbrText || selected || 'text'}[/abbr]`;
      const newValue = text.substring(0, start) + replacement + text.substring(end);

      let newHistory = history.slice(0, historyIndex + 1);
      if (newHistory[newHistory.length - 1] !== text) newHistory.push(text);
      newHistory.push(newValue);
      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
      
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      lastHistoryPushTime.current = Date.now();

      isInternalUpdate.current = true;
      onChange({ target: { value: newValue } });

      textarea.focus();
      const newCursorPos = start + replacement.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const handleImageSubmit = (e) => {
    e.preventDefault();
    const capturedImageData = { ...imageData };
    setShowImageModal(false);
    setImageData({ alt: '', url: 'https://', width: '' });
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      const url = capturedImageData.url;
      let prefix = '[img';
      if (capturedImageData.alt.trim() && !capturedImageData.width?.trim()) {
        prefix += `=${capturedImageData.alt.trim()}]`;
      } else {
        if (capturedImageData.alt.trim()) prefix += ` alt="${capturedImageData.alt.trim()}"`;
        if (capturedImageData.width?.trim()) prefix += ` width="${capturedImageData.width.trim()}"`;
        prefix += ']';
      }
      const replacement = prefix + url + '[/img]';
      const newValue = text.substring(0, start) + replacement + text.substring(end);

      let newHistory = history.slice(0, historyIndex + 1);
      if (newHistory[newHistory.length - 1] !== text) newHistory.push(text);
      newHistory.push(newValue);
      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
      
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      lastHistoryPushTime.current = Date.now();

      isInternalUpdate.current = true;
      onChange({ target: { value: newValue } });

      textarea.focus();
      const newCursorPos = start + replacement.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const handleDiceSubmit = (e) => {
    e.preventDefault();
    const capturedDiceData = { ...diceData };
    setShowDiceModal(false);
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      const { sides, type } = capturedDiceData;
      const replacement = `[dice=${sides}${type === 'master' ? ' type=master' : ''}]`;
      const newValue = text.substring(0, start) + replacement + text.substring(start);

      let newHistory = history.slice(0, historyIndex + 1);
      if (newHistory[newHistory.length - 1] !== text) newHistory.push(text);
      newHistory.push(newValue);
      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
      
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      lastHistoryPushTime.current = Date.now();

      isInternalUpdate.current = true;
      onChange({ target: { value: newValue } });

      textarea.focus();
      const newCursorPos = start + replacement.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const handleHideSubmit = (e) => {
    e.preventDefault();
    const capturedHideData = { ...hideData };
    setShowHideModal(false);
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      const selected = text.substring(start, end);

      const val = capturedHideData.type === 'posts' ? (capturedHideData.threshold || '10') : 'hidden';
      const replacement = `[hide=${val}]${selected}[/hide]`;
      const newValue = text.substring(0, start) + replacement + text.substring(end);

      let newHistory = history.slice(0, historyIndex + 1);
      if (newHistory[newHistory.length - 1] !== text) newHistory.push(text);
      newHistory.push(newValue);
      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
      
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      lastHistoryPushTime.current = Date.now();

      isInternalUpdate.current = true;
      onChange({ target: { value: newValue } });

      textarea.focus();
      const newCursorPos = start + `[hide=${val}]`.length + selected.length + `[/hide]`.length;
      const cursorPos = selected.length > 0 ? newCursorPos : start + `[hide=${val}]`.length;
      textarea.setSelectionRange(cursorPos, cursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const handleColumnsSubmit = () => {
    const { count, stack } = columnsData;
    let before = `[columns${stack ? ` stack=${stack}` : ''}]\n[col]`;
    let after = `[/col]\n`;
    for (let i = 1; i < count; i++) {
        after += `[col][/col]\n`;
    }
    after += `[/columns]`;
    insertText(before, after, 'columns');
    setShowColumnsModal(false);
  };

  const hotkeyGroups = [
    {
      title: lang === 'ru' ? 'Форматирование' : 'Formatting',
      items: [
        { keys: 'Ctrl + B', desc: lang === 'ru' ? 'Жирный' : 'Bold' },
        { keys: 'Ctrl + I', desc: lang === 'ru' ? 'Курсив' : 'Italic' },
        { keys: 'Ctrl + U', desc: lang === 'ru' ? 'Подчёркнутый' : 'Underline' },
        { keys: 'Ctrl + S', desc: lang === 'ru' ? 'Зачёркнутый' : 'Strikethrough' },
      ],
    },
    {
      title: lang === 'ru' ? 'Выравнивание' : 'Alignment',
      items: [
        { keys: 'Ctrl + L', desc: lang === 'ru' ? 'По левому краю' : 'Align Left' },
        { keys: 'Ctrl + E', desc: lang === 'ru' ? 'По центру' : 'Align Center' },
        { keys: 'Ctrl + R', desc: lang === 'ru' ? 'По правому краю' : 'Align Right' },
        { keys: 'Ctrl + J', desc: lang === 'ru' ? 'По ширине' : 'Justify' },
      ],
    },
    {
      title: lang === 'ru' ? 'Вставки' : 'Inserts',
      items: [
        { keys: 'Ctrl + K', desc: lang === 'ru' ? 'Ссылка' : 'Link' },
        { keys: 'Ctrl + G', desc: lang === 'ru' ? 'Спойлер' : 'Spoiler' },
        { keys: 'Ctrl + H', desc: lang === 'ru' ? 'Скрыть' : 'Hide' },
        { keys: 'Ctrl + Q', desc: lang === 'ru' ? 'Цитата' : 'Quote' },
        { keys: 'Ctrl + [', desc: lang === 'ru' ? 'Блок кода' : 'Code Block' },
        { keys: 'Ctrl + ]', desc: lang === 'ru' ? 'HTML-блок' : 'HTML Block' },
      ],
    },
    {
      title: lang === 'ru' ? 'Медиа и структура (Alt)' : 'Media & Structure (Alt)',
      items: [
        { keys: 'Alt + V', desc: lang === 'ru' ? 'Видео' : 'Video' },
        { keys: 'Alt + I', desc: lang === 'ru' ? 'Изображение' : 'Image' },
        { keys: 'Alt + H', desc: lang === 'ru' ? 'Горизонтальная линия' : 'Horizontal Rule' },
        { keys: 'Alt + T', desc: lang === 'ru' ? 'Таблица' : 'Table' },
        { keys: 'Alt + L', desc: lang === 'ru' ? 'Обтекание слева' : 'Floating Left' },
        { keys: 'Alt + R', desc: lang === 'ru' ? 'Обтекание справа' : 'Floating Right' },
      ],
    },
    {
      title: lang === 'ru' ? 'Спец. блоки (Ctrl+Shift)' : 'Special Blocks (Ctrl+Shift)',
      items: [
        { keys: 'Ctrl + Shift + D', desc: lang === 'ru' ? 'Добавлено' : 'Added Block' },
        { keys: 'Ctrl + Shift + A', desc: lang === 'ru' ? 'Информация' : 'Info Block' },
        { keys: 'Ctrl + Shift + M', desc: lang === 'ru' ? 'Маркированный список' : 'Bullet List' },
      ],
    },
    {
      title: lang === 'ru' ? 'Система' : 'System',
      items: [
        { keys: 'Ctrl + Z', desc: lang === 'ru' ? 'Отменить' : 'Undo' },
        { keys: 'Ctrl + Y / Ctrl + Shift + Z', desc: lang === 'ru' ? 'Повторить' : 'Redo' },
        { keys: 'Ctrl + Enter', desc: lang === 'ru' ? 'Отправить' : 'Submit' },
        { keys: 'Shift + Tab', desc: lang === 'ru' ? 'Отступ (4 пробела)' : 'Indent (4 spaces)' },
        { keys: 'Ctrl + /', desc: lang === 'ru' ? 'Показать эту справку' : 'Show this manual' },
      ],
    },
  ];

  const renderGroup = (groupId, isOverflow = false) => {
    switch (groupId) {
      case 'style':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => insertText('[b]', '[/b]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Bold size={16} /> {lang === 'ru' ? 'Жирный' : 'Bold'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[i]', '[/i]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Italic size={16} /> {lang === 'ru' ? 'Курсив' : 'Italic'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[u]', '[/u]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Underline size={16} /> {lang === 'ru' ? 'Подчёркнутый' : 'Underline'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[s]', '[/s]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Strikethrough size={16} /> {lang === 'ru' ? 'Зачёркнутый' : 'Strikethrough'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[sup]', '[/sup]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Superscript size={16} /> {lang === 'ru' ? 'Надстрочный' : 'Superscript'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[sub]', '[/sub]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Subscript size={16} /> {lang === 'ru' ? 'Подстрочный' : 'Subscript'}
            </Dropdown.Item>
            <Dropdown.Divider />
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[b]', '[/b]')} title="Bold (Ctrl+B)"><Bold size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[i]', '[/i]')} title="Italic (Ctrl+I)"><Italic size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[u]', '[/u]')} title="Underline (Ctrl+U)"><Underline size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[s]', '[/s]')} title="Strikethrough (Ctrl+S)"><Strikethrough size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[sup]', '[/sup]')} title="Superscript"><Superscript size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[sub]', '[/sub]')} title="Subscript"><Subscript size={16} /></Button>
          </div>
        );
      case 'history':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={handleUndo} disabled={historyIndex === 0} className="d-flex align-items-center gap-2 py-2 px-3">
              <Undo size={16} /> {lang === 'ru' ? 'Отменить (Ctrl+Z)' : 'Undo (Ctrl+Z)'}
            </Dropdown.Item>
            <Dropdown.Item onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="d-flex align-items-center gap-2 py-2 px-3">
              <Redo size={16} /> {lang === 'ru' ? 'Повторить (Ctrl+Y)' : 'Redo (Ctrl+Y)'}
            </Dropdown.Item>
            <Dropdown.Divider />
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={handleUndo} disabled={historyIndex === 0} title="Undo (Ctrl+Z)"><Undo size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={handleRedo} disabled={historyIndex >= history.length - 1} title="Redo (Ctrl+Y)"><Redo size={16} /></Button>
          </div>
        );
      case 'smiles':
        return isOverflow ? (
          <Dropdown.Item onClick={() => setShowSmilesModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
             <Smile size={16} /> {lang === 'ru' ? 'Смайлики' : 'Smiles'}
          </Dropdown.Item>
        ) : (
          <Dropdown className="d-inline-block" drop={smilesDropDirection}>
            <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title="Smiles"><Smile size={16} /></Dropdown.Toggle>
            <Dropdown.Menu className="smiles-picker-menu p-0 shadow border-0" renderOnMount style={{ width: smilesFullWidth ? `${editorWidth}px` : '320px', zIndex: 3500 }}>
              <SmilesPicker onSelect={(code) => insertText(code, '')} />
            </Dropdown.Menu>
          </Dropdown>
        );
      case 'links':
        return isOverflow ? (
          <Dropdown.Item onClick={() => setShowLinkModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
            <LinkIcon size={16} /> {lang === 'ru' ? 'Ссылка' : 'Link'}
          </Dropdown.Item>
        ) : (
          <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowLinkModal(true)} title="Link (Ctrl+K)"><LinkIcon size={16} /></Button>
        );
      case 'typography':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => insertText('150%', '', 'size')} className="d-flex align-items-center gap-2 py-2 px-3">
              <ALargeSmall size={16} /> {lang === 'ru' ? 'Крупный текст' : 'Large Text'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('#ff0000', '', 'color')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Palette size={16} /> {lang === 'ru' ? 'Цвет текста' : 'Text Color'}
            </Dropdown.Item>
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Dropdown className="d-inline-block">
              <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title="Size"><ALargeSmall size={19} /></Dropdown.Toggle>
              <Dropdown.Menu className="size-picker-menu shadow-sm border-0" style={{ maxHeight: '250px', overflowY: 'auto' }}>
                <Dropdown.Header className="px-3 py-1 font-monospace text-uppercase" style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                  {lang === 'ru' ? 'Проценты' : 'Percent'}
                </Dropdown.Header>
                {[{label:'50%',v:'50%'},{label:'85%',v:'85%'},{label:'100%',v:'100%'},{label:'120%',v:'120%'},{label:'150%',v:'150%'},{label:'200%',v:'200%'}].map(s=>(
                  <Dropdown.Item key={s.v} onClick={()=>insertText(s.v,'','size')} className="small py-1 px-3"><span style={{fontSize:s.v}}>{s.label}</span></Dropdown.Item>
                ))}
                <Dropdown.Divider />
                <Dropdown.Header className="px-3 py-1 font-monospace text-uppercase" style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                  {lang === 'ru' ? 'Пиксели' : 'Pixels'}
                </Dropdown.Header>
                {[{label:'9px',v:'9'},{label:'11px',v:'11'},{label:'12px',v:'12'},{label:'14px',v:'14'},{label:'16px',v:'16'},{label:'18px',v:'18'},{label:'20px',v:'20'},{label:'24px',v:'24'}].map(s=>(
                  <Dropdown.Item key={s.v} onClick={()=>insertText(s.v,'','size')} className="small py-1 px-3"><span style={{fontSize:`${s.v}px`}}>{s.label}</span></Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown>
            <Dropdown className="d-inline-block">
              <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title="Color"><Palette size={16} /></Dropdown.Toggle>
              <Dropdown.Menu className="color-picker-menu p-2 shadow-sm border-0" style={{ minWidth: '160px' }}>
                <div className="d-flex flex-wrap gap-1 justify-content-center">
                  {['#000000','#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ffffff'].map(c=>(
                    <button key={c} type="button" className="color-swatch border rounded-circle" style={{backgroundColor:c,width:20,height:20,cursor:'pointer',padding:0}} onClick={()=>insertText(c,'','color')} />
                  ))}
                </div>
              </Dropdown.Menu>
            </Dropdown>
          </div>
        );
      case 'align':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => insertText('[left]', '[/left]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <AlignLeft size={16} /> {lang === 'ru' ? 'По левому краю' : 'Align Left'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[center]', '[/center]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <AlignCenter size={16} /> {lang === 'ru' ? 'По центру' : 'Align Center'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[right]', '[/right]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <AlignRight size={16} /> {lang === 'ru' ? 'По правому краю' : 'Align Right'}
            </Dropdown.Item>
            <Dropdown.Divider />
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[left]', '[/left]')} title="Left"><AlignLeft size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[center]', '[/center]')} title="Center"><AlignCenter size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[right]', '[/right]')} title="Right"><AlignRight size={16} /></Button>
          </div>
        );
      case 'inserts':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => insertText('', '', 'quote')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Quote size={16} /> {lang === 'ru' ? 'Цитата' : 'Quote'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('', '', 'spoiler')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Clapperboard size={16} /> {lang === 'ru' ? 'Спойлер' : 'Spoiler'}
            </Dropdown.Item>
            <Dropdown.Item onClick={openAbbrModal} className="d-flex align-items-center gap-2 py-2 px-3">
              <HelpCircle size={16} /> {lang === 'ru' ? 'Аббревиатура / Подсказка' : 'Abbreviation / Tooltip'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[html]', '[/html]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Code size={16} /> HTML
            </Dropdown.Item>
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'quote')} title="Quote"><Quote size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'spoiler')} title="Spoiler"><Clapperboard size={15} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={openAbbrModal} title={lang === 'ru' ? 'Аббревиатура / Подсказка' : 'Abbreviation / Tooltip'}><HelpCircle size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[html]', '[/html]')} title="HTML"><Code size={16} /></Button>
          </div>
        );
      case 'media':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => setShowImageModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
              <ImageIcon size={16} /> {lang === 'ru' ? 'Изображение' : 'Image'}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[video]', '[/video]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Youtube size={16} /> {lang === 'ru' ? 'Видео' : 'Video'}
            </Dropdown.Item>
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowImageModal(true)} title="Image"><ImageIcon size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[video]', '[/video]')} title="Video"><Youtube size={16} /></Button>
          </div>
        );
      case 'advanced':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => setShowColumnsModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
              <Columns size={16} /> {lang === 'ru' ? 'Колонки' : 'Columns'}
            </Dropdown.Item>
            {showHide && (
              <Dropdown.Item onClick={() => setShowHideModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
                <EyeOff size={16} /> {lang === 'ru' ? 'Скрыть под хайдом' : 'Hide'}
              </Dropdown.Item>
            )}
            {showDice && !isEdit && (
              <Dropdown.Item onClick={() => setShowDiceModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
                <Dices size={16} /> {lang === 'ru' ? 'Бросить кубик' : 'Roll Dice'}
              </Dropdown.Item>
            )}
            <Dropdown.Item onClick={() => insertText('[hr]', '')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Minus size={16} /> {lang === 'ru' ? 'Разделительная линия' : 'HR'}
            </Dropdown.Item>
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowColumnsModal(true)} title="Columns"><Columns size={16} /></Button>
            {showHide && (
              <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowHideModal(true)} title="Hide"><EyeOff size={16} /></Button>
            )}
            {showDice && !isEdit && (
              <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowDiceModal(true)} title="Roll Dice"><Dices size={16} /></Button>
            )}
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[hr]', '')} title="HR"><Minus size={16} /></Button>
          </div>
        );
      default: return null;
    }
  };

  return (
    <div className="rich-editor-container" ref={containerRef}>
      <div 
        ref={toolbarContainerRef}
        className="d-flex align-items-center gap-1 mb-2 p-2 rounded editor-toolbar-themed editor-toolbar" 
        style={{ minHeight: '46px' }}
      >
        
        {/* Render Visible Groups */}
        {visibleGroupIds.map((groupId, idx) => (
          <React.Fragment key={groupId}>
            {renderGroup(groupId)}
            {idx < visibleGroupIds.length - 1 && <div className="vr mx-1 opacity-25"></div>}
          </React.Fragment>
        ))}

        {/* Render Overflow Menu */}
        {overflowGroupIds.length > 0 && (
          <>
            {visibleGroupIds.length > 0 && <div className="vr mx-1 opacity-25"></div>}
            <Dropdown className="d-inline-block">
              <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title={lang === 'ru' ? 'Дополнительно' : 'More'}>
                <MoreHorizontal size={18} />
              </Dropdown.Toggle>
              <Dropdown.Menu className="shadow-sm border-0 dropdown-menu-end" style={{ borderRadius: '12px', minWidth: '220px' }}>
                {overflowGroupIds.map(groupId => (
                  <React.Fragment key={groupId}>
                    {renderGroup(groupId, true)}
                  </React.Fragment>
                ))}
              </Dropdown.Menu>
            </Dropdown>
          </>
        )}

        {/* Far Right: Manual */}
        {!hideHotkeysButton && (
          <div className="ms-auto flex-shrink-0">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowHotkeysModal(true)} title={lang === 'ru' ? 'Горячие клавиши (Ctrl+/)' : 'Hotkeys (Ctrl+/)'}>
              <Keyboard size={18} />
            </Button>
          </div>
        )}
      </div>

      <Form.Control
        ref={textareaRef}
        id={id}
        as="textarea"
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={handleTextChange}
        onKeyDown={handleKeyDown}
        maxLength={maxLength}
        autoFocus={autoFocus}
        className="form-control"
        style={minHeight ? { minHeight } : {}}
      />

      <div className="d-flex justify-content-between mt-2 px-1">
        <Form.Text className="text-muted small">
          {lang === 'ru' ? 'Поддерживается BBCode' : 'BBCode is supported'}.
        </Form.Text>
        <Form.Text className={`${maxLength && value?.length >= maxLength ? 'text-danger' : 'text-muted'} fw-bold small`}>
          {maxLength > 0
            ? `${value?.length || 0} / ${maxLength}`
            : `${lang === 'ru' ? 'Символов: ' : 'Chars: '}${value?.length || 0}`
          }
        </Form.Text>
      </div>

      <ForumModal
        show={showLinkModal}
        onHide={() => closeModalWithFocus(setShowLinkModal)}
        title={lang === 'ru' ? 'Вставить ссылку' : 'Insert Link'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowLinkModal)}>
              {lang === 'ru' ? 'Отмена' : 'Cancel'}
            </Button>
            <Button variant="primary" onClick={handleLinkSubmit}>
              {lang === 'ru' ? 'Вставить' : 'Insert'}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{lang === 'ru' ? 'Текст ссылки' : 'Link Text'}</Form.Label>
          <Form.Control
            type="text"
            value={linkData.text}
            onChange={e => setLinkData({ ...linkData, text: e.target.value })}
            placeholder={lang === 'ru' ? 'Текст...' : 'Text...'}
          />
        </Form.Group>
        <Form.Group>
          <Form.Label>URL</Form.Label>
          <Form.Control
            type="url"
            value={linkData.url}
            onChange={e => setLinkData({ ...linkData, url: e.target.value })}
            required
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleLinkSubmit(e); } }}
          />
        </Form.Group>
      </ForumModal>

      <ForumModal
        show={showAbbrModal}
        onHide={() => closeModalWithFocus(setShowAbbrModal)}
        title={lang === 'ru' ? 'Вставить аббревиатуру / подсказку' : 'Insert Abbreviation / Tooltip'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowAbbrModal)}>
              {lang === 'ru' ? 'Отмена' : 'Cancel'}
            </Button>
            <Button variant="primary" onClick={handleAbbrSubmit}>
              {lang === 'ru' ? 'Вставить' : 'Insert'}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{lang === 'ru' ? 'Текст' : 'Text'}</Form.Label>
          <Form.Control
            type="text"
            value={abbrData.text}
            onChange={e => setAbbrData({ ...abbrData, text: e.target.value })}
            placeholder={lang === 'ru' ? 'Слово или текст...' : 'Word or text...'}
            autoFocus
          />
        </Form.Group>
        <Form.Group>
          <Form.Label>{lang === 'ru' ? 'Описание / Подсказка' : 'Description / Tooltip'}</Form.Label>
          <Form.Control
            type="text"
            value={abbrData.title}
            onChange={e => setAbbrData({ ...abbrData, title: e.target.value })}
            placeholder={lang === 'ru' ? 'Значение или описание...' : 'Definition or explanation...'}
            required
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAbbrSubmit(e); } }}
          />
        </Form.Group>
      </ForumModal>

      <ForumModal
        show={showImageModal}
        onHide={() => closeModalWithFocus(setShowImageModal)}
        title={lang === 'ru' ? 'Вставить изображение' : 'Insert Image'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowImageModal)}>
              {lang === 'ru' ? 'Отмена' : 'Cancel'}
            </Button>
            <Button variant="primary" onClick={handleImageSubmit}>
              {lang === 'ru' ? 'Вставить' : 'Insert'}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{lang === 'ru' ? 'Описание (alt)' : 'Description (alt)'}</Form.Label>
          <Form.Control
            type="text"
            value={imageData.alt}
            onChange={e => setImageData({ ...imageData, alt: e.target.value })}
            placeholder={lang === 'ru' ? 'Описание...' : 'Description...'}
          />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>{lang === 'ru' ? 'Ширина (px или %)' : 'Width (px or %)'}</Form.Label>
          <Form.Control
            type="text"
            value={imageData.width || ''}
            onChange={e => setImageData({ ...imageData, width: e.target.value })}
            placeholder={lang === 'ru' ? 'Например: 100px или 50%' : 'e.g. 100px or 50%'}
          />
        </Form.Group>
        <Form.Group>
          <Form.Label>{lang === 'ru' ? 'Ссылка на изображение' : 'Image URL'}</Form.Label>
          <Form.Control
            type="url"
            value={imageData.url}
            onChange={e => setImageData({ ...imageData, url: e.target.value })}
            required
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleImageSubmit(e); } }}
          />
        </Form.Group>
      </ForumModal>

      <ForumModal
        show={showDiceModal}
        onHide={() => closeModalWithFocus(setShowDiceModal)}
        title={lang === 'ru' ? 'Бросить кубик' : 'Roll Dice'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowDiceModal)}>
              {lang === 'ru' ? 'Отмена' : 'Cancel'}
            </Button>
            <Button variant="primary" onClick={handleDiceSubmit}>
              {lang === 'ru' ? 'Бросить' : 'Roll'}
            </Button>
          </>
        }
      >
        <div className="alert alert-info py-2" style={{ fontSize: '0.875rem' }}>
          {lang === 'ru'
            ? 'Кубики нельзя менять после публикации. Для нового броска нужно создать новый пост.'
            : 'Dice rolls cannot be changed after publication. To roll again, create a new post.'}
        </div>

        <Form.Group className="mb-3">
          <Form.Label>{lang === 'ru' ? 'Выберите кубик' : 'Select dice'}</Form.Label>
          <Form.Select
            value={diceData.sides}
            onChange={e => setDiceData({ ...diceData, sides: parseInt(e.target.value) })}
            className="form-select-themed"
          >
            <option value="4">d4</option>
            <option value="6">d6</option>
            <option value="8">d8</option>
            <option value="10">d10</option>
            <option value="12">d12</option>
            <option value="20">d20</option>
            <option value="100">d100</option>
          </Form.Select>
          <Form.Text className="text-muted small mt-1 d-block">
            {lang === 'ru'
              ? 'Выберите тип кубика для броска. Результат будет сгенерирован при публикации.'
              : 'Choose the dice type for your roll. The result will be generated upon publication.'}
          </Form.Text>
        </Form.Group>

        {!hideDiceType && (
          <Form.Group className="mb-3">
            <Form.Label>{lang === 'ru' ? 'Тип броска' : 'Roll type'}</Form.Label>
            <Form.Select
              value={diceData.type}
              onChange={e => setDiceData({ ...diceData, type: e.target.value })}
              className="form-select-themed"
            >
              <option value="normal">{lang === 'ru' ? 'Обычный (видят все)' : 'Normal (visible to all)'}</option>
              <option value="master">{lang === 'ru' ? 'Мастерский (только GM)' : 'Master (GM only)'}</option>
            </Form.Select>
          </Form.Group>
        )}
      </ForumModal>

      <ForumModal
        show={showHideModal}
        onHide={() => closeModalWithFocus(setShowHideModal)}
        title={t('editor.hide_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowHideModal)}>
              {lang === 'ru' ? 'Отмена' : 'Cancel'}
            </Button>
            <Button variant="primary" onClick={handleHideSubmit}>
              {t('editor.hide_insert')}
            </Button>
          </>
        }
      >
        <Form onSubmit={handleHideSubmit}>
          <div className="mb-3 p-3 rounded" style={{ backgroundColor: 'rgba(var(--primary-rgb, 13, 110, 253), 0.05)', border: '1px solid var(--border-color)' }}>
            <Form.Check
              type="radio"
              id="hide-type-posts"
              label={t('editor.hide_threshold')}
              name="hideType"
              checked={hideData.type === 'posts'}
              onChange={() => setHideData(prev => ({ ...prev, type: 'posts' }))}
              className="fw-bold mb-2 cursor-pointer"
            />
            {hideData.type === 'posts' && (
              <div className="ms-4">
                <Form.Control
                  type="number"
                  value={hideData.threshold}
                  onChange={(e) => setHideData(prev => ({ ...prev, threshold: e.target.value }))}
                  min="1"
                  placeholder="10"
                  className="modal-section-themed"
                  style={{ width: '120px' }}
                  autoFocus
                />
              </div>
            )}

            <Form.Check
              type="radio"
              id="hide-type-hidden"
              label={t('editor.hide_hidden')}
              name="hideType"
              checked={hideData.type === 'hidden'}
              onChange={() => setHideData(prev => ({ ...prev, type: 'hidden' }))}
              className="fw-bold mt-3 cursor-pointer"
            />
          </div>
          <p className="small text-muted mb-0">
            {lang === 'ru'
              ? 'Текст внутри тега будет скрыт от пользователей, не соответствующих условиям.'
              : 'Text inside the tag will be hidden from users who do not meet the requirements.'}
          </p>
        </Form>
      </ForumModal>

      <ForumModal
        show={showColumnsModal}
        onHide={() => closeModalWithFocus(setShowColumnsModal)}
        title={lang === 'ru' ? 'Настройка колонок' : 'Columns Setup'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowColumnsModal)}>
              {lang === 'ru' ? 'Отмена' : 'Cancel'}
            </Button>
            <Button variant="primary" onClick={handleColumnsSubmit}>
              {lang === 'ru' ? 'Применить' : 'Apply'}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{lang === 'ru' ? 'Количество колонок' : 'Number of Columns'}</Form.Label>
          <Form.Select
            value={columnsData.count}
            onChange={(e) => setColumnsData({ ...columnsData, count: parseInt(e.target.value) })}
          >
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </Form.Select>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>{lang === 'ru' ? 'Адаптивность (Stack)' : 'Adaptability (Stack)'}</Form.Label>
          <Form.Select
            value={columnsData.stack}
            onChange={(e) => setColumnsData({ ...columnsData, stack: e.target.value })}
          >
            <option value="0">{lang === 'ru' ? 'Никогда не переносить (в ряд)' : 'Never stack (always row)'}</option>
            <option value="576">{lang === 'ru' ? 'Мобильный (576px)' : 'Mobile (576px)'}</option>
            <option value="768">{lang === 'ru' ? 'Планшет (768px)' : 'Tablet (768px)'}</option>
            <option value="992">{lang === 'ru' ? 'Десктоп (992px)' : 'Desktop (992px)'}</option>
            <option value="9999">{lang === 'ru' ? 'Всегда переносить (в колонку)' : 'Always stack (column)'}</option>
          </Form.Select>
          <Form.Text className="text-muted small mt-1 d-block">
            {lang === 'ru'
              ? 'Параметр Stack определяет ширину экрана, при которой колонки выстраиваются вертикально друг под другом. 768px — стандарт для планшетов.'
              : 'Stack parameter defines the screen width at which columns will collapse into a vertical list. 768px is recommended for most cases.'}
          </Form.Text>
        </Form.Group>
      </ForumModal>

      {/* Hotkeys Manual Modal */}
      <ForumModal
        show={showHotkeysModal}
        onHide={() => closeModalWithFocus(setShowHotkeysModal)}
        title={lang === 'ru' ? 'Горячие клавиши' : 'Keyboard Shortcuts'}
        footer={
          <Button variant="primary" onClick={() => closeModalWithFocus(setShowHotkeysModal)}>
            {lang === 'ru' ? 'Закрыть' : 'Close'}
          </Button>
        }
      >
        <p className="small text-muted mb-3">
          {lang === 'ru'
            ? 'Полный список сочетаний клавиш, доступных в редакторе. Нажмите Ctrl + / в любой момент, чтобы открыть эту справку.'
            : 'Full list of keyboard shortcuts available in the editor. Press Ctrl + / at any time to reopen this manual.'}
        </p>

        {hotkeyGroups.map((group) => (
          <div key={group.title} className="mb-3">
            <h6 className="fw-bold mb-2">{group.title}</h6>
            <Table size="sm" borderless className="mb-0 hotkeys-table">
              <tbody>
                {group.items.map((item) => (
                  <tr key={item.keys}>
                    <td style={{ width: '45%', whiteSpace: 'nowrap' }}>
                      <kbd className="px-2 py-1" style={{ fontSize: '0.8rem' }}>{item.keys}</kbd>
                    </td>
                    <td className="small align-middle">{item.desc}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ))}
      </ForumModal>

      {/* Smiles Modal (for overflow mode) */}
      <ForumModal
        show={showSmilesModal}
        onHide={() => setShowSmilesModal(false)}
        title={lang === 'ru' ? 'Выбор смайлика' : 'Select a smile'}
        size="md"
      >
        <div style={{ minHeight: '300px' }}>
          <SmilesPicker onSelect={(code) => {
            insertText(code, '');
            setShowSmilesModal(false);
          }} />
        </div>
      </ForumModal>
    </div>
  );
});

export default RichEditor;
