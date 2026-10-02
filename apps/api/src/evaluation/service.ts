// Builds the immutable evaluation snapshot for a stored design, runs the evaluator and the independent
// validator on it, and shapes what each role may see. The evaluator and validator are pure; everything
// that touches the database lives here.
import { schema, type Executor } from '@khalta/db';
import {
  freshness,
  priceAt,
  priceStaleness,
  todayAmman,
  type EvaluationReport,
  type EvaluationSnapshot,
  type PriceRow,
  type SnapshotMaterial,
  type SnapshotPrice,
  type SnapshotTest,
  type Properties,
} from '@khalta/engine';
import { evaluate, selectRules } from '@khalta/engine/evaluate';
import type { Mode, ProjectOverride, RuleRecord } from '@khalta/rules';
import { validateEvaluation } from '@khalta/validator';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { loadMaterialParams } from '../materials/service';
import { loadCurrentRecords } from '../rules/service';
import { loadSettings } from '../settings';
import { toPriceRow } from '../prices/service';

export type DesignRow = typeof schema.mixDesigns.$inferSelect;

export interface BuildOptions {
  mode: Mode;
  /** `YYYY-MM-DD`: the day prices and freshness are judged on (default today, Asia/Amman). */
  evaluationDate?: string;
  priceSnapshotId?: string | null;
  s3Option?: 1 | 2 | null;
  airPct?: number | null;
  projectOverrides?: ProjectOverride[];
  tablePolicy?: Record<string, 'ACI' | 'JS'>;
  /** Preview of an unsaved edit: use these lines instead of the stored ones. */
  linesOverride?: { materialId: string; quantity: string }[];
  now?: Date;
}

interface RequirementsJson {
  fcMpa?: number | null;
  basis?: 'cylinder' | 'cube' | 'b_grade' | null;
  testAgeDays?: number | null;
  exposure?: string[];
  slumpMm?: number | null;
  nmasMm?: number | null;
  pumpable?: boolean | null;
  s3Option?: 1 | 2 | null;
  airPct?: number | null;
}

/** Notes and groups are display text; the snapshot keeps only what reproduces the result. */
const slimRule = (r: RuleRecord): RuleRecord => {
  const { note_en: _en, note_ar: _ar, group: _g, ...rest } = r;
  return { ...rest, prerequisites: [] };
};

/** The materials (current test + price at the plant and date) a snapshot carries. Shared with the optimizer. */
export async function loadSnapshotMaterials(
  db: Executor,
  tenantId: string,
  plantId: string,
  materialIds: string[],
  date: string,
  opts: Pick<BuildOptions, 'priceSnapshotId' | 'now'>,
  now: Date,
): Promise<SnapshotMaterial[]> {
  const settings = await loadSettings(db, tenantId);
  const params = await loadMaterialParams(db, tenantId);
  const mats = materialIds.length
    ? await db
        .select()
        .from(schema.materials)
        .where(
          and(eq(schema.materials.tenantId, tenantId), inArray(schema.materials.id, materialIds)),
        )
    : [];
  const tests = materialIds.length
    ? await db
        .select()
        .from(schema.materialTests)
        .where(
          and(
            eq(schema.materialTests.tenantId, tenantId),
            inArray(schema.materialTests.materialId, materialIds),
            eq(schema.materialTests.isCurrent, true),
          ),
        )
    : [];
  const testBy = new Map(tests.map((t) => [t.materialId, t]));

  const prices = await loadPrices(
    db,
    tenantId,
    plantId,
    materialIds,
    date,
    opts as BuildOptions,
    settings.stalePriceDays,
  );

  const snapshotMaterials: SnapshotMaterial[] = materialIds.map((id) => {
    const m = mats.find((x) => x.id === id);
    const t = testBy.get(id);
    const category = (m?.category ?? 'cement') as SnapshotMaterial['category'];
    let test: SnapshotTest | null = null;
    if (t) {
      const f = freshness(t.testedAt, now, params.testAgeLimitDays[category]);
      test = {
        id: t.id,
        version: t.version,
        source: t.source,
        fieldSources: t.fieldSources as SnapshotTest['fieldSources'],
        testedAt: t.testedAt,
        validUntil: t.validUntil ?? null,
        freshness: f.status,
        properties: t.properties as Properties,
      };
    }
    return {
      id,
      category,
      nameEn: m?.marketNameEn ?? id,
      nameAr: m?.marketNameAr ?? null,
      test,
      price: prices.get(id) ?? { status: 'unavailable' },
    };
  });

  return snapshotMaterials;
}

