import React, { useRef, useState } from 'react';
import { Image as BSImage, Button, Form, Spinner, InputGroup } from 'react-bootstrap';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { storage, isStorageEnabled } from '../../../firebase';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * AvatarUploader
 * Props:
 *   value        – current avatar URL (string)
 *   onChange     – called with new URL when upload/URL change is confirmed
 *   storagePath  – Firebase Storage path, e.g. "users/uid/avatar"
 *   size         – preview circle size in px (default 80)
 *   label        – optional label text
 */
const AvatarUploader = ({ value, onChange, storagePath, size = 80, label, disabled = false, canUpload = true, allowGifs = true }) => {
  const fileInputRef = useRef(null);
  const { t } = useI18n();
  const [mode, setMode] = useState('preview'); // 'preview' | 'url'
  const [urlInput, setUrlInput] = useState(value || '');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const placeholderSrc = `https://ui-avatars.com/api/?name=?&background=666&color=fff&size=${size * 2}`;
  const displaySrc = value || placeholderSrc;

  const resizeImage = (file, minSide = 250) => {
    return new Promise((resolve) => {
      // GIF resizing is complex in JS, usually better to skip or use a lib.
      // If it's a GIF and allowGifs is true, we'll just upload as is to preserve animation.
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
          // If already small enough, just return original file
          resolve(file);
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // Use better image smoothing
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            resolve(file); // Fallback to original
          }
        }, file.type, 0.85);
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        resolve(file); // Fallback
      };
    });
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate — PNG/JPG/WebP/GIF
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
    setProgress(0);

    try {
      const uploadData = await resizeImage(file);
      const storageRef = ref(storage, storagePath);
      const uploadTask = uploadBytesResumable(storageRef, uploadData);

      uploadTask.on(
        'state_changed',
        (snapshot) => {
          setProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
        },
        (err) => {
          console.error('[AvatarUploader]', err);
          setError(t('profile.error_upload_failed'));
          setUploading(false);
        },
        async () => {
          const url = await getDownloadURL(uploadTask.snapshot.ref);
          onChange(url);
          setUploading(false);
          setMode('preview');
        }
      );
    } catch (err) {
      console.error('[AvatarUploader] Resize error:', err);
      setUploading(false);
      setError(t('profile.error_upload_failed'));
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
