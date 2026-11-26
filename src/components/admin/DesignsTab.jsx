import React, { useState, lazy, Suspense } from 'react';
import { PlusCircle, Edit2, Trash2, Copy, Eye, EyeOff, Palette } from 'lucide-react';
import ForumModal from '../common/ForumModal';
import ConfirmModal from '../common/ConfirmModal';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import { createDesign, updateDesign, deleteDesign, uploadDesignFavicon } from '../../api/designs';
import { validateCode } from './codeValidation';
import FaviconUploader from './FaviconUploader';
import './DesignsTab.css';

const CodeEditor = lazy(() => import('./CodeEditor'));

const DEFAULT_FORM = {
  name: '',
  description: '',
  faviconUrl: '',
  forumTitle: '',
  welcomeMessage: '',
  css: '',
  js: '',
  showInList: false,
  isActive: false,
};

const EMPTY_CODE_ERRORS = {
  welcomeMessage: null,
  css: null,
  js: null,
};

const DesignsTab = ({ designs, settings, updateSettings }) => {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [showModal, setShowModal] = useState(false);
  const [editingDesign, setEditingDesign] = useState(null);
  const [basedOnId, setBasedOnId] = useState('');
  const [form, setForm] = useState(DEFAULT_FORM);
  const [nameAttempted, setNameAttempted] = useState(false);
  const [codeErrors, setCodeErrors] = useState(EMPTY_CODE_ERRORS);
  const [pendingFavicon, setPendingFavicon] = useState(null);
  const [faviconPreview, setFaviconPreview] = useState('');

  const resetFaviconStaging = () => {
    setPendingFavicon(null);
    setFaviconPreview((prev) => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      return '';
    });
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

  const handleOpenModal = (design = null) => {
    setBasedOnId('');
    setNameAttempted(false);
    setCodeErrors(EMPTY_CODE_ERRORS);
    resetFaviconStaging();
    if (design) {
      const active = Boolean(design.isActive);
      setEditingDesign(design.id);
      setForm({
        name: design.name || '',
        description: design.description || '',
        faviconUrl: design.faviconUrl || '',
        forumTitle: design.forumTitle || '',
        welcomeMessage: design.welcomeMessage || '',
        css: design.css || '',
        js: design.js || '',
        showInList: active ? Boolean(design.showInList) : false,
        isActive: active,
      });
    } else {
      setEditingDesign(null);
      setForm({ ...DEFAULT_FORM });
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    resetFaviconStaging();
    setShowModal(false);
  };

  const handleBasedOnChange = (selectedId) => {
    setBasedOnId(selectedId);
    setCodeErrors(EMPTY_CODE_ERRORS);
    resetFaviconStaging();
    if (!selectedId) {
      setForm((prev) => ({
        ...prev,
        faviconUrl: '',
        forumTitle: '',
        welcomeMessage: '',
        css: '',
        js: '',
      }));
      return;
    }

    const source = designs.find((d) => d.id === selectedId);
    if (!source) return;
    setForm((prev) => ({
      ...prev,
      faviconUrl: source.faviconUrl || '',
      forumTitle: source.forumTitle || '',
      welcomeMessage: source.welcomeMessage || '',
      css: source.css || '',
      js: source.js || '',
    }));
  };

  const runFieldValidation = (field, language, value) => {
    const result = validateCode(language, value, t);
    setCodeErrors((prev) => ({ ...prev, [field]: result }));
    return result;
  };

  const handleFaviconUpload = async (blob, filename) => {
    if (!editingDesign) {
      const objectUrl = URL.createObjectURL(blob);
      setPendingFavicon({ blob, filename });
      setFaviconPreview((prev) => {
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
        return objectUrl;
      });
      return objectUrl;
    }
    const url = await uploadDesignFavicon(editingDesign, blob, filename);
    resetFaviconStaging();
    setForm((prev) => ({ ...prev, faviconUrl: url }));
    return url;
  };

  const handleSave = async () => {
    setNameAttempted(true);
    const trimmedName = form.name.trim();
    if (!trimmedName) return;

    const welcomeError = validateCode('html', form.welcomeMessage, t);
    const cssWarning = validateCode('css', form.css, t);
    const jsError = validateCode('javascript', form.js, t);

    setCodeErrors({
      welcomeMessage: welcomeError,
      css: cssWarning,
      js: jsError,
    });

    if (welcomeError || jsError) {
      showToast(t('admin.designs.validation_save_blocked'), 'danger');
      return;
    }

    const payload = {
      ...form,
      name: trimmedName,
      showInList: form.isActive ? Boolean(form.showInList) : false,
    };

    try {
      if (editingDesign) {
        await updateDesign(editingDesign, payload);
      } else {
        const newId = await createDesign(payload);
        if (pendingFavicon && newId) {
          const { blob, filename } = pendingFavicon;
          try {
            await uploadDesignFavicon(newId, blob, filename);
          } catch (uploadErr) {
            console.error(uploadErr);
            showToast(t('profile.error_upload_failed'), 'danger');
          }
        }
      }
      resetFaviconStaging();
      showToast(t('admin.designs.toast_saved'), 'success');
      setShowModal(false);
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const handleClone = async (design) => {
    try {
      const { id: _id, ...data } = design;
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

  const handlePreview = (designId) => {
    window.open(`/?preview_design=${designId}`, '_blank');
  };

  const showInListDisabled = !editingDesign || !form.isActive;
  const baseDesignOptions = designs.filter((d) => d.id !== editingDesign);
  const nameInvalid = nameAttempted && !form.name.trim();

  return (
    <div className="designs-tab">
      <div className="designs-header">
        <h4 className="designs-header__title">
          <Palette size={22} />
          <span>{t('admin.designs.title')}</span>
        </h4>
        <button
          type="button"
          className="designs-btn designs-btn--primary"
          onClick={() => handleOpenModal()}
        >
          <PlusCircle size={18} />
          <span>{t('admin.designs.create_btn')}</span>
        </button>
      </div>

      {designs.length === 0 ? (
        <div className="designs-empty">{t('admin.designs.empty_list')}</div>
      ) : (
        <div className="designs-grid">
          {designs.map((design) => (
            <article
              key={design.id}
              className={`designs-card ${!design.isActive ? 'designs-card--inactive' : ''}`}
            >
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

              <p className="designs-card__desc">{design.description}</p>

              <div className="designs-card__actions">
                <button
                  type="button"
                  className={`designs-btn designs-btn--ghost designs-btn--icon ${
                    design.isActive ? 'designs-btn--deactivate' : 'designs-btn--activate'
                  }`}
                  onClick={() => toggleActivate(design)}
                  title={design.isActive ? t('admin.designs.deactivate') : t('admin.designs.activate')}
                  aria-label={design.isActive ? t('admin.designs.deactivate') : t('admin.designs.activate')}
                >
                  {design.isActive ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button
                  type="button"
                  className="designs-btn designs-btn--ghost designs-btn--icon designs-btn--preview"
                  onClick={() => handlePreview(design.id)}
                  title={t('admin.designs.preview')}
                  aria-label={t('admin.designs.preview')}
                >
                  <Palette size={16} />
                </button>
                <button
                  type="button"
                  className="designs-btn designs-btn--ghost designs-btn--icon"
                  onClick={() => handleOpenModal(design)}
                  title={t('admin.designs.edit')}
                  aria-label={t('admin.designs.edit')}
                >
                  <Edit2 size={16} />
                </button>
                <button
                  type="button"
                  className="designs-btn designs-btn--ghost designs-btn--icon"
                  onClick={() => handleClone(design)}
                  title={t('admin.designs.clone')}
                  aria-label={t('admin.designs.clone')}
                >
                  <Copy size={16} />
                </button>
                <button
                  type="button"
                  className="designs-btn designs-btn--ghost designs-btn--icon designs-btn--danger"
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

      {/* Edit/Create Modal */}
      <ForumModal
        show={showModal}
        onHide={handleCloseModal}
        size="lg"
        title={editingDesign ? t('admin.designs.modal_edit') : t('admin.designs.modal_create')}
        bodyClassName=""
        footerClassName=""
        footer={
          <>
            <button
              type="button"
              className="designs-btn designs-btn--secondary"
              onClick={handleCloseModal}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="designs-btn designs-btn--primary"
              onClick={handleSave}
              disabled={!form.name.trim()}
            >
              {t('admin.designs.save_btn')}
            </button>
          </>
        }
      >
        <form
          className="designs-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          {!editingDesign && (
            <div className="designs-form__group">
              <label className="designs-form__label" htmlFor="design-based-on">
                {t('admin.designs.modal_based_on')}
              </label>
              <select
                id="design-based-on"
                className="designs-form__select"
                value={basedOnId}
                onChange={(e) => handleBasedOnChange(e.target.value)}
              >
                <option value="">{t('admin.designs.based_on_empty')}</option>
                {baseDesignOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="designs-form__group">
            <label
              className={`designs-switch ${showInListDisabled ? 'designs-switch--disabled' : ''}`}
              htmlFor="show-in-list"
            >
              <input
                type="checkbox"
                id="show-in-list"
                className="designs-switch__input"
                disabled={showInListDisabled}
                checked={showInListDisabled ? false : form.showInList}
                onChange={(e) => setForm({ ...form, showInList: e.target.checked })}
              />
              <span>{t('admin.designs.modal_show_in_list')}</span>
            </label>
            {showInListDisabled && (
              <div className="designs-form__hint">
                {t('admin.designs.show_in_list_disabled_hint')}
              </div>
            )}
          </div>

          <div className="designs-form__row">
            <div className="designs-form__group">
              <label className="designs-form__label" htmlFor="design-name">
                {t('admin.designs.modal_name')}
              </label>
              <input
                id="design-name"
                type="text"
                className={`designs-form__control ${nameInvalid ? 'designs-form__control--invalid' : ''}`}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="designs-form__group">
              <label className="designs-form__label" htmlFor="design-forum-title">
                {t('admin.designs.modal_title')}
              </label>
              <input
                id="design-forum-title"
                type="text"
                className="designs-form__control"
                value={form.forumTitle}
                onChange={(e) => setForm({ ...form, forumTitle: e.target.value })}
              />
            </div>
          </div>

          <div className="designs-form__group">
            <label className="designs-form__label" htmlFor="design-favicon">
              {t('admin.designs.modal_favicon')}
            </label>
            <FaviconUploader
              key={`${editingDesign || 'new'}-${showModal}`}
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

          <div className="designs-form__group">
            <label className="designs-form__label" htmlFor="design-desc">
              {t('admin.designs.modal_desc')}
            </label>
            <textarea
              id="design-desc"
              rows={2}
              className="designs-form__textarea"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <Suspense fallback={<div className="designs-code-skeleton">{t('common.loading')}</div>}>
            <CodeEditor
              id="design-welcome"
              language="html"
              label={t('admin.designs.modal_welcome')}
              value={form.welcomeMessage}
              onChange={(val) => {
                setForm((prev) => ({ ...prev, welcomeMessage: val }));
                if (codeErrors.welcomeMessage) {
                  setCodeErrors((prev) => ({ ...prev, welcomeMessage: null }));
                }
              }}
              onBeautify={(val) => runFieldValidation('welcomeMessage', 'html', val)}
              error={codeErrors.welcomeMessage}
              minHeight="120px"
            />

            <CodeEditor
              id="design-css"
              language="css"
              label={t('admin.designs.modal_css')}
              value={form.css}
              onChange={(val) => {
                setForm((prev) => ({ ...prev, css: val }));
                if (codeErrors.css) {
                  setCodeErrors((prev) => ({ ...prev, css: null }));
                }
              }}
              onBeautify={(val) => runFieldValidation('css', 'css', val)}
              error={codeErrors.css}
              minHeight="180px"
            />

            <CodeEditor
              id="design-js"
              language="javascript"
              label={t('admin.designs.modal_js')}
              value={form.js}
              onChange={(val) => {
                setForm((prev) => ({ ...prev, js: val }));
                if (codeErrors.js) {
                  setCodeErrors((prev) => ({ ...prev, js: null }));
                }
              }}
              onBeautify={(val) => runFieldValidation('js', 'javascript', val)}
              error={codeErrors.js}
              minHeight="120px"
            />
          </Suspense>

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
              className="designs-btn designs-btn--secondary"
              onClick={() =>
                setDeactivateModal({ show: false, designIdToDeactivate: null, replacementId: '' })
              }
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="designs-btn designs-btn--primary"
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
          <div className="designs-form__group">
            <label className="designs-form__label" htmlFor="design-replacement">
              {t('admin.designs.select_replacement')}
            </label>
            <select
              id="design-replacement"
              className="designs-form__select"
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
