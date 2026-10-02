import type { EvaluationReport } from '@khalta/engine';
import {
  Button,
  CodeBadge,
  EvidenceChip,
  Input,
  Label,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
  type CodeSource,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleHelp, CircleX, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { ComplianceTable, useReason } from './ComplianceTable';
import {
  evaluateDesign,
  evaluationQuery,
  evaluationsQuery,
  type DesignCard,
  type EvaluationDetail,
} from './api';

const chip =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium';

const NamesContext = createContext<Map<string, { en: string; ar: string | null }>>(new Map());
export const MaterialNames = NamesContext.Provider;
const useMaterialNames = () => useContext(NamesContext);

export function EvaluationTab({ design }: { design: DesignCard }) {
  const { t } = useTranslation();
  const f = useFormat();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const qc = useQueryClient();
  const list = useQuery(evaluationsQuery(design.id));
  const [picked, setPicked] = useState<string | null>(null);
  const evalId = picked ?? list.data?.[0]?.id ?? null;
  const detail = useQuery({ ...evaluationQuery(design.id, evalId ?? ''), enabled: !!evalId });

  const [mode, setMode] = useState<'ACI' | 'JS' | 'BOTH'>('BOTH');
  const [s3, setS3] = useState('none');
  const [air, setAir] = useState('');
  const exposure = design.requirements.exposure ?? [];
  const canRun =
    caps.includes('design.write') && !['superseded', 'retired'].includes(design.status);
  const run = useMutation({
    mutationFn: () => {
      const airPct = air.trim() === '' ? undefined : Number(air);
      return evaluateDesign(design.id, {
        mode,
        ...(s3 !== 'none' && { s3Option: Number(s3) as 1 | 2 }),
        ...(airPct !== undefined && !Number.isNaN(airPct) && { airPct }),
      });
    },
    onSuccess: async (res) => {
      setPicked(null);
      await qc.invalidateQueries({ queryKey: ['designs'] });
      if (res.transition.blocker) toast.error(t(`evaluation.transition.${res.transition.blocker}`));
      else toast.success(t('evaluation.done'));
    },
  });
  const err = run.error instanceof ApiError ? run.error.message : null;

  return (
    <div className="flex flex-col gap-5" data-testid="evaluation-tab">
      {canRun && (
        <section
          className="flex flex-wrap items-end gap-3 rounded-md border border-line p-3"
          aria-label={t('evaluation.run')}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="ev-mode">{t('evaluation.options.mode')}</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <SelectTrigger id="ev-mode" className="w-48" data-testid="evaluate-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BOTH">{t('evaluation.options.both')}</SelectItem>
                <SelectItem value="ACI">{t('evaluation.options.aci')}</SelectItem>
                <SelectItem value="JS">{t('evaluation.options.js')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {exposure.includes('S3') && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="ev-s3">{t('evaluation.options.s3')}</Label>
              <Select value={s3} onValueChange={setS3}>
                <SelectTrigger id="ev-s3" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('evaluation.options.s3None')}</SelectItem>
                  <SelectItem value="1">{t('evaluation.options.s3Opt1')}</SelectItem>
                  <SelectItem value="2">{t('evaluation.options.s3Opt2')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="ev-air">{t('evaluation.options.air')}</Label>
            <Input
              id="ev-air"
              dir="ltr"
              inputMode="decimal"
              className="w-28"
              value={air}
              onChange={(e) => setAir(e.target.value)}
              aria-describedby="ev-air-hint"
            />
          </div>
          <Button onClick={() => run.mutate()} disabled={run.isPending} data-testid="evaluate-run">
            <Play className="size-4" aria-hidden />
            {run.isPending
              ? t('evaluation.running')
              : list.data?.length
                ? t('evaluation.runAgain')
                : t('evaluation.run')}
          </Button>
          <p id="ev-air-hint" className="basis-full text-xs text-muted">
            {t('evaluation.options.airHint')}
          </p>
          {err && (
            <p role="alert" className="basis-full text-sm text-fail-text">
              {err}
            </p>
          )}
        </section>
      )}

      {list.isLoading && <Skeleton className="h-24 w-full" />}
      {list.data && list.data.length === 0 && (
        <p className="text-sm text-muted" data-testid="evaluation-none">
          {t('evaluation.none')}
        </p>
      )}
      {list.data && list.data.length > 1 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="ev-history">{t('evaluation.history')}</Label>
          <Select value={evalId ?? ''} onValueChange={setPicked}>
            <SelectTrigger id="ev-history" className="w-80 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {list.data.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {f.dateTime(e.createdAt)} · {e.mode} · {t(`evaluation.verdict.${e.verdict}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {evalId && detail.isLoading && <Skeleton className="h-48 w-full" />}
      {detail.data && (
        <EvaluationReportView
          d={detail.data}
          design={design}
          canSeeCost={caps.includes('cost.view')}
        />
      )}
    </div>
  );
}

function EvaluationReportView({
  d,
  design,
  canSeeCost,
}: {
  d: EvaluationDetail;
  design: DesignCard;
  canSeeCost: boolean;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const r = d.report;
  const why = useReason();
  const n = (v: number | string | null | undefined, digits = 3) =>
    v === null || v === undefined ? '–' : f.number(Number(v), { maximumFractionDigits: digits });
  const verified = d.validatorStatus === 'pass';
  const changed = d.inputsChanged.materials.length + d.inputsChanged.rules;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-2" aria-label={t('evaluation.summary')}>
        <span
          data-testid="evaluation-verdict"
          data-verdict={r.verdict}
          className={`${chip} ${
            r.verdict === 'pass'
              ? 'border-pass bg-pass-bg text-pass-text'
              : r.verdict === 'fail'
                ? 'border-fail bg-fail-bg text-fail-text'
                : 'border-warn bg-warn-bg text-warn-text'
          }`}
        >
          {r.verdict === 'pass' ? (
            <CircleCheck className="size-3.5" aria-hidden />
          ) : r.verdict === 'fail' ? (
            <CircleX className="size-3.5" aria-hidden />
          ) : (
            <CircleHelp className="size-3.5" aria-hidden />
          )}
          {t(`evaluation.verdict.${r.verdict}`)}
        </span>
        <span
          data-testid="validator-status"
          data-validator={d.validatorStatus}
          className={`${chip} ${verified ? 'border-pass bg-pass-bg text-pass-text' : 'border-fail bg-fail-bg text-fail-text'}`}
        >
          {verified ? (
            <ShieldCheck className="size-3.5" aria-hidden />
          ) : (
            <ShieldAlert className="size-3.5" aria-hidden />
          )}
          {t(`evaluation.validator.${d.validatorStatus}`)}
        </span>
        {r.evidence.map((e) => (
          <EvidenceChip key={e} status={e} />
        ))}
        {design.needsRevalidation && (
          <span
            data-testid="revalidation-badge"
            className={`${chip} border-fail bg-fail-bg text-fail-text`}
          >
            <ShieldAlert className="size-3.5" aria-hidden />
            {t('evaluation.revalidation')}
          </span>
        )}
        {changed > 0 && (
          <span
            className={`${chip} border-warn bg-warn-bg text-warn-text`}
            data-testid="inputs-changed"
          >
            {t('evaluation.inputsChanged')}
          </span>
        )}
      </header>
      <p className="text-xs text-muted">
        <Ltr>{r.mode}</Ltr> · {f.dateTime(d.createdAt)} · {t('evaluation.priceDate')}{' '}
        <Ltr>{r.evaluationDate}</Ltr>
        {r.provisional ? ` · ${t('evaluation.provisional')}` : ''}
      </p>
      {!verified && (
        <section role="alert" className="rounded-md border border-fail p-3 text-sm text-fail-text">
          <p className="font-medium">{t('evaluation.validatorFailedHint')}</p>
          <ul className="mt-1 list-disc ps-5 text-xs" data-testid="validator-mismatches">
            {d.validator.mismatches.slice(0, 8).map((m, i) => (
              <li key={i}>
                <Ltr mono>
                  {m.kind}: {m.key}
                </Ltr>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!r.minimumData.ok && (
        <p role="alert" className="text-sm text-warn-text" data-testid="minimum-data-missing">
          {t('evaluation.minimumMissing')}
        </p>
      )}

      <Figures r={r} n={n} />

      <ComplianceTable r={r} n={n} names={(id) => <MaterialName id={id} lang={lang} />} />

      <StrengthSection r={r} n={n} />

      {canSeeCost && <CostSection r={r} n={n} lang={lang} />}

      <section aria-label={t('evaluation.quality')}>
        <h3 className="mb-2 text-sm font-semibold text-heading">{t('evaluation.quality')}</h3>
        {r.dataQuality.length === 0 ? (
          <p className="text-sm text-muted">{t('evaluation.qualityNone')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="data-quality">
            {r.dataQuality.map((q, i) => (
              <li key={i} data-severity={q.severity} data-code={q.code}>
                <span
                  className={
                    q.severity === 'blocker'
                      ? 'font-medium text-fail-text'
                      : q.severity === 'warning'
                        ? 'text-warn-text'
                        : 'text-muted'
                  }
                >
                  {t(`evaluation.severity.${q.severity}`)}
                </span>{' '}
                · {t(`evaluation.dq.${q.code}`, { defaultValue: q.code })}
                {q.materialId && (
                  <>
                    {' '}
                    · <MaterialName id={q.materialId} lang={lang} />
                  </>
                )}
                <span className="block text-xs text-muted" dir="auto">
                  {why(q.reason, q.detail)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {r.characteristics.rows.length > 0 && (
        <section aria-label={t('evaluation.characteristics')}>
          <h3 className="mb-1 text-sm font-semibold text-heading">
            {t('evaluation.characteristics')}
          </h3>
          <p className="mb-2 text-xs text-muted">{t('evaluation.characteristicsHint')}</p>
          <table className="w-full text-sm" data-testid="characteristics-table">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="py-1 text-start font-medium">
                  {t('evaluation.col.characteristic')}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('evaluation.col.requested')}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('evaluation.col.achieved')}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('evaluation.col.result')}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('evaluation.col.origin')}
                </th>
              </tr>
            </thead>
            <tbody>
              {r.characteristics.rows.map((c) => (
                <tr key={c.key} className="border-t border-line" data-status={c.status}>
                  <td className="py-1.5">
                    <Ltr mono>{c.key}</Ltr>
                  </td>
                  <td className="py-1.5">
                    <Ltr>{c.requested}</Ltr>
                  </td>
                  <td className="py-1.5">
                    <Ltr>{n(c.achieved as number | null)}</Ltr>
                  </td>
                  <td className="py-1.5">{t(`evaluation.charStatus.${c.status}`)}</td>
                  <td className="py-1.5">
                    <Ltr>{c.origin}</Ltr>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {r.assumptions.length > 0 && (
        <section aria-label={t('evaluation.assumptions')}>
          <h3 className="mb-2 text-sm font-semibold text-heading">{t('evaluation.assumptions')}</h3>
          <ul className="list-disc ps-5 text-sm text-muted" data-testid="assumptions">
            {r.assumptions.map((a, i) => (
              <li key={i} dir="auto">
                {why(r.assumptionReasons?.[i], a)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

type N = (v: number | string | null | undefined, digits?: number) => string;

function Figures({ r, n }: { r: EvaluationReport; n: N }) {
  const { t } = useTranslation();
  const fg = r.figures;
  const rows: [string, string, string][] = [
    ['volume', t('evaluation.unit.m3', { n: n(fg['volume.total'] as number, 4) }), 'volume.total'],
    ['yield', t('evaluation.unit.m3', { n: n(fg['yield.delta'] as number, 4) }), 'yield.delta'],
    ['wcm', n(fg['ratio.wcm'] as number), 'ratio.wcm'],
    ['binder', t('evaluation.unit.kgm3', { n: n(fg['mass.binder'] as number) }), 'mass.binder'],
    ['scm', t('evaluation.unit.pct', { n: n(fg['scm.pct.total'] as number) }), 'scm.pct.total'],
    ['water', t('evaluation.unit.kgm3', { n: n(fg['mass.water'] as number) }), 'mass.water'],
    [
      'density',
      t('evaluation.unit.kgm3', { n: n(fg['mass.fresh_density'] as number) }),
      'mass.fresh_density',
    ],
    ['fcr', t('evaluation.unit.mpa', { n: n(r.strength.fcrMpa) }), 'fcr.total'],
  ];
  return (
    <section aria-label={t('evaluation.figures')}>
      <h3 className="mb-2 text-sm font-semibold text-heading">{t('evaluation.figures')}</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" data-testid="figures">
        {rows.map(([k, v, key]) => (
          <div key={k} className="flex flex-col gap-0.5" data-figure={key}>
            <dt className="text-xs text-muted">{t(`evaluation.fig.${k}`)}</dt>
            <dd>
              <Ltr>{v}</Ltr>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function StrengthSection({ r, n }: { r: EvaluationReport; n: N }) {
  const { t } = useTranslation();
  const why = useReason();
  const s = r.strength;
  const a = r.strengthAdequacy;
  const w = r.waterBaseline;
  return (
    <section aria-label={t('evaluation.strength.title')} className="flex flex-col gap-4">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-heading">
          {t('evaluation.strength.title')}
        </h3>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" data-testid="strength-block">
          <div>
            <dt className="text-xs text-muted">{t('evaluation.strength.cylinder')}</dt>
            <dd>
              <Ltr>{t('evaluation.unit.mpa', { n: n(s.cylinderMpa) })}</Ltr>
            </dd>
          </div>
          {s.branches.map((b) => (
            <div key={b.ruleset}>
              <dt className="text-xs text-muted">
                {t('evaluation.strength.branch')} <CodeBadge source={b.ruleset as CodeSource} />
              </dt>
              <dd>
                {b.value === null ? (
                  <span className="text-warn-text">{t('evaluation.strength.notOnFile')}</span>
                ) : (
                  <Ltr>{t('evaluation.unit.mpa', { n: n(b.value) })}</Ltr>
                )}
              </dd>
            </div>
          ))}
          <div>
            <dt className="text-xs text-muted">{t('evaluation.strength.margin')}</dt>
            <dd>
              {s.marginConfigured ? (
                <Ltr>{t('evaluation.unit.mpa', { n: n(s.safetyMarginMpa) })}</Ltr>
              ) : (
                t('evaluation.strength.noMargin')
              )}
            </dd>
          </div>
        </dl>
        {s.blocker && (
          <p className="mt-1 text-xs text-warn-text" dir="auto">
            {why(s.blocker.reason, s.blocker.detail)}
          </p>
        )}
      </div>

      <div className="rounded-md border border-line p-3" data-testid="adequacy-block">
        <h4 className="text-sm font-semibold text-heading">{t('evaluation.adequacy.title')}</h4>
        <p className="mt-0.5 text-xs font-medium text-warn-text">
          {t('evaluation.adequacy.notCompliance')}
        </p>
        <p className="mt-1 text-xs text-muted">{t('evaluation.adequacy.noModel')}</p>
        {a.baselineWc !== null ? (
          <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted">{t('evaluation.adequacy.baseline')}</dt>
              <dd>
                <Ltr>{n(a.baselineWc)}</Ltr>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('evaluation.fig.wcm')}</dt>
              <dd>
                <Ltr>{n(a.designWcm)}</Ltr>
              </dd>
            </div>
          </dl>
        ) : (
          a.blocker && (
            <p className="mt-1 text-xs text-warn-text" dir="auto">
              {why(a.blocker.reason, a.blocker.detail)}
            </p>
          )
        )}
        {a.comparison && <p className="mt-2 text-sm">{t(`evaluation.adequacy.${a.comparison}`)}</p>}
        <div className="mt-2 flex flex-wrap gap-1">
          {a.evidence.map((e) => (
            <EvidenceChip key={e} status={e} />
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line p-3" data-testid="water-block">
        <h4 className="text-sm font-semibold text-heading">{t('evaluation.water.title')}</h4>
        <p className="mt-0.5 text-xs text-muted">{t('evaluation.water.notPlant')}</p>
        {w.baselineWaterKg !== null ? (
          <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">{t('evaluation.water.table')}</dt>
              <dd>
                <Ltr>{t('evaluation.unit.kgm3', { n: n(w.baseWaterKg) })}</Ltr>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('evaluation.water.reduction')}</dt>
              <dd>
                <Ltr>{t('evaluation.unit.pct', { n: n(w.admixtureReductionPct, 1) })}</Ltr>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('evaluation.water.baseline')}</dt>
              <dd>
                <Ltr>{t('evaluation.unit.kgm3', { n: n(w.baselineWaterKg, 1) })}</Ltr>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('evaluation.water.design')}</dt>
              <dd>
                <Ltr>{t('evaluation.unit.kgm3', { n: n(w.designWaterKg, 1) })}</Ltr>
              </dd>
            </div>
          </dl>
        ) : (
          w.blocker && (
            <p className="mt-1 text-xs text-warn-text" dir="auto">
              {why(w.blocker.reason, w.blocker.detail)}
            </p>
          )
        )}
      </div>
    </section>
  );
}

function CostSection({ r, n, lang }: { r: EvaluationReport; n: N; lang: string }) {
  const { t } = useTranslation();
  const c = r.cost;
  if (c.lines.length === 0) return null;
  return (
    <section aria-label={t('evaluation.cost.title')} data-testid="evaluation-cost">
      <h3 className="mb-1 text-sm font-semibold text-heading">{t('evaluation.cost.title')}</h3>
      <p className="mb-2 text-xs text-muted">
        {c.basis.kind === 'snapshot'
          ? t('evaluation.cost.basisSnapshot')
          : t('evaluation.cost.basisLive', { date: c.basis.date })}
      </p>
      <p className="mb-2 text-sm">
        {c.state === 'complete' ? (
          <>
            {t('evaluation.cost.total')}:{' '}
            <strong>
              <Ltr>{t('evaluation.unit.jodm3', { n: n(c.totalJodPerM3) })}</Ltr>
            </strong>
          </>
        ) : (
          <span data-testid="cost-incomplete" className="text-warn-text">
            {t('evaluation.cost.incomplete', { count: c.missing.length })} ·{' '}
            {t('evaluation.cost.subtotal')}:{' '}
            <Ltr>{t('evaluation.unit.jodm3', { n: n(c.subtotalJodPerM3) })}</Ltr>
          </span>
        )}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted">
            <th scope="col" className="py-1 text-start font-medium">
              {t('library.line.material')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('library.line.kg')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('evaluation.cost.line')}
            </th>
          </tr>
        </thead>
        <tbody>
          {c.lines.map((l) => (
            <tr key={l.materialId} className="border-t border-line" data-state={l.state}>
              <td className="py-1.5">
                <MaterialName id={l.materialId} lang={lang} />
              </td>
              <td className="py-1.5">
                <Ltr>{t('evaluation.unit.kgm3', { n: n(l.kgPerM3) })}</Ltr>
              </td>
              <td className="py-1.5">
                {l.jod !== null ? (
                  <Ltr>{t('evaluation.unit.jodm3', { n: n(l.jod) })}</Ltr>
                ) : (
                  <span className="text-warn-text">{t(`evaluation.cost.state.${l.state}`)}</span>
                )}
                {l.stale && (
                  <span className="block text-xs text-warn-text">{t('evaluation.cost.stale')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Material names come from the design detail query (already cached by the sheet). */
function MaterialName({ id, lang }: { id: string; lang: string }) {
  const names = useMaterialNames();
  const m = names.get(id);
  return <>{m ? (lang === 'ar' ? (m.ar ?? m.en) : m.en) : id.slice(0, 8)}</>;
}
