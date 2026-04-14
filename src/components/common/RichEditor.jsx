import React, { useState, useRef, useEffect } from 'react';
import { Button, Form, Dropdown } from 'react-bootstrap';
import ForumModal from './ForumModal';
import { Bold, Italic, Underline, Strikethrough, Link as LinkIcon, Image as ImageIcon, Quote, List, Undo, Redo, Palette, ALargeSmall, Columns, Dices, Clapperboard, Youtube, EyeOff, Minus, Smile } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import SmilesPicker from './SmilesPicker';

const RichEditor = ({ value, onChange, placeholder, rows = 6, id = 'rich-editor', maxLength, autoFocus, showDice = false, isEdit = false, hideDiceType = false, showHide = true }) => {
    const { lang, t } = useI18n();

  const textareaRef = useRef(null);
  const containerRef = useRef(null);
  const [editorWidth, setEditorWidth] = useState(0);

  // Modals state
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [linkData, setLinkData] = useState({ text: '', url: 'https://' });
  const [imageData, setImageData] = useState({ alt: '', url: 'https://' });
  const [showDiceModal, setShowDiceModal] = useState(false);
    const [diceData, setDiceData] = useState({ sides: 6, type: 'normal' });
  const [showHideModal, setShowHideModal] = useState(false);
  const [hideData, setHideData] = useState({ threshold: '10', type: 'posts' });


  // Undo/Redo history
  const [history, setHistory] = useState([value]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Use a ref to store the latest value for keydown handlers
  const latestValueRef = useRef(value);
  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  // Track the last time a new history snapshot was taken
  const lastHistoryPushTime = useRef(0);

  // Flag: set to true when we ourselves triggered an onChange (modal inserts, toolbar actions).
  // Prevents the useEffect below from mistakenly resetting history on our own updates.
  const isInternalUpdate = useRef(false);

  // Reset history ONLY if the value is completely replaced from outside (e.g., form reset after submit, or initial load),
  // and it's fundamentally different from our current history tip.
  useEffect(() => {
    // Prevent infinite loop: if value is empty/undefined and we just cleared it, or if it matches current tip, do nothing.
    if (value === undefined || value === null) return;

    // Skip if this change was triggered by us internally (toolbar / modal inserts).
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }

    // Check if the current value matches the tip of our local history
    const currentTip = history[historyIndex] || '';
    if (value !== currentTip) {
      // External change (e.g. form reset, loaded draft) — hard-reset history.
      setHistory([value]);
      setHistoryIndex(0);
      lastHistoryPushTime.current = Date.now();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]); // REMOVED history and historyIndex from dependencies to prevent infinite loops

  // Handle autoFocus and measure width
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
    // If not forced (i.e. regular typing) and it's been less than 1.5 seconds since the last push,
    // just update the current tip of the history instead of creating a new snapshot.
    if (!forceNewSnapshot && newHistory.length > 1 && (now - lastHistoryPushTime.current < 1500)) {
      newHistory[newHistory.length - 1] = newValue;
      setHistory(newHistory);
      return;
    }

    // Force a new snapshot
    if (newHistory[newHistory.length - 1] !== newValue) {
      newHistory.push(newValue);

      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50); // limit history

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

  const handleKeyDown = (e) => {
    // ctrl+z or cmd+z for undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      // Check for shift+ctrl+z (redo on some OS)
      if (e.shiftKey) {
        handleRedo();
      } else {
        handleUndo();
      }
    }
    // ctrl+y or cmd+y for redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      handleRedo();
    }
  };

  const handleTextChange = (e) => {
    const newValue = e.target.value;
    onChange(e);
    // Push manual typing to history without forcing a new snapshot every keystroke
    addToHistory(newValue, false);
  };

  const insertText = (before, after = '', isLink = false) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const currentScrollTop = textarea.scrollTop;
    const selected = text.substring(start, end);

    let replacement = '';
    if (isLink === 'link' || isLink === 'image') {
      const { url, text: linkText } = isLink === 'link' ? linkData : imageData;
      if (!url) return;
      if (isLink === 'link') {
        replacement = `[url=${url}]${linkText || selected || 'link'}[/url]`;
      } else {
        replacement = `[img]${url}[/img]`;
      }
    } else if (isLink === 'bullet') {
      const lines = selected.split('\n');
      replacement = '[list]\n' + lines.map(line => `[*] ${line}`).join('\n') + '\n[/list]';
      if (start !== 0 && text[start - 1] !== '\n') {
        replacement = '\n' + replacement;
      }
    } else if (isLink === 'quote') {
      replacement = `[quote]${selected || '...'}[/quote]`;
      if (start !== 0 && text[start - 1] !== '\n') {
        replacement = '\n' + replacement;
      }
    } else if (isLink === 'color') {
      replacement = `[color=${before}]${selected || (lang === 'ru' ? 'цвет' : 'color')}[/color]`;
    } else if (isLink === 'size') {
      replacement = `[size=${before}]${selected || (lang === 'ru' ? 'размер' : 'size')}[/size]`;
    } else if (isLink === 'columns') {
      replacement = `[columns]\n[col]${selected || '...'}[/col]\n[col]...[/col]\n[/columns]\n`;
      if (start !== 0 && text[start - 1] !== '\n') {
        replacement = '\n' + replacement;
      }
    } else if (isLink === 'spoiler') {
      const defaultTitle = lang === 'ru' ? 'Спойлер' : 'Spoiler';
      replacement = `[spoiler="${defaultTitle}"]${selected || '...'}[/spoiler]`;
      if (start !== 0 && text[start - 1] !== '\n') {
        replacement = '\n' + replacement;
      }
    } else {
      replacement = before + selected + after;
    }

    const newValue = text.substring(0, start) + replacement + text.substring(end);

    // Explicitly push current manual text as a snapshot, then push formatted text
    let newHistory = history.slice(0, historyIndex + 1);
    if (newHistory[newHistory.length - 1] !== text) {
      newHistory.push(text);
    }
    newHistory.push(newValue);
    if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);

    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    lastHistoryPushTime.current = Date.now(); // Reset debounce timer

    isInternalUpdate.current = true;
    onChange({ target: { value: newValue } });

    // Set focus back and adjust selection
    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + replacement.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  const handleLinkSubmit = (e) => {
    e.preventDefault();
    // Capture modal state before closing so it's available in the deferred callback
    const capturedLinkData = { ...linkData };
    // 1. Close modal first — let Bootstrap remove the overlay from the DOM
    setShowLinkModal(false);
    setLinkData({ text: '', url: 'https://' });
    // 2. Insert text on the next tick, after the modal has been removed
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

  const handleImageSubmit = (e) => {
    e.preventDefault();
    // Capture modal state before closing
    const capturedImageData = { ...imageData };
    // 1. Close modal first — let Bootstrap remove the overlay from the DOM
    setShowImageModal(false);
    setImageData({ alt: '', url: 'https://' });
    // 2. Insert text on the next tick, after the modal has been removed
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      const url = capturedImageData.url;
      const prefix = capturedImageData.alt.trim() ? `[img=${capturedImageData.alt.trim()}]` : '[img]';
      const suffix = '[/img]';
      const replacement = prefix + url + suffix;
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
      const end = textarea.selectionEnd;
      const text = latestValueRef.current;
      const currentScrollTop = textarea.scrollTop;
      
      const { sides, type } = capturedDiceData;
      const replacement = `[dice=${sides}${type === 'master' ? ' type=master' : ''}]`;
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
      const newCursorPos = start + (`[hide=${val}]`).length + selected.length + (`[/hide]`).length;
      const cursorPos = selected.length > 0 ? newCursorPos : start + (`[hide=${val}]`).length;
      textarea.setSelectionRange(cursorPos, cursorPos);
      textarea.scrollTop = currentScrollTop;
    }, 0);
  };

  return (
    <div className="rich-editor-container" ref={containerRef}>
      <div className="d-flex flex-wrap gap-1 mb-2 p-2 rounded editor-toolbar-themed editor-toolbar">
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[b]', '[/b]')} title="Bold"><Bold size={16} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[i]', '[/i]')} title="Italic"><Italic size={16} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[u]', '[/u]')} title="Underline"><Underline size={16} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[s]', '[/s]')} title="Strikethrough"><Strikethrough size={16} /></Button>

        <div className="vr mx-1"></div>

        <Button
          variant="light"
          size="sm"
          className="p-1 px-2"
          onClick={() => {
            const textarea = textareaRef.current;
            const selected = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
            setLinkData(prev => ({ ...prev, text: selected }));
            setShowLinkModal(true);
          }}
          title="Link"
        >
          <LinkIcon size={16} />
        </Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowImageModal(true)} title="Image"><ImageIcon size={16} /></Button>
        <Dropdown className="d-inline-block" drop="up">
          <Dropdown.Toggle 
            variant="light" 
            size="sm" 
            className="p-1 px-2 no-caret editor-dropdown-toggle" 
            title={lang === 'ru' ? 'Смайлики' : 'Smiles'}
          >
            <Smile size={16} />
          </Dropdown.Toggle>
          <Dropdown.Menu 
            className="smiles-picker-menu p-0 shadow border-0" 
            renderOnMount
            style={{ 
              width: editorWidth ? `${editorWidth}px` : '320px', 
              zIndex: 3500,
              maxWidth: 'none'
            }}
            placement="top-start"
            popperConfig={{ 
              strategy: 'fixed',
              modifiers: [
                {
                  name: 'offset',
                  options: {
                    offset: ({ placement, reference, popper }) => {
                      if (containerRef.current && reference) {
                        const containerRect = containerRef.current.getBoundingClientRect();
                        if (containerRect.width === 0) return [0, 8];
                        
                        const toggleRect = reference;
                        const skhiftX = -(toggleRect.x - containerRect.x);
                        return [skhiftX, 8];
                      }
                      return [0, 8];
                    },
                  },
                },
                {
                  name: 'flip',
                  enabled: false, // Prevents "disappearing" while determining best placement
                },
                {
                  name: 'preventOverflow',
                  options: {
                    boundary: 'viewport',
                  },
                },
                {
                  name: 'computeStyles',
                  options: {
                    adaptive: true, 
                    gpuAcceleration: true,
                  },
                }
              ],
            }}
          >
            <SmilesPicker onSelect={(code) => insertText(code, '')} width={editorWidth} />
          </Dropdown.Menu>
        </Dropdown>

        <div className="vr mx-1"></div>

        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'bullet')} title="Bullet List"><List size={16} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'quote')} title="Quote"><Quote size={16} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[hr]', '')} title={lang === 'ru' ? 'Линия' : 'Horizontal Rule'}><Minus size={16} /></Button>

        <div className="vr mx-1"></div>

        {/* Color Picker */}
        <Dropdown className="d-inline-block">
          <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title={lang === 'ru' ? 'Цвет текста' : 'Text Color'}>
            <Palette size={16} />
          </Dropdown.Toggle>
          <Dropdown.Menu className="color-picker-menu p-2 shadow-sm border-0" style={{ minWidth: '160px', borderRadius: '12px' }}>
            <div className="d-flex flex-wrap gap-1 justify-content-center">
              {[
                '#000000', '#444444', '#666666', '#999999', '#cccccc', '#ffffff',
                '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#9900ff', '#ff00ff',
                '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#cfe2f3', '#d9d2e9', '#ead1dc',
                '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#9fc5e8', '#b4a7d6', '#d5a6bd',
                '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6fa8dc', '#8e7cc3', '#c27ba0',
              ].map(color => (
                <button
                  key={color}
                  type="button"
                  className="color-swatch border rounded-circle"
                  style={{ 
                    backgroundColor: color, 
                    width: '20px', 
                    height: '20px', 
                    border: '1px solid rgba(0,0,0,0.1)',
                    cursor: 'pointer',
                    padding: 0
                  }}
                  onClick={() => insertText(color, '', 'color')}
                  title={color}
                />
              ))}
            </div>
          </Dropdown.Menu>
        </Dropdown>

        {/* Size Selector */}
        <Dropdown className="d-inline-block">
          <Dropdown.Toggle variant="light" size="sm" className="p-1 px-2 no-caret editor-dropdown-toggle" title={lang === 'ru' ? 'Размер текста' : 'Text Size'}>
            <ALargeSmall size={19} />
          </Dropdown.Toggle>
          <Dropdown.Menu className="size-picker-menu shadow-sm border-0" style={{ borderRadius: '12px' }}>
            {[
              { label: '50%', value: '50%' },
              { label: '85%', value: '85%' },
              { label: '100%', value: '100%' },
              { label: '120%', value: '120%' },
              { label: '150%', value: '150%' },
              { label: '200%', value: '200%' },
            ].map(size => (
              <Dropdown.Item key={size.value} onClick={() => insertText(size.value, '', 'size')} className="small py-1 px-3">
                <span style={{ fontSize: size.value }}>{size.label}</span>
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown>

        <div className="vr mx-1"></div>

        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'columns')} title={lang === 'ru' ? 'Колонки' : 'Columns'}><Columns size={16} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'spoiler')} title={lang === 'ru' ? 'Спойлер' : 'Spoiler'}><Clapperboard size={15} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('[video]', '[/video]')} title={lang === 'ru' ? 'Видео' : 'Video'}>
          <Youtube size={16} />
        </Button>
        {showDice && !isEdit && (
          <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowDiceModal(true)} title={lang === 'ru' ? 'Бросить кубик' : 'Roll Dice'}>
            <Dices size={16} />
          </Button>
        )}
        {showHide && (
          <Button variant="light" size="sm" className="p-1 px-2" onClick={() => setShowHideModal(true)} title={t('editor.hide')}>
            <EyeOff size={16} />
          </Button>
        )}

        <div className="vr mx-1"></div>

        <Button
          variant="light"
          size="sm"
          className="p-1 px-2"
          onClick={handleUndo}
          disabled={historyIndex === 0}
          title={lang === 'ru' ? 'Отменить' : 'Undo'}
        >
          <Undo size={16} />
        </Button>
        <Button
          variant="light"
          size="sm"
          className="p-1 px-2"
          onClick={handleRedo}
          disabled={historyIndex >= history.length - 1}
          title={lang === 'ru' ? 'Повторить' : 'Redo'}
        >
          <Redo size={16} />
        </Button>
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
        onHide={() => setShowLinkModal(false)}
        title={lang === 'ru' ? 'Вставить ссылку' : 'Insert Link'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowLinkModal(false)}>
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
        show={showImageModal}
        onHide={() => setShowImageModal(false)}
        title={lang === 'ru' ? 'Вставить изображение' : 'Insert Image'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowImageModal(false)}>
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

      {/* Dice Modal */}
      <ForumModal
        show={showDiceModal}
        onHide={() => setShowDiceModal(false)}
        title={lang === 'ru' ? 'Бросить кубик' : 'Roll Dice'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowDiceModal(false)}>
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

      {/* Hide Modal */}
      <ForumModal
        show={showHideModal}
        onHide={() => setShowHideModal(false)}
        title={t('editor.hide_modal_title')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowHideModal(false)}>
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
    </div>
  );
};

export default RichEditor;
