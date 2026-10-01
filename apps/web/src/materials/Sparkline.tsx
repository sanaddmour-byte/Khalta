import { useTranslation } from 'react-i18next';

/** Tiny trend line across test versions. Always LTR (time runs left to right), with a text alternative. */
export function Sparkline({
  values,
  label,
  format,
}: {
  values: number[];
  label: string;
  format: (n: number) => string;
}) {
  const { t } = useTranslation();
  if (values.length < 2)
    return <span className="text-xs text-muted">{t('materials.trend.single')}</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 96;
  const h = 28;
  const pts = values.map(
    (v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 3 - ((v - min) / span) * (h - 6)}`,
  );
  const last = pts[pts.length - 1]!.split(',');
  return (
    <span dir="ltr" className="inline-flex items-center gap-2">
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={t('materials.trend.label', {
          name: label,
          from: format(values[0]!),
          to: format(values[values.length - 1]!),
        })}
        className="text-primary"
      >
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <circle cx={last[0]} cy={last[1]} r="2.5" fill="currentColor" />
      </svg>
    </span>
  );
}
