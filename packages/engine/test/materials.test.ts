import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  adHocMaterialSchema,
  blockers,
  declaredKeyFields,
  detectDrift,
  DEFAULT_SANITY,
  fineModulus,
  freshness,
  isKnownSieve,
  overallSource,
  parseGradationPaste,
  parseProperties,
  parseSieve,
  readiness,
  sanityWarnings,
  sieveLabel,
  validateGradation,
  validateWaterReduction,
  type GradationPoint,
} from '../src/index';

const pts = (rows: [number, number][]): GradationPoint[] => rows.map(([sieve_mm, passing_pct]) => ({ sieve_mm, passing_pct }));

// Hand computed: retained 0,5,20,40,60,85,95 = 305 → FM 3.05 (sieves coarser than 9.5 pass 100%).
const SAND = pts([[9.5, 100], [4.75, 95], [2.36, 80], [1.18, 60], [0.6, 40], [0.3, 15], [0.15, 5]]);

describe('sieves', () => {
  it('parses mm, microns, US labels and variants', () => {
    expect(parseSieve('4.75')).toBe(4.75);
    expect(parseSieve('4,75 mm')).toBe(4.75);
    expect(parseSieve('300 µm')).toBe(0.3);
    expect(parseSieve('No. 4')).toBe(4.75);
    expect(parseSieve('#4')).toBe(4.75);
    expect(parseSieve('no4')).toBe(4.75);
    expect(parseSieve('3/8"')).toBe(9.5);
    expect(parseSieve('3/8 inch')).toBe(9.5);
    expect(parseSieve('')).toBeNull();
    expect(parseSieve('abc')).toBeNull();
    expect(parseSieve('0 mm')).toBeNull();
  });
  it('knows standard sieves and labels them', () => {
    expect(isKnownSieve(4.75)).toBe(true);
    expect(isKnownSieve(5)).toBe(false);
    expect(sieveLabel(4.75)).toBe('4.75 mm (No. 4)');
    expect(sieveLabel(8)).toBe('8 mm');
  });
});

describe('fineness modulus', () => {
  it('computes a hand-calculated sand', () => {
    const r = fineModulus(SAND);
    expect(r).toEqual({ ok: true, fm: expect.closeTo(3.05, 9) });
  });
  it('uses explicit coarse sieves too', () => {
    const r = fineModulus([...pts([[150, 100], [75, 100], [37.5, 100], [19, 100]]), ...SAND]);
    expect(r).toEqual({ ok: true, fm: expect.closeTo(3.05, 9) });
  });
  it('infers 0% retained above a 100%-passing sieve and 100% retained below a 0%-passing sieve', () => {
    // 150…9.5 pass everything (0 retained); 4.75 retains all; 2.36…0.15 are below it (5 × 100) → 600/100
    expect(fineModulus(pts([[9.5, 100], [4.75, 0]]))).toEqual({ ok: true, fm: expect.closeTo(6, 9) });
    expect(fineModulus(pts([[9.5, 100], [4.75, 0]]), [9.5, 4.75, 2.36])).toEqual({ ok: true, fm: expect.closeTo(2, 9) });
  });
  it('reports the missing sieves instead of guessing', () => {
    const r = fineModulus(pts([[4.75, 90], [2.36, 70]]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain(0.15);
  });
});

describe('gradation validation', () => {
  it('accepts a good gradation', () => expect(validateGradation(SAND)).toEqual([]));
  it.each([
    ['too_few_points', pts([[4.75, 100]])],
    ['unknown_sieve', pts([[5, 100], [2.36, 50]])],
    ['duplicate_sieve', pts([[4.75, 100], [4.75, 100]])],
    ['out_of_range', pts([[4.75, 100], [2.36, 120]])],
    ['not_monotonic', pts([[4.75, 100], [2.36, 50], [1.18, 60]])],
    ['top_not_100', pts([[4.75, 90], [2.36, 50]])],
  ] as const)('rejects %s', (code, input) => {
    expect(validateGradation(input).map((e) => e.code)).toContain(code);
  });
  it('property: any non-increasing 100-topped series passes; a rise is rejected', () => {
    const sieves = [9.5, 4.75, 2.36, 1.18, 0.6, 0.3, 0.15];
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 7, maxLength: 7 }), (vals) => {
        const desc = [...vals].sort((a, b) => b - a);
        desc[0] = 100;
        expect(validateGradation(pts(sieves.map((s, i) => [s, desc[i]!])))).toEqual([]);
        const rising = pts(sieves.map((s, i) => [s, desc[i]!]));
        rising[3]!.passing_pct = Math.min(100, rising[2]!.passing_pct + 1);
        if (rising[2]!.passing_pct < 100) expect(validateGradation(rising).map((e) => e.code)).toContain('not_monotonic');
      }),
    );
  });
  it('property: FM stays within [0, 11] and is order independent for valid gradations', () => {
    const sieves = [150, 75, 37.5, 19, 9.5, 4.75, 2.36, 1.18, 0.6, 0.3, 0.15];
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 11, maxLength: 11 }), (vals) => {
        const desc = [...vals].sort((a, b) => b - a);
        const a = pts(sieves.map((s, i) => [s, desc[i]!]));
        const r1 = fineModulus(a);
        const r2 = fineModulus([...a].reverse());
        expect(r1.ok && r2.ok).toBe(true);
        if (r1.ok && r2.ok) {
          expect(r1.fm).toBeGreaterThanOrEqual(0);
          expect(r1.fm).toBeLessThanOrEqual(11);
          expect(r1.fm).toBeCloseTo(r2.fm, 9);
        }
      }),
    );
  });
});

