import React, { useState, useRef, useEffect } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { Bold, Italic, Underline, Strikethrough, Link as LinkIcon, Image as ImageIcon, Quote, List, Undo, Redo } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';

const RichEditor = ({ value, onChange, placeholder, rows = 6, id = 'rich-editor', maxLength }) => {
  const { t, lang } = useI18n();
  const textareaRef = useRef(null);

  // Modals state
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [linkData, setLinkData] = useState({ text: '', url: 'https://' });
  const [imageData, setImageData] = useState({ alt: '', url: 'https://' });

  // Undo/Redo history
  const [history, setHistory] = useState([value]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Use a ref to store the latest value for keydown handlers
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  // Track the last time a new history snapshot was taken
  const lastHistoryPushTime = useRef(Date.now());

  // Reset history ONLY if the value is completely replaced from outside (e.g., form reset after submit, or initial load),
  // and it's fundamentally different from our current history tip.
  useEffect(() => {
    // Prevent infinite loop: if value is empty/undefined and we just cleared it, or if it matches current tip, do nothing.
    if (value === undefined || value === null) return;

    // Check if the current value matches the tip of our local history
    const currentTip = history[historyIndex] || '';
    if (value !== currentTip) {
      // Is this a completely new external string? Or just a stray render?
      // We only reset history if the external value changed significantly (e.g., cleared, or loaded a new draft)
      // If the difference is just 1 character, it might be a typed character that didn't sync instantly.
      // But usually `value` is bound tightly. Let's just do a hard reset to be safe.
      setHistory([value]);
      setHistoryIndex(0);
      lastHistoryPushTime.current = Date.now();
    }
  }, [value]); // REMOVED history and historyIndex from dependencies to prevent infinite loops

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
    const selected = text.substring(start, end);

    let replacement = '';
    if (isLink === 'link' || isLink === 'image') {
      const { url, text: linkText, alt } = isLink === 'link' ? linkData : imageData;
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

    onChange({ target: { value: newValue } });

    // Set focus back and adjust selection
    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + replacement.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleLinkSubmit = (e) => {
    e.preventDefault();
    insertText('', '', 'link');
    setShowLinkModal(false);
    setLinkData({ text: '', url: 'https://' });
  };

  const handleImageSubmit = (e) => {
    e.preventDefault();
    // We actually want to insert the URL directly inside the tags.
    // Let's do a custom insert to put the URL inside.
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const url = imageData.url;
      const prefix = imageData.alt.trim() ? `[img=${imageData.alt.trim()}]` : '[img]';
      const suffix = '[/img]';
      const replacement = prefix + url + suffix;

      const newValue = text.substring(0, start) + replacement + text.substring(end);

      let newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(newValue);
      if (newHistory.length > 50) newHistory = newHistory.slice(newHistory.length - 50);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      lastHistoryPushTime.current = Date.now();
      onChange({ target: { value: newValue } });
    }

    setShowImageModal(false);
    setImageData({ alt: '', url: 'https://' });
  };

  return (
    <div className="rich-editor-container">
      <div className="d-flex flex-wrap gap-1 mb-2 p-2 border rounded bg-light editor-toolbar">
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

        <div className="vr mx-1"></div>

        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'bullet')} title="Bullet List"><List size={16} /></Button>
        <Button variant="light" size="sm" className="p-1 px-2" onClick={() => insertText('', '', 'quote')} title="Quote"><Quote size={16} /></Button>

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
        className="form-control"
      />

      <div className="d-flex justify-content-between mt-2 px-1">
        <Form.Text className="text-muted small">
          {lang === 'ru' ? 'Поддерживается BBCode' : 'BBCode is supported'}.
        </Form.Text>
        {maxLength && (
          <Form.Text className={`${value?.length >= maxLength ? 'text-danger' : 'text-muted'} fw-bold small`}>
            {value?.length || 0} / {maxLength}
          </Form.Text>
        )}
      </div>

      {/* Link Modal */}
      <Modal show={showLinkModal} onHide={() => setShowLinkModal(false)} animation={false} centered className="premium-modal">
        <Modal.Header closeButton>
          <Modal.Title>{lang === 'ru' ? 'Вставить ссылку' : 'Insert Link'}</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleLinkSubmit}>
          <Modal.Body>
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
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline-secondary" onClick={() => setShowLinkModal(false)}>{lang === 'ru' ? 'Отмена' : 'Cancel'}</Button>
            <Button variant="primary" type="submit">{lang === 'ru' ? 'Вставить' : 'Insert'}</Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Image Modal */}
      <Modal show={showImageModal} onHide={() => setShowImageModal(false)} animation={false} centered className="premium-modal">
        <Modal.Header closeButton>
          <Modal.Title>{lang === 'ru' ? 'Вставить изображение' : 'Insert Image'}</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleImageSubmit}>
          <Modal.Body>
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
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline-secondary" onClick={() => setShowImageModal(false)}>{lang === 'ru' ? 'Отмена' : 'Cancel'}</Button>
            <Button variant="primary" type="submit">{lang === 'ru' ? 'Вставить' : 'Insert'}</Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </div>
  );
};

export default RichEditor;
