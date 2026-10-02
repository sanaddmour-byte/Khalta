import { schema, type AuditRecorder, type Executor, type Tx } from '@khalta/db';
import { canTransition, checkCharacteristics, type EvaluationReport } from '@khalta/engine';
import { limitContextFor } from '@khalta/engine/evaluate';
import type { ProjectOverride } from '@khalta/rules';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError, notFound } from '../errors';
import type { AuthContext } from '../middleware';
import { buildSnapshot, runEvaluation, stripCost, type DesignRow } from './service';
import { canAccessPlant, roleCan } from '@khalta/rbac';

export interface EvalInput {
  mode: 'ACI' | 'JS' | 'BOTH';
  evaluationDate?: string | undefined;
  priceSnapshotId?: string | undefined;
  s3Option?: 1 | 2 | undefined;
  airPct?: number | undefined;
  projectOverrides?: ProjectOverride[] | undefined;
  characteristics?: unknown;
}

const ruleVersions = (rules: { id: string; version: number }[]) =>
  rules.map((r) => ({ id: r.id, version: r.version }));

/** What the portfolio and data-quality views need without reading the whole report. */
export function summarize(report: EvaluationReport) {
  return {
    failing: report.checks.filter((c) => c.status === 'fail').length,
    unevaluated: report.checks.filter((c) => c.status === 'not_evaluated').length,
    blockers: report.dataQuality.filter((q) => q.severity === 'blocker').length,
    provisional: report.provisional,
    evidence: report.evidence,
    quality: report.dataQuality
      .filter((q) => q.severity !== 'info')
      .map((q) => ({ code: q.code, severity: q.severity, materialId: q.materialId ?? null })),
  };
}

/**
 * Evaluate one design, run the independent validator, store both, and move the state if the evidence allows.
 * Shared by the single, batch, baseline and opportunity routes so they cannot drift apart.
 */
export async function evaluateAndStore(
  tx: Tx,
  auth: AuthContext,
  audit: AuditRecorder,
  design: DesignRow,
  body: EvalInput,
) {
  if (design.status === 'superseded' || design.status === 'retired')
    throw new ApiError(409, 'conflict', `A ${design.status} design cannot be evaluated`);

  const snapshot = await buildSnapshot(tx, auth.tenantId, design, {
    mode: body.mode,
    ...(body.evaluationDate ? { evaluationDate: body.evaluationDate } : {}),
    priceSnapshotId: body.priceSnapshotId ?? null,
    s3Option: body.s3Option ?? null,
    airPct: body.airPct ?? null,
    projectOverrides: body.projectOverrides ?? [],
  });
  if (body.priceSnapshotId && snapshot.priceBasis.kind === 'snapshot') {
    const [ps] = await tx
      .select({ id: schema.priceSnapshots.id })
      .from(schema.priceSnapshots)
      .where(
        and(
          eq(schema.priceSnapshots.id, body.priceSnapshotId),
          eq(schema.priceSnapshots.tenantId, auth.tenantId),
        ),
      );
    if (!ps) throw notFound('Price snapshot not found');
  }

  // User characteristics tighten, never loosen: rejected here exactly as in the form.
  if (body.characteristics !== undefined) {
    const checked = checkCharacteristics(
      [{ level: 'request', origin: 'request', characteristics: body.characteristics }],
      limitContextFor(snapshot),
    );
    if (!checked.ok)
      throw new ApiError(400, 'characteristics_rejected', 'The characteristics were rejected', {
        invalid: checked.invalid,
        rejected: checked.rejected,
      });
    snapshot.characteristics = checked.characteristics ?? [];
  }

  const { report, validator } = runEvaluation(snapshot);
  const attested = design.approvalSource === 'legacy_attested';

  const [row] = await tx
    .insert(schema.designEvaluations)
    .values({
      tenantId: auth.tenantId,
      designId: design.id,
      mode: body.mode,
      snapshot,
      report,
      validator,
      validatorStatus: validator.status,
      verdict: report.verdict,
      provisional: report.provisional,
      minimumDataOk: report.minimumData.ok,
      costJodPerM3: report.cost.totalJodPerM3,
      priceBasis: snapshot.priceBasis,
      ruleVersions: ruleVersions(snapshot.rules),
      summary: summarize(report),
      testVersions: Object.fromEntries(
        snapshot.materials.flatMap((m) => (m.test ? [[m.id, m.test.version]] : [])),
      ),
      evaluatorVersion: report.evaluatorVersion,
      validatorVersion: validator.validatorVersion,
      createdBy: auth.user.id,
    })
    .returning();

  // State: only a verified evaluation with the minimum data moves a draft to `evaluated`.
  let moved = false;
  let blocker: string | null = null;
  let status = design.status;
  if (design.status === 'draft') {
    if (validator.status !== 'pass') blocker = 'validator_failed';
    else if (!report.minimumData.ok) blocker = 'minimum_data_missing';
    else {
      const verdict = canTransition('draft', 'evaluated', ['evaluation_verified']);
      if (!verdict.ok) throw new ApiError(409, 'conflict', verdict.reason);
      status = 'evaluated';
      moved = true;
      await tx.insert(schema.designTransitions).values({
        tenantId: auth.tenantId,
        designId: design.id,
        fromStatus: 'draft',
        toStatus: 'evaluated',
        actorId: auth.user.id,
        evidence: {
          kind: 'evaluation_verified',
          evaluationId: row!.id,
          validator: validator.status,
          verdict: report.verdict,
          note: 'implies no approval',
        },
      });
    }
  }
  // An attested design keeps its state; a failed hard check raises the revalidation flag (M1.3).
  let needsRevalidation = design.needsRevalidation;
  if (attested && validator.status === 'pass') needsRevalidation = report.verdict === 'fail';

  await tx
    .update(schema.mixDesigns)
    .set({
      status,
      evaluationPending: false,
      needsRevalidation,
      lastEvaluationId: row!.id,
      lastVerdict: report.verdict,
      lastEvaluatedAt: row!.createdAt,
      updatedAt: new Date(),
    })
    .where(eq(schema.mixDesigns.id, design.id));

  await audit.record({
    action: 'design.evaluate',
    entityType: 'mix_design',
    entityId: design.id,
    before: { status: design.status, needsRevalidation: design.needsRevalidation },
    after: {
      status,
      needsRevalidation,
      evaluationId: row!.id,
      mode: body.mode,
      verdict: report.verdict,
      validator: validator.status,
    },
  });

  const shaped = roleCan(auth.role, 'cost.view', auth.settings) ? report : stripCost(report);
  return {
    // what the API returns (cost removed for roles without cost.view)
    result: {
      evaluation: {
        id: row!.id,
        createdAt: row!.createdAt,
        mode: body.mode,
        verdict: report.verdict,
        provisional: report.provisional,
        validatorStatus: validator.status,
      },
      design: { id: design.id, status, needsRevalidation },
      transition: { moved, blocker },
      report: shaped,
      validator,
    },
    // what trusted server code needs (never sent to the client as is)
    report,
    snapshot,
    validator,
    evaluationId: row!.id,
    status,
  };
}

export async function loadDesign(db: Executor, auth: AuthContext, id: string, lock = false) {
  const q = db
    .select()
    .from(schema.mixDesigns)
    .where(
      and(
        eq(schema.mixDesigns.id, id),
        eq(schema.mixDesigns.tenantId, auth.tenantId),
        isNull(schema.mixDesigns.deletedAt),
      ),
    );
  const [d] = await (lock ? q.for('update') : q);
  if (!d || !canAccessPlant(auth.scope, d.plantId)) throw notFound('Design not found');
  return d as DesignRow;
}
