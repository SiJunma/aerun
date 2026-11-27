import React, { useState, useCallback, useRef } from 'react';
import { PlusCircle, Edit2, Trash2, Copy, Eye, EyeOff, Palette, Upload, X, Image as ImageIcon } from 'lucide-react';
import ForumModal from '../common/ForumModal';
import ConfirmModal from '../common/ConfirmModal';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import { useAuth } from '../../contexts/AuthProvider';
import {
  createDesign,
  updateDesign,
  deleteDesign,
  uploadDesignFavicon,
  uploadDesignBackground,
  uploadDesignPlaceholder,
  updateDefaultDesign,
  uploadDefaultDesignBackground,
  uploadDefaultDesignPlaceholder,
  uploadDefaultDesignFavicon,
  resolveDesignBaseTheme,
  loadDesignForEdit,
} from '../../api/designs';
import { uploadSettingsFavicon, uploadIdentityPlaceholder } from '../../api/admin';
import { validateCode } from './codeValidation';
import { sanitizeHtml } from '../../utils/text';
import { resolveAvatarUrl } from '../../api/avatars';
import FaviconUploader from './FaviconUploader';
import AvatarUploader from '../common/AvatarUploader';
import CodeEditorField from './CodeEditorField';
import './DesignsTab.css';

const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024;

const DEFAULT_FORM = {
  name: '',
  faviconUrl: '',
  forumTitle: '',
  headerHtml: '',
  customFooterHtml: '',
  css: '',
  js: '',
  baseTheme: 'dark',
  showInList: false,
  isActive: false,
  overwriteHeader: false,
  overwriteFooter: false,
  overwriteTitle: false,
  overwriteFavicon: false,
  overwriteCss: false,
  overwriteJs: false,
  overwritePlaceholderDeleted: false,
  overwritePlaceholderGuest: false,
  bgDefaultUrl: '',
  bgTabletUrl: '',
  bgMobileUrl: '',
  placeholderDeletedUrl: '',
  placeholderGuestUrl: '',
};

const BG_FIELD_BY_KIND = {
  default: 'bgDefaultUrl',
  tablet: 'bgTabletUrl',
  mobile: 'bgMobileUrl',
};

