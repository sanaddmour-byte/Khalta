// Cross-checks every seeded number against the actual tables and sentences in docs/spec/02-codes.md.
// This catches drift between seeds and the spec text. It does NOT prove either matches ACI or the
// Jordanian code: only a QC manager's verification against the licensed documents can do that.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSeeds } from '../src/loader';
import type { RuleRecord } from '../src/schema';

const md = readFileSync(join(import.meta.dirname, '../../../docs/spec/02-codes.md'), 'utf8');
const lines = md.split('\n');
const { rules } = loadSeeds();
const rule = (ruleset: string, key: string): RuleRecord => {
  const r = rules.find((x) => x.ruleset === ruleset && x.key === key);
  if (!r) throw new Error(`no seed rule ${ruleset}:${key}`);
  return r;
};
const has = (ruleset: string, key: string) =>
  rules.some((x) => x.ruleset === ruleset && x.key === key);

const num = (s: string) =>
  Number(
    s
      .replace(/,/g, '')
      .replace('−', '-')
      .replace(/[^\d.\-]/g, ''),
  );
const nums = (s: string) =>
  [
    ...s
      .replace(/,/g, '')
      .replace(/−/g, '-')
      .matchAll(/-?\d+(?:\.\d+)?/g),
  ].map((m) => Number(m[0]));

