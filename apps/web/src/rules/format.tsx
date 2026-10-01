import { Ltr } from '@khalta/ui';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import type { Rule } from './api';

const UNIT_LABEL: Record<string, string> = {
  'kg/m3': 'kg/m³',
  degC: '°C',
  ratio: '',
  fraction: '',
  none: '',
  'L/m3': 'L/m³',
  kg_cm2: 'kg/cm²',
};
export const unitLabel = (u: string) => (u in UNIT_LABEL ? UNIT_LABEL[u]! : u);

/** Plain-text summary of a rule value (used by the table and the import preview). */
export function summarizeValue(
  kind: string,
  value: unknown,
  definition: Rule['definition'],
): string | null {
  if (kind === 'table')
    return definition
      ? `${definition.rows ? definition.rows.values.length : 1}×${definition.cols.values.length}`
      : null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value))
    return value.every((v) => typeof v === 'string')
      ? (value as string[]).join(' · ')
      : JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function RuleValue({
  rule,
}: {
  rule: Pick<Rule, 'kind' | 'value' | 'definition' | 'units' | 'inherits' | 'status'>;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const { kind, value, definition, units, inherits } = rule;

  if (inherits) return <Ltr mono className="text-xs">{`→ ${inherits}`}</Ltr>;
  if (kind === 'table') {
    if (!definition) return <span className="text-muted">{t('rules.notOnFile')}</span>;
    return (
      <span>
        {t('rules.field.table')}{' '}
        <Ltr>{`${definition.rows ? definition.rows.values.length : 1}×${definition.cols.values.length}`}</Ltr>
      </span>
    );
  }
  if (value === null || value === undefined)
    return (
      <span className="text-muted">
        {rule.status === 'info' ? t('rules.structural') : t('rules.notOnFile')}
      </span>
    );
  if (typeof value === 'boolean')
    return (
      <span>
        {kind === 'prohibition' ? t(value ? 'rules.prohibited' : 'rules.permitted') : String(value)}
      </span>
    );
  if (typeof value === 'number') {
    return (
      <Ltr>
        {f.number(value, { maximumFractionDigits: 4 })}
        {unitLabel(units) ? ` ${unitLabel(units)}` : ''}
      </Ltr>
    );
  }
  if (typeof value === 'string') return <Ltr>{units === 'fraction' ? value : value}</Ltr>;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return (
      <span className="flex flex-wrap gap-1">
        {(value as string[]).map((v) => (
          <Ltr key={v} mono className="rounded-sm border border-line px-1 text-xs">
            {v}
          </Ltr>
        ))}
      </span>
    );
  }
  return (
    <Ltr mono className="text-xs text-muted">
      {summarizeValue(kind, value, definition)}
    </Ltr>
  );
}
