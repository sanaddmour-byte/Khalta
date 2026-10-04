import { useQuery } from '@tanstack/react-query';
import { Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import { sensitivityQuery, type Termination } from './api';

const WARN = new Set(['feasible_unproven', 'timed_out', 'solver_failure']);

/**
 * How the search ended and what it ran under. It never says "optimal": the search is one LP per discrete
 * configuration, so the first candidate is the lowest cost FOUND within the selected constraints.
 */
export function TerminationPanel({
  termination,
  canCost,
}: {
  termination: Termination;
  canCost: boolean;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const c = termination.configurations;
  const Icon = WARN.has(termination.kind) ? TriangleAlert : Info;
  return (
    <section
      className="rounded-md border border-line p-3 text-sm"
      aria-label={t('studio.trans.title')}
      data-testid="termination"
      data-kind={termination.kind}
    >
      <p
        className={`flex items-center gap-2 font-medium ${WARN.has(termination.kind) ? 'text-warn-text' : 'text-heading'}`}
      >
        <Icon className="size-4" aria-hidden />
        {t(`studio.trans.kind.${termination.kind}`)}
      </p>
      <p className="mt-1 text-muted">
        {t(`studio.trans.statement.${termination.objective.statement}`)}
      </p>
      <p className="mt-1 text-muted" data-testid="termination-configs">
        {t('studio.trans.configs', {
          solved: c.solved,
          infeasible: c.infeasible,
          errors: c.solverErrors,
          skipped: c.notAttempted,
          total: c.enumerated,
        })}
      </p>
      <p className="mt-1 text-muted">
        {t('studio.trans.validator', {
          accepted: termination.validator.accepted,
          rejected: termination.validator.rejected,
        })}
      </p>
      {canCost && termination.maxRoundingGapJod != null && (
        <p className="mt-1 text-muted" data-testid="rounding-gap">
          {t('studio.trans.gap', {
            jod: f.number(termination.maxRoundingGapJod, { maximumFractionDigits: 3 }),
          })}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">{t('studio.trans.notProven')}</p>
    </section>
  );
}

/** Break-even prices of the stored candidates. A re-pricing only: nothing is re-solved. */
export function SensitivityPanel({
  requestId,
  nameOfMaterial,
}: {
  requestId: string;
  nameOfMaterial: (id: string) => string;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const q = useQuery({ ...sensitivityQuery(requestId), retry: false });
  if (q.isPending || q.isError || !q.data) return null;
  const rows = q.data.breakeven.filter((b) => b.change !== null);
  const flips = q.data.scenarios.filter((s) => s.topChanged);
  return (
    <section
      className="rounded-md border border-line p-3 text-sm"
      aria-label={t('studio.sens.title')}
      data-testid="sensitivity"
    >
      <h3 className="font-semibold text-heading">{t('studio.sens.title')}</h3>
      <p className="mt-1 text-xs text-muted">{t('studio.sens.hint')}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-muted">{t('studio.sens.stable')}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {rows.map((b) => (
            <li key={b.materialId}>
              {t('studio.sens.breakeven', {
                material: nameOfMaterial(b.materialId),
                pct: f.number(Math.abs((b.change as number) * 100), { maximumFractionDigits: 1 }),
                direction: t((b.change as number) > 0 ? 'studio.sens.rises' : 'studio.sens.falls'),
              })}
            </li>
          ))}
        </ul>
      )}
      {flips.length > 0 && (
        <p className="mt-2 text-xs text-muted">{t('studio.sens.flips', { n: flips.length })}</p>
      )}
    </section>
  );
}