function tableAfter(heading: string, startAtHeading = false) {
  const at = lines.findIndex((l) => l.includes(heading));
  if (at < 0) throw new Error(`heading not found in 02-codes.md: ${heading}`);
  let i = startAtHeading ? at : at + 1;
  while (i < lines.length && !lines[i]!.startsWith('|')) i++;
  const rows: string[][] = [];
  for (; i < lines.length && lines[i]!.startsWith('|'); i++)
    rows.push(
      lines[i]!.split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const [header, , ...body] = rows;
  return { header: header!, rows: body };
}
const lineWith = (needle: string) => {
  const l = lines.find((x) => x.includes(needle));
  if (!l) throw new Error(`line not found: ${needle}`);
  return l;
};
const between = (start: string, end: string) => {
  const a = lines.findIndex((l) => l.includes(start));
  if (a < 0) throw new Error(`section not found: ${start}`);
  let b = a + 1;
  while (b < lines.length && !lines[b]!.includes(end)) b++;
  return lines.slice(a, b).join('\n');
};

describe('sulfate exposure thresholds (ACI 318-19 T19.3.1.1)', () => {
  const { rows } = tableAfter('Sulfate exposure thresholds');
  const seed = rule('ACI', 'exposure.sulfate.thresholds').value as {
    class: string;
    soil_so4_pct: (number | null)[];
    water_so4_ppm: (number | null)[];
    seawater: boolean;
  }[];
  const range = (t: string): (number | null)[] => {
    const x = t.replace(/,/g, '');
    if (x.startsWith('<')) return [null, num(x)];
    if (x.startsWith('>')) return [num(x), null];
    const [a, b] = nums(x.split(' ')[0]!.replace('–', ' '));
    return [a!, b!];
  };
  it.each(rows)('class %s', (cls, soil, water) => {
    const s = seed.find((e) => e.class === cls)!;
    expect(s.soil_so4_pct).toEqual(range(soil!));
    expect(s.water_so4_ppm).toEqual(range(water!));
    expect(s.seawater).toBe(/seawater/.test(water!));
  });
  it('covers exactly the classes in the table', () =>
    expect(seed.map((s) => s.class)).toEqual(rows.map((r) => r[0])));
});

describe('durability requirements (ACI 318-19 T19.3.2.1)', () => {
  const { rows } = tableAfter('Durability requirements');
  const key = (label: string) => label.replace(/ opt\. (\d)/, '.opt$1');
  const expectedKeys = new Set<string>();

  it.each(rows)('row %s', (label, wcm, fc, cement, cl, cacl2) => {
    const c = key(label!);
    const k = (suffix: string) => `durability.${c}.${suffix}`;
    // max w/cm
    if (wcm === '—') expect(has('ACI', k('max_wcm')), k('max_wcm')).toBe(false);
    else {
      expect(rule('ACI', k('max_wcm')).value).toBe(Number(wcm));
      expectedKeys.add(k('max_wcm'));
    }
    // min f'c
    expect(rule('ACI', k('min_fc')).value).toBe(Number(fc));
    expectedKeys.add(k('min_fc'));
    // chloride: "non-prestressed / prestressed"
    if (cl === '—') expect(has('ACI', k('max_cl_nonprestressed'))).toBe(false);
    else {
      const [a, b] = cl!.split('/').map((s) => Number(s.trim()));
      expect(rule('ACI', k('max_cl_nonprestressed')).value).toBe(a);
      expect(rule('ACI', k('max_cl_prestressed')).value).toBe(b);
      expectedKeys.add(k('max_cl_nonprestressed')).add(k('max_cl_prestressed'));
    }
    // CaCl2
    if (cacl2 === 'Not permitted') {
      expect(rule('ACI', k('cacl2_prohibited')).value).toBe(true);
      expectedKeys.add(k('cacl2_prohibited'));
    } else expect(has('ACI', k('cacl2_prohibited'))).toBe(false);
    // cement / other column
    if (/Type II/.test(cement!)) {
      expect(rule('ACI', k('sulfate_cement')).value).toEqual(['moderate', 'high']);
      expectedKeys.add(k('sulfate_cement'));
    } else if (/Type V/.test(cement!)) {
      expect(rule('ACI', k('sulfate_cement')).value).toEqual(['high']);
      expectedKeys.add(k('sulfate_cement'));
      if (/pozzolan or slag/.test(cement!)) {
        expect(rule('ACI', k('scm_required')).value).toEqual(['pozzolan', 'slag']);
        expectedKeys.add(k('scm_required'));
      }
    } else
      expect(has('ACI', k('sulfate_cement')), `${c} has no cement requirement in the table`).toBe(
        false,
      );
    if (/ASR mitigation/.test(cement!)) {
      expect(has('ACI', k('asr_mitigation'))).toBe(true);
      expectedKeys.add(k('asr_mitigation'));
    }
    if (/Min cover/.test(cement!)) {
      const r = rule('ACI', k('min_cover'));
      expect(r.kind).toBe('info'); // structural, never a constraint
      expectedKeys.add(k('min_cover'));
    }
  });

  it('the seeds contain no durability rule that the table does not justify', () => {
    const seeded = rules
      .filter((r) => r.ruleset === 'ACI' && r.key.startsWith('durability.'))
      .map((r) => r.key);
    expect(seeded.filter((s) => !expectedKeys.has(s))).toEqual([]);
  });
});

describe('air content for F classes (T19.3.3.1)', () => {
  const { header, rows } = tableAfter('Air content for F classes');
  const nmas = header.slice(1).map(Number);
  it('F1', () => {
    const d = rule('ACI', 'air.F1.target_pct').definition!;
    expect(d.cols.values).toEqual(nmas);
    expect(d.data[0]).toEqual(rows[0]!.slice(1).map(Number));
  });
  it('F2 / F3', () => {
    const d = rule('ACI', 'air.F2_F3.target_pct').definition!;
    expect(d.cols.values).toEqual(nmas);
    expect(d.data[0]).toEqual(rows[1]!.slice(1).map(Number));
  });
  it('tolerance', () =>
    expect(rule('ACI', 'air.tolerance_pct').value).toBe(
      num(lineWith('Air content for F classes').match(/tolerance ± (\d+(?:\.\d+)?)/)![1]!),
    ));
});

describe('SCM limits, max NMAS', () => {
  it('SCM limits for F3 (T26.4.2.2(b))', () => {
    const v = nums(lineWith('SCM limits for F3').split('% of total cementitious):')[1]!);
    const keys = [
      'fly_ash_pozzolan_pct',
      'slag_pct',
      'silica_fume_pct',
      'fly_ash_silica_fume_pct',
      'total_pct',
    ];
    expect(keys.map((k) => rule('ACI', `scm.max.${k}`).value)).toEqual(v);
    for (const k of keys)
      expect(rule('ACI', `scm.max.${k}`).applies_to).toEqual({ exposure: ['F3'] });
  });
  it('max NMAS fractions (§26.4.2.1(a)(4))', () => {
    const fr = [...lineWith('Max NMAS').matchAll(/(\d+\/\d+)/g)].map((m) => m[1]);
    expect(
      ['narrowest_form_dimension', 'slab_depth', 'min_clear_bar_spacing'].map(
        (k) => rule('ACI', `nmas.max_fraction.${k}`).value,
      ),
    ).toEqual(fr);
  });
});

describe("required average strength f'cr (ACI 301 §4.2.3.3)", () => {
  const sec = between('**Required average strength', '**Acceptance');
  const v = (k: string) => rule('ACI', k).value;
  it('n-factor table', () => {
    const nfactor = sec.match(/n-factor: ([^\n]*)/)![1]!;
    const pairs = [...nfactor.matchAll(/(\d+) → (\d+(?:\.\d+)?)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    const d = rule('ACI', 'fcr.statistical.n_factor').definition!;
    expect(d.cols.values).toEqual(pairs.map((p) => p[0]));
    expect(d.data[0]).toEqual(pairs.map((p) => p[1]));
  });
  it("minimum tests and f'c window", () => {
    expect(v('fcr.statistical.min_tests')).toBe(Number(sec.match(/≥ (\d+) consecutive tests/)![1]));
    expect(v('fcr.statistical.fc_window_mpa')).toBe(Number(sec.match(/within (\d+) MPa/)![1]));
  });
  it("f'c ≤ 35 equation: max(f'c + 1.34s, f'c + 2.33s − 3.45)", () => {
    const m = sec.match(
      /f'c ≤ 35 MPa: f'cr = max\(f'c \+ (\d+(?:\.\d+)?)s, f'c \+ (\d+(?:\.\d+)?)s − (\d+(?:\.\d+)?)\)/,
    )!;
    expect([
      v('fcr.statistical.le35.k1'),
      v('fcr.statistical.le35.k2'),
      v('fcr.statistical.le35.offset'),
    ]).toEqual([m[1], m[2], m[3]].map(Number));
    expect(v('fcr.threshold_mpa')).toBe(35);
  });
  it("f'c > 35 equation: max(f'c + 1.34s, 0.90·f'c + 2.33s)", () => {
    const m = sec.match(
      /f'c > 35 MPa: f'cr = max\(f'c \+ (\d+(?:\.\d+)?)s, (\d+(?:\.\d+)?)·f'c \+ (\d+(?:\.\d+)?)s\)/,
    )!;
    expect([
      v('fcr.statistical.gt35.k1'),
      v('fcr.statistical.gt35.factor'),
      v('fcr.statistical.gt35.k2'),
    ]).toEqual([m[1], m[2], m[3]].map(Number));
  });
  it("without data: < 21 → +7.0; 21–35 → +8.3; > 35 → 1.10·f'c + 5.0", () => {
    const m = sec.match(
      /Without data: f'c < (\d+) → f'c \+ (\d+(?:\.\d+)?); (\d+) ≤ f'c ≤ (\d+) → f'c \+ (\d+(?:\.\d+)?); f'c > (\d+) → (\d+(?:\.\d+)?)·f'c \+ (\d+(?:\.\d+)?)/,
    )!;
    expect(v('fcr.no_data.lower_threshold_mpa')).toBe(Number(m[1]));
    expect(v('fcr.no_data.lt21.add')).toBe(Number(m[2]));
    expect(Number(m[3])).toBe(Number(m[1]));
    expect(v('fcr.no_data.mid.add')).toBe(Number(m[5]));
    expect(Number(m[4])).toBe(v('fcr.threshold_mpa'));
    expect(v('fcr.no_data.gt35.factor')).toBe(Number(m[7]));
    expect(v('fcr.no_data.gt35.add')).toBe(Number(m[8]));
  });
});

describe('acceptance (ACI 318-19 §26.12.3.1)', () => {
  const l = lineWith('**Acceptance — ACI 318-19');
  it("every average of 3 consecutive tests ≥ f'c; single test −3.5 MPa (≤ 35) or 0.90·f'c (> 35)", () => {
    expect(rule('ACI', 'accept.avg3.min_ratio_fc').value).toBe(1);
    const m = l.match(
      /f'c − (\d+(?:\.\d+)?) MPa \(f'c ≤ (\d+)\) or below (\d+(?:\.\d+)?)·f'c \(f'c > (\d+)\)/,
    )!;
    expect(rule('ACI', 'accept.single.max_deficit_mpa').value).toBe(Number(m[1]));
    expect(rule('ACI', 'accept.single.max_deficit_mpa').applies_to).toEqual({
      fc_mpa: { lte: Number(m[2]) },
    });
    expect(rule('ACI', 'accept.single.min_ratio_fc').value).toBe(Number(m[3]));
    expect(rule('ACI', 'accept.single.min_ratio_fc').applies_to).toEqual({
      fc_mpa: { gt: Number(m[4]) },
    });
    expect(rule('ACI', 'accept.fc_threshold_mpa').value).toBe(Number(m[2]));
  });
});

describe('ACI 211.1 baseline tables', () => {
  it('water and entrapped air (T6.3.3)', () => {
    const { header, rows } = tableAfter('Water, kg/m³ — T6.3.3');
    const d = rule('ACI', 'prop.water.non_ae').definition!;
    expect(d.cols.values).toEqual(header.slice(1).map(Number));
    const water = rows.filter((r) => /^\d/.test(r[0]!));
    expect(d.data).toEqual(water.map((r) => r.slice(1).map(Number)));
    expect(d.rows!.values).toEqual(water.map((r) => nums(r[0]!.replace('–', ' '))));
    const air = rows.find((r) => r[0]!.startsWith('Entrapped air'))!;
    expect(rule('ACI', 'prop.air_entrapped.non_ae').definition!.data[0]).toEqual(
      air.slice(1).map(Number),
    );
  });
  it('w/c vs strength (T6.3.4(a)), table is listed strongest-first, the seed ascending', () => {
    const { header, rows } = tableAfter('w/c vs 28-day cylinder strength');
    const d = rule('ACI', 'prop.wc_strength.non_ae').definition!;
    const spec = new Map(header.slice(1).map((h, i) => [Number(h), Number(rows[0]![i + 1])]));
    expect(d.cols.values.length).toBe(spec.size);
    d.cols.values.forEach((s, i) => expect(d.data[0]![i]).toBe(spec.get(s)));
  });
  it('coarse aggregate volume (T6.3.6)', () => {
    const { header, rows } = tableAfter('Dry-rodded coarse aggregate volume');
    const d = rule('ACI', 'prop.ca_volume').definition!;
    expect(d.cols.values).toEqual(header.slice(1).map(Number));
    expect(d.rows!.values).toEqual(rows.map((r) => Number(r[0])));
    expect(d.data).toEqual(rows.map((r) => r.slice(1).map(Number)));
  });
  it('are design aids only', () => {
    for (const k of [
      'prop.water.non_ae',
      'prop.air_entrapped.non_ae',
      'prop.wc_strength.non_ae',
      'prop.ca_volume',
    ])
      expect(rule('ACI', k).requirement_class).toBe('DESIGN_AID');
  });
});

describe('slump tolerance and hot weather', () => {
  it('ASTM C94 bands', () => {
    const l = lineWith('**Slump tolerance — ASTM C94');
    const m = l.match(
      /≤ (\d+) mm → ± (\d+) mm; (\d+)–(\d+) mm → ± (\d+) mm; > (\d+) mm → ± (\d+) mm/,
    )!;
    expect([
      rule('ACI', 'tolerance.slump.band1').value,
      rule('ACI', 'tolerance.slump.band2').value,
      rule('ACI', 'tolerance.slump.band3').value,
    ]).toEqual([Number(m[2]), Number(m[5]), Number(m[7])]);
    expect(rule('ACI', 'tolerance.slump.band1').applies_to).toEqual({
      slump_mm: { lte: Number(m[1]) },
    });
    expect(rule('ACI', 'tolerance.slump.band2').applies_to).toEqual({
      slump_mm: { gt: Number(m[3]), lte: Number(m[4]) },
    });
    expect(rule('ACI', 'tolerance.slump.band3').applies_to).toEqual({
      slump_mm: { gt: Number(m[6]) },
    });
  });
  it('hot weather default (ACI 305.1)', () => {
    expect(rule('ACI', 'hot.max_concrete_temp_c').value).toBe(
      Number(lineWith('**Hot weather — ACI 305.1').match(/placement (\d+) °C/)![1]),
    );
  });
});

describe('cross-code equivalence and Jordanian taxonomy (02-codes §5)', () => {
  const { rows } = tableAfter('| ACI requirement |', true);
  it('C₃A limits for Type II / MS and Type V / HS', () => {
    const [moderate, high] = rows;
    expect(rule('SHARED', 'cement.equivalence.moderate.max_c3a_pct').value).toBe(
      Number(moderate![1]!.match(/C₃A ≤ (\d+)%/)![1]),
    );
    expect(rule('SHARED', 'cement.equivalence.high.max_c3a_pct').value).toBe(
      Number(high![1]!.match(/C₃A ≤ (\d+)%/)![1]),
    );
  });
  it('JS 30-1 cement taxonomy', () => {
    const l = lineWith('**JS seed skeleton:**');
    const list = l.match(/EN 197-1 \(([^)]+)\)/)![1]!.split(', ');
    expect(rule('JS', 'cement.taxonomy').value).toEqual(list);
  });
  it('EN 197-1 sulfate-resisting definitions for CEM I', () => {
    const l = lineWith('**JS seed skeleton:**');
    const m = l.match(/SR0: C₃A = (\d+)%; SR3: ≤ (\d+)%; SR5: ≤ (\d+)%/)!;
    expect(
      ['SR0', 'SR3', 'SR5'].map((k) => rule('JS', `cement.sr_definitions.${k}.max_c3a_pct`).value),
    ).toEqual([m[1], m[2], m[3]].map(Number));
  });
});

