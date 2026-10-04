// Strength models and proposals (F-028). Fitting is a proposal; approving or retiring a model is a QC manager's
// e-signed decision; the s refit and the β calibration are read-only proposals (a person edits the Rules screen).
import { schema } from '@khalta/db';
import {
  betaProposal,
  combinedP75,
  sRefit,
  todayAmman,
  type BetaRow,
  type StrengthGroup,
} from '@khalta/engine';
import { canAccessPlant } from '@khalta/rbac';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import type { ApiRoutes } from '../route';
import { loadSettings } from '../settings';
import { fitGroup, groupsAt, modelHash, unassigned } from '../strength/service';
import { testsOf } from '../strength/intel';

const idParam = z.object({ id: z.uuid() });
const plantQuery = z.object({ plantId: z.uuid().optional() });
const reasonBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });

type Row = typeof schema.strengthModels.$inferSelect;
const shape = (r: Row) => ({
  id: r.id,
  plantId: r.plantId,
  groupKey: r.groupKey,
  group: r.grp,
  ageDays: r.ageDays,
  basis: r.basis,
  a: r.a,
  b: r.b,
  seA: r.seA,
  seB: r.seB,
  n: r.n,
  levels: r.levels,
  wcmMin: r.wcmMin,
  wcmMax: r.wcmMax,
  sMpa: r.sMpa,
  r2: r.r2,
  heldOut: r.heldOut,
  chronological: r.chronological,
  validationReport: r.validationReport,
  fitVersion: r.fitVersion,
  reasons: r.reasons,
  status: r.status,
  fittedAt: r.fittedAt,
  approvedAt: r.approvedAt,
  approvedBy: r.approvedBy,
  retiredAt: r.retiredAt,
  retiredReason: r.retiredReason,
  inForce: r.approvedAt !== null && r.retiredAt === null && r.status === 'valid',
});

