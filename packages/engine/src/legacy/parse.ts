import { formatDecimal, multiply, parseDecimal } from '../prices/decimal';
import { normalizeName } from './normalize';

export const LEGACY_COLUMNS = [
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
] as const;
export type LegacyColumn = (typeof LEGACY_COLUMNS)[number];
export const REQUIRED_COLUMNS: readonly LegacyColumn[] = ['design_code', 'plant_code', 'fc_mpa', 'material_name', 'material_category', 'quantity', 'unit'];

const ALIASES: Record<LegacyColumn, string[]> = {
  design_code: ['design code', 'code', 'رمز التصميم', 'رمز الخلطة', 'كود'],
  plant_code: ['plant code', 'plant', 'المصنع', 'رمز المصنع'],
  design_name: ['design name', 'name', 'اسم التصميم', 'اسم الخلطة'],
  fc_mpa: ['fc mpa', 'fc', 'strength', 'المقاومة'],
  strength_basis: ['strength basis', 'basis', 'أساس المقاومة'],
  test_age_days: ['test age days', 'test age', 'age days', 'عمر الفحص'],
  exposure_classes: ['exposure classes', 'exposure', 'فئات التعرض', 'التعرض'],
  slump_mm: ['slump mm', 'slump', 'الهبوط'],
  nmas_mm: ['nmas mm', 'nmas', 'المقاس الاعتباري الأقصى'],
  pumpable: ['pumpable', 'قابل للضخ'],
  material_name: ['material name', 'material', 'المادة', 'اسم المادة'],
  material_category: ['material category', 'category', 'فئة المادة'],
  quantity: ['quantity', 'qty', 'الكمية'],
  unit: ['unit', 'الوحدة'],
  approval_reference: ['approval reference', 'approval ref', 'مرجع الاعتماد'],
  currently_in_production: ['currently in production', 'in production', 'قيد الإنتاج'],
  avg_monthly_volume_m3: ['avg monthly volume m3', 'monthly volume', 'average monthly volume', 'متوسط الإنتاج الشهري'],
};

const key = (s: string) => normalizeName(s.replace(/[_/]+/g, ' '));

export type Mapping = Partial<Record<LegacyColumn, number>>;

/** Detects which file column holds which Appendix D field (header names in English or Arabic). */
export function detectMapping(header: readonly string[]): { mapping: Mapping; missing: LegacyColumn[] } {
  const mapping: Mapping = {};
  header.forEach((h, i) => {
    const k = key(h);
    for (const col of LEGACY_COLUMNS) {
      if (mapping[col] !== undefined) continue;
      if (key(col) === k || ALIASES[col].some((a) => key(a) === k)) mapping[col] = i;
    }
  });
  return { mapping, missing: REQUIRED_COLUMNS.filter((c) => mapping[c] === undefined) };
}

export const CATEGORIES_IMPORT = ['cement', 'scm', 'fine_agg', 'coarse_agg', 'water', 'admixture'] as const;
export type ImportCategory = (typeof CATEGORIES_IMPORT)[number];
export const EXPOSURE_PATTERN = /^(F[0-3]|S[0-3]|W[0-2]|C[0-2])$/;
export const STRENGTH_BASES = ['cylinder', 'cube', 'b_grade'] as const;
export type StrengthBasis = (typeof STRENGTH_BASES)[number];

export interface LegacyLine {
  /** 1-based line number in the file (header = 1). */
  line: number;
  materialName: string;
  category: ImportCategory;
  /** Decimal string as typed (after digit/comma normalization). */
  quantity: string;
  unit: 'kg/m3' | 'L/m3';
}
export interface LegacyDesign {
  code: string;
  plantCode: string;
  name: string;
  fcMpa: number | null;
  basis: StrengthBasis | null;
  testAgeDays: number | null;
  exposure: string[];
  slumpMm: number | null;
  nmasMm: number | null;
  pumpable: boolean | null;
  approvalReference: string | null;
  inProduction: boolean | null;
  avgMonthlyVolumeM3: string | null;
  lines: LegacyLine[];
  firstLine: number;
  errors: { code: string; line?: number; detail?: string }[];
  warnings: { code: string; line?: number; detail?: string }[];
}