describe('paste parser', () => {
  it('reads an Excel row pair', () => {
    const r = parseGradationPaste('9.5\t4.75\t2.36\t1.18\t0.6\t0.3\t0.15\n100\t95\t80\t60\t40\t15\t5');
    expect(r.errors).toEqual([]);
    expect(r.points).toHaveLength(7);
    expect(r.points[0]).toEqual({ sieve_mm: 9.5, passing_pct: 100 });
    expect(r.assumptions.join(' ')).toMatch(/PASSING/);
  });
  it('reads a two-column table with a header, labels and percent signs', () => {
    const r = parseGradationPaste('Sieve\t% passing\nNo. 4\t95 %\nNo. 8\t80%\n3/8"\t100');
    expect(r.errors).toEqual([]);
    expect(r.points.map((p) => p.sieve_mm)).toEqual([9.5, 4.75, 2.36]);
    expect(r.assumptions.join(' ')).toMatch(/header/);
  });
  it('reads Arabic-Indic digits and decimal commas', () => {
    const r = parseGradationPaste('٤٫٧٥\t٩٥٫٥\n٢٫٣٦\t٨٠');
    expect(r.errors).toEqual([]);
    expect(r.points).toEqual([
      { sieve_mm: 4.75, passing_pct: 95.5 },
      { sieve_mm: 2.36, passing_pct: 80 },
    ]);
    const c = parseGradationPaste('4,75;95,5\n2,36;80');
    expect(c.points[0]).toEqual({ sieve_mm: 4.75, passing_pct: 95.5 });
  });
  it('reads comma separated pairs', () => {
    expect(parseGradationPaste('4.75,95\n2.36,80').points).toHaveLength(2);
  });
  it('reports malformed input instead of guessing', () => {
    expect(parseGradationPaste('').errors).toEqual(['nothing to parse']);
    expect(parseGradationPaste('a\tb\tc').errors.length).toBeGreaterThan(0);
    expect(parseGradationPaste('4.75\tabc\nxyz\t80').errors).toHaveLength(2);
    expect(parseGradationPaste('1\t2\t3\n4\t5').errors.length).toBeGreaterThan(0);
  });
});

describe('properties', () => {
  it('accepts valid aggregate props and rejects unknown keys and bad values', () => {
    expect(parseProperties('fine_agg', { sg_ssd: 2.6, absorption_pct: 1.2 }).ok).toBe(true);
    expect(parseProperties('fine_agg', { sg_ssd: 2.6, bogus: 1 }).ok).toBe(false);
    const bad = parseProperties('coarse_agg', { sg_ssd: -1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]!.path).toBe('sg_ssd');
  });
  it('validates admixture water-reduction tables', () => {
    expect(validateWaterReduction({})).toEqual([]);
    expect(validateWaterReduction({ water_reduction_table: [{ dosage_pct: 0.5, water_reduction_pct: 5 }] }).length).toBe(1);
    const ok = { min_dosage_pct: 0.3, max_dosage_pct: 1.5, water_reduction_table: [{ dosage_pct: 0.5, water_reduction_pct: 5 }, { dosage_pct: 1, water_reduction_pct: 10 }, { dosage_pct: 1.5, water_reduction_pct: 15 }] };
    expect(validateWaterReduction(ok)).toEqual([]);
    const messy = { min_dosage_pct: 2, max_dosage_pct: 1, water_reduction_table: [{ dosage_pct: 1, water_reduction_pct: 5 }, { dosage_pct: 1, water_reduction_pct: 6 }, { dosage_pct: 3, water_reduction_pct: 7 }] };
    expect(validateWaterReduction(messy).map((e) => e.message).join('|')).toMatch(/ascending.*maximum|maximum.*ascending/s);
  });
});