// Upload-only image field for a card background variant: preview thumbnail
// with a link to the full size, an upload button and a clear button. No URL
// entry (backgrounds are uploads only) and a 10 MB client-side limit.
const BackgroundUploadField = ({ id, label, value, onUpload, onClear, disabled }) => {
  const { t } = useI18n();
  const inputRef = useRef(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  const displaySrc = value
    ? (value.startsWith('blob:') ? value : (resolveAvatarUrl(value) || value))
    : '';

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BACKGROUND_BYTES) {
      setError(t('admin.designs.background_size_error'));
      return;
    }
    setError('');
    setUploading(true);
    try {
      await onUpload(file, file.name || 'background.png');
    } catch (err) {
      console.error('[BackgroundUploadField] Upload error:', err);
      setError(t('profile.error_upload_failed'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="admin-form__group">
      <span className="admin-form__label">{label}</span>
      <div className="admin-actions admin-actions--wide">
        <div className="designs-bg-field__preview">
          {displaySrc ? (
            <a href={displaySrc} target="_blank" rel="noreferrer" title={t('admin.designs.background_view')}>
              <img src={displaySrc} alt="" className="designs-bg-field__img" />
            </a>
          ) : (
            <ImageIcon size={18} aria-hidden="true" />
          )}
        </div>
        <div className="admin-actions">
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={14} aria-hidden="true" />
            <span>{uploading ? t('common.loading') : t('admin.designs.background_upload')}</span>
          </button>
          {displaySrc && (
            <a
              className="admin-btn admin-btn--ghost admin-btn--sm"
              href={displaySrc}
              target="_blank"
              rel="noreferrer"
            >
              {t('admin.designs.background_view')}
            </a>
          )}
          {Boolean(value) && (
            <button
              type="button"
              className="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
              disabled={disabled || uploading}
              onClick={onClear}
            >
              <X size={14} aria-hidden="true" />
              <span>{t('admin.designs.background_clear')}</span>
            </button>
          )}
        </div>
      </div>
      {error && <div className="admin-form__error">{error}</div>}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/*"
        className="designs-bg-field__input"
        onChange={handleFileChange}
      />
    </div>
  );
};

// One overwritable field: a switch ("use this card's own value") above the
// field itself. Switch OFF hides the field entirely — its value stays stored
// but the resolver falls back to surface 1 instead. No greyed-out field and
// no repetitive "off" hint under every toggle: the switch label says what
// switching it on does.
const OverwriteField = ({ label, overwrite, onToggle, children }) => {
  return (
    <div className="admin-form__group">
      <label className="admin-switch">
        <input
          type="checkbox"
          className="admin-switch__input"
          checked={Boolean(overwrite)}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      {overwrite ? children : null}
    </div>
  );
};

const DesignsTab = ({ surface = 'all', designs, defaultDesigns = [], settings, setSettings, updateSettings }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  // The forum-settings updater arrives as the `updateSettings` prop; the
  // viewer's OWN theme goes through AuthProvider's updateSettings instead.
  const { updateSettings: updateMySettings } = useAuth();

  const [showModal, setShowModal] = useState(false);
  // { kind: 'custom' | 'default', id, key? } — null when creating a custom design.
  const [editingTarget, setEditingTarget] = useState(null);
  // True while the modal waits for the FULL record (see handleOpenModal).
  const [modalLoading, setModalLoading] = useState(false);
  // Guards the async open: a close (or a second open) while a fetch is in
  // flight must not let the late answer fill the form afterwards.
  const openNonceRef = useRef(0);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [nameAttempted, setNameAttempted] = useState(false);
  const [fieldValidity, setFieldValidity] = useState({});
  const [pendingFavicon, setPendingFavicon] = useState(null);
  const [faviconPreview, setFaviconPreview] = useState('');
  const [pendingBg, setPendingBg] = useState({});
  const [pendingPlaceholders, setPendingPlaceholders] = useState({});
  const [s1Validity, setS1Validity] = useState({});
  const [s1Saving, setS1Saving] = useState(false);

  const setValidity = useCallback((field) => (valid) => {
    setFieldValidity((prev) => (prev[field] === valid ? prev : { ...prev, [field]: valid }));
  }, []);
  const setS1ValidityFor = useCallback((field) => (valid) => {
    setS1Validity((prev) => (prev[field] === valid ? prev : { ...prev, [field]: valid }));
  }, []);

  const resetFaviconStaging = () => {
    setPendingFavicon(null);
    setFaviconPreview((prev) => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      return '';
    });
  };

  const resetPendingUploads = () => {
    Object.values(pendingBg).forEach((entry) => {
      if (entry?.url?.startsWith('blob:')) URL.revokeObjectURL(entry.url);
    });
    Object.values(pendingPlaceholders).forEach((entry) => {
      if (entry?.url?.startsWith('blob:')) URL.revokeObjectURL(entry.url);
    });
    setPendingBg({});
    setPendingPlaceholders({});
  };

  const [confirmState, setConfirmState] = useState({
    show: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const [deactivateModal, setDeactivateModal] = useState({
    show: false,
    designIdToDeactivate: null,
    replacementId: '',
  });

  const formFromCard = (card) => ({
    name: card.name || '',
    faviconUrl: card.faviconUrl || '',
    forumTitle: card.forumTitle || '',
    headerHtml: card.headerHtml || '',
    customFooterHtml: card.customFooterHtml || '',
    css: card.css || '',
    js: card.js || '',
    baseTheme: card.baseTheme || resolveDesignBaseTheme(card, settings),
    showInList: Boolean(card.showInList),
    isActive: card.isDefaultDesign ? true : Boolean(card.isActive),
    overwriteHeader: Boolean(card.overwriteHeader),
    overwriteFooter: Boolean(card.overwriteFooter),
    overwriteTitle: Boolean(card.overwriteTitle),
    overwriteFavicon: Boolean(card.overwriteFavicon),
    overwriteCss: Boolean(card.overwriteCss),
    overwriteJs: Boolean(card.overwriteJs),
    overwritePlaceholderDeleted: Boolean(card.overwritePlaceholderDeleted),
    overwritePlaceholderGuest: Boolean(card.overwritePlaceholderGuest),
    bgDefaultUrl: card.bgDefaultUrl || '',
    bgTabletUrl: card.bgTabletUrl || '',
    bgMobileUrl: card.bgMobileUrl || '',
    placeholderDeletedUrl: card.placeholderDeletedUrl || '',
    placeholderGuestUrl: card.placeholderGuestUrl || '',
  });

  // The cards this tab renders are LIST SUMMARIES (id/name/show_in_list/
  // bg_default_url/is_active/base_theme) — they carry no css/js/header/
  // footer/title/favicon/placeholder/overwrite fields. The modal therefore
  // never builds its form from the card: on open it loads the FULL record
  // with one single-record GET via loadDesignForEdit, cached in
  // sessionStorage for the session (a second open reuses the cached copy
  // with no refetch; a successful save overwrites it). While the record
  // loads the modal shows a loading state and the Save button stays off.
  const handleOpenModal = (target = null) => {
    setNameAttempted(false);
    setFieldValidity({});
    resetFaviconStaging();
    resetPendingUploads();
    if (!target) {
      setEditingTarget(null);
      setModalLoading(false);
      setForm({ ...DEFAULT_FORM, baseTheme: resolveDesignBaseTheme(null, settings) });
      setShowModal(true);
      return;
    }
    const nonce = ++openNonceRef.current;
    setEditingTarget(target);
    setModalLoading(true);
    setForm({ ...DEFAULT_FORM, baseTheme: resolveDesignBaseTheme(target.card, settings) });
    setShowModal(true);
    loadDesignForEdit(target.kind, target.kind === 'default' ? target.key : target.id)
      .then(({ design }) => {
        if (nonce !== openNonceRef.current) return;
        if (!design) {
          showToast(t('admin.designs.error_save'), 'danger');
          setShowModal(false);
          return;
        }
        setForm(formFromCard(design));
      })
      .catch((err) => {
        console.error(err);
        if (nonce !== openNonceRef.current) return;
        showToast(t('admin.designs.error_save'), 'danger');
        setShowModal(false);
      })
      .finally(() => {
        if (nonce === openNonceRef.current) setModalLoading(false);
      });
  };

  const handleCloseModal = () => {
    openNonceRef.current++;
    resetFaviconStaging();
    resetPendingUploads();
    setShowModal(false);
  };

  const isDefaultTarget = editingTarget?.kind === 'default';

  const handleFaviconUpload = async (blob, filename) => {
    if (!editingTarget) {
      const objectUrl = URL.createObjectURL(blob);
      setPendingFavicon({ blob, filename });
      setFaviconPreview((prev) => {
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
        return objectUrl;
      });
      return objectUrl;
    }
    const url = isDefaultTarget
      ? await uploadDefaultDesignFavicon(editingTarget.key, blob, filename)
      : await uploadDesignFavicon(editingTarget.id, blob, filename);
    resetFaviconStaging();
    setForm((prev) => ({ ...prev, faviconUrl: url }));
    return url;
  };

  const handleBackgroundUpload = async (kind, blob, filename) => {
    const field = BG_FIELD_BY_KIND[kind];
    if (!editingTarget) {
      const objectUrl = URL.createObjectURL(blob);
      setPendingBg((prev) => {
        const old = prev[kind];
        if (old?.url?.startsWith('blob:')) URL.revokeObjectURL(old.url);
        return { ...prev, [kind]: { blob, filename, url: objectUrl } };
      });
      setForm((prev) => ({ ...prev, [field]: objectUrl }));
      return objectUrl;
    }
    const url = isDefaultTarget
      ? await uploadDefaultDesignBackground(editingTarget.key, kind, blob, filename)
      : await uploadDesignBackground(editingTarget.id, kind, blob, filename);
    setForm((prev) => ({ ...prev, [field]: url }));
    return url;
  };

  const handleBackgroundClear = (kind) => {
    const field = BG_FIELD_BY_KIND[kind];
    setPendingBg((prev) => {
      const old = prev[kind];
      if (old?.url?.startsWith('blob:')) URL.revokeObjectURL(old.url);
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    setForm((prev) => ({ ...prev, [field]: '' }));
  };

  // Card placeholders go through AvatarUploader (same component the Settings
  // tab uses for the surface-1 placeholders). For a card that does not exist
  // yet the file is staged until the card is created.
  const handlePlaceholderUpload = async (kind, blob, filename) => {
    const field = kind === 'guest' ? 'placeholderGuestUrl' : 'placeholderDeletedUrl';
    if (!editingTarget) {
      const objectUrl = URL.createObjectURL(blob);
      setPendingPlaceholders((prev) => {
        const old = prev[kind];
        if (old?.url?.startsWith('blob:')) URL.revokeObjectURL(old.url);
        return { ...prev, [kind]: { blob, filename, url: objectUrl } };
      });
      setForm((prev) => ({ ...prev, [field]: objectUrl }));
      return objectUrl;
    }
    const url = isDefaultTarget
      ? await uploadDefaultDesignPlaceholder(editingTarget.key, kind, blob, filename)
      : await uploadDesignPlaceholder(editingTarget.id, kind, blob, filename);
    setForm((prev) => ({ ...prev, [field]: url }));
    return url;
  };

  const handlePlaceholderClear = (kind) => {
    const field = kind === 'guest' ? 'placeholderGuestUrl' : 'placeholderDeletedUrl';
    setPendingPlaceholders((prev) => {
      const old = prev[kind];
      if (old?.url?.startsWith('blob:')) URL.revokeObjectURL(old.url);
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    setForm((prev) => ({ ...prev, [field]: '' }));
  };

  const handleSave = async () => {
    setNameAttempted(true);
    const trimmedName = form.name.trim();
    if (!trimmedName) return;

    // Backstop re-validation at save time: the fields also report validity
    // live through CodeEditorField, but a value that never changed since the
    // modal opened must still block the save. Only fields whose overwrite
    // switch is ON are validated — a hidden field's stored value is unused
    // (surface 1 applies instead) and must not block the save.
    const headerError = form.overwriteHeader ? validateCode('html', form.headerHtml, t) : null;
    const footerError = form.overwriteFooter ? validateCode('html', form.customFooterHtml, t) : null;
    const jsError = form.overwriteJs ? validateCode('javascript', form.js, t) : null;
    if (headerError || footerError || jsError) {
      showToast(t('admin.designs.validation_save_blocked'), 'danger');
      return;
    }

    try {
      if (isDefaultTarget) {
        await updateDefaultDesign(editingTarget.key, { ...form, name: trimmedName });
      } else if (editingTarget) {
        await updateDesign(editingTarget.id, {
          ...form,
          name: trimmedName,
          showInList: form.isActive ? Boolean(form.showInList) : false,
        });
      } else {
        // Staged uploads carry blob: preview URLs — never send those to the
        // server. The payload starts empty for staged fields; the real URLs
        // are patched in right after the create, below.
        const payload = {
          ...form,
          name: trimmedName,
          showInList: false,
          faviconUrl: pendingFavicon ? '' : form.faviconUrl,
        };
        Object.entries(pendingBg).forEach(([kind, _entry]) => {
          payload[BG_FIELD_BY_KIND[kind]] = '';
        });
        Object.entries(pendingPlaceholders).forEach(([kind, _entry]) => {
          payload[kind === 'guest' ? 'placeholderGuestUrl' : 'placeholderDeletedUrl'] = '';
        });
        const newId = await createDesign(payload);
        const uploaded = {};
        if (pendingFavicon && newId) {
          try {
            uploaded.faviconUrl = await uploadDesignFavicon(newId, pendingFavicon.blob, pendingFavicon.filename);
          } catch (uploadErr) {
            console.error(uploadErr);
            showToast(t('profile.error_upload_failed'), 'danger');
          }
        }
        for (const [kind, entry] of Object.entries(pendingBg)) {
          try {
            uploaded[BG_FIELD_BY_KIND[kind]] = await uploadDesignBackground(newId, kind, entry.blob, entry.filename);
          } catch (uploadErr) {
            console.error(uploadErr);
            showToast(t('profile.error_upload_failed'), 'danger');
          }
        }
        for (const [kind, entry] of Object.entries(pendingPlaceholders)) {
          try {
            uploaded[kind === 'guest' ? 'placeholderGuestUrl' : 'placeholderDeletedUrl'] = await uploadDesignPlaceholder(newId, kind, entry.blob, entry.filename);
          } catch (uploadErr) {
            console.error(uploadErr);
            showToast(t('profile.error_upload_failed'), 'danger');
          }
        }
        if (Object.keys(uploaded).length > 0) {
          await updateDesign(newId, uploaded);
        }
      }
      resetFaviconStaging();
      resetPendingUploads();
      showToast(t('admin.designs.toast_saved'), 'success');
      setShowModal(false);
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const handleClone = async (design) => {
    try {
      // A clone needs the FULL record — the card is a list summary and
      // cloning from it would silently drop the css/js/header/footer and
      // every other full-only field. One single-record GET (cached).
      const { design: full } = await loadDesignForEdit('custom', design.id);
      if (!full) {
        showToast(t('admin.designs.error_save'), 'danger');
        return;
      }
      // The description field was removed from the modal (F): a clone must
      // not carry the stale, now uneditable value along.
      const { id: _id, description: _description, ...data } = full;
      await createDesign({
        ...data,
        name: `${data.name} (Copy)`,
        isActive: false,
        showInList: false,
      });
      showToast(t('admin.designs.toast_saved'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const handleDelete = (design) => {
    if (design.isActive || settings.defaultDesignId === design.id) {
      showToast(t('admin.designs.cant_delete_active'), 'warning');
      return;
    }

    setConfirmState({
      show: true,
      title: t('admin.designs.confirm_delete_title'),
      message: t('admin.designs.confirm_delete_message'),
      onConfirm: async () => {
        try {
          await deleteDesign(design.id);
          showToast(t('admin.designs.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.designs.error_delete'), 'danger');
        }
      },
    });
  };

  const initiateDeactivate = (designId) => {
    if (settings.defaultDesignId === designId) {
      const available = designs.filter((d) => d.id !== designId && d.isActive);
      setDeactivateModal({
        show: true,
        designIdToDeactivate: designId,
        replacementId: available.length > 0 ? available[0].id : '',
      });
    } else {
      updateDesign(designId, { isActive: false, showInList: false }).catch(console.error);
    }
  };

  const handleConfirmDeactivate = async () => {
    const { designIdToDeactivate, replacementId } = deactivateModal;
    try {
      await updateDesign(designIdToDeactivate, { isActive: false, showInList: false });
      if (settings.defaultDesignId === designIdToDeactivate) {
        await updateSettings({ ...settings, defaultDesignId: replacementId });
      }
      setDeactivateModal({ show: false, designIdToDeactivate: null, replacementId: '' });
      showToast(t('admin.designs.toast_saved'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const toggleActivate = async (design) => {
    if (design.isActive) {
      initiateDeactivate(design.id);
    } else {
      try {
        await updateDesign(design.id, { isActive: true });
        showToast(t('admin.designs.toast_saved'), 'success');
      } catch (err) {
        console.error(err);
        showToast(t('admin.designs.error_save'), 'danger');
      }
    }
  };

  const toggleDefaultShowInList = async (card) => {
    try {
      await updateDefaultDesign(card.key, { showInList: !card.showInList });
      showToast(t('admin.designs.toast_saved'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const handlePreview = (designId) => {
    window.open(`/?preview_design=${designId}`, '_blank');
  };

  // ── B2: see / apply the design being edited, from the modal ─────────────
  // The theme value is the built-in key ('dark'/'light'/'neutral') for a
  // built-in card and the record id for a custom one. Applying a design only
  // makes sense when it can actually render: built-in cards always can, a
  // custom design only while it is active (an inactive one falls back to the
  // forum default, so offering the buttons would silently do nothing).
  const modalThemeValue = isDefaultTarget ? editingTarget?.key : editingTarget?.id;
  const canApplyModalDesign = Boolean(editingTarget) && (isDefaultTarget || form.isActive);

  const handleSetAsMyTheme = async () => {
    if (!modalThemeValue) return;
    try {
      await updateMySettings({ theme: modalThemeValue });
      showToast(t('admin.designs.toast_theme_set'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const handleSetAsForumDefault = async () => {
    if (!modalThemeValue) return;
    try {
      const next = { ...settings, defaultDesignId: modalThemeValue };
      await updateSettings(next);
      setSettings((prev) => ({ ...prev, defaultDesignId: modalThemeValue }));
      showToast(t('admin.designs.toast_default_set'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const showInListDisabled = !isDefaultTarget && (!editingTarget || !form.isActive);
  const nameInvalid = nameAttempted && !form.name.trim();
  // Only overwrite-ON fields can block the save: a hidden field's stored
  // value is unused (surface 1 applies instead).
  const saveBlocked = (form.overwriteHeader && fieldValidity.header === false)
    || (form.overwriteFooter && fieldValidity.footer === false)
    || (form.overwriteJs && fieldValidity.js === false);

  // ── Surface 1: default settings (the fallback for every card) ──────────
  // Edits write straight into AdminPage's settings draft (the same pattern
  // as the Settings tab); Save PATCHes the whole snapshot via updateSettings.
  const sanitizedFooterPreview = sanitizeHtml(settings?.customFooterHtml || '') || '';

  const handleSaveDefaults = async () => {
    const headerError = validateCode('html', settings?.headerHtml || '', t);
    const footerError = validateCode('html', settings?.customFooterHtml || '', t);
    if (headerError || footerError || s1Validity.header === false || s1Validity.footer === false) {
      showToast(t('admin.designs.validation_save_blocked'), 'danger');
      return;
    }
    setS1Saving(true);
    try {
      await updateSettings(settings);
      showToast(t('admin.settings.success'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.settings.error'), 'danger');
    } finally {
      setS1Saving(false);
    }
  };

  const handleUploadSettingsFavicon = async (blob, filename) => {
    const url = await uploadSettingsFavicon(blob, filename);
    if (url) {
      setSettings((prev) => ({ ...prev, faviconUrl: url }));
    }
    return url;
  };

  const handleClearSettingsFavicon = async () => {
    try {
      await updateSettings({ faviconUrl: '' });
      setSettings((prev) => ({ ...prev, faviconUrl: '' }));
    } catch (err) {
      console.error(err);
      showToast(t('admin.settings.error'), 'danger');
    }
  };

  const handleUploadSettingsPlaceholder = async (kind, blob, filename) => {
    const url = await uploadIdentityPlaceholder(kind, blob, filename);
    if (url) {
      setSettings((prev) => ({ ...prev, [kind === 'guest' ? 'guestAvatar' : 'deletedAvatar']: url }));
    }
    return url;
  };

  const handleResetSettingsPlaceholder = async (kind) => {
    const key = kind === 'guest' ? 'guestAvatar' : 'deletedAvatar';
    setS1Saving(true);
    try {
      await updateSettings({ [key]: '' });
      setSettings((prev) => ({ ...prev, [key]: '' }));
      showToast(t('admin.settings.success'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.settings.error'), 'danger');
    } finally {
      setS1Saving(false);
    }
  };

  const renderSurface1 = () => (
    <section className="designs-surface" aria-label={t('admin.designs.defaults_title')}>
      <h4 className="admin-subtitle">{t('admin.designs.defaults_title')}</h4>
      <p className="admin-form__hint">{t('admin.designs.defaults_desc')}</p>
      <div className="admin-form">
        <div className="admin-form__group">
          <label className="admin-form__label" htmlFor="defaults-forum-title">
            {t('admin.designs.modal_title')}
          </label>
          <input
            id="defaults-forum-title"
            type="text"
            className="admin-form__control"
            value={settings?.forumName || ''}
            onChange={(e) => setSettings((prev) => ({ ...prev, forumName: e.target.value }))}
          />
        </div>

        <CodeEditorField
          id="defaults-header"
          language="html"
          label={t('admin.designs.modal_header')}
          value={settings?.headerHtml || ''}
          onChange={(val) => setSettings((prev) => ({ ...prev, headerHtml: val }))}
          onValidityChange={setS1ValidityFor('header')}
          minHeight="120px"
        />

        <CodeEditorField
          id="defaults-footer"
          language="html"
          label={t('admin.designs.modal_footer')}
          value={settings?.customFooterHtml || ''}
          onChange={(val) => setSettings((prev) => ({ ...prev, customFooterHtml: val }))}
          onValidityChange={setS1ValidityFor('footer')}
          minHeight="120px"
        />
        <div className="admin-form__group">
          <span className="admin-form__label">{t('admin.designs.footer_preview')}</span>
          {sanitizedFooterPreview ? (
            <div className="designs-preview" dangerouslySetInnerHTML={{ __html: sanitizedFooterPreview }} />
          ) : (
            <div className="designs-preview designs-preview--empty">{t('admin.designs.footer_preview_empty')}</div>
          )}
        </div>

        <div className="admin-form__group">
          <label className="admin-form__label" htmlFor="defaults-favicon">
            {t('admin.designs.modal_favicon')}
          </label>
          <FaviconUploader
            id="defaults-favicon"
            value={settings?.faviconUrl || ''}
            onUpload={handleUploadSettingsFavicon}
            onChange={(url) => setSettings((prev) => ({ ...prev, faviconUrl: url }))}
            onClear={handleClearSettingsFavicon}
            disabled={s1Saving}
          />
        </div>

        <div className="designs-form__row">
          <div className="admin-form__group">
            <label className="admin-form__label" htmlFor="defaults-placeholder-deleted">
              {t('admin.settings.placeholder_deleted')}
            </label>
            <AvatarUploader
              value={settings?.deletedAvatar || ''}
              onChange={(url) => setSettings((prev) => ({ ...prev, deletedAvatar: url }))}
              onUpload={(blob, filename) => handleUploadSettingsPlaceholder('deleted', blob, filename)}
              allowGifs={settings?.allowGifAvatars !== false}
              size={80}
              canUpload
              disabled={s1Saving}
            />
            {settings?.deletedAvatar && (
              <button
                type="button"
                className="admin-btn admin-btn--secondary admin-btn--sm"
                onClick={() => handleResetSettingsPlaceholder('deleted')}
                disabled={s1Saving}
              >
                {t('admin.settings.placeholder_reset')}
              </button>
            )}
          </div>
          <div className="admin-form__group">
            <label className="admin-form__label" htmlFor="defaults-placeholder-guest">
              {t('admin.settings.placeholder_guest')}
            </label>
            <AvatarUploader
              value={settings?.guestAvatar || ''}
              onChange={(url) => setSettings((prev) => ({ ...prev, guestAvatar: url }))}
              onUpload={(blob, filename) => handleUploadSettingsPlaceholder('guest', blob, filename)}
              allowGifs={settings?.allowGifAvatars !== false}
              size={80}
              canUpload
              disabled={s1Saving}
            />
            {settings?.guestAvatar && (
              <button
                type="button"
                className="admin-btn admin-btn--secondary admin-btn--sm"
                onClick={() => handleResetSettingsPlaceholder('guest')}
                disabled={s1Saving}
              >
                {t('admin.settings.placeholder_reset')}
              </button>
            )}
          </div>
        </div>

        <div className="admin-form__group">
          <label className="admin-switch" htmlFor="defaults-allow-custom">
            <input
              type="checkbox"
              id="defaults-allow-custom"
              className="admin-switch__input"
              checked={settings?.allowUserCustomDesign ?? true}
              onChange={(e) => setSettings((prev) => ({ ...prev, allowUserCustomDesign: e.target.checked }))}
            />
            <span>{t('admin.settings.allow_user_custom_design')}</span>
          </label>
          <div className="admin-form__hint">{t('admin.settings.allow_user_custom_design_help')}</div>
        </div>

        <div className="admin-form__group">
          <label className="admin-form__label" htmlFor="defaults-default-design">
            {t('admin.settings.default_design')}
          </label>
          <select
            id="defaults-default-design"
            className="admin-form__select"
            value={settings?.defaultDesignId || 'dark'}
            onChange={(e) => setSettings((prev) => ({ ...prev, defaultDesignId: e.target.value }))}
          >
            <optgroup label={t('admin.settings.default_design_builtin')}>
              <option value="dark">{t('profile.theme_dark')}</option>
              <option value="light">{t('profile.theme_light')}</option>
              <option value="neutral">{t('profile.theme_neutral')}</option>
            </optgroup>
            {designs.filter((d) => d.isActive).length > 0 && (
              <optgroup label={t('admin.settings.default_design_custom')}>
                {designs.filter((d) => d.isActive).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="admin-form__hint">{t('admin.settings.default_design_help')}</div>
        </div>

        <div>
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={handleSaveDefaults}
            disabled={s1Saving || s1Validity.header === false || s1Validity.footer === false}
          >
            {s1Saving ? t('admin.settings.saving') : t('admin.settings.save_btn')}
          </button>
        </div>
      </div>
    </section>
  );

  // D: one component, three pages. `surface` picks which surface this page
  // shows ('defaults' | 'custom' | 'builtin'); 'all' renders everything, as
  // the old single tab did. The edit modal and the confirmation modals are
  // shared by all three pages.
  const surfaceTitle = {
    defaults: t('admin.designs.defaults_title'),
    custom: t('admin.designs.custom_title'),
    builtin: t('admin.designs.default_designs_title'),
    all: t('admin.designs.title'),
  }[surface] || t('admin.designs.title');

  return (
    <div className="designs-tab">
      <div className="designs-header">
        <h4 className="designs-header__title">
          <Palette size={22} />
          <span>{surfaceTitle}</span>
        </h4>
        {(surface === 'custom' || surface === 'all') && (
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={() => handleOpenModal()}
          >
            <PlusCircle size={18} />
            <span>{t('admin.designs.create_btn')}</span>
          </button>
        )}
      </div>

      {(surface === 'defaults' || surface === 'all') && renderSurface1()}

      {/* Surface 2 — custom designs */}
      {(surface === 'custom' || surface === 'all') && (
      <section className="designs-surface" aria-label={t('admin.designs.custom_title')}>
        <h4 className="admin-subtitle">{t('admin.designs.custom_title')}</h4>
        {designs.length === 0 ? (
          <div className="designs-empty">{t('admin.designs.empty_list')}</div>
        ) : (
          <div className="designs-grid">
            {designs.map((design) => (
              <article
                key={design.id}
                className={`designs-card ${!design.isActive ? 'designs-card--inactive' : ''}`}
              >
                {design.bgDefaultUrl ? (
                  <div className="designs-card__cover">
                    <img
                      src={resolveAvatarUrl(design.bgDefaultUrl)}
                      alt=""
                      className="designs-card__cover-img"
                    />
                  </div>
                ) : null}
                <div className="designs-card__header">
                  <h5 className="designs-card__title">{design.name}</h5>
                  <span
                    className={`designs-card__badge ${
                      design.isActive
                        ? 'designs-card__badge--active'
                        : 'designs-card__badge--inactive'
                    }`}
                  >
                    {design.isActive ? t('admin.designs.active') : t('admin.designs.inactive')}
                  </span>
                </div>

                <p className="designs-card__base">
                  {t('admin.designs.modal_base_theme')}: {{
                    dark: t('profile.theme_dark'),
                    light: t('profile.theme_light'),
                    neutral: t('profile.theme_neutral'),
                  }[resolveDesignBaseTheme(design, settings)]}
                </p>

                <div className="designs-card__actions">
                  <button
                    type="button"
                    className={`admin-btn admin-btn--ghost admin-btn--icon ${
                      design.isActive ? 'admin-btn--deactivate' : 'admin-btn--activate'
                    }`}
                    onClick={() => toggleActivate(design)}
                    title={design.isActive ? t('admin.designs.deactivate') : t('admin.designs.activate')}
                    aria-label={design.isActive ? t('admin.designs.deactivate') : t('admin.designs.activate')}
                  >
                    {design.isActive ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon admin-btn--preview"
                    onClick={() => handlePreview(design.id)}
                    title={t('admin.designs.preview')}
                    aria-label={t('admin.designs.preview')}
                  >
                    <Palette size={16} />
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon"
                    onClick={() => handleOpenModal({ kind: 'custom', id: design.id, card: design })}
                    title={t('admin.designs.edit')}
                    aria-label={t('admin.designs.edit')}
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon"
                    onClick={() => handleClone(design)}
                    title={t('admin.designs.clone')}
                    aria-label={t('admin.designs.clone')}
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon admin-btn--danger"
                    onClick={() => handleDelete(design)}
                    title={t('admin.designs.delete')}
                    aria-label={t('admin.designs.delete')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Surface 3 — built-in (default) designs */}
      {(surface === 'builtin' || surface === 'all') && (
      <section className="designs-surface" aria-label={t('admin.designs.default_designs_title')}>
        <h4 className="admin-subtitle">{t('admin.designs.default_designs_title')}</h4>
        <p className="admin-form__hint">{t('admin.designs.default_designs_desc')}</p>
        {defaultDesigns.length === 0 ? (
          <div className="designs-empty">{t('admin.designs.empty_default_list')}</div>
        ) : (
          <div className="designs-grid">
            {defaultDesigns.map((card) => (
              <article key={card.id || card.key} className="designs-card">
                {card.bgDefaultUrl ? (
                  <div className="designs-card__cover">
                    <img
                      src={resolveAvatarUrl(card.bgDefaultUrl)}
                      alt=""
                      className="designs-card__cover-img"
                    />
                  </div>
                ) : null}
                <div className="designs-card__header">
                  <h5 className="designs-card__title">{card.name}</h5>
                  <span className="designs-card__badge designs-card__badge--builtin">
                    {t('admin.designs.builtin_badge')}
                  </span>
                </div>

                {settings?.defaultDesignId === card.key && (
                  <p className="designs-card__base">{t('admin.designs.default_badge')}</p>
                )}

                <div className="designs-card__actions">
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon admin-btn--preview"
                    onClick={() => handlePreview(card.id)}
                    title={t('admin.designs.preview')}
                    aria-label={t('admin.designs.preview')}
                  >
                    <Palette size={16} />
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon"
                    onClick={() => handleOpenModal({ kind: 'default', id: card.id, key: card.key, card })}
                    title={t('admin.designs.edit')}
                    aria-label={t('admin.designs.edit')}
                  >
                    <Edit2 size={16} />
                  </button>
                  <label className="admin-switch">
                    <input
                      type="checkbox"
                      className="admin-switch__input"
                      checked={Boolean(card.showInList)}
                      onChange={() => toggleDefaultShowInList(card)}
                    />
                    <span>{t('admin.designs.modal_show_in_list')}</span>
                  </label>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Edit/Create Modal */}
      <ForumModal
        show={showModal}
        onHide={handleCloseModal}
        size="lg"
        title={editingTarget
          ? (isDefaultTarget ? t('admin.designs.modal_edit_default') : t('admin.designs.modal_edit'))
          : t('admin.designs.modal_create')}
        bodyClassName=""
        footerClassName=""
        footer={
          <>
            {editingTarget && (
              <span className="designs-modal-footer__try">
                <button
                  type="button"
                  className="admin-btn admin-btn--secondary"
                  onClick={() => handlePreview(editingTarget.id)}
                >
                  {t('admin.designs.preview')}
                </button>
                {canApplyModalDesign && (
                  <>
                    <button
                      type="button"
                      className="admin-btn admin-btn--secondary"
                      onClick={handleSetAsMyTheme}
                    >
                      {t('admin.designs.set_as_my_theme')}
                    </button>
                    <button
                      type="button"
                      className="admin-btn admin-btn--secondary"
                      onClick={handleSetAsForumDefault}
                    >
                      {t('admin.designs.set_as_forum_default')}
                    </button>
                  </>
                )}
              </span>
            )}
            <button
              type="button"
              className="admin-btn admin-btn--secondary"
              onClick={handleCloseModal}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              onClick={handleSave}
              disabled={modalLoading || !form.name.trim() || saveBlocked}
            >
              {t('admin.designs.save_btn')}
            </button>
          </>
        }
      >
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          {modalLoading && (
            <div className="admin-muted">{t('common.loading')}</div>
          )}
          <section className="designs-modal-section" aria-label={t('admin.designs.section_general')}>
          <h5 className="designs-modal-section__title">{t('admin.designs.section_general')}</h5>
          {!isDefaultTarget && (
            <div className="admin-form__group">
              <label className="admin-form__label" htmlFor="design-base-theme">
                {t('admin.designs.modal_base_theme')}
              </label>
              <select
                id="design-base-theme"
                className="admin-form__select"
                value={form.baseTheme}
                onChange={(e) => setForm({ ...form, baseTheme: e.target.value })}
              >
                <option value="dark">{t('profile.theme_dark')}</option>
                <option value="light">{t('profile.theme_light')}</option>
                <option value="neutral">{t('profile.theme_neutral')}</option>
              </select>
              <div className="admin-form__hint">
                {t('admin.designs.modal_base_theme_help')}
              </div>
            </div>
          )}

          <div className="admin-form__group">
            <label
              className={`admin-switch ${showInListDisabled ? 'admin-switch--disabled' : ''}`}
              htmlFor="show-in-list"
            >
              <input
                type="checkbox"
                id="show-in-list"
                className="admin-switch__input"
                disabled={showInListDisabled}
                checked={showInListDisabled ? false : form.showInList}
                onChange={(e) => setForm({ ...form, showInList: e.target.checked })}
              />
              <span>{t('admin.designs.modal_show_in_list')}</span>
            </label>
            {showInListDisabled && (
              <div className="admin-form__hint">
                {t('admin.designs.show_in_list_disabled_hint')}
              </div>
            )}
          </div>

          <div className="admin-form__group">
            <label className="admin-form__label" htmlFor="design-name">
              {t('admin.designs.modal_name')}
            </label>
            <input
              id="design-name"
              type="text"
              className={`admin-form__control ${nameInvalid ? 'admin-form__control--invalid' : ''}`}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
        </section>

        <section className="designs-modal-section" aria-label={t('admin.designs.background_title')}>
          <details className="designs-bg-section">
            <summary className="designs-bg-section__summary">
              {t('admin.designs.background_title')}
            </summary>
            <div className="designs-bg-section__body">
              <BackgroundUploadField
                id="design-bg-default"
                label={t('admin.designs.background_default')}
                value={form.bgDefaultUrl}
                onUpload={(blob, filename) => handleBackgroundUpload('default', blob, filename)}
                onClear={() => handleBackgroundClear('default')}
              />
              <BackgroundUploadField
                id="design-bg-tablet"
                label={t('admin.designs.background_tablet')}
                value={form.bgTabletUrl}
                onUpload={(blob, filename) => handleBackgroundUpload('tablet', blob, filename)}
                onClear={() => handleBackgroundClear('tablet')}
              />
              <BackgroundUploadField
                id="design-bg-mobile"
                label={t('admin.designs.background_mobile')}
                value={form.bgMobileUrl}
                onUpload={(blob, filename) => handleBackgroundUpload('mobile', blob, filename)}
                onClear={() => handleBackgroundClear('mobile')}
              />
            </div>
          </details>
        </section>

        <section className="designs-modal-section" aria-label={t('admin.designs.section_content')}>
          <h5 className="designs-modal-section__title">{t('admin.designs.section_content')}</h5>
          <OverwriteField
            label={t('admin.designs.overwrite_header')}
            overwrite={form.overwriteHeader}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwriteHeader: val }))}
          >
            <CodeEditorField
              id="design-header"
              language="html"
              label={t('admin.designs.modal_header')}
              value={form.headerHtml}
              onChange={(val) => setForm((prev) => ({ ...prev, headerHtml: val }))}
              onValidityChange={setValidity('header')}
              minHeight="120px"
            />
          </OverwriteField>

          <OverwriteField
            label={t('admin.designs.overwrite_footer')}
            overwrite={form.overwriteFooter}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwriteFooter: val }))}
          >
            <CodeEditorField
              id="design-footer"
              language="html"
              label={t('admin.designs.modal_footer')}
              value={form.customFooterHtml}
              onChange={(val) => setForm((prev) => ({ ...prev, customFooterHtml: val }))}
              onValidityChange={setValidity('footer')}
              minHeight="120px"
            />
          </OverwriteField>

          <OverwriteField
            label={t('admin.designs.overwrite_title')}
            overwrite={form.overwriteTitle}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwriteTitle: val }))}
          >
            <div className="admin-form__group">
              <label className="admin-form__label" htmlFor="design-forum-title">
                {t('admin.designs.modal_title')}
              </label>
              <input
                id="design-forum-title"
                type="text"
                className="admin-form__control"
                value={form.forumTitle}
                onChange={(e) => setForm({ ...form, forumTitle: e.target.value })}
              />
            </div>
          </OverwriteField>

          <OverwriteField
            label={t('admin.designs.overwrite_favicon')}
            overwrite={form.overwriteFavicon}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwriteFavicon: val }))}
          >
            <div className="admin-form__group">
              <label className="admin-form__label" htmlFor="design-favicon">
                {t('admin.designs.modal_favicon')}
              </label>
              <FaviconUploader
                key={`${editingTarget?.id || editingTarget?.key || 'new'}-${showModal}`}
                id="design-favicon"
                value={faviconPreview || form.faviconUrl}
                onUpload={handleFaviconUpload}
                onChange={(url) => {
                  if (!url.startsWith('blob:')) {
                    resetFaviconStaging();
                    setForm((prev) => ({ ...prev, faviconUrl: url }));
                  }
                }}
                onClear={() => {
                  resetFaviconStaging();
                  setForm((prev) => ({ ...prev, faviconUrl: '' }));
                }}
              />
            </div>
          </OverwriteField>

          <OverwriteField
            label={t('admin.designs.overwrite_placeholder_deleted')}
            overwrite={form.overwritePlaceholderDeleted}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwritePlaceholderDeleted: val }))}
          >
            <div className="admin-form__group">
              <label className="admin-form__label" htmlFor="design-placeholder-deleted">
                {t('admin.settings.placeholder_deleted')}
              </label>
              <AvatarUploader
                value={form.placeholderDeletedUrl}
                onChange={(url) => setForm((prev) => ({ ...prev, placeholderDeletedUrl: url }))}
                onUpload={(blob, filename) => handlePlaceholderUpload('deleted', blob, filename)}
                allowGifs
                size={80}
                canUpload
              />
              {form.placeholderDeletedUrl && !form.placeholderDeletedUrl.startsWith('blob:') && (
                <button
                  type="button"
                  className="admin-btn admin-btn--secondary admin-btn--sm"
                  onClick={() => handlePlaceholderClear('deleted')}
                >
                  {t('admin.settings.placeholder_reset')}
                </button>
              )}
            </div>
          </OverwriteField>

          <OverwriteField
            label={t('admin.designs.overwrite_placeholder_guest')}
            overwrite={form.overwritePlaceholderGuest}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwritePlaceholderGuest: val }))}
          >
            <div className="admin-form__group">
              <label className="admin-form__label" htmlFor="design-placeholder-guest">
                {t('admin.settings.placeholder_guest')}
              </label>
              <AvatarUploader
                value={form.placeholderGuestUrl}
                onChange={(url) => setForm((prev) => ({ ...prev, placeholderGuestUrl: url }))}
                onUpload={(blob, filename) => handlePlaceholderUpload('guest', blob, filename)}
                allowGifs
                size={80}
                canUpload
              />
              {form.placeholderGuestUrl && !form.placeholderGuestUrl.startsWith('blob:') && (
                <button
                  type="button"
                  className="admin-btn admin-btn--secondary admin-btn--sm"
                  onClick={() => handlePlaceholderClear('guest')}
                >
                  {t('admin.settings.placeholder_reset')}
                </button>
              )}
            </div>
          </OverwriteField>
        </section>

        <section className="designs-modal-section" aria-label={t('admin.designs.section_code')}>
          <h5 className="designs-modal-section__title">{t('admin.designs.section_code')}</h5>
          <OverwriteField
            label={t('admin.designs.overwrite_css')}
            overwrite={form.overwriteCss}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwriteCss: val }))}
          >
            <CodeEditorField
              id="design-css"
              language="css"
              label={t('admin.designs.modal_css')}
              value={form.css}
              onChange={(val) => setForm((prev) => ({ ...prev, css: val }))}
              onValidityChange={setValidity('css')}
              minHeight="180px"
            />
          </OverwriteField>

          <OverwriteField
            label={t('admin.designs.overwrite_js')}
            overwrite={form.overwriteJs}
            onToggle={(val) => setForm((prev) => ({ ...prev, overwriteJs: val }))}
          >
            <CodeEditorField
              id="design-js"
              language="javascript"
              label={t('admin.designs.modal_js')}
              value={form.js}
              onChange={(val) => setForm((prev) => ({ ...prev, js: val }))}
              onValidityChange={setValidity('js')}
              minHeight="120px"
            />
          </OverwriteField>
        </section>

        </form>
      </ForumModal>

      {/* Deactivate Replacement Modal */}
      <ForumModal
        show={deactivateModal.show}
        onHide={() =>
          setDeactivateModal({ show: false, designIdToDeactivate: null, replacementId: '' })
        }
        title={t('admin.designs.confirm_deactivate_title')}
        bodyClassName=""
        footerClassName=""
        footer={
          <>
            <button
              type="button"
              className="admin-btn admin-btn--secondary"
              onClick={() =>
                setDeactivateModal({ show: false, designIdToDeactivate: null, replacementId: '' })
              }
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              onClick={handleConfirmDeactivate}
            >
              {t('common.confirm')}
            </button>
          </>
        }
      >
        <div className="designs-deactivate-body">
          <p className="designs-deactivate-body__msg">
            {t('admin.designs.confirm_deactivate_message')}
          </p>
          <div className="admin-form__group">
            <label className="admin-form__label" htmlFor="design-replacement">
              {t('admin.designs.select_replacement')}
            </label>
            <select
              id="design-replacement"
              className="admin-form__select"
              value={deactivateModal.replacementId}
              onChange={(e) =>
                setDeactivateModal({ ...deactivateModal, replacementId: e.target.value })
              }
            >
              <optgroup label={t('admin.settings.default_design_builtin') || 'Built-in Themes'}>
                <option value="dark">{t('profile.theme_dark') || 'Dark'}</option>
                <option value="light">{t('profile.theme_light') || 'Light'}</option>
                <option value="neutral">{t('profile.theme_neutral') || 'Neutral'}</option>
              </optgroup>
              {designs.filter((d) => d.isActive && d.id !== deactivateModal.designIdToDeactivate)
                .length > 0 && (
                <optgroup label={t('admin.settings.default_design_custom') || 'Custom Designs'}>
                  {designs
                    .filter((d) => d.isActive && d.id !== deactivateModal.designIdToDeactivate)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
          </div>
        </div>
      </ForumModal>

      <ConfirmModal
        show={confirmState.show}
        title={confirmState.title}
        message={confirmState.message}
        onConfirm={confirmState.onConfirm}
        onHide={() => setConfirmState((prev) => ({ ...prev, show: false }))}
      />
    </div>
  );
};

export default DesignsTab;
