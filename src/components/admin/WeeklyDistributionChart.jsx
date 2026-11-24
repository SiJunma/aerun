import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * 7-day weekly distribution SVG bar chart (0 = Sun .. 6 = Sat).
 * Uses CSS theme tokens, font sizes >= 14px, zero inline styles.
 */
export default function WeeklyDistributionChart({ data = [] }) {
  const { t } = useI18n();

  const rawNames = t('admin.visits.charts.dow_names');
  const dayNames = Array.isArray(rawNames) && rawNames.length === 7
    ? rawNames
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Reorder Monday..Sunday (1, 2, 3, 4, 5, 6, 0) for standard week view
  const orderedIndices = [1, 2, 3, 4, 5, 6, 0];
  const counts = data && data.length === 7 ? data : [0, 0, 0, 0, 0, 0, 0];
  const maxVal = Math.max(...counts, 1);

  const svgWidth = 420;
  const svgHeight = 175;
  const padTop = 16;
  const padBottom = 30;
  const chartH = svgHeight - padTop - padBottom;
  const colW = svgWidth / 7;

  return (
    <div className="visits-chart-wrapper">
      <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="visits-chart-svg">
        {orderedIndices.map((dowIdx, pos) => {
          const val = counts[dowIdx] || 0;
          const barH = Math.max(4, Math.round((val / maxVal) * chartH));
          const barW = Math.round(colW * 0.56);
          const x = Math.round(pos * colW + (colW - barW) / 2);
          const y = padTop + chartH - barH;

          return (
            <g key={dowIdx}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx="4"
                fill="var(--primary-color)"
                opacity={val > 0 ? Math.max(0.45, val / maxVal) : 0.2}
              >
                <title>{`${dayNames[dowIdx]}: ${val}`}</title>
              </rect>
              <text
                x={pos * colW + colW / 2}
                y={svgHeight - 8}
                fill="var(--secondary-color)"
                fontSize="14"
                textAnchor="middle"
              >
                {dayNames[dowIdx]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
