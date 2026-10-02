// Controlled optimizer API (M3.1): create a design request, read its candidates, and turn one validated
// candidate into a TRIAL CANDIDATE design. Nothing here approves anything: the only edge opened is
// draft/evaluated → trial_candidate, on independent-validator evidence, and every candidate still needs a trial.
import { schema, type AuditRecorder, type Tx } from '@khalta/db';
import type { AuthContext } from '../middleware';
import { canTransition, type EvaluationSnapshot } from '@khalta/engine';
import { candidateRecord } from '@khalta/engine/optimizer';
import { roleCan, canAccessPlant } from '@khalta/rbac';
import { validateCandidate } from '@khalta/validator';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import { evaluateAndStore } from '../evaluation/run';
import { runEvaluation, stripCost } from '../evaluation/service';
import {
  candidateSnapshot,
  evaluateMix,
  mapRequest,
  preflight,
  requestBody,
  runOptimizer,
  type RequestBody,
} from '../optimizer/service';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
const candParam = z.object({ id: z.uuid(), cid: z.uuid() });
const listQuery = z.object({ plantId: z.uuid().optional() });
const mixLines = z
  .array(
    z.strictObject({
      materialId: z.uuid(),
      kgPerM3: z.string().regex(/^\d{1,5}(\.\d{1,3})?$/),
    }),
  )
  .min(2)
  .max(30);
const trialBody = z.strictObject({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(200),
  /** Required (and QC-manager only) when the candidate carries MODEL_PREDICTS_SHORTFALL. */
  authorizationReason: z.string().trim().min(10).max(500).optional(),
});

type CandidateRow = typeof schema.designCandidates.$inferSelect;

/** What a role may see of a candidate: money figures only with `cost.view`. */
function candidateView(c: CandidateRow, canCost: boolean) {
  const report = c.report as Parameters<typeof stripCost>[0];
  const deviations = (c.deviations ?? []) as { weightedCostJod?: number }[];
  return {
    id: c.id,
    rank: c.rank,
    configuration: c.configuration,
    lines: c.lines,
    report: canCost ? report : stripCost(report),
    guardrails: c.guardrails,
    margins: c.margins,
    binding: canCost ? c.binding : [],
    characteristics: c.characteristics,
    deviations: canCost ? deviations : deviations.map(({ weightedCostJod: _w, ...rest }) => rest),
    notes: c.notes,
    evidence: c.evidence,
    requiresAuthorization: c.requiresAuthorization,
    costJodPerM3: canCost ? c.costJodPerM3 : null,
    validator: {
      status: c.validatorStatus,
      version: (c.validator as { validatorVersion?: string }).validatorVersion ?? null,
      checked: (c.validator as { evaluation?: { checked?: unknown } }).evaluation?.checked ?? null,
    },
  };
}