const latin = (s: string) => s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/٫/g, '.');
const num = (s: string): number | null => {
  const t = latin(s).trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
const bool = (s: string): boolean | null => {
  const k = s.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'نعم'].includes(k)) return true;
  if (['false', 'no', 'n', '0', 'لا'].includes(k)) return false;
  return null;
};
const basisOf = (s: string): StrengthBasis | null => {
  const k = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (['cylinder', 'cyl', 'اسطوانة', 'أسطوانة'].includes(k)) return 'cylinder';
  if (['cube', 'مكعب'].includes(k)) return 'cube';
  if (['bgrade', 'b', 'bgr'].includes(k)) return 'b_grade';
  return null;
};
const categoryOf = (s: string): ImportCategory | null => {
  const k = s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map: Record<string, ImportCategory> = {
    cement: 'cement', إسمنت: 'cement', اسمنت: 'cement',
    scm: 'scm', pozzolan: 'scm',
    fine_agg: 'fine_agg', fine_aggregate: 'fine_agg', fine: 'fine_agg', ركام_ناعم: 'fine_agg',
    coarse_agg: 'coarse_agg', coarse_aggregate: 'coarse_agg', coarse: 'coarse_agg', ركام_خشن: 'coarse_agg',
    water: 'water', ماء: 'water',
    admixture: 'admixture', إضافة: 'admixture', اضافة: 'admixture',
  };
  return map[k] ?? null;
};
const unitOf = (s: string): 'kg/m3' | 'L/m3' | null => {
  const k = s.trim().toLowerCase().replace(/\s+/g, '').replace('³', '3');
  if (['kg/m3', 'kg/m^3', 'كغم/م3'].includes(k)) return 'kg/m3';
  if (['l/m3', 'lt/m3', 'litre/m3', 'liter/m3', 'لتر/م3'].includes(k)) return 'L/m3';
  return null;
};

export interface ParseOutput {
  designs: LegacyDesign[];
  fileErrors: string[];
}

