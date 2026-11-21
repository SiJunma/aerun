import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import ForumModal from './ForumModal';
import {
  Bold, Italic, Underline, Strikethrough, Link as LinkIcon, Image as ImageIcon,
  Quote, Undo, Redo, Palette, ALargeSmall, Columns, Dices, Clapperboard,
  Youtube, EyeOff, Minus, Smile, AlignLeft, AlignCenter, AlignRight,
  AlignJustify, Keyboard, MoreHorizontal, Superscript, Subscript, HelpCircle, Code, CodeXml, Table as TableIcon,
  ChevronDown
} from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import SmilesPicker from './SmilesPicker';
import { sendApi } from '../../api/pocketbase';
import { resolveAvatarUrl } from '../../api/avatars';
import Button from './Button';

const RichEditor = forwardRef(({
  value, onChange, placeholder, rows = 6, minHeight, maxHeight, id = 'rich-editor',
  maxLength, autoFocus, showDice = false, isEdit = false, hideDiceType = false,
  showHide = true, _smilesDropDirection = "up", _smilesFullWidth = true, _onSubmit,
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

  // Custom pickers state
  const [showSizePicker, setShowSizePicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const sizePickerRef = useRef(null);
  const colorPickerRef = useRef(null);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 992);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Click outside handler for pickers
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (sizePickerRef.current && !sizePickerRef.current.contains(event.target)) {
        setShowSizePicker(false);
      }
      if (colorPickerRef.current && !colorPickerRef.current.contains(event.target)) {
        setShowColorPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Escape key handler for pickers
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setShowSizePicker(false);
        setShowColorPicker(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  useImperativeHandle(ref, () => ({
    openHotkeysModal: () => setShowHotkeysModal(true),
    focus: () => textareaRef.current?.focus()
  }));

  const adjustTextareaHeight = useCallback(() => {
    if (!autoResize || !textareaRef.current) return;
    const el = textareaRef.current;
    el.style.height = 'auto';
    const maxHeightPx =
      typeof maxHeight === 'number'
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
    if (autoResize) adjustTextareaHeight();
  }, [value, autoResize, adjustTextareaHeight]);

  // Responsive toolbar logic with ResizeObserver
  useEffect(() => {
    const container = toolbarContainerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setEditorWidth(container.offsetWidth);
    };

    // Initial measurement
    updateWidth();

    // Observe resize
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // Calculate visible/overflow groups
  useEffect(() => {
    if (editorWidth === 0) return;

    // Groups definition — minWidth based on actual button sizes:
    // icon-only button = 34px + gap 4px = 38px per button
    // basic: 6 buttons = 6*38 - 4 = 224px
    // format: 5 buttons = 5*38 - 4 = 186px
    // align: 4 buttons = 4*38 - 4 = 148px
    // inserts: 3 buttons = 3*38 - 4 = 110px
    // media: 2 buttons = 2*38 - 4 = 72px
    // advanced: 6 buttons = 6*38 - 4 = 224px
    // smiles: 1 button = 34px
    // hotkeys: 1 button = 34px
    const groups = [
      { id: 'basic', minWidth: 224 },
      { id: 'format', minWidth: 186 },
      { id: 'align', minWidth: 148 },
      { id: 'inserts', minWidth: 110 },
      { id: 'media', minWidth: 72 },
      { id: 'advanced', minWidth: 224 },
      { id: 'smiles', minWidth: 34 },
      { id: 'hotkeys', minWidth: 34 }
    ];
    const groupOrder = ['basic', 'format', 'align', 'inserts', 'media', 'advanced', 'smiles', 'hotkeys'];

    // Always reserve space for: size picker (38px) + color picker (38px) + divider (2px*2=4px) + overflow toggle (38px) = ~118px
    // Plus container padding (0.5rem*2 = 16px) and gap between items
    const fixedReserved = 118;
    let availableWidth = editorWidth - fixedReserved;
    const visible = [];
    const overflow = [];
    for (const groupId of groupOrder) {
      const group = groups.find(g => g.id === groupId);
      if (!group) continue;
      if (availableWidth >= group.minWidth) {
        visible.push(groupId);
        availableWidth -= group.minWidth;
      } else {
        overflow.push(groupId);
      }
    }
    /* eslint-disable react-hooks/set-state-in-effect */
    setVisibleGroupIds(_ => visible);
    setOverflowGroupIds(_ => overflow);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [editorWidth, isMobile]);

  // Modal helpers
  const closeModalWithFocus = useCallback((setter) => {
    setter(false);
    textareaRef.current?.focus();
  }, []);

  const insertText = useCallback((openTag, closeTag, cursorOffset = null) => {
    if (!textareaRef.current) return;
    const el = textareaRef.current;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selectedText = value.substring(start, end);
    let newText;
    if (cursorOffset !== null && selectedText) {
      newText = openTag + selectedText + closeTag;
    } else {
      newText = openTag + closeTag;
    }
    const newValue = value.substring(0, start) + newText + value.substring(end);
    onChange(newValue);
    el.focus();
    if (cursorOffset !== null && !selectedText) {
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = start + openTag.length + cursorOffset;
      }, 0);
    }
  }, [value, onChange]);

  // BBCode modal handlers
  const handleLinkSubmit = (e) => {
    e.preventDefault();
    insertText(`[url=${linkData.url}]${linkData.text || linkData.url}[/url]`, '');
    setShowLinkModal(false);
    setLinkData({ text: '', url: 'https://' });
  };

  const handleAbbrSubmit = (e) => {
    e.preventDefault();
    insertText(`[abbr=${abbrData.title}]${abbrData.text}[/abbr]`, '');
    setShowAbbrModal(false);
    setAbbrData({ text: '', title: '' });
  };

  const handleImageSubmit = (e) => {
    e.preventDefault();
    let bbcode = `[img]${imageData.url}[/img]`;
    if (imageData.alt) bbcode = `[img=${imageData.alt}]${imageData.url}[/img]`;
    if (imageData.width) bbcode = `[img=${imageData.width}]${imageData.url}[/img]`;
    if (imageData.alt && imageData.width) bbcode = `[img=${imageData.alt},${imageData.width}]${imageData.url}[/img]`;
    insertText(bbcode, '');
    setShowImageModal(false);
    setImageData({ alt: '', url: 'https://', width: '' });
  };

  const handleDiceSubmit = (e) => {
    e.preventDefault();
    const typePrefix = diceData.type === 'master' ? 'mdice' : 'dice';
    insertText(`[${typePrefix}=${diceData.sides}]`, `[/${typePrefix}]`);
    setShowDiceModal(false);
  };

  const handleHideSubmit = (e) => {
    e.preventDefault();
    let bbcode;
    if (hideData.type === 'user') {
      if (!hideData.uid) return;
      bbcode = `[hide=${hideData.uid}]`;
    } else if (hideData.type === 'posts') {
      bbcode = `[hide=${hideData.threshold}]`;
    } else {
      bbcode = '[hide]';
    }
    insertText(bbcode, '[/hide]');
    setShowHideModal(false);
    setHideData({ threshold: '10', type: 'posts', uid: '', username: '' });
  };

  const handleColumnsSubmit = (e) => {
    e.preventDefault();
    insertText(`[columns=${columnsData.count},${columnsData.stack}]`, '[/columns]');
    setShowColumnsModal(false);
  };

  const handleTableSubmit = (e) => {
    e.preventDefault();
    let attrs = [];
    if (tableData.layout) attrs.push(tableData.layout);
    if (tableData.width) attrs.push(tableData.width);
    if (tableData.border) attrs.push(tableData.border);
    if (tableData.noBorders) attrs.push('noborders');
    const attrStr = attrs.length ? `=${attrs.join(',')}` : '';
    insertText(`[table${attrStr}]`, '[/table]');
    setShowTableModal(false);
  };

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
    setHideData(prev => ({ ...prev, uid: user.id, username: user.nickname }));
  };

  const openAbbrModal = useCallback(() => {
    setShowAbbrModal(true);
  }, []);

  const openTableModal = useCallback(() => {
    setShowTableModal(true);
  }, []);

  const openHideModal = useCallback(() => {
    setShowHideModal(true);
  }, []);

  // Toolbar group rendering
  const renderGroup = useCallback((groupId, isOverflow = false) => {
    switch (groupId) {
      case 'basic':
        if (isOverflow) {
          return (
            <>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[b]', '[/b]')}
              >
                <Bold size={16} /> {t('editor.bold')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[i]', '[/i]')}
              >
                <Italic size={16} /> {t('editor.italic')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[u]', '[/u]')}
              >
                <Underline size={16} /> {t('editor.underline')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[s]', '[/s]')}
              >
                <Strikethrough size={16} /> {t('editor.strikethrough')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => setShowLinkModal(true)}
              >
                <LinkIcon size={16} /> {t('editor.link')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => setShowImageModal(true)}
              >
                <ImageIcon size={16} /> {t('editor.image')}
              </button>
            </>
          );
        }
        return (
          <div className="editor-toolbar-group">
            <Button variant="ghost" iconOnly onClick={() => insertText('[b]', '[/b]')} title={t('editor.bold')}>
              <Bold size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[i]', '[/i]')} title={t('editor.italic')}>
              <Italic size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[u]', '[/u]')} title={t('editor.underline')}>
              <Underline size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[s]', '[/s]')} title={t('editor.strikethrough')}>
              <Strikethrough size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => setShowLinkModal(true)} title={t('editor.link')}>
              <LinkIcon size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => setShowImageModal(true)} title={t('editor.image')}>
              <ImageIcon size={16} />
            </Button>
          </div>
        );

      case 'format':
        if (isOverflow) {
          return (
            <>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[quote]', '[/quote]')}
              >
                <Quote size={16} /> {t('editor.quote')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[spoiler]', '[/spoiler]')}
              >
                <Clapperboard size={16} /> {t('editor.spoiler')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={openAbbrModal}
              >
                <HelpCircle size={16} /> {t('editor.abbreviation')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[code]', '[/code]')}
              >
                <Code size={16} /> {t('editor.code_block')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[html]', '[/html]')}
              >
                <CodeXml size={16} /> HTML
              </button>
            </>
          );
        }
        return (
          <div className="editor-toolbar-group">
            <Button variant="ghost" iconOnly onClick={() => insertText('[quote]', '[/quote]')} title={t('editor.quote')}>
              <Quote size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[spoiler]', '[/spoiler]')} title={t('editor.spoiler')}>
              <Clapperboard size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={openAbbrModal} title={t('editor.abbreviation')}>
              <HelpCircle size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[code]', '[/code]')} title={t('editor.code_block')}>
              <Code size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[html]', '[/html]')} title="HTML">
              <CodeXml size={16} />
            </Button>
          </div>
        );

      case 'align':
        if (isOverflow) {
          return (
            <>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[align=left]', '[/align]')}
              >
                <AlignLeft size={16} /> {t('editor.align_left')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[align=center]', '[/align]')}
              >
                <AlignCenter size={16} /> {t('editor.align_center')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[align=right]', '[/align]')}
              >
                <AlignRight size={16} /> {t('editor.align_right')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[align=justify]', '[/align]')}
              >
                <AlignJustify size={16} /> {t('editor.align_justify')}
              </button>
            </>
          );
        }
        return (
          <div className="editor-toolbar-group">
            <Button variant="ghost" iconOnly onClick={() => insertText('[align=left]', '[/align]')} title={t('editor.align_left')}>
              <AlignLeft size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[align=center]', '[/align]')} title={t('editor.align_center')}>
              <AlignCenter size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[align=right]', '[/align]')} title={t('editor.align_right')}>
              <AlignRight size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[align=justify]', '[/align]')} title={t('editor.align_justify')}>
              <AlignJustify size={16} />
            </Button>
          </div>
        );

      case 'inserts':
        if (isOverflow) {
          return (
            <>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[sup]', '[/sup]')}
              >
                <Superscript size={16} /> {t('editor.superscript')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[sub]', '[/sub]')}
              >
                <Subscript size={16} /> {t('editor.subscript')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[hr]', '')}
              >
                <Minus size={16} /> {t('editor.hr')}
              </button>
            </>
          );
        }
        return (
          <div className="editor-toolbar-group">
            <Button variant="ghost" iconOnly onClick={() => insertText('[sup]', '[/sup]')} title={t('editor.superscript')}>
              <Superscript size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[sub]', '[/sub]')} title={t('editor.subscript')}>
              <Subscript size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[hr]', '')} title={t('editor.hr')}>
              <Minus size={16} />
            </Button>
          </div>
        );

      case 'media':
        if (isOverflow) {
          return (
            <>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => setShowImageModal(true)}
              >
                <ImageIcon size={16} /> {t('editor.image')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[video]', '[/video]')}
              >
                <Youtube size={16} /> {t('editor.video')}
              </button>
            </>
          );
        }
        return (
          <div className="editor-toolbar-group">
            <Button variant="ghost" iconOnly onClick={() => setShowImageModal(true)} title={t('editor.image')}>
              <ImageIcon size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={() => insertText('[video]', '[/video]')} title={t('editor.video')}>
              <Youtube size={16} />
            </Button>
          </div>
        );

      case 'advanced':
        if (isOverflow) {
          return (
            <>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => setShowColumnsModal(true)}
              >
                <Columns size={16} /> {t('editor.columns')}
              </button>
              <button
                type="button"
                className="editor-overflow-item"
                onClick={openTableModal}
              >
                <TableIcon size={16} /> {t('editor.table')}
              </button>
              {showHide && (
                <button
                  type="button"
                  className="editor-overflow-item"
                  onClick={openHideModal}
                >
                  <EyeOff size={16} /> {t('editor.hide')}
                </button>
              )}
              {showDice && !isEdit && (
                <button
                  type="button"
                  className="editor-overflow-item"
                  onClick={() => setShowDiceModal(true)}
                >
                  <Dices size={16} /> {t('editor.dice_roll_btn')}
                </button>
              )}
              <button
                type="button"
                className="editor-overflow-item"
                onClick={() => insertText('[hr]', '')}
              >
                <Minus size={16} /> {t('editor.hr')}
              </button>
            </>
          );
        }
        return (
          <div className="editor-toolbar-group">
            <Button variant="ghost" iconOnly onClick={() => setShowColumnsModal(true)} title={t('editor.columns')}>
              <Columns size={16} />
            </Button>
            <Button variant="ghost" iconOnly onClick={openTableModal} title={t('editor.table')}>
              <TableIcon size={16} />
            </Button>
            {showHide && (
              <Button variant="ghost" iconOnly onClick={openHideModal} title={t('editor.hide')}>
                <EyeOff size={16} />
              </Button>
            )}
            {showDice && !isEdit && (
              <Button variant="ghost" iconOnly onClick={() => setShowDiceModal(true)} title={t('editor.roll_dice')}>
                <Dices size={16} />
              </Button>
            )}
            <Button variant="ghost" iconOnly onClick={() => insertText('[hr]', '')} title={t('editor.hr')}>
              <Minus size={16} />
            </Button>
          </div>
        );

      case 'smiles':
        if (isOverflow) {
          return (
            <button
              type="button"
              className="editor-overflow-item"
              onClick={() => setShowSmilesModal(true)}
            >
              <Smile size={16} /> {t('editor.smiles')}
            </button>
          );
        }
        return (
          <div className="editor-toolbar-group">
            <Button
              variant="ghost"
              iconOnly
              onClick={() => setShowSmilesModal(true)}
              title={t('editor.smiles')}
            >
              <Smile size={18} />
            </Button>
          </div>
        );

      case 'hotkeys':
        if (isOverflow || hideHotkeysButton) return null;
        return (
          <div className="editor-toolbar-group">
            <Button variant="ghost" iconOnly onClick={() => setShowHotkeysModal(true)} title={t('editor.hotkeys')}>
              <Keyboard size={16} />
            </Button>
          </div>
        );

      default:
        return null;
    }
  }, [t, insertText, showHide, showDice, isEdit, hideHotkeysButton, openAbbrModal, openTableModal, openHideModal]);

  // Size picker options
  const sizeOptions = [
    { value: 'xx-small', label: t('editor.size_xx_small') },
    { value: 'x-small', label: t('editor.size_x_small') },
    { value: 'small', label: t('editor.size_small') },
    { value: 'medium', label: t('editor.size_medium') },
    { value: 'large', label: t('editor.size_large') },
    { value: 'x-large', label: t('editor.size_x_large') },
    { value: 'xx-large', label: t('editor.size_xx_large') }
  ];

  // Color picker options
  const colorOptions = [
    { value: '#e03e3e', label: t('editor.color_red') },
    { value: '#dd6b20', label: t('editor.color_orange') },
    { value: '#d69e2e', label: t('editor.color_yellow') },
    { value: '#38a169', label: t('editor.color_green') },
    { value: '#3182ce', label: t('editor.color_blue') },
    { value: '#805ad5', label: t('editor.color_purple') },
    { value: '#d53f8c', label: t('editor.color_pink') },
    { value: '#4a5568', label: t('editor.color_gray') },
    { value: '#000000', label: t('editor.color_black') },
    { value: '#ffffff', label: t('editor.color_white') }
  ];

  // Hotkey groups for the hotkeys modal
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

  return (
    <div className="rich-editor-container" ref={containerRef}>
      <div
        ref={toolbarContainerRef}
        className="editor-toolbar"
      >
        {/* Render Visible Groups */}
        {visibleGroupIds.map((groupId, idx) => (
          <React.Fragment key={groupId}>
            {renderGroup(groupId)}
            {idx < visibleGroupIds.length - 1 && <div className="editor-toolbar-divider"></div>}
          </React.Fragment>
        ))}

        {/* Size Picker */}
        <div className="editor-picker" ref={sizePickerRef}>
          <button
            type="button"
            className="editor-picker__toggle"
            onClick={() => setShowSizePicker(!showSizePicker)}
            aria-haspopup="listbox"
            aria-expanded={showSizePicker}
            title={t('editor.font_size')}
          >
            <ALargeSmall size={16} />
          </button>
          {showSizePicker && (
            <div className="editor-picker__menu editor-picker__menu--right" role="listbox">
              {sizeOptions.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className="editor-picker__item"
                  role="option"
                  onClick={() => {
                    insertText(`[size=${opt.value}]`, '[/size]');
                    setShowSizePicker(false);
                  }}
                >
                  <span style={{ fontSize: opt.value }}>{opt.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="editor-toolbar-divider"></div>

        {/* Color Picker */}
        <div className="editor-picker" ref={colorPickerRef}>
          <button
            type="button"
            className="editor-picker__toggle"
            onClick={() => setShowColorPicker(!showColorPicker)}
            aria-haspopup="listbox"
            aria-expanded={showColorPicker}
            title={t('editor.font_color')}
          >
            <Palette size={16} />
          </button>
          {showColorPicker && (
            <div className="editor-picker__menu editor-picker__menu--right" role="listbox">
              {colorOptions.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className="editor-picker__item"
                  role="option"
                  onClick={() => {
                    insertText(`[color=${opt.value}]`, '[/color]');
                    setShowColorPicker(false);
                  }}
                >
                  <span className="editor-color-swatch" style={{ backgroundColor: opt.value }}></span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="editor-toolbar-divider"></div>

        {/* Render Overflow Menu */}
        {overflowGroupIds.length > 0 && (
          <>
            {visibleGroupIds.length > 0 && <div className="editor-toolbar-divider"></div>}
            {isMobile ? (
              <Button
                variant="ghost"
                iconOnly
                className="editor-more-tools-btn"
                onClick={() => setShowMoreToolsModal(true)}
                title={t('editor.additional_formatting_title')}
              >
                <MoreHorizontal size={18} />
              </Button>
            ) : (
              <div className="editor-picker">
                <button
                  type="button"
                  className="editor-overflow-toggle"
                  onClick={() => setShowMoreToolsModal(true)}
                  aria-haspopup="listbox"
                  aria-expanded={showMoreToolsModal}
                  title={t('editor.additional_formatting_title')}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        id={id}
        className="editor-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{ minHeight: minHeight }}
        maxLength={maxLength > 0 ? maxLength : undefined}
        autoFocus={autoFocus}
      />

      {/* Footer */}
      {!hideFooter && (
        <div className="editor-footer">
          <span className="editor-footer__hint">{t('forum.bbcode_supported')}</span>
          <span className={maxLength > 0 && value?.length >= maxLength ? 'editor-footer__counter editor-footer__counter--danger' : 'editor-footer__counter'}>
            {maxLength > 0
              ? `${value?.length || 0} / ${maxLength}`
              : `${t('forum.chars')} ${value?.length || 0}`}
          </span>
        </div>
      )}

      {/* Link Modal */}
      <ForumModal
        show={showLinkModal}
        onHide={() => closeModalWithFocus(setShowLinkModal)}
        title={t('editor.link_modal_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => closeModalWithFocus(setShowLinkModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleLinkSubmit}>
              {t('editor.link_insert')}
            </Button>
          </>
        }
      >
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="linkText">{t('editor.link_text_label')}</label>
          <input
            id="linkText"
            type="text"
            className="editor-modal-input"
            value={linkData.text}
            onChange={e => setLinkData({ ...linkData, text: e.target.value })}
            placeholder={t('editor.link_text_placeholder')}
          />
        </div>
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="linkUrl">URL</label>
          <input
            id="linkUrl"
            type="url"
            className="editor-modal-input"
            value={linkData.url}
            onChange={e => setLinkData({ ...linkData, url: e.target.value })}
            required
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleLinkSubmit(e); } }}
          />
        </div>
      </ForumModal>

      {/* Abbreviation Modal */}
      <ForumModal
        show={showAbbrModal}
        onHide={() => closeModalWithFocus(setShowAbbrModal)}
        title={t('editor.abbr_modal_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => closeModalWithFocus(setShowAbbrModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleAbbrSubmit}>
              {t('editor.link_insert')}
            </Button>
          </>
        }
      >
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="abbrText">{t('editor.abbr_text_label')}</label>
          <input
            id="abbrText"
            type="text"
            className="editor-modal-input"
            value={abbrData.text}
            onChange={e => setAbbrData({ ...abbrData, text: e.target.value })}
            placeholder={t('editor.abbr_text_placeholder')}
            autoFocus
          />
        </div>
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="abbrTitle">{t('editor.abbr_title_label')}</label>
          <input
            id="abbrTitle"
            type="text"
            className="editor-modal-input"
            value={abbrData.title}
            onChange={e => setAbbrData({ ...abbrData, title: e.target.value })}
            placeholder={t('editor.abbr_title_placeholder')}
            required
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAbbrSubmit(e); } }}
          />
        </div>
      </ForumModal>

      {/* Image Modal */}
      <ForumModal
        show={showImageModal}
        onHide={() => closeModalWithFocus(setShowImageModal)}
        title={t('editor.image_modal_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => closeModalWithFocus(setShowImageModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleImageSubmit}>
              {t('editor.link_insert')}
            </Button>
          </>
        }
      >
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="imageAlt">{t('editor.image_alt_label')}</label>
          <input
            id="imageAlt"
            type="text"
            className="editor-modal-input"
            value={imageData.alt}
            onChange={e => setImageData({ ...imageData, alt: e.target.value })}
            placeholder={t('editor.image_alt_placeholder')}
          />
        </div>
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="imageWidth">{t('editor.image_width_label')}</label>
          <input
            id="imageWidth"
            type="text"
            className="editor-modal-input"
            value={imageData.width || ''}
            onChange={e => setImageData({ ...imageData, width: e.target.value })}
            placeholder={t('editor.image_width_placeholder')}
          />
        </div>
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="imageUrl">{t('editor.image_url_label')}</label>
          <input
            id="imageUrl"
            type="url"
            className="editor-modal-input"
            value={imageData.url}
            onChange={e => setImageData({ ...imageData, url: e.target.value })}
            required
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleImageSubmit(e); } }}
          />
        </div>
      </ForumModal>

      {/* Dice Modal */}
      <ForumModal
        show={showDiceModal}
        onHide={() => closeModalWithFocus(setShowDiceModal)}
        title={t('editor.dice_modal_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => closeModalWithFocus(setShowDiceModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleDiceSubmit}>
              {t('editor.dice_roll')}
            </Button>
          </>
        }
      >
        <div className="editor-modal-notice">
          {t('editor.dice_immutable')}
        </div>

        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="diceSides">{t('editor.dice_select_label')}</label>
          <select
            id="diceSides"
            className="editor-modal-select"
            value={diceData.sides}
            onChange={e => setDiceData({ ...diceData, sides: parseInt(e.target.value) })}
          >
            <option value="4">d4</option>
            <option value="6">d6</option>
            <option value="8">d8</option>
            <option value="10">d10</option>
            <option value="12">d12</option>
            <option value="20">d20</option>
            <option value="100">d100</option>
          </select>
          <small className="editor-modal-hint">{t('editor.dice_type_hint')}</small>
        </div>

        {!hideDiceType && (
          <div className="editor-modal-field">
            <label className="editor-modal-label" htmlFor="diceType">{t('editor.dice_type_label')}</label>
            <select
              id="diceType"
              className="editor-modal-select"
              value={diceData.type}
              onChange={e => setDiceData({ ...diceData, type: e.target.value })}
            >
              <option value="normal">{t('editor.dice_normal')}</option>
              <option value="master">{t('editor.dice_master')}</option>
            </select>
          </div>
        )}
      </ForumModal>

      {/* Hide Modal */}
      <ForumModal
        show={showHideModal}
        onHide={() => closeModalWithFocus(setShowHideModal)}
        title={t('editor.hide_modal_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => closeModalWithFocus(setShowHideModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleHideSubmit}>
              {t('editor.hide_insert')}
            </Button>
          </>
        }
      >
        <form onSubmit={handleHideSubmit} className="editor-modal-card">
          {/* Threshold Mode */}
          <label className="editor-modal-radio">
            <input
              type="radio"
              id="hide-type-posts"
              name="hideType"
              checked={hideData.type === 'posts'}
              onChange={() => setHideData(prev => ({ ...prev, type: 'posts' }))}
            />
            <span>{t('editor.hide_threshold')}</span>
          </label>
          {hideData.type === 'posts' && (
            <div className="editor-modal-field editor-modal-field--indented">
              <input
                type="number"
                id="hideThreshold"
                className="editor-modal-input editor-modal-input--small"
                value={hideData.threshold}
                onChange={(e) => setHideData(prev => ({ ...prev, threshold: e.target.value }))}
                min="1"
                placeholder="10"
                autoFocus
              />
            </div>
          )}

          {/* Addressed Mode */}
          <label className="editor-modal-radio">
            <input
              type="radio"
              id="hide-type-user"
              name="hideType"
              checked={hideData.type === 'user'}
              onChange={() => setHideData(prev => ({ ...prev, type: 'user' }))}
            />
            <span>{t('editor.hide_addressed_label')}</span>
          </label>
          {hideData.type === 'user' && (
            <div className="editor-modal-field editor-modal-field--indented editor-modal-field--relative">
              <input
                type="text"
                id="hideUsername"
                className="editor-modal-input"
                placeholder={t('editor.hide_username_placeholder')}
                value={hideData.username}
                onChange={(e) => handleUserSearch(e.target.value)}
                autoComplete="off"
              />
              {isSearchingUsers && <small className="editor-modal-hint">{t('editor.hide_searching')}</small>}
              {!isSearchingUsers && userSearchResults.length > 0 && (
                <div className="editor-modal-dropdown">
                  {userSearchResults.map(u => (
                    <button
                      key={u.id}
                      type="button"
                      className="editor-modal-dropdown-item"
                      onClick={() => selectUser(u)}
                    >
                      <div className="editor-modal-avatar">
                        {u.avatar_url ? (
                          <img src={resolveAvatarUrl(u.avatar_url)} alt="avatar" />
                        ) : (
                          <span>{u.nickname?.charAt(0).toUpperCase()}</span>
                        )}
                      </div>
                      <span>{u.nickname}</span>
                    </button>
                  ))}
                </div>
              )}
              {hideData.uid && (
                <small className="editor-modal-hint editor-modal-hint--success">
                  {t('editor.hide_user_selected')}
                </small>
              )}
            </div>
          )}

          {/* Hidden Mode */}
          <label className="editor-modal-radio">
            <input
              type="radio"
              id="hide-type-hidden"
              name="hideType"
              checked={hideData.type === 'hidden'}
              onChange={() => setHideData(prev => ({ ...prev, type: 'hidden' }))}
            />
            <span>{t('editor.hide_hidden')}</span>
          </label>
          <small className="editor-modal-hint">{t('editor.hide_hidden_hint')}</small>
        </form>
      </ForumModal>

      {/* Columns Modal */}
      <ForumModal
        show={showColumnsModal}
        onHide={() => closeModalWithFocus(setShowColumnsModal)}
        title={t('editor.columns_modal_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => closeModalWithFocus(setShowColumnsModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleColumnsSubmit}>
              {t('editor.columns_apply')}
            </Button>
          </>
        }
      >
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="columnsCount">{t('editor.columns_count_label')}</label>
          <select
            id="columnsCount"
            className="editor-modal-select"
            value={columnsData.count}
            onChange={(e) => setColumnsData({ ...columnsData, count: parseInt(e.target.value) })}
          >
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
          </select>
        </div>

        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="columnsStack">{t('editor.columns_stack_label')}</label>
          <select
            id="columnsStack"
            className="editor-modal-select"
            value={columnsData.stack}
            onChange={(e) => setColumnsData({ ...columnsData, stack: e.target.value })}
          >
            <option value="0">{t('editor.columns_never')}</option>
            <option value="576">{t('editor.columns_mobile')}</option>
            <option value="768">{t('editor.columns_tablet')}</option>
            <option value="992">{t('editor.columns_desktop')}</option>
            <option value="9999">{t('editor.columns_always')}</option>
          </select>
          <small className="editor-modal-hint">{t('editor.columns_hint')}</small>
        </div>
      </ForumModal>

      {/* Table Modal */}
      <ForumModal
        show={showTableModal}
        onHide={() => closeModalWithFocus(setShowTableModal)}
        title={t('editor.table_modal_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => closeModalWithFocus(setShowTableModal)}>
              {t('editor.link_cancel')}
            </Button>
            <Button variant="primary" onClick={handleTableSubmit}>
              {t('editor.table_apply')}
            </Button>
          </>
        }
      >
        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="tableRows">{t('editor.table_rows_label')}</label>
          <select
            id="tableRows"
            className="editor-modal-select"
            value={tableData.rows}
            onChange={(e) => setTableData({ ...tableData, rows: parseInt(e.target.value) })}
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10">10</option>
          </select>
        </div>

        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="tableCols">{t('editor.table_cols_label')}</label>
          <select
            id="tableCols"
            className="editor-modal-select"
            value={tableData.cols}
            onChange={(e) => setTableData({ ...tableData, cols: parseInt(e.target.value) })}
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10">10</option>
          </select>
        </div>

        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="tableLayout">{t('editor.table_layout_label')}</label>
          <select
            id="tableLayout"
            className="editor-modal-select"
            value={tableData.layout}
            onChange={(e) => setTableData({ ...tableData, layout: e.target.value })}
          >
            <option value="auto">{t('editor.table_layout_auto')}</option>
            <option value="fixed">{t('editor.table_layout_fixed')}</option>
          </select>
        </div>

        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="tableWidth">{t('editor.table_width_label')}</label>
          <input
            id="tableWidth"
            type="text"
            className="editor-modal-input"
            value={tableData.width}
            onChange={(e) => setTableData({ ...tableData, width: e.target.value })}
            placeholder="100%"
          />
          <small className="editor-modal-hint">{t('editor.table_width_hint')}</small>
        </div>

        <div className="editor-modal-field">
          <label className="editor-modal-label" htmlFor="tableBorder">{t('editor.table_border_label')}</label>
          <input
            id="tableBorder"
            type="text"
            className="editor-modal-input"
            value={tableData.border}
            onChange={(e) => setTableData({ ...tableData, border: e.target.value })}
            placeholder="#cccccc"
          />
          <small className="editor-modal-hint">{t('editor.table_border_hint')}</small>
        </div>

        <div className="editor-modal-field editor-modal-field--checkbox">
          <input
            type="checkbox"
            id="tableNoBorders"
            className="topic-select-input"
            checked={tableData.noBorders}
            onChange={(e) => setTableData({ ...tableData, noBorders: e.target.checked })}
          />
          <label htmlFor="tableNoBorders">{t('editor.table_no_borders')}</label>
          <small className="editor-modal-hint">{t('editor.table_no_borders_hint')}</small>
        </div>
      </ForumModal>

      {/* Hotkeys Modal */}
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
        <p className="editor-hotkeys-hint">
          {t('editor.hotkeys_hint')}
        </p>

        {hotkeyGroups.map((group) => (
          <div key={group.title} className="editor-hotkeys-group">
            <h6 className="editor-hotkeys-group-title">{group.title}</h6>
            <div className="editor-hotkeys-list">
              {group.items.map((item) => (
                <React.Fragment key={item.keys}>
                  <kbd className="editor-hotkeys-key">{item.keys}</kbd>
                  <span className="editor-hotkeys-desc">{item.desc}</span>
                </React.Fragment>
              ))}
            </div>
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
        <div className="editor-modal-body">
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
        <div className="editor-more-tools-modal" onClick={(e) => {
          if (e.target.closest('.editor-overflow-item, button')) {
            setShowMoreToolsModal(false);
          }
        }}>
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