describe('readiness minimum sets (07 §2.2)', () => {
  it('aggregate: SG + absorption evaluates, gradation designs', () => {
    const r = readiness('fine_agg', { sg_ssd: 2.6, absorption_pct: 1.2 });
    expect(r.canEvaluate).toBe(true);
    expect(r.canDesign).toBe(false);
    expect(r.design.map((b) => b.field)).toEqual(['sieve_analysis', 'finer_75um_pct']);
  });
  it('aggregate: complete data designs', () => {
    const r = readiness('coarse_agg', { sg_ssd: 2.65, absorption_pct: 0.8, finer_75um_pct: 0.5, sieve_analysis: [...SAND, ...pts([[150, 100], [75, 100], [37.5, 100], [19, 100]])].sort((a, b) => b.sieve_mm - a.sieve_mm) });
    expect(r.canDesign).toBe(true);
  });
  it('flags an invalid or FM-incomputable gradation', () => {
    expect(blockers('fine_agg', { sg_ssd: 2.6, absorption_pct: 1, finer_75um_pct: 2, sieve_analysis: pts([[4.75, 90], [2.36, 95]]) }, 'design')[0]).toMatchObject({ code: 'invalid' });
    const b = blockers('fine_agg', { sg_ssd: 2.6, absorption_pct: 1, finer_75um_pct: 2, sieve_analysis: pts([[4.75, 100], [2.36, 90]]) }, 'design');
    expect(b[0]).toMatchObject({ field: 'fineness_modulus', code: 'missing' });
  });
  it('cement: C3A and alkali are required only when the context asks', () => {
    expect(readiness('cement', { sg: 3.15 }).canDesign).toBe(true);
    expect(blockers('cement', { sg: 3.15 }, 'design', { sulfateGoverns: true, asrActive: true }).map((b) => b.field)).toEqual(['c3a_pct', 'alkali_na2o_eq_pct']);
  });
  it('scm, admixture, water, fiber', () => {
    expect(readiness('scm', {}).evaluate.map((b) => b.field)).toEqual(['scm_type', 'sg']);
    expect(blockers('scm', { scm_type: 'fly_ash', sg: 2.2 }, 'design', { asrActive: true })[0]!.field).toBe('alkali_na2o_eq_pct');
    const adm = readiness('admixture', { type: 'F', sg: 1.1, solids_pct: 40 });
    expect(adm.canEvaluate).toBe(true);
    expect(adm.design.map((b) => b.field)).toEqual(['min_dosage_pct', 'max_dosage_pct', 'water_reduction_table']);
    expect(blockers('admixture', { type: 'F', sg: 1.1, solids_pct: 40, min_dosage_pct: 0.3, max_dosage_pct: 1.5, water_reduction_table: [{}, {}] }, 'design')[0]).toMatchObject({ code: 'invalid' });
    expect(readiness('water', { water_source: 'municipal', sg: 1 }).canEvaluate).toBe(false); // SG not confirmed
    expect(readiness('water', { water_source: 'municipal', sg: 1, sg_confirmed: true }).canEvaluate).toBe(true);
    expect(blockers('water', { water_source: 'recycled', sg: 1, sg_confirmed: true }, 'design', { recycledWater: true })[0]!.field).toBe('chloride_mg_l');
    expect(readiness('fiber', {}).canEvaluate).toBe(false);
    expect(readiness('pigment', { sg: 2 }).canEvaluate).toBe(true);
  });
  it('lists user-declared key fields only', () => {
    const props = { sg_ssd: 2.6, absorption_pct: 1.2, la_abrasion_pct: 30 };
    const prov = { sg_ssd: 'user_declared', absorption_pct: 'lab_report', la_abrasion_pct: 'user_declared' } as const;
    expect(declaredKeyFields('fine_agg', props, prov)).toEqual(['sg_ssd']);
    expect(declaredKeyFields('cement', { sg: 3.15 }, { sg: 'user_declared' })).toEqual(['sg']);
  });
  it('record source is the weakest field source', () => {
    expect(overallSource({}, 'lab_report')).toBe('lab_report');
    expect(overallSource({ a: 'lab_report', b: 'supplier_datasheet' }, 'lab_report')).toBe('supplier_datasheet');
    expect(overallSource({ a: 'lab_report', b: 'user_declared', c: 'supplier_datasheet' }, 'lab_report')).toBe('user_declared');
  });
});

