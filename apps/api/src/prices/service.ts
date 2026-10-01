import { schema, type AuditRecorder, type Executor, type Tx } from '@khalta/db';
import {
  addDays,
  divide,
  multiply,
  parseDecimal,
  PRICE_PATTERN,
  PRICE_UNITS,
  priceAt,
  priceStaleness,
  roundTo,
  toJodPerKg,
  type PriceRow,
  type PriceUnit,
} from '@khalta/engine';
import { canAccessPlant } from '@khalta/rbac';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ApiError, notFound } from '../errors';
import type { AuthContext } from '../middleware';

export type PriceDbRow = typeof schema.materialPrices.$inferSelect;
export const isUnit = (u: string): u is PriceUnit => (PRICE_UNITS as readonly string[]).includes(u);

export const toPriceRow = (r: PriceDbRow): PriceRow => ({
  id: r.id,
  materialId: r.materialId,
  plantId: r.plantId,
  supplierId: r.supplierId,
  price: r.price,
  unit: r.unit,
  includesDelivery: r.includesDelivery,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  supersededAt: r.supersededAt,
});

/** Plants the caller may see (unscoped roles: every plant of the tenant). */
export async function visiblePlants(db: Executor, auth: AuthContext) {
  const where = [
    eq(schema.plants.tenantId, auth.tenantId),
    isNull(schema.plants.deletedAt),
    eq(schema.plants.isActive, true),
  ];
  if (!auth.scope.all) {
    if (auth.scope.plantIds.length === 0) return [];
    where.push(inArray(schema.plants.id, [...auth.scope.plantIds]));
  }
  return db
    .select({
      id: schema.plants.id,
      code: schema.plants.code,
      nameAr: schema.plants.nameAr,
      nameEn: schema.plants.nameEn,
    })
    .from(schema.plants)
    .where(and(...where))
    .orderBy(asc(schema.plants.code));
}

/** Active materials the caller may see: shared (no home plant) or homed at one of their plants. */
export async function visibleMaterials(db: Executor, auth: AuthContext) {
  const where = [
    eq(schema.materials.tenantId, auth.tenantId),
    isNull(schema.materials.deletedAt),
    eq(schema.materials.isActive, true),
  ];
  if (!auth.scope.all)
    where.push(
      auth.scope.plantIds.length
        ? or(
            isNull(schema.materials.plantId),
            inArray(schema.materials.plantId, [...auth.scope.plantIds]),
          )!
        : isNull(schema.materials.plantId),
    );
  return db
    .select()
    .from(schema.materials)
    .where(and(...where))
    .orderBy(asc(schema.materials.category), asc(schema.materials.marketNameEn));
}

/** Specific gravity from each material's current test (for JOD/L conversion); null when not on file. */
export async function loadSgs(db: Executor, tenantId: string, materialIds: string[]) {
  const out = new Map<string, number | null>();
  if (materialIds.length === 0) return out;
  const tests = await db
    .select({
      materialId: schema.materialTests.materialId,
      properties: schema.materialTests.properties,
    })
    .from(schema.materialTests)
    .where(
      and(
        eq(schema.materialTests.tenantId, tenantId),
        eq(schema.materialTests.isCurrent, true),
        inArray(schema.materialTests.materialId, materialIds),
      ),
    );
  for (const t of tests) {
    const sg = (t.properties as Record<string, unknown>)['sg'];
    out.set(t.materialId, typeof sg === 'number' ? sg : null);
  }
  return out;
}

export interface Cell {
  materialId: string;
  plantId: string;
  status: 'ok' | 'ambiguous';
  id?: string;
  supplierId?: string;
  supplierIds?: string[];
  price?: string;
  unit?: PriceUnit;
  includesDelivery?: boolean;
  effectiveFrom?: string;
  alternatives?: number;
  jodPerKg?: string | null;
  notConvertible?: 'needs_density' | 'needs_sg' | 'invalid_price';
  staleness?: { status: 'fresh' | 'stale' | 'not_configured'; ageDays: number };
}

