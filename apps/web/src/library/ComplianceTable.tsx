import type { CheckResult, EvaluationReport, Reason } from '@khalta/engine';
import {
  CodeBadge,
  EvidenceChip,
  Label,
  Ltr,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type CodeSource,
} from '@khalta/ui';
import { CircleCheck, CircleHelp, CircleX, Info } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const chip =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium';

/** Tri-state result: icon + text + colour, never colour alone. A check that was not evaluated is not a pass. */
export function CheckStatus({ status }: { status: CheckResult['status'] }) {
  const { t } = useTranslation();
  const cfg = {
    pass: { Icon: CircleCheck, cls: 'border-pass bg-pass-bg text-pass-text' },
    fail: { Icon: CircleX, cls: 'border-fail bg-fail-bg text-fail-text' },
    not_evaluated: { Icon: CircleHelp, cls: 'border-warn bg-warn-bg text-warn-text' },
  }[status];
  return (
    <span data-status={status} className={`${chip} ${cfg.cls}`}>
      <cfg.Icon className="size-3.5" aria-hidden />
      {t(`evaluation.status.${status}`)}
    </span>
  );
}

const ALL = 'all';
const ORDER = { fail: 0, not_evaluated: 1, pass: 2 } as const;

/** One explanation in the reader's language; the English text from the report is the fallback. */
export function useReason() {
  const { t } = useTranslation();
  return (reason: Reason | undefined, fallback: string) =>
    reason ? t(`reason.${reason.key}`, { ...reason.params, defaultValue: fallback }) : fallback;
}

type N = (v: number | string | null | undefined, digits?: number) => string;

