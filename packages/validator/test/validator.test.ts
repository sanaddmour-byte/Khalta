import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate } from '@khalta/engine/evaluate';
import type { EvaluationReport, EvaluationSnapshot } from '@khalta/engine';
import { fixtureToSnapshot, loadFixtures } from '@khalta/engine/testing/fixtures';
import { LINES, MATERIALS, makeSnapshot } from '@khalta/engine/testing';
import { VALIDATOR_API_VERSION, VALIDATOR_VERSION, validateEvaluation } from '../src';
import { Rat, R } from '../src/rat';
import { look1d, look2dBins } from '../src/tables';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const base = () => {
  const s = makeSnapshot({ mode: 'BOTH' });
  return { s, r: evaluate(s) };
};
const kinds = (s: EvaluationSnapshot, r: EvaluationReport) =>
  validateEvaluation(s, r).mismatches.map((m) => `${m.kind}:${m.key}`);

describe('clean reports pass', () => {
  it('versions are exposed', () => {
    expect(VALIDATOR_API_VERSION).toBe(1);
    expect(VALIDATOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('the synthetic design in every ruleset mode', () => {
    for (const mode of ['ACI', 'JS', 'BOTH'] as const) {
      const s = makeSnapshot({ mode });
      const v = validateEvaluation(s, evaluate(s));
      expect(v.mismatches, mode).toEqual([]);
      expect(v.status).toBe('pass');
      expect(v.checked.figures).toBeGreaterThan(30);
      expect(v.checked.trace).toBe(v.checked.figures);
    }
  });
  it('every fixture', () => {
    for (const f of loadFixtures()) {
      const s = fixtureToSnapshot(f);
      expect(validateEvaluation(s, evaluate(s)).mismatches, f.id).toEqual([]);
    }
  });
});

describe('corruption suite: the validator catches changes without reading the evaluator’s flags', () => {
  it.each([
    [
      'volume (one material)',
      (r: EvaluationReport) => {
        r.figures['volume.sand'] = 0.31;
      },
      'figure_mismatch:volume.sand',
    ],
    [
      'total volume',
      (r: EvaluationReport) => {
        r.figures['volume.total'] = 1;
      },
      'figure_mismatch:volume.total',
    ],
    [
      'yield delta',
      (r: EvaluationReport) => {
        r.figures['yield.delta'] = 0;
      },
      'figure_mismatch:yield.delta',
    ],
    [
      'w/cm',
      (r: EvaluationReport) => {
        r.figures['ratio.wcm'] = 0.45;
      },
      'figure_mismatch:ratio.wcm',
    ],
    [
      'w/cm rounded to two places',
      (r: EvaluationReport) => {
        r.figures['ratio.wcm'] = 0.51;
      },
      'figure_mismatch:ratio.wcm',
    ],
    [
      'binder',
      (r: EvaluationReport) => {
        r.figures['mass.binder'] = 360;
      },
      'figure_mismatch:mass.binder',
    ],
    [
      'chloride',
      (r: EvaluationReport) => {
        r.figures['chloride.pct'] = 0.01;
      },
      'figure_mismatch:chloride.pct',
    ],
    [
      'SCM share',
      (r: EvaluationReport) => {
        r.figures['scm.pct.total'] = 5;
      },
      'figure_mismatch:scm.pct.total',
    ],
    [
      'dosage',
      (r: EvaluationReport) => {
        r.figures['dosage.sp'] = 0.5;
      },
      'figure_mismatch:dosage.sp',
    ],
    [
      'f′cr',
      (r: EvaluationReport) => {
        r.figures['fcr.total'] = 30;
        r.strength.fcrMpa = 30;
      },
      'figure_mismatch:fcr.total',
    ],
    [
      'cost line',
      (r: EvaluationReport) => {
        r.figures['cost.cem'] = '20.000';
      },
      'figure_mismatch:cost.cem',
    ],
    [
      'cost total',
      (r: EvaluationReport) => {
        r.figures['cost.total'] = '10.000';
        r.cost.totalJodPerM3 = '10.000';
      },
      'cost_mismatch:cost.total',
    ],
    [
      'baseline w/c',
      (r: EvaluationReport) => {
        r.figures['baseline.wc'] = 0.6;
      },
      'figure_mismatch:baseline.wc',
    ],
    [
      'combined FM',
      (r: EvaluationReport) => {
        r.figures['agg.fm_combined'] = 3;
      },
      'figure_mismatch:agg.fm_combined',
    ],
  ])('altered %s', (_n, mutate, expected) => {
    const { s, r } = base();
    const bad = clone(r);
    mutate(bad);
    const v = validateEvaluation(s, bad);
    expect(v.status).toBe('fail');
    expect(v.mismatches.map((m) => `${m.kind}:${m.key}`)).toContain(expected);
  });

  it('a claimed pass it cannot reproduce', () => {
    const s = makeSnapshot({ request: { ...makeSnapshot().request, exposure: ['S2'], fcMpa: 30 } });
    const r = evaluate(s);
    expect(r.checks.find((c) => c.id === 'max_wcm')?.status).toBe('fail');
    const bad = clone(r);
    bad.checks.find((c) => c.id === 'max_wcm')!.status = 'pass';
    expect(kinds(s, bad)).toContain('check_mismatch:max_wcm');
    const bad2 = clone(r);
    bad2.verdict = 'pass';
    expect(kinds(s, bad2)).toContain('verdict_mismatch:verdict');
  });

  it('a not-evaluated check reported as a pass', () => {
    const s = makeSnapshot({
      request: { ...makeSnapshot().request, exposure: ['S1'] },
      materials: MATERIALS.map((m) =>
        m.id === 'cem' && m.test ? { ...m, test: { ...m.test, properties: { sg: 3.15 } } } : m,
      ),
    });
    const r = evaluate(s);
    const sulfate = r.checks.find((c) => c.id === 'sulfate_cement')!;
    expect(sulfate.status).toBe('not_evaluated');
    const bad = clone(r);
    bad.checks.find((c) => c.id === 'sulfate_cement')!.status = 'pass';
    expect(kinds(s, bad)).toContain('check_mismatch:sulfate_cement');
  });

  it('a changed limit, value or warning on a check', () => {
    const s = makeSnapshot({ request: { ...makeSnapshot().request, exposure: ['S1'] } });
    const r = evaluate(s);
    const a = clone(r);
    a.checks.find((c) => c.id === 'max_wcm')!.limit = 0.6;
    expect(kinds(s, a)).toContain('check_mismatch:max_wcm');
    const b = clone(r);
    b.checks.find((c) => c.id === 'max_wcm')!.value = 0.4;
    expect(kinds(s, b)).toContain('check_mismatch:max_wcm');
    const c = clone(r);
    c.checks.find((x) => x.id === 'max_wcm')!.warning = 'near_limit';
    expect(kinds(s, c)).toContain('check_mismatch:max_wcm');
    const d = clone(r);
    const sul = d.checks.find((x) => x.id === 'sulfate_cement')!;
    sul.limit = ['none'];
    expect(kinds(s, d)).toContain('check_mismatch:sulfate_cement');
  });

  it('a missing or extra check, figure or trace entry', () => {
    const { s, r } = base();
    const noCheck = clone(r);
    noCheck.checks = noCheck.checks.filter((c) => c.id !== 'yield');
    expect(kinds(s, noCheck)).toContain('missing_check:yield');
    const extra = clone(r);
    extra.checks.push({ ...extra.checks[0]!, id: 'invented' });
    expect(kinds(s, extra)).toContain('unexpected_check:invented');
    const noTrace = clone(r);
    noTrace.trace = noTrace.trace.filter((t) => t.key !== 'ratio.wcm');
    expect(kinds(s, noTrace)).toContain('missing_trace:ratio.wcm');
    const noFig = clone(r);
    delete noFig.figures['ratio.wcm'];
    expect(kinds(s, noFig)).toContain('missing_figure:ratio.wcm');
    const extraFig = clone(r);
    extraFig.figures['invented'] = 1;
    expect(kinds(s, extraFig)).toContain('unexpected_figure:invented');
    const orphan = clone(r);
    orphan.trace.push({ ...orphan.trace[0]!, key: 'orphan' });
    expect(kinds(s, orphan)).toContain('trace_mismatch:orphan');
    const dup = clone(r);
    dup.trace.push(dup.trace[0]!);
    expect(
      validateEvaluation(s, dup).mismatches.some((m) => m.detail === 'duplicate trace key'),
    ).toBe(true);
  });

  it('a trace that disagrees with the figure, or has no formula', () => {
    const { s, r } = base();
    const a = clone(r);
    a.trace.find((t) => t.key === 'ratio.wcm')!.value = 0.4;
    expect(kinds(s, a)).toContain('trace_mismatch:ratio.wcm');
    const b = clone(r);
    b.trace.find((t) => t.key === 'ratio.wcm')!.formula = '';
    expect(kinds(s, b)).toContain('trace_mismatch:ratio.wcm');
    const c = clone(r);
    (c.trace.find((t) => t.key === 'ratio.wcm') as unknown as { inputs: unknown }).inputs = null;
    expect(kinds(s, c)).toContain('trace_mismatch:ratio.wcm');
    const d = clone(r);
    d.checks.find((x) => x.id === 'cl.prestressed')!.traceKey = 'nope';
    expect(kinds(s, d)).toContain('missing_trace:cl.prestressed');
  });

  it('changed inputs: a different SG, quantity, price or limit in the snapshot is not what the report was computed from', () => {
    const { s, r } = base();
    const sg = clone(s);
    sg.materials.find((m) => m.id === 'sand')!.test!.properties['sg_ssd'] = 2.5;
    expect(kinds(sg, r)).toContain('figure_mismatch:volume.sand');
    const qty = clone(s);
    qty.lines.find((l) => l.materialId === 'cem')!.kgPerM3 = '400.000';
    expect(kinds(qty, r)).toContain('figure_mismatch:mass.cement');
    const price = clone(s);
    (price.materials.find((m) => m.id === 'cem')!.price as { price: string }).price = '90';
    expect(kinds(price, r)).toContain('figure_mismatch:cost.cem');
    const limit = clone(s);
    limit.rules.find((x) => x.key === 'durability.C1.max_cl_nonprestressed')!.value = 0.01;
    expect(kinds(limit, r).some((k) => k.startsWith('check_mismatch:cl.nonprestressed'))).toBe(
      true,
    );
    const mode = clone(s);
    mode.mode = 'ACI';
    expect(kinds(mode, r)).toContain('metadata_mismatch:mode');
    const date = clone(s);
    date.evaluationDate = '2026-01-01';
    expect(kinds(date, r)).toContain('metadata_mismatch:evaluationDate');
  });

  it('strength, baselines, cost block and minimum data', () => {
    const { s, r } = base();
    const a = clone(r);
    a.strength.cylinderMpa = 35;
    a.strength.governingRuleset = 'JS';
    a.strength.branches[0]!.value = 30;
    const ka = kinds(s, a);
    expect(ka).toEqual(
      expect.arrayContaining([
        'strength_mismatch:strength.cylinderMpa',
        'strength_mismatch:strength.governingRuleset',
        'strength_mismatch:strength.branch.ACI',
      ]),
    );
    const b = clone(r);
    b.strengthAdequacy.baselineWc = 0.5;
    b.strengthAdequacy.comparison = 'design_at_or_below_baseline';
    (b.strengthAdequacy as { label: string }).label = 'compliance';
    expect(kinds(s, b)).toEqual(
      expect.arrayContaining([
        'strength_mismatch:strengthAdequacy.baselineWc',
        'strength_mismatch:strengthAdequacy.comparison',
        'strength_mismatch:strengthAdequacy.label',
      ]),
    );
    const c = clone(r);
    c.waterBaseline.baseWaterKg = 1;
    c.waterBaseline.baselineWaterKg = 1;
    c.waterBaseline.admixtureReductionPct = 50;
    expect(kinds(s, c)).toEqual(
      expect.arrayContaining([
        'strength_mismatch:waterBaseline.baseWaterKg',
        'strength_mismatch:waterBaseline.baselineWaterKg',
        'strength_mismatch:waterBaseline.admixtureReductionPct',
      ]),
    );
    const d = clone(r);
    d.cost.state = 'incomplete';
    d.cost.subtotalJodPerM3 = '1.000';
    d.cost.lines[0]!.jod = '9.999';
    d.cost.missing = [{ materialId: 'cem', reason: 'x' }];
    expect(kinds(s, d)).toEqual(
      expect.arrayContaining([
        'cost_mismatch:cost.state',
        'cost_mismatch:cost.subtotal',
        'cost_mismatch:cost.missing',
      ]),
    );
    expect(kinds(s, d).some((k) => k.startsWith('cost_mismatch:cost.line.'))).toBe(true);
    const e = clone(r);
    e.minimumData = { ok: false, missing: [{ materialId: 'sand', field: 'sg_ssd' }] };
    expect(kinds(s, e)).toContain('metadata_mismatch:minimumData.missing');
    const gap = makeSnapshot({
      materials: MATERIALS.map((m) =>
        m.id === 'sand' && m.test
          ? { ...m, test: { ...m.test, properties: { ...m.test.properties, sg_ssd: undefined } } }
          : m,
      ),
    });
    const rg = evaluate(gap);
    const f = clone(rg);
    f.minimumData = { ok: true, missing: [] };
    expect(kinds(gap, f)).toEqual(
      expect.arrayContaining([
        'metadata_mismatch:minimumData.missing',
        'metadata_mismatch:minimumData.ok',
      ]),
    );
  });

  it('unverified rules cannot be presented as a clean result', () => {
    const { s, r } = base();
    const a = clone(r);
    a.provisional = false;
    expect(kinds(s, a)).toContain('verdict_mismatch:provisional');
    const b = clone(r);
    b.evidence = b.evidence.filter((e) => e !== 'RULE_UNVERIFIED');
    expect(kinds(s, b)).toContain('verdict_mismatch:evidence');
    const verified = makeSnapshot({
      rules: makeSnapshot().rules.map((x) => ({ ...x, verified: true })),
    });
    expect(validateEvaluation(verified, evaluate(verified)).status).toBe('pass');
  });

  it('characteristic rows', () => {
    const s = makeSnapshot({
      characteristics: [
        { key: 'wcm', sub: null, spec: { mode: 'range', max: 0.45 }, origin: 'request' },
      ],
    });
    const r = evaluate(s);
    expect(r.characteristics.rows[0]!.status).toBe('deviated');
    const a = clone(r);
    a.characteristics.rows[0]!.status = 'met';
    expect(kinds(s, a)).toContain('characteristic_mismatch:wcm');
    const b = clone(r);
    b.characteristics.rows[0]!.achieved = 0.4;
    expect(kinds(s, b)).toContain('characteristic_mismatch:wcm');
    const c = clone(r);
    c.characteristics.rows = [];
    expect(kinds(s, c)).toContain('characteristic_mismatch:wcm');
    const d = clone(r);
    d.characteristics.rows.push({ ...d.characteristics.rows[0]!, key: 'binder_kg' });
    expect(kinds(s, d)).toContain('characteristic_mismatch:binder_kg');
  });

  it('a snapshot it cannot understand is a hard failure, not a pass', () => {
    const { s, r } = base();
    const bad = clone(s) as unknown as { schema: number };
    bad.schema = 2;
    const v = validateEvaluation(bad as unknown as EvaluationSnapshot, r);
    expect(v.status).toBe('fail');
    expect(v.mismatches[0]!.kind).toBe('snapshot_invalid');
    const broken = clone(s);
    broken.lines[0]!.kgPerM3 = 'abc';
    expect(validateEvaluation(broken, r).mismatches[0]!.kind).toBe('snapshot_invalid');
    const wrongSchema = clone(r);
    (wrongSchema as { schema: number }).schema = 9;
    expect(kinds(s, wrongSchema)).toContain('metadata_mismatch:schema');
  });
});

describe('agreement across many designs (independent implementations)', () => {
  it('evaluator and validator agree on varied proportions, requests and rulesets', () => {
    const exposures = [['F0'], ['S1'], ['S2'], ['C2'], ['F1'], ['F3'], ['S3'], ['W2']];
    let n = 0;
    for (const mode of ['ACI', 'JS', 'BOTH'] as const)
      for (const exposure of exposures)
        for (const water of ['150.000', '175.000', '200.000'])
          for (const fc of [20, 30, 40]) {
            const s = makeSnapshot({
              mode,
              request: {
                ...makeSnapshot().request,
                exposure,
                fcMpa: fc,
                s3Option: exposure[0] === 'S3' ? 1 : null,
                airPct: exposure[0] === 'F1' ? 5 : 2,
              },
              lines: LINES.map((l) => (l.materialId === 'water' ? { ...l, kgPerM3: water } : l)),
            });
            const v = validateEvaluation(s, evaluate(s));
            expect(v.mismatches, `${mode} ${exposure} ${water} ${fc}`).toEqual([]);
            n++;
          }
    expect(n).toBe(216);
  });
});

describe('exact arithmetic (the validator’s own)', () => {
  it('rationals', () => {
    expect(R('0.1').add(R('0.2')).cmp(R('0.3'))).toBe(0);
    expect(R(1.5e-7).toFixed(9)).toBe('0.000000150');
    expect(R('3.15').mul(R(1000)).toFixed(0)).toBe('3150');
    expect(R('-2.5').toFixed(0)).toBe('-3');
    expect(R('0.0004').toFixed(3)).toBe('0.000');
    expect(R('0.0005').toFixed(3)).toBe('0.001');
    expect(R('1').div(R('3')).toNumber()).toBeCloseTo(1 / 3, 14);
    expect(R('5').sub(R('7')).abs().toNumber()).toBe(2);
    expect(R(1e21).toNumber()).toBe(1e21);
    expect(new Rat(6n, -4n).n).toBe(-3n);
    expect(R('1').gt(R('0'))).toBe(true);
    expect(R('0').isZero()).toBe(true);
    expect(R(5n).neg().toNumber()).toBe(-5);
    expect(() => R('abc')).toThrow(/not a decimal/);
    expect(() => R(1).div(R(0))).toThrow(/division by zero/);
  });
  it('tables: linear, never extrapolating, bins', () => {
    const def = {
      cols: { name: 'x', values: [10, 20] },
      data: [[1, 3]],
      interpolation: 'linear' as const,
    };
    expect(look1d(def, R(15))).toMatchObject({ s: 'ok' });
    expect((look1d(def, R(15)) as { v: Rat }).v.toNumber()).toBe(2);
    expect(look1d(def, R(25)).s).toBe('out');
    expect(look1d(def, R(5)).s).toBe('out');
    expect(look1d({ ...def, interpolation: 'none' }, R(15)).s).toBe('none');
    expect(look1d({ ...def, data: [[1, null]] }, R(20)).s).toBe('none');
    expect(look1d({ ...def, data: [[1, null]] }, R(15)).s).toBe('none');
    expect(look1d(null, R(1)).s).toBe('none');
    const bins = {
      rows: {
        name: 's',
        values: [
          [25, 50],
          [75, 100],
        ] as [number, number][],
      },
      cols: { name: 'n', values: [10, 20] },
      data: [
        [1, 2],
        [3, 4],
      ],
      interpolation: 'linear' as const,
    };
    expect((look2dBins(bins, R(60), R(10)) as { s: string }).s).toBe('between');
    expect(look2dBins(bins, R(30), R(10))).toMatchObject({ s: 'ok' });
    expect(look2dBins(bins, R(200), R(10)).s).toBe('out');
    expect(look2dBins(bins, R(10), R(10)).s).toBe('out');
    expect(look2dBins(def, R(10), R(10)).s).toBe('none');
  });
});

// ---------------------------------------------------------------- independence

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolvePath(here, '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('independence from the evaluator and the optimizer', () => {
  const imports = files(srcDir).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => ({
      file: f,
      spec: m[1]!,
    })),
  );
  it('imports only its own modules, the shared rules resolver, decimal helpers and report types', () => {
    const allowed = (spec: string) =>
      spec.startsWith('./') ||
      spec === '@khalta/rules' ||
      spec === '@khalta/engine/decimal' ||
      spec === '@khalta/engine';
    expect(imports.filter((i) => !allowed(i.spec))).toEqual([]);
  });
  it('never imports the evaluator, the optimizer or any calculation module', () => {
    expect(
      imports.filter((i) =>
        /evaluate|optimizer|characteristics|materials|prices(?!\/decimal)/.test(i.spec),
      ),
    ).toEqual([]);
  });
  it('the engine barrel is used for types only (no runtime value is taken from it)', () => {
    let seen = 0;
    for (const f of files(srcDir)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(
        /^(import|export)\s+(type\s+)?\{[^}]*\}\s+from\s+'@khalta\/engine';/gm,
      )) {
        seen++;
        expect(m[2], `${f}: ${m[0]}`).toBeTruthy();
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

import { scenarios } from '@khalta/engine/testing/scenarios';

describe('agreement on every branch of the evaluator (scenario catalogue)', () => {
  const all = scenarios();
  it('has broad coverage', () => {
    expect(all.length).toBeGreaterThan(100);
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
  });
  it.each(all.map((s) => [s.name, s] as const))('%s', (_n, sc) => {
    const r = evaluate(sc.snapshot);
    const v = validateEvaluation(sc.snapshot, r);
    expect(v.mismatches).toEqual([]);
  });
});

describe('plant strength model recomputation (M5.2)', () => {
  const model = (over: Partial<NonNullable<EvaluationSnapshot['strengthModel']>> = {}) => ({
    id: 'm1',
    a: Math.log(38.3) + 1,
    b: 2,
    wcmMin: 0.4,
    wcmMax: 0.6,
    ageDays: 28,
    basis: 'cylinder' as const,
    groupKey: 'g',
    sMpa: 1.5,
    ...over,
  });
  for (const [name, over] of [
    ['inside the domain', {}],
    ['outside the domain', { wcmMax: 0.45 }],
    ['another age', { ageDays: 7 }],
  ] as const) {
    it(`agrees with the evaluator ${name}`, () => {
      const s = makeSnapshot({ strengthModel: model(over) });
      expect(validateEvaluation(s, evaluate(s)).mismatches).toEqual([]);
    });
  }
  it('catches a report that claims the model governs when it does not, or a wrong governing w/cm', () => {
    const s = makeSnapshot({ strengthModel: model() });
    const r = evaluate(s);
    const tampered = clone(r);
    tampered.strengthAdequacy.governingWc = 0.6;
    expect(kinds(s, tampered)).toContain('strength_mismatch:strengthAdequacy.governingWc');
    const lying = clone(r);
    lying.strengthAdequacy.model = 'none';
    expect(kinds(s, lying)).toContain('strength_mismatch:strengthAdequacy.model');
    const hidden = clone(r);
    delete hidden.strengthAdequacy.modelUse;
    expect(kinds(s, hidden)).toContain('strength_mismatch:strengthAdequacy.modelUse');
  });
});
