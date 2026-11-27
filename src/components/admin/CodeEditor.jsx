import React, { useMemo, useState, useEffect } from 'react';
import CodeMirror, { EditorState, EditorView } from '@uiw/react-codemirror';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { indentUnit } from '@codemirror/language';
import beautify from 'js-beautify';
import { Wand2 } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeProvider';
import { useI18n } from '../../contexts/I18nProvider';

const BEAUTIFY_OPTIONS = {
  indent_size: 2,
  indent_char: ' ',
  preserve_newlines: true,
  max_preserve_newlines: 2,
  wrap_line_length: 0,
  indent_inner_html: true,
};

function beautifyCode(language, value) {
  if (!value || !value.trim()) return value || '';
  if (language === 'css') return beautify.css(value, BEAUTIFY_OPTIONS);
  if (language === 'javascript') return beautify.js(value, BEAUTIFY_OPTIONS);
  if (language === 'html') return beautify.html(value, BEAUTIFY_OPTIONS);
  return value;
}

const themeBaseExtension = EditorView.theme({
  '&': {
    backgroundColor: 'var(--input-bg)',
    color: 'var(--input-text)',
    fontSize: '14px',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: '1.5',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--block-bg)',
    color: 'var(--secondary-color)',
    borderRight: '1px solid var(--border-color)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--block-bg)',
    color: 'var(--text-color)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(var(--primary-rgb), 0.05)',
  },
  '.cm-content': {
    caretColor: 'var(--text-color)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
});

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: false,
  indentOnInput: true,
  tabSize: 2,
};

const CodeEditor = ({
  id,
  language,
  value,
  onChange,
  label,
  onBeautify,
  error,
  placeholder = '',
  minHeight = '140px',
}) => {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [bodyTheme, setBodyTheme] = useState(
    () => (typeof document !== 'undefined' ? document.body.getAttribute('data-theme') : null) || 'dark'
  );

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const syncTheme = () => {
      setBodyTheme(document.body.getAttribute('data-theme') || 'dark');
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [theme]);

  const isDark = bodyTheme === 'dark';

  const extensions = useMemo(() => {
    const langExt =
      language === 'css'
        ? css()
        : language === 'javascript'
          ? javascript()
          : html();
    return [
      langExt,
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      themeBaseExtension,
    ];
  }, [language]);

  const handleBeautifyClick = () => {
    const formatted = beautifyCode(language, value);
    if (formatted !== value) {
      onChange(formatted);
    }
    if (onBeautify) {
      onBeautify(formatted);
    }
  };

  const errorMessage = typeof error === 'string' ? error : error?.message;
  const severity = typeof error === 'object' && error?.severity ? error.severity : 'error';

  return (
    <div
      className={`designs-code-field ${
        errorMessage ? `designs-code-field--${severity}` : ''
      }`}
    >
      <div className="designs-code-field__header">
        <label className="admin-form__label" htmlFor={id}>
          {label}
        </label>
        <button
          type="button"
          className="admin-btn admin-btn--secondary admin-btn--sm"
          onClick={handleBeautifyClick}
        >
          <Wand2 size={15} />
          <span>{t('admin.designs.beautify')}</span>
        </button>
      </div>

      <div className="designs-code-field__editor" id={id}>
        <CodeMirror
          value={value || ''}
          onChange={(val) => onChange(val)}
          theme={isDark ? 'dark' : 'light'}
          extensions={extensions}
          basicSetup={BASIC_SETUP}
          indentWithTab={true}
          placeholder={placeholder}
          minHeight={minHeight}
          maxHeight="340px"
        />
      </div>

      {errorMessage && (
        <div
          className={`admin-notice admin-notice--${severity}`}
          role="alert"
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
};

export default CodeEditor;
