import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';
import ForumPagination from '../common/ForumPagination';

export default function RecentVisitsTable({
  visits = [],
  total = 0,
  page = 1,
  limit = 25,
  filter = 'all',
  query = '',
  onPageChange,
  onFilterChange,
  onSearchChange,
  onSelectIP,
}) {
  const { t } = useI18n();
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="visits-recent-section">
      {/* Search and Filters Bar */}
      <div className="visits-toolbar">
        <div className="visits-filter-group">
          {[
            { id: 'all', label: t('admin.visits.table.filter_all', 'All') },
            { id: 'members', label: t('admin.visits.table.filter_members', 'Members') },
            { id: 'guests', label: t('admin.visits.table.filter_guests', 'Guests') },
            { id: 'bots', label: t('admin.visits.table.filter_bots', 'Bots') },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? 'admin-btn admin-btn--primary admin-btn--sm' : 'admin-btn admin-btn--secondary admin-btn--sm'}
              onClick={() => onFilterChange && onFilterChange(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <input
          type="text"
          className="visits-search-input"
          placeholder={t('admin.visits.table.search_placeholder', 'Search by nickname, IP, city, or path...')}
          value={query}
          onChange={(e) => onSearchChange && onSearchChange(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="visits-table-scroll">
        <table className="visits-table">
          <thead>
            <tr>
              <th>{t('admin.visits.table.time', 'Time')}</th>
              <th>{t('admin.visits.table.visitor', 'Visitor')}</th>
              <th>{t('admin.visits.table.ip', 'IP Address')}</th>
              <th>{t('admin.visits.table.location', 'Location')}</th>
              <th>{t('admin.visits.table.device', 'Device / OS')}</th>
              <th>{t('admin.visits.table.entry', 'Entry Path')}</th>
            </tr>
          </thead>
          <tbody>
            {visits.length === 0 ? (
              <tr>
                <td colSpan={6} className="visits-empty-state">
                  {t('admin.visits.table.no_visits', 'No visits found.')}
                </td>
              </tr>
            ) : (
              visits.map((v) => {
                const dateStr = v.occurred_at
                  ? new Date(v.occurred_at).toLocaleString([], {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                  : '—';

                let identityBadge = null;
                if (v.is_bot) {
                  identityBadge = (
                    <span className="visits-badge visits-badge--bot">
                      {t('admin.visits.table.bot_badge', 'Bot')}
                    </span>
                  );
                } else if (v.user) {
                  identityBadge = (
                    <span className="visits-badge visits-badge--member">
                      {v.user.nickname || t('admin.visits.table.member_fallback', 'Member')}
                    </span>
                  );
                } else {
                  const shortG = v.guest_id ? v.guest_id.slice(0, 6) : 'anon';
                  identityBadge = (
                    <span className="visits-badge visits-badge--guest">
                      {t('admin.visits.table.guest_badge', 'Guest')} [{shortG}]
                    </span>
                  );
                }

                return (
                  <tr key={v.id}>
                    <td className="admin-muted visits-text-nowrap">{dateStr}</td>
                    <td>{identityBadge}</td>
                    <td>
                      <button
                        type="button"
                        className="visits-ip-badge"
                        onClick={() => onSelectIP && onSelectIP(v.ip, v.ip_hash)}
                        title={t('admin.visits.table.ip_click_hint', 'Click to view IP dossier')}
                      >
                        {v.ip || '—'}
                      </button>
                    </td>
                    <td>
                      {v.country || 'XX'} {v.city ? `(${v.city})` : ''}
                    </td>
                    <td>
                      {v.device} · {v.browser || v.os || 'Other'}
                    </td>
                    <td className="visits-entry-cell">
                      <span title={v.entry_path}>{v.entry_path || '/'}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="visits-pagination-row">
          <ForumPagination
            currentPage={page}
            totalPages={totalPages}
            onPageChange={(p) => onPageChange && onPageChange(p)}
            centered
          />
        </div>
      )}
    </div>
  );
}
