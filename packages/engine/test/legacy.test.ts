import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detectMapping, litresToKg, matchMaterial, normalizeName, parseLegacyRows, similarity, type Mapping } from '../src/index';

describe('normalizeName', () => {
  it('removes spelling noise but keeps names distinct', () => {
    expect(normalizeName('  فُولِيّة ')).toBe(normalizeName('فوليه'));
    expect(normalizeName('إسمنت')).toBe(normalizeName('اسمنت'));
    expect(normalizeName('رمــل')).toBe('رمل'); // tatweel
    expect(normalizeName('عدسية ٢٠ ملم')).toBe(normalizeName('عدسيه 20 ملم'));
    expect(normalizeName('CEM I 42.5N')).toBe('cem i 42 5n');
    expect(normalizeName('مؤسسة')).toBe(normalizeName('موسسه'));
    expect(normalizeName('فولية')).not.toBe(normalizeName('حمصية'));
  });
  it('property: idempotent and never empty for non-empty letters', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 30 }), (s) => {
      const n = normalizeName(s);
      expect(normalizeName(n)).toBe(n);
    }));
  });
  it('similarity orders near names above unrelated ones', () => {
    expect(similarity('فولية', 'فولية')).toBe(1);
    expect(similarity('عدسية 20', 'عدسية 25')).toBeGreaterThan(similarity('عدسية 20', 'حمصية'));
    expect(similarity('', 'x')).toBe(0);
    expect(similarity('a', 'a')).toBe(1);
  });
});

describe('matchMaterial: only an exact normalized match is pre-selected', () => {
  const lib = [
    { id: 'foulieh', category: 'coarse_agg', names: ['فولية', 'Fouliyeh'] },
    { id: 'hummusieh', category: 'coarse_agg', names: ['حمصية', 'Hummusiyeh'] },
    { id: 'adasiyeh', category: 'coarse_agg', names: ['عدسية', null] },
    { id: 'foul-sand', category: 'fine_agg', names: ['فولية'] },
  ];
  it('exact (with spelling variants) in the same category', () => {
    expect(matchMaterial('فُوليَّة', 'coarse_agg', lib).exactId).toBe('foulieh');
    expect(matchMaterial('FOULIYEH', 'coarse_agg', lib).exactId).toBe('foulieh');
  });
  it('near names and wrong categories are suggestions, never auto-selected', () => {
    const r = matchMaterial('فولية 19', 'coarse_agg', lib);
    expect(r.exactId).toBeNull();
    expect(r.suggestions[0]!.id).toBe('foulieh');
    const wrong = matchMaterial('فولية', 'cement', lib);
    expect(wrong.exactId).toBeNull();
    expect(wrong.suggestions.every((s) => s.categoryMismatch)).toBe(true);
  });
  it('two exact candidates are ambiguous; unknown names get no suggestion', () => {
    const dup = [...lib, { id: 'foulieh2', category: 'coarse_agg', names: ['فولية'] }];
    expect(matchMaterial('فولية', 'coarse_agg', dup)).toMatchObject({ exactId: null, ambiguous: true });
    expect(matchMaterial('zzzz', 'coarse_agg', lib).suggestions).toEqual([]);
    expect(matchMaterial('', 'coarse_agg', lib).exactId).toBeNull();
  });
});

const HEADER = ['design_code', 'plant_code', 'design_name', 'fc_mpa', 'strength_basis', 'test_age_days', 'exposure_classes', 'slump_mm', 'nmas_mm', 'pumpable', 'material_name', 'material_category', 'quantity', 'unit', 'approval_reference', 'currently_in_production', 'avg_monthly_volume_m3'];
const row = (o: Record<string, string>): string[] => HEADER.map((h) => o[h] ?? '');
const base = { design_code: 'AMM01-C30', plant_code: 'AMM-01', design_name: 'C30 pump', fc_mpa: '30', strength_basis: 'cylinder', test_age_days: '28', exposure_classes: 'F0;S0;W0;C1', slump_mm: '125', nmas_mm: '19', pumpable: 'true', approval_reference: 'Submittal 2025-14', currently_in_production: 'true', avg_monthly_volume_m3: '2400' };
const mapping = detectMapping(HEADER).mapping;
const ok = [
  row({ ...base, material_name: 'إسمنت', material_category: 'cement', quantity: '360', unit: 'kg/m3' }),
  row({ ...base, material_name: 'ماء', material_category: 'water', quantity: '175', unit: 'kg/m3' }),
  row({ ...base, material_name: 'فولية', material_category: 'coarse_agg', quantity: '٦١٠٫٥', unit: 'kg/m3' }),
];

