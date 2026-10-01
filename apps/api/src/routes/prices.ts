import { schema, type Executor } from '@khalta/db';
import { PRICE_UNITS, todayAmman, type PriceUnit } from '@khalta/engine';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import { z } from 'zod';
import { ApiError, conflict, notFound } from '../errors';
import type { AuthContext } from '../middleware';
import {
  BOM,
  MAX_IMPORT_BYTES,
  mapHeader,
  parseBool,
  parseDateCell,
  parsePriceCell,
  parseUnit,
  readTable,
} from '../prices/import';
import {
  applyPrices,
  buildCells,
  changeByPercent,
  loadLiveRows,
  loadPrefs,
  loadSgs,
  visibleMaterials,
  visiblePlants,
  type Entry,
} from '../prices/service';
import type { ApiRoutes } from '../route';

const uuid = z.uuid();
const date = z.iso.date();
const text = (n: number) => z.string().trim().max(n);
const unit = z.enum(PRICE_UNITS);

const asOfQuery = z.object({ asOf: date.optional() });
const historyQuery = z.object({ materialId: uuid, plantId: uuid, supplierId: uuid.optional() });
const entry = z.strictObject({
  materialId: uuid,
  plantId: uuid,
  supplierId: uuid.optional(),
  price: z.string().max(20),
  unit,
  includesDelivery: z.boolean().optional(),
});
const setBody = z.strictObject({
  entries: z.array(entry).min(1).max(5000),
  effectiveFrom: date.optional(),
  reason: text(500).optional(),
});
const preferredBody = z.strictObject({ materialId: uuid, plantId: uuid, supplierId: uuid });
const percent = z.string().regex(/^-?\d{1,4}(\.\d{1,3})?$/);
const bulkBody = z.strictObject({
  percent,
  plantIds: z.array(uuid).max(200).optional(),
  materialIds: z.array(uuid).max(2000).optional(),
  effectiveFrom: date.optional(),
  reason: text(500).optional(),
});
const copyBody = z.strictObject({
  fromPlantId: uuid,
  toPlantId: uuid,
  materialIds: z.array(uuid).max(2000).optional(),
  overwrite: z.boolean().optional(),
  effectiveFrom: date.optional(),
  reason: text(500).optional(),
});
const importQuery = z.object({ filename: z.string().max(300).optional() });
const commitBody = z.strictObject({ batchId: uuid });
const exportBody = z.strictObject({ format: z.enum(['xlsx', 'csv']), asOf: date.optional() });
const snapshotBody = z.strictObject({
  name: text(120).min(1),
  asOf: date.optional(),
  plantIds: z.array(uuid).max(200).optional(),
});
const idParam = z.object({ id: uuid });

/** A back-dated entry needs a reason; the reason is mandatory for every non-today start. */
function checkDates(effectiveFrom: string | undefined, reason: string | undefined) {
  const today = todayAmman();
  if (effectiveFrom && effectiveFrom < today && !(reason && reason.trim().length >= 3))
    throw new ApiError(400, 'reason_required', 'A back-dated price needs a reason');
  return effectiveFrom ?? today;
}

async function writablePlantIds(db: Executor, auth: AuthContext, wanted?: string[]) {
  const plants = await visiblePlants(db, auth);
  const ids = plants.map((p) => p.id);
  if (wanted) {
    if (wanted.some((w) => !ids.includes(w))) throw notFound('Plant not found');
    return wanted;
  }
  return ids;
}

/** Current price per (material, plant) with supplier names, as the matrix and exports show it. */
async function matrix(db: Executor, auth: AuthContext, asOf: string, plantFilter?: string[]) {
  const [plants, materials] = await Promise.all([
    visiblePlants(db, auth),
    visibleMaterials(db, auth),
  ]);
  const shown = plantFilter ? plants.filter((p) => plantFilter.includes(p.id)) : plants;
  const plantIds = shown.map((p) => p.id);
  const materialIds = materials.map((m) => m.id);
  const settings = auth.settings;
  const [rows, prefs, sgs] = await Promise.all([
    loadLiveRows(db, auth.tenantId, materialIds, plantIds),
    loadPrefs(db, auth.tenantId, plantIds),
    loadSgs(db, auth.tenantId, materialIds),
  ]);
  const cells = buildCells(rows, prefs, sgs, asOf, todayAmman(), settings.stalePriceDays);
  return { plants: shown, materials, cells };
}