export async function buildSnapshot(
  db: Executor,
  tenantId: string,
  design: DesignRow,
  opts: BuildOptions,
): Promise<EvaluationSnapshot> {
  const now = opts.now ?? new Date();
  const date = opts.evaluationDate ?? todayAmman(now);
  const settings = await loadSettings(db, tenantId);
  const req = design.requirements as RequirementsJson;

  const request: EvaluationSnapshot['request'] = {
    fcMpa: req.fcMpa ?? null,
    basis: req.basis ?? null,
    testAgeDays: req.testAgeDays ?? null,
    exposure: req.exposure ?? [],
    s3Option: opts.s3Option ?? req.s3Option ?? null,
    slumpMm: req.slumpMm ?? null,
    nmasMm: req.nmasMm ?? null,
    pumpable: req.pumpable ?? null,
    airPct: opts.airPct ?? req.airPct ?? null,
  };

  const lines = opts.linesOverride
    ? opts.linesOverride.map((l, i) => ({ ...l, sourceLine: i + 1 }))
    : await db
        .select({
          materialId: schema.mixDesignLines.materialId,
          quantity: schema.mixDesignLines.quantityKgM3,
          sourceLine: schema.mixDesignLines.sourceLine,
        })
        .from(schema.mixDesignLines)
        .where(eq(schema.mixDesignLines.designId, design.id))
        .orderBy(schema.mixDesignLines.sourceLine, schema.mixDesignLines.id);
  const materialIds = [...new Set(lines.map((l) => l.materialId))];

  const snapshotMaterials = await loadSnapshotMaterials(
    db,
    tenantId,
    design.plantId,
    materialIds,
    date,
    opts,
    now,
  );

  const all = await loadCurrentRecords(db, tenantId);
  const rules = selectRules(all, opts.mode, request).map(slimRule);

  const snapshot: EvaluationSnapshot = {
    schema: 1,
    design: { id: design.id, code: design.code, name: design.name, plantId: design.plantId },
    mode: opts.mode,
    evaluationDate: date,
    priceBasis: {
      kind: opts.priceSnapshotId ? 'snapshot' : 'live',
      date,
      snapshotId: opts.priceSnapshotId ?? null,
    },
    request,
    projectOverrides: opts.projectOverrides ?? [],
    tablePolicy: opts.tablePolicy ?? {},
    rules,
    lines: lines.map((l) => ({ materialId: l.materialId, kgPerM3: l.quantity })),
    materials: snapshotMaterials,
    settings: {
      nearLimitPct: settings.nearLimitPct,
      safetyMarginMpa: settings.safetyMarginMpa,
      yieldTolerance: settings.yieldTolerance,
      roundingTolerance: {},
    },
    characteristics: [],
    strengthRecords: null,
  };
  return snapshot;
}

