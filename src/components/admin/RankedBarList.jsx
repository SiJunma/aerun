import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * Reusable ranked bar list for countries, devices, browsers, OS, and entry paths.
 * Uses SVG bar fill so zero inline styles are needed.
 */
export default function RankedBarList({ items = [], maxCount = 0 }) {
  const { t } = useI18n();

  if (!items || items.length === 0) {
    return (
      <div className="visits-empty-state">
        {t('admin.visits.table.no_ranked_data', 'No data available.')}
      </div>
    );
  }

  const computedMax = maxCount || Math.max(...items.map((it) => it.count || 0), 1);
  const totalCount = items.reduce((sum, it) => sum + (it.count || 0), 0);

  return (
    <div className="visits-ranked-list">
      {items.map((item, idx) => {
        const count = item.count || 0;
        const widthPercent = Math.max(3, Math.round((count / computedMax) * 100));
        const sharePercent = totalCount > 0 ? Math.round((count / totalCount) * 100) : 0;
        const name = item.name || 'Unknown';

        return (
          <div key={idx} className="visits-ranked-item">
            <div className="visits-ranked-header">
              <span className="visits-ranked-name" title={name}>{name}</span>
              <span className="visits-text-nowrap">
                {count.toLocaleString()} ({sharePercent}%)
              </span>
            </div>
            <div className="visits-ranked-bar-bg">
              <svg width="100%" height="10" aria-hidden="true">
                <rect
                  x="0"
                  y="0"
                  width={`${widthPercent}%`}
                  height="10"
                  rx="5"
                  fill="var(--primary-color)"
                />
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}
