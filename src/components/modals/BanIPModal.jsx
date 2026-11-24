import React, { useState, useEffect } from 'react';
import { Button, Form, Alert } from 'react-bootstrap';
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
          <Button variant="secondary" onClick={onHide} disabled={saving}>
            {t('admin.visits.ban_modal.cancel', 'Cancel')}
          </Button>
          <Button variant="danger" onClick={handleSubmit} disabled={saving}>
            {saving
              ? t('admin.visits.ban_modal.saving', 'Saving...')
              : t('admin.visits.ban_modal.confirm', 'Apply Ban')}
          </Button>
        </>
      }
    >
      {error && <Alert variant="danger">{error}</Alert>}

      {associatedAccountsCount > 3 && (
        <Alert variant="warning">
          {t(
            'admin.visits.ban_modal.nat_warning',
            'Warning: Over {count} accounts have been active from this IP. Banning may affect innocent users on shared NAT/network.'
          ).replace('{count}', String(associatedAccountsCount))}
        </Alert>
      )}

      <Form onSubmit={handleSubmit}>
        <Form.Group className="mb-3">
          <Form.Label>{t('admin.visits.ban_modal.ip_label', 'IP Address or CIDR Subnet')}</Form.Label>
          <Form.Control
            type="text"
            value={ipOrSubnet}
            onChange={(e) => setIpOrSubnet(e.target.value)}
            placeholder={t('admin.visits.ban_modal.ip_placeholder', 'e.g., 198.51.100.1 or 198.51.100.0/24')}
            required
          />
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>{t('admin.visits.ban_modal.reason_label', 'Reason for Blocking')}</Form.Label>
          <Form.Control
            as="textarea"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin.visits.ban_modal.reason_placeholder', 'e.g., spammer botnet, brute force')}
            required
          />
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>{t('admin.visits.ban_modal.duration_label', 'Ban Duration')}</Form.Label>
          <Form.Select value={duration} onChange={(e) => setDuration(e.target.value)}>
            <option value="permanent">{t('admin.visits.ban_modal.permanent', 'Permanent')}</option>
            <option value="24h">{t('admin.visits.ban_modal.one_day', '24 Hours')}</option>
            <option value="7d">{t('admin.visits.ban_modal.seven_days', '7 Days')}</option>
            <option value="30d">{t('admin.visits.ban_modal.thirty_days', '30 Days')}</option>
          </Form.Select>
        </Form.Group>
      </Form>
    </ForumModal>
  );
}