async function loadPrices(
  db: Executor,
  tenantId: string,
  plantId: string,
  materialIds: string[],
  date: string,
  opts: BuildOptions,
  staleDays: number | null,
): Promise<Map<string, SnapshotPrice>> {
  const out = new Map<string, SnapshotPrice>();
  if (materialIds.length === 0) return out;

  if (opts.priceSnapshotId) {
    const [snap] = await db
      .select()
      .from(schema.priceSnapshots)
      .where(
        and(
          eq(schema.priceSnapshots.id, opts.priceSnapshotId),
          eq(schema.priceSnapshots.tenantId, tenantId),
        ),
      );
    if (!snap) return out;
    const rows = await db
      .select()
      .from(schema.priceSnapshotLines)
      .where(
        and(
          eq(schema.priceSnapshotLines.snapshotId, snap.id),
          eq(schema.priceSnapshotLines.plantId, plantId),
          inArray(schema.priceSnapshotLines.materialId, materialIds),
        ),
      );
    for (const r of rows) {
      if (r.status === 'ambiguous') {
        out.set(r.materialId, { status: 'ambiguous', supplierIds: [] });
      } else if (r.price && r.unit && r.supplierId && r.effectiveFrom && r.priceId) {
        const age = priceStaleness(r.effectiveFrom, snap.asOf, staleDays);
        out.set(r.materialId, {
          status: 'ok',
          priceId: r.priceId,
          price: r.price,
          unit: r.unit as Extract<SnapshotPrice, { status: 'ok' }>['unit'],
          supplierId: r.supplierId,
          includesDelivery: r.includesDelivery ?? true,
          effectiveFrom: r.effectiveFrom,
          staleness: age.status,
          ageDays: age.ageDays,
        });
      } else out.set(r.materialId, { status: 'unavailable' });
    }
    return out;
  }

  const rows = await db
    .select()
    .from(schema.materialPrices)
    .where(
      and(
        eq(schema.materialPrices.tenantId, tenantId),
        eq(schema.materialPrices.plantId, plantId),
        isNull(schema.materialPrices.supersededAt),
        inArray(schema.materialPrices.materialId, materialIds),
      ),
    );
  const prefs = await db
    .select()
    .from(schema.pricePreferences)
    .where(
      and(
        eq(schema.pricePreferences.tenantId, tenantId),
        eq(schema.pricePreferences.plantId, plantId),
      ),
    );
  const prefBy = new Map(prefs.map((p) => [p.materialId, p.supplierId]));
  const byMaterial = new Map<string, PriceRow[]>();
  for (const r of rows) {
    const list = byMaterial.get(r.materialId) ?? [];
    list.push(toPriceRow(r));
    byMaterial.set(r.materialId, list);
  }
  for (const id of materialIds) {
    const hit = priceAt(byMaterial.get(id) ?? [], date, prefBy.get(id));
    if (hit.status === 'unavailable') out.set(id, { status: 'unavailable' });
    else if (hit.status === 'ambiguous')
      out.set(id, { status: 'ambiguous', supplierIds: hit.supplierIds });
    else {
      const age = priceStaleness(
        hit.row.effectiveFrom,
        todayAmman(opts.now ?? new Date()),
        staleDays,
      );
      out.set(id, {
        status: 'ok',
        priceId: hit.row.id,
        price: hit.row.price,
        unit: hit.row.unit as Extract<SnapshotPrice, { status: 'ok' }>['unit'],
        supplierId: hit.row.supplierId,
        includesDelivery: hit.row.includesDelivery,
        effectiveFrom: hit.row.effectiveFrom,
        staleness: age.status,
        ageDays: age.ageDays,
      });
    }
  }
  return out;
}

export interface Evaluated {
  snapshot: EvaluationSnapshot;
  report: EvaluationReport;
  validator: ReturnType<typeof validateEvaluation>;
}

/** Evaluator first, then the independent validator on the same snapshot. Neither touches the database. */
export function runEvaluation(snapshot: EvaluationSnapshot): Evaluated {
  const report = evaluate(snapshot);
  return { snapshot, report, validator: validateEvaluation(snapshot, report) };
}

// ------------------------------------------------------------------- what a role may see

/** Money figures never leave the server for roles without `cost.view`. */
export function stripCost<T extends EvaluationReport>(report: T): T {
  const isCost = (k: string) => k.startsWith('cost.');
  const figures = Object.fromEntries(Object.entries(report.figures).filter(([k]) => !isCost(k)));
  return {
    ...report,
    figures,
    trace: report.trace.filter((t) => !isCost(t.key)),
    cost: {
      state: report.cost.state,
      basis: report.cost.basis,
      totalJodPerM3: null,
      subtotalJodPerM3: '',
      lines: [],
      missing: [],
    },
    dataQuality: report.dataQuality.filter((q) => !q.code.startsWith('price_')),
    characteristics: {
      rows: report.characteristics.rows.filter((r) => r.key !== 'max_cost_jod_m3'),
    },
  };
}

/** The snapshot's prices are cost data too. */
export function stripSnapshotCost(s: EvaluationSnapshot): EvaluationSnapshot {
  return {
    ...s,
    materials: s.materials.map((m) => ({ ...m, price: { status: 'unavailable' as const } })),
  };
}
