import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * Pure SVG Daily Visits & Traffic Dynamics Chart.
 * No third-party bundle weight, theme-token adaptive, fonts >= 14px, zero inline styles.
 */
export default function DailyVisitsChart({ data = [] }) {
  const { t } = useI18n();

  if (!data || data.length === 0) {
    return (
      <div className="visits-empty-state">
        {t('admin.visits.charts.no_data', 'No traffic recorded for this period.')}
      </div>
    );
  }

  const height = 240;
  const paddingLeft = 50;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 40;
  const chartHeight = height - paddingTop - paddingBottom;
  const chartWidth = Math.max(540, data.length * 48);

  const maxVal = Math.max(
    ...data.map((d) => Math.max(d.Visits || d.visits || 0, d.Uniques || d.uniques || 0, d.Bots || d.bots || 0)),
    10
  );

  const stepX = (chartWidth - paddingLeft - paddingRight) / data.length;

  const botPoints = data.map((d, i) => {
    const val = d.Bots || d.bots || 0;
    const x = paddingLeft + i * stepX + stepX / 2;
    const y = paddingTop + chartHeight - (val / maxVal) * chartHeight;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="visits-chart-wrapper">
      <div className="visits-table-scroll">
        <svg
          viewBox={`0 0 ${chartWidth} ${height}`}
          width={chartWidth}
          height={height}
          className="visits-chart-svg"
        >
          {/* Horizontal Grid lines */}
          {[0, 0.5, 1].map((ratio) => {
            const y = paddingTop + chartHeight * (1 - ratio);
            const val = Math.round(maxVal * ratio);
            return (
              <g key={ratio}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={chartWidth - paddingRight}
                  y2={y}
                  stroke="var(--border-color)"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text
                  x={paddingLeft - 8}
                  y={y + 5}
                  fill="var(--secondary-color)"
                  fontSize="14"
                  textAnchor="end"
                >
                  {val}
                </text>
              </g>
            );
          })}

          {/* Daily Bars */}
          {data.map((d, i) => {
            const visits = d.Visits || d.visits || 0;
            const uniques = d.Uniques || d.uniques || 0;
            const bots = d.Bots || d.bots || 0;
            const dayStr = (d.Date || d.day || '').slice(5); // MM-DD

            const barW = Math.max(8, stepX * 0.35);
            const xVisits = paddingLeft + i * stepX + stepX * 0.15;
            const xUniques = xVisits + barW + 2;

            const hVisits = (visits / maxVal) * chartHeight;
            const yVisits = paddingTop + chartHeight - hVisits;

            const hUniques = (uniques / maxVal) * chartHeight;
            const yUniques = paddingTop + chartHeight - hUniques;

            return (
              <g key={i}>
                <rect
                  x={xVisits}
                  y={yVisits}
                  width={barW}
                  height={Math.max(2, hVisits)}
                  rx="3"
                  fill="var(--primary-color)"
                >
                  <title>{`${d.Date || d.day}: ${visits} (${bots} bots)`}</title>
                </rect>

                <rect
                  x={xUniques}
                  y={yUniques}
                  width={barW}
                  height={Math.max(2, hUniques)}
                  rx="3"
                  fill="color-mix(in srgb, var(--primary-color) 60%, var(--card-bg))"
                  stroke="var(--primary-color)"
                  strokeWidth="1"
                >
                  <title>{`${d.Date || d.day}: ${uniques}`}</title>
                </rect>

                <text
                  x={xVisits + barW}
                  y={height - 10}
                  fill="var(--secondary-color)"
                  fontSize="14"
                  textAnchor="middle"
                >
                  {dayStr}
                </text>
              </g>
            );
          })}

          {botPoints && (
            <polyline
              fill="none"
              stroke="var(--secondary-color)"
              strokeWidth="2"
              strokeDasharray="4 4"
              points={botPoints}
            />
          )}
        </svg>
      </div>

      <div className="visits-chart-legend">
        <div className="visits-legend-item">
          <span className="visits-legend-color visits-legend-color--primary" />
          <span>{t('admin.visits.charts.visits', 'Visits')}</span>
        </div>
        <div className="visits-legend-item">
          <span className="visits-legend-color visits-legend-color--uniques" />
          <span>{t('admin.visits.charts.uniques', 'Uniques')}</span>
        </div>
        <div className="visits-legend-item">
          <span className="visits-legend-color visits-legend-color--bots" />
          <span>{t('admin.visits.charts.bots', 'Bots')}</span>
        </div>
      </div>
    </div>
  );
}