/** The price in force for every (material, plant) pair on `asOf`, with conversion and staleness. */
export function buildCells(
  rows: PriceDbRow[],
  prefs: Map<string, string>,
  sgs: Map<string, number | null>,
  asOf: string,
  today: string,
  staleDays: number | null,
): Cell[] {
  const byCell = new Map<string, PriceRow[]>();
  for (const r of rows) {
    const k = `${r.materialId}|${r.plantId}`;
    const list = byCell.get(k);
    if (list) list.push(toPriceRow(r));
    else byCell.set(k, [toPriceRow(r)]);
  }
  const out: Cell[] = [];
  for (const [k, list] of byCell) {
    const [materialId, plantId] = k.split('|') as [string, string];
    const hit = priceAt(list, asOf, prefs.get(k));
    if (hit.status === 'unavailable') continue;
    if (hit.status === 'ambiguous') {
      out.push({ materialId, plantId, status: 'ambiguous', supplierIds: hit.supplierIds });
      continue;
    }
    const r = hit.row;
    const unit = r.unit as PriceUnit;
    const conv = toJodPerKg({ price: r.price, unit, sg: sgs.get(materialId) ?? null });
    out.push({
      materialId,
      plantId,
      status: 'ok',
      id: r.id,
      supplierId: r.supplierId,
      price: r.price,
      unit,
      includesDelivery: r.includesDelivery,
      effectiveFrom: r.effectiveFrom,
      alternatives: hit.alternatives,
      jodPerKg: conv.ok ? conv.jodPerKg : null,
      ...(conv.ok ? {} : { notConvertible: conv.reason }),
      staleness: priceStaleness(r.effectiveFrom, today, staleDays),
    });
  }
  return out;
}

export async function loadLiveRows(
  db: Executor,
  tenantId: string,
  materialIds: string[] | null,
  plantIds: string[],
) {
  if (plantIds.length === 0 || (materialIds && materialIds.length === 0)) return [];
  const where = [
    eq(schema.materialPrices.tenantId, tenantId),
    isNull(schema.materialPrices.supersededAt),
    inArray(schema.materialPrices.plantId, plantIds),
  ];
  if (materialIds) where.push(inArray(schema.materialPrices.materialId, materialIds));
  return db
    .select()
    .from(schema.materialPrices)
    .where(and(...where));
}

export async function loadPrefs(db: Executor, tenantId: string, plantIds: string[]) {
  const out = new Map<string, string>();
  if (plantIds.length === 0) return out;
  const rows = await db
    .select()
    .from(schema.pricePreferences)
    .where(
      and(
        eq(schema.pricePreferences.tenantId, tenantId),
        inArray(schema.pricePreferences.plantId, plantIds),
      ),
    );
  for (const r of rows) out.set(`${r.materialId}|${r.plantId}`, r.supplierId);
  return out;
}

export interface Entry {
  materialId: string;
  plantId: string;
  supplierId?: string | undefined;
  price: string;
  unit: PriceUnit;
  includesDelivery?: boolean | undefined;
  effectiveFrom?: string | undefined;
  reason?: string | undefined;
}
export interface ApplyOptions {
  effectiveFrom: string;
  reason?: string | undefined;
  importBatchId?: string | undefined;
  /** Re-enter an unchanged price as a new period (a "reconfirm"). */
  allowUnchanged?: boolean;
}
export interface ApplyResult {
  applied: number;
  unchanged: number;
  rows: {
    materialId: string;
    plantId: string;
    supplierId: string;
    price: string;
    unit: string;
    previous: string | null;
  }[];
}

const fail = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);

/**
 * Writes a set of prices in one transaction. Rules: a new price closes the previous period the day before it
 * starts; entering a price for the same start date supersedes the previous row; a start earlier than the
 * latest existing price is rejected; rows are never updated or deleted otherwise. Nothing is half-applied.
 */