const MAX_BATCH = 5000;

export function priceRoutes(api: ApiRoutes) {
  api.get(
    '/api/prices',
    {
      summary: 'Price matrix: the price in force per material and plant',
      capability: 'price.view',
      query: asOfQuery,
    },
    async ({ auth, query, db }) => {
      const asOf = query.asOf ?? todayAmman();
      const { plants, materials, cells } = await matrix(db, auth, asOf);
      const suppliers = await db
        .select({
          id: schema.suppliers.id,
          nameAr: schema.suppliers.nameAr,
          nameEn: schema.suppliers.nameEn,
        })
        .from(schema.suppliers)
        .where(
          and(eq(schema.suppliers.tenantId, auth.tenantId), isNull(schema.suppliers.deletedAt)),
        );
      const priced = new Set(
        cells.filter((c) => c.status === 'ok').map((c) => `${c.materialId}|${c.plantId}`),
      );
      return {
        asOf,
        plants,
        suppliers,
        materials: materials.map((m) => ({
          id: m.id,
          category: m.category,
          marketNameAr: m.marketNameAr,
          marketNameEn: m.marketNameEn,
          supplierId: m.supplierId,
          plantId: m.plantId,
        })),
        cells,
        summary: {
          pairs: plants.length * materials.length,
          priced: priced.size,
          unpriced: plants.length * materials.length - cells.length,
          ambiguous: cells.filter((c) => c.status === 'ambiguous').length,
          stale: cells.filter((c) => c.staleness?.status === 'stale').length,
          notConvertible: cells.filter((c) => c.notConvertible).length,
          staleLimitDays: auth.settings.stalePriceDays,
        },
      };
    },
  );

  api.get(
    '/api/prices/coverage',
    { summary: 'How many plants each material is priced at', capability: 'price.view' },
    async ({ auth, db }) => {
      const { plants, cells } = await matrix(db, auth, todayAmman());
      const out: Record<string, number> = {};
      for (const c of cells)
        if (c.status === 'ok') out[c.materialId] = (out[c.materialId] ?? 0) + 1;
      return { plants: plants.length, priced: out };
    },
  );

  api.get(
    '/api/prices/history',
    {
      summary: 'Every price ever entered for one material at one plant',
      capability: 'price.view',
      query: historyQuery,
    },
    async ({ auth, query, db }) => {
      const plants = await writablePlantIds(db, auth, [query.plantId]);
      const [m] = await db
        .select({ id: schema.materials.id })
        .from(schema.materials)
        .where(
          and(
            eq(schema.materials.id, query.materialId),
            eq(schema.materials.tenantId, auth.tenantId),
            isNull(schema.materials.deletedAt),
          ),
        );
      if (!m) throw notFound('Material not found');
      const where = [
        eq(schema.materialPrices.tenantId, auth.tenantId),
        eq(schema.materialPrices.materialId, query.materialId),
        eq(schema.materialPrices.plantId, plants[0]!),
      ];
      if (query.supplierId) where.push(eq(schema.materialPrices.supplierId, query.supplierId));
      const rows = await db
        .select({
          id: schema.materialPrices.id,
          supplierId: schema.materialPrices.supplierId,
          price: schema.materialPrices.price,
          unit: schema.materialPrices.unit,
          includesDelivery: schema.materialPrices.includesDelivery,
          effectiveFrom: schema.materialPrices.effectiveFrom,
          effectiveTo: schema.materialPrices.effectiveTo,
          supersededAt: schema.materialPrices.supersededAt,
          reason: schema.materialPrices.reason,
          createdAt: schema.materialPrices.createdAt,
          enteredBy: schema.users.name,
        })
        .from(schema.materialPrices)
        .leftJoin(schema.users, eq(schema.users.id, schema.materialPrices.enteredBy))
        .where(and(...where))
        .orderBy(desc(schema.materialPrices.effectiveFrom), desc(schema.materialPrices.createdAt));
      return rows;
    },
  );

  api.mutate(
    'post',
    '/api/prices',
    {
      summary: 'Enter prices (one cell or a pasted block); history is kept',
      capability: 'price.edit',
      body: setBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      const effectiveFrom = checkDates(body.effectiveFrom, body.reason);
      return applyPrices(tx, auth, audit, body.entries as Entry[], {
        effectiveFrom,
        reason: body.reason,
      });
    },
  );

  api.mutate(
    'post',
    '/api/prices/preferred',
    {
      summary: 'Choose which supplier’s price a material uses at a plant',
      capability: 'price.edit',
      body: preferredBody,
    },
    async ({ auth, body, tx, audit }) => {
      await writablePlantIds(tx, auth, [body.plantId]);
      const rows = await loadLiveRows(tx, auth.tenantId, [body.materialId], [body.plantId]);
      if (!rows.some((r) => r.supplierId === body.supplierId))
        throw conflict('That supplier has no price for this material at this plant');
      await tx
        .insert(schema.pricePreferences)
        .values({ ...body, tenantId: auth.tenantId, updatedBy: auth.user.id })
        .onConflictDoUpdate({
          target: [schema.pricePreferences.materialId, schema.pricePreferences.plantId],
          set: { supplierId: body.supplierId, updatedBy: auth.user.id, updatedAt: new Date() },
        });
      await audit.record({
        action: 'price.preferred',
        entityType: 'price_preference',
        entityId: `${body.materialId}:${body.plantId}`,
        after: body,
      });
    },
  );

  async function planBulk(
    db: Executor,
    auth: AuthContext,
    body: z.infer<typeof bulkBody>,
    asOf: string,
  ): Promise<Entry[]> {
    const plantIds = await writablePlantIds(db, auth, body.plantIds);
    const { cells } = await matrix(db, auth, asOf, plantIds);
    const wanted = body.materialIds ? new Set(body.materialIds) : null;
    const out: Entry[] = [];
    for (const c of cells) {
      if (c.status !== 'ok' || (wanted && !wanted.has(c.materialId))) continue;
      const next = changeByPercent(c.price!, body.percent);
      if (next === null)
        throw new ApiError(400, 'invalid_price', 'The change produces an invalid price', {
          materialId: c.materialId,
          plantId: c.plantId,
        });
      out.push({
        materialId: c.materialId,
        plantId: c.plantId,
        supplierId: c.supplierId,
        price: next,
        unit: c.unit!,
        includesDelivery: c.includesDelivery,
      });
    }
    if (out.length > MAX_BATCH)
      throw new ApiError(400, 'too_many', 'Too many prices in one change');
    return out;
  }

  api.readPost(
    '/api/prices/bulk-change/preview',
    {
      summary: 'Preview a percentage change (0 % = reconfirm today)',
      capability: 'price.edit',
      body: bulkBody,
    },
    async ({ auth, body, db }) => {
      const asOf = body.effectiveFrom ?? todayAmman();
      const entries = await planBulk(db, auth, body, asOf);
      const { cells } = await matrix(
        db,
        auth,
        asOf,
        await writablePlantIds(db, auth, body.plantIds),
      );
      const prev = new Map(cells.map((c) => [`${c.materialId}|${c.plantId}`, c.price]));
      return {
        count: entries.length,
        rows: entries.slice(0, 500).map((e) => ({
          materialId: e.materialId,
          plantId: e.plantId,
          from: prev.get(`${e.materialId}|${e.plantId}`),
          to: e.price,
          unit: e.unit,
        })),
      };
    },
  );

  api.mutate(
    'post',
    '/api/prices/bulk-change',
    {
      summary: 'Apply a percentage change to current prices (0 % = reconfirm)',
      capability: 'price.edit',
      body: bulkBody,
    },
    async ({ auth, body, tx, audit }) => {
      const effectiveFrom = checkDates(body.effectiveFrom, body.reason);
      const entries = await planBulk(tx, auth, body, effectiveFrom);
      return applyPrices(tx, auth, audit, entries, {
        effectiveFrom,
        reason: body.reason ?? `Bulk change ${body.percent}%`,
        allowUnchanged: Number(body.percent) === 0,
      });
    },
  );

  api.mutate(
    'post',
    '/api/prices/copy',
    {
      summary: 'Copy one plant’s prices to another plant',
      capability: 'price.edit',
      body: copyBody,
    },
    async ({ auth, body, tx, audit }) => {
      if (body.fromPlantId === body.toPlantId)
        throw new ApiError(400, 'invalid_request', 'Choose two different plants');
      const effectiveFrom = checkDates(body.effectiveFrom, body.reason);
      await writablePlantIds(tx, auth, [body.fromPlantId, body.toPlantId]);
      const { cells } = await matrix(tx, auth, effectiveFrom, [body.fromPlantId, body.toPlantId]);
      const wanted = body.materialIds ? new Set(body.materialIds) : null;
      const target = new Set(
        cells
          .filter((c) => c.plantId === body.toPlantId && c.status === 'ok')
          .map((c) => c.materialId),
      );
      const entries: Entry[] = cells
        .filter(
          (c) =>
            c.plantId === body.fromPlantId &&
            c.status === 'ok' &&
            (!wanted || wanted.has(c.materialId)) &&
            (body.overwrite || !target.has(c.materialId)),
        )
        .map((c) => ({
          materialId: c.materialId,
          plantId: body.toPlantId,
          supplierId: c.supplierId,
          price: c.price!,
          unit: c.unit!,
          includesDelivery: c.includesDelivery,
        }));
      return applyPrices(tx, auth, audit, entries, {
        effectiveFrom,
        reason: body.reason ?? 'Copied from another plant',
      });
    },
  );

  // ---- Import (preview, then all-or-nothing commit) ----
  api.upload(
    '/api/prices/import/preview',
    {
      summary: 'Validate an .xlsx or .csv price list; nothing is applied until commit',
      capability: 'price.edit',
      status: 200,
      query: importQuery,
      limitBytes: MAX_IMPORT_BYTES,
    },
    async ({ auth, body, query, tx, audit }) => {
      if (body.length === 0) throw new ApiError(400, 'invalid_request', 'The upload is empty');
      let table: string[][];
      try {
        table = await readTable(body, query.filename ?? 'upload.csv');
      } catch {
        throw new ApiError(415, 'unsupported_type', 'Upload an .xlsx or .csv file');
      }
      const header = table[0] ?? [];
      const { index, missing } = mapHeader(header);
      if (missing.length)
        throw new ApiError(400, 'missing_columns', 'Required columns are missing', { missing });
      const [plants, materials, suppliers] = await Promise.all([
        visiblePlants(tx, auth),
        visibleMaterials(tx, auth),
        tx
          .select()
          .from(schema.suppliers)
          .where(
            and(eq(schema.suppliers.tenantId, auth.tenantId), isNull(schema.suppliers.deletedAt)),
          ),
      ]);
      const low = (s: string | null) => (s ?? '').trim().toLowerCase();
      const find = <T>(list: T[], key: string, ...names: ((t: T) => string | null)[]) =>
        list.filter((t) => names.some((n) => low(n(t)) === low(key)));
      const today = todayAmman();
      const rows: ImportRow[] = [];
      const pairs: { materialId: string; plantId: string }[] = [];
      table.slice(1).forEach((r, i) => {
        const get = (c: keyof typeof index) =>
          index[c] === undefined ? '' : (r[index[c]!] ?? '').trim();
        const line = i + 2;
        const errors: string[] = [];
        const m = find(
          materials,
          get('material'),
          (x) => x.marketNameEn,
          (x) => x.marketNameAr,
          (x) => x.technicalName,
        );
        const p = find(
          plants,
          get('plant'),
          (x) => x.code,
          (x) => x.nameEn,
          (x) => x.nameAr,
        );
        const sName = get('supplier');
        const s = sName
          ? find(
              suppliers,
              sName,
              (x) => x.nameEn,
              (x) => x.nameAr,
            )
          : [];
        const price = parsePriceCell(get('price'));
        const u = parseUnit(get('unit'));
        const del = get('includes_delivery') ? parseBool(get('includes_delivery')) : null;
        const from = get('effective_from') ? parseDateCell(get('effective_from')) : today;
        if (m.length !== 1) errors.push(m.length === 0 ? 'unknown_material' : 'ambiguous_material');
        if (p.length !== 1) errors.push(p.length === 0 ? 'unknown_plant' : 'ambiguous_plant');
        if (sName && s.length !== 1)
          errors.push(s.length === 0 ? 'unknown_supplier' : 'ambiguous_supplier');
        if (price.kind !== 'value')
          errors.push(price.kind === 'error' ? price.message : 'price_required');
        if (!u) errors.push('unknown_unit');
        if (get('includes_delivery') && del === null) errors.push('bad_delivery_flag');
        if (!from) errors.push('bad_date');
        if (from && from < today && get('reason').length < 3) errors.push('reason_required');
        const entry: Entry | undefined =
          errors.length === 0
            ? {
                materialId: m[0]!.id,
                plantId: p[0]!.id,
                supplierId: s[0]?.id,
                price: (price as { value: string }).value,
                unit: u!,
                includesDelivery: del ?? undefined,
                effectiveFrom: from!,
                reason: get('reason') || undefined,
              }
            : undefined;
        if (entry) pairs.push({ materialId: entry.materialId, plantId: entry.plantId });
        rows.push({ line, status: errors.length ? 'error' : 'ok', errors, entry, previous: null });
      });
      // Mark rows that would not change anything, and remember what each row replaces (stale-preview check).
      const live = await loadLiveRows(
        tx,
        auth.tenantId,
        [...new Set(pairs.map((x) => x.materialId))],
        [...new Set(pairs.map((x) => x.plantId))],
      );
      const prefs = await loadPrefs(tx, auth.tenantId, [...new Set(pairs.map((x) => x.plantId))]);
      for (const r of rows) {
        const e = r.entry;
        if (!e) continue;
        const cell = live.filter((x) => x.materialId === e.materialId && x.plantId === e.plantId);
        const supplier =
          e.supplierId ??
          prefs.get(`${e.materialId}|${e.plantId}`) ??
          (new Set(cell.map((x) => x.supplierId)).size === 1 ? cell[0]?.supplierId : undefined);
        const latest = cell
          .filter((x) => x.supplierId === supplier)
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
        r.previous = latest ? `${latest.id}` : null;
        if (latest && e.effectiveFrom && e.effectiveFrom < latest.effectiveFrom) {
          r.status = 'error';
          r.errors.push('earlier_than_latest');
          continue;
        }
        if (
          latest &&
          Number(latest.price) === Number(e.price) &&
          latest.unit === e.unit &&
          (e.includesDelivery === undefined || latest.includesDelivery === e.includesDelivery)
        )
          r.status = 'unchanged';
      }
      if (rows.length > MAX_BATCH)
        throw new ApiError(400, 'too_many', `At most ${MAX_BATCH} rows per import`);
      const summary = {
        total: rows.length,
        ok: rows.filter((r) => r.status === 'ok').length,
        unchanged: rows.filter((r) => r.status === 'unchanged').length,
        errors: rows.filter((r) => r.status === 'error').length,
      };
      const [batch] = await tx
        .insert(schema.priceImportBatches)
        .values({
          tenantId: auth.tenantId,
          filename: query.filename ?? null,
          rows,
          summary,
          status: 'previewed',
          createdBy: auth.user.id,
        })
        .returning({ id: schema.priceImportBatches.id });
      await audit.record({
        action: 'price.import.preview',
        entityType: 'price_import_batch',
        entityId: batch!.id,
        after: summary,
      });
      return { batchId: batch!.id, summary, rows: rows.slice(0, 1000) };
    },
  );

  api.mutate(
    'post',
    '/api/prices/import/commit',
    {
      summary: 'Apply a previewed import, all or nothing',
      capability: 'price.edit',
      body: commitBody,
    },
    async ({ auth, body, tx, audit }) => {
      const [batch] = await tx
        .select()
        .from(schema.priceImportBatches)
        .where(
          and(
            eq(schema.priceImportBatches.id, body.batchId),
            eq(schema.priceImportBatches.tenantId, auth.tenantId),
          ),
        )
        .for('update');
      if (!batch) throw notFound('Import not found');
      if (batch.createdBy !== auth.user.id) throw notFound('Import not found');
      if (batch.status === 'committed') throw conflict('This import was already applied');
      const rows = batch.rows as ImportRow[];
      if (rows.some((r) => r.status === 'error'))
        throw new ApiError(400, 'has_errors', 'Fix the errors in the file and preview again');
      const todo = rows.filter((r) => r.status === 'ok' && r.entry);
      // stale-preview check: the prices each row replaced must still be the latest ones
      const cellRows = await loadLiveRows(
        tx,
        auth.tenantId,
        [...new Set(todo.map((r) => r.entry!.materialId))],
        [...new Set(todo.map((r) => r.entry!.plantId))],
      );
      const prefs = await loadPrefs(tx, auth.tenantId, [
        ...new Set(todo.map((r) => r.entry!.plantId)),
      ]);
      for (const r of todo) {
        const e = r.entry!;
        const cell = cellRows.filter(
          (x) => x.materialId === e.materialId && x.plantId === e.plantId,
        );
        const supplier =
          e.supplierId ??
          prefs.get(`${e.materialId}|${e.plantId}`) ??
          (new Set(cell.map((x) => x.supplierId)).size === 1 ? cell[0]?.supplierId : undefined);
        const latest = cell
          .filter((x) => x.supplierId === supplier)
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
        if ((latest?.id ?? null) !== r.previous)
          throw conflict('Prices changed since the preview; preview the file again');
      }
      const result = await applyPrices(
        tx,
        auth,
        audit,
        todo.map((r) => r.entry!),
        {
          effectiveFrom: todayAmman(),
          reason: `Imported from ${batch.filename ?? 'file'}`,
          importBatchId: batch.id,
        },
      );
      await tx
        .update(schema.priceImportBatches)
        .set({ status: 'committed', committedAt: new Date() })
        .where(eq(schema.priceImportBatches.id, batch.id));
      await audit.record({
        action: 'price.import.commit',
        entityType: 'price_import_batch',
        entityId: batch.id,
        after: { applied: result.applied, unchanged: result.unchanged },
      });
      return { applied: result.applied, unchanged: result.unchanged };
    },
  );

  // ---- Export (logged) ----
  api.mutateFile(
    '/api/prices/export',
    {
      summary: 'Export the current prices as .xlsx or .csv (logged)',
      capability: 'export.priceCost',
      body: exportBody,
    },
    async ({ auth, body, tx, audit }) => {
      const asOf = body.asOf ?? todayAmman();
      const { plants, materials, cells } = await matrix(tx, auth, asOf);
      const suppliers = await tx
        .select()
        .from(schema.suppliers)
        .where(eq(schema.suppliers.tenantId, auth.tenantId));
      const sup = new Map(suppliers.map((s) => [s.id, s.nameEn]));
      const mat = new Map(materials.map((m) => [m.id, m]));
      const pl = new Map(plants.map((p) => [p.id, p]));
      const header = [
        'material',
        'material_ar',
        'category',
        'plant',
        'supplier',
        'price',
        'unit',
        'includes_delivery',
        'effective_from',
        'jod_per_kg',
      ];
      const lines = cells
        .filter((c) => c.status === 'ok')
        .map((c) => [
          mat.get(c.materialId)!.marketNameEn,
          mat.get(c.materialId)!.marketNameAr ?? '',
          mat.get(c.materialId)!.category,
          pl.get(c.plantId)!.code,
          sup.get(c.supplierId!) ?? '',
          c.price!,
          c.unit!,
          c.includesDelivery ? 'yes' : 'no',
          c.effectiveFrom!,
          c.jodPerKg ?? '',
        ])
        .sort(
          (a, b) =>
            String(a[3]).localeCompare(String(b[3])) || String(a[0]).localeCompare(String(b[0])),
        );
      await audit.record({
        action: 'price.export',
        entityType: 'price_export',
        entityId: `${asOf}:${body.format}`,
        after: { rows: lines.length, format: body.format },
      });
      if (body.format === 'csv')
        return {
          filename: `prices-${asOf}.csv`,
          contentType: 'text/csv; charset=utf-8',
          data: Buffer.from(`${BOM}${Papa.unparse([header, ...lines])}`, 'utf8'),
        };
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Prices');
      ws.addRow(header);
      for (const l of lines) ws.addRow(l);
      ws.getRow(1).font = { bold: true };
      return {
        filename: `prices-${asOf}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: Buffer.from(await wb.xlsx.writeBuffer()),
      };
    },
  );

  // ---- Snapshots ----
  const lineHash = (lines: SnapLine[]) =>
    createHash('sha256')
      .update(
        JSON.stringify(
          [...lines]
            .sort((a, b) =>
              `${a.materialId}|${a.plantId}`.localeCompare(`${b.materialId}|${b.plantId}`),
            )
            .map((l) => [
              l.materialId,
              l.plantId,
              l.status,
              l.priceId,
              l.price,
              l.unit,
              l.jodPerKg,
            ]),
        ),
      )
      .digest('hex');

  api.mutate(
    'post',
    '/api/price-snapshots',
    {
      summary: 'Freeze the prices in force on a date as a named, immutable snapshot',
      capability: 'price.edit',
      body: snapshotBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      const asOf = body.asOf ?? todayAmman();
      const plantIds = await writablePlantIds(tx, auth, body.plantIds);
      const { materials, cells } = await matrix(tx, auth, asOf, plantIds);
      const byKey = new Map(cells.map((c) => [`${c.materialId}|${c.plantId}`, c]));
      const lines: SnapLine[] = [];
      for (const m of materials)
        for (const p of plantIds) {
          const c = byKey.get(`${m.id}|${p}`);
          if (!c)
            lines.push({
              materialId: m.id,
              plantId: p,
              status: 'unavailable',
              priceId: null,
              supplierId: null,
              price: null,
              unit: null,
              includesDelivery: null,
              effectiveFrom: null,
              jodPerKg: null,
            });
          else if (c.status === 'ambiguous')
            lines.push({
              materialId: m.id,
              plantId: p,
              status: 'ambiguous',
              priceId: null,
              supplierId: null,
              price: null,
              unit: null,
              includesDelivery: null,
              effectiveFrom: null,
              jodPerKg: null,
            });
          else
            lines.push({
              materialId: m.id,
              plantId: p,
              status: c.jodPerKg ? 'ok' : 'not_convertible',
              priceId: c.id!,
              supplierId: c.supplierId!,
              price: c.price!,
              unit: c.unit!,
              includesDelivery: c.includesDelivery!,
              effectiveFrom: c.effectiveFrom!,
              jodPerKg: c.jodPerKg ?? null,
            });
        }
      const [snap] = await tx
        .insert(schema.priceSnapshots)
        .values({
          tenantId: auth.tenantId,
          name: body.name,
          asOf,
          plantIds,
          lineCount: lines.length,
          contentHash: lineHash(lines),
          createdBy: auth.user.id,
        })
        .returning();
      for (let i = 0; i < lines.length; i += 1000)
        await tx
          .insert(schema.priceSnapshotLines)
          .values(lines.slice(i, i + 1000).map((l) => ({ ...l, snapshotId: snap!.id })));
      await audit.record({
        action: 'price.snapshot',
        entityType: 'price_snapshot',
        entityId: snap!.id,
        after: { name: body.name, asOf, lines: lines.length, hash: snap!.contentHash },
      });
      return {
        id: snap!.id,
        name: snap!.name,
        asOf,
        lineCount: lines.length,
        contentHash: snap!.contentHash,
      };
    },
  );

  api.get(
    '/api/price-snapshots',
    { summary: 'List price snapshots', capability: 'price.view' },
    async ({ auth, db }) => {
      const rows = await db
        .select()
        .from(schema.priceSnapshots)
        .where(eq(schema.priceSnapshots.tenantId, auth.tenantId))
        .orderBy(desc(schema.priceSnapshots.createdAt));
      const visible = new Set((await visiblePlants(db, auth)).map((p) => p.id));
      return rows
        .filter((s) => (s.plantIds as string[]).every((p) => visible.has(p)))
        .map((s) => ({
          id: s.id,
          name: s.name,
          asOf: s.asOf,
          lineCount: s.lineCount,
          contentHash: s.contentHash,
          createdAt: s.createdAt,
        }));
    },
  );

  api.get(
    '/api/price-snapshots/:id',
    {
      summary: 'One snapshot with its lines and an integrity check',
      capability: 'price.view',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const [s] = await db
        .select()
        .from(schema.priceSnapshots)
        .where(
          and(
            eq(schema.priceSnapshots.id, params.id),
            eq(schema.priceSnapshots.tenantId, auth.tenantId),
          ),
        );
      const visible = new Set((await visiblePlants(db, auth)).map((p) => p.id));
      if (!s || !(s.plantIds as string[]).every((p) => visible.has(p)))
        throw notFound('Snapshot not found');
      const lines = await db
        .select()
        .from(schema.priceSnapshotLines)
        .where(eq(schema.priceSnapshotLines.snapshotId, s.id))
        .orderBy(asc(schema.priceSnapshotLines.materialId));
      return { ...s, lines, hashOk: lineHash(lines as unknown as SnapLine[]) === s.contentHash };
    },
  );
}

interface SnapLine {
  materialId: string;
  plantId: string;
  status: 'ok' | 'unavailable' | 'ambiguous' | 'not_convertible';
  priceId: string | null;
  supplierId: string | null;
  price: string | null;
  unit: PriceUnit | string | null;
  includesDelivery: boolean | null;
  effectiveFrom: string | null;
  jodPerKg: string | null;
}
interface ImportRow {
  line: number;
  status: 'ok' | 'unchanged' | 'error';
  errors: string[];
  entry: Entry | undefined;
  previous: string | null;
}
