import React, { useEffect, useState } from 'react';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import { getGlobalSettings, updateGlobalSettings, uploadPwaIcon } from '../../api/admin';
import FaviconUploader from './FaviconUploader';

// Web Push & PWA settings (migration 1780100001).
//
// The manifest is NOT a file any more: the browser reads it from
// GET /api/aerun/manifest.webmanifest, which the server builds from the
// fields on this surface. Empty text/icon fields mean "use the built-in
// default" — the server resolves them, so this form must be able to tell an
// empty field from a stored one, and it saves exactly what the admin typed.
//
// Only the name, the short name and the description live here. The colours
// and the language are NOT admin fields: the manifest takes them from the
// viewer's live theme and locale (?theme= / ?lang=, see PwaManifestLink.jsx),
// so one static pair can never drift away from the theme anyone has active.
//
// Theming: the shared admin classes from admin.css — no per-tab copies, no
// react-bootstrap, no Bootstrap utility classes, no inline styles. The tab
// itself has no CSS file of its own.

const ICON_FIELDS = [
  { kind: 'icon-192', key: 'pwaIcon192Url', labelKey: 'icon_192', helpKey: 'icon_192_help' },
  { kind: 'icon-512', key: 'pwaIcon512Url', labelKey: 'icon_512', helpKey: 'icon_512_help' },
  { kind: 'icon-maskable', key: 'pwaIconMaskableUrl', labelKey: 'icon_maskable', helpKey: 'icon_maskable_help' },
  { kind: 'apple-touch', key: 'pwaIconAppleTouchUrl', labelKey: 'icon_apple_touch', helpKey: 'icon_apple_touch_help' },
  { kind: 'badge', key: 'pwaIconBadgeUrl', labelKey: 'icon_badge', helpKey: 'icon_badge_help' },
];

const TEXT_FIELDS = [
  { key: 'pwaName', labelKey: 'pwa_name', placeholderKey: 'pwa_name_placeholder' },
  { key: 'pwaShortName', labelKey: 'pwa_short_name', placeholderKey: 'pwa_short_name_placeholder' },
  { key: 'pwaDescription', labelKey: 'pwa_description', placeholderKey: 'pwa_description_placeholder', as: 'textarea' },
];

