import type {
  CandidateGuardrails,
  EvaluationReport,
  EvidenceStatus as EStatus,
} from '@khalta/engine';
import {
  EvidenceChip,
  Ltr,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
  type EvidenceStatus,
} from '@khalta/ui';
import { CircleCheck, CircleX } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import { ComplianceTable } from '../library/ComplianceTable';

const Charts = {
  Combined: lazy(() => import('./CombinedChart').then((m) => ({ default: m.CombinedChart }))),
  Shilstone: lazy(() => import('./CombinedChart').then((m) => ({ default: m.ShilstoneChart }))),
};

export interface Inspectable {
  report: EvaluationReport;
  lines: { materialId: string; kgPerM3: string }[];
  guardrails: CandidateGuardrails | null;
  validator: {
    status: 'pass' | 'fail';
    version: string | null;
    checked: unknown;
    mismatches?: unknown[];
  };
  evidence: EStatus[];
  binding: { id: string; shadowPrice: number; klass: string }[];
}

export function InspectStage({
  item,
  nameOf,
  canCost,
}: {
  item: Inspectable;
  nameOf: (id: string) => string;
  canCost: boolean;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const r = item.report;
  const n = (v: number | string | null | undefined, digits = 3) =>
    v === null || v === undefined ? '–' : f.number(Number(v), { maximumFractionDigits: digits });
  const cost = new Map(r.cost.lines.map((l) => [l.materialId, l]));
  const totalCost = r.cost.totalJodPerM3 === null ? null : Number(r.cost.totalJodPerM3);
  const checked = item.validator.checked as {
    figures?: number;
    checks?: number;
    trace?: number;
  } | null;
  return (
    <div className="flex flex-col gap-4" data-testid="inspect-stage">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${item.validator.status === 'pass' ? 'border-pass bg-pass-bg text-pass-text' : 'border-fail bg-fail-bg text-fail-text'}`}
          data-testid="validator-status"
          data-status={item.validator.status}
        >
          {item.validator.status === 'pass' ? (
            <CircleCheck className="size-3.5" aria-hidden />
          ) : (
            <CircleX className="size-3.5" aria-hidden />
          )}
          {t(`studio.inspect.validator.${item.validator.status}`)}
        </span>
        {item.evidence.map((e) => (
          <EvidenceChip key={e} status={e as EvidenceStatus} />
        ))}
      </p>
      <Tabs defaultValue="proportions">
        <TabsList aria-label={t('studio.inspect.tabs')} className="flex-wrap">
          {['proportions', 'compliance', 'strength', 'gradation', 'cost', 'trace', 'validator'].map(
            (k) => (
              <TabsTrigger key={k} value={k} data-testid={`tab-${k}`}>
                {t(`studio.inspect.tab.${k}`)}
              </TabsTrigger>
            ),
          )}
        </TabsList>

        <TabsContent value="proportions" className="pt-4">
          <div className="overflow-x-auto">
            <Table data-testid="proportions-table">
              <caption className="sr-only">{t('studio.inspect.tab.proportions')}</caption>
              <thead>
                <tr>
                  <Th>{t('studio.inspect.col.material')}</Th>
                  <Th>{t('studio.inspect.col.kg')}</Th>
                  <Th>{t('studio.inspect.col.litres')}</Th>
                  <Th>{t('studio.inspect.col.volume')}</Th>
                  {canCost && <Th>{t('studio.inspect.col.jodKg')}</Th>}
                  {canCost && <Th>{t('studio.inspect.col.jodM3')}</Th>}
                  {canCost && <Th>{t('studio.inspect.col.share')}</Th>}
                </tr>
              </thead>
              <tbody>
                {item.lines.map((l) => {
                  const vol = r.figures[`volume.${l.materialId}`];
                  const c = cost.get(l.materialId);
                  const jod = c?.jod ? Number(c.jod) : null;
                  return (
                    <tr
                      key={l.materialId}
                      className="border-t border-line"
                      data-testid="proportion-row"
                    >
                      <Td>{nameOf(l.materialId)}</Td>
                      <Td>
                        <Ltr>{n(l.kgPerM3, 3)}</Ltr>
                      </Td>
                      <Td>
                        <Ltr>{typeof vol === 'number' ? n(vol * 1000, 1) : '–'}</Ltr>
                      </Td>
                      <Td>
                        <Ltr>{typeof vol === 'number' ? n(vol, 4) : '–'}</Ltr>
                      </Td>
                      {canCost && (
                        <Td>
                          <Ltr>{n(c?.jodPerKg, 4)}</Ltr>
                        </Td>
                      )}
                      {canCost && (
                        <Td>
                          <Ltr>{n(c?.jod, 3)}</Ltr>
                        </Td>
                      )}
                      {canCost && (
                        <Td>
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 rounded-full bg-line" aria-hidden>
                              <div
                                className="h-1.5 rounded-full bg-primary"
                                style={{
                                  width: `${jod && totalCost ? Math.min(100, (jod / totalCost) * 100) : 0}%`,
                                }}
                              />
                            </div>
                            <Ltr>{jod && totalCost ? n((jod / totalCost) * 100, 1) : '–'}%</Ltr>
                          </div>
                        </Td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-medium" data-testid="proportion-totals">
                  <Td>{t('studio.inspect.totals')}</Td>
                  <Td>
                    <Ltr>{n(r.figures['mass.fresh_density'] as number, 1)}</Ltr>
                  </Td>
                  <Td />
                  <Td>
                    <Ltr>
                      {f.number(Number(r.figures['volume.total']), {
                        minimumFractionDigits: 3,
                        maximumFractionDigits: 3,
                      })}
                    </Ltr>{' '}
                    {Math.abs(Number(r.figures['yield.delta'] ?? 1)) <= 0.0051 && (
                      <span aria-label={t('studio.inspect.volumeOk')}>✓</span>
                    )}
                  </Td>
                  {canCost && <Td />}
                  {canCost && (
                    <Td>
                      <Ltr>{n(totalCost, 3)}</Ltr>
                    </Td>
                  )}
                  {canCost && <Td />}
                </tr>
              </tfoot>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="compliance" className="pt-4">
          <ComplianceTable r={r} n={n} names={(id) => nameOf(id)} />
        </TabsContent>

        <TabsContent
          value="strength"
          className="flex flex-col gap-3 pt-4"
          data-testid="strength-evidence"
        >
          <p className="max-w-3xl rounded-md border border-line p-3 text-sm">
            {t('studio.inspect.strength.notModel')}
          </p>
          <dl className="grid max-w-md grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{t('studio.inspect.strength.fcr')}</dt>
            <dd>
              <Ltr>{`${n(r.strength.fcrMpa, 1)} MPa`}</Ltr>
            </dd>
            <dt className="text-muted">{t('studio.inspect.strength.baselineWc')}</dt>
            <dd>
              <Ltr>{n(r.strengthAdequacy.baselineWc, 3)}</Ltr>
            </dd>
            <dt className="text-muted">{t('studio.inspect.strength.designWcm')}</dt>
            <dd>
              <Ltr>{n(r.strengthAdequacy.designWcm, 3)}</Ltr>
            </dd>
            <dt className="text-muted">{t('studio.inspect.strength.compare')}</dt>
            <dd>
              {r.strengthAdequacy.comparison
                ? t(`studio.inspect.strength.${r.strengthAdequacy.comparison}`)
                : '–'}
            </dd>
          </dl>
        </TabsContent>

        <TabsContent value="gradation" className="flex flex-col gap-4 pt-4">
          {item.guardrails ? (
            <Suspense fallback={<div className="h-64" />}>
              <div className="grid gap-4 lg:grid-cols-2">
                <Charts.Combined g={item.guardrails} />
                <Charts.Shilstone g={item.guardrails} />
              </div>
              <Table data-testid="grading-table">
                <caption className="sr-only">{t('studio.inspect.tab.gradation')}</caption>
                <thead>
                  <tr>
                    <Th>{t('materials.chart.sieve')}</Th>
                    <Th>{t('studio.inspect.chart.combined')}</Th>
                    <Th>{t('studio.inspect.chart.target')}</Th>
                    <Th>{t('studio.inspect.chart.dev')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...item.guardrails.gradingSieves].reverse().map((s) => (
                    <tr key={s.sieve_mm} className="border-t border-line">
                      <Td>
                        <Ltr>{`${s.sieve_mm} mm`}</Ltr>
                      </Td>
                      <Td>
                        <Ltr>{n(s.passing_pct, 1)}</Ltr>
                      </Td>
                      <Td>
                        <Ltr>{n(s.target_pct, 1)}</Ltr>
                      </Td>
                      <Td>
                        <Ltr>{n(s.passing_pct - s.target_pct, 1)}</Ltr>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Suspense>
          ) : (
            <p className="text-sm text-muted">{t('studio.inspect.noGuardrails')}</p>
          )}
        </TabsContent>

        <TabsContent value="cost" className="flex flex-col gap-3 pt-4">
          {!canCost ? (
            <p className="text-sm text-muted">{t('studio.inspect.noCost')}</p>
          ) : (
            <>
              <p className="text-lg font-semibold tabular-nums" data-testid="cost-total">
                <Ltr>{n(totalCost, 3)}</Ltr> {t('studio.cand.perM3')}
              </p>
              {r.cost.state === 'incomplete' && (
                <p className="text-sm text-warn-text">{t('studio.inspect.costIncomplete')}</p>
              )}
              {item.binding.length > 0 && (
                <section aria-labelledby="whatif-title" data-testid="whatifs">
                  <h4 id="whatif-title" className="font-medium">
                    {t('studio.inspect.whatif.title')}
                  </h4>
                  <p className="text-xs text-muted">{t('studio.inspect.whatif.hint')}</p>
                  <ul className="mt-2 text-sm">
                    {item.binding.slice(0, 6).map((b) => (
                      <li key={b.id}>
                        <Ltr mono>{b.id}</Ltr>: <Ltr>{n(b.shadowPrice, 3)}</Ltr>{' '}
                        {t('studio.inspect.whatif.unit')}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="trace" className="pt-4">
          <div className="overflow-x-auto">
            <Table data-testid="trace-table">
              <caption className="sr-only">{t('studio.inspect.tab.trace')}</caption>
              <thead>
                <tr>
                  <Th>{t('studio.inspect.trace.figure')}</Th>
                  <Th>{t('studio.inspect.trace.value')}</Th>
                  <Th>{t('studio.inspect.trace.formula')}</Th>
                </tr>
              </thead>
              <tbody>
                {r.trace
                  .filter((e) => canCost || !e.key.startsWith('cost.'))
                  .map((e) => (
                    <tr key={e.key} className="border-t border-line align-top">
                      <Td>
                        <Ltr mono>{e.key}</Ltr>
                      </Td>
                      <Td>
                        <Ltr>
                          {typeof e.value === 'number' ? n(e.value, 4) : String(e.value ?? '–')}{' '}
                          {e.unit}
                        </Ltr>
                      </Td>
                      <Td className="text-xs text-muted">{e.formula}</Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent
          value="validator"
          className="flex flex-col gap-2 pt-4"
          data-testid="validator-report"
        >
          <p className="text-sm">{t('studio.inspect.validator.explain')}</p>
          <dl className="grid max-w-md grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{t('studio.inspect.validator.version')}</dt>
            <dd>
              <Ltr>{item.validator.version ?? '–'}</Ltr>
            </dd>
            <dt className="text-muted">{t('studio.inspect.validator.figures')}</dt>
            <dd>
              <Ltr>{checked?.figures ?? '–'}</Ltr>
            </dd>
            <dt className="text-muted">{t('studio.inspect.validator.checks')}</dt>
            <dd>
              <Ltr>{checked?.checks ?? '–'}</Ltr>
            </dd>
            <dt className="text-muted">{t('studio.inspect.validator.mismatches')}</dt>
            <dd>
              <Ltr>{item.validator.mismatches?.length ?? 0}</Ltr>
            </dd>
          </dl>
        </TabsContent>
      </Tabs>
    </div>
  );
}
