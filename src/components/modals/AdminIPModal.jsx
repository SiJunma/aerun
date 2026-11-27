import React, { useState, useEffect, useCallback } from 'react';
import ForumModal from '../common/ForumModal';
import ErrorCard from '../common/ErrorCard';
import { useI18n } from '../../contexts/I18nProvider';
import { fetchIPDossier, unbanIP } from '../../api/analytics';
import { useAuth } from '../../contexts/AuthProvider';
import { PERMISSIONS } from '../../constants/permissions';

export default function AdminIPModal({
  show,
  onHide,
  targetIP,
  targetHash,
  onOpenBanModal,
  onUnbanSuccess,
}) {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const [loading, setLoading] = useState(false);
  const [dossier, setDossier] = useState(null);
  const [error, setError] = useState(null);
  const [unbanning, setUnbanning] = useState(false);

  const loadDossier = useCallback(async () => {
    if (!show || (!targetIP && !targetHash)) return null;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchIPDossier({ ip: targetIP, ipHash: targetHash });
      return data;
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [show, targetIP, targetHash]);

  useEffect(() => {
    if (!show || (!targetIP && !targetHash)) {
      setDossier(null);
      setError(null);
      return;
    }
    let active = true;
    loadDossier().then((data) => {
      if (active && data) {
        setDossier(data);
      }
    });
    return () => {
      active = false;
    };
  }, [show, targetIP, targetHash, loadDossier]);

  const handleUnban = async () => {
    if (!dossier?.ban_info?.id) return;
    setUnbanning(true);
    setError(null);
    try {
      await unbanIP(dossier.ban_info.id);
      setDossier((prev) => ({ ...prev, is_banned: false, ban_info: null }));
      if (onUnbanSuccess) onUnbanSuccess();
    } catch (err) {
      setError(err);
    } finally {
      setUnbanning(false);
    }
  };

  const canManageBans = hasPermission(PERMISSIONS.MANAGE_IP_BANS);
  const rawBanTarget = dossier?.ip && !dossier.ip.includes('*') ? dossier.ip : '';
  const displayTitleIP = dossier?.ip || targetIP || targetHash || '';

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={`${t('admin.visits.dossier.title', 'IP Address Dossier')}: ${displayTitleIP}`}
      size="lg"
      footer={
        <div className="visits-dossier-footer">
          <div>
            {canManageBans && dossier && (
              dossier.is_banned ? (
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost admin-btn--activate"
                  onClick={handleUnban}
                  disabled={unbanning}
                >
                  {unbanning
                    ? t('admin.visits.dossier.processing', 'Processing...')
                    : t('admin.visits.dossier.unban_action', 'Unban IP')}
                </button>
              ) : rawBanTarget ? (
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost admin-btn--danger"
                  onClick={() => {
                    onHide();
                    if (onOpenBanModal) {
                      onOpenBanModal(rawBanTarget, (dossier.associated_accounts || []).length);
                    }
                  }}
                >
                  {t('admin.visits.dossier.ban_action', 'Ban IP')}
                </button>
              ) : null
            )}
          </div>
          <button type="button" className="admin-btn admin-btn--secondary" onClick={onHide}>
            {t('admin.visits.dossier.close', 'Close')}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="visits-empty-state">
          {t('admin.visits.dossier.loading', 'Loading intelligence data...')}
        </div>
      ) : error ? (
        <ErrorCard error={error} onRetry={loadDossier} />
      ) : dossier ? (
        <div className="visits-stack--md">
          {/* Header Status */}
          <div className="visits-dossier-header">
            <div>
              <strong>{t('admin.visits.dossier.location_label', 'Location')}:</strong>{' '}
              {dossier.country || 'XX'} {dossier.city ? `(${dossier.city})` : ''}
            </div>
            <div>
              {dossier.is_banned ? (
                <span className="visits-badge visits-badge--banned">
                  ⛔ {t('admin.visits.dossier.banned_badge', 'Banned')}
                </span>
              ) : (
                <span className="visits-badge visits-badge--member">
                  ✓ {t('admin.visits.dossier.active_badge', 'Allowed')}
                </span>
              )}
            </div>
          </div>

          {/* Ban Info only when actually banned */}
          {dossier.is_banned && dossier.ban_info && (
            <div className="visits-anomaly-card visits-anomaly-card--danger">
              <div>
                <strong>{t('admin.visits.dossier.ban_reason', 'Ban Reason')}:</strong>{' '}
                {dossier.ban_info.reason || '—'}
              </div>
              {dossier.ban_info.expires_at && (
                <div>
                  <strong>{t('admin.visits.dossier.expires', 'Expires')}:</strong>{' '}
                  {new Date(dossier.ban_info.expires_at).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {/* Associated Accounts */}
          <div>
            <h5 className="visits-dossier-section-title">
              {t('admin.visits.dossier.associated_accounts', 'Associated Accounts')} (
              {(dossier.associated_accounts || []).length})
            </h5>
            {!dossier.associated_accounts || dossier.associated_accounts.length === 0 ? (
              <div className="admin-muted">
                {t('admin.visits.dossier.no_accounts', 'No registered accounts recorded from this IP')}
              </div>
            ) : (
              <div className="visits-table-scroll">
                <table className="visits-table">
                  <thead>
                    <tr>
                      <th>{t('admin.visits.dossier.col_account', 'Account')}</th>
                      <th>{t('admin.visits.dossier.col_role', 'Role')}</th>
                      <th>{t('admin.visits.dossier.col_first_seen', 'First Seen')}</th>
                      <th>{t('admin.visits.dossier.col_last_seen', 'Last Seen')}</th>
                      <th>{t('admin.visits.dossier.col_visits', 'Visits')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dossier.associated_accounts.map((acc, idx) => (
                      <tr key={idx}>
                        <td>
                          <strong>{acc.user?.nickname || acc.user?.id}</strong>
                        </td>
                        <td>{acc.user?.role}</td>
                        <td className="admin-muted">
                          {acc.first_seen ? new Date(acc.first_seen).toLocaleDateString() : '—'}
                        </td>
                        <td className="admin-muted">
                          {acc.last_seen ? new Date(acc.last_seen).toLocaleDateString() : '—'}
                        </td>
                        <td>{acc.visits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Guest Stats */}
          <div className="admin-muted">
            <strong>{t('admin.visits.dossier.guest_sessions', 'Guest Sessions')}:</strong>{' '}
            {dossier.guest_count || 0}
          </div>

          {/* Recent Activity */}
          <div>
            <h5 className="visits-dossier-section-title">
              {t('admin.visits.dossier.recent_activity', 'Recent Activity (Last 50 Visits)')}
            </h5>
            <div className="visits-table-scroll visits-table-scroll--modal">
              <table className="visits-table">
                <thead>
                  <tr>
                    <th>{t('admin.visits.dossier.col_time', 'Time')}</th>
                    <th>{t('admin.visits.dossier.col_user_guest', 'User / Guest')}</th>
                    <th>{t('admin.visits.dossier.col_device', 'Device')}</th>
                    <th>{t('admin.visits.dossier.col_path', 'Path')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(dossier.recent_visits || []).map((rv) => {
                    const dateStr = rv.occurred_at
                      ? new Date(rv.occurred_at).toLocaleString([], {
                        month: 'short',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                      : '—';

                    let identityBadge = null;
                    if (rv.is_bot) {
                      identityBadge = (
                        <span className="visits-badge visits-badge--bot">
                          {t('admin.visits.table.bot_badge', 'Bot')}
                        </span>
                      );
                    } else if (rv.user || rv.user_id) {
                      identityBadge = (
                        <span className="visits-badge visits-badge--member">
                          {rv.user?.nickname || rv.user_id || t('admin.visits.table.member_fallback', 'Member')}
                        </span>
                      );
                    } else {
                      const shortG = rv.guest_id ? rv.guest_id.slice(0, 6) : 'anon';
                      identityBadge = (
                        <span className="visits-badge visits-badge--guest">
                          {t('admin.visits.table.guest_badge', 'Guest')} [{shortG}]
                        </span>
                      );
                    }

                    return (
                      <tr key={rv.id}>
                        <td className="admin-muted visits-text-nowrap">{dateStr}</td>
                        <td>{identityBadge}</td>
                        <td>
                          {rv.device || 'unknown'} · {rv.browser || rv.os || 'Other'}
                        </td>
                        <td>{rv.entry_path || '/'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </ForumModal>
  );
}
