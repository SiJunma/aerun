import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useI18n } from '../../contexts/I18nProvider';
import { validateCode } from './codeValidation';

// CodeMirror stays lazy inside CodeEditor; this field never imports it
// directly, so the editor bundle still loads on demand.
const CodeEditor = lazy(() => import('./CodeEditor'));

/**
 * CodeEditorField — a CodeEditor with its syntax validation wired in.
 *
 * Props: language ('html' | 'css' | 'javascript'), id, label, value,
 * onChange, onValidityChange, minHeight. Validation runs on every value
 * change (including Beautify, which flows through onChange) and on mount,
 * so a form opened with an already-invalid value reports it at once. The
 * error (with line number) renders under the field; validity is reported
 * outward so the owning form can block Save. A CSS warning does NOT make
 * the field invalid — only error-severity results do.
 *
 * onValidityChange is read through a ref: the parent passes a state setter
 * wrapper, and an effect that re-ran on every fresh callback identity would
 * loop. The ref always holds the latest callback without re-running.
 */
const CodeEditorField = ({
  id,
  language,
  label,
  value,
  onChange,
  onValidityChange,
  minHeight,
}) => {
  const { t } = useI18n();
  const [error, setError] = useState(null);
  const validityRef = useRef(onValidityChange);
  validityRef.current = onValidityChange;

  useEffect(() => {
    const result = validateCode(language, value || '', t);
    setError(result);
    if (validityRef.current) {
      validityRef.current(!result || result.severity !== 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, language]);

  return (
    <Suspense fallback={<div className="designs-code-skeleton">{t('common.loading')}</div>}>
      <CodeEditor
        id={id}
        language={language}
        label={label}
        value={value}
        onChange={onChange}
        onBeautify={(formatted) => {
          // Beautify flows through onChange, which re-validates via the
          // effect above; the explicit call covers a beautify that leaves
          // the value unchanged. CodeEditor passes the formatted text.
          const result = validateCode(language, formatted ?? value ?? '', t);
          setError(result);
          if (validityRef.current) {
            validityRef.current(!result || result.severity !== 'error');
          }
        }}
        error={error}
        minHeight={minHeight}
      />
    </Suspense>
  );
};

export default CodeEditorField;

export const HtmlEditorField = (props) => <CodeEditorField {...props} language="html" />;
export const CssEditorField = (props) => <CodeEditorField {...props} language="css" />;
export const JsEditorField = (props) => <CodeEditorField {...props} language="javascript" />;
