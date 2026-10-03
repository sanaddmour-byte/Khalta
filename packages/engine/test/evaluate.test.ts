import { describe, expect, it } from 'vitest';
import type { RuleRecord } from '@khalta/rules';
import { evaluate } from '../src/evaluate';
import type { EvaluationReport, EvaluationSnapshot, SnapshotMaterial } from '../src/evaluate';
import { ALL_RULES, LINES, MATERIALS, makeSnapshot } from '../src/testing/synthetic';
import { selectRules } from '../src/evaluate/select';

type OkPrice = Extract<SnapshotMaterial['price'], { status: 'ok' }>;

const run = (over: Partial<EvaluationSnapshot> = {}) => evaluate(makeSnapshot(over));
const chk = (r: EvaluationReport, id: string) => r.checks.find((c) => c.id === id);
const req = (o: Partial<EvaluationSnapshot['request']>) => ({ ...makeSnapshot().request, ...o });
const mat = (id: string, props: Record<string, unknown>, over: Partial<SnapshotMaterial> = {}) =>
  MATERIALS.map((m) =>
    m.id === id
      ? {
          ...m,
          ...over,
          test: m.test ? { ...m.test, properties: { ...m.test.properties, ...props } } : m.test,
        }
      : m,
  );
const dropProp = (id: string, key: string) =>
  MATERIALS.map((m) => {
    if (m.id !== id || !m.test) return m;
    const { [key]: _gone, ...rest } = m.test.properties;
    return { ...m, test: { ...m.test, properties: rest } };
  });
const lines = (over: Record<string, string | null>) =>
  LINES.flatMap((l) =>
    over[l.materialId] === null ? [] : [{ ...l, kgPerM3: over[l.materialId] ?? l.kgPerM3 }],
  );
const rulesFor = (
  mode: 'ACI' | 'JS' | 'BOTH',
  request: EvaluationSnapshot['request'],
  patch: (r: RuleRecord) => RuleRecord = (r) => r,
) => selectRules(ALL_RULES.map(patch), mode, request);

