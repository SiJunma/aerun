import React, { useRef, useState } from 'react';
import { Globe, Upload, Link2, X, Loader2 } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { resolveAvatarUrl } from '../../api/avatars';
import './FaviconUploader.css';

const MAX_FAVICON_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
]);
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.svg'];

const isValidFaviconFile = (file) => {
  if (file.type && ALLOWED_MIME_TYPES.has(file.type.toLowerCase())) {
    return true;
  }
  const lowerName = (file.name || '').toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
};

const isSafeUrlInput = (raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/')) return !trimmed.startsWith('//');
  return /^https?:\/\//i.test(trimmed);
};

/**
 * FaviconUploader handles both multipart file uploads (PNG, JPEG, WebP, GIF,
 * ICO, SVG up to 2 MB) and external/relative URL entry for global and design
 * favicons.
 */
const FaviconUploader = ({
  id,
  value = '',
  onChange = () => {},
  onUpload,
  onClear,
  disabled = false,
}) => {
  const fileInputRef = useRef(null);
  const { t } = useI18n();
  const [mode, setMode] = useState('preview'); // 'preview' | 'url'
  const [urlInput, setUrlInput] = useState(value || '');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [failedSrc, setFailedSrc] = useState('');

  const displaySrc = value
    ? (value.startsWith('blob:') ? value : resolveAvatarUrl(value))
    : '';
  const showImage = Boolean(displaySrc) && failedSrc !== displaySrc;

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!isValidFaviconFile(file)) {
      setError(t('admin.settings.favicon_error_type'));
      return;
    }
    if (file.size > MAX_FAVICON_BYTES) {
      setError(t('profile.error_file_size'));
      return;
    }

    setError('');
    setFailedSrc('');
    setUploading(true);
    try {
      if (typeof onUpload !== 'function') {
        throw new Error('no upload handler');
      }
      const nextUrl = await onUpload(file, file.name || 'favicon.png');
      if (!nextUrl) {
        throw new Error('upload returned empty favicon url');
      }
      onChange(nextUrl);
      setMode('preview');
    } catch (err) {
      console.error('[FaviconUploader] Upload error:', err);
      setError(t('profile.error_upload_failed'));
    } finally {
      setUploading(false);
    }
  };

  const handleUrlConfirm = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setError('');
      setFailedSrc('');
      if (typeof onClear === 'function') {
        onClear();
      } else {
        onChange('');
      }
      setMode('preview');
      return;
    }
    if (!isSafeUrlInput(trimmed)) {
      setError(t('admin.settings.favicon_error_url'));
      return;
    }
    setError('');
    setFailedSrc('');
    onChange(trimmed);
    setMode('preview');
  };

  const handleClearClick = () => {
    setError('');
    setFailedSrc('');
    setUrlInput('');
    if (typeof onClear === 'function') {
      onClear();
    } else {
      onChange('');
    }
  };

  return (
    <div className="favicon-uploader" id={id ? `${id}-wrapper` : undefined}>
      <div className="favicon-uploader__row">
        <div className="favicon-uploader__preview">
          {uploading ? (
            <Loader2 size={18} className="favicon-uploader__spin" aria-hidden="true" />
          ) : showImage ? (
            <img
              src={displaySrc}
              alt={t('admin.settings.favicon_preview_alt')}
              className="favicon-uploader__img"
              onError={() => setFailedSrc(displaySrc)}
            />
          ) : (
            <Globe size={18} aria-hidden="true" />
          )}
        </div>

        {mode === 'preview' ? (
          <div className="admin-actions">
            <button
              type="button"
              id={id}
              className="admin-btn admin-btn--secondary"
              disabled={disabled || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} aria-hidden="true" />
              <span>{t('profile.upload_file')}</span>
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--secondary"
              disabled={disabled || uploading}
              onClick={() => {
                setError('');
                setUrlInput(value && !value.startsWith('blob:') ? value : '');
                setMode('url');
              }}
            >
              <Link2 size={14} aria-hidden="true" />
              <span>{t('profile.by_url')}</span>
            </button>
            {Boolean(value) && (
              <button
                type="button"
                className="admin-btn admin-btn--secondary admin-btn--danger"
                disabled={disabled || uploading}
                onClick={handleClearClick}
              >
                <X size={14} aria-hidden="true" />
                <span>{t('admin.settings.favicon_clear')}</span>
              </button>
            )}
          </div>
        ) : (
          <div className="favicon-uploader__url-box">
            <input
              id={id}
              type="url"
              className="admin-form__control favicon-uploader__input"
              value={urlInput}
              placeholder="https://..."
              disabled={disabled || uploading}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  handleUrlConfirm();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setError('');
                  setMode('preview');
                }
              }}
            />
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              disabled={disabled || uploading}
              onClick={handleUrlConfirm}
            >
              OK
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--secondary"
              disabled={disabled || uploading}
              onClick={() => {
                setError('');
                setMode('preview');
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
      </div>

      <div className="admin-form__hint">
        {t('admin.settings.favicon_upload_help')}
      </div>

      {error && <div className="admin-form__error">{error}</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon,.ico,image/svg+xml,.svg"
        hidden
        onChange={handleFileChange}
      />
    </div>
  );
};

export default FaviconUploader;