export function ComplianceTable({
  r,
  n,
  names,
}: {
  r: EvaluationReport;
  n: N;
  names: (id: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState(ALL);
  const [source, setSource] = useState(ALL);
  const [klass, setKlass] = useState(ALL);
  const classes = useMemo(
    () =>
      [
        ...new Set(r.checks.flatMap((c) => (c.governing ? [c.governing.requirementClass] : []))),
      ].sort(),
    [r.checks],
  );
  const rows = useMemo(
    () =>
      r.checks
        .filter((c) => result === ALL || c.status === result)
        .filter((c) =>
          source === ALL
            ? true
            : source === 'ENGINEERING'
              ? !c.governing
              : c.governing?.source === source,
        )
        .filter((c) => klass === ALL || c.governing?.requirementClass === klass)
        .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.id.localeCompare(b.id)),
    [r.checks, result, source, klass],
  );
  const filter = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    items: [string, string][],
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={set}>
        <SelectTrigger id={id} className="w-44" data-testid={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('evaluation.filter.all')}</SelectItem>
          {items.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  return (
    <section aria-label={t('evaluation.checks')}>
      <h3 className="mb-2 text-sm font-semibold text-heading">{t('evaluation.checks')}</h3>
      <div className="mb-3 flex flex-wrap gap-3" role="search" aria-label={t('rules.filters')}>
        {filter('f-result', t('evaluation.col.status'), result, setResult, [
          ['fail', t('evaluation.status.fail')],
          ['not_evaluated', t('evaluation.status.not_evaluated')],
          ['pass', t('evaluation.status.pass')],
        ])}
        {filter('f-source', t('evaluation.col.source'), source, setSource, [
          ['ACI', 'ACI'],
          ['JS', 'JS'],
          ['PROJECT', t('ui.code.PROJECT')],
          ['ENGINEERING', t('evaluation.engineering')],
        ])}
        {filter(
          'f-class',
          t('evaluation.col.class'),
          klass,
          setKlass,
          classes.map((c) => [c, t(`evaluation.class.${c}`, { defaultValue: c })]),
        )}
      </div>
      <p className="mb-2 text-xs text-muted" data-testid="checks-count">
        {t('evaluation.shown', { shown: rows.length, total: r.checks.length })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="checks-table">
          <caption className="sr-only">{t('evaluation.checks')}</caption>
          <thead>
            <tr className="text-muted">
              {['check', 'status', 'value', 'limit', 'source'].map((c) => (
                <th key={c} scope="col" className="py-1 text-start font-medium">
                  {t(`evaluation.col.${c}`)}
                </th>
              ))}
              <th scope="col" className="py-1 text-start font-medium">
                <span className="sr-only">{t('evaluation.trace.title')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <Row key={c.id} c={c} r={r} n={n} names={names} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const checkKey = (id: string) => id.replace(/\./g, '_');

function Row({
  c,
  r,
  n,
  names,
}: {
  c: CheckResult;
  r: EvaluationReport;
  n: N;
  names: (id: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const why = useReason();
  const dosage = c.id.startsWith('admixture_dosage.');
  const label = dosage ? (
    <>
      {t('evaluation.check.admixture_dosage')} · {names(c.id.slice(17))}
    </>
  ) : (
    t(`evaluation.check.${checkKey(c.id)}`, { defaultValue: c.id })
  );
  const fmt = (v: CheckResult['value'] | CheckResult['limit']) => {
    if (v === null) return '–';
    if (Array.isArray(v))
      return v.map((x) => t(`evaluation.klass.${x}`, { defaultValue: x })).join(' / ');
    if (typeof v === 'boolean') return t(v ? 'library.yes' : 'library.no');
    if (typeof v === 'string') return t(`evaluation.klass.${v}`, { defaultValue: v });
    const unit =
      c.units === '%' ? 'pct' : c.units === 'MPa' ? 'mpa' : c.units === 'm3' ? 'm3' : null;
    return unit ? t(`evaluation.unit.${unit}`, { n: n(v, 4) }) : n(v, 4);
  };
  const src = c.governing?.source;
  const code: CodeSource | null = src === 'ACI' || src === 'JS' || src === 'PROJECT' ? src : null;
  const trace = c.traceKey ? r.trace.find((x) => x.key === c.traceKey) : undefined;
  return (
    <tr
      className="border-t border-line align-top"
      data-testid="check-row"
      data-check-id={c.id}
      data-status={c.status}
    >
      <td className="py-1.5">
        {label}
        {c.blocker && (
          <span className="block text-xs text-warn-text" data-testid="check-blocker">
            {t(`evaluation.blocker.${c.blocker.code}`)}
            <span className="block text-muted">{why(c.blocker.reason, c.blocker.detail)}</span>
          </span>
        )}
        {c.warning === 'near_limit' && (
          <span className="block text-xs text-warn-text">{t('evaluation.nearLimit')}</span>
        )}
        {c.note && <span className="block text-xs text-muted">{why(c.noteReason, c.note)}</span>}
        {c.provisional && c.status !== 'not_evaluated' && (
          <span className="block text-xs text-muted">{t('evaluation.provisionalRow')}</span>
        )}
      </td>
      <td className="py-1.5">
        <CheckStatus status={c.status} />
      </td>
      <td className="whitespace-nowrap py-1.5 pe-4">
        <Ltr>{fmt(c.value)}</Ltr>
      </td>
      <td className="whitespace-nowrap py-1.5 pe-4">
        <Ltr>
          {c.op && c.op !== 'in' && c.op !== 'is' ? `${c.op === 'abs<=' ? '±' : c.op} ` : ''}
          {fmt(c.limit)}
        </Ltr>
      </td>
      <td className="py-1.5">
        {code ? (
          <CodeBadge source={code} />
        ) : (
          <span className="text-xs text-muted">{t('evaluation.engineering')}</span>
        )}
        {c.governing && (
          <span className="mt-0.5 block text-xs">
            <a
              className="text-muted underline underline-offset-2"
              href={`/rules?q=${encodeURIComponent(c.governing.ruleKey)}`}
              data-testid="clause-link"
            >
              <Ltr>{c.governing.clause}</Ltr>
            </a>
          </span>
        )}
      </td>
      <td className="py-1.5">
        <Popover>
          <PopoverTrigger
            className="rounded-md p-1 text-muted hover:text-heading"
            aria-label={`${t('evaluation.trace.title')}: ${c.id}`}
            data-testid="trace-open"
          >
            <Info className="size-4" aria-hidden />
          </PopoverTrigger>
          <PopoverContent className="w-80 text-xs" data-testid="trace-popover">
            <p className="mb-2 font-semibold text-heading">{t('evaluation.trace.title')}</p>
            <dl className="flex flex-col gap-1.5">
              {c.governing && (
                <div>
                  <dt className="text-muted">{t('evaluation.trace.rule')}</dt>
                  <dd>
                    <Ltr mono>{c.governing.ruleKey}</Ltr> ·{' '}
                    {t(`evaluation.class.${c.governing.requirementClass}`, {
                      defaultValue: c.governing.requirementClass,
                    })}{' '}
                    ·{' '}
                    {t(
                      c.governing.verified
                        ? 'evaluation.trace.verified'
                        : 'evaluation.trace.unverified',
                    )}
                  </dd>
                </div>
              )}
              {trace ? (
                <>
                  <div>
                    <dt className="text-muted">{t('evaluation.trace.formula')}</dt>
                    <dd dir="auto">{trace.formula}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('evaluation.trace.inputs')}</dt>
                    <dd>
                      <Ltr mono>
                        {Object.entries(trace.inputs)
                          .map(([k, v]) => `${k}=${v === null ? '–' : String(v)}`)
                          .join('  ')}
                      </Ltr>
                    </dd>
                  </div>
                </>
              ) : (
                <p className="text-muted">{t('evaluation.trace.none')}</p>
              )}
              <div className="flex flex-wrap gap-1 pt-1">
                {c.evidence.map((e) => (
                  <EvidenceChip key={e} status={e} />
                ))}
              </div>
            </dl>
          </PopoverContent>
        </Popover>
      </td>
    </tr>
  );
}