async function createRequest(tx: Tx, auth: AuthContext, audit: AuditRecorder, body: RequestBody) {
  if (!canAccessPlant(auth.scope, body.plantId)) throw notFound('Plant not found');
  const [plant] = await tx
    .select({ id: schema.plants.id })
    .from(schema.plants)
    .where(and(eq(schema.plants.id, body.plantId), eq(schema.plants.tenantId, auth.tenantId)));
  if (!plant) throw notFound('Plant not found');

  const run = await runOptimizer(tx, auth.tenantId, body);
  const r = run.result;
  const validated = r.candidates.filter((c) => run.validations.get(c.rank)?.status === 'pass');
  if (validated.length !== r.candidates.length)
    throw new ApiError(
      500,
      'internal_error',
      'A candidate failed the independent validator after it was accepted',
    );
  const { base } = run.input;
  const [row] = await tx
    .insert(schema.designRequests)
    .values({
      tenantId: auth.tenantId,
      plantId: body.plantId,
      mode: body.mode,
      objective: body.objective,
      request: base.request,
      inputs: { characteristics: body.characteristics ?? {}, materials: body.materials ?? {} },
      snapshot: { ...base, characteristics: base.characteristics },
      status: r.status,
      outcome: {
        blockers: r.blockers,
        conflicts: r.conflicts,
        dof: r.dof,
        stats: r.stats,
        excluded: r.excluded,
        notes: r.notes,
      },
      optimizerVersion: r.optimizerVersion,
      solver: 'highs-wasm',
      createdBy: auth.user.id,
    })
    .returning();
  const stored = r.candidates.length
    ? await tx
        .insert(schema.designCandidates)
        .values(
          r.candidates.map((c) => ({
            tenantId: auth.tenantId,
            requestId: row!.id,
            rank: c.rank,
            configuration: c.configuration,
            lines: c.lines,
            overrides: {
              request: c.snapshot.request,
              roundingTolerance: c.snapshot.settings.roundingTolerance,
            },
            report: c.report,
            guardrails: c.guardrails,
            margins: c.margins,
            binding: c.binding,
            characteristics: c.characteristics,
            deviations: c.deviations,
            notes: c.notes,
            evidence: c.evidence,
            requiresAuthorization: c.requiresAuthorization,
            costJodPerM3: c.costJodPerM3,
            objectiveValue: c.objectiveValue.toFixed(6),
            validator: run.validations.get(c.rank)!,
            validatorStatus: 'pass' as const,
          })),
        )
        .returning()
    : [];
  await audit.record({
    action: 'design_request.create',
    entityType: 'design_request',
    entityId: row!.id,
    after: {
      status: r.status,
      objective: body.objective,
      candidates: stored.length,
      blockers: r.blockers.length,
      stats: r.stats,
    },
  });
  const canCost = roleCan(auth.role, 'cost.view', auth.settings);
  return {
    id: row!.id,
    status: r.status,
    objective: r.objective,
    outcome: row!.outcome,
    candidates: stored.sort((a, b) => a.rank - b.rank).map((c) => candidateView(c, canCost)),
  };
}

