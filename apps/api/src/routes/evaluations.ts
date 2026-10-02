import { schema, type Executor } from '@khalta/db';
import { canTransition, checkCharacteristics, type EvaluationReport } from '@khalta/engine';
import { limitContextFor } from '@khalta/engine/evaluate';
import { canAccessPlant, roleCan } from '@khalta/rbac';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import type { AuthContext } from '../middleware';
import type { ApiRoutes } from '../route';
import {
  buildSnapshot,
  runEvaluation,
  stripCost,
  stripSnapshotCost,
  type DesignRow,
} from '../evaluation/service';
import { loadCurrentRecords } from '../rules/service';

const idParam = z.object({ id: z.uuid() });
const evalParams = z.object({ id: z.uuid(), evalId: z.uuid() });

const projectOverride = z.strictObject({
  requirement: z.string().min(1).max(100),
  value: z.unknown(),
  kind: z
    .enum(['limit_max', 'limit_min', 'allowed_set', 'prohibition', 'range', 'tolerance'])
    .optional(),
  units: z
    .enum([
      'ratio',
      'MPa',
      'kg/m3',
      '%',
      'ppm',
      'mm',
      'degC',
      'fraction',
      'L/m3',
      'kg/cm2',
      'days',
      'none',
    ])
    .optional(),
  clause_ref: z.string().min(1).max(200).optional(),
});

const requestContext = {
  mode: z.enum(['ACI', 'JS', 'BOTH']).default('BOTH'),
  s3Option: z.union([z.literal(1), z.literal(2)]).optional(),
  airPct: z.number().min(0).max(100).optional(),
  projectOverrides: z.array(projectOverride).max(50).optional(),
  /** The request layer of the characteristics (Appendix E `characteristics`). */
  characteristics: z.unknown().optional(),
};

const evaluateBody = z.strictObject({
  ...requestContext,
  evaluationDate: z.iso.date().optional(),
  priceSnapshotId: z.uuid().optional(),
});

const validateBody = z.strictObject({
  designId: z.uuid(),
  ...requestContext,
});

async function loadDesign(db: Executor, auth: AuthContext, id: string, lock = false) {
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

const canSeeCost = (auth: AuthContext) => roleCan(auth.role, 'cost.view', auth.settings);

function shapeReport(auth: AuthContext, report: EvaluationReport) {
  return canSeeCost(auth) ? report : stripCost(report);
}

const ruleVersions = (rules: { id: string; version: number }[]) =>
  rules.map((r) => ({ id: r.id, version: r.version }));

export function evaluationRoutes(api: ApiRoutes) {
  api.mutate(
    'post',
    '/api/designs/:id/evaluate',
    {
      summary:
        'Evaluate a stored design (compliance, cost, data quality) and run the independent validator',
      capability: 'design.write',
      params: idParam,
      body: evaluateBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const design = await loadDesign(tx, auth, params.id, true);
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

      return {
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
        report: shapeReport(auth, report),
        validator,
      };
    },
  );

  api.get(
    '/api/designs/:id/evaluations',
    {
      summary: 'Stored evaluations of a design, newest first',
      capability: 'library.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const design = await loadDesign(db, auth, params.id);
      const rows = await db
        .select({
          id: schema.designEvaluations.id,
          createdAt: schema.designEvaluations.createdAt,
          mode: schema.designEvaluations.mode,
          verdict: schema.designEvaluations.verdict,
          provisional: schema.designEvaluations.provisional,
          validatorStatus: schema.designEvaluations.validatorStatus,
          minimumDataOk: schema.designEvaluations.minimumDataOk,
          costJodPerM3: schema.designEvaluations.costJodPerM3,
          priceBasis: schema.designEvaluations.priceBasis,
          evaluatorVersion: schema.designEvaluations.evaluatorVersion,
          actor: schema.users.name,
        })
        .from(schema.designEvaluations)
        .leftJoin(schema.users, eq(schema.users.id, schema.designEvaluations.createdBy))
        .where(eq(schema.designEvaluations.designId, design.id))
        .orderBy(desc(schema.designEvaluations.createdAt));
      const cost = canSeeCost(auth);
      return rows.map((r) => ({ ...r, costJodPerM3: cost ? r.costJodPerM3 : null }));
    },
  );

  api.get(
    '/api/designs/:id/evaluations/:evalId',
    {
      summary:
        'One stored evaluation: report, validator result and whether its inputs have changed since',
      capability: 'library.read',
      params: evalParams,
    },
    async ({ auth, params, db }) => {
      const design = await loadDesign(db, auth, params.id);
      const [e] = await db
        .select()
        .from(schema.designEvaluations)
        .where(
          and(
            eq(schema.designEvaluations.id, params.evalId),
            eq(schema.designEvaluations.designId, design.id),
          ),
        );
      if (!e) throw notFound('Evaluation not found');
      const snap = e.snapshot as ReturnType<typeof stripSnapshotCost>;

      // "Inputs changed since this evaluation": compare versions, never recompute.
      const current = await db
        .select({
          materialId: schema.materialTests.materialId,
          version: schema.materialTests.version,
        })
        .from(schema.materialTests)
        .where(
          and(
            eq(schema.materialTests.tenantId, auth.tenantId),
            eq(schema.materialTests.isCurrent, true),
          ),
        );
      const currentBy = new Map(current.map((c) => [c.materialId, c.version]));
      const changedMaterials = snap.materials
        .filter((m) => m.test && currentBy.get(m.id) !== m.test.version)
        .map((m) => ({
          materialId: m.id,
          evaluated: m.test!.version,
          current: currentBy.get(m.id) ?? null,
        }));
      const rules = await loadCurrentRecords(db, auth.tenantId);
      const currentRules = new Map(rules.map((r) => [r.id, r.version]));
      const changedRules = snap.rules.filter((r) => currentRules.get(r.id) !== r.version).length;

      return {
        id: e.id,
        createdAt: e.createdAt,
        mode: e.mode,
        verdict: e.verdict,
        provisional: e.provisional,
        validatorStatus: e.validatorStatus,
        evaluatorVersion: e.evaluatorVersion,
        validatorVersion: e.validatorVersion,
        priceBasis: canSeeCost(auth) ? e.priceBasis : null,
        ruleVersions: e.ruleVersions,
        report: shapeReport(auth, e.report as EvaluationReport),
        validator: e.validator,
        inputsChanged: { materials: changedMaterials, rules: changedRules },
        snapshot: {
          design: snap.design,
          request: snap.request,
          evaluationDate: snap.evaluationDate,
          settings: snap.settings,
        },
      };
    },
  );

  api.readPost(
    '/api/characteristics/validate',
    {
      summary:
        'Check characteristics against the hard limits for a design (the form and the API share this check)',
      capability: 'design.write',
      body: validateBody,
    },
    async ({ auth, body, db }) => {
      const design = await loadDesign(db, auth, body.designId);
      const snapshot = await buildSnapshot(db, auth.tenantId, design, {
        mode: body.mode,
        s3Option: body.s3Option ?? null,
        airPct: body.airPct ?? null,
        projectOverrides: body.projectOverrides ?? [],
      });
      const checked = checkCharacteristics(
        [{ level: 'request', origin: 'request', characteristics: body.characteristics ?? {} }],
        limitContextFor(snapshot),
      );
      return {
        ok: checked.ok,
        invalid: checked.invalid,
        rejected: checked.rejected,
        characteristics: checked.characteristics ?? [],
      };
    },
  );
}
