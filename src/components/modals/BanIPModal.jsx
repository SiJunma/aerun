import React, { useState, useEffect } from 'react';
import ForumModal from '../common/ForumModal';
import { useI18n } from '../../contexts/I18nProvider';
import { createIPBan } from '../../api/analytics';

export default function BanIPModal({
  show,
  onHide,
  initialIP = '',
  associatedAccountsCount = 0,
  onBanSuccess,
}) {
  const { t } = useI18n();

  const [ipOrSubnet, setIpOrSubnet] = useState(initialIP);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('permanent'); // permanent, 24h, 7d, 30d
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (show) {
      setIpOrSubnet(initialIP);
      setReason('');
      setDuration('permanent');
      setError(null);
    }
  }, [show, initialIP]);

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!ipOrSubnet.trim() || !reason.trim()) {
      setError(t('admin.visits.ban_modal.missing_fields', 'IP/Subnet and Reason are required.'));
      return;
    }

    setSaving(true);
    setError(null);

    let expiresAt = '';
    const now = new Date();
    if (duration === '24h') {
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    } else if (duration === '7d') {
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (duration === '30d') {
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    try {
      const data = await createIPBan({
        ip_or_subnet: ipOrSubnet.trim(),
        reason: reason.trim(),
        expires_at: expiresAt,
      });

      onHide();
      if (onBanSuccess) onBanSuccess(data?.ban);
    } catch (err) {
      setError(err.message || 'Failed to apply IP ban');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={t('admin.visits.ban_modal.title', 'Block IP / Subnet')}
      size="md"
      footer={
        <>
          <button type="button" className="admin-btn admin-btn--secondary" onClick={onHide} disabled={saving}>
            {t('admin.visits.ban_modal.cancel', 'Cancel')}
          </button>
          <button type="button" className="admin-btn admin-btn--ghost admin-btn--danger" onClick={handleSubmit} disabled={saving}>
            {saving
              ? t('admin.visits.ban_modal.saving', 'Saving...')
              : t('admin.visits.ban_modal.confirm', 'Apply Ban')}
          </button>
        </>
      }
    >
      {error && <div className="admin-notice admin-notice--danger" role="alert">{error}</div>}

      {associatedAccountsCount > 3 && (
        <div className="admin-notice admin-notice--warning">
          {t(
            'admin.visits.ban_modal.nat_warning',
            'Warning: Over {count} accounts have been active from this IP. Banning may affect innocent users on shared NAT/network.'
          ).replace('{count}', String(associatedAccountsCount))}
        </div>
      )}

      <form className="admin-form" onSubmit={handleSubmit}>
        <div className="admin-form__group">
          <label className="admin-form__label">{t('admin.visits.ban_modal.ip_label', 'IP Address or CIDR Subnet')}</label>
          <input
            type="text"
            className="admin-form__control"
            value={ipOrSubnet}
            onChange={(e) => setIpOrSubnet(e.target.value)}
            placeholder={t('admin.visits.ban_modal.ip_placeholder', 'e.g., 198.51.100.1 or 198.51.100.0/24')}
            required
          />
        </div>

        <div className="admin-form__group">
          <label className="admin-form__label">{t('admin.visits.ban_modal.reason_label', 'Reason for Blocking')}</label>
          <textarea
            rows={2}
            className="admin-form__control admin-form__textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin.visits.ban_modal.reason_placeholder', 'e.g., spammer botnet, brute force')}
            required
          />
        </div>

        <div className="admin-form__group">
          <label className="admin-form__label">{t('admin.visits.ban_modal.duration_label', 'Ban Duration')}</label>
          <select className="admin-form__control admin-form__select" value={duration} onChange={(e) => setDuration(e.target.value)}>
            <option value="permanent">{t('admin.visits.ban_modal.permanent', 'Permanent')}</option>
            <option value="24h">{t('admin.visits.ban_modal.one_day', '24 Hours')}</option>
            <option value="7d">{t('admin.visits.ban_modal.seven_days', '7 Days')}</option>
            <option value="30d">{t('admin.visits.ban_modal.thirty_days', '30 Days')}</option>
          </select>
        </div>
      </form>
    </ForumModal>
  );
}
