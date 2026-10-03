// Price a design without storing anything: the same evaluator and independent validator, at live prices or at a
// named snapshot. Used by the proactive jobs and the savings ledger (both sides of a comparison use ONE snapshot).
import { schema, type Executor } from '@khalta/db';
import type { EvaluationReport, EvaluationSnapshot } from '@khalta/engine';
import { eq } from 'drizzle-orm';
import { buildSnapshot, runEvaluation, type DesignRow } from '../evaluation/service';

export interface Priced {
  report: EvaluationReport;
  validatorPass: boolean;
  /** Cost per m³ as a decimal string, or null while any price is missing. */
  cost: string | null;
  verdict: EvaluationReport['verdict'];
  provisional: boolean;
}

export async function priceDesign(
  db: Executor,
  tenantId: string,
  d: DesignRow,
  opts: { snapshotId?: string | null } = {},
): Promise<Priced> {
  const [stored] = d.lastEvaluationId
    ? await db
        .select({
          mode: schema.designEvaluations.mode,
          snapshot: schema.designEvaluations.snapshot,
        })
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
    : [];
  const prev = stored?.snapshot as EvaluationSnapshot | undefined;
  let asOf: string | undefined;
  if (opts.snapshotId) {
    const [s] = await db
      .select({ asOf: schema.priceSnapshots.asOf })
      .from(schema.priceSnapshots)
      .where(eq(schema.priceSnapshots.id, opts.snapshotId));
    asOf = s?.asOf;
  }
  const snapshot = await buildSnapshot(db, tenantId, d, {
    mode: stored?.mode ?? (d.rulesetMode as 'ACI' | 'JS' | 'BOTH' | null) ?? 'BOTH',
    s3Option: prev?.request.s3Option ?? null,
    airPct: prev?.request.airPct ?? null,
    projectOverrides: prev?.projectOverrides ?? [],
    ...(opts.snapshotId
      ? { priceSnapshotId: opts.snapshotId, ...(asOf ? { evaluationDate: asOf } : {}) }
      : {}),
  });
  if (prev) snapshot.characteristics = prev.characteristics ?? [];
  const { report, validator } = runEvaluation(snapshot);
  return {
    report,
    validatorPass: validator.status === 'pass',
    cost: report.cost.state === 'complete' ? report.cost.totalJodPerM3 : null,
    verdict: report.verdict,
    provisional: report.provisional,
  };
}
