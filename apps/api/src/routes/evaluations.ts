import { schema } from '@khalta/db';
import { checkCharacteristics, type EvaluationReport } from '@khalta/engine';
import { limitContextFor } from '@khalta/engine/evaluate';
import { roleCan } from '@khalta/rbac';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { notFound } from '../errors';
import type { AuthContext } from '../middleware';
import type { ApiRoutes } from '../route';
import { evaluateAndStore, loadDesign } from '../evaluation/run';
import { buildSnapshot, stripCost, stripSnapshotCost } from '../evaluation/service';
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

const canSeeCost = (auth: AuthContext) => roleCan(auth.role, 'cost.view', auth.settings);

function shapeReport(auth: AuthContext, report: EvaluationReport) {
  return canSeeCost(auth) ? report : stripCost(report);
}

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
      return (await evaluateAndStore(tx, auth, audit, design, body)).result;
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
