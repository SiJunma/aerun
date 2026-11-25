import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * 24-hour activity distribution SVG bar chart.
 * Fonts >= 14px, theme-token adaptive, zero inline styles.
 */
export default function HourlyDistributionChart({ data = [] }) {
  const { t } = useI18n();

  const hours = data && data.length === 24 ? data : new Array(24).fill(0);
  const maxVal = Math.max(...hours, 1);

  let peakHour = 0;
  let peakVal = 0;
  hours.forEach((val, hr) => {
    if (val > peakVal) {
      peakVal = val;
      peakHour = hr;
    }
  });

  const svgWidth = 528; // 24 * 22
  const svgHeight = 170;
  const padTop = 14;
  const padBottom = 30;
  const chartH = svgHeight - padTop - padBottom;
  const colW = svgWidth / 24;

  return (
    <div className="visits-hourly-section">
      <div className="visits-table-scroll">
        <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="visits-chart-svg">
          {hours.map((cnt, hr) => {
            const barH = Math.max(4, Math.round((cnt / maxVal) * chartH));
            const barW = Math.round(colW * 0.72);
            const x = Math.round(hr * colW + (colW - barW) / 2);
            const y = padTop + chartH - barH;
            const isPeak = hr === peakHour && peakVal > 0;

            return (
              <g key={hr}>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx="3"
                  fill="var(--primary-color)"
                  opacity={isPeak ? 1 : Math.max(0.3, cnt / maxVal)}
                >
                  <title>{`${hr}:00 — ${cnt} ${t('admin.visits.charts.visits_unit', 'visits')}`}</title>
                </rect>
                {hr % 4 === 0 && (
                  <text
                    x={hr * colW + colW / 2}
                    y={svgHeight - 8}
                    fill="var(--secondary-color)"
                    fontSize="14"
                    textAnchor="middle"
                  >
                    {`${hr}h`}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="visits-kpi-subtext visits-peak-summary">
        <span>{t('admin.visits.charts.peak_hour', 'Peak Hour')}:</span>
        <strong className="visits-text-primary-strong">
          {peakVal > 0 ? `${peakHour}:00 — ${peakHour + 1}:00 (${peakVal})` : '—'}
        </strong>
      </div>
    </div>
  );
}
