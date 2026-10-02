import { schema } from '@khalta/db';
import { roleCan } from '@khalta/rbac';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { AuthContext } from '../middleware';
import type { ApiRoutes } from '../route';
import { evaluateAndStore, loadDesign } from '../evaluation/run';
import { buildSnapshot, runEvaluation, stripCost } from '../evaluation/service';

const idParam = z.object({ id: z.uuid() });
const KG = /^\d{1,6}(\.\d{1,3})?$/;
const MAX_BATCH = 200;

const versionBody = z.strictObject({
  note: z.string().trim().min(3).max(500),
  requirements: z
    .strictObject({
      fcMpa: z.number().positive().max(200),
      basis: z.enum(['cylinder', 'cube', 'b_grade']),
      testAgeDays: z.number().int().positive().max(365),
      exposure: z.array(z.string().min(2).max(8)).max(12),
      slumpMm: z.number().positive().max(300),
      nmasMm: z.number().positive().max(100),
      pumpable: z.boolean(),
      s3Option: z.union([z.literal(1), z.literal(2)]),
      airPct: z.number().min(0).max(100),
    })
    .partial()
    .optional(),
  lines: z
    .array(z.strictObject({ materialId: z.uuid(), kgPerM3: z.string().regex(KG) }))
    .min(1)
    .max(40),
});

const batchBody = z.strictObject({
  mode: z.enum(['ACI', 'JS', 'BOTH']).default('BOTH'),
  designIds: z.array(z.uuid()).min(1).max(MAX_BATCH).optional(),
  plantId: z.uuid().optional(),
});

const portfolioQuery = z.object({
  plantId: z.uuid().optional(),
  filter: z
    .enum(['all', 'failing', 'incomplete', 'not_evaluated', 'revalidation', 'inputs_changed'])
    .default('all'),
});

const canCost = (auth: AuthContext) => roleCan(auth.role, 'cost.view', auth.settings);

type Row = Awaited<ReturnType<typeof portfolioRows>>[number];

/** Latest evaluation of every live design the caller may see, with the "inputs changed" comparison. */
async function portfolioRows(
  db: Parameters<typeof loadDesign>[0],
  auth: AuthContext,
  plantId?: string,
) {
  const where = [
    eq(schema.mixDesigns.tenantId, auth.tenantId),
    isNull(schema.mixDesigns.deletedAt),
    notInArray(schema.mixDesigns.status, ['retired', 'superseded']),
  ];
  if (plantId) where.push(eq(schema.mixDesigns.plantId, plantId));
  if (!auth.scope.all) {
    if (auth.scope.plantIds.length === 0) return [];
    where.push(inArray(schema.mixDesigns.plantId, [...auth.scope.plantIds]));
  }
  const rows = await db
    .select({
      id: schema.mixDesigns.id,
      code: schema.mixDesigns.code,
      name: schema.mixDesigns.name,
      version: schema.mixDesigns.version,
      plantId: schema.mixDesigns.plantId,
      status: schema.mixDesigns.status,
      approvalSource: schema.mixDesigns.approvalSource,
      needsRevalidation: schema.mixDesigns.needsRevalidation,
      avgMonthlyVolumeM3: schema.mixDesigns.avgMonthlyVolumeM3,
      synthetic: schema.mixDesigns.synthetic,
      evaluationId: schema.designEvaluations.id,
      evaluatedAt: schema.designEvaluations.createdAt,
      mode: schema.designEvaluations.mode,
      verdict: schema.designEvaluations.verdict,
      validatorStatus: schema.designEvaluations.validatorStatus,
      provisional: schema.designEvaluations.provisional,
      minimumDataOk: schema.designEvaluations.minimumDataOk,
      costJodPerM3: schema.designEvaluations.costJodPerM3,
      summary: schema.designEvaluations.summary,
      testVersions: schema.designEvaluations.testVersions,
      ruleVersions: schema.designEvaluations.ruleVersions,
    })
    .from(schema.mixDesigns)
    .leftJoin(
      schema.designEvaluations,
      eq(schema.designEvaluations.id, schema.mixDesigns.lastEvaluationId),
    )
    .where(and(...where))
    .orderBy(asc(schema.mixDesigns.code), desc(schema.mixDesigns.version));

  const tests = await db
    .select({ materialId: schema.materialTests.materialId, version: schema.materialTests.version })
    .from(schema.materialTests)
    .where(
      and(
        eq(schema.materialTests.tenantId, auth.tenantId),
        eq(schema.materialTests.isCurrent, true),
      ),
    );
  const currentTest = new Map(tests.map((t) => [t.materialId, t.version]));
  const rules = await db
    .select({ id: schema.rules.id, version: schema.rules.version })
    .from(schema.rules)
    .where(and(eq(schema.rules.tenantId, auth.tenantId), eq(schema.rules.isCurrent, true)));
  const currentRule = new Map(rules.map((r) => [r.id, r.version]));

  return rows.map((r) => {
    const tv = (r.testVersions ?? {}) as Record<string, number>;
    const changedTests = Object.entries(tv).filter(([id, v]) => currentTest.get(id) !== v).length;
    const rv = (r.ruleVersions ?? []) as { id: string; version: number }[];
    const changedRules = rv.filter((x) => currentRule.get(x.id) !== x.version).length;
    return { ...r, inputsChanged: r.evaluationId ? changedTests + changedRules > 0 : false };
  });
}