describe('detectMapping', () => {
  it('maps English headers, Arabic aliases and reports missing required columns', () => {
    expect(detectMapping(HEADER).missing).toEqual([]);
    const ar = detectMapping(['رمز التصميم', 'المصنع', 'المقاومة', 'اسم المادة', 'فئة المادة', 'الكمية', 'الوحدة']);
    expect(ar.missing).toEqual([]);
    expect(detectMapping(['design code', 'Plant', 'FC', 'material', 'category', 'qty', 'unit']).missing).toEqual([]);
    expect(detectMapping(['design_code', 'price']).missing).toContain('plant_code');
  });
});

describe('parseLegacyRows', () => {
  it('groups lines into one design with parsed headers (digits, decimal comma)', () => {
    const { designs, fileErrors } = parseLegacyRows(ok, mapping);
    expect(fileErrors).toEqual([]);
    expect(designs).toHaveLength(1);
    const d = designs[0]!;
    expect(d.errors).toEqual([]);
    expect(d).toMatchObject({ code: 'AMM01-C30', plantCode: 'AMM-01', fcMpa: 30, basis: 'cylinder', testAgeDays: 28, exposure: ['F0', 'S0', 'W0', 'C1'], slumpMm: 125, nmasMm: 19, pumpable: true, inProduction: true, avgMonthlyVolumeM3: '2400' });
    expect(d.lines.map((l) => [l.line, l.quantity])).toEqual([[2, '360'], [3, '175'], [4, '610.5']]);
  });
  it('reports every kind of problem with its line', () => {
    const bad = [
      row({ ...base, material_name: 'إسمنت', material_category: 'cement', quantity: '0', unit: 'kg/m3' }),
      row({ ...base, fc_mpa: '35', material_name: 'ماء', material_category: 'water', quantity: '175', unit: 'lbs' }),
      row({ ...base, exposure_classes: 'X9', material_name: 'ماء', material_category: 'sand', quantity: '1', unit: 'kg/m3' }),
      row({ ...base, material_name: 'إسمنت', material_category: 'cement', quantity: '10', unit: 'kg/m3' }),
      row({ ...base, material_name: 'إسمنت', material_category: 'cement', quantity: '10', unit: 'kg/m3' }),
      row({ ...base, material_name: '', material_category: 'cement', quantity: '10', unit: 'kg/m3' }),
    ];
    const codes = parseLegacyRows(bad, mapping).designs[0]!.errors.map((e) => e.code);
    for (const c of ['bad_quantity', 'conflicting_header', 'bad_unit', 'bad_exposure', 'bad_category', 'duplicate_material', 'material_name_empty', 'no_water']) expect(codes, c).toContain(c);
  });
  it('requires plant, strength, cement and water; warns about a missing test age', () => {
    const r = parseLegacyRows([row({ design_code: 'X', material_name: 'ركام', material_category: 'coarse_agg', quantity: '5', unit: 'kg/m3' })], mapping).designs[0]!;
    expect(r.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['plant_required', 'fc_required', 'no_cement', 'no_water']));
    expect(r.warnings.map((w) => w.code)).toContain('test_age_missing');
  });
  it('skips blank rows, flags a missing design code and a missing column', () => {
    const rows = [row({}), row({ plant_code: 'AMM-01' }), ...ok];
    const r = parseLegacyRows(rows, mapping);
    expect(r.fileErrors[0]).toMatch(/design_code is empty/);
    expect(r.designs).toHaveLength(1);
    expect(parseLegacyRows(ok, {} as Mapping).fileErrors).toContain('missing_column:design_code');
  });
  it('accepts alternative spellings for basis, category, unit and booleans', () => {
    const alt = [
      row({ ...base, strength_basis: 'مكعب', pumpable: 'نعم', currently_in_production: 'no', material_name: 'cem', material_category: 'Cement', quantity: '300', unit: 'Kg/m³' }),
      row({ ...base, strength_basis: 'مكعب', pumpable: 'نعم', currently_in_production: 'no', material_name: 'adm', material_category: 'admixture', quantity: '3,5', unit: 'L/m3' }),
    ];
    const d = parseLegacyRows(alt, mapping).designs[0]!;
    expect(d).toMatchObject({ basis: 'cube', pumpable: true, inProduction: false });
    expect(d.lines.map((l) => l.unit)).toEqual(['kg/m3', 'L/m3']);
    expect(d.lines[1]!.quantity).toBe('3.5');
  });
});

describe('litresToKg', () => {
  it('converts through SG with exact decimals and refuses without one', () => {
    expect(litresToKg('3.5', 1.1)).toBe('3.850');
    expect(litresToKg('10', 1.0)).toBe('10.000');
    expect(litresToKg('3.5', null)).toBeNull();
    expect(litresToKg('3.5', 0)).toBeNull();
    expect(litresToKg('abc', 1.1)).toBeNull();
  });
});