export default function PushSettingsTab() {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [form, setForm] = useState({
    pushEnabled: true,
    pwaName: '',
    pwaShortName: '',
    pwaDescription: '',
    pwaIcon192Url: '',
    pwaIcon512Url: '',
    pwaIconMaskableUrl: '',
    pwaIconAppleTouchUrl: '',
    pwaIconBadgeUrl: '',
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const unsub = getGlobalSettings((data) => {
      if (!data) return;
      setForm((prev) => ({
        ...prev,
        pushEnabled: data.pushEnabled ?? true,
        pwaName: data.pwaName || '',
        pwaShortName: data.pwaShortName || '',
        pwaDescription: data.pwaDescription || '',
        pwaIcon192Url: data.pwaIcon192Url || '',
        pwaIcon512Url: data.pwaIcon512Url || '',
        pwaIconMaskableUrl: data.pwaIconMaskableUrl || '',
        pwaIconAppleTouchUrl: data.pwaIconAppleTouchUrl || '',
        pwaIconBadgeUrl: data.pwaIconBadgeUrl || '',
      }));
      setLoaded(true);
    });
    return unsub;
  }, []);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      await updateGlobalSettings({
        pushEnabled: form.pushEnabled,
        pwaName: form.pwaName,
        pwaShortName: form.pwaShortName,
        pwaDescription: form.pwaDescription,
        pwaIcon192Url: form.pwaIcon192Url,
        pwaIcon512Url: form.pwaIcon512Url,
        pwaIconMaskableUrl: form.pwaIconMaskableUrl,
        pwaIconAppleTouchUrl: form.pwaIconAppleTouchUrl,
        pwaIconBadgeUrl: form.pwaIconBadgeUrl,
      });
      showToast(t('admin.push.save_success'), 'success');
    } catch (err) {
      setError(err?.message || t('admin.push.save_error'));
      showToast(t('admin.push.save_error'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-form">
      <h2 className="admin-title">{t('admin.push.title')}</h2>
      <div className="admin-form__hint">{t('admin.push.description')}</div>

      {error && <div className="admin-form__error" role="alert">{error}</div>}

      <section className="admin-card">
        <div className="admin-card__body admin-form">
          <h3 className="admin-subtitle">{t('admin.push.section_push')}</h3>
          <label className="admin-switch">
            <input
              type="checkbox"
              className="admin-switch__input"
              checked={form.pushEnabled}
              disabled={!loaded || saving}
              onChange={(e) => setField('pushEnabled', e.target.checked)}
            />
            <span>{t('admin.push.push_enabled')}</span>
          </label>
          <div className="admin-form__hint">{t('admin.push.push_enabled_help')}</div>
        </div>
      </section>

      <section className="admin-card">
        <div className="admin-card__body admin-form">
          <h3 className="admin-subtitle">{t('admin.push.section_manifest')}</h3>
          <div className="admin-form__hint">{t('admin.push.manifest_help')}</div>
          {TEXT_FIELDS.map((field) => (
        <div className="admin-form__group" key={field.key}>
          <label className="admin-form__label" htmlFor={`pwa-${field.key}`}>
            {t(`admin.push.${field.labelKey}`)}
          </label>
          {field.as === 'textarea' ? (
            <textarea
              id={`pwa-${field.key}`}
              className="admin-form__control admin-form__textarea"
              rows={2}
              value={form[field.key]}
              placeholder={field.placeholderKey ? t(`admin.push.${field.placeholderKey}`) : ''}
              disabled={!loaded || saving}
              onChange={(e) => setField(field.key, e.target.value)}
            />
          ) : (
            <input
              id={`pwa-${field.key}`}
              className="admin-form__control"
              value={form[field.key]}
              placeholder={field.placeholderKey ? t(`admin.push.${field.placeholderKey}`) : ''}
              disabled={!loaded || saving}
              onChange={(e) => setField(field.key, e.target.value)}
            />
          )}
          {field.helpKey && (
            <div className="admin-form__hint">{t(`admin.push.${field.helpKey}`)}</div>
          )}
        </div>
      ))}
        </div>
      </section>

      <section className="admin-card">
        <div className="admin-card__body admin-form">
          <h3 className="admin-subtitle">{t('admin.push.section_icons')}</h3>
          <div className="admin-form__hint">{t('admin.push.icons_help')}</div>
          {ICON_FIELDS.map((field) => (
        <div className="admin-form__group" key={field.kind}>
          <label className="admin-form__label" htmlFor={`pwa-icon-${field.kind}`}>
            {t(`admin.push.${field.labelKey}`)}
          </label>
          <FaviconUploader
            id={`pwa-icon-${field.kind}`}
            value={form[field.key]}
            disabled={!loaded || saving}
            onChange={(url) => setField(field.key, url)}
            onUpload={(file, filename) => uploadPwaIcon(field.kind, file, filename)}
            onClear={() => setField(field.key, '')}
          />
          <div className="admin-form__hint">{t(`admin.push.${field.helpKey}`)}</div>
        </div>
      ))}
        </div>
      </section>

      <div className="admin-actions">
        <button
          type="button"
          className="admin-btn admin-btn--primary"
          onClick={handleSave}
          disabled={!loaded || saving}
        >
          {saving ? t('admin.push.saving') : t('admin.push.save_btn')}
        </button>
        <a href="/api/aerun/manifest.webmanifest" target="_blank" rel="noreferrer">
          {t('admin.push.view_manifest')}
        </a>
      </div>
    </div>
  );
}
