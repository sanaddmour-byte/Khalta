// Lab loop (F-023, F-024): trial batches, strength results, batch-weight conversion and stored batch instances.
// Records are append-only. A batch instance is a production correction, never a new design version.
import { schema } from '@khalta/db';
import { canAccessPlant } from '@khalta/rbac';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import { loadDesign } from '../evaluation/run';
import { loadSettings } from '../settings';
import { gatherSubmittal, renderPdf, submittalHtml } from '../submittal/render';
import { convert, moistureBody, planBody, prepare } from '../lab/service';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
const num = (min: number, max: number, dp: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .transform((v) => v.toFixed(dp));
const batchBody = z.strictObject({
  batchedOn: z.iso.date(),
  slumpMm: num(0, 300, 1).optional(),
  airPct: num(0, 20, 2).optional(),
  temperatureC: num(-10, 60, 1).optional(),
  freshDensityKgM3: num(1500, 3500, 1).optional(),
  yieldM3: num(0.5, 1.5, 3).optional(),
  waterAddedKgM3: num(0, 100, 1).optional(),
  /** Optional criteria: judged only when QC has configured them. */
  retainedSlumpMm: num(0, 300, 1).optional(),
  retentionMinutes: z.number().int().min(1).max(600).optional(),
  stability: z.enum(['stable', 'bleeding', 'segregation', 'bleeding_and_segregation']).optional(),
  placementAcceptable: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
  supersedesId: z.uuid().optional(),
});
const resultsBody = z.strictObject({
  castDate: z.iso.date(),
  ageDays: z.number().int().min(1).max(365),
  specimenType: z.enum(['cylinder', 'cube']),
  setId: z.string().trim().min(1).max(60),
  resultsMpa: z.array(z.number().min(0).max(200)).min(1).max(12),
});

const TRIAL_STATES = ['trial_candidate', 'trial_in_progress'];

export function labRoutes(api: ApiRoutes) {
  api.mutate(
    'post',
    '/api/designs/:id/trial-batches',
    {
      summary:
        'Log a trial batch against a trial candidate (append-only; a correction is a new batch)',
      capability: 'lab.enter',
      params: idParam,
      body: batchBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      if (!TRIAL_STATES.includes(d.status))
        throw new ApiError(
          409,
          'conflict',
          'Trial batches are logged for trial candidates and designs in trial',
        );
      if (body.supersedesId) {
        const [old] = await tx
          .select({ id: schema.trialBatches.id })
          .from(schema.trialBatches)
          .where(
            and(
              eq(schema.trialBatches.id, body.supersedesId),
              eq(schema.trialBatches.designId, d.id),
            ),
          );
        if (!old)
          throw new ApiError(
            400,
            'bad_request',
            'The batch it supersedes is not a batch of this design',
          );
      }
      const { batchedOn, ...rest } = body;
      const [row] = await tx
        .insert(schema.trialBatches)
        .values({
          ...rest,
          tenantId: auth.tenantId,
          designId: d.id,
          batchedOn,
          createdBy: auth.user.id,
        })
        .returning({ id: schema.trialBatches.id });
      await audit.record({
        action: 'trial_batch.create',
        entityType: 'trial_batch',
        entityId: row!.id,
        after: { designId: d.id, batchedOn },
      });
      return { id: row!.id };
    },
  );

  api.get(
    '/api/designs/:id/trial-batches',
    {
      summary: 'Trial batches of a design with their strength results',
      capability: 'library.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const d = await loadDesign(db, auth, params.id);
      const batches = await db
        .select()
        .from(schema.trialBatches)
        .where(eq(schema.trialBatches.designId, d.id))
        .orderBy(desc(schema.trialBatches.batchedOn), desc(schema.trialBatches.createdAt));
      const results = await db
        .select()
        .from(schema.strengthResults)
        .where(eq(schema.strengthResults.designId, d.id))
        .orderBy(asc(schema.strengthResults.castDate), asc(schema.strengthResults.setId));
      const { testAgeDays, fcMpa } = d.requirements as { testAgeDays?: number; fcMpa?: number };
      const [ev] = d.lastEvaluationId
        ? await db
            .select({ report: schema.designEvaluations.report })
            .from(schema.designEvaluations)
            .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
        : [];
      const fcr = (ev?.report as { strengthAdequacy?: { fcrMpa?: number | null } } | undefined)
        ?.strengthAdequacy?.fcrMpa;
      return {
        testAgeDays: testAgeDays ?? null,
        fcMpa: fcMpa ?? null,
        fcrMpa: fcr ?? null,
        batches: batches.map(({ strengthMpa: _legacy, ...b }) => b),
        results,
      };
    },
  );

  api.mutate(
    'post',
    '/api/trial-batches/:id/strength-results',
    {
      summary: 'Add the specimens of one set (cast date, age, type) to a trial batch',
      capability: 'lab.enter',
      after: ({ auth, result }) =>
        api.jobs.enqueue(
          'strength-result',
          { tenantId: auth.tenantId, designId: (result as { designId: string }).designId },
          { delaySeconds: api.jobDelaySeconds },
        ),
      params: idParam,
      body: resultsBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const [b] = await tx
        .select()
        .from(schema.trialBatches)
        .where(
          and(
            eq(schema.trialBatches.id, params.id),
            eq(schema.trialBatches.tenantId, auth.tenantId),
          ),
        );
      if (!b) throw notFound('Trial batch not found');
      const d = await loadDesign(tx, auth, b.designId);
      if (!canAccessPlant(auth.scope, d.plantId)) throw notFound('Trial batch not found');
      const rows = await tx
        .insert(schema.strengthResults)
        .values(
          body.resultsMpa.map((r) => ({
            tenantId: auth.tenantId,
            plantId: d.plantId,
            trialBatchId: b.id,
            designId: d.id,
            castDate: body.castDate,
            ageDays: body.ageDays,
            specimenType: body.specimenType,
            setId: body.setId,
            resultMpa: r.toFixed(2),
            createdBy: auth.user.id,
          })),
        )
        .returning({ id: schema.strengthResults.id });
      await audit.record({
        action: 'strength_results.create',
        entityType: 'trial_batch',
        entityId: b.id,
        after: { setId: body.setId, ageDays: body.ageDays, specimens: rows.length },
      });
      return { ids: rows.map((r) => r.id), designId: d.id };
    },
  );

  api.readPost(
    '/api/designs/:id/batch-weights/preview',
    {
      summary:
        'Convert the SSD design to wet batch weights from measured moisture (nothing is stored)',
      capability: 'lab.enter',
      body: moistureBody,
    },
    async ({ auth, params, body, db }) => {
      const d = await loadDesign(db, auth, idParam.parse(params).id);
      const c = await convert(db, auth.tenantId, d, body);
      return { result: c.result, validator: c.validator, config: c.config };
    },
  );

  api.readPost(
    '/api/designs/:id/batch-plans/preview',
    {
      summary:
        'Batch preparation (nothing stored): the reference design and the moisture-corrected, rounded weights side by side, with the reconciliation and every blocker named',
      capability: 'lab.enter',
      body: planBody,
    },
    async ({ auth, params, body, db }) => {
      const d = await loadDesign(db, auth, idParam.parse(params).id);
      const p = await prepare(db, auth.tenantId, d, body);
      return {
        design: {
          id: d.id,
          code: d.code,
          version: d.version,
          plantId: d.plantId,
          status: d.status,
        },
        conversion: { result: p.conversion.result, validator: p.conversion.validator },
        plan: p.plan,
        planValidator: p.planValidator,
        binding: p.binding,
      };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/batch-plans',
    {
      summary:
        'Save a batch plan for an approved, in-production or trial design: bound to the exact design version, plant, material test versions, moisture readings, calculation versions and the preparer. Refused unless both independent checks pass and every equipment parameter is on file',
      capability: 'lab.enter',
      params: idParam,
      body: planBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const kind = ['approved', 'in_production'].includes(d.status)
        ? 'production'
        : TRIAL_STATES.includes(d.status)
          ? 'trial'
          : null;
      if (!kind)
        throw new ApiError(
          409,
          'conflict',
          `A batch plan is not available for a ${d.status} design`,
        );
      const p = await prepare(tx, auth.tenantId, d, body);
      if (!p.conversion.result.ok)
        throw new ApiError(409, 'batch_blocked', 'The moisture conversion is blocked', {
          blockers: p.conversion.result.blockers,
        });
      if (p.conversion.validator.status !== 'pass')
        throw new ApiError(409, 'validator_failed', 'The independent conversion check disagrees', {
          mismatches: p.conversion.validator.mismatches,
        });
      if (!p.plan || !p.plan.ok)
        throw new ApiError(409, 'plan_blocked', 'The batch plan is blocked', {
          blockers: p.plan && !p.plan.ok ? p.plan.blockers : [],
        });
      if (p.planValidator?.status !== 'pass')
        throw new ApiError(409, 'plan_validator_failed', 'The independent plan check disagrees', {
          mismatches: p.planValidator?.mismatches ?? [],
        });
      const [row] = await tx
        .insert(schema.batchInstances)
        .values({
          tenantId: auth.tenantId,
          designId: d.id,
          designVersion: d.version,
          plantId: d.plantId,
          kind,
          moisture: p.conversion.moisture,
          config: p.conversion.config,
          result: p.conversion.result,
          validator: p.conversion.validator,
          validatorStatus: 'pass',
          batchSizeM3: String(body.batchSizeM3),
          plan: p.plan,
          planValidator: p.planValidator,
          designVersionHash: p.binding.designVersionHash,
          calcVersion: p.binding.calcVersion,
          materialTestVersions: p.binding.materialTestVersions,
          rounding: p.config,
          createdBy: auth.user.id,
        })
        .returning({ id: schema.batchInstances.id });
      await audit.record({
        action: 'batch_plan.create',
        entityType: 'batch_instance',
        entityId: row!.id,
        after: {
          designId: d.id,
          designVersion: d.version,
          designVersionHash: p.binding.designVersionHash,
          kind,
          batchSizeM3: body.batchSizeM3,
          roundedTotalKg: p.plan.reconciliation.roundedTotalKg,
        },
      });
      return { id: row!.id, kind, designVersionHash: p.binding.designVersionHash };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/batch-instances',
    {
      summary:
        "Save today's batch weights for an approved, in-production or trial design (never a new design version)",
      capability: 'lab.enter',
      params: idParam,
      body: moistureBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const kind = ['approved', 'in_production'].includes(d.status)
        ? 'production'
        : TRIAL_STATES.includes(d.status)
          ? 'trial'
          : null;
      if (!kind)
        throw new ApiError(
          409,
          'conflict',
          `Batch weights are not available for a ${d.status} design`,
        );
      const c = await convert(tx, auth.tenantId, d, body);
      if (!c.result.ok)
        throw new ApiError(409, 'batch_blocked', 'The conversion is blocked', {
          blockers: c.result.blockers,
        });
      if (c.validator.status !== 'pass')
        throw new ApiError(
          409,
          'validator_failed',
          'The independent check disagrees with the conversion',
          {
            mismatches: c.validator.mismatches,
          },
        );
      const [row] = await tx
        .insert(schema.batchInstances)
        .values({
          tenantId: auth.tenantId,
          designId: d.id,
          designVersion: d.version,
          plantId: d.plantId,
          kind,
          moisture: c.moisture,
          config: c.config,
          result: c.result,
          validator: c.validator,
          validatorStatus: 'pass',
          createdBy: auth.user.id,
        })
        .returning({ id: schema.batchInstances.id });
      await audit.record({
        action: 'batch_instance.create',
        entityType: 'batch_instance',
        entityId: row!.id,
        after: { designId: d.id, kind, batchWaterKg: c.result.batchWaterKg },
      });
      return { id: row!.id, kind };
    },
  );

  api.get(
    '/api/designs/:id/batch-instances',
    {
      summary: 'Stored batch instances of a design, newest first',
      capability: 'library.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const d = await loadDesign(db, auth, params.id);
      return db
        .select({
          id: schema.batchInstances.id,
          kind: schema.batchInstances.kind,
          designVersion: schema.batchInstances.designVersion,
          moisture: schema.batchInstances.moisture,
          result: schema.batchInstances.result,
          batchSizeM3: schema.batchInstances.batchSizeM3,
          plan: schema.batchInstances.plan,
          designVersionHash: schema.batchInstances.designVersionHash,
          validatorStatus: schema.batchInstances.validatorStatus,
          createdAt: schema.batchInstances.createdAt,
          actor: schema.users.name,
        })
        .from(schema.batchInstances)
        .leftJoin(schema.users, eq(schema.users.id, schema.batchInstances.createdBy))
        .where(eq(schema.batchInstances.designId, d.id))
        .orderBy(desc(schema.batchInstances.createdAt));
    },
  );

  api.mutateFile(
    '/api/designs/:id/submittal',
    {
      summary:
        'Bilingual PDF submittal (watermarked unless approved or in production; never shows cost). Logged as an export',
      capability: 'library.read',
      params: idParam,
      body: z.strictObject({ lang: z.enum(['ar', 'en', 'both']).default('en') }),
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, idParam.parse(params).id);
      const settings = await loadSettings(tx, auth.tenantId);
      const data = await gatherSubmittal(tx, auth.tenantId, d, settings);
      const base = (
        process.env['APP_BASE_URL'] ??
        process.env['BETTER_AUTH_URL'] ??
        'http://localhost:5173'
      ).replace(/\/$/, '');
      const html = await submittalHtml(data, body.lang, base, new Date());
      const pdf = await renderPdf(html);
      await audit.record({
        action: 'design.submittal',
        entityType: 'mix_design',
        entityId: d.id,
        after: {
          lang: body.lang,
          status: d.status,
          watermarked: !['approved', 'in_production'].includes(d.status),
        },
      });
      return {
        filename: `${d.code}-v${d.version}-${body.lang}.pdf`,
        contentType: 'application/pdf',
        data: pdf,
      };
    },
  );
}