describe('freshness', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  it('is never "fresh" without a configured limit', () => {
    expect(freshness('2026-09-01', now, null)).toEqual({ status: 'not_configured', ageDays: 30 });
    expect(freshness('2026-09-01', now, undefined).status).toBe('not_configured');
  });
  it('is fresh up to the limit and expired after', () => {
    expect(freshness('2026-09-01', now, 30).status).toBe('fresh');
    expect(freshness('2026-09-01', now, 29)).toMatchObject({ status: 'expired', validUntil: '2026-09-30' });
  });
});

describe('drift', () => {
  const a = { sg_ssd: 2.60, absorption_pct: 1.0, sieve_analysis: SAND };
  it('reports raw deltas when no tolerance is set', () => {
    const d = detectDrift(a, { ...a, sg_ssd: 2.65 }, {});
    expect(d.find((i) => i.field === 'sg_ssd')).toMatchObject({ delta: 0.05, status: 'no_tolerance', tolerance: null });
  });
  it('is within at the tolerance and beyond above it', () => {
    const tol = { sg_ssd: 0.05, absorption_pct: 0.2 };
    const at = detectDrift(a, { ...a, sg_ssd: 2.65 }, tol).find((i) => i.field === 'sg_ssd');
    expect(at?.status).toBe('within');
    const above = detectDrift(a, { ...a, sg_ssd: 2.66, absorption_pct: 0.7 }, tol);
    expect(above.find((i) => i.field === 'sg_ssd')?.status).toBe('beyond');
    expect(above.find((i) => i.field === 'absorption_pct')?.status).toBe('beyond'); // negative delta uses |Δ|
  });
  it('compares computed fineness modulus and skips fields missing on either side', () => {
    const finer = pts([[9.5, 100], [4.75, 100], [2.36, 90], [1.18, 70], [0.6, 50], [0.3, 25], [0.15, 10]]);
    const d = detectDrift(a, { sg_ssd: 2.6, sieve_analysis: finer }, { fm: 0.1 });
    expect(d.map((i) => i.field)).toEqual(['sg_ssd', 'fm']);
    expect(d[1]).toMatchObject({ status: 'beyond' });
    expect(detectDrift({ sieve_analysis: pts([[4.75, 90]]) }, a, {}).some((i) => i.field === 'fm')).toBe(false);
    expect(detectDrift({ sg_ssd: 2.6 }, { absorption_pct: 1 }, {})).toEqual([]);
  });
});

describe('sanity ranges (warn only)', () => {
  it('warns outside the range and ignores unconfigured keys', () => {
    expect(sanityWarnings('fine_agg', { sg_ssd: 2.65, absorption_pct: 1 }, DEFAULT_SANITY)).toEqual([]);
    expect(sanityWarnings('coarse_agg', { sg_ssd: 3.5, absorption_pct: 9 }, DEFAULT_SANITY).map((w) => w.field)).toEqual(['sg_ssd', 'absorption_pct']);
    expect(sanityWarnings('coarse_agg', { sg_ssd: 3.5 }, {})).toEqual([]);
    expect(sanityWarnings('cement', { sg: 9 }, DEFAULT_SANITY)).toEqual([]);
    expect(sanityWarnings('fine_agg', { sg_ssd: 2.0 }, { aggregate_sg_ssd: { max: 3 } })).toEqual([]);
  });
});

describe('ad-hoc material', () => {
  it('validates properties through the category schema', () => {
    expect(adHocMaterialSchema.safeParse({ category: 'fine_agg', market_name_en: 'Test sand', properties: { sg_ssd: 2.6 }, price_jod_per_kg: '0.012' }).success).toBe(true);
    expect(adHocMaterialSchema.safeParse({ category: 'fine_agg', market_name_en: 'x', properties: { sg_ssd: -1 } }).success).toBe(false);
    expect(adHocMaterialSchema.safeParse({ category: 'fine_agg', market_name_en: 'x', properties: {}, price_jod_per_kg: '0.1.2' }).success).toBe(false);
  });
});
