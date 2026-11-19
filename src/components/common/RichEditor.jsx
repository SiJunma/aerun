import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Button, Form, Dropdown, Table } from 'react-bootstrap';
import ForumModal from './ForumModal';
import {
  Bold, Italic, Underline, Strikethrough, Link as LinkIcon, Image as ImageIcon,
  Quote, Undo, Redo, Palette, ALargeSmall, Columns, Dices, Clapperboard,
  Youtube, EyeOff, Minus, Smile, AlignLeft, AlignCenter, AlignRight,
  AlignJustify, Keyboard, MoreHorizontal, Superscript, Subscript, HelpCircle, Code, CodeXml, Table as TableIcon
} from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import SmilesPicker from './SmilesPicker';
import { sendApi } from '../../api/pocketbase';
import { resolveAvatarUrl } from '../../api/avatars';

const RichEditor = forwardRef(({
  value, onChange, placeholder, rows = 6, minHeight, maxHeight, id = 'rich-editor',
  maxLength, autoFocus, showDice = false, isEdit = false, hideDiceType = false,
  showHide = true, smilesDropDirection = "up", smilesFullWidth = true, onSubmit,
  hideHotkeysButton = false, hideFooter = false, autoResize = false
}, ref) => {
  const { t } = useI18n();

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
  const [hideData, setHideData] = useState({ threshold: '10', type: 'posts', uid: '', username: '' });
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [showColumnsModal, setShowColumnsModal] = useState(false);
  const [columnsData, setColumnsData] = useState({ count: 2, stack: '768' });
  const [showTableModal, setShowTableModal] = useState(false);
  const [tableData, setTableData] = useState({ rows: 3, cols: 2, layout: 'auto', width: '100%', border: '', noBorders: false });
  const [showHotkeysModal, setShowHotkeysModal] = useState(false);
  const [showSmilesModal, setShowSmilesModal] = useState(false);
  const [showAbbrModal, setShowAbbrModal] = useState(false);
  const [abbrData, setAbbrData] = useState({ text: '', title: '' });
  const [showMoreToolsModal, setShowMoreToolsModal] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 992);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 992);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useImperativeHandle(ref, () => ({
    openHotkeysModal: () => setShowHotkeysModal(true),
    focus: () => textareaRef.current?.focus()
  }));

  const adjustTextareaHeight = useCallback(() => {
    if (!autoResize || !textareaRef.current) return;
    const el = textareaRef.current;
    el.style.height = 'auto';
    const maxHeightPx = typeof maxHeight === 'number'
      ? maxHeight
      : (typeof maxHeight === 'string' && maxHeight.endsWith('px')
          ? parseInt(maxHeight, 10)
          : window.innerHeight * 0.3);
    const scrollH = el.scrollHeight;
    if (scrollH > maxHeightPx) {
      el.style.height = `${maxHeightPx}px`;
      el.style.overflowY = 'auto';
    } else {
      el.style.height = `${Math.max(scrollH, 38)}px`;
      el.style.overflowY = 'hidden';
    }
  }, [autoResize, maxHeight]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [value, adjustTextareaHeight]);

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
      const defaultTitle = t('editor.spoiler_default');
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
        } else {
          replacement = before + (selected || '') + after;
        }
      } else {
        replacement = before + (selected || '') + after;
      }
    } else if (type === 'size') {
      replacement = `[size=${before}]${selected || t('editor.size_placeholder')}[/size]`;
    } else if (type === 'color') {
      replacement = `[color=${before}]${selected || t('editor.color_placeholder')}[/color]`;
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
          cursorStart = preText.length + (replacement.includes('\n[list]') ? 1 : 0) + '[list]\n[*] '.length;
          cursorEnd = cursorStart;
        } else if (type === 'quote') {
          cursorStart = preText.length + (replacement.startsWith('\n') ? 1 : 0) + '[quote]'.length;
          cursorEnd = cursorStart;
        } else if (type === 'spoiler') {
          const defaultTitle = t('editor.spoiler_default');
          cursorStart = preText.length + (replacement.startsWith('\n') ? 1 : 0) + `[spoiler="${defaultTitle}"]`.length;
          cursorEnd = cursorStart;
        } else if (before && after) {
          cursorStart = preText.length + (replacement.startsWith('\n') ? 1 : 0) + before.length;
          cursorEnd = cursorStart;
        } else {
          cursorStart = preText.length + replacement.length;
          cursorEnd = cursorStart;
        }
      } else {
        cursorStart = preText.length + replacement.length;
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
      { id: 'inserts', priority: 7, width: 205 },
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
    if (isCtrl && (e.code === 'Slash' || e.key === '/' || e.key === '?')) {
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
        case 'KeyL': e.preventDefault(); insertText('[align=left]', '[/align]'); break;
        case 'KeyR': e.preventDefault(); insertText('[align=right]', '[/align]'); break;
        case 'KeyE': e.preventDefault(); insertText('[align=center]', '[/align]'); break;
        case 'KeyJ': e.preventDefault(); insertText('[align=justify]', '[/align]'); break;
        case 'KeyK': e.preventDefault(); openLinkModal(); break;
        case 'KeyG': e.preventDefault(); insertText('', '', 'spoiler'); break;
        case 'KeyH': e.preventDefault(); openHideModal(); break;
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

  const [savedLinkSelection, setSavedLinkSelection] = useState({ start: 0, end: 0, text: '' });

  const openLinkModal = () => {
    const textarea = textareaRef.current;
    const start = textarea ? textarea.selectionStart : 0;
    const end = textarea ? textarea.selectionEnd : 0;
    const selected = textarea ? textarea.value.substring(start, end) : '';
    setSavedLinkSelection({ start, end, text: selected });
    setLinkData({ text: selected, url: 'https://' });
    setShowLinkModal(true);
  };

  const handleLinkSubmit = (e) => {
    e.preventDefault();
    const capturedLinkData = { ...linkData };
    const { start, end, text: selected } = savedLinkSelection;
    setShowLinkModal(false);
    setLinkData({ text: '', url: 'https://' });
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      let { url, text: linkText } = capturedLinkData;
      if (!url || !url.trim()) return;
      url = url.trim();
      
      const displayContent = linkText?.trim() || selected || url;
      const replacement = `[url=${url}]${displayContent}[/url]`;
      const safeStart = Math.min(start, text.length);
      const safeEnd = Math.min(end, text.length);
      const newValue = text.substring(0, safeStart) + replacement + text.substring(safeEnd);

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
      const newCursorPos = safeStart + replacement.length;
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
    // Guard: addressed mode requires a selected user
    if (capturedHideData.type === 'user' && !capturedHideData.uid) return;
    setShowHideModal(false);
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      const selected = text.substring(start, end);

      let val = 'hidden';
      let extraParams = '';
      if (capturedHideData.type === 'posts') val = capturedHideData.threshold || '10';
      else if (capturedHideData.type === 'user' && capturedHideData.uid) {
        val = `@${capturedHideData.uid}`;
        if (capturedHideData.username) extraParams = ` nick="${capturedHideData.username}"`;
      }

      const prefix = `[hide=${val}${extraParams}]`;
      const suffix = `[/hide]`;
      const replacement = `${prefix}${selected}${suffix}`;
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
      const newCursorPos = start + prefix.length + selected.length + suffix.length;
      const cursorPos = selected.length > 0 ? newCursorPos : start + prefix.length;
      textarea.setSelectionRange(cursorPos, cursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const openHideModal = () => {
    setHideData({ threshold: '10', type: 'posts', uid: '', username: '' });
    setUserSearchResults([]);
    setShowHideModal(true);
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

  const openTableModal = () => {
    setTableData({ rows: 3, cols: 2, layout: 'auto', width: '100%', border: '', noBorders: false });
    setShowTableModal(true);
  };

  const handleTableSubmit = () => {
    const { rows, cols, layout, width, border, noBorders } = tableData;
    let before = `[table${layout ? ` layout=${layout}` : ''}${width ? ` width=${width}` : ''}${noBorders ? ' border=0' : border ? ` border=${border}` : ''}]\n`;
    for (let r = 0; r < rows; r++) {
      before += `[tr]`;
      for (let c = 0; c < cols; c++) {
        before += `[td][/td]`;
      }
      before += `[/tr]\n`;
    }
    before += `[/table]`;
    insertText(before, '', 'table');
    setShowTableModal(false);
  };

  // The mention picker.
//
// THIS USED TO BE `pb.collection('users').getList(1, 5, { filter: nickname ~ … })`
// — one whole auth record per SUGGESTION, per KEYSTROKE. Typing four letters in a
// reply box handed the typist five strangers' private `settings`. The rows are
// now a three-column list from GET /api/aerun/users/search: id for the uid the
// editor stores, nickname for the label, avatar for the chip.
//
// The two-character floor is duplicated on the server so the cap cannot be
// sidestepped by calling the route directly.
const handleUserSearch = async (queryText) => {
    setHideData(prev => ({ ...prev, username: queryText, uid: '' })); // clear uid when typing
    if (!queryText || queryText.length < 2) {
      setUserSearchResults([]);
      return;
    }
    setIsSearchingUsers(true);
    try {
      const res = await sendApi(`/api/aerun/users/search?q=${encodeURIComponent(queryText)}`);
      setUserSearchResults(res?.items || []);
    } catch (err) {
      console.error(err);
      setUserSearchResults([]);
    }
    setIsSearchingUsers(false);
  };

  const selectUser = (user) => {
    setHideData(prev => ({ ...prev, username: user.nickname, uid: user.id }));
    setUserSearchResults([]);
  };

  const hotkeyGroups = [
    {
      title: t('editor.formatting'),
      items: [
        { keys: 'Ctrl + B', desc: t('editor.bold') },
        { keys: 'Ctrl + I', desc: t('editor.italic') },
        { keys: 'Ctrl + U', desc: t('editor.underline') },
        { keys: 'Ctrl + S', desc: t('editor.strikethrough') },
      ],
    },
    {
      title: t('editor.alignment'),
      items: [
        { keys: 'Ctrl + L', desc: t('editor.align_left') },
        { keys: 'Ctrl + E', desc: t('editor.align_center') },
        { keys: 'Ctrl + R', desc: t('editor.align_right') },
        { keys: 'Ctrl + J', desc: t('editor.justify') },
      ],
    },
    {
      title: t('editor.inserts'),
      items: [
        { keys: 'Ctrl + K', desc: t('editor.link') },
        { keys: 'Ctrl + G', desc: t('editor.spoiler') },
        { keys: 'Ctrl + H', desc: t('editor.hide') },
        { keys: 'Ctrl + Q', desc: t('editor.quote') },
        { keys: 'Ctrl + [', desc: t('editor.code_block') },
        { keys: 'Ctrl + ]', desc: t('editor.html_block') },
      ],
    },
    {
      title: t('editor.media_structure'),
      items: [
        { keys: 'Alt + V', desc: t('editor.video') },
        { keys: 'Alt + I', desc: t('editor.image') },
        { keys: 'Alt + H', desc: t('editor.horizontal_rule') },
        { keys: 'Alt + T', desc: t('editor.table') },
        { keys: 'Alt + L', desc: t('editor.float_left') },
        { keys: 'Alt + R', desc: t('editor.float_right') },
      ],
    },
    {
      title: t('editor.special_blocks'),
      items: [
        { keys: 'Ctrl + Shift + D', desc: t('editor.added_block') },
        { keys: 'Ctrl + Shift + A', desc: t('editor.info_block') },
        { keys: 'Ctrl + Shift + M', desc: t('editor.bullet_list') },
      ],
    },
    {
      title: t('editor.system'),
      items: [
        { keys: 'Ctrl + Z', desc: t('editor.undo') },
        { keys: 'Ctrl + Y / Ctrl + Shift + Z', desc: t('editor.redo') },
        { keys: 'Ctrl + Enter', desc: t('editor.submit') },
        { keys: 'Shift + Tab', desc: t('editor.indent') },
        { keys: 'Ctrl + /', desc: t('editor.show_manual') },
      ],
    },
  ];

  const renderGroup = (groupId, isOverflow = false) => {
    switch (groupId) {
      case 'style':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => insertText('[b]', '[/b]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Bold size={16} /> {t('editor.bold')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[i]', '[/i]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Italic size={16} /> {t('editor.italic')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[u]', '[/u]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Underline size={16} /> {t('editor.underline')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[s]', '[/s]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Strikethrough size={16} /> {t('editor.strikethrough')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[sup]', '[/sup]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Superscript size={16} /> {t('editor.superscript')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[sub]', '[/sub]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Subscript size={16} /> {t('editor.subscript')}
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
              <Undo size={16} /> {t('editor.undo_shortcut')}
            </Dropdown.Item>
            <Dropdown.Item onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="d-flex align-items-center gap-2 py-2 px-3">
              <Redo size={16} /> {t('editor.redo_shortcut')}
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
             <Smile size={16} /> {t('editor.smiles')}
          </Dropdown.Item>
        ) : (
          <Dropdown className="d-inline-block" drop={smilesDropDirection}>
            <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title="Smiles"><Smile size={16} /></Dropdown.Toggle>
            <Dropdown.Menu className="smiles-picker-menu p-0 shadow border-0" style={{ width: smilesFullWidth ? `${editorWidth}px` : '320px', zIndex: 3500 }}>
              <SmilesPicker onSelect={(code) => insertText(code, '')} />
            </Dropdown.Menu>
          </Dropdown>
        );
      case 'links':
        return isOverflow ? (
          <Dropdown.Item onClick={openLinkModal} className="d-flex align-items-center gap-2 py-2 px-3">
            <LinkIcon size={16} /> {t('editor.link')}
          </Dropdown.Item>
        ) : (
          <Button variant="light" size="sm" className="p-1 px-2" onClick={openLinkModal} title="Link (Ctrl+K)"><LinkIcon size={16} /></Button>
        );
      case 'typography':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => insertText('150%', '', 'size')} className="d-flex align-items-center gap-2 py-2 px-3">
              <ALargeSmall size={16} /> {t('editor.large_text')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('#ff0000', '', 'color')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Palette size={16} /> {t('editor.text_color')}
            </Dropdown.Item>
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Dropdown className="d-inline-block">
              <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title="Size"><ALargeSmall size={19} /></Dropdown.Toggle>
              <Dropdown.Menu className="size-picker-menu shadow-sm border-0" style={{ maxHeight: '250px', overflowY: 'auto' }}>
                <Dropdown.Header className="px-3 py-1 font-monospace text-uppercase" style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                  {t('editor.smiles_percent')}
                </Dropdown.Header>
                {[{label:'50%',v:'50%'},{label:'85%',v:'85%'},{label:'100%',v:'100%'},{label:'120%',v:'120%'},{label:'150%',v:'150%'},{label:'200%',v:'200%'}].map(s=>(
                  <Dropdown.Item key={s.v} onClick={()=>insertText(s.v,'','size')} className="small py-1 px-3"><span style={{fontSize:s.v}}>{s.label}</span></Dropdown.Item>
                ))}
                <Dropdown.Divider />
                <Dropdown.Header className="px-3 py-1 font-monospace text-uppercase" style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                  {t('editor.smiles_pixels')}
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
            <Dropdown.Item onClick={() => insertText('[align=left]', '[/align]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <AlignLeft size={16} /> {t('editor.align_left')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[align=center]', '[/align]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <AlignCenter size={16} /> {t('editor.align_center')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[align=right]', '[/align]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <AlignRight size={16} /> {t('editor.align_right')}
            </Dropdown.Item>
            <Dropdown.Divider />
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[align=left]', '[/align]')} title="Left"><AlignLeft size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[align=center]', '[/align]')} title="Center"><AlignCenter size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[align=right]', '[/align]')} title="Right"><AlignRight size={16} /></Button>
          </div>
        );
      case 'inserts':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => insertText('', '', 'quote')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Quote size={16} /> {t('editor.quote')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('', '', 'spoiler')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Clapperboard size={16} /> {t('editor.spoiler')}
            </Dropdown.Item>
            <Dropdown.Item onClick={openAbbrModal} className="d-flex align-items-center gap-2 py-2 px-3">
              {t('editor.abbreviation')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[code]', '[/code]', 'code')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Code size={16} /> {t('editor.code_block')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[html]', '[/html]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <CodeXml size={16} /> HTML
            </Dropdown.Item>
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'quote')} title="Quote"><Quote size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'spoiler')} title="Spoiler"><Clapperboard size={15} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={openAbbrModal} title={t('editor.abbreviation')}><HelpCircle size={16} /></Button>
            <Button
              variant="light"
              size="sm"
              className="p-1 px-2"
              onClick={() => insertText('[code]', '[/code]', 'code')}
              title={t('editor.code_block')}
            >
              <Code size={16} />
            </Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[html]', '[/html]')} title="HTML"><CodeXml size={16} /></Button>
          </div>
        );
      case 'media':
        return isOverflow ? (
          <>
            <Dropdown.Item onClick={() => setShowImageModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
              <ImageIcon size={16} /> {t('editor.image')}
            </Dropdown.Item>
            <Dropdown.Item onClick={() => insertText('[video]', '[/video]')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Youtube size={16} /> {t('editor.video')}
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
              <Columns size={16} /> {t('editor.columns')}
            </Dropdown.Item>
            <Dropdown.Item onClick={openTableModal} className="d-flex align-items-center gap-2 py-2 px-3">
              <TableIcon size={16} /> {t('editor.table')}
            </Dropdown.Item>
            {showHide && (
              <Dropdown.Item onClick={openHideModal} className="d-flex align-items-center gap-2 py-2 px-3">
                <EyeOff size={16} /> {t('editor.hide')}
              </Dropdown.Item>
            )}
            {showDice && !isEdit && (
              <Dropdown.Item onClick={() => setShowDiceModal(true)} className="d-flex align-items-center gap-2 py-2 px-3">
                <Dices size={16} /> {t('editor.dice_roll_btn')}
              </Dropdown.Item>
            )}
            <Dropdown.Item onClick={() => insertText('[hr]', '')} className="d-flex align-items-center gap-2 py-2 px-3">
              <Minus size={16} /> {t('editor.hr')}
            </Dropdown.Item>
          </>
        ) : (
          <div className="d-flex align-items-center gap-1">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowColumnsModal(true)} title={t('editor.columns')}><Columns size={16} /></Button>
            <Button variant="light" size="sm" className="p-1 px-2" onClick={openTableModal} title={t('editor.table')}> <TableIcon size={16} /></Button>
            {showHide && (
              <Button variant="light" size="sm" className="p-1 px-2" onClick={openHideModal} title={t('editor.hide')}><EyeOff size={16} /></Button>
            )}
            {showDice && !isEdit && (
              <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowDiceModal(true)} title={t('editor.roll_dice')}><Dices size={16} /></Button>
            )}
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[hr]', '')} title={t('editor.hr')}><Minus size={16} /></Button>
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
            {isMobile ? (
              <Button
                variant="light"
                size="sm"
                className="p-1 px-2 editor-more-tools-btn"
                onClick={() => setShowMoreToolsModal(true)}
                title={t('editor.additional_formatting_title')}
              >
                <MoreHorizontal size={18} />
              </Button>
            ) : (
              <Dropdown className="d-inline-block">
                <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title={t('editor.additional_formatting_title')}>
                  <MoreHorizontal size={18} />
                </Dropdown.Toggle>
                <Dropdown.Menu
                  className="shadow-sm border-0 dropdown-menu-end editor-overflow-dropdown-menu"
                  style={{
                    borderRadius: '12px',
                    minWidth: '220px',
                    maxHeight: '260px',
                    overflowY: 'auto'
                  }}
                >
                  {overflowGroupIds.map(groupId => (
                    <React.Fragment key={groupId}>
                      {renderGroup(groupId, true)}
                    </React.Fragment>
                  ))}
                </Dropdown.Menu>
              </Dropdown>
            )}
          </>
        )}

        {/* Far Right: Manual */}
        {!hideHotkeysButton && (
          <div className="ms-auto flex-shrink-0">
            <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowHotkeysModal(true)} title={t('editor.hotkeys')}>
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
        onInput={adjustTextareaHeight}
        maxLength={maxLength}
        autoFocus={autoFocus}
        className="form-control"
        style={minHeight ? { minHeight } : {}}
      />

      {!hideFooter && (
        <div className="d-flex justify-content-between mt-2 px-1">
          <Form.Text className="text-muted small">
            {t('forum.bbcode_supported')}
          </Form.Text>
          <Form.Text className={`${maxLength && value?.length >= maxLength ? 'text-danger' : 'text-muted'} fw-bold small`}>
            {maxLength > 0
              ? `${value?.length || 0} / ${maxLength}`
              : `${t('forum.chars')} ${value?.length || 0}`
            }
          </Form.Text>
        </div>
      )}

      <ForumModal
        show={showLinkModal}
        onHide={() => closeModalWithFocus(setShowLinkModal)}
        title={t('editor.link_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowLinkModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleLinkSubmit}>
              {t('editor.link_insert')}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{t('editor.link_text_label')}</Form.Label>
          <Form.Control
            type="text"
            value={linkData.text}
            onChange={e => setLinkData({ ...linkData, text: e.target.value })}
            placeholder={t('editor.link_text_placeholder')}
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
        title={t('editor.abbr_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowAbbrModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleAbbrSubmit}>
              {t('editor.link_insert')}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{t('editor.abbr_text_label')}</Form.Label>
          <Form.Control
            type="text"
            value={abbrData.text}
            onChange={e => setAbbrData({ ...abbrData, text: e.target.value })}
            placeholder={t('editor.abbr_text_placeholder')}
            autoFocus
          />
        </Form.Group>
        <Form.Group>
          <Form.Label>{t('editor.abbr_title_label')}</Form.Label>
          <Form.Control
            type="text"
            value={abbrData.title}
            onChange={e => setAbbrData({ ...abbrData, title: e.target.value })}
            placeholder={t('editor.abbr_title_placeholder')}
            required
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAbbrSubmit(e); } }}
          />
        </Form.Group>
      </ForumModal>

      <ForumModal
        show={showImageModal}
        onHide={() => closeModalWithFocus(setShowImageModal)}
        title={t('editor.image_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowImageModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleImageSubmit}>
              {t('editor.link_insert')}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{t('editor.image_alt_label')}</Form.Label>
          <Form.Control
            type="text"
            value={imageData.alt}
            onChange={e => setImageData({ ...imageData, alt: e.target.value })}
            placeholder={t('editor.image_alt_placeholder')}
          />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>{t('editor.image_width_label')}</Form.Label>
          <Form.Control
            type="text"
            value={imageData.width || ''}
            onChange={e => setImageData({ ...imageData, width: e.target.value })}
            placeholder={t('editor.image_width_placeholder')}
          />
        </Form.Group>
        <Form.Group>
          <Form.Label>{t('editor.image_url_label')}</Form.Label>
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
        title={t('editor.dice_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowDiceModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleDiceSubmit}>
              {t('editor.dice_roll')}
            </Button>
          </>
        }
      >
        <div className="alert alert-info py-2" style={{ fontSize: '0.875rem' }}>
          {t('editor.dice_immutable')}
        </div>

        <Form.Group className="mb-3">
          <Form.Label>{t('editor.dice_select_label')}</Form.Label>
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
            {t('editor.dice_type_hint')}
          </Form.Text>
        </Form.Group>

        {!hideDiceType && (
          <Form.Group className="mb-3">
            <Form.Label>{t('editor.dice_type_label')}</Form.Label>
            <Form.Select
              value={diceData.type}
              onChange={e => setDiceData({ ...diceData, type: e.target.value })}
              className="form-select-themed"
            >
              <option value="normal">{t('editor.dice_normal')}</option>
              <option value="master">{t('editor.dice_master')}</option>
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
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleHideSubmit}>
              {t('editor.hide_insert')}
            </Button>
          </>
        }
      >
        <Form onSubmit={handleHideSubmit}>
          <div className="mb-3 p-3 rounded" style={{ backgroundColor: 'rgba(var(--primary-rgb, 13, 110, 253), 0.05)', border: '1px solid var(--border-color)' }}>
            {/* Threshold Mode */}
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
              <div className="ms-4 mb-3">
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

            {/* Addressed Mode */}
            <Form.Check
              type="radio"
              id="hide-type-user"
              label={t('editor.hide_addressed_label')}
              name="hideType"
              checked={hideData.type === 'user'}
              onChange={() => setHideData(prev => ({ ...prev, type: 'user' }))}
              className="fw-bold mb-2 cursor-pointer"
            />
            {hideData.type === 'user' && (
              <div className="ms-4 mb-3 position-relative">
                <Form.Control
                  type="text"
                  placeholder={t('editor.hide_username_placeholder')}
                  value={hideData.username}
                  onChange={(e) => handleUserSearch(e.target.value)}
                  className="modal-section-themed"
                  autoComplete="off"
                />
                {isSearchingUsers && <div className="small text-muted mt-1">{t('editor.hide_searching')}</div>}
                {!isSearchingUsers && userSearchResults.length > 0 && (
                  <div className="position-absolute w-100 mt-1 shadow-sm rounded border bg-white" style={{ zIndex: 1000, maxHeight: '200px', overflowY: 'auto' }}>
                    {userSearchResults.map(u => (
                      <div 
                        key={u.id} 
                        className="p-2 cursor-pointer dropdown-item d-flex align-items-center gap-2"
                        onClick={() => selectUser(u)}
                      >
                        <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--bs-gray-300)', overflow: 'hidden' }}>
                          {u.avatar_url ? (
                            <img src={resolveAvatarUrl(u.avatar_url)} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : (
                            <div className="d-flex align-items-center justify-content-center h-100 text-white small fw-bold">
                              {u.nickname?.charAt(0).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <span className="fw-semibold text-dark">{u.nickname}</span>
                      </div>
                    ))}
                  </div>
                )}
                {hideData.uid && (
                  <div className="small text-success mt-1">
                    {t('editor.hide_user_selected')}
                  </div>
                )}
              </div>
            )}

            {/* Hidden Mode */}
            <Form.Check
              type="radio"
              id="hide-type-hidden"
              label={t('editor.hide_hidden')}
              name="hideType"
              checked={hideData.type === 'hidden'}
              onChange={() => setHideData(prev => ({ ...prev, type: 'hidden' }))}
              className="fw-bold cursor-pointer"
            />
          </div>
          <p className="small text-muted mb-0">
            {t('editor.hide_hidden_hint')}
          </p>
        </Form>
      </ForumModal>

      <ForumModal
        show={showColumnsModal}
        onHide={() => closeModalWithFocus(setShowColumnsModal)}
        title={t('editor.columns_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowColumnsModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleColumnsSubmit}>
              {t('editor.columns_apply')}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{t('editor.columns_count_label')}</Form.Label>
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
          <Form.Label>{t('editor.columns_stack_label')}</Form.Label>
          <Form.Select
            value={columnsData.stack}
            onChange={(e) => setColumnsData({ ...columnsData, stack: e.target.value })}
          >
            <option value="0">{t('editor.columns_never')}</option>
            <option value="576">{t('editor.columns_mobile')}</option>
            <option value="768">{t('editor.columns_tablet')}</option>
            <option value="992">{t('editor.columns_desktop')}</option>
            <option value="9999">{t('editor.columns_always')}</option>
          </Form.Select>
          <Form.Text className="text-muted small mt-1 d-block">
            {t('editor.columns_hint')}
          </Form.Text>
        </Form.Group>
      </ForumModal>

      <ForumModal
        show={showTableModal}
        onHide={() => closeModalWithFocus(setShowTableModal)}
        title={t('editor.table_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => closeModalWithFocus(setShowTableModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleTableSubmit}>
              {t('editor.table_apply')}
            </Button>
          </>
        }
      >
        <Form.Group className="mb-3">
          <Form.Label>{t('editor.table_rows_label')}</Form.Label>
          <Form.Select
            value={tableData.rows}
            onChange={(e) => setTableData({ ...tableData, rows: parseInt(e.target.value) })}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5</option>
            <option value={6}>6</option>
            <option value={7}>7</option>
            <option value={8}>8</option>
            <option value={9}>9</option>
            <option value={10}>10</option>
          </Form.Select>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>{t('editor.table_cols_label')}</Form.Label>
          <Form.Select
            value={tableData.cols}
            onChange={(e) => setTableData({ ...tableData, cols: parseInt(e.target.value) })}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5</option>
            <option value={6}>6</option>
            <option value={7}>7</option>
            <option value={8}>8</option>
            <option value={9}>9</option>
            <option value={10}>10</option>
          </Form.Select>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>{t('editor.table_layout_label')}</Form.Label>
          <Form.Select
            value={tableData.layout}
            onChange={(e) => setTableData({ ...tableData, layout: e.target.value })}
          >
            <option value="auto">{t('editor.table_layout_auto')}</option>
            <option value="fixed">{t('editor.table_layout_fixed')}</option>
            <option value="revert">{t('editor.table_layout_revert')}</option>
          </Form.Select>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>{t('editor.table_width_label')}</Form.Label>
          <Form.Control
            type="text"
            value={tableData.width}
            onChange={(e) => setTableData({ ...tableData, width: e.target.value })}
            placeholder="100%"
          />
          <Form.Text className="text-muted small mt-1 d-block">
            {t('editor.table_width_hint')}
          </Form.Text>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>{t('editor.table_border_label')}</Form.Label>
          <Form.Control
            type="text"
            value={tableData.border}
            onChange={(e) => setTableData({ ...tableData, border: e.target.value })}
            placeholder="#cccccc"
          />
          <Form.Text className="text-muted small mt-1 d-block">
            {t('editor.table_border_hint')}
          </Form.Text>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Check
            type="checkbox"
            id="table-no-borders"
            label={t('editor.table_no_borders')}
            checked={tableData.noBorders}
            onChange={(e) => setTableData({ ...tableData, noBorders: e.target.checked })}
          />
          <Form.Text className="text-muted small mt-1 d-block">
            {t('editor.table_no_borders_hint')}
          </Form.Text>
        </Form.Group>
      </ForumModal>

      {/* Hotkeys Manual Modal */}
      <ForumModal
        show={showHotkeysModal}
        onHide={() => closeModalWithFocus(setShowHotkeysModal)}
        title={t('editor.hotkeys_modal_title')}
        footer={
          <Button variant="primary" onClick={() => closeModalWithFocus(setShowHotkeysModal)}>
            {t('editor.hotkeys_close')}
          </Button>
        }
      >
        <p className="small text-muted mb-3">
          {t('editor.hotkeys_hint')}
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
        title={t('editor.smiles_modal_title')}
        size="md"
      >
        <div style={{ minHeight: '300px' }}>
          <SmilesPicker onSelect={(code) => {
            insertText(code, '');
            setShowSmilesModal(false);
          }} />
        </div>
      </ForumModal>

      {/* More Tools Modal (Mobile) */}
      <ForumModal
        show={showMoreToolsModal}
        onHide={() => closeModalWithFocus(setShowMoreToolsModal)}
        title={t('editor.additional_formatting_title')}
        size="md"
      >
        <div 
          className="editor-overflow-modal-items py-1"
          onClick={(e) => {
            if (e.target.closest('.dropdown-item, button')) {
              setShowMoreToolsModal(false);
            }
          }}
        >
          {overflowGroupIds.map(groupId => (
            <React.Fragment key={groupId}>
              {renderGroup(groupId, true)}
            </React.Fragment>
          ))}
        </div>
      </ForumModal>
    </div>
  );
});

export default RichEditor;
