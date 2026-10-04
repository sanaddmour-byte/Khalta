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

// ---- khalta.batch-weights.v2: production batch PLANS (batch size, rounded weights, reconciliation) ---------------
// v1 is frozen (its header never changes). v2 is a different file for a different job: what to WEIGH for a batch,
// bound to the exact design version, with the age of every moisture reading at the time of export. No cost, ever.

export const BATCH_V2_SCHEMA = 'khalta.batch-weights.v2';

export const BATCH_V2_HEADER = [
  'schema',
  'batch_plan_id',
  'design_code',
  'design_version',
  'design_hash',
  'plant_code',
  'requirements_ref',
  'prepared_at',
  'prepared_by',
  'calc_version',
  'check_versions',
  'batch_size_m3',
  'line_no',
  'material_id',
  'material_name',
  'material_category',
  'material_test_version',
  'design_kg_per_m3_ssd',
  'corrected_kg_per_m3',
  'exact_kg',
  'resolution_kg',
  'weigh_kg',
  'rounding_error_kg',
  'total_moisture_pct',
  'absorption_pct',
  'moisture_source',
  'moisture_measured_at',
  'moisture_age_hours_at_export',
  'plan_exact_total_kg',
  'plan_rounded_total_kg',
  'basis',
] as const;

export interface ExportBatchPlan {
  id: string;
  designCode: string;
  designVersion: number;
  designHash: string;
  plantCode: string;
  /** "<project ref> r<revision>" or empty when the design froze none. */
  requirementsRef: string;
  preparedAt: string;
  preparedBy: string | null;
  calcVersion: string;
  checkVersions: string;
  batchSizeM3: number;
  exactTotalKg: number;
  roundedTotalKg: number;
  lines: {
    lineNo: number;
    materialId: string;
    materialName: string;
    category: string;
    testVersion: number | null;
    designKgPerM3: number;
    correctedKgPerM3: number;
    exactKg: number;
    resolutionKg: number;
    weighKg: number;
    errorKg: number;
    totalMoisturePct: number | null;
    absorptionPct: number | null;
    moistureSource: string | null;
    moistureMeasuredAt: string | null;
    moistureAgeHoursAtExport: number | null;
  }[];
}

export function batchPlanCsv(plans: readonly ExportBatchPlan[]): string {
  const ordered = [...plans].sort(
    (a, b) => a.preparedAt.localeCompare(b.preparedAt) || a.id.localeCompare(b.id),
  );
  const rows: string[][] = [];
  for (const b of ordered)
    for (const l of [...b.lines].sort((x, y) => x.lineNo - y.lineNo))
      rows.push([
        BATCH_V2_SCHEMA,
        b.id,
        text(b.designCode),
        String(b.designVersion),
        b.designHash,
        text(b.plantCode),
        text(b.requirementsRef),
        b.preparedAt,
        text(b.preparedBy),
        text(b.calcVersion),
        text(b.checkVersions),
        n(b.batchSizeM3),
        String(l.lineNo),
        l.materialId,
        text(l.materialName),
        text(l.category),
        l.testVersion === null ? '' : String(l.testVersion),
        n(l.designKgPerM3),
        n(l.correctedKgPerM3),
        n(l.exactKg),
        n(l.resolutionKg),
        n(l.weighKg),
        n(l.errorKg),
        n(l.totalMoisturePct),
        n(l.absorptionPct),
        text(l.moistureSource),
        l.moistureMeasuredAt ?? '',
        n(l.moistureAgeHoursAtExport),
        n(b.exactTotalKg),
        n(b.roundedTotalKg),
        'kg for the whole batch',
      ]);
  return toCsv(BATCH_V2_HEADER, rows);
}
