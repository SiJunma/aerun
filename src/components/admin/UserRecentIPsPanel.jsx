import React, { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../contexts/I18nProvider';
import { fetchUserIPs } from '../../api/analytics';
import ErrorCard from '../common/ErrorCard';

/**
 * Displays the recent IP addresses associated with a member account (Sprint 3 §5.2).
 * Clicking any IP opens AdminIPModal for full investigation and ban actions.
 */
export default function UserRecentIPsPanel({ userId, onSelectIP }) {
  const { t } = useI18n();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadIPs = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUserIPs(userId);
      setItems(data?.items || []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadIPs();
  }, [loadIPs]);

  return (
    <div className="visits-user-ips-section">
      <h6 className="visits-dossier-section-title">
        {t('admin.visits.user_ips.title', 'Activity IP Addresses')}
      </h6>
      {loading ? (
        <div className="visits-text-muted">
          {t('admin.visits.user_ips.loading', 'Loading IP history...')}
        </div>
      ) : error ? (
        <ErrorCard error={error} onRetry={loadIPs} />
      ) : items.length === 0 ? (
        <div className="visits-text-muted">
          {t('admin.visits.user_ips.empty', 'No recorded IP visits for this user yet.')}
        </div>
      ) : (
        <div className="visits-table-scroll">
          <table className="visits-table">
            <thead>
              <tr>
                <th>{t('admin.visits.user_ips.col_ip', 'IP Address')}</th>
                <th>{t('admin.visits.user_ips.col_location', 'Location')}</th>
                <th>{t('admin.visits.user_ips.col_first', 'First Seen')}</th>
                <th>{t('admin.visits.user_ips.col_last', 'Last Seen')}</th>
                <th>{t('admin.visits.user_ips.col_visits', 'Visits')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row, idx) => (
                <tr key={row.ip_hash || idx}>
                  <td>
                    <button
                      type="button"
                      className="visits-ip-badge"
                      onClick={() => onSelectIP && onSelectIP(row.ip, row.ip_hash)}
                    >
                      {row.ip || '—'}
                    </button>
                  </td>
                  <td>
                    {row.country || 'XX'} {row.city ? `(${row.city})` : ''}
                  </td>
                  <td className="visits-text-muted visits-text-nowrap">
                    {row.first_seen ? new Date(row.first_seen).toLocaleDateString() : '—'}
                  </td>
                  <td className="visits-text-muted visits-text-nowrap">
                    {row.last_seen ? new Date(row.last_seen).toLocaleDateString() : '—'}
                  </td>
                  <td>{row.visits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
