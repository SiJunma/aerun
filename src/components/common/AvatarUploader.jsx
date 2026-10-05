import React, { useRef, useState } from 'react';
import { Image as BSImage, Button, Form, Spinner, InputGroup } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';
import { resolveAvatarUrl } from '../../api/avatars';

const isStorageEnabled = true;

/**
 * AvatarUploader
 * Props:
 *   value        – current avatar URL (string)
 *   onChange     – called with new URL when upload/URL change is confirmed
 *   onUpload     – async (blob, filename) => newUrl. REQUIRED for the file
 *                  picker: the component no longer fabricates a data URL,
 *                  because `avatar_url` is a 512-character text column and an
 *                  inline base64 image can never fit it.
 *   storagePath  – Storage path / identifier
 *   size         – preview circle size in px (default 80)
 *   label        – optional label text
 */
const AvatarUploader = ({ value, onChange, onUpload, _storagePath, size = 80, label, disabled = false, canUpload = true, allowGifs = true }) => {
  const fileInputRef = useRef(null);
  const { t } = useI18n();
  const [mode, setMode] = useState('preview'); // 'preview' | 'url'
  const [urlInput, setUrlInput] = useState(value || '');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const placeholderSrc = `https://ui-avatars.com/api/?name=?&background=666&color=fff&size=${size * 2}`;
  // The stored value may be a host-agnostic PocketBase file path (what the
  // avatar importer writes), so the preview resolves it; the value itself is
  // left untouched, because it is what gets saved.
  const displaySrc = resolveAvatarUrl(value) || placeholderSrc;

  const resizeImage = (file, minSide = 250) => {
    return new Promise((resolve) => {
      if (file.type === 'image/gif') {
        resolve(file);
        return;
      }

      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        let width = img.width;
        let height = img.height;

        const shorterSide = Math.min(width, height);
        if (shorterSide > minSide) {
          const ratio = minSide / shorterSide;
          width *= ratio;
          height *= ratio;
        } else {
          resolve(file);
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            resolve(file);
          }
        }, file.type, 0.85);
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        resolve(file);
      };
    });
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_SIZE_MB = 2;
    const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
    const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
    if (allowGifs) ALLOWED_TYPES.push('image/gif');

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError(allowGifs ? 'Only PNG, JPG, WebP, and GIF images are allowed.' : 'Only PNG, JPG, and WebP images are allowed.');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`${t('profile.error_file_size') || 'File is too large'} (Max ${MAX_SIZE_MB}MB)`);
      return;
    }

    setError('');
    setUploading(true);
    setProgress(50);

    try {
      // resizeImage returns a Blob (a File is passed through for GIFs, which
      // are not re-encoded so animation survives). The bytes go to the server
      // as multipart; the response carries the new avatar_url, which is what
      // gets committed to state.
      const uploadData = await resizeImage(file);
      setProgress(80);

      if (typeof onUpload !== 'function') {
        throw new Error('no upload handler');
      }
      const newUrl = await onUpload(uploadData, file.name || 'avatar.png');
      if (!newUrl) {
        throw new Error('upload returned no avatar url');
      }

      onChange(newUrl);
      setProgress(100);
      setUploading(false);
      setMode('preview');
    } catch (err) {
      console.error('[AvatarUploader] Upload error:', err);
      setUploading(false);
      setProgress(0);
      setError(
        err?.message === 'no upload handler'
          ? 'Avatar upload is not available here yet.'
          : (t('profile.error_upload_failed') || 'Upload failed')
      );
    }

    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  const handleUrlConfirm = () => {
    const lower = urlInput.toLowerCase().split('?')[0]; // strip query params
    const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
    if (allowGifs) ALLOWED_EXTENSIONS.push('.gif');
    if (!ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
      setError(allowGifs ? 'Only PNG, JPG, WebP, and GIF URLs are allowed.' : 'Only PNG, JPG, and WebP URLs are allowed.');
      return;
    }
    setError('');
    onChange(urlInput);
    setMode('preview');
  };

  return (
    <div className="d-flex flex-column align-items-start gap-2 mb-2">
      {label && <div className="fw-bold small">{label}</div>}

      {/* Preview */}
      <div className="position-relative" style={{ width: size, height: size }}>
        {uploading ? (
          <div
            className="d-flex flex-column align-items-center justify-content-center rounded-circle bg-secondary text-white"
            style={{ width: size, height: size, fontSize: '0.7rem' }}
          >
            <Spinner animation="border" size="sm" className="mb-1" />
            {progress}%
          </div>
        ) : (
          <BSImage
            src={displaySrc}
            roundedCircle
            style={{ width: size, height: size, objectFit: 'cover' }}
            onError={(e) => { e.target.onerror = null; e.target.src = placeholderSrc; }}
          />
        )}
      </div>

      {/* Controls */}
      {mode === 'preview' && !disabled && (
        <>
          <div className="d-flex gap-2">
            {canUpload && isStorageEnabled && (
              <Button
                variant="outline-secondary"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                📁 {t('profile.upload_file')}
              </Button>
            )}
            <Button
              variant="outline-secondary"
              size="sm"
              disabled={uploading}
              onClick={() => { setUrlInput(value || ''); setMode('url'); }}
            >
              🔗 {t('profile.by_url')}
            </Button>
          </div>
          {canUpload && (
            <div className="text-muted" style={{ fontSize: '0.7rem', opacity: 0.8 }}>
              {t('profile.avatar_help', { size: 2 })}
            </div>
          )}
        </>
      )}

      {mode === 'url' && (
        <div className="d-flex flex-column gap-2 w-100" style={{ maxWidth: 360 }}>
          <Form.Control
            type="url"
            value={urlInput}
            autoFocus
            placeholder="https://..."
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleUrlConfirm(); if (e.key === 'Escape') setMode('preview'); }}
            className="form-control-sm"
          />
          <div className="d-flex gap-2">
            <Button variant="primary" size="sm" onClick={handleUrlConfirm} className="px-3">
              OK
            </Button>
            <Button variant="outline-secondary" size="sm" onClick={() => setMode('preview')} className="px-3">
              {t('common.cancel') || '✕'}
            </Button>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={allowGifs ? "image/png, image/jpeg, image/webp, image/gif" : "image/png, image/jpeg, image/webp"}
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {error && <div className="text-danger small">{error}</div>}
    </div>
  );
};

export default AvatarUploader;
