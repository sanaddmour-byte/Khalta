// `khalta.designs.v1` and `khalta.batch-weights.v1` (docs/contracts/csv-exchange.md). The header rows are FROZEN: a change
// is a new schema version. No cost, price, margin or saving appears in either file, by construction.
import { bool, num, text, toCsv } from './csv';

export const DESIGNS_SCHEMA = 'khalta.designs.v1';
export const BATCH_SCHEMA = 'khalta.batch-weights.v1';

/** Appendix D columns first (the legacy importer reads them), then the exchange columns. */
export const DESIGNS_HEADER = [
  'design_code',
  'plant_code',
  'design_name',
  'fc_mpa',
  'strength_basis',
  'test_age_days',
  'exposure_classes',
  'slump_mm',
  'nmas_mm',
  'pumpable',
  'material_name',
  'material_category',
  'quantity',
  'unit',
  'approval_reference',
  'currently_in_production',
  'avg_monthly_volume_m3',
  'schema',
  'version',
  'status',
  'approved_at',
  'approved_by',
  'design_hash',
  'ruleset_mode',
  'material_id',
  'line_no',
  'quantity_basis',
] as const;

export const BATCH_HEADER = [
  'schema',
  'batch_instance_id',
  'design_code',
  'design_version',
  'plant_code',
  'kind',
  'created_at',
  'created_by',
  'check_verdict',
  'check_version',
  'material_id',
  'material_name',
  'material_category',
  'line_no',
  'kg_ssd',
  'kg_oven_dry',
  'kg_batch',
  'free_water_kg',
  'solution_water_kg',
  'total_moisture_pct',
  'absorption_pct',
  'moisture_measured_at',
  'design_water_kg',
  'batch_water_kg',
  'design_hash',
  'basis',
] as const;

export interface ExportDesign {
  code: string;
  name: string;
  plantCode: string;
  version: number;
  status: 'approved' | 'in_production';
  approvedAt: string | null;
  approvedBy: string | null;
  designHash: string;
  rulesetMode: string | null;
  avgMonthlyVolumeM3: string | null;
  requirements: {
    fcMpa: number | null;
    basis: string | null;
    testAgeDays: number | null;
    exposure: string[];
    slumpMm: number | null;
    nmasMm: number | null;
    pumpable: boolean | null;
  };
  lines: {
    lineNo: number;
    materialId: string;
    materialName: string;
    category: string;
    kgPerM3: string;
  }[];
}

/** Numbers are written as plain decimals (never exponent notation), at most six places. */
const n = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : num(String(+v.toFixed(6)));

export function designsCsv(designs: readonly ExportDesign[]): string {
  const ordered = [...designs].sort(
    (a, b) =>
      a.plantCode.localeCompare(b.plantCode) ||
      a.code.localeCompare(b.code) ||
      a.version - b.version,
  );
  const rows: string[][] = [];
  for (const d of ordered)
    for (const l of [...d.lines].sort((a, b) => a.lineNo - b.lineNo))
      rows.push([
        text(d.code),
        text(d.plantCode),
        text(d.name),
        n(d.requirements.fcMpa),
        text(d.requirements.basis),
        n(d.requirements.testAgeDays),
        text(d.requirements.exposure.join(';')),
        n(d.requirements.slumpMm),
        n(d.requirements.nmasMm),
        bool(d.requirements.pumpable),
        text(l.materialName),
        text(l.category),
        num(l.kgPerM3),
        'kg/m3',
        text(
          `Khalta v${d.version} ${d.status} ${d.approvedAt ? d.approvedAt.slice(0, 10) : ''}`.trim(),
        ),
        bool(d.status === 'in_production'),
        d.avgMonthlyVolumeM3 === null ? '' : num(d.avgMonthlyVolumeM3),
        DESIGNS_SCHEMA,
        String(d.version),
        d.status,
        d.approvedAt ?? '',
        text(d.approvedBy),
        d.designHash,
        text(d.rulesetMode),
        l.materialId,
        String(l.lineNo),
        'kg/m3 SSD',
      ]);
  return toCsv(DESIGNS_HEADER, rows);
}

export interface ExportBatch {
  id: string;
  designCode: string;
  designVersion: number;
  plantCode: string;
  kind: 'production' | 'trial';
  createdAt: string;
  createdBy: string | null;
  checkVerdict: 'pass';
  checkVersion: string;
  designHash: string;
  designWaterKg: number;
  batchWaterKg: number;
  lines: {
    lineNo: number;
    materialId: string;
    materialName: string;
    category: string;
    kgSsd: number;
    kgOvenDry: number | null;
    kgBatch: number;
    freeWaterKg: number | null;
    solutionWaterKg: number | null;
    totalMoisturePct: number | null;
    absorptionPct: number | null;
    moistureMeasuredAt: string | null;
  }[];
}

export function batchCsv(batches: readonly ExportBatch[]): string {
  const ordered = [...batches].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const rows: string[][] = [];
  for (const b of ordered)
    for (const l of [...b.lines].sort((x, y) => x.lineNo - y.lineNo))
      rows.push([
        BATCH_SCHEMA,
        b.id,
        text(b.designCode),
        String(b.designVersion),
        text(b.plantCode),
        b.kind,
        b.createdAt,
        text(b.createdBy),
        b.checkVerdict,
        text(b.checkVersion),
        l.materialId,
        text(l.materialName),
        text(l.category),
        String(l.lineNo),
        n(l.kgSsd),
        n(l.kgOvenDry),
        n(l.kgBatch),
        n(l.freeWaterKg),
        n(l.solutionWaterKg),
        n(l.totalMoisturePct),
        n(l.absorptionPct),
        l.moistureMeasuredAt ?? '',
        n(b.designWaterKg),
        n(b.batchWaterKg),
        b.designHash,
        'kg per m3 of concrete',
      ]);
  return toCsv(BATCH_HEADER, rows);
}