export async function applyPrices(
  tx: Tx,
  auth: AuthContext,
  audit: AuditRecorder,
  input: Entry[],
  opts: ApplyOptions,
): Promise<ApplyResult> {
  if (input.length === 0) return { applied: 0, unchanged: 0, rows: [] };
  for (const e of input) {
    if (!PRICE_PATTERN.test(e.price))
      throw fail('invalid_price', 'Prices have at most 3 decimals', {
        materialId: e.materialId,
        price: e.price,
      });
    if (!isUnit(e.unit)) throw fail('invalid_unit', 'Unknown price unit', { unit: e.unit });
  }
  // Last entry wins per (material, plant, supplier-or-default).
  const entries = [
    ...new Map(
      input.map((e) => [`${e.materialId}|${e.plantId}|${e.supplierId ?? ''}`, e]),
    ).values(),
  ];
  const materialIds = [...new Set(entries.map((e) => e.materialId))];
  const plantIds = [...new Set(entries.map((e) => e.plantId))];

  const plants = await tx
    .select({ id: schema.plants.id })
    .from(schema.plants)
    .where(
      and(
        eq(schema.plants.tenantId, auth.tenantId),
        isNull(schema.plants.deletedAt),
        inArray(schema.plants.id, plantIds),
      ),
    );
  if (plants.length !== plantIds.length || plantIds.some((p) => !canAccessPlant(auth.scope, p)))
    throw notFound('Plant not found');
  const mats = await tx
    .select({
      id: schema.materials.id,
      supplierId: schema.materials.supplierId,
      plantId: schema.materials.plantId,
    })
    .from(schema.materials)
    .where(
      and(
        eq(schema.materials.tenantId, auth.tenantId),
        isNull(schema.materials.deletedAt),
        inArray(schema.materials.id, materialIds),
      ),
    );
  if (mats.length !== materialIds.length) throw notFound('Material not found');
  const matById = new Map(mats.map((m) => [m.id, m]));

  const supplierIds = [...new Set(entries.flatMap((e) => (e.supplierId ? [e.supplierId] : [])))];
  if (supplierIds.length) {
    const found = await tx
      .select({ id: schema.suppliers.id })
      .from(schema.suppliers)
      .where(
        and(
          eq(schema.suppliers.tenantId, auth.tenantId),
          isNull(schema.suppliers.deletedAt),
          inArray(schema.suppliers.id, supplierIds),
        ),
      );
    if (found.length !== supplierIds.length) throw fail('invalid_request', 'Unknown supplier');
  }

  const live = await loadLiveRows(tx, auth.tenantId, materialIds, plantIds);
  const prefs = await loadPrefs(tx, auth.tenantId, plantIds);
  const liveByCell = new Map<string, PriceDbRow[]>();
  for (const r of live) {
    const k = `${r.materialId}|${r.plantId}`;
    liveByCell.set(k, [...(liveByCell.get(k) ?? []), r]);
  }

  const inserts: (typeof schema.materialPrices.$inferInsert)[] = [];
  const closes: { id: string; to: string | null; supersede: boolean }[] = [];
  const newPrefs: { materialId: string; plantId: string; supplierId: string }[] = [];
  const result: ApplyResult = { applied: 0, unchanged: 0, rows: [] };
  const problems: { materialId: string; plantId: string; code: string }[] = [];

  for (const e of entries) {
    const cellKey = `${e.materialId}|${e.plantId}`;
    const cellRows = liveByCell.get(cellKey) ?? [];
    const supplierId =
      e.supplierId ??
      prefs.get(cellKey) ??
      matById.get(e.materialId)?.supplierId ??
      (new Set(cellRows.map((r) => r.supplierId)).size === 1 ? cellRows[0]!.supplierId : undefined);
    if (!supplierId) {
      problems.push({ materialId: e.materialId, plantId: e.plantId, code: 'supplier_required' });
      continue;
    }
    const from = e.effectiveFrom ?? opts.effectiveFrom;
    const mine = cellRows
      .filter((r) => r.supplierId === supplierId)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    const latest = mine[0];
    const includes = e.includesDelivery ?? latest?.includesDelivery ?? true;
    if (latest) {
      const same =
        parseDecimal(latest.price) === parseDecimal(e.price) &&
        latest.unit === e.unit &&
        latest.includesDelivery === includes;
      if (same && (!opts.allowUnchanged || latest.effectiveFrom === from)) {
        result.unchanged++;
        continue;
      }
      if (from < latest.effectiveFrom) {
        problems.push({
          materialId: e.materialId,
          plantId: e.plantId,
          code: 'earlier_than_latest',
        });
        continue;
      }
      if (from === latest.effectiveFrom) closes.push({ id: latest.id, to: null, supersede: true });
      else if (latest.effectiveTo === null)
        closes.push({ id: latest.id, to: addDays(from, -1), supersede: false });
      else if (latest.effectiveTo >= from) {
        problems.push({ materialId: e.materialId, plantId: e.plantId, code: 'period_closed' });
        continue;
      }
    }
    inserts.push({
      tenantId: auth.tenantId,
      materialId: e.materialId,
      plantId: e.plantId,
      supplierId,
      price: e.price,
      unit: e.unit,
      includesDelivery: includes,
      effectiveFrom: from,
      reason: e.reason ?? opts.reason ?? null,
      importBatchId: opts.importBatchId ?? null,
      enteredBy: auth.user.id,
    });
    if (
      !prefs.has(cellKey) &&
      !newPrefs.some((p) => p.materialId === e.materialId && p.plantId === e.plantId)
    )
      newPrefs.push({ materialId: e.materialId, plantId: e.plantId, supplierId });
    result.rows.push({
      materialId: e.materialId,
      plantId: e.plantId,
      supplierId,
      price: e.price,
      unit: e.unit,
      previous: latest ? latest.price : null,
    });
    result.applied++;
  }
  if (problems.length) {
    const code = problems[0]!.code;
    throw new ApiError(
      code === 'supplier_required' ? 400 : 409,
      code,
      code === 'supplier_required'
        ? 'Choose a supplier for these prices'
        : 'Prices cannot be entered for these cells',
      { cells: problems.slice(0, 50), total: problems.length },
    );
  }

  if (closes.length) {
    const now = new Date().toISOString();
    await tx.execute(sql`
      UPDATE material_prices AS p
         SET effective_to = COALESCE(d.eto, p.effective_to),
             superseded_at = CASE WHEN d.sup THEN ${now}::timestamptz ELSE p.superseded_at END
        FROM jsonb_to_recordset(${JSON.stringify(closes.map((c) => ({ id: c.id, eto: c.to, sup: c.supersede })))}::jsonb)
             AS d(id uuid, eto date, sup boolean)
       WHERE p.id = d.id`);
  }
  for (let i = 0; i < inserts.length; i += 1000)
    await tx.insert(schema.materialPrices).values(inserts.slice(i, i + 1000));
  for (let i = 0; i < newPrefs.length; i += 1000)
    await tx
      .insert(schema.pricePreferences)
      .values(
        newPrefs
          .slice(i, i + 1000)
          .map((p) => ({ ...p, tenantId: auth.tenantId, updatedBy: auth.user.id })),
      )
      .onConflictDoNothing();

  // every request leaves an audit entry, including one that changed nothing
  await audit.record({
    action: 'price.set',
    entityType: 'price_batch',
    entityId: randomUUID(),
    before: {
      previous: result.rows.map((r) => [r.materialId, r.plantId, r.supplierId, r.previous]),
    },
    after: {
      effectiveFrom: opts.effectiveFrom,
      reason: opts.reason ?? null,
      importBatchId: opts.importBatchId ?? null,
      unchanged: result.unchanged,
      prices: result.rows.map((r) => [r.materialId, r.plantId, r.supplierId, r.price, r.unit]),
    },
  });
  return result;
}

/** Percentage change of a price string, rounded half up to 3 decimals. `percent` has at most 3 decimals. */
export function changeByPercent(price: string, percent: string): string | null {
  const p = parseDecimal(price);
  const pct = /^-?\d{1,4}(\.\d{1,3})?$/.test(percent) ? percent : null;
  if (p === null || pct === null) return null;
  const neg = pct.startsWith('-');
  const f = parseDecimal(pct.replace('-', ''));
  if (f === null) return null;
  const hundred = 100n * 10n ** 9n;
  const factor = neg ? hundred - f : hundred + f;
  if (factor < 0n) return null;
  const out = roundTo(multiply(p, divide(factor, hundred)), 3);
  return PRICE_PATTERN.test(out) ? out : null;
}