export function strengthRoutes(api: ApiRoutes) {
  api.get(
    '/api/strength-models',
    {
      summary:
        'Strength models of the plants you can see: the latest fit per group, the one in force, and results left unassigned',
      capability: 'library.read',
      query: plantQuery,
    },
    async ({ auth, query, db }) => {
      const rows = await db
        .select()
        .from(schema.strengthModels)
        .where(eq(schema.strengthModels.tenantId, auth.tenantId))
        .orderBy(desc(schema.strengthModels.fittedAt));
      const visible = rows.filter(
        (r) =>
          canAccessPlant(auth.scope, r.plantId) && (!query.plantId || r.plantId === query.plantId),
      );
      const seen = new Set<string>();
      const latest = visible.filter((r) => {
        if (seen.has(r.groupKey) && !(r.approvedAt !== null && r.retiredAt === null)) return false;
        seen.add(r.groupKey);
        return true;
      });
      const plants = [...new Set(visible.map((r) => r.plantId))];
      const un = [];
      for (const p of query.plantId ? [query.plantId] : plants)
        if (canAccessPlant(auth.scope, p))
          un.push(...(await unassigned(db, auth.tenantId, p)).map((u) => ({ ...u, plantId: p })));
      const ids = [
        ...new Set(
          latest.flatMap((m) => {
            const g = m.grp as StrengthGroup;
            return [g.cementId, ...g.scm.map((x) => x.id), ...g.admixtures.map((x) => x.id)];
          }),
        ),
      ];
      const names = ids.length
        ? await db
            .select({
              id: schema.materials.id,
              nameEn: schema.materials.marketNameEn,
              nameAr: schema.materials.marketNameAr,
            })
            .from(schema.materials)
            .where(inArray(schema.materials.id, ids))
        : [];
      return {
        models: latest.map(shape),
        unassigned: un,
        materials: Object.fromEntries(
          names.map((n) => [n.id, { nameEn: n.nameEn, nameAr: n.nameAr }]),
        ),
      };
    },
  );

  api.get(
    '/api/strength-models/:id',
    { summary: 'One model with the results it used', capability: 'library.read', params: idParam },
    async ({ auth, params, db }) => {
      const [m] = await db
        .select()
        .from(schema.strengthModels)
        .where(
          and(
            eq(schema.strengthModels.id, params.id),
            eq(schema.strengthModels.tenantId, auth.tenantId),
          ),
        );
      if (!m || !canAccessPlant(auth.scope, m.plantId)) throw notFound('Strength model not found');
      const points = await db
        .select()
        .from(schema.strengthModelPoints)
        .where(eq(schema.strengthModelPoints.modelId, m.id));
      return { model: shape(m), points };
    },
  );

  api.mutate(
    'post',
    '/api/strength-models/refit',
    {
      summary: 'Refit every group with results (a proposal; nothing is approved or applied)',
      capability: 'design.write',
      body: z.strictObject({ plantId: z.uuid().optional() }),
    },
    async ({ auth, body, tx, audit }) => {
      if (body.plantId && !canAccessPlant(auth.scope, body.plantId))
        throw notFound('Plant not found');
      const settings = await loadSettings(tx, auth.tenantId);
      const today = todayAmman();
      const out: {
        groupKey: string;
        result: string;
        modelId?: string;
        n?: number;
        status?: string;
      }[] = [];
      for (const g of await groupsAt(tx, auth.tenantId, body.plantId)) {
        if (!canAccessPlant(auth.scope, g.plantId)) continue;
        const r = await fitGroup(tx, auth.tenantId, g, settings, auth.user.id, today);
        out.push(
          r.kind === 'fitted'
            ? {
                groupKey: r.model.groupKey,
                result: r.created ? 'fitted' : 'unchanged',
                modelId: r.model.id,
                status: r.model.status,
                n: r.model.n,
              }
            : { groupKey: `${g.plantId}/${g.cementId}`, result: 'insufficient', n: r.n },
        );
      }
      await audit.record({
        action: 'strength_model.refit',
        entityType: 'strength_model',
        entityId: body.plantId ?? 'all',
        after: { groups: out.length, created: out.filter((o) => o.result === 'fitted').length },
      });
      return { groups: out };
    },
  );

  const signature = async (
    tx: Parameters<Parameters<ApiRoutes['mutate']>[3]>[0]['tx'],
    auth: Parameters<Parameters<ApiRoutes['mutate']>[3]>[0]['auth'],
    m: Row,
    meaning: string,
    reason: string,
  ) => {
    const [u] = await tx
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, auth.user.id));
    return {
      signerId: auth.user.id,
      signerName: u?.name ?? auth.user.id,
      role: auth.role,
      meaning,
      reason,
      modelHash: modelHash(m),
      at: new Date().toISOString(),
    };
  };

  api.mutate(
    'post',
    '/api/strength-models/:id/approve',
    {
      summary:
        'Approve the latest valid fit of a group for use by the evaluator and optimizer (QC manager, e-signed; replaces the one in force)',
      capability: 'design.approve',
      params: idParam,
      body: reasonBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const [m] = await tx
        .select()
        .from(schema.strengthModels)
        .where(
          and(
            eq(schema.strengthModels.id, params.id),
            eq(schema.strengthModels.tenantId, auth.tenantId),
          ),
        )
        .for('update');
      if (!m || !canAccessPlant(auth.scope, m.plantId)) throw notFound('Strength model not found');
      if (m.status !== 'valid')
        throw new ApiError(
          409,
          'model_not_valid',
          `Only a valid model can be approved (this one is ${m.status})`,
          {
            reasons: m.reasons,
          },
        );
      if (m.approvedAt) throw new ApiError(409, 'conflict', 'This model is already approved');
      if (m.retiredAt) throw new ApiError(409, 'conflict', 'This model was retired');
      const [newest] = await tx
        .select({ id: schema.strengthModels.id })
        .from(schema.strengthModels)
        .where(
          and(
            eq(schema.strengthModels.tenantId, auth.tenantId),
            eq(schema.strengthModels.groupKey, m.groupKey),
          ),
        )
        .orderBy(desc(schema.strengthModels.fittedAt))
        .limit(1);
      if (newest && newest.id !== m.id)
        throw new ApiError(
          409,
          'stale_model',
          'A newer fit exists for this group; approve that one',
        );
      const sig = await signature(tx, auth, m, 'strength_model_approved', body.reason);
      const old = await tx
        .select()
        .from(schema.strengthModels)
        .where(
          and(
            eq(schema.strengthModels.tenantId, auth.tenantId),
            eq(schema.strengthModels.groupKey, m.groupKey),
            isNotNull(schema.strengthModels.approvedAt),
            isNull(schema.strengthModels.retiredAt),
          ),
        );
      for (const o of old) {
        await tx
          .update(schema.strengthModels)
          .set({
            retiredAt: new Date(),
            retiredBy: auth.user.id,
            retiredReason: `replaced by ${m.id}`,
          })
          .where(eq(schema.strengthModels.id, o.id));
        await audit.record({
          action: 'strength_model.retire',
          entityType: 'strength_model',
          entityId: o.id,
          after: { replacedBy: m.id },
        });
      }
      await tx
        .update(schema.strengthModels)
        .set({ approvedAt: new Date(), approvedBy: auth.user.id, approvalSignature: sig })
        .where(eq(schema.strengthModels.id, m.id));
      await audit.record({
        action: 'strength_model.approve',
        entityType: 'strength_model',
        entityId: m.id,
        after: { groupKey: m.groupKey, reason: body.reason },
      });
      return { id: m.id, status: 'approved' };
    },
  );

  api.mutate(
    'post',
    '/api/strength-models/:id/retire',
    {
      summary: 'Retire a model in force (QC manager, with a reason): the baseline governs again',
      capability: 'design.approve',
      params: idParam,
      body: reasonBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const [m] = await tx
        .select()
        .from(schema.strengthModels)
        .where(
          and(
            eq(schema.strengthModels.id, params.id),
            eq(schema.strengthModels.tenantId, auth.tenantId),
          ),
        )
        .for('update');
      if (!m || !canAccessPlant(auth.scope, m.plantId)) throw notFound('Strength model not found');
      if (!m.approvedAt || m.retiredAt)
        throw new ApiError(409, 'conflict', 'This model is not in force');
      await tx
        .update(schema.strengthModels)
        .set({ retiredAt: new Date(), retiredBy: auth.user.id, retiredReason: body.reason })
        .where(eq(schema.strengthModels.id, m.id));
      await audit.record({
        action: 'strength_model.retire',
        entityType: 'strength_model',
        entityId: m.id,
        after: { reason: body.reason },
      });
      return { id: m.id, status: 'retired' };
    },
  );

  api.get(
    '/api/strength/s-proposal',
    {
      summary:
        'Proposed standard deviation per live design from its recorded tests (a proposal: apply it by hand on the Rules screen)',
      capability: 'library.read',
      query: plantQuery,
    },
    async ({ auth, query, db }) => {
      const designs = await db
        .select()
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            inArray(schema.mixDesigns.status, ['approved', 'in_production', 'superseded']),
          ),
        );
      const models = await db
        .select()
        .from(schema.strengthModels)
        .where(
          and(
            eq(schema.strengthModels.tenantId, auth.tenantId),
            isNotNull(schema.strengthModels.approvedAt),
            isNull(schema.strengthModels.retiredAt),
          ),
        );
      const out = [];
      for (const d of designs) {
        if (
          !canAccessPlant(auth.scope, d.plantId) ||
          (query.plantId && d.plantId !== query.plantId)
        )
          continue;
        const age = (d.requirements as { testAgeDays?: number | null }).testAgeDays;
        if (!age) continue;
        const t = await testsOf(db, d, age);
        if (t.length < 2) continue;
        const model = models.find((m) => m.plantId === d.plantId && m.ageDays === age);
        out.push({
          designId: d.id,
          code: d.code,
          version: d.version,
          plantId: d.plantId,
          ...sRefit(
            t.map((x) => x.mpa),
            model ? Number(model.sMpa) : null,
          ),
          note: 'proposal only; a lower s needs the code’s sample conditions and a QC manager’s edit on the Rules screen',
        });
      }
      return { proposals: out };
    },
  );

  api.get(
    '/api/strength/beta-proposal',
    {
      summary:
        'Proposed β_FM and β_75 from logged trial batches (a proposal: enter a value on the Rules screen if you accept it)',
      capability: 'library.read',
      query: z.object({ plantId: z.uuid() }),
    },
    async ({ auth, query, db }) => {
      if (!canAccessPlant(auth.scope, query.plantId)) throw notFound('Plant not found');
      const settings = await loadSettings(db, auth.tenantId);
      const batches = await db
        .select({ b: schema.trialBatches, d: schema.mixDesigns })
        .from(schema.trialBatches)
        .innerJoin(schema.mixDesigns, eq(schema.mixDesigns.id, schema.trialBatches.designId))
        .where(
          and(
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            eq(schema.mixDesigns.plantId, query.plantId),
          ),
        );
      const rows: BetaRow[] = [];
      const skipped: { batchId: string; reason: string }[] = [];
      for (const { b, d } of batches) {
        if (b.slumpMm === null || !d.lastEvaluationId) {
          skipped.push({
            batchId: b.id,
            reason: b.slumpMm === null ? 'no_slump' : 'no_evaluation',
          });
          continue;
        }
        const [e] = await db
          .select({ report: schema.designEvaluations.report })
          .from(schema.designEvaluations)
          .where(eq(schema.designEvaluations.id, d.lastEvaluationId));
        const trace =
          (e?.report as { trace?: { key: string; value: unknown }[] } | undefined)?.trace ?? [];
        const at = (k: string) => {
          const v = trace.find((t) => t.key === k)?.value;
          return typeof v === 'number' ? v : null;
        };
        const water = at('mass.water');
        const fm = at('agg.fm_combined');
        const lines = await db
          .select({ id: schema.mixDesignLines.materialId, kg: schema.mixDesignLines.quantityKgM3 })
          .from(schema.mixDesignLines)
          .where(eq(schema.mixDesignLines.designId, d.id));
        const mats = await db
          .select({ id: schema.materials.id, category: schema.materials.category })
          .from(schema.materials)
          .where(
            inArray(
              schema.materials.id,
              lines.map((l) => l.id),
            ),
          );
        const aggs = mats.filter((m) => m.category === 'fine_agg' || m.category === 'coarse_agg');
        const tests = aggs.length
          ? await db
              .select({
                materialId: schema.materialTests.materialId,
                properties: schema.materialTests.properties,
              })
              .from(schema.materialTests)
              .where(
                and(
                  inArray(
                    schema.materialTests.materialId,
                    aggs.map((m) => m.id),
                  ),
                  eq(schema.materialTests.isCurrent, true),
                ),
              )
          : [];
        const p75 = combinedP75(
          aggs.map((m) => ({
            kg: Number(lines.find((l) => l.id === m.id)!.kg),
            sieve: (
              tests.find((t) => t.materialId === m.id)?.properties as
                { sieve_analysis?: { sieve_mm: number; passing_pct: number }[] } | undefined
            )?.sieve_analysis,
          })),
        );
        if (water === null || fm === null || p75 === null) {
          skipped.push({
            batchId: b.id,
            reason: water === null || fm === null ? 'no_evaluation' : 'no_75um_data',
          });
          continue;
        }
        rows.push({
          id: b.id,
          waterKgM3: water + Number(b.waterAddedKgM3 ?? 0),
          slumpMm: Number(b.slumpMm),
          fm,
          p75,
        });
      }
      return {
        proposal: betaProposal(rows, settings.strengthBetaMinBatches),
        skipped,
        note: 'proposal only: Khalta never writes eng.water.beta_fm or eng.water.beta_75',
      };
    },
  );
}
