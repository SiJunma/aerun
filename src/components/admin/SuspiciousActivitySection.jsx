import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';

export default function SuspiciousActivitySection({ anomalies, onSelectIP }) {
  const { t } = useI18n();

  if (!anomalies) return null;

  const multiAccounts = anomalies.multiple_accounts || [];
  const regBursts = anomalies.registration_bursts || [];
  const multiIPs = anomalies.multi_ip_accounts || [];
  const guestSurges = anomalies.guest_surges || [];

  const hasAnyAnomalies =
    multiAccounts.length > 0 ||
    regBursts.length > 0 ||
    multiIPs.length > 0 ||
    guestSurges.length > 0;

  if (!hasAnyAnomalies) {
    return (
      <div className="visits-empty-state">
        {t('admin.visits.suspicious.no_anomalies', 'No security anomalies detected.')}
      </div>
    );
  }

  return (
    <div className="visits-suspicious-container">
      {/* 1. Multiple accounts on single IP */}
      {multiAccounts.length > 0 && (
        <div className="visits-anomaly-card">
          <h4 className="visits-anomaly-title">
            ⚠️ {t('admin.visits.suspicious.multi_accounts', 'Multiple Accounts on Single IP')} (≥3)
          </h4>
          <div className="visits-table-scroll">
            <table className="visits-table">
              <thead>
                <tr>
                  <th>{t('admin.visits.suspicious.col_ip', 'IP Address')}</th>
                  <th>{t('admin.visits.suspicious.col_location', 'Location')}</th>
                  <th>{t('admin.visits.suspicious.col_accounts', 'Accounts Detected')}</th>
                  <th>{t('admin.visits.suspicious.col_action', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {multiAccounts.map((item, idx) => (
                  <tr key={idx}>
                    <td>
                      <button
                        type="button"
                        className="visits-ip-badge"
                        onClick={() => onSelectIP && onSelectIP(item.ip, item.ip_hash)}
                      >
                        {item.ip}
                      </button>
                    </td>
                    <td>
                      {item.country || 'XX'} {item.city ? `(${item.city})` : ''}
                    </td>
                    <td>
                      <strong className="visits-text-danger">
                        {item.account_count} {t('admin.visits.suspicious.accounts_suffix', 'accounts')}
                      </strong>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="visits-period-btn"
                        onClick={() => onSelectIP && onSelectIP(item.ip, item.ip_hash)}
                      >
                        {t('admin.visits.suspicious.inspect_dossier', 'Inspect Dossier')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 2. Registration Bursts (24h) */}
      {regBursts.length > 0 && (
        <div className="visits-anomaly-card visits-anomaly-card--danger">
          <h4 className="visits-anomaly-title visits-text-danger">
            🚨 {t('admin.visits.suspicious.registration_spikes', 'Registration Spikes (24h)')} (≥2)
          </h4>
          <div className="visits-table-scroll">
            <table className="visits-table">
              <thead>
                <tr>
                  <th>{t('admin.visits.suspicious.col_ip', 'IP Address')}</th>
                  <th>{t('admin.visits.suspicious.col_location', 'Location')}</th>
                  <th>{t('admin.visits.suspicious.col_registrations', 'Registrations')}</th>
                  <th>{t('admin.visits.suspicious.col_action', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {regBursts.map((item, idx) => (
                  <tr key={idx}>
                    <td>
                      <button
                        type="button"
                        className="visits-ip-badge"
                        onClick={() => onSelectIP && onSelectIP(item.ip, item.ip_hash)}
                      >
                        {item.ip}
                      </button>
                    </td>
                    <td>
                      {item.country || 'XX'} {item.city ? `(${item.city})` : ''}
                    </td>
                    <td>
                      <strong className="visits-text-danger">
                        {item.reg_count} {t('admin.visits.suspicious.registrations_suffix', 'accounts')}
                      </strong>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="visits-period-btn"
                        onClick={() => onSelectIP && onSelectIP(item.ip, item.ip_hash)}
                      >
                        {t('admin.visits.suspicious.inspect_dossier', 'Inspect Dossier')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. Frequent IP Swapping */}
      {multiIPs.length > 0 && (
        <div className="visits-anomaly-card">
          <h4 className="visits-anomaly-title">
            🔄 {t('admin.visits.suspicious.multi_ip', 'Frequent IP Swapping (≥4 IPs in 24h)')}
          </h4>
          <div className="visits-table-scroll">
            <table className="visits-table">
              <thead>
                <tr>
                  <th>{t('admin.visits.suspicious.col_user', 'User')}</th>
                  <th>{t('admin.visits.suspicious.col_distinct_ips', 'Distinct IPs')}</th>
                </tr>
              </thead>
              <tbody>
                {multiIPs.map((item, idx) => (
                  <tr key={idx}>
                    <td>
                      <strong>{item.nickname}</strong> ({item.user_id})
                    </td>
                    <td>
                      <strong className="visits-text-warning">
                        {item.ip_count} {t('admin.visits.suspicious.distinct_ips_suffix', 'distinct IPs')}
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. Guest Surges */}
      {guestSurges.length > 0 && (
        <div className="visits-anomaly-card">
          <h4 className="visits-anomaly-title">
            🌊 {t('admin.visits.suspicious.guest_surges', 'Guest Request Surges (≥15 in 1h)')}
          </h4>
          <div className="visits-table-scroll">
            <table className="visits-table">
              <thead>
                <tr>
                  <th>{t('admin.visits.suspicious.col_ip', 'IP Address')}</th>
                  <th>{t('admin.visits.suspicious.col_country', 'Country')}</th>
                  <th>{t('admin.visits.suspicious.col_guest_sessions', 'Guest Sessions (1h)')}</th>
                  <th>{t('admin.visits.suspicious.col_action', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {guestSurges.map((item, idx) => (
                  <tr key={idx}>
                    <td>
                      <button
                        type="button"
                        className="visits-ip-badge"
                        onClick={() => onSelectIP && onSelectIP(item.ip, item.ip_hash)}
                      >
                        {item.ip}
                      </button>
                    </td>
                    <td>{item.country || 'XX'}</td>
                    <td>
                      <strong>
                        {item.guest_count} {t('admin.visits.suspicious.sessions_suffix', 'sessions')}
                      </strong>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="visits-period-btn"
                        onClick={() => onSelectIP && onSelectIP(item.ip, item.ip_hash)}
                      >
                        {t('admin.visits.suspicious.inspect_dossier', 'Inspect Dossier')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