export function designRequestRoutes(api: ApiRoutes) {
  api.mutate(
    'post',
    '/api/design-requests',
    {
      summary:
        'Run the controlled optimizer: up to N validated CANDIDATES (not approved mixes), or the named blockers / conflicts that prevent them',
      capability: 'design.write',
      body: requestBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => createRequest(tx, auth, audit, body),
  );

  api.get(
    '/api/design-requests',
    { summary: 'Optimizer requests, newest first', capability: 'library.read', query: listQuery },
    async ({ auth, query, db }) => {
      const where = [eq(schema.designRequests.tenantId, auth.tenantId)];
      if (query.plantId) where.push(eq(schema.designRequests.plantId, query.plantId));
      if (!auth.scope.all) {
        if (auth.scope.plantIds.length === 0) return [];
        where.push(inArray(schema.designRequests.plantId, [...auth.scope.plantIds]));
      }
      return db
        .select({
          id: schema.designRequests.id,
          plantId: schema.designRequests.plantId,
          mode: schema.designRequests.mode,
          objective: schema.designRequests.objective,
          status: schema.designRequests.status,
          request: schema.designRequests.request,
          createdAt: schema.designRequests.createdAt,
          candidates: sql<number>`(select count(*)::int from design_candidates c where c.request_id = ${schema.designRequests.id})`,
        })
        .from(schema.designRequests)
        .where(and(...where))
        .orderBy(desc(schema.designRequests.createdAt))
        .limit(100);
    },
  );

  api.get(
    '/api/design-requests/:id',
    {
      summary: 'One optimizer request with its candidates (cost only for roles that may see it)',
      capability: 'library.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const [row] = await db
        .select()
        .from(schema.designRequests)
        .where(
          and(
            eq(schema.designRequests.id, params.id),
            eq(schema.designRequests.tenantId, auth.tenantId),
          ),
        );
      if (!row || !canAccessPlant(auth.scope, row.plantId))
        throw notFound('Design request not found');
      const cands = await db
        .select()
        .from(schema.designCandidates)
        .where(eq(schema.designCandidates.requestId, row.id))
        .orderBy(schema.designCandidates.rank);
      const canCost = roleCan(auth.role, 'cost.view', auth.settings);
      const designs = cands.length
        ? await db
            .select({
              id: schema.mixDesigns.id,
              code: schema.mixDesigns.code,
              status: schema.mixDesigns.status,
              sourceCandidateId: schema.mixDesigns.sourceCandidateId,
            })
            .from(schema.mixDesigns)
            .where(
              and(
                eq(schema.mixDesigns.tenantId, auth.tenantId),
                inArray(
                  schema.mixDesigns.sourceCandidateId,
                  cands.map((c) => c.id),
                ),
                isNull(schema.mixDesigns.deletedAt),
              ),
            )
        : [];
      return {
        id: row.id,
        plantId: row.plantId,
        mode: row.mode,
        objective: row.objective,
        status: row.status,
        request: row.request,
        inputs: row.inputs,
        outcome: row.outcome,
        optimizerVersion: row.optimizerVersion,
        solver: row.solver,
        createdAt: row.createdAt,
        candidates: cands.map((c) => ({
          ...candidateView(c, canCost),
          design: designs.find((d) => d.sourceCandidateId === c.id) ?? null,
        })),
      };
    },
  );

  api.mutate(
    'post',
    '/api/design-requests/:id/candidates/:cid/trial-candidate',
    {
      summary:
        'Create a draft design from a validated candidate and move it to TRIAL CANDIDATE (never approved; a trial is still required)',
      capability: 'trial.request',
      params: candParam,
      body: trialBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const [req] = await tx
        .select()
        .from(schema.designRequests)
        .where(
          and(
            eq(schema.designRequests.id, params.id),
            eq(schema.designRequests.tenantId, auth.tenantId),
          ),
        );
      if (!req || !canAccessPlant(auth.scope, req.plantId))
        throw notFound('Design request not found');
      const [cand] = await tx
        .select()
        .from(schema.designCandidates)
        .where(
          and(
            eq(schema.designCandidates.id, params.cid),
            eq(schema.designCandidates.requestId, req.id),
            eq(schema.designCandidates.tenantId, auth.tenantId),
          ),
        )
        .for('update');
      if (!cand) throw notFound('Candidate not found');
      const [existing] = await tx
        .select({ id: schema.mixDesigns.id })
        .from(schema.mixDesigns)
        .where(eq(schema.mixDesigns.sourceCandidateId, cand.id));
      if (existing) throw new ApiError(409, 'conflict', 'This candidate already became a design');

      // The independent validator runs again now, on the rebuilt snapshot: nothing is trusted from storage.
      const snapshot: EvaluationSnapshot = candidateSnapshot(
        req.snapshot as Omit<EvaluationSnapshot, 'lines'>,
        cand,
      );
      const { report } = runEvaluation(snapshot);
      const inputs = req.inputs as { materials?: { include?: string[]; exclude?: string[] } };
      const record = candidateRecord(
        {
          configuration: cand.configuration as never,
          lines: cand.lines as never,
          snapshot,
          report,
          guardrails: cand.guardrails as never,
          margins: cand.margins as never,
          binding: [],
          costJodPerM3: report.cost.totalJodPerM3,
          objectiveValue: Number(cand.objectiveValue),
          deviations: cand.deviations as never,
          characteristics: cand.characteristics as never,
          evidence: cand.evidence as never,
          requiresAuthorization: cand.requiresAuthorization,
          notes: [],
        },
        inputs.materials ?? {},
      );
      const fresh = validateCandidate(record);
      if (fresh.status !== 'pass')
        throw new ApiError(
          409,
          'validator_failed',
          'The independent validator no longer agrees with this candidate; run the request again',
          { mismatches: fresh.mismatches.slice(0, 10) },
        );

      let authorization: { by: string; reason: string } | null = null;
      if (cand.requiresAuthorization) {
        if (!roleCan(auth.role, 'candidate.authorize', auth.settings))
          throw new ApiError(
            403,
            'authorization_required',
            'This candidate is predicted to fall short of the strength baseline (MODEL_PREDICTS_SHORTFALL); a QC manager must authorise it',
          );
        if (!body.authorizationReason)
          throw new ApiError(
            400,
            'authorization_reason_required',
            'A reason is required to authorise a candidate that is predicted to fall short',
          );
        authorization = { by: auth.user.id, reason: body.authorizationReason };
      }

      const adHocIds = (cand.lines as { materialId: string }[]).filter((l) =>
        l.materialId.startsWith('adhoc-'),
      );
      if (adHocIds.length > 0)
        throw new ApiError(
          409,
          'adhoc_material',
          'This candidate uses a what-if material that exists only in the request; add it to the library (with a test and a price) and run the request again',
        );
      const [dupe] = await tx
        .select({ id: schema.mixDesigns.id })
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            eq(schema.mixDesigns.code, body.code),
            isNull(schema.mixDesigns.deletedAt),
          ),
        );
      if (dupe) throw new ApiError(409, 'conflict', 'A design with this code already exists');

      const reqInput = req.request as EvaluationSnapshot['request'];
      const cfg = cand.configuration as { nmasMm: number };
      const requirements = {
        fcMpa: reqInput.fcMpa,
        basis: reqInput.basis,
        testAgeDays: reqInput.testAgeDays,
        exposure: reqInput.exposure,
        slumpMm: reqInput.slumpMm,
        nmasMm: cfg.nmasMm,
        pumpable: reqInput.pumpable,
        s3Option: reqInput.s3Option,
        airPct: snapshot.request.airPct,
      };
      const [design] = await tx
        .insert(schema.mixDesigns)
        .values({
          tenantId: auth.tenantId,
          code: body.code,
          name: body.name,
          plantId: req.plantId,
          version: 1,
          status: 'draft',
          rulesetMode: req.mode,
          requirements,
          inputsSnapshot: {
            source: 'optimizer',
            requestId: req.id,
            candidateId: cand.id,
            rank: cand.rank,
            evidence: cand.evidence,
            note: 'an optimizer candidate: not approved; a trial is required',
          },
          evaluationPending: true,
          sourceCandidateId: cand.id,
          createdBy: auth.user.id,
        })
        .returning();
      const lines = cand.lines as { materialId: string; kgPerM3: string }[];
      const names = await tx
        .select({ id: schema.materials.id, nameEn: schema.materials.marketNameEn })
        .from(schema.materials)
        .where(
          and(
            eq(schema.materials.tenantId, auth.tenantId),
            inArray(
              schema.materials.id,
              lines.map((l) => l.materialId),
            ),
          ),
        );
      const nameBy = new Map(names.map((n) => [n.id, n.nameEn]));
      await tx.insert(schema.mixDesignLines).values(
        lines.map((l, i) => ({
          tenantId: auth.tenantId,
          designId: design!.id,
          materialId: l.materialId,
          quantityKgM3: l.kgPerM3,
          originalQuantity: l.kgPerM3,
          originalUnit: 'kg/m3' as const,
          originalName: nameBy.get(l.materialId) ?? '',
          sourceLine: i + 1,
          matchMethod: 'confirmed' as const,
        })),
      );
      await tx.insert(schema.designTransitions).values({
        tenantId: auth.tenantId,
        designId: design!.id,
        fromStatus: 'none',
        toStatus: 'draft',
        actorId: auth.user.id,
        evidence: { kind: 'optimizer_candidate', requestId: req.id, candidateId: cand.id },
      });

      const run = await evaluateAndStore(tx, auth, audit, design!, {
        mode: req.mode,
        ...(snapshot.request.airPct !== null ? { airPct: snapshot.request.airPct } : {}),
      });
      if (run.status !== 'evaluated')
        throw new ApiError(
          409,
          'conflict',
          'The design could not be evaluated cleanly, so it cannot become a trial candidate',
        );
      const verdict = canTransition('evaluated', 'trial_candidate', ['validated_candidate']);
      if (!verdict.ok) throw new ApiError(409, 'conflict', verdict.reason);
      await tx
        .update(schema.mixDesigns)
        .set({ status: 'trial_candidate', updatedAt: new Date() })
        .where(eq(schema.mixDesigns.id, design!.id));
      await tx.insert(schema.designTransitions).values({
        tenantId: auth.tenantId,
        designId: design!.id,
        fromStatus: 'evaluated',
        toStatus: 'trial_candidate',
        actorId: auth.user.id,
        evidence: {
          kind: 'validated_candidate',
          requestId: req.id,
          candidateId: cand.id,
          candidateValidator: fresh.status,
          evaluationId: run.evaluationId,
          evidenceLabels: cand.evidence,
          authorization,
          note: 'implies no approval; a trial is required',
        },
      });
      await audit.record({
        action: 'design.trial_candidate',
        entityType: 'mix_design',
        entityId: design!.id,
        after: {
          requestId: req.id,
          candidateId: cand.id,
          rank: cand.rank,
          authorized: authorization !== null,
          status: 'trial_candidate',
        },
      });
      return {
        design: { id: design!.id, code: design!.code, status: 'trial_candidate' },
        evaluationId: run.evaluationId,
      };
    },
  );

  api.readPost(
    '/api/design-requests/preflight',
    {
      summary:
        'Before generating: usable materials (and why not), live code limits for the request, named blockers, and a check of the characteristics. Writes nothing',
      capability: 'design.write',
      body: requestBody,
    },
    async ({ auth, body, db }) => {
      if (!canAccessPlant(auth.scope, body.plantId)) throw notFound('Plant not found');
      return preflight(db, auth.tenantId, body);
    },
  );

  api.readPost(
    '/api/design-requests/evaluate-mix',
    {
      summary:
        'Evaluate a typed (unsaved) mix and run the independent validator on it; nothing is stored (cost removed without cost.view)',
      capability: 'design.write',
      body: requestBody.extend({ lines: mixLines }),
    },
    async ({ auth, body, db }) => {
      if (!canAccessPlant(auth.scope, body.plantId)) throw notFound('Plant not found');
      const { lines, ...rest } = body;
      const run = await evaluateMix(db, auth.tenantId, requestBody.parse(rest), lines);
      return {
        report: roleCan(auth.role, 'cost.view', auth.settings) ? run.report : stripCost(run.report),
        validator: run.validator,
      };
    },
  );

  api.mutate(
    'post',
    '/api/designs',
    {
      summary:
        'Save a typed mix as a new DRAFT design (the Evaluate path of the Studio); nothing is approved',
      capability: 'design.write',
      body: requestBody.extend({
        code: z.string().trim().min(2).max(40),
        name: z.string().trim().min(2).max(200),
        lines: mixLines,
      }),
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      if (!canAccessPlant(auth.scope, body.plantId)) throw notFound('Plant not found');
      const ids = body.lines.map((l) => l.materialId);
      if (new Set(ids).size !== ids.length)
        throw new ApiError(400, 'invalid_request', 'A material appears twice in the lines');
      const mats = await tx
        .select({ id: schema.materials.id, nameEn: schema.materials.marketNameEn })
        .from(schema.materials)
        .where(
          and(
            eq(schema.materials.tenantId, auth.tenantId),
            inArray(schema.materials.id, ids),
            isNull(schema.materials.deletedAt),
          ),
        );
      if (mats.length !== ids.length)
        throw new ApiError(400, 'invalid_request', 'A line refers to an unknown material');
      const [dupe] = await tx
        .select({ id: schema.mixDesigns.id })
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            eq(schema.mixDesigns.code, body.code),
            isNull(schema.mixDesigns.deletedAt),
          ),
        );
      if (dupe) throw new ApiError(409, 'conflict', 'A design with this code already exists');
      const r = body.requirements;
      const [design] = await tx
        .insert(schema.mixDesigns)
        .values({
          tenantId: auth.tenantId,
          code: body.code,
          name: body.name,
          plantId: body.plantId,
          version: 1,
          status: 'draft',
          rulesetMode: body.mode,
          requirements: r,
          inputsSnapshot: { source: 'studio', note: 'typed in the Design Studio; not approved' },
          evaluationPending: true,
          createdBy: auth.user.id,
        })
        .returning();
      const nameBy = new Map(mats.map((m) => [m.id, m.nameEn]));
      await tx.insert(schema.mixDesignLines).values(
        body.lines.map((l, i) => ({
          tenantId: auth.tenantId,
          designId: design!.id,
          materialId: l.materialId,
          quantityKgM3: l.kgPerM3,
          originalQuantity: l.kgPerM3,
          originalUnit: 'kg/m3' as const,
          originalName: nameBy.get(l.materialId) ?? '',
          sourceLine: i + 1,
          matchMethod: 'confirmed' as const,
        })),
      );
      await tx.insert(schema.designTransitions).values({
        tenantId: auth.tenantId,
        designId: design!.id,
        fromStatus: 'none',
        toStatus: 'draft',
        actorId: auth.user.id,
        evidence: { kind: 'studio_draft' },
      });
      await audit.record({
        action: 'design.create',
        entityType: 'mix_design',
        entityId: design!.id,
        after: { code: body.code, status: 'draft', source: 'studio' },
      });
      return { id: design!.id, code: design!.code, status: 'draft', mode: body.mode };
    },
  );

  api.mutate(
    'post',
    '/api/design-requests/compare-plants',
    {
      summary:
        'Run the same request at several plants with a user-confirmed material mapping; one stored request per plant; every figure is theoretical and trial-only',
      capability: 'design.write',
      body: requestBody.omit({ plantId: true }).extend({
        plants: z
          .array(
            z.strictObject({
              plantId: z.uuid(),
              /** home material id -> this plant's material id (null = no counterpart) */
              mapping: z.record(z.string(), z.string().nullable()).default({}),
            }),
          )
          .min(1)
          .max(20),
      }),
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      const { plants, ...rest } = body;
      const out: {
        plantId: string;
        status: string;
        requestId: string | null;
        reason: string | null;
        best: { costJodPerM3: string | null; candidates: number } | null;
      }[] = [];
      const canCost = roleCan(auth.role, 'cost.view', auth.settings);
      for (const p of plants) {
        if (!canAccessPlant(auth.scope, p.plantId)) {
          out.push({
            plantId: p.plantId,
            status: 'skipped',
            requestId: null,
            reason: 'plant_not_accessible',
            best: null,
          });
          continue;
        }
        // A material that already belongs to the target plant (or to every plant) maps to itself.
        const own = await tx
          .select({ id: schema.materials.id })
          .from(schema.materials)
          .where(
            and(
              eq(schema.materials.tenantId, auth.tenantId),
              or(isNull(schema.materials.plantId), eq(schema.materials.plantId, p.plantId)),
            ),
          );
        const mapping = { ...Object.fromEntries(own.map((m) => [m.id, m.id])), ...p.mapping };
        const mapped = mapRequest(
          requestBody.parse({ ...rest, plantId: p.plantId }),
          p.plantId,
          mapping,
        );
        if (!mapped.ok) {
          out.push({
            plantId: p.plantId,
            status: 'skipped',
            requestId: null,
            reason: `no_counterpart:${mapped.missing.join(',')}`,
            best: null,
          });
          continue;
        }
        const res = await createRequest(tx, auth, audit, mapped.body);
        out.push({
          plantId: p.plantId,
          status: res.status,
          requestId: res.id,
          reason: null,
          best:
            res.candidates.length > 0
              ? {
                  costJodPerM3: canCost ? res.candidates[0]!.costJodPerM3 : null,
                  candidates: res.candidates.length,
                }
              : null,
        });
      }
      await audit.record({
        action: 'design_request.compare_plants',
        entityType: 'design_request',
        entityId: crypto.randomUUID(),
        after: {
          plants: out.map((o) => ({
            plantId: o.plantId,
            status: o.status,
            requestId: o.requestId,
          })),
        },
      });
      return { results: out };
    },
  );
}