const summaryOf = (r: Row) =>
  (r.summary ?? {}) as {
    failing?: number;
    unevaluated?: number;
    blockers?: number;
    evidence?: string[];
    quality?: { code: string; severity: string; materialId: string | null }[];
  };

function shape(auth: AuthContext, r: Row) {
  const s = summaryOf(r);
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    version: r.version,
    plantId: r.plantId,
    status: r.status,
    approvalSource: r.approvalSource,
    needsRevalidation: r.needsRevalidation,
    synthetic: r.synthetic,
    avgMonthlyVolumeM3: r.avgMonthlyVolumeM3,
    evaluated: !!r.evaluationId,
    evaluationId: r.evaluationId,
    evaluatedAt: r.evaluatedAt,
    mode: r.mode,
    verdict: r.verdict,
    validatorStatus: r.validatorStatus,
    provisional: r.provisional,
    minimumDataOk: r.minimumDataOk,
    failing: s.failing ?? 0,
    unevaluated: s.unevaluated ?? 0,
    blockers: s.blockers ?? 0,
    evidence: s.evidence ?? [],
    inputsChanged: r.inputsChanged,
    costJodPerM3: canCost(auth) ? r.costJodPerM3 : null,
  };
}

function matches(filter: z.infer<typeof portfolioQuery>['filter'], r: Row) {
  switch (filter) {
    case 'failing':
      return r.verdict === 'fail';
    case 'incomplete':
      return r.verdict === 'incomplete';
    case 'not_evaluated':
      return !r.evaluationId;
    case 'revalidation':
      return r.needsRevalidation;
    case 'inputs_changed':
      return r.inputsChanged;
    default:
      return true;
  }
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // spreadsheet formula injection: a leading = + - @ is made inert
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function portfolioRoutes(api: ApiRoutes) {
  api.mutate(
    'post',
    '/api/designs/:id/versions',
    {
      summary:
        'Create the next version of a design as a draft from edited proportions (the source version is never changed)',
      capability: 'design.write',
      params: idParam,
      body: versionBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const src = await loadDesign(tx, auth, params.id, true);
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
      if (body.lines.some((l) => Number(l.kgPerM3) <= 0))
        throw new ApiError(400, 'invalid_request', 'Quantities must be positive');

      const [maxRow] = await tx
        .select({ max: sql<number>`coalesce(max(${schema.mixDesigns.version}), 0)` })
        .from(schema.mixDesigns)
        .where(
          and(eq(schema.mixDesigns.tenantId, auth.tenantId), eq(schema.mixDesigns.code, src.code)),
        );
      const requirements = { ...(src.requirements as object), ...(body.requirements ?? {}) };
      const [created] = await tx
        .insert(schema.mixDesigns)
        .values({
          tenantId: auth.tenantId,
          code: src.code,
          name: src.name,
          plantId: src.plantId,
          version: Number(maxRow?.max ?? 0) + 1,
          status: 'draft',
          requirements,
          inputsSnapshot: { derivedFrom: src.id, derivedVersion: src.version, note: body.note },
          avgMonthlyVolumeM3: src.avgMonthlyVolumeM3,
          evaluationPending: true,
          synthetic: src.synthetic,
          parentDesignId: src.id,
          createdBy: auth.user.id,
        })
        .returning();
      const nameBy = new Map(mats.map((m) => [m.id, m.nameEn]));
      await tx.insert(schema.mixDesignLines).values(
        body.lines.map((l, i) => ({
          tenantId: auth.tenantId,
          designId: created!.id,
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
        designId: created!.id,
        fromStatus: 'none',
        toStatus: 'draft',
        actorId: auth.user.id,
        evidence: {
          kind: 'new_version',
          parentDesignId: src.id,
          parentVersion: src.version,
          note: body.note,
        },
      });
      await audit.record({
        action: 'design.version',
        entityType: 'mix_design',
        entityId: created!.id,
        before: { parent: src.id, version: src.version, status: src.status },
        after: { version: created!.version, status: 'draft', note: body.note },
      });
      return { id: created!.id, code: created!.code, version: created!.version, status: 'draft' };
    },
  );

  api.readPost(
    '/api/designs/:id/preview',
    {
      summary:
        'Evaluate an unsaved edit (proportions and requirements) and run the validator on it; nothing is stored',
      capability: 'design.write',
      body: versionBody
        .omit({ note: true })
        .extend({ mode: z.enum(['ACI', 'JS', 'BOTH']).default('BOTH') }),
    },
    async ({ auth, params, body, db }) => {
      const src = await loadDesign(db, auth, idParam.parse(params).id);
      const ids = body.lines.map((l) => l.materialId);
      if (new Set(ids).size !== ids.length)
        throw new ApiError(400, 'invalid_request', 'A material appears twice in the lines');
      const snapshot = await buildSnapshot(
        db,
        auth.tenantId,
        { ...src, requirements: { ...(src.requirements as object), ...(body.requirements ?? {}) } },
        {
          mode: body.mode,
          linesOverride: body.lines.map((l) => ({ materialId: l.materialId, quantity: l.kgPerM3 })),
        },
      );
      const { report, validator } = runEvaluation(snapshot);
      return {
        report: roleCan(auth.role, 'cost.view', auth.settings) ? report : stripCost(report),
        validator,
      };
    },
  );

  api.get(
    '/api/designs/:id/versions',
    {
      summary: 'All versions of a design code, newest first',
      capability: 'library.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const d = await loadDesign(db, auth, params.id);
      return db
        .select({
          id: schema.mixDesigns.id,
          version: schema.mixDesigns.version,
          status: schema.mixDesigns.status,
          parentDesignId: schema.mixDesigns.parentDesignId,
          lastVerdict: schema.mixDesigns.lastVerdict,
          needsRevalidation: schema.mixDesigns.needsRevalidation,
          createdAt: schema.mixDesigns.createdAt,
        })
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            eq(schema.mixDesigns.code, d.code),
            eq(schema.mixDesigns.plantId, d.plantId),
            isNull(schema.mixDesigns.deletedAt),
          ),
        )
        .orderBy(desc(schema.mixDesigns.version));
    },
  );

  api.get(
    '/api/designs/:id/diff/:otherId',
    {
      summary: 'Line-by-line difference between two versions of a design',
      capability: 'library.read',
      params: z.object({ id: z.uuid(), otherId: z.uuid() }),
    },
    async ({ auth, params, db }) => {
      const [a, b] = [
        await loadDesign(db, auth, params.id),
        await loadDesign(db, auth, params.otherId),
      ];
      if (a.code !== b.code || a.plantId !== b.plantId)
        throw new ApiError(
          400,
          'invalid_request',
          'Only versions of the same design can be compared',
        );
      const lines = async (id: string) =>
        db
          .select({
            materialId: schema.mixDesignLines.materialId,
            nameEn: schema.materials.marketNameEn,
            nameAr: schema.materials.marketNameAr,
            kg: schema.mixDesignLines.quantityKgM3,
          })
          .from(schema.mixDesignLines)
          .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
          .where(eq(schema.mixDesignLines.designId, id));
      const [la, lb] = [await lines(a.id), await lines(b.id)];
      const ids = [...new Set([...la, ...lb].map((l) => l.materialId))];
      const rows = ids.map((id) => {
        const x = la.find((l) => l.materialId === id);
        const y = lb.find((l) => l.materialId === id);
        return {
          materialId: id,
          nameEn: (x ?? y)!.nameEn,
          nameAr: (x ?? y)!.nameAr,
          from: x?.kg ?? null,
          to: y?.kg ?? null,
          change: !x
            ? 'added'
            : !y
              ? 'removed'
              : Number(x.kg) === Number(y.kg)
                ? 'same'
                : 'changed',
        };
      });
      const ra = a.requirements as Record<string, unknown>;
      const rb = b.requirements as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
      return {
        from: { id: a.id, version: a.version },
        to: { id: b.id, version: b.version },
        lines: rows,
        requirements: keys
          .filter((k) => JSON.stringify(ra[k]) !== JSON.stringify(rb[k]))
          .map((k) => ({ key: k, from: ra[k] ?? null, to: rb[k] ?? null })),
      };
    },
  );

  api.mutate(
    'post',
    '/api/designs/evaluate-batch',
    {
      summary: `Evaluate up to ${MAX_BATCH} designs in one audited batch (one audit entry per design)`,
      capability: 'design.write',
      body: batchBody,
    },
    async ({ auth, body, tx, audit }) => {
      const where = [
        eq(schema.mixDesigns.tenantId, auth.tenantId),
        isNull(schema.mixDesigns.deletedAt),
        notInArray(schema.mixDesigns.status, ['retired', 'superseded']),
      ];
      if (body.designIds) where.push(inArray(schema.mixDesigns.id, body.designIds));
      if (body.plantId) where.push(eq(schema.mixDesigns.plantId, body.plantId));
      if (!auth.scope.all) {
        if (auth.scope.plantIds.length === 0) return { evaluated: 0, results: [] };
        where.push(inArray(schema.mixDesigns.plantId, [...auth.scope.plantIds]));
      }
      const designs = await tx
        .select()
        .from(schema.mixDesigns)
        .where(and(...where))
        .orderBy(asc(schema.mixDesigns.code), asc(schema.mixDesigns.version))
        .for('update');
      if (designs.length > MAX_BATCH)
        throw new ApiError(400, 'invalid_request', `A batch is limited to ${MAX_BATCH} designs`);
      const results: {
        id: string;
        code: string;
        version: number;
        verdict: string;
        validator: string;
        status: string;
        error?: string;
      }[] = [];
      for (const d of designs) {
        try {
          const r = await evaluateAndStore(tx, auth, audit, d, { mode: body.mode });
          results.push({
            id: d.id,
            code: d.code,
            version: d.version,
            verdict: r.report.verdict,
            validator: r.validator.status,
            status: r.status,
          });
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          results.push({
            id: d.id,
            code: d.code,
            version: d.version,
            verdict: 'error',
            validator: 'n/a',
            status: d.status,
            error: e.message,
          });
        }
      }
      return { evaluated: results.filter((r) => !r.error).length, results };
    },
  );

  api.get(
    '/api/portfolio',
    {
      summary: 'Every live design with its latest evaluation (cost only for cost.view)',
      capability: 'library.read',
      query: portfolioQuery,
    },
    async ({ auth, query, db }) => {
      const rows = await portfolioRows(db, auth, query.plantId);
      const out = rows.filter((r) => matches(query.filter, r)).map((r) => shape(auth, r));
      return {
        rows: out,
        counts: {
          total: rows.length,
          failing: rows.filter((r) => r.verdict === 'fail').length,
          incomplete: rows.filter((r) => r.verdict === 'incomplete').length,
          notEvaluated: rows.filter((r) => !r.evaluationId).length,
          revalidation: rows.filter((r) => r.needsRevalidation).length,
          inputsChanged: rows.filter((r) => r.inputsChanged).length,
        },
      };
    },
  );

  api.get(
    '/api/data-quality',
    {
      summary:
        'Every material, test, price and rule gap behind the latest evaluations, grouped by cause',
      capability: 'library.read',
      query: z.object({ plantId: z.uuid().optional() }),
    },
    async ({ auth, query, db }) => {
      const rows = await portfolioRows(db, auth, query.plantId);
      const groups = new Map<
        string,
        {
          code: string;
          severity: string;
          materialId: string | null;
          designs: { id: string; code: string }[];
        }
      >();
      for (const r of rows)
        for (const q of summaryOf(r).quality ?? []) {
          if (q.code.startsWith('price_') && !canCost(auth)) continue;
          const key = `${q.code}|${q.materialId ?? ''}`;
          const g = groups.get(key) ?? {
            code: q.code,
            severity: q.severity,
            materialId: q.materialId,
            designs: [],
          };
          if (!g.designs.some((d) => d.id === r.id)) g.designs.push({ id: r.id, code: r.code });
          groups.set(key, g);
        }
      const ids = [
        ...new Set([...groups.values()].flatMap((g) => (g.materialId ? [g.materialId] : []))),
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
      const nameBy = new Map(names.map((n) => [n.id, n]));
      return {
        notEvaluated: rows.filter((r) => !r.evaluationId).length,
        groups: [...groups.values()]
          .map((g) => ({
            ...g,
            materialNameEn: g.materialId ? (nameBy.get(g.materialId)?.nameEn ?? null) : null,
            materialNameAr: g.materialId ? (nameBy.get(g.materialId)?.nameAr ?? null) : null,
          }))
          .sort(
            (a, b) =>
              (a.severity === 'blocker' ? 0 : 1) - (b.severity === 'blocker' ? 0 : 1) ||
              b.designs.length - a.designs.length ||
              a.code.localeCompare(b.code),
          ),
      };
    },
  );

  api.mutateFile(
    '/api/portfolio/export',
    {
      summary: 'Download the portfolio table as CSV (logged)',
      capability: 'export.priceCost',
      body: z.strictObject({ plantId: z.uuid().optional(), filter: portfolioQuery.shape.filter }),
    },
    async ({ auth, body, tx, audit }) => {
      const rows = (await portfolioRows(tx, auth, body.plantId))
        .filter((r) => matches(body.filter, r))
        .map((r) => shape(auth, r));
      const head = [
        'code',
        'version',
        'status',
        'verdict',
        'validator',
        'provisional',
        'failing_checks',
        'unevaluated_checks',
        'blockers',
        'cost_jod_per_m3',
        'monthly_volume_m3',
        'inputs_changed',
        'needs_revalidation',
      ];
      const lines = [
        head.join(','),
        ...rows.map((r) =>
          [
            r.code,
            r.version,
            r.status,
            r.verdict ?? 'not_evaluated',
            r.validatorStatus ?? '',
            r.provisional ?? '',
            r.failing,
            r.unevaluated,
            r.blockers,
            r.costJodPerM3 ?? '',
            r.avgMonthlyVolumeM3 ?? '',
            r.inputsChanged,
            r.needsRevalidation,
          ]
            .map(csvCell)
            .join(','),
        ),
      ];
      await audit.record({
        action: 'portfolio.export',
        entityType: 'portfolio',
        entityId: 'portfolio',
        after: { rows: rows.length, filter: body.filter },
      });
      return {
        filename: 'khalta-portfolio.csv',
        contentType: 'text/csv; charset=utf-8',
        data: Buffer.from(`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`, 'utf8'),
      };
    },
  );
}
