import { Button, Input, Label, Ltr, toast } from '@khalta/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { WhyDisabled } from '../lib/WhyDisabled';
import { exportBatchPlan } from '../exports/api';
import type { DesignCard, DesignLine } from './api';
import { previewPlan, savePlan, type PlanPreview } from './labApi';

/**
 * Batch preparation: the reference design (SSD, per m³) beside the moisture-corrected, equipment-rounded weights for a
 * batch size. Every blocker is named; saving needs both independent checks; the export is a separate, audited step.
 */
export function BatchPlanPanel({ design, lines }: { design: DesignCard; lines: DesignLine[] }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const aggs = lines.filter((l) => l.category.endsWith('_agg'));
  const [vals, setVals] = useState<Record<string, string>>({});
  const [size, setSize] = useState('');
  const rows = aggs.flatMap((a) =>
    vals[a.materialId] && Number.isFinite(Number(vals[a.materialId]))
      ? [{ materialId: a.materialId, totalMoisturePct: Number(vals[a.materialId]) }]
      : [],
  );
  const batchSize = Number(size);
  const valid = Number.isFinite(batchSize) && batchSize > 0;
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const prev = useMutation({
    mutationFn: () => previewPlan(design.id, rows, batchSize),
    onSuccess: (p) => {
      setPreview(p);
      setSavedId(null);
    },
  });
  const save = useMutation({
    mutationFn: () => savePlan(design.id, rows, batchSize),
    onSuccess: async (r) => {
      setSavedId(r.id);
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('lab.saved'));
    },
  });
  const err = [save.error, prev.error].find((e) => e instanceof ApiError) as ApiError | undefined;
  const name = (id: string) => {
    const l = lines.find((x) => x.materialId === id);
    return l ? (lang === 'ar' ? (l.nameAr ?? l.nameEn) : l.nameEn) : id;
  };
  const n = (v: number) => f.number(v, { maximumFractionDigits: 3 });
  const plan = preview?.plan;
  const checks =
    preview?.planValidator?.status === 'pass' && preview.conversion.validator.status === 'pass';
  const blockers = [
    ...(preview && !preview.conversion.result.ok ? preview.conversion.result.blockers : []),
    ...(plan && !plan.ok ? plan.blockers : []),
  ];
  return (
    <section className="mt-6" aria-label={t('lab.plan.title')} data-testid="batch-plan">
      <h3 className="mb-1 text-sm font-semibold text-heading">{t('lab.plan.title')}</h3>
      <p className="mb-2 text-xs text-muted">{t('lab.plan.hint')}</p>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="plan-size">{t('lab.plan.size')}</Label>
          <Input
            id="plan-size"
            className="w-28"
            dir="ltr"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            data-testid="plan-size"
          />
        </div>
        {aggs.map((a) => (
          <div key={a.materialId} className="flex flex-col gap-1">
            <Label htmlFor={`pm-${a.materialId}`}>{name(a.materialId)}</Label>
            <Input
              id={`pm-${a.materialId}`}
              className="w-32"
              dir="ltr"
              inputMode="decimal"
              placeholder={t('lab.weights.moisture')}
              value={vals[a.materialId] ?? ''}
              onChange={(e) => setVals({ ...vals, [a.materialId]: e.target.value })}
              data-testid={`plan-moisture-${a.category}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => prev.mutate()}
          disabled={!valid || prev.isPending}
          aria-describedby={valid ? undefined : 'plan-why'}
          data-testid="plan-preview"
        >
          {t('lab.plan.prepare')}
        </Button>
        {plan?.ok && checks && !savedId && (
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="plan-save">
            {t('lab.plan.save')}
          </Button>
        )}
        {savedId && me?.capabilities.includes('export.csv') && (
          <Button
            variant="secondary"
            onClick={() =>
              exportBatchPlan(savedId)
                .then((n_) => toast.success(t('exports.done', { name: n_ })))
                .catch((e: unknown) =>
                  toast.error(e instanceof ApiError ? e.message : t('exports.failed')),
                )
            }
            data-testid="plan-export"
          >
            {t('lab.plan.export')}
          </Button>
        )}
      </div>
      <WhyDisabled id="plan-why" reason={valid ? null : t('lab.plan.why.size')} />
      {err && (
        <p role="alert" className="mt-2 text-sm text-fail-text">
          {err.message}
        </p>
      )}
      {blockers.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm text-fail-text" data-testid="plan-blockers">
          {blockers.map((b, i) => (
            <li key={i}>
              {t(`lab.plan.blocker.${b.code}`, { defaultValue: t('lab.plan.blocker.other') })} ·{' '}
              <Ltr>{b.subject}</Ltr> — {b.detail}
            </li>
          ))}
        </ul>
      )}
      {plan?.ok && (
        <div
          className="mt-3 overflow-x-auto rounded-md border border-line p-3"
          data-testid="plan-result"
        >
          <table className="w-full text-sm">
            <caption className="sr-only">{t('lab.plan.title')}</caption>
            <thead>
              <tr className="text-start text-xs text-muted">
                <th className="text-start">{t('lab.plan.material')}</th>
                <th className="text-end">{t('lab.plan.design')}</th>
                <th className="text-end">{t('lab.plan.corrected')}</th>
                <th className="text-end">{t('lab.plan.exact')}</th>
                <th className="text-end">{t('lab.plan.resolution')}</th>
                <th className="text-end">{t('lab.plan.weigh')}</th>
                <th className="text-end">{t('lab.plan.error')}</th>
              </tr>
            </thead>
            <tbody>
              {plan.lines.map((l) => (
                <tr key={l.materialId} className="border-t border-line">
                  <td>{name(l.materialId)}</td>
                  <td className="text-end tabular-nums">
                    <Ltr>{n(l.designKgPerM3)}</Ltr>
                  </td>
                  <td className="text-end tabular-nums">
                    <Ltr>{n(l.correctedKgPerM3)}</Ltr>
                  </td>
                  <td className="text-end tabular-nums">
                    <Ltr>{n(l.exactKg)}</Ltr>
                  </td>
                  <td className="text-end tabular-nums">
                    <Ltr>{n(l.resolutionKg)}</Ltr>
                  </td>
                  <td className="text-end font-semibold tabular-nums">
                    <Ltr>{n(l.roundedKg)}</Ltr>
                  </td>
                  <td className="text-end tabular-nums">
                    <Ltr>{n(l.errorKg)}</Ltr>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-sm" data-testid="plan-reconciliation">
            {t('lab.plan.reconciliation', {
              design: n(plan.reconciliation.designTotalKg),
              exact: n(plan.reconciliation.exactTotalKg),
              rounded: n(plan.reconciliation.roundedTotalKg),
            })}
          </p>
          <p
            className={`mt-1 text-sm ${checks ? 'text-pass-text' : 'text-fail-text'}`}
            data-testid="plan-validator"
            data-status={checks ? 'pass' : 'fail'}
          >
            {t(checks ? 'lab.plan.checksPass' : 'lab.plan.checksFail')}
          </p>
          <p className="mt-1 text-xs text-muted">
            {t('lab.plan.bound', {
              code: preview?.design.code ?? '',
              version: preview?.design.version ?? 0,
              hash: preview?.binding.designVersionHash.slice(0, 12) ?? '',
            })}
          </p>
        </div>
      )}
    </section>
  );
}