describe('f′cr (ACI 301 §4.2.3.3 no-data equations)', () => {
  it.each([
    [15, 22],
    [20, 27],
    [21, 29.3],
    [30, 38.3],
    [35, 43.3],
    [36, 44.6],
    [40, 49],
  ])('f′c %d MPa → f′cr %d MPa', (fc, expected) => {
    const r = run({ request: req({ fcMpa: fc }) });
    expect(r.strength.fcrMpa).toBeCloseTo(expected, 9);
    expect(r.strength.branches[0]!.branch).toBe('no_data');
  });

  it('adds the configured safety margin and says when none is configured', () => {
    const none = run();
    expect(none.strength.marginConfigured).toBe(false);
    expect(none.dataQuality.map((d) => d.code)).toContain('safety_margin_not_configured');
    const set = run({ settings: { ...makeSnapshot().settings, safetyMarginMpa: 1.5 } });
    expect(set.strength.fcrMpa).toBeCloseTo(39.8, 9);
    expect(set.strength.marginConfigured).toBe(true);
  });

  it('extra margin adds, a fixed f′cr only applies above the code value', () => {
    const extra = run({
      characteristics: [
        {
          key: 'extra_margin_mpa',
          sub: null,
          spec: { mode: 'fixed', value: 2 },
          origin: 'request',
        },
      ],
    });
    expect(extra.strength.fcrMpa).toBeCloseTo(40.3, 9);
    const fixedHigh = run({
      characteristics: [
        { key: 'fcr_mpa', sub: null, spec: { mode: 'fixed', value: 42 }, origin: 'request' },
      ],
    });
    expect(fixedHigh.strength.fcrMpa).toBe(42);
    expect(fixedHigh.trace.find((t) => t.key === 'fcr.total')!.evidence).toContain('USER_OVERRIDE');
    const fixedLow = run({
      characteristics: [
        { key: 'fcr_mpa', sub: null, spec: { mode: 'fixed', value: 30 }, origin: 'request' },
      ],
    });
    expect(fixedLow.strength.fcrMpa).toBeCloseTo(38.3, 9);
  });

  it('statistical branch (reachable once strength records exist): hand-computed', () => {
    const base = makeSnapshot().settings;
    // f'c 30, SD 3, 30 tests (n-factor 1.00): max(30+1.34·3, 30+2.33·3−3.45) = 34.02
    expect(
      run({ strengthRecords: { n: 30, sdMpa: 3, fcMpa: 30 }, settings: base }).strength.fcrMpa,
    ).toBeCloseTo(34.02, 9);
    // 20 tests: n-factor 1.08 → s = 3.24 → 30 + 1.34·3.24 = 34.3416
    expect(run({ strengthRecords: { n: 20, sdMpa: 3, fcMpa: 30 } }).strength.fcrMpa).toBeCloseTo(
      34.3416,
      9,
    );
    // f'c 40 (> 35): max(40 + 1.34·3, 0.9·40 + 2.33·3) = 44.02
    const hi = run({
      request: req({ fcMpa: 40 }),
      strengthRecords: { n: 30, sdMpa: 3, fcMpa: 40 },
    });
    expect(hi.strength.fcrMpa).toBeCloseTo(44.02, 9);
    expect(hi.strength.branches[0]!.branch).toBe('statistical');
    // too few tests, or tests from a different strength level: the no-data equations apply
    expect(
      run({ strengthRecords: { n: 10, sdMpa: 3, fcMpa: 30 } }).strength.branches[0]!.branch,
    ).toBe('no_data');
    expect(
      run({ strengthRecords: { n: 30, sdMpa: 3, fcMpa: 45 } }).strength.branches[0]!.branch,
    ).toBe('no_data');
  });

  it('Both mode: each ruleset is computed and the higher governs; a code with no values is named', () => {
    const request = req({});
    const patch = (r: RuleRecord): RuleRecord => {
      if (r.ruleset !== 'JS') return r;
      const v: Record<string, number> = {
        'fcr.no_data.lower_threshold_mpa': 21,
        'fcr.threshold_mpa': 35,
        'fcr.no_data.lt21.add': 8,
        'fcr.no_data.mid.add': 9.5,
        'fcr.no_data.gt35.factor': 1.15,
        'fcr.no_data.gt35.add': 6,
      };
      return r.key in v ? { ...r, value: v[r.key]! } : r;
    };
    const r = run({ mode: 'BOTH', request, rules: rulesFor('BOTH', request, patch) });
    expect(r.strength.governingRuleset).toBe('JS');
    expect(r.strength.fcrMpa).toBeCloseTo(39.5, 9);
    expect(r.strength.branches.map((b) => b.value)).toEqual([38.3, 39.5]);
    const onlyAci = run({ mode: 'BOTH' });
    expect(onlyAci.strength.governingRuleset).toBe('ACI');
    expect(onlyAci.strength.branches[1]!.blocker?.code).toBe('rule_not_on_file');
    expect(onlyAci.provisional).toBe(true);
    const js = run({ mode: 'JS' });
    expect(js.strength.fcrMpa).toBeNull();
    expect(js.strength.blocker?.code).toBe('rule_not_on_file');
    expect(js.strengthAdequacy.blocker?.detail).toMatch(/f′?'?cr/);
  });
});

describe('specified strength basis', () => {
  it('converts cube and B-grade through the basis map', () => {
    expect(run({ request: req({ fcMpa: 37, basis: 'cube' }) }).strength.cylinderMpa).toBe(30);
    expect(run({ request: req({ fcMpa: 300, basis: 'b_grade' }) }).strength.cylinderMpa).toBe(25);
  });
  it('names why it cannot convert', () => {
    expect(run({ request: req({ fcMpa: 38, basis: 'cube' }) }).strength.blocker?.code).toBe(
      'out_of_domain',
    );
    expect(run({ request: req({ fcMpa: 350, basis: 'b_grade' }) }).strength.blocker?.code).toBe(
      'rule_blocked',
    );
    expect(run({ request: req({ fcMpa: 999, basis: 'b_grade' }) }).strength.blocker?.code).toBe(
      'out_of_domain',
    );
    expect(run({ request: req({ basis: null }) }).strength.blocker?.detail).toMatch(/basis/);
    expect(run({ request: req({ fcMpa: null }) }).strength.blocker?.detail).toMatch(/not stated/);
    const noMap = rulesFor('ACI', req({ fcMpa: 37, basis: 'cube' }), (r) =>
      r.key === 'strength.basis_map' ? { ...r, value: null } : r,
    );
    expect(
      run({ request: req({ fcMpa: 37, basis: 'cube' }), rules: noMap }).strength.blocker?.code,
    ).toBe('rule_not_on_file');
  });
  it('a failed conversion leaves the dependent checks not evaluated, never passed', () => {
    const r = run({ request: req({ fcMpa: 38, basis: 'cube' }) });
    expect(chk(r, 'min_fc')?.status).toBe('not_evaluated'); // every exposure class has a minimum f'c
    const s2 = run({ request: req({ fcMpa: 38, basis: 'cube', exposure: ['S2'] }) });
    expect(chk(s2, 'min_fc')?.status).toBe('not_evaluated');
    expect(s2.verdict).not.toBe('pass');
  });
});

describe('absolute volume, yield, w/cm, binder', () => {
  it('matches the hand computation (L: 111.111 + 175 + 3.2407 + 300 + 390.566 + 20)', () => {
    const r = run();
    expect(r.figures['volume.cem']).toBeCloseTo(350 / 3150, 6);
    expect(r.figures['volume.sp']).toBeCloseTo(3.5 / 1080, 6);
    expect(r.figures['volume.total']).toBeCloseTo(0.999918, 6);
    expect(r.figures['yield.delta']).toBeCloseTo(-0.000082, 6);
    expect(chk(r, 'yield')?.status).toBe('pass');
    expect(r.figures['mass.binder']).toBe(350);
    expect(r.figures['mass.fresh_density']).toBe(2343.5);
  });
  it('counts admixture water only where the product says so', () => {
    expect(run().figures['ratio.wcm']).toBeCloseTo(177.1 / 350, 6);
    const ignored = run({ materials: mat('sp', { water_convention: 'liquid_ignored' }) });
    expect(ignored.figures['ratio.wcm']).toBeCloseTo(0.5, 6);
    const unset = run({ materials: dropProp('sp', 'water_convention') });
    expect(unset.figures['ratio.wcm']).toBeCloseTo(0.5, 6);
    expect(unset.dataQuality.map((d) => d.code)).toContain('admixture_water_convention_missing');
    const noSolids = run({ materials: dropProp('sp', 'solids_pct') });
    expect(noSolids.figures['ratio.wcm']).toBeNull();
  });
  it('fails the yield check outside ± tolerance and is tolerance-configurable', () => {
    const lean = run({ lines: lines({ coarse: '1000.000' }) });
    expect(chk(lean, 'yield')?.status).toBe('fail');
    expect(lean.verdict).toBe('fail');
    const loose = run({
      lines: lines({ coarse: '1000.000' }),
      settings: { ...makeSnapshot().settings, yieldTolerance: 0.02 },
    });
    expect(chk(loose, 'yield')?.status).toBe('pass');
  });
  it('a missing specific gravity names the line and blocks the minimum data, not the other figures', () => {
    const r = run({ materials: dropProp('sand', 'sg_ssd') });
    expect(r.minimumData.ok).toBe(false);
    expect(r.minimumData.missing).toEqual([{ materialId: 'sand', field: 'sg_ssd' }]);
    expect(r.figures['volume.total']).toBeNull();
    expect(chk(r, 'yield')?.status).toBe('not_evaluated');
    expect(r.figures['ratio.wcm']).toBeCloseTo(0.506, 6);
  });
  it('water specific gravity defaults to 1.000 visibly', () => {
    const r = run({ materials: dropProp('water', 'sg') });
    expect(r.minimumData.ok).toBe(true);
    expect(r.dataQuality.map((d) => d.code)).toContain('water_sg_defaulted');
    expect(r.assumptions.join(' ')).toMatch(/1\.000/);
  });
  it('no water line and no cement leave w/cm null', () => {
    expect(run({ lines: lines({ water: null }) }).figures['ratio.wcm']).toBeNull();
    const noCement = run({ lines: lines({ cem: null }) });
    expect(noCement.figures['ratio.wcm']).toBeNull();
    expect(noCement.dataQuality.map((d) => d.code)).not.toContain('material_missing');
  });
  it('air: the design value, else the ACI 211.1 entrapped-air baseline, labelled; air-entrained without a value blocks volume', () => {
    const given = run();
    expect(given.figures['volume.air']).toBeCloseTo(0.02, 9);
    const baseline = run({ request: req({ airPct: null }) });
    expect(baseline.figures['volume.air']).toBeCloseTo(0.02, 9); // 19 mm → 2.0 %
    expect(baseline.evidence).toContain('MODEL_BASELINE');
    expect(baseline.assumptions.join(' ')).toMatch(/entrapped-air/);
    const interp = run({ request: req({ airPct: null, nmasMm: 22 }) });
    expect(interp.figures['volume.air']).toBeCloseTo(0.0175, 9); // between 2.0 (19) and 1.5 (25)
    const noNmas = run({ request: req({ airPct: null, nmasMm: null }) });
    expect(noNmas.figures['volume.total']).toBeNull();
    const outOfDomain = run({ request: req({ airPct: null, nmasMm: 100 }) });
    expect(outOfDomain.figures['volume.air']).toBeNull();
    const ae = run({ request: req({ airPct: null, exposure: ['F2'] }) });
    expect(ae.figures['volume.air']).toBeNull();
    expect(chk(ae, 'yield')?.blocker?.detail).toMatch(/not on file/);
  });
  it('limestone filler is not counted as an SCM, and the report says so', () => {
    const lime: SnapshotMaterial = {
      id: 'lime',
      category: 'scm',
      nameEn: 'Limestone',
      nameAr: null,
      test: { ...MATERIALS[0]!.test!, properties: { scm_type: 'limestone_filler', sg: 2.7 } },
      price: { status: 'unavailable' },
    };
    const r = run({
      materials: [...MATERIALS, lime],
      lines: [...LINES, { materialId: 'lime', kgPerM3: '30.000' }],
    });
    expect(r.figures['scm.pct.total']).toBe(0);
    expect(r.figures['mass.binder']).toBe(380);
    expect(r.dataQuality.map((d) => d.code)).toContain('limestone_not_counted');
  });
});

describe('compliance checks (tri-state)', () => {
  const fa: SnapshotMaterial = {
    id: 'fa',
    category: 'scm',
    nameEn: 'Fly ash',
    nameAr: null,
    test: { ...MATERIALS[0]!.test!, properties: { scm_type: 'fly_ash', sg: 2.2 } },
    price: { status: 'unavailable' },
  };
  const slag: SnapshotMaterial = {
    ...fa,
    id: 'slag',
    nameEn: 'GGBS',
    test: { ...fa.test!, properties: { scm_type: 'ggbs', sg: 2.9 } },
  };
  const f3 = (kg: Record<string, string>) =>
    run({
      request: req({ exposure: ['F3'], fcMpa: 40 }),
      materials: [...MATERIALS, fa, slag],
      lines: [
        ...LINES.filter((l) => !['cem'].includes(l.materialId)),
        { materialId: 'cem', kgPerM3: kg['cem'] ?? '300.000' },
        ...Object.entries(kg)
          .filter(([k]) => k !== 'cem')
          .map(([materialId, kgPerM3]) => ({ materialId, kgPerM3 })),
      ],
    });

  it('max w/cm: pass at the limit, fail above, not evaluated when the limit is not on file', () => {
    const at = run({
      request: req({ exposure: ['S1'], fcMpa: 30 }),
      lines: lines({ water: '175.000', sp: null, cem: '350.000' }),
    });
    expect(chk(at, 'max_wcm')).toMatchObject({ status: 'pass', value: 0.5, limit: 0.5, op: '<=' });
    const over = run({
      request: req({ exposure: ['S1'] }),
      lines: lines({ water: '176.000', sp: null }),
    });
    expect(chk(over, 'max_wcm')?.status).toBe('fail');
    const jsOnly = run({ mode: 'JS', request: req({ exposure: ['S1'] }) });
    expect(chk(jsOnly, 'max_wcm')).toMatchObject({ status: 'not_evaluated', limit: null });
    expect(chk(jsOnly, 'max_wcm')?.blocker?.code).toBe('rule_not_on_file');
    expect(jsOnly.verdict).toBe('incomplete');
  });

  it('min f′c compares the specified strength (cylinder basis) with the exposure minimum', () => {
    expect(chk(run({ request: req({ exposure: ['S2'], fcMpa: 31 }) }), 'min_fc')?.status).toBe(
      'pass',
    );
    expect(chk(run({ request: req({ exposure: ['S2'], fcMpa: 30 }) }), 'min_fc')?.status).toBe(
      'fail',
    );
  });

  it('SCM limits by type, from the exact shares', () => {
    const r = f3({ cem: '280.000', fa: '120.000' });
    expect(r.figures['scm.pct.fly_ash_pozzolan']).toBe(30);
    expect(chk(r, 'scm.max.fly_ash_pozzolan_pct')).toMatchObject({
      status: 'fail',
      value: 30,
      limit: 25,
    });
    expect(chk(r, 'scm.max.total_pct')?.status).toBe('pass');
    expect(chk(r, 'scm.max.fly_ash_silica_fume_pct')?.status).toBe('pass'); // 30 ≤ 35
    expect(chk(r, 'scm.max.slag_pct')?.status).toBe('pass');
    const s = f3({ cem: '180.000', slag: '220.000' });
    expect(chk(s, 'scm.max.slag_pct')?.status).toBe('fail'); // 55 > 50
    expect(chk(s, 'scm.max.total_pct')?.status).toBe('fail');
  });

  it('an SCM with no recorded type leaves every SCM limit not evaluated', () => {
    const untyped = { ...fa, test: { ...fa.test!, properties: { sg: 2.2 } } };
    const r = run({
      request: req({ exposure: ['F3'], fcMpa: 40 }),
      materials: [...MATERIALS, untyped],
      lines: [...LINES, { materialId: 'fa', kgPerM3: '100.000' }],
    });
    expect(chk(r, 'scm.max.total_pct')?.status).toBe('not_evaluated');
    expect(chk(r, 'scm.max.total_pct')?.blocker?.detail).toMatch(/SCM type/);
  });

  it('chlorides: a partial sum already over the limit fails; missing data keep it open; complete data pass', () => {
    const pass = run({ request: req({ exposure: ['C2'], fcMpa: 40 }) });
    expect(chk(pass, 'cl.nonprestressed')).toMatchObject({ status: 'pass', limit: 0.15 });
    expect(chk(pass, 'cl.prestressed')).toMatchObject({ status: 'pass', limit: 0.06 }); // 0.0476 ≤ 0.06
    const salty = run({
      request: req({ exposure: ['C2'], fcMpa: 40 }),
      materials: mat('sand', { chlorides_pct: 0.1 }),
    });
    expect(chk(salty, 'cl.nonprestressed')?.status).toBe('fail'); // (78+0.0517+0.035+0.00175)/350 → 0.33 %
    const noData = run({
      request: req({ exposure: ['C2'], fcMpa: 40 }),
      materials: dropProp('sand', 'chlorides_pct'),
    });
    expect(chk(noData, 'cl.nonprestressed')?.status).toBe('not_evaluated');
    expect(chk(noData, 'cl.nonprestressed')?.blocker?.detail).toMatch(/chlorides_pct/);
    const noWaterCl = run({
      request: req({ exposure: ['C2'], fcMpa: 40 }),
      materials: dropProp('water', 'chloride_mg_l'),
    });
    expect(chk(noWaterCl, 'cl.nonprestressed')?.status).toBe('not_evaluated');
    const noAdmCl = run({
      request: req({ exposure: ['C2'], fcMpa: 40 }),
      materials: dropProp('sp', 'chloride_pct'),
    });
    expect(chk(noAdmCl, 'cl.nonprestressed')?.status).toBe('not_evaluated');
    const noCementitious = run({
      request: req({ exposure: ['C2'], fcMpa: 40 }),
      lines: lines({ cem: null }),
    });
    expect(chk(noCementitious, 'cl.nonprestressed')?.status).toBe('not_evaluated');
  });

  it('cement property check reads C₃A, never the label', () => {
    const s2 = (c3a: number | null, over: Partial<EvaluationSnapshot> = {}) =>
      run({
        request: req({ exposure: ['S2'], fcMpa: 31 }),
        materials:
          c3a === null
            ? dropProp('cem', 'c3a_pct')
            : mat('cem', { c3a_pct: c3a, cement_type: 'Type V' }),
        ...over,
      });
    expect(chk(s2(4.9), 'sulfate_cement')).toMatchObject({ status: 'pass', value: 'high' });
    expect(chk(s2(5), 'sulfate_cement')?.status).toBe('pass'); // ≤ 5 is high
    expect(chk(s2(6), 'sulfate_cement')).toMatchObject({ status: 'fail', value: 'moderate' });
    expect(chk(s2(9), 'sulfate_cement')).toMatchObject({ status: 'fail', value: 'none' });
    const missing = chk(s2(null), 'sulfate_cement')!;
    expect(missing.status).toBe('not_evaluated');
    expect(missing.blocker?.detail).toMatch(/C3A is not on file/);
    // S1 accepts moderate or high; a high cement satisfies a lower class
    const s1 = (c3a: number) =>
      run({ request: req({ exposure: ['S1'] }), materials: mat('cem', { c3a_pct: c3a }) });
    expect(chk(s1(7), 'sulfate_cement')?.status).toBe('pass');
    expect(chk(s1(3), 'sulfate_cement')?.status).toBe('pass');
    expect(chk(s1(8.5), 'sulfate_cement')?.status).toBe('fail');
    const noEquiv = rulesFor('ACI', req({ exposure: ['S1'] }), (r) =>
      r.key === 'cement.equivalence.high.max_c3a_pct' ? { ...r, value: null } : r,
    );
    expect(
      chk(run({ request: req({ exposure: ['S1'] }), rules: noEquiv }), 'sulfate_cement')?.blocker
        ?.code,
    ).toBe('rule_not_on_file');
    expect(
      chk(
        run({ request: req({ exposure: ['S1'] }), lines: lines({ cem: null }) }),
        'sulfate_cement',
      )?.blocker?.detail,
    ).toMatch(/no cement/);
  });

  it('S3 option 1 needs a pozzolan or slag; S3 without an option is named and never a clean pass', () => {
    const noOption = run({ request: req({ exposure: ['S3'], fcMpa: 35 }) });
    expect(noOption.verdict).not.toBe('pass');
    expect(
      noOption.dataQuality.some((q) => q.code === 'context_missing' && q.severity === 'blocker'),
    ).toBe(true);
    const base = { request: req({ exposure: ['S3'], s3Option: 1 as const, fcMpa: 35 }) };
    const none = run(base);
    expect(chk(none, 'scm_required')).toMatchObject({ status: 'fail', value: 'none' });
    const withFa = run({
      ...base,
      materials: [...MATERIALS, fa],
      lines: [...LINES, { materialId: 'fa', kgPerM3: '60.000' }],
    });
    expect(chk(withFa, 'scm_required')?.status).toBe('pass');
    const slagOnly = run({
      ...base,
      materials: [...MATERIALS, slag],
      lines: [...LINES, { materialId: 'slag', kgPerM3: '60.000' }],
    });
    expect(chk(slagOnly, 'scm_required')).toMatchObject({ status: 'pass', value: 'slag' });
    const untyped = run({
      ...base,
      materials: [...MATERIALS, { ...fa, test: { ...fa.test!, properties: { sg: 2.2 } } }],
      lines: [...LINES, { materialId: 'fa', kgPerM3: '60.000' }],
    });
    expect(chk(untyped, 'scm_required')?.status).toBe('not_evaluated');
  });

  it('calcium chloride prohibition: accelerators fail, unknown admixture type is not evaluated', () => {
    const s2 = (props: Record<string, unknown> | null) =>
      run({
        request: req({ exposure: ['S2'], fcMpa: 31 }),
        materials: props === null ? dropProp('sp', 'type') : mat('sp', props),
      });
    expect(chk(s2({ type: 'F' }), 'cacl2_prohibited')?.status).toBe('pass');
    expect(chk(s2({ type: 'C' }), 'cacl2_prohibited')?.status).toBe('fail');
    expect(chk(s2({ type: 'E' }), 'cacl2_prohibited')?.status).toBe('fail');
    expect(chk(s2(null), 'cacl2_prohibited')?.status).toBe('not_evaluated');
    expect(
      chk(
        run({ request: req({ exposure: ['S2'], fcMpa: 31 }), lines: lines({ sp: null }) }),
        'cacl2_prohibited',
      )?.status,
    ).toBe('pass');
  });

  it('air content: target ± tolerance for F classes; not stated or no table means not evaluated', () => {
    // F1 at 19 mm: target 5.0 %, tolerance 1.5 %
    const f1 = (air: number | null, extra: Partial<EvaluationSnapshot> = {}) =>
      run({ request: req({ exposure: ['F1'], fcMpa: 30, airPct: air }), ...extra });
    expect(chk(f1(5), 'air')).toMatchObject({ status: 'pass', limit: 5 });
    expect(chk(f1(6.5), 'air')?.status).toBe('pass');
    expect(chk(f1(6.6), 'air')?.status).toBe('fail');
    expect(chk(f1(3.4), 'air')?.status).toBe('fail');
    expect(chk(f1(null), 'air')?.blocker?.detail).toMatch(/not stated/);
    expect(
      chk(f1(5, { request: req({ exposure: ['F1'], airPct: 5, nmasMm: null }) }), 'air')?.blocker
        ?.detail,
    ).toMatch(/NMAS/);
    expect(
      chk(f1(5, { request: req({ exposure: ['F1'], airPct: 5, nmasMm: 100 }) }), 'air')?.status,
    ).toBe('not_evaluated');
    const noTol = rulesFor('ACI', req({ exposure: ['F1'] }), (r) =>
      r.key === 'air.tolerance_pct' ? { ...r, value: null } : r,
    );
    expect(chk(f1(5, { rules: noTol }), 'air')?.status).toBe('not_evaluated');
    // Both: the JS table is empty, so ACI's is used provisionally
    expect(chk(f1(5, { mode: 'BOTH' }), 'air')?.provisional).toBe(true);
  });

  it('admixture dosage against the product range', () => {
    expect(chk(run(), 'admixture_dosage.sp')).toMatchObject({ status: 'pass', value: 1 });
    expect(chk(run({ lines: lines({ sp: '7.000' }) }), 'admixture_dosage.sp')?.status).toBe('fail'); // 2 % > 1.5 %
    expect(chk(run({ lines: lines({ sp: '1.000' }) }), 'admixture_dosage.sp')?.status).toBe('fail'); // 0.29 % < 0.4 %
    const noRange = run({
      materials: mat('sp', { min_dosage_pct: undefined, max_dosage_pct: undefined }),
    });
    expect(chk(noRange, 'admixture_dosage.sp')?.status).toBe('not_evaluated');
    expect(chk(run({ lines: lines({ cem: null }) }), 'admixture_dosage.sp')?.status).toBe(
      'not_evaluated',
    );
  });

  it('near-limit warnings only exist when a percentage is configured', () => {
    const sn = (nearLimitPct: number | null) =>
      run({
        request: req({ exposure: ['S1'] }),
        lines: lines({ water: '172.000', sp: null }),
        settings: { ...makeSnapshot().settings, nearLimitPct },
      });
    expect(chk(sn(null), 'max_wcm')?.warning).toBeNull();
    expect(chk(sn(5), 'max_wcm')?.warning).toBe('near_limit'); // 0.4914 ≥ 0.5 × 0.95
    expect(chk(sn(1), 'max_wcm')?.warning).toBeNull();
    const minNear = run({
      request: req({ exposure: ['S2'], fcMpa: 31 }),
      settings: { ...makeSnapshot().settings, nearLimitPct: 5 },
    });
    expect(chk(minNear, 'min_fc')?.warning).toBe('near_limit');
    expect(
      chk(
        run({
          settings: { ...makeSnapshot().settings, nearLimitPct: 1 },
          lines: lines({ coarse: '1030.000' }),
        }),
        'yield',
      )?.status,
    ).toBe('pass');
    const air = run({
      request: req({ exposure: ['F1'], airPct: 6.4 }),
      settings: { ...makeSnapshot().settings, nearLimitPct: 10 },
    });
    expect(chk(air, 'air')?.warning).toBe('near_limit');
  });

  it('project overrides may tighten a code limit but never loosen it', () => {
    const tighten = run({
      request: req({ exposure: ['S1'] }),
      projectOverrides: [{ requirement: 'max_wcm', value: 0.45 }],
    });
    expect(chk(tighten, 'max_wcm')).toMatchObject({ limit: 0.45, status: 'fail' });
    expect(chk(tighten, 'max_wcm')?.evidence).toContain('PROJECT_VERIFIED');
    const loosen = run({
      request: req({ exposure: ['S1'] }),
      projectOverrides: [{ requirement: 'max_wcm', value: 0.6 }],
    });
    expect(chk(loosen, 'max_wcm')?.limit).toBe(0.5);
    expect(loosen.dataQuality.map((d) => d.code)).toContain('override_rejected');
  });

  it('every requirement is listed with the reason it has no design-stage check', () => {
    const r = run({ request: req({ exposure: ['S2', 'C2'], fcMpa: 40 }) });
    const byName = (n: string) => r.requirements.find((x) => x.requirement === n);
    expect(byName('max_wcm')?.checked).toBe(true);
    expect(byName('accept.single.min_ratio_fc')).toMatchObject({
      checked: false,
      skippedReason: 'field_acceptance',
    });
    expect(byName('slump_tolerance_mm')).toMatchObject({
      checked: false,
      skippedReason: 'field_tolerance',
    });
    expect(byName('nmas.max_fraction.slab_depth')?.skippedReason).toBe('geometry_not_provided');
    expect(byName('min_cover')?.skippedReason).toBe('information');
    expect(r.requirements.some((x) => x.kind === 'parameter')).toBe(false);
  });

  it('a clean pass is still provisional while the rules are unverified', () => {
    const r = run();
    expect(r.verdict).toBe('pass');
    expect(r.provisional).toBe(true);
    expect(r.evidence).toContain('RULE_UNVERIFIED');
    expect(r.evidence).toContain('TRIAL_REQUIRED');
    expect(r.dataQuality.find((q) => q.code === 'rules_unverified')).toBeTruthy();
    const verified = run({ rules: makeSnapshot().rules.map((x) => ({ ...x, verified: true })) });
    expect(verified.provisional).toBe(false);
    expect(verified.evidence).not.toContain('RULE_UNVERIFIED');
    expect(verified.checks.find((c) => c.id === 'min_fc')?.evidence).toContain('CODE_VERIFIED');
  });
});

describe('strength adequacy and water baseline (information, never compliance)', () => {
  it('ACI 211.1 w/c for f′cr, interpolated, labelled as not compliance', () => {
    const r = run();
    expect(r.strengthAdequacy).toMatchObject({
      label: 'not_a_compliance_result',
      model: 'none',
      fcrMpa: 38.3,
      comparison: 'design_above_baseline',
    });
    expect(r.strengthAdequacy.baselineWc).toBeCloseTo(0.437, 9); // 0.47 − 3.3/5 × 0.05
    expect(r.strengthAdequacy.evidence).toEqual([
      'MODEL_BASELINE',
      'TRIAL_REQUIRED',
      'MODEL_PREDICTS_SHORTFALL',
    ]);
    expect(r.checks.some((c) => c.id.includes('adequacy'))).toBe(false);
    const lean = run({ lines: lines({ water: '120.000' }) });
    expect(lean.strengthAdequacy.comparison).toBe('design_at_or_below_baseline');
    expect(lean.strengthAdequacy.evidence).not.toContain('MODEL_PREDICTS_SHORTFALL');
  });
  it('names the reason when it cannot give a baseline', () => {
    expect(run({ request: req({ fcMpa: 45 }) }).strengthAdequacy.blocker?.code).toBe(
      'out_of_domain',
    ); // f'cr 53.3 > 40
    expect(run({ request: req({ fcMpa: 5 }) }).strengthAdequacy.blocker?.code).toBe(
      'out_of_domain',
    ); // 12 < 15
    expect(run({ request: req({ exposure: ['F2'] }) }).strengthAdequacy.blocker?.code).toBe(
      'rule_not_on_file',
    ); // air-entrained
    expect(run({ request: req({ fcMpa: null }) }).strengthAdequacy.blocker?.code).toBe(
      'input_missing',
    );
    const hole = rulesFor('ACI', req({}), (r) =>
      r.key === 'prop.wc_strength.non_ae'
        ? { ...r, definition: { ...r.definition!, data: [[0.79, 0.69, 0.61, 0.54, null, 0.42]] } }
        : r,
    );
    expect(run({ rules: hole }).strengthAdequacy.blocker?.detail).toMatch(/no value at/);
    const jsOnly = run({ mode: 'JS', request: req({}) });
    expect(jsOnly.strengthAdequacy.baselineWc).toBeNull();
  });
  it('baseline water: table value × (1 − admixture reduction at the design dosage)', () => {
    const r = run();
    expect(r.waterBaseline).toMatchObject({
      label: 'does_not_predict_plant_water_demand',
      baseWaterKg: 205,
      designWaterKg: 177.1,
    });
    expect(r.waterBaseline.admixtureReductionPct).toBeCloseTo(16.285714, 5); // 14 + 0.2/0.7 × 8
    expect(r.waterBaseline.baselineWaterKg).toBeCloseTo(171.614286, 5);
    const none = run({ lines: lines({ sp: null }) });
    expect(none.waterBaseline).toMatchObject({
      baseWaterKg: 205,
      admixtureReductionPct: 0,
      baselineWaterKg: 205,
    });
  });
  it('slump between two tabulated ranges is interpolated between their nearest edges, and says so', () => {
    const r = run({ request: req({ slumpMm: 125 }), lines: lines({ sp: null }) });
    expect(r.waterBaseline.baseWaterKg).toBeCloseTo(210.5, 9); // 205 at 100 mm, 216 at 150 mm
    expect(r.assumptions.join(' ')).toMatch(/between the ACI 211\.1 slump ranges/);
    const inBin = run({ request: req({ slumpMm: 90 }), lines: lines({ sp: null }) });
    expect(inBin.waterBaseline.baseWaterKg).toBe(205);
    const nmas22 = run({ request: req({ nmasMm: 22 }), lines: lines({ sp: null }) });
    expect(nmas22.waterBaseline.baseWaterKg).toBeCloseTo(205 - (3 / 6) * 12, 9); // 205 (19) → 193 (25)
  });
  it('names why the water baseline is unavailable', () => {
    expect(run({ request: req({ slumpMm: null }) }).waterBaseline.blocker?.detail).toMatch(/slump/);
    expect(run({ request: req({ nmasMm: null }) }).waterBaseline.blocker?.detail).toMatch(/NMAS/);
    expect(run({ request: req({ slumpMm: 300 }) }).waterBaseline.blocker?.code).toBe(
      'out_of_domain',
    );
    expect(run({ request: req({ exposure: ['F2'] }) }).waterBaseline.blocker?.code).toBe(
      'rule_not_on_file',
    );
    const noTable = run({ mode: 'JS' });
    expect(noTable.waterBaseline.baselineWaterKg).not.toBeNull(); // ACI 211.1 design aids are information in every mode
    expect(
      run({ materials: dropProp('sp', 'water_reduction_table') }).waterBaseline.blocker?.detail,
    ).toMatch(/table/);
    expect(
      run({
        materials: mat('sp', {
          water_reduction_table: [
            { dosage_pct: 2, water_reduction_pct: 20 },
            { dosage_pct: 3, water_reduction_pct: 25 },
          ],
        }),
      }).waterBaseline.blocker?.detail,
    ).toMatch(/no extrapolation/);
    const holes = rulesFor('ACI', req({}), (r) =>
      r.key === 'prop.water.non_ae'
        ? {
            ...r,
            definition: {
              ...r.definition!,
              data: [
                [207, 199, null, 179, 166, 154],
                [228, 216, null, 193, 181, 169],
                [243, 228, null, 202, 190, 178],
              ],
            },
          }
        : r,
    );
    expect(run({ rules: holes }).waterBaseline.blocker?.code).toBe('rule_not_on_file');
  });
  it('multiple admixtures combine multiplicatively', () => {
    const sp2: SnapshotMaterial = { ...MATERIALS[4]!, id: 'sp2' };
    const r = run({
      materials: [...MATERIALS, sp2],
      lines: [...LINES, { materialId: 'sp2', kgPerM3: '3.500' }],
    });
    expect(r.waterBaseline.admixtureReductionPct).toBeCloseTo(
      (1 - (1 - 0.162857143) ** 2) * 100,
      4,
    );
  });
});

describe('cost', () => {
  it('Σ kg × JOD/kg, exact decimals, rounded once at the end', () => {
    const r = run();
    expect(r.cost.state).toBe('complete');
    expect(r.cost.totalJodPerM3).toBe('44.023');
    expect(r.cost.lines.find((l) => l.materialId === 'cem')).toMatchObject({
      jod: '26.250',
      jodPerKg: '0.075000000',
      state: 'priced',
    });
    expect(r.cost.basis).toEqual({ kind: 'live', date: '2026-10-02', snapshotId: null });
  });
  it('total is the rounded sum of exact line costs, not the sum of rounded lines', () => {
    // three lines of 0.4 kg at 1.001 JOD/kg = 0.4004 each (rounds to 0.400); total 1.2012 → 1.201, not 1.200
    const mk = (id: string): SnapshotMaterial => ({
      ...MATERIALS[1]!,
      id,
      price: { ...(MATERIALS[1]!.price as OkPrice), price: '1.001', unit: 'JOD/kg' },
    });
    const r = run({
      materials: ['a', 'b', 'c'].map(mk),
      lines: ['a', 'b', 'c'].map((m) => ({ materialId: m, kgPerM3: '0.400' })),
    });
    expect(r.cost.lines.map((l) => l.jod)).toEqual(['0.400', '0.400', '0.400']);
    expect(r.cost.totalJodPerM3).toBe('1.201');
  });
  it('an unpriced, ambiguous or non-convertible line makes the cost incomplete and is named, never zero', () => {
    const base = MATERIALS.find((m) => m.id === 'coarse')!;
    const withPrice = (price: SnapshotMaterial['price']) =>
      MATERIALS.map((m) => (m.id === 'coarse' ? { ...m, price } : m));
    const none = run({ materials: withPrice({ status: 'unavailable' }) });
    expect(none.cost).toMatchObject({ state: 'incomplete', totalJodPerM3: null });
    expect(none.cost.missing).toEqual([
      { materialId: 'coarse', reason: expect.stringMatching(/no price in force/) },
    ]);
    expect(none.cost.subtotalJodPerM3).toBe('36.778');
    expect(none.evidence).toContain('INPUT_MISSING');
    const amb = run({ materials: withPrice({ status: 'ambiguous', supplierIds: ['a', 'b'] }) });
    expect(amb.cost.lines.find((l) => l.materialId === 'coarse')?.state).toBe('ambiguous');
    const ok = base.price as OkPrice;
    const m3 = run({ materials: withPrice({ ...ok, unit: 'JOD/m3' }) });
    expect(m3.cost.lines.find((l) => l.materialId === 'coarse')?.state).toBe('not_convertible');
    const perL = run({ materials: withPrice({ ...ok, price: '2', unit: 'JOD/L' }) });
    expect(perL.cost.lines.find((l) => l.materialId === 'coarse')).toMatchObject({
      state: 'priced',
      jod: '781.132',
    }); // 1035 kg × 2 JOD/L ÷ 2.65 kg/L
    const bad = run({ materials: withPrice({ ...ok, price: '1.2345', unit: 'JOD/kg' }) });
    expect(bad.cost.state).toBe('incomplete');
  });
  it('stale and unconfigured price ages are reported', () => {
    const ok = MATERIALS[0]!.price as OkPrice;
    const stale = run({
      materials: MATERIALS.map((m) =>
        m.id === 'cem' ? { ...m, price: { ...ok, staleness: 'stale' as const, ageDays: 200 } } : m,
      ),
    });
    expect(stale.cost.lines.find((l) => l.materialId === 'cem')?.stale).toBe(true);
    expect(stale.dataQuality.find((q) => q.code === 'price_stale')?.evidence).toContain(
      'INPUT_STALE',
    );
    expect(stale.evidence).toContain('INPUT_STALE');
    const unset = run({
      materials: MATERIALS.map((m) =>
        m.id === 'cem' ? { ...m, price: { ...ok, staleness: 'not_configured' as const } } : m,
      ),
    });
    expect(unset.dataQuality.map((q) => q.code)).toContain('price_age_limit_not_configured');
  });
});

describe('data quality', () => {
  it('names missing, expired, unconfigured and declared tests', () => {
    const noTest = run({
      materials: MATERIALS.map((m) => (m.id === 'sand' ? { ...m, test: null } : m)),
    });
    expect(noTest.dataQuality.find((q) => q.code === 'test_missing')).toMatchObject({
      severity: 'blocker',
      materialId: 'sand',
    });
    expect(noTest.minimumData.ok).toBe(false);
    const expired = run({
      materials: MATERIALS.map((m) =>
        m.id === 'sand' ? { ...m, test: { ...m.test!, freshness: 'expired' as const } } : m,
      ),
    });
    expect(expired.dataQuality.find((q) => q.code === 'test_expired')?.evidence).toContain(
      'INPUT_STALE',
    );
    const unset = run({
      materials: MATERIALS.map((m) =>
        m.id === 'sand' ? { ...m, test: { ...m.test!, freshness: 'not_configured' as const } } : m,
      ),
    });
    expect(unset.dataQuality.map((q) => q.code)).toContain('test_age_limit_not_configured');
    const declared = run({
      materials: MATERIALS.map((m) =>
        m.id === 'sand'
          ? {
              ...m,
              test: {
                ...m.test!,
                source: 'user_declared' as const,
                fieldSources: { sg_ssd: 'user_declared' as const },
              },
            }
          : m,
      ),
    });
    expect(declared.dataQuality.find((q) => q.code === 'declared_values')?.detail).toMatch(
      /sg_ssd/,
    );
    expect(declared.evidence).toContain('INPUT_USER_DECLARED');
    const ghost = run({ lines: [...LINES, { materialId: 'ghost', kgPerM3: '1.000' }] });
    expect(ghost.dataQuality.find((q) => q.code === 'material_missing')?.severity).toBe('blocker');
    expect(ghost.minimumData.ok).toBe(false);
  });
  it('states what is not configured and how many rule values are missing', () => {
    const r = run();
    const codes = r.dataQuality.map((q) => q.code);
    expect(codes).toEqual(
      expect.arrayContaining(['near_limit_not_configured', 'no_strength_records']),
    );
    const withMargin = run({
      settings: { ...makeSnapshot().settings, nearLimitPct: 5, safetyMarginMpa: 1 },
      strengthRecords: { n: 30, sdMpa: 3, fcMpa: 30 },
    });
    expect(withMargin.dataQuality.map((q) => q.code)).not.toContain('near_limit_not_configured');
    expect(withMargin.dataQuality.map((q) => q.code)).not.toContain('safety_margin_not_configured');
    expect(run({ mode: 'JS' }).dataQuality.map((q) => q.code)).toContain('rules_missing');
  });
  it('flags the assumptions it made: air-entrained exposure and non-28-day strength', () => {
    expect(run({ request: req({ exposure: ['F1'] }) }).assumptions.join(' ')).toMatch(
      /air-entrained/,
    );
    expect(run({ request: req({ testAgeDays: 56 }) }).assumptions.join(' ')).toMatch(/56 days/);
  });
});

describe('determinism and purity', () => {
  it('same snapshot → byte-identical report, snapshot untouched', () => {
    const s = makeSnapshot({ mode: 'BOTH' });
    const before = JSON.stringify(s);
    const a = JSON.stringify(evaluate(s));
    const b = JSON.stringify(evaluate(s));
    expect(a).toBe(b);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('every figure has exactly one trace entry with a formula', () => {
    const r = run({ mode: 'BOTH' });
    const keys = r.trace.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(r.figures).sort());
    for (const t of r.trace) {
      expect(t.formula.length).toBeGreaterThan(5);
      expect(t.value).toBe(r.figures[t.key]);
    }
  });
});

describe('plant strength model in the adequacy block (M5.2)', () => {
  const model = (over: Partial<NonNullable<EvaluationSnapshot['strengthModel']>> = {}) => ({
    id: 'm1',
    a: Math.log(38.3) + 1, // w/cm = 0.5 at f′cr 38.3
    b: 2,
    wcmMin: 0.4,
    wcmMax: 0.6,
    ageDays: 28,
    basis: 'cylinder' as const,
    groupKey: 'g',
    sMpa: 1.5,
    ...over,
  });
  it('uses the model inside its domain and says so', () => {
    const r = run({ strengthModel: model() });
    expect(r.strengthAdequacy).toMatchObject({
      model: 'plant',
      modelUse: 'used',
      modelId: 'm1',
      label: 'not_a_compliance_result',
    });
    expect(r.strengthAdequacy.governingWc).toBeCloseTo(0.5, 9);
    expect(r.strengthAdequacy.baselineWc).toBeCloseTo(0.437, 9);
    expect(r.strengthAdequacy.evidence).toContain('MODEL_IN_DOMAIN');
    expect(r.strengthAdequacy.evidence).toContain('TRIAL_REQUIRED');
    expect(r.trace.some((t) => t.key === 'model.wc')).toBe(true);
  });
  it('compares the design with the model w/cm, not the baseline', () => {
    const lean = run({ strengthModel: model(), lines: lines({ water: '130.000' }) });
    expect(lean.strengthAdequacy.comparison).toBe('design_at_or_below_baseline');
    const loose = run({ strengthModel: model({ a: Math.log(38.3) + 0.7 }) });
    expect(loose.strengthAdequacy.comparison).toBe('design_above_baseline');
    expect(loose.strengthAdequacy.evidence).toContain('MODEL_PREDICTS_SHORTFALL');
  });
  it('falls back to the ACI baseline outside the domain or for another age or basis', () => {
    const out = run({ strengthModel: model({ wcmMax: 0.45 }) });
    expect(out.strengthAdequacy).toMatchObject({ model: 'none', modelUse: 'out_of_domain' });
    expect(out.strengthAdequacy.governingWc).toBeCloseTo(0.437, 9);
    expect(out.strengthAdequacy.evidence).toContain('MODEL_BASELINE');
    expect(run({ strengthModel: model({ ageDays: 7 }) }).strengthAdequacy.modelUse).toBe(
      'age_or_basis_differs',
    );
    expect(run({ strengthModel: model({ basis: 'cube' }) }).strengthAdequacy.modelUse).toBe(
      'age_or_basis_differs',
    );
  });
  it('without a model the report is exactly as before (no new keys)', () => {
    const r = run();
    expect(Object.keys(r.strengthAdequacy)).not.toContain('modelUse');
    expect(Object.keys(r.strengthAdequacy)).not.toContain('governingWc');
    expect(run({ strengthModel: null }).strengthAdequacy).toEqual(r.strengthAdequacy);
  });
});