describe('strength basis mapping', () => {
  const { rows } = tableAfter('**Strength basis mapping**');
  const seed = rule('SHARED', 'strength.basis_map').value as {
    cylinder_mpa: number;
    cube_mpa: number;
    en_class: string;
    b_grade: string | null;
    b_grade_candidates?: string[];
  }[];
  it.each(rows)('cylinder %s MPa', (cyl, cube, en, b) => {
    const s = seed.find((e) => e.cylinder_mpa === Number(cyl))!;
    expect([s.cube_mpa, s.en_class]).toEqual([Number(cube), en]);
    if (/confirm/.test(b!)) {
      // two candidates in the spec: stored unresolved, never silently picked
      expect(s.b_grade).toBeNull();
      expect(s.b_grade_candidates).toEqual(b!.match(/B\d+/g));
    } else expect(s.b_grade).toBe(b);
  });
  it('has exactly the spec rows', () =>
    expect(seed.map((e) => String(e.cylinder_mpa))).toEqual(rows.map((r) => r[0])));
});

describe('engineering parameters (02-codes §6 starter values)', () => {
  const { rows } = tableAfter('Stored in `packages/rules/seeds/engineering');
  const row = (name: string) => rows.find((r) => r[0] === name)!;
  const v = (k: string) => rule('ENGINEERING', k).value;
  it('Shilstone CF band', () => {
    const [lo, hi] = nums(row('Shilstone CF band')[1]!.replace('–', ' '));
    expect([v('eng.shilstone.cf.min'), v('eng.shilstone.cf.max')]).toEqual([lo, hi]);
  });
  it('WF binder adjustment', () => {
    const m = row('WF binder adjustment')[1]!.match(
      /\+(\d+(?:\.\d+)?) WF points per (\d+) kg\/m³ binder above (\d+) kg/,
    )!;
    expect([
      v('eng.shilstone.wf.binder_adjust.points'),
      v('eng.shilstone.wf.binder_adjust.per_kg'),
      v('eng.shilstone.wf.binder_adjust.above_kg'),
    ]).toEqual([m[1], m[2], m[3]].map(Number));
  });
  it('robustness margins', () => {
    const m = row('Robustness margins')[1]!.match(
      /w\/cm − (\d+(?:\.\d+)?); grading (\d+) percentage/,
    )!;
    expect([v('eng.margin.wcm'), v('eng.margin.grading_pct_points')]).toEqual([
      Number(m[1]),
      Number(m[2]),
    ]);
  });
  it('0.45 power curve default; values the spec leaves to Sanad stay null', () => {
    expect(v('eng.grading.target.exponent')).toBe(0.45);
    for (const name of [
      'Shilstone WF band',
      'Max combined % passing 75 µm',
      'Pumpable: min % passing 0.3 mm',
    ])
      expect(row(name)[1]).toMatch(/Sanad sets/);
    expect([
      v('eng.shilstone.wf.min'),
      v('eng.fines.max_pct_75um'),
      v('eng.pumpable.min_passing_0_3mm_pct'),
    ]).toEqual([null, null, null]);
    expect(row('β_FM, β_75 water adjustments')[1]).toMatch(/null until calibrated/);
    expect([v('eng.water.beta_fm'), v('eng.water.beta_75')]).toEqual([null, null]);
  });
  it('the ±10% coarse-aggregate sanity bound from §4', () => {
    expect(v('eng.ca_volume.sanity_band_pct')).toBe(
      Number(lineWith('sanity bound on the optimized blend').match(/± (\d+)% sanity bound/)![1]),
    );
  });
});

describe('no code value is duplicated in TypeScript (CLAUDE.md rule 2)', () => {
  it('source files in packages/ and apps/ contain none of the distinctive code constants', async () => {
    const { readdirSync, readFileSync: rf, statSync } = await import('node:fs');
    const root = join(import.meta.dirname, '../../..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (
          ['node_modules', 'dist', 'coverage', 'seeds', 'test', 'migrations', '.turbo'].includes(n)
        )
          continue;
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) files.push(f);
      }
    };
    for (const d of ['packages', 'apps']) walk(join(root, d));
    // distinctive numbers/strings from the tables (a loose check: these should only live in YAML)
    const forbidden = [
      /\b207\b/,
      /\b0\.47\b/,
      /\b1\.16\b/,
      /\b8\.3\b/,
      /\b3\.45\b/,
      /T19\.3\.2\.1/,
      /JSC-2022/,
      /B350/,
      /\b2\.33\b/,
    ];
    const hits: string[] = [];
    for (const f of files) {
      const src = rf(f, 'utf8');
      for (const re of forbidden) if (re.test(src)) hits.push(`${f.replace(root, '')}: ${re}`);
    }
    expect(hits).toEqual([]);
  });
});