/** Groups the long-format rows into designs and validates everything that needs no code rules. */
export function parseLegacyRows(rows: readonly (readonly string[])[], mapping: Mapping): ParseOutput {
  const fileErrors: string[] = [];
  const missing = REQUIRED_COLUMNS.filter((c) => mapping[c] === undefined);
  if (missing.length) return { designs: [], fileErrors: missing.map((c) => `missing_column:${c}`) };
  const get = (r: readonly string[], c: LegacyColumn) => (mapping[c] === undefined ? '' : (r[mapping[c]!] ?? '').trim());
  const byCode = new Map<string, LegacyDesign>();
  rows.forEach((r, idx) => {
    if (r.every((c) => !String(c ?? '').trim())) return;
    const line = idx + 2;
    const code = get(r, 'design_code');
    if (!code) {
      fileErrors.push(`line ${line}: design_code is empty`);
      return;
    }
    let d = byCode.get(code);
    if (!d) {
      d = {
        code, plantCode: '', name: '', fcMpa: null, basis: null, testAgeDays: null, exposure: [], slumpMm: null, nmasMm: null,
        pumpable: null, approvalReference: null, inProduction: null, avgMonthlyVolumeM3: null, lines: [], firstLine: line, errors: [], warnings: [],
      };
      byCode.set(code, d);
    }
    const err = (c: string, detail?: string) => d!.errors.push({ code: c, line, ...(detail && { detail }) });
    // header fields: first non-empty value wins; a later conflicting value is an error
    const head = <T,>(name: string, raw: string, parse: (s: string) => T | null, current: T | null, set: (v: T) => void, bad: string) => {
      if (!raw) return;
      const v = parse(raw);
      if (v === null) return err(bad, raw);
      if (current === null || current === '') set(v);
      else if (current !== v && !(Array.isArray(v) && JSON.stringify(v) === JSON.stringify(current))) err('conflicting_header', name);
    };
    head('plant_code', get(r, 'plant_code'), (s) => s, d.plantCode || null, (v) => (d!.plantCode = v), 'bad_plant');
    head('design_name', get(r, 'design_name'), (s) => s, d.name || null, (v) => (d!.name = v), 'bad_name');
    head('fc_mpa', get(r, 'fc_mpa'), num, d.fcMpa, (v) => (d!.fcMpa = v), 'bad_fc');
    head('strength_basis', get(r, 'strength_basis'), basisOf, d.basis, (v) => (d!.basis = v), 'bad_basis');
    head('test_age_days', get(r, 'test_age_days'), num, d.testAgeDays, (v) => (d!.testAgeDays = v), 'bad_test_age');
    head('slump_mm', get(r, 'slump_mm'), num, d.slumpMm, (v) => (d!.slumpMm = v), 'bad_slump');
    head('nmas_mm', get(r, 'nmas_mm'), num, d.nmasMm, (v) => (d!.nmasMm = v), 'bad_nmas');
    head('pumpable', get(r, 'pumpable'), bool, d.pumpable, (v) => (d!.pumpable = v), 'bad_pumpable');
    head('approval_reference', get(r, 'approval_reference'), (s) => s, d.approvalReference, (v) => (d!.approvalReference = v), 'bad_reference');
    head('currently_in_production', get(r, 'currently_in_production'), bool, d.inProduction, (v) => (d!.inProduction = v), 'bad_in_production');
    head(
      'avg_monthly_volume_m3',
      get(r, 'avg_monthly_volume_m3'),
      (s) => {
        const n = num(s);
        return n === null ? null : String(n);
      },
      d.avgMonthlyVolumeM3,
      (v) => (d!.avgMonthlyVolumeM3 = v),
      'bad_volume',
    );
    const ex = get(r, 'exposure_classes');
    if (ex) {
      const classes = ex.split(/[;,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      const bad = classes.filter((c) => !EXPOSURE_PATTERN.test(c));
      if (bad.length) err('bad_exposure', bad.join(';'));
      else if (d.exposure.length === 0) d.exposure = classes;
      else if (JSON.stringify(d.exposure) !== JSON.stringify(classes)) err('conflicting_header', 'exposure_classes');
    }
    // the line itself
    const name = get(r, 'material_name');
    const cat = categoryOf(get(r, 'material_category'));
    const qRaw = latin(get(r, 'quantity')).trim().replace(',', '.');
    const unit = unitOf(get(r, 'unit'));
    if (!name) err('material_name_empty');
    if (!cat) err('bad_category', get(r, 'material_category'));
    if (!unit) err('bad_unit', get(r, 'unit'));
    const q = /^\d{1,9}(\.\d{1,6})?$/.test(qRaw) ? qRaw : null;
    if (q === null || Number(q) <= 0) err('bad_quantity', get(r, 'quantity'));
    if (name && cat && unit && q !== null && Number(q) > 0) {
      if (d.lines.some((l) => normalizeName(l.materialName) === normalizeName(name) && l.category === cat)) err('duplicate_material', name);
      d.lines.push({ line, materialName: name, category: cat, quantity: q, unit });
    }
  });
  const out = [...byCode.values()];
  for (const d of out) {
    const e = (c: string) => d.errors.push({ code: c });
    if (!d.plantCode) e('plant_required');
    if (d.fcMpa === null || d.fcMpa <= 0) e('fc_required');
    if (d.testAgeDays === null) d.warnings.push({ code: 'test_age_missing' });
    if (!d.lines.some((l) => l.category === 'cement')) e('no_cement');
    if (!d.lines.some((l) => l.category === 'water')) e('no_water');
  }
  return { designs: out, fileErrors };
}

/** Litres → kg through the specific gravity (kg per litre). Exact decimal arithmetic; no SG, no guess. */
export function litresToKg(litres: string, sg: number | null | undefined): string | null {
  if (!sg || !(sg > 0)) return null;
  const q = parseDecimal(litres);
  const s = parseDecimal(sg.toFixed(6));
  if (q === null || s === null) return null;
  return formatDecimal(multiply(q, s), 3);
}
