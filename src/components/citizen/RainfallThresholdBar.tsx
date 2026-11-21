import React from 'react';
import { IMD_RAINFALL_CLASSES, classifyRainfall24h } from '../../config/risk_model';
import { RAIN_CLASS_LABEL, type Lang } from '../../config/citizen_labels';
import { t } from '../../i18n';

/**
 * 24h rainfall against IMD reference classes. Scale tops out at 250 mm.
 * Only plots the value it is given; never converts rainfall to flood depth.
 */
const MAX = 250;
const BANDS = [
  { from: 0, to: 64.5, color: 'bg-sky-200', name: 'Moderate or less' },
  { from: 64.5, to: 115.6, color: 'bg-amber-300', name: 'Heavy' },
  { from: 115.6, to: 204.5, color: 'bg-orange-400', name: 'Very Heavy' },
  { from: 204.5, to: MAX, color: 'bg-red-500', name: 'Extremely Heavy' },
];

export const RainfallThresholdBar: React.FC<{
  mm: number | null;
  lang: Lang;
  unit: string;
  compact?: boolean;
}> = ({ mm, lang, unit, compact }) => {
  if (mm === null || Number.isNaN(mm)) {
    return <p className="text-base text-slate-600">—</p>;
  }
  const pct = Math.min(100, (mm / MAX) * 100);
  const cls = classifyRainfall24h(mm);
  const next = IMD_RAINFALL_CLASSES.find(c => c.min > mm && c.min >= 64.5);
  return (
    <div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-4xl font-extrabold text-slate-900 tabular-nums">{mm}</span>
        <span className="text-lg font-semibold text-slate-600">{unit}</span>
        <span className="ml-1 px-2.5 py-0.5 rounded-full bg-slate-900 text-white text-sm font-bold">
          {RAIN_CLASS_LABEL[cls]?.[lang] ?? cls}
        </span>
      </div>
      <div
        className="relative mt-4 h-5 rounded-full overflow-hidden flex border border-slate-300"
        role="img"
        aria-label={`${mm} millimetres in 24 hours, category ${cls}`}
      >
        {BANDS.map(b => (
          <div key={b.name} className={b.color} style={{ width: `${((b.to - b.from) / MAX) * 100}%` }} />
        ))}
        <div
          className="absolute top-0 bottom-0 w-1.5 bg-slate-900 rounded transition-all duration-700 motion-reduce:transition-none"
          style={{ left: `calc(${pct}% - 3px)` }}
        />
      </div>
      <div className="relative h-5 mt-1 text-[11px] font-semibold text-slate-600 tabular-nums">
        {[64.5, 115.6, 204.5].map(v => (
          <span key={v} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(v / MAX) * 100}%` }}>
            {v}
          </span>
        ))}
      </div>
      {!compact && (
        <p className="text-sm text-slate-600 mt-1">
          {next ? `${t(lang, 'nextLevel')}: +${(next.min - mm).toFixed(1)} ${unit} → ${RAIN_CLASS_LABEL[next.name]?.[lang] ?? next.name}` : ''}
        </p>
      )}
    </div>
  );
};
