import React, { useState, useEffect, useCallback } from 'react';
import { Row, Col, Form, Button, Badge, Alert, Spinner } from 'react-bootstrap';
import { KeyRound, RefreshCw, Save } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import { fetchAdminSecrets, updateAdminSecrets, downloadGeoIPDatabase } from '../../api/admin';
import ErrorCard from '../common/ErrorCard';

export default function AdminSecretsSettings() {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [downloadingGeoIP, setDownloadingGeoIP] = useState(false);

  const [snapshot, setSnapshot] = useState(null);
  const [maxmindKey, setMaxmindKey] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpAuthMethod, setSmtpAuthMethod] = useState('PLAIN');
  const [smtpTls, setSmtpTls] = useState(true);
  const [mailSenderAddress, setMailSenderAddress] = useState('');
  const [mailSenderName, setMailSenderName] = useState('');
  const [ipHashSalt, setIpHashSalt] = useState('');

  const applySnapshot = useCallback((s) => {
    if (!s) return;
    setSnapshot(s);
    setMaxmindKey('');
    setGoogleClientId(s.google_client_id || '');
    setGoogleClientSecret('');
    setSmtpEnabled(Boolean(s.smtp_enabled));
    setSmtpHost(s.smtp_host || '');
    setSmtpPort(s.smtp_port ? String(s.smtp_port) : '');
    setSmtpUsername(s.smtp_username || '');
    setSmtpPassword('');
    setSmtpAuthMethod(s.smtp_auth_method || 'PLAIN');
    setSmtpTls(s.smtp_tls ?? true);
    setMailSenderAddress(s.mail_sender_address || '');
    setMailSenderName(s.mail_sender_name || '');
    setIpHashSalt('');
  }, []);

  const loadSecrets = useCallback(async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const data = await fetchAdminSecrets();
      applySnapshot(data?.secrets);
    } catch (err) {
      setFetchError(err);
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        google_client_id: googleClientId.trim(),
      };
      if (maxmindKey.trim()) payload.maxmind_license_key = maxmindKey.trim();
      if (googleClientSecret.trim()) payload.google_client_secret = googleClientSecret.trim();
      if (ipHashSalt.trim()) payload.ip_hash_salt = ipHashSalt.trim();

      if (snapshot?.mail_mode !== 'disabled') {
        payload.smtp_enabled = smtpEnabled;
        payload.smtp_host = smtpHost.trim();
        payload.smtp_port = smtpPort ? parseInt(smtpPort, 10) || 0 : 0;
        payload.smtp_username = smtpUsername.trim();
        payload.smtp_auth_method = smtpAuthMethod || 'PLAIN';
        payload.smtp_tls = smtpTls;
        payload.mail_sender_address = mailSenderAddress.trim();
        payload.mail_sender_name = mailSenderName.trim();
        if (smtpPassword) payload.smtp_password = smtpPassword;
      }

      const res = await updateAdminSecrets(payload);
      applySnapshot(res?.secrets);
      showToast(t('admin.settings.secrets_saved', 'Secrets & integration settings saved!'), 'success');
    } catch (err) {
      showToast(err.message || t('admin.settings.error', 'Error saving settings'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleClearField = async (clearPayload) => {
    setSaving(true);
    try {
      const res = await updateAdminSecrets(clearPayload);
      applySnapshot(res?.secrets);
      showToast(t('admin.settings.secrets_saved', 'Secrets & integration settings saved!'), 'success');
    } catch (err) {
      showToast(err.message || t('admin.settings.error', 'Error saving settings'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadGeoIP = async () => {
    setDownloadingGeoIP(true);
    try {
      const res = await downloadGeoIPDatabase();
      setSnapshot((prev) => ({
        ...(prev || {}),
        geoip_db_exists: Boolean(res?.geoip_db_exists),
        geoip_updated_at: res?.geoip_updated_at || prev?.geoip_updated_at || '',
      }));
      showToast(t('admin.settings.geoip_download_success', 'GeoLite2-City database updated and activated!'), 'success');
    } catch (err) {
      showToast(err.message || t('admin.settings.geoip_download_error', 'Failed to update GeoIP database'), 'danger');
    } finally {
      setDownloadingGeoIP(false);
    }
  };

  const mailDisabledByEnv = snapshot?.mail_mode === 'disabled';

  return (
    <div className="admin-card admin-card--spacing">
      <div className="admin-card__header d-flex align-items-center justify-content-between flex-wrap gap-2">
        <div className="d-flex align-items-center gap-2">
          <KeyRound size={18} className="text-primary" />
          <h5 className="mb-0 text-primary">{t('admin.settings.secrets_section', 'Secrets & Integrations')}</h5>
        </div>
      </div>

      <div className="admin-card__body">
        <p className="small text-muted mb-4">
          {t('admin.settings.secrets_help', 'API keys and credentials are stored securely in the database (admin-only). They are never exposed in public settings or env files.')}
        </p>

        {loading ? (
          <div className="d-flex align-items-center gap-2 text-muted py-3">
            <Spinner animation="border" size="sm" />
            <span>{t('common.loading', 'Loading...')}</span>
          </div>
        ) : fetchError ? (
          <ErrorCard error={fetchError} onRetry={loadSecrets} />
        ) : (
          <Form onSubmit={handleSave}>
            {/* 1. MaxMind GeoIP */}
            <div className="mb-4">
              <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
                <h6 className="fw-bold mb-0">{t('admin.settings.maxmind_title', 'GeoIP (MaxMind GeoLite2-City)')}</h6>
                <div className="d-flex align-items-center gap-2">
                  <Badge bg={snapshot?.has_maxmind_license_key ? 'success' : 'secondary'}>
                    {snapshot?.has_maxmind_license_key
                      ? `${t('admin.settings.secrets_configured', 'Configured')}: ${snapshot.maxmind_license_key_masked}`
                      : t('admin.settings.secrets_not_set', 'Not set')}
                  </Badge>
                  {snapshot?.has_maxmind_license_key && (
                    <Button
                      type="button"
                      variant="outline-secondary"
                      size="sm"
                      disabled={saving}
                      onClick={() => handleClearField({ clear_maxmind_license_key: true })}
                    >
                      {t('admin.settings.secrets_clear_btn', 'Clear')}
                    </Button>
                  )}
                </div>
              </div>

              <Form.Group className="mb-2" controlId="maxmindLicenseKey">
                <Form.Label className="small fw-bold">{t('admin.settings.maxmind_key_label', 'MaxMind License Key')}</Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="new-password"
                  placeholder={snapshot?.has_maxmind_license_key ? t('admin.settings.secrets_keep_placeholder', 'Leave blank to keep current value') : ''}
                  value={maxmindKey}
                  onChange={(e) => setMaxmindKey(e.target.value)}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.settings.maxmind_key_help', 'Used exclusively on the server to download and update GeoLite2-City.mmdb. To get a key: sign up for GeoLite in your MaxMind account, then open Manage License Keys, generate a new key, and copy it immediately — it is shown only once.')}
                </div>
              </Form.Group>

              <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mt-2">
                <div className="small text-muted">
                  {snapshot?.geoip_db_exists ? (
                    <span className="text-success fw-semibold">
                      {t('admin.settings.geoip_db_ready', 'GeoIP database installed')}
                      {snapshot?.geoip_updated_at
                        ? ` (${t('admin.settings.geoip_updated_at', 'Last updated')}: ${new Date(snapshot.geoip_updated_at).toLocaleString()})`
                        : ''}
                    </span>
                  ) : (
                    <span>{t('admin.settings.geoip_db_missing', 'GeoIP database not installed yet (locations show XX / Unknown)')}</span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline-primary"
                  size="sm"
                  className="d-inline-flex align-items-center gap-2"
                  disabled={downloadingGeoIP || !snapshot?.has_maxmind_license_key}
                  onClick={handleDownloadGeoIP}
                >
                  <RefreshCw size={15} />
                  {downloadingGeoIP
                    ? t('admin.settings.geoip_downloading', 'Updating...')
                    : t('admin.settings.geoip_download_btn', 'Update GeoIP DB')}
                </Button>
              </div>
            </div>

            <hr className="my-4" />

            {/* 2. Google OAuth2 */}
            <div className="mb-4">
              <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
                <h6 className="fw-bold mb-0">{t('admin.settings.google_oauth_title', 'Google OAuth2 Sign-In')}</h6>
                <div className="d-flex align-items-center gap-2">
                  <Badge bg={snapshot?.has_google_client_secret && snapshot?.google_client_id ? 'success' : 'secondary'}>
                    {snapshot?.has_google_client_secret && snapshot?.google_client_id
                      ? `${t('admin.settings.secrets_configured', 'Configured')}: ${snapshot.google_client_secret_masked}`
                      : t('admin.settings.secrets_not_set', 'Not set')}
                  </Badge>
                  {(snapshot?.google_client_id || snapshot?.has_google_client_secret) && (
                    <Button
                      type="button"
                      variant="outline-secondary"
                      size="sm"
                      disabled={saving}
                      onClick={() => handleClearField({ clear_google_oauth: true })}
                    >
                      {t('admin.settings.secrets_clear_btn', 'Clear')}
                    </Button>
                  )}
                </div>
              </div>
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-3" controlId="googleClientId">
                    <Form.Label className="small fw-bold">{t('admin.settings.google_client_id', 'Google Client ID')}</Form.Label>
                    <Form.Control
                      type="text"
                      value={googleClientId}
                      onChange={(e) => setGoogleClientId(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-3" controlId="googleClientSecret">
                    <Form.Label className="small fw-bold">{t('admin.settings.google_client_secret', 'Google Client Secret')}</Form.Label>
                    <Form.Control
                      type="password"
                      autoComplete="new-password"
                      placeholder={snapshot?.has_google_client_secret ? t('admin.settings.secrets_keep_placeholder', 'Leave blank to keep current value') : ''}
                      value={googleClientSecret}
                      onChange={(e) => setGoogleClientSecret(e.target.value)}
                    />
                  </Form.Group>
                </Col>
              </Row>
            </div>

            <hr className="my-4" />

            {/* 3. SMTP Relay */}
            <div className="mb-4">
              <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
                <h6 className="fw-bold mb-0">{t('admin.settings.smtp_title', 'SMTP Mail Relay')}</h6>
                <Badge bg={mailDisabledByEnv ? 'warning' : 'info'}>
                  {t('admin.settings.smtp_mode_label', 'Mail Mode')}: {snapshot?.mail_mode || 'dashboard'}
                </Badge>
              </div>

              {mailDisabledByEnv && (
                <Alert variant="warning" className="small">
                  {t('admin.settings.smtp_disabled_hint', 'Outgoing mail is disabled by server environment (AERUN_MAIL_MODE=disabled).')}
                </Alert>
              )}

              <Form.Check
                type="switch"
                id="smtp-enabled-switch"
                label={t('admin.settings.smtp_enabled', 'Enable SMTP delivery')}
                className="mb-3 fw-bold"
                checked={smtpEnabled}
                disabled={mailDisabledByEnv}
                onChange={(e) => setSmtpEnabled(e.target.checked)}
              />

              <Row>
                <Col md={8}>
                  <Form.Group className="mb-3" controlId="smtpHost">
                    <Form.Label className="small fw-bold">{t('admin.settings.smtp_host', 'SMTP Host')}</Form.Label>
                    <Form.Control
                      type="text"
                      disabled={mailDisabledByEnv}
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-3" controlId="smtpPort">
                    <Form.Label className="small fw-bold">{t('admin.settings.smtp_port', 'SMTP Port')}</Form.Label>
                    <Form.Control
                      type="number"
                      min="0"
                      max="65535"
                      disabled={mailDisabledByEnv}
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-3" controlId="smtpUsername">
                    <Form.Label className="small fw-bold">{t('admin.settings.smtp_username', 'SMTP Username')}</Form.Label>
                    <Form.Control
                      type="text"
                      disabled={mailDisabledByEnv}
                      value={smtpUsername}
                      onChange={(e) => setSmtpUsername(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-3" controlId="smtpPassword">
                    <Form.Label className="small fw-bold">
                      {t('admin.settings.smtp_password', 'SMTP Password')}
                      {snapshot?.has_smtp_password ? ` (${snapshot.smtp_password_masked})` : ''}
                    </Form.Label>
                    <Form.Control
                      type="password"
                      autoComplete="new-password"
                      disabled={mailDisabledByEnv}
                      placeholder={snapshot?.has_smtp_password ? t('admin.settings.secrets_keep_placeholder', 'Leave blank to keep current value') : ''}
                      value={smtpPassword}
                      onChange={(e) => setSmtpPassword(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-3" controlId="smtpAuthMethod">
                    <Form.Label className="small fw-bold">{t('admin.settings.smtp_auth_method', 'Auth Method')}</Form.Label>
                    <Form.Select
                      disabled={mailDisabledByEnv}
                      value={smtpAuthMethod}
                      onChange={(e) => setSmtpAuthMethod(e.target.value)}
                    >
                      <option value="PLAIN">PLAIN</option>
                      <option value="LOGIN">LOGIN</option>
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-3" controlId="mailSenderAddress">
                    <Form.Label className="small fw-bold">{t('admin.settings.mail_sender_address', 'Sender Email Address')}</Form.Label>
                    <Form.Control
                      type="email"
                      disabled={mailDisabledByEnv}
                      value={mailSenderAddress}
                      onChange={(e) => setMailSenderAddress(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-3" controlId="mailSenderName">
                    <Form.Label className="small fw-bold">{t('admin.settings.mail_sender_name', 'Sender Display Name')}</Form.Label>
                    <Form.Control
                      type="text"
                      disabled={mailDisabledByEnv}
                      value={mailSenderName}
                      onChange={(e) => setMailSenderName(e.target.value)}
                    />
                  </Form.Group>
                </Col>
              </Row>

              <Form.Check
                type="switch"
                id="smtp-tls-switch"
                label={t('admin.settings.smtp_tls', 'Use TLS')}
                className="fw-bold"
                disabled={mailDisabledByEnv}
                checked={smtpTls}
                onChange={(e) => setSmtpTls(e.target.checked)}
              />
            </div>

            <hr className="my-4" />

            {/* 4. Telemetry IP Hash Salt */}
            <div className="mb-4">
              <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
                <h6 className="fw-bold mb-0">{t('admin.settings.ip_hash_salt_title', 'Telemetry IP Hash Salt')}</h6>
                <Badge bg={snapshot?.has_ip_hash_salt ? 'success' : 'secondary'}>
                  {snapshot?.has_ip_hash_salt
                    ? `${t('admin.settings.secrets_configured', 'Configured')}: ${snapshot.ip_hash_salt_masked}`
                    : t('admin.settings.secrets_not_set', 'Not set')}
                </Badge>
              </div>
              <Form.Group controlId="ipHashSalt">
                <Form.Label className="small fw-bold">{t('admin.settings.ip_hash_salt_label', 'Custom IP Hash Salt (optional)')}</Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="new-password"
                  placeholder={snapshot?.has_ip_hash_salt ? t('admin.settings.secrets_keep_placeholder', 'Leave blank to keep current value') : ''}
                  value={ipHashSalt}
                  onChange={(e) => setIpHashSalt(e.target.value)}
                />
                <div className="small text-muted mt-1 opacity-75">
                  {t('admin.settings.ip_hash_salt_help', 'Optional HMAC salt for IP anonymization hashes. Leave blank to keep existing.')}
                </div>
              </Form.Group>
            </div>

            <Button type="submit" variant="primary" className="d-inline-flex align-items-center gap-2 px-4" disabled={saving}>
              <Save size={16} />
              {saving ? t('admin.settings.saving', 'Saving...') : t('admin.settings.secrets_save_btn', 'Save Secrets')}
            </Button>
          </Form>
        )}
      </div>
    </div>
  );
}
