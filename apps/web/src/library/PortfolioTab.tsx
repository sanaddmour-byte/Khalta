import {
  Button,
  EmptyState,
  EvidenceChip,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  Td,
  Th,
  toast,
  Label,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Play, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { DesignStatusChip, VerdictChip } from './chips';
import {
  dataQualityQuery,
  evaluateBatch,
  exportPortfolio,
  portfolioQuery,
  type PortfolioFilter,
} from './portfolioApi';

const FILTERS: PortfolioFilter[] = [
  'all',
  'failing',
  'incomplete',
  'not_evaluated',
  'revalidation',
  'inputs_changed',
];

export function PortfolioTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const { lang } = usePrefs();
  const { data: me } = useMe();
  const { plants, selected } = usePlant();
  const caps = me?.capabilities ?? [];
  const qc = useQueryClient();
  const [filter, setFilter] = useState<PortfolioFilter>('all');
  const plantId = selected && selected !== 'all' ? selected : undefined;
  const q = useQuery(portfolioQuery(filter, plantId));
  const batch = useMutation({
    mutationFn: () => evaluateBatch({ mode: 'BOTH', ...(plantId ? { plantId } : {}) }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('portfolio.batchDone', { count: r.evaluated }));
    },
  });
  const plantName = (id: string) => {
    const p = plants.find((x) => x.id === id);
    return p ? (lang === 'ar' ? p.nameAr : p.nameEn) : '–';
  };
  const c = q.data?.counts;
  return (
    <div className="flex flex-col gap-4" data-testid="portfolio">
      <p className="max-w-3xl text-sm text-muted">{t('portfolio.hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pf-filter">{t('portfolio.filter')}</Label>
          <Select value={filter} onValueChange={(v) => setFilter(v as PortfolioFilter)}>
            <SelectTrigger id="pf-filter" className="w-60" data-testid="portfolio-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`portfolio.filters.${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {caps.includes('design.write') && (
          <Button
            onClick={() => batch.mutate()}
            disabled={batch.isPending}
            data-testid="evaluate-all"
          >
            <Play className="size-4" aria-hidden />
            {batch.isPending ? t('evaluation.running') : t('portfolio.evaluateAll')}
          </Button>
        )}
        {caps.includes('export.priceCost') && (
          <Button
            variant="secondary"
            onClick={() =>
              exportPortfolio(filter, plantId).catch(() => toast.error(t('errors.loadFailed')))
            }
            data-testid="export-portfolio"
          >
            <Download className="size-4" aria-hidden />
            {t('portfolio.export')}
          </Button>
        )}
      </div>
      {c && (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm" data-testid="portfolio-counts">
          {(
            [
              'total',
              'failing',
              'incomplete',
              'notEvaluated',
              'revalidation',
              'inputsChanged',
            ] as const
          ).map((k) => (
            <li key={k} data-count={k}>
              <span className="text-muted">{t(`portfolio.counts.${k}`)}</span>{' '}
              <strong>
                <Ltr>{f.number(c[k])}</Ltr>
              </strong>
            </li>
          ))}
        </ul>
      )}
      {q.isLoading && <Skeleton className="h-32 w-full" />}
      {q.data && q.data.rows.length === 0 && (
        <EmptyState
          title={t('portfolio.empty.title')}
          description={t('portfolio.empty.description')}
        />
      )}
      {q.data && q.data.rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table data-testid="portfolio-table">
            <caption className="sr-only">{t('portfolio.title')}</caption>
            <thead>
              <tr>
                <Th>{t('library.col.code')}</Th>
                <Th className="hidden lg:table-cell">{t('library.col.plant')}</Th>
                <Th>{t('library.col.status')}</Th>
                <Th>{t('portfolio.col.result')}</Th>
                <Th className="hidden md:table-cell">{t('portfolio.col.checks')}</Th>
                {caps.includes('cost.view') && (
                  <Th className="hidden md:table-cell">{t('portfolio.col.cost')}</Th>
                )}
                <Th className="hidden xl:table-cell">{t('portfolio.col.evidence')}</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-line align-top hover:bg-primary-tint"
                  data-testid="portfolio-row"
                  data-code={r.code}
                  data-verdict={r.verdict ?? 'none'}
                >
                  <Td>
                    <button
                      type="button"
                      className="text-start font-medium text-heading underline-offset-2 hover:underline"
                      onClick={() => onOpen(r.id)}
                    >
                      <Ltr mono>
                        {r.code} {t('versions.short', { n: r.version })}
                      </Ltr>
                    </button>
                  </Td>
                  <Td className="hidden lg:table-cell">{plantName(r.plantId)}</Td>
                  <Td>
                    <DesignStatusChip status={r.status} />
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {r.evaluated ? (
                        <>
                          <VerdictChip verdict={r.verdict} />
                          {r.validatorStatus === 'fail' && (
                            <span className="inline-flex items-center gap-1 text-xs text-fail-text">
                              <ShieldAlert className="size-3.5" aria-hidden />
                              {t('evaluation.validator.fail')}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-muted">{t('portfolio.notEvaluated')}</span>
                      )}
                      {r.inputsChanged && (
                        <span className="text-xs text-warn-text" data-testid="row-inputs-changed">
                          {t('evaluation.inputsChanged')}
                        </span>
                      )}
                      {r.needsRevalidation && (
                        <span className="text-xs text-fail-text">
                          {t('evaluation.revalidation')}
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td className="hidden md:table-cell">
                    {r.evaluated
                      ? t('portfolio.checkSummary', { failing: r.failing, open: r.unevaluated })
                      : '–'}
                  </Td>
                  {caps.includes('cost.view') && (
                    <Td className="hidden whitespace-nowrap md:table-cell">
                      {r.costJodPerM3 ? (
                        <Ltr>
                          {t('evaluation.unit.jodm3', {
                            n: f.number(Number(r.costJodPerM3), { maximumFractionDigits: 3 }),
                          })}
                        </Ltr>
                      ) : (
                        '–'
                      )}
                    </Td>
                  )}
                  <Td className="hidden xl:table-cell">
                    <span className="flex flex-wrap gap-1">
                      {r.evidence
                        .filter((e) =>
                          ['RULE_UNVERIFIED', 'INPUT_STALE', 'INPUT_MISSING'].includes(e),
                        )
                        .map((e) => (
                          <EvidenceChip key={e} status={e as never} />
                        ))}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function DataQualityTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { selected } = usePlant();
  const q = useQuery(dataQualityQuery(selected && selected !== 'all' ? selected : undefined));
  return (
    <div className="flex flex-col gap-4" data-testid="data-quality-tab">
      <p className="max-w-3xl text-sm text-muted">{t('dataQuality.hint')}</p>
      {q.isLoading && <Skeleton className="h-32 w-full" />}
      {q.data && q.data.notEvaluated > 0 && (
        <p className="text-sm text-warn-text">
          {t('dataQuality.notEvaluated', { count: q.data.notEvaluated })}
        </p>
      )}
      {q.data && q.data.groups.length === 0 && (
        <EmptyState
          title={t('dataQuality.empty.title')}
          description={t('dataQuality.empty.description')}
        />
      )}
      <ul className="flex flex-col gap-3">
        {q.data?.groups.map((g) => (
          <li
            key={`${g.code}|${g.materialId ?? ''}`}
            className="rounded-md border border-line p-3"
            data-testid="dq-group"
            data-code={g.code}
            data-severity={g.severity}
          >
            <p className="text-sm font-medium">
              <span className={g.severity === 'blocker' ? 'text-fail-text' : 'text-warn-text'}>
                {t(`evaluation.severity.${g.severity}`)}
              </span>{' '}
              · {t(`evaluation.dq.${g.code}`, { defaultValue: g.code })}
              {g.materialId && (
                <> · {lang === 'ar' ? (g.materialNameAr ?? g.materialNameEn) : g.materialNameEn}</>
              )}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t('dataQuality.affects', { count: g.designs.length })}
            </p>
            <p className="mt-1 flex flex-wrap gap-2">
              {g.designs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-primary-tint"
                  onClick={() => onOpen(d.id)}
                >
                  <Ltr mono>{d.code}</Ltr>
                </button>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
