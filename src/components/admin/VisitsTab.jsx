import React, { useState, useEffect, useCallback } from 'react';
import { RotateCw, ShieldBan } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { useToast } from '../../contexts/ToastProvider';
import { PERMISSIONS } from '../../constants/permissions';
import {
  fetchAnalyticsDashboard,
  fetchAnalyticsTopics,
  fetchAnalyticsSuspicious,
  fetchAnalyticsVisits,
  fetchIPBans,
  unbanIP,
} from '../../api/analytics';
import ErrorCard from '../common/ErrorCard';
import ForumPagination from '../common/ForumPagination';
import DailyVisitsChart from './DailyVisitsChart';
import HourlyDistributionChart from './HourlyDistributionChart';
import WeeklyDistributionChart from './WeeklyDistributionChart';
import RankedBarList from './RankedBarList';
import TopTopicsTable from './TopTopicsTable';
import RecentVisitsTable from './RecentVisitsTable';
import SuspiciousActivitySection from './SuspiciousActivitySection';
import AdminIPModal from '../modals/AdminIPModal';
import BanIPModal from '../modals/BanIPModal';
import './VisitsTab.css';

export default function VisitsTab() {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();

  const canManageBans = hasPermission(PERMISSIONS.MANAGE_IP_BANS);

  const [period, setPeriod] = useState('30d');
  const [loading, setLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);
  const [topicsData, setTopicsData] = useState([]);
  const [suspiciousData, setSuspiciousData] = useState(null);

  // Visits table state
  const [visits, setVisits] = useState([]);
  const [visitsTotal, setVisitsTotal] = useState(0);
  const [visitsPage, setVisitsPage] = useState(1);
  const [visitsFilter, setVisitsFilter] = useState('all');
  const [visitsQuery, setVisitsQuery] = useState('');
  const [visitsError, setVisitsError] = useState(null);

  // IP Bans table state
  const [ipBans, setIpBans] = useState([]);
  const [bansTotal, setBansTotal] = useState(0);
  const [bansPage, setBansPage] = useState(1);
  const [bansStatus, setBansStatus] = useState('active');
  const [unbanningId, setUnbanningId] = useState('');

  // Modals state
  const [selectedIP, setSelectedIP] = useState('');
  const [selectedHash, setSelectedHash] = useState('');
  const [showIPModal, setShowIPModal] = useState(false);

  const [showBanModal, setShowBanModal] = useState(false);
  const [banInitialIP, setBanInitialIP] = useState('');
  const [banAccountCount, setBanAccountCount] = useState(0);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setDashboardError(null);
    try {
      const [dashJson, topJson, suspJson] = await Promise.all([
        fetchAnalyticsDashboard(period),
        fetchAnalyticsTopics(period, 15),
        fetchAnalyticsSuspicious(),
      ]);
      setDashboardData(dashJson);
      setTopicsData(topJson?.items || []);
      setSuspiciousData(suspJson);
    } catch (err) {
      setDashboardError(err);
    } finally {
      setLoading(false);
    }
  }, [period]);

  const fetchVisits = useCallback(async () => {
    setVisitsError(null);
    try {
      const data = await fetchAnalyticsVisits({
        page: visitsPage,
        limit: 25,
        filter: visitsFilter,
        query: visitsQuery,
      });
      setVisits(data?.items || []);
      setVisitsTotal(data?.total || 0);
    } catch (err) {
      setVisitsError(err);
    }
  }, [visitsPage, visitsFilter, visitsQuery]);

  const loadBans = useCallback(async () => {
    if (!canManageBans) return;
    try {
      const data = await fetchIPBans({ page: bansPage, limit: 15, status: bansStatus });
      setIpBans(data?.items || []);
      setBansTotal(data?.total || 0);
    } catch {
      // Non-fatal: table remains empty or previous snapshot
    }
  }, [canManageBans, bansPage, bansStatus]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => {
    fetchVisits();
  }, [fetchVisits]);

  useEffect(() => {
    loadBans();
  }, [loadBans]);

  const handleSelectIP = (ip, ipHash) => {
    setSelectedIP(ip || '');
    setSelectedHash(ipHash || '');
    setShowIPModal(true);
  };

  const handleOpenBanModal = (ip, accCount) => {
    setBanInitialIP(ip || '');
    setBanAccountCount(accCount || 0);
    setShowBanModal(true);
  };

  const handleUnbanRow = async (banId) => {
    setUnbanningId(banId);
    try {
      await unbanIP(banId);
      loadBans();
    } catch (err) {
      showToast(err.message || 'Failed to unban IP', 'danger');
    } finally {
      setUnbanningId('');
    }
  };

  const refreshAll = () => {
    fetchDashboard();
    fetchVisits();
    loadBans();
  };

  const kpis = dashboardData?.kpis || {};
  const bansTotalPages = Math.ceil(bansTotal / 15) || 1;

  const calcDelta = (curr = 0, prev = 0) => {
    if (!prev) return curr > 0 ? '+100%' : '0%';
    const pct = Math.round(((curr - prev) / prev) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  };

  return (
    <div className="visits-dashboard">
      {/* Header controls */}
      <div className="visits-header-bar">
        <div className="visits-period-selector">
          {[
            { id: 'today', label: t('admin.visits.periods.today', 'Today') },
            { id: '7d', label: t('admin.visits.periods.seven_days', '7 Days') },
            { id: '30d', label: t('admin.visits.periods.thirty_days', '30 Days') },
          ].map((p) => (
            <button
              key={p.id}
              type="button"
              className={`visits-period-btn ${period === p.id ? 'visits-period-btn--active' : ''}`}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="visits-header-actions">
          {canManageBans && (
            <button
              type="button"
              className="visits-danger-btn"
              onClick={() => handleOpenBanModal('', 0)}
            >
              <ShieldBan size={16} />
              {t('admin.visits.ban_table.add_ban', 'Block IP / Subnet')}
            </button>
          )}
          <button
            type="button"
            className="visits-refresh-btn"
            onClick={refreshAll}
            disabled={loading}
          >
            <RotateCw size={16} className={loading ? 'spin' : ''} />
            {t('admin.visits.refresh', 'Refresh Data')}
          </button>
        </div>
      </div>

      {dashboardError && (
        <ErrorCard error={dashboardError} onRetry={fetchDashboard} />
      )}

      {/* 1. KPI Cards Row */}
      <div className="visits-kpi-grid">
        {/* Online Now */}
        <div className="visits-kpi-card">
          <div className="visits-kpi-label">{t('admin.visits.kpi.online_now', 'Online Now')}</div>
          <div className="visits-kpi-value">{kpis.online_now || 0}</div>
          <div className="visits-kpi-subtext">
            <span>{kpis.members_online || 0} {t('admin.visits.kpi.members', 'members')}</span>
            <span>·</span>
            <span>{kpis.guests_online || 0} {t('admin.visits.kpi.guests', 'guests')}</span>
          </div>
        </div>

        {/* Total Visits */}
        <div className="visits-kpi-card">
          <div className="visits-kpi-label">{t('admin.visits.kpi.total_visits', 'Visits')}</div>
          <div className="visits-kpi-value">{(kpis.total_visits || 0).toLocaleString()}</div>
          <div className="visits-kpi-subtext">
            <span
              className={
                (kpis.total_visits || 0) >= (kpis.prev_visits || 0)
                  ? 'visits-delta--positive'
                  : 'visits-delta--negative'
              }
            >
              {calcDelta(kpis.total_visits, kpis.prev_visits)}
            </span>
            <span>{t('admin.visits.kpi.vs_prev', 'vs prev')}</span>
            <span>·</span>
            <span>{kpis.bot_visits || 0} {t('admin.visits.kpi.bots', 'bots')}</span>
          </div>
        </div>

        {/* Unique Visitors */}
        <div className="visits-kpi-card">
          <div className="visits-kpi-label">{t('admin.visits.kpi.unique_visitors', 'Unique Visitors')}</div>
          <div className="visits-kpi-value">{(kpis.unique_visitors || 0).toLocaleString()}</div>
          <div className="visits-kpi-subtext">
            <span
              className={
                (kpis.unique_visitors || 0) >= (kpis.prev_uniques || 0)
                  ? 'visits-delta--positive'
                  : 'visits-delta--negative'
              }
            >
              {calcDelta(kpis.unique_visitors, kpis.prev_uniques)}
            </span>
            <span>{t('admin.visits.kpi.vs_prev', 'vs prev')}</span>
          </div>
        </div>

        {/* Registrations */}
        <div className="visits-kpi-card">
          <div className="visits-kpi-label">{t('admin.visits.kpi.registrations', 'New Registrations')}</div>
          <div className="visits-kpi-value">+{kpis.registrations || 0}</div>
          <div className="visits-kpi-subtext">
            <span
              className={
                (kpis.registrations || 0) >= (kpis.prev_reg || 0)
                  ? 'visits-delta--positive'
                  : 'visits-delta--negative'
              }
            >
              {calcDelta(kpis.registrations, kpis.prev_reg)}
            </span>
            <span>{t('admin.visits.kpi.vs_prev', 'vs prev')}</span>
          </div>
        </div>

        {/* Posts */}
        <div className="visits-kpi-card">
          <div className="visits-kpi-label">{t('admin.visits.kpi.posts', 'Posts Created')}</div>
          <div className="visits-kpi-value">+{kpis.posts_count || 0}</div>
          <div className="visits-kpi-subtext">
            <span
              className={
                (kpis.posts_count || 0) >= (kpis.prev_posts || 0)
                  ? 'visits-delta--positive'
                  : 'visits-delta--negative'
              }
            >
              {calcDelta(kpis.posts_count, kpis.prev_posts)}
            </span>
            <span>{t('admin.visits.kpi.vs_prev', 'vs prev')}</span>
          </div>
        </div>
      </div>

      {/* 2. Daily Traffic Dynamics Chart */}
      <div className="admin-card">
        <div className="admin-card__header">
          <h3 className="visits-card-title">
            {t('admin.visits.charts.daily_dynamics', 'Daily Traffic Dynamics')}
          </h3>
        </div>
        <div className="admin-card__body">
          <DailyVisitsChart data={dashboardData?.daily_series || []} />
        </div>
      </div>

      {/* 3. Two-Column Grid: Left (Hourly, Weekly & Entry Paths), Right (Countries, Devices, Browsers, OS) */}
      <div className="visits-two-column-grid">
        <div className="visits-stack">
          <div className="admin-card">
            <div className="admin-card__header">
              <h3 className="visits-card-title visits-card-title--sm">
                {t('admin.visits.charts.hourly_distribution', '24h Activity by Hour')}
              </h3>
            </div>
            <div className="admin-card__body">
              <HourlyDistributionChart data={dashboardData?.hourly_series || []} />
            </div>
          </div>

          <div className="admin-card">
            <div className="admin-card__header">
              <h3 className="visits-card-title visits-card-title--sm">
                {t('admin.visits.charts.dow_distribution', 'Weekly Distribution')}
              </h3>
            </div>
            <div className="admin-card__body">
              <WeeklyDistributionChart data={dashboardData?.dow_series || []} />
            </div>
          </div>

          <div className="admin-card">
            <div className="admin-card__header">
              <h3 className="visits-card-title visits-card-title--sm">
                {t('admin.visits.sections.top_entry_paths', 'Top Entry Paths')}
              </h3>
            </div>
            <div className="admin-card__body">
              <RankedBarList items={dashboardData?.top_entry_paths || []} />
            </div>
          </div>
        </div>

        <div className="visits-stack">
          <div className="admin-card">
            <div className="admin-card__header">
              <h3 className="visits-card-title visits-card-title--sm">
                {t('admin.visits.sections.top_countries', 'Top Countries')}
              </h3>
            </div>
            <div className="admin-card__body">
              <RankedBarList items={dashboardData?.top_countries || []} />
            </div>
          </div>

          <div className="admin-card">
            <div className="admin-card__header">
              <h3 className="visits-card-title visits-card-title--sm">
                {t('admin.visits.sections.top_devices', 'Devices')} & {t('admin.visits.sections.top_browsers', 'Browsers')}
              </h3>
            </div>
            <div className="admin-card__body visits-stack--md">
              <div>
                <h4 className="visits-sub-heading">
                  {t('admin.visits.sections.top_devices', 'Devices')}
                </h4>
                <RankedBarList items={dashboardData?.top_devices || []} />
              </div>
              <div>
                <h4 className="visits-sub-heading">
                  {t('admin.visits.sections.top_browsers', 'Browsers')}
                </h4>
                <RankedBarList items={dashboardData?.top_browsers || []} />
              </div>
              <div>
                <h4 className="visits-sub-heading">
                  {t('admin.visits.sections.top_os', 'Operating Systems')}
                </h4>
                <RankedBarList items={dashboardData?.top_os || []} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Popular Topics Table */}
      <div className="admin-card">
        <div className="admin-card__header">
          <h3 className="visits-card-title">
            {t('admin.visits.sections.topic_visits', 'Popular Topics Readership')}
          </h3>
        </div>
        <div className="admin-card__body">
          <TopTopicsTable topics={topicsData} />
        </div>
      </div>

      {/* 5. Recent Visits Table */}
      <div className="admin-card">
        <div className="admin-card__header">
          <h3 className="visits-card-title">
            {t('admin.visits.sections.recent_visits', 'Recent Visits Log')}
          </h3>
        </div>
        <div className="admin-card__body">
          {visitsError ? (
            <ErrorCard error={visitsError} onRetry={fetchVisits} />
          ) : (
            <RecentVisitsTable
              visits={visits}
              total={visitsTotal}
              page={visitsPage}
              limit={25}
              filter={visitsFilter}
              query={visitsQuery}
              onPageChange={setVisitsPage}
              onFilterChange={(f) => {
                setVisitsFilter(f);
                setVisitsPage(1);
              }}
              onSearchChange={(q) => {
                setVisitsQuery(q);
                setVisitsPage(1);
              }}
              onSelectIP={handleSelectIP}
            />
          )}
        </div>
      </div>

      {/* 6. Suspicious Activity & Security Anomalies */}
      <div className="admin-card">
        <div className="admin-card__header">
          <h3 className="visits-card-title">
            {t('admin.visits.sections.suspicious', 'Security & Abuse Anomalies')}
          </h3>
        </div>
        <div className="admin-card__body">
          <SuspiciousActivitySection
            anomalies={suspiciousData}
            onSelectIP={handleSelectIP}
          />
        </div>
      </div>

      {/* 7. Active IP Bans Management (§6 / Sprint 4) */}
      {canManageBans && (
        <div className="admin-card">
          <div className="admin-card__header visits-card-header-flex">
            <h3 className="visits-card-title">
              {t('admin.visits.sections.ip_bans', 'Blocked IP Addresses & Subnets')}
            </h3>
            <div className="visits-filter-group">
              {[
                { id: 'active', label: t('admin.visits.ban_table.status_active', 'Active Bans') },
                { id: 'all', label: t('admin.visits.ban_table.status_all', 'All History') },
              ].map((st) => (
                <button
                  key={st.id}
                  type="button"
                  className={`visits-period-btn ${bansStatus === st.id ? 'visits-period-btn--active' : ''}`}
                  onClick={() => {
                    setBansStatus(st.id);
                    setBansPage(1);
                  }}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>
          <div className="admin-card__body">
            {ipBans.length === 0 ? (
              <div className="visits-empty-state">
                {t('admin.visits.ban_table.empty', 'No active IP bans.')}
              </div>
            ) : (
              <>
                <div className="visits-table-scroll">
                  <table className="visits-table">
                    <thead>
                      <tr>
                        <th>{t('admin.visits.ban_table.target', 'IP / Subnet')}</th>
                        <th>{t('admin.visits.ban_table.reason', 'Reason')}</th>
                        <th>{t('admin.visits.ban_table.created_at', 'Created')}</th>
                        <th>{t('admin.visits.ban_table.expires', 'Expires')}</th>
                        <th>{t('admin.visits.ban_table.actions', 'Actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ipBans.map((b) => (
                        <tr key={b.id}>
                          <td>
                            <span className="visits-ip-badge">{b.ip_or_subnet}</span>
                          </td>
                          <td>{b.reason}</td>
                          <td className="visits-text-muted visits-text-nowrap">
                            {b.created_at ? new Date(b.created_at).toLocaleDateString() : '—'}
                          </td>
                          <td className="visits-text-muted visits-text-nowrap">
                            {b.expires_at
                              ? new Date(b.expires_at).toLocaleString()
                              : t('admin.visits.ban_table.permanent', 'Permanent')}
                          </td>
                          <td>
                            {b.is_active ? (
                              <button
                                type="button"
                                className="visits-period-btn"
                                disabled={unbanningId === b.id}
                                onClick={() => handleUnbanRow(b.id)}
                              >
                                {t('admin.visits.ban_table.unban', 'Unban')}
                              </button>
                            ) : (
                              <span className="visits-text-muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {bansTotalPages > 1 && (
                  <div className="visits-pagination-row">
                    <ForumPagination
                      currentPage={bansPage}
                      totalPages={bansTotalPages}
                      onPageChange={setBansPage}
                      centered
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      <AdminIPModal
        show={showIPModal}
        onHide={() => setShowIPModal(false)}
        targetIP={selectedIP}
        targetHash={selectedHash}
        onOpenBanModal={handleOpenBanModal}
        onUnbanSuccess={refreshAll}
      />

      <BanIPModal
        show={showBanModal}
        onHide={() => setShowBanModal(false)}
        initialIP={banInitialIP}
        associatedAccountsCount={banAccountCount}
        onBanSuccess={refreshAll}
      />
    </div>
  );
}
