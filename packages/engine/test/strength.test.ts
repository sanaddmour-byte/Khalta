import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  belowBandSequence,
  betaProposal,
  combinedP75,
  DEFAULT_FIT_LIMITS,
  fitModel,
  groupKey,
  groupOf,
  invalidations,
  judgeAcceptance,
  lowerBandMpa,
  predictMpa,
  sRefit,
  windowStart,
  wcmForStrength,
  type GroupMaterial,
  type StrengthPoint,
} from '../src/index';

// SYNTHETIC: ln f = 4.4 − 2.0·w/cm, plus a deterministic ± wobble so s > 0.
const WCMS = [0.4, 0.5, 0.6];
function points(n: number, wobble = 1.5): StrengthPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const w = WCMS[i % 3]!;
    const noise = ((i * 7) % 5) - 2; // −2..2
    return {
      id: `p${String(i).padStart(3, '0')}`,
      wcm: w,
      mpa: Math.exp(4.4 - 2.0 * w) + (noise * wobble) / 2,
      castDate: '2026-06-01',
    };
  });
}

describe('fitModel', () => {
  it('recovers an exact curve (hand-worked: a = 4.4, b = 2.0, s = 0)', () => {
    const pts = WCMS.flatMap((w, k) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `e${k}-${i}`,
        wcm: w,
        mpa: Math.exp(4.4 - 2 * w),
        castDate: '2026-06-01',
      })),
    );
    const f = fitModel(pts)!;
    expect(f.a).toBeCloseTo(4.4, 5);
    expect(f.b).toBeCloseTo(2.0, 5);
    expect(f.sMpa).toBeCloseTo(0, 5);
    expect(f.n).toBe(30);
    expect(f.levels).toBe(3);
    expect(f.status).toBe('valid');
    expect(wcmForStrength(f, predictMpa(f, 0.5))).toBeCloseTo(0.5, 5);
  });

  it('matches a hand-computed least-squares line on four points', () => {
    // x = 0.4,0.5,0.6,0.7 ; y = ln f with f = 60, 50, 40, 30 → hand OLS: slope = Σ(x−x̄)(y−ȳ)/Σ(x−x̄)²
    const xs = [0.4, 0.5, 0.6, 0.7];
    const fs = [60, 50, 40, 30];
    const ys = fs.map(Math.log);
    const xb = 0.55;
    const yb = ys.reduce((a, b) => a + b) / 4;
    const slope =
      xs.reduce((s, x, i) => s + (x - xb) * (ys[i]! - yb), 0) /
      xs.reduce((s, x) => s + (x - xb) ** 2, 0);
    const f = fitModel(
      xs.map((w, i) => ({ id: `h${i}`, wcm: w, mpa: fs[i]!, castDate: '2026-06-01' })),
    )!;
    expect(f.b).toBeCloseTo(-slope, 5);
    expect(f.a).toBeCloseTo(yb - slope * xb, 5);
  });

  it('is invariant to the order of the rows', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(points(36), { minLength: 36, maxLength: 36 }), (rows) => {
        const a = fitModel(points(36))!;
        const b = fitModel(rows)!;
        expect(b.a).toBeCloseTo(a.a, 5);
        expect(b.b).toBeCloseTo(a.b, 5);
        expect(b.heldOut?.rmseMpa).toBeCloseTo(a.heldOut!.rmseMpa, 5);
      }),
    );
  });

  it('predicts strength that falls as w/cm rises', () => {
    const f = fitModel(points(36))!;
    fc.assert(
      fc.property(
        fc.double({ min: 0.3, max: 0.7, noNaN: true }),
        fc.double({ min: 0.001, max: 0.2, noNaN: true }),
        (w, d) => {
          expect(predictMpa(f, w + d)).toBeLessThan(predictMpa(f, w));
        },
      ),
    );
  });
});

describe('validity matrix (each threshold on both sides)', () => {
  it('valid at exactly the thresholds', () => {
    const f = fitModel(points(30))!;
    expect(f.reasons).toEqual([]);
    expect(f.status).toBe('valid');
  });
  it('29 results is provisional, naming the count', () => {
    const f = fitModel(points(29))!;
    expect(f.status).toBe('provisional');
    expect(f.reasons.map((r) => r.code)).toContain('too_few_results');
  });
  it('two w/cm levels is provisional', () => {
    const pts = points(36).filter((p) => p.wcm !== 0.5);
    const f = fitModel(pts)!;
    expect(f.reasons.map((r) => r.code)).toContain('too_few_levels');
  });
  it('a span of 0.09 is provisional and 0.10 is not', () => {
    const narrow = (hi: number) =>
      Array.from({ length: 36 }, (_, i) => {
        const w = [0.4, (0.4 + hi) / 2, hi][i % 3]!;
        return { id: `n${i}`, wcm: w, mpa: Math.exp(4.4 - 2 * w), castDate: '2026-06-01' };
      });
    expect(fitModel(narrow(0.49))!.reasons.map((r) => r.code)).toContain('span_too_narrow');
    expect(fitModel(narrow(0.5))!.reasons.map((r) => r.code)).not.toContain('span_too_narrow');
  });
  it('a rising curve is never valid', () => {
    const pts = points(36).map((p) => ({ ...p, mpa: Math.exp(2 + 2 * p.wcm) }));
    expect(fitModel(pts)!.reasons.map((r) => r.code)).toContain('slope_not_positive');
  });
  it('a wild held-out result fails the held-out checks', () => {
    const pts = points(36);
    pts[5] = { ...pts[5]!, mpa: pts[5]!.mpa * 3 };
    const codes = fitModel(pts)!.reasons.map((r) => r.code);
    expect(codes.some((c) => c === 'held_out_miss' || c === 'held_out_rmse')).toBe(true);
    expect(fitModel(pts)!.status).toBe('provisional');
  });
  it('never valid below any threshold (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 29 }), (n) => {
        expect(fitModel(points(n))?.status ?? 'provisional').toBe('provisional');
      }),
    );
  });
  it('too few to hold out says so', () => {
    expect(fitModel(points(4))!.reasons.map((r) => r.code)).toContain('no_held_out');
  });
  it('the time window is a date cutoff', () => {
    expect(windowStart('2026-10-03', 12)).toBe('2025-10-03');
    expect(windowStart('2026-03-31', 1)).toBe('2026-02-28');
    expect(DEFAULT_FIT_LIMITS.minResults).toBe(30);
  });
});

describe('model invalidation', () => {
  const mats: GroupMaterial[] = [
    { id: 'c1', category: 'cement', kind: 'CEM I' },
    { id: 's1', category: 'scm', kind: 'fly_ash' },
    { id: 'a1', category: 'admixture', kind: 'F' },
  ];
  const g = groupOf('plantA', 'cylinder', 28, mats)!;
  it('still holds against unchanged materials with recent results', () => {
    expect(invalidations(g, mats, 5)).toEqual([]);
  });
  it('a different cement, SCM or admixture type invalidates', () => {
    const swap = (id: string, kind: string) => mats.map((m) => (m.id === id ? { ...m, kind } : m));
    expect(invalidations(g, swap('c1', 'CEM II'), 5)[0]!.code).toBe('cement_type_changed');
    expect(invalidations(g, swap('s1', 'ggbs'), 5)[0]!.code).toBe('scm_type_changed');
    expect(invalidations(g, swap('a1', 'D'), 5)[0]!.code).toBe('admixture_type_changed');
  });
  it('a retired material or no recent results invalidates', () => {
    expect(invalidations(g, mats.slice(1), 5)[0]!.code).toBe('material_missing');
    expect(invalidations(g, mats, 0)[0]!.code).toBe('no_recent_results');
  });
  it('groups differ by every part of the key', () => {
    const base = groupKey(g);
    expect(groupKey({ ...g, basis: 'cube' })).not.toBe(base);
    expect(groupKey({ ...g, ageDays: 7 })).not.toBe(base);
    expect(groupKey({ ...g, plantId: 'plantB' })).not.toBe(base);
    expect(groupKey({ ...g, cementId: 'c2' })).not.toBe(base);
    expect(groupKey({ ...g, scm: [] })).not.toBe(base);
    expect(groupKey({ ...g, admixtures: [] })).not.toBe(base);
  });
  it('two cements cannot be one group', () => {
    expect(
      groupOf('p', 'cylinder', 28, [...mats, { id: 'c2', category: 'cement', kind: null }]),
    ).toBeNull();
  });
});

describe('acceptance (rule values passed in)', () => {
  const rules = {
    avg3MinRatio: 1,
    thresholdMpa: 35,
    singleMaxDeficitMpa: 3.5,
    singleMinRatio: 0.9,
    verified: false,
  };
  it('a clean sequence is ok', () => {
    const r = judgeAcceptance(30, [32, 31, 33, 34], rules);
    expect(r.status).toBe('ok');
    expect(r.latestAvg3Mpa).toBeCloseTo(32.667, 3);
  });
  it('the running average of 3 below f′c breaches', () => {
    const r = judgeAcceptance(30, [29.5, 29, 30, 29.8], rules);
    expect(r.status).toBe('breach');
    expect(r.breaches.map((b) => b.kind)).toContain('avg3');
  });
  it('one test more than 3.5 MPa under f′c (f′c ≤ 35) breaches; above 35 it is 90 %', () => {
    expect(judgeAcceptance(30, [32, 33, 26.4], rules).breaches.map((b) => b.kind)).toContain(
      'single',
    );
    expect(judgeAcceptance(30, [32, 33, 26.6], rules).breaches.map((b) => b.kind)).not.toContain(
      'single',
    );
    expect(judgeAcceptance(40, [45, 45, 35.9], rules).breaches.map((b) => b.kind)).toContain(
      'single',
    );
    expect(judgeAcceptance(40, [45, 45, 36.1], rules).breaches.map((b) => b.kind)).not.toContain(
      'single',
    );
  });
  it('a recovered sequence no longer breaches (alerts expire)', () => {
    expect(judgeAcceptance(30, [26, 27, 28, 36, 36, 36], rules).status).toBe('ok');
  });
  it('a missing rule value is unknown, never ok', () => {
    const r = judgeAcceptance(30, [20, 20, 20], { ...rules, avg3MinRatio: null });
    expect(r.status).toBe('unknown');
    expect(r.missing).toContain('accept.avg3.min_ratio_fc');
  });
  it('the sequence rule needs n consecutive tests under the band', () => {
    const f = fitModel(points(36))!;
    const band = lowerBandMpa(f, 0.5, f.sMpa);
    expect(belowBandSequence([band - 1, band - 1, band - 1], band, 3)).toBe(true);
    expect(belowBandSequence([band - 1, band + 1, band - 1], band, 3)).toBe(false);
    expect(belowBandSequence([band - 1, band - 1], band, 3)).toBe(false);
  });
});

describe('proposals', () => {
  it('s refit: sample SD with n − 1, eligible from 30, flags a higher s than the model', () => {
    const ms = [30, 32, 34];
    const p = sRefit(ms, 1.5);
    expect(p.sMpa).toBeCloseTo(2, 6);
    expect(p.enoughForCode).toBe(false);
    expect(p.higherThanModel).toBe(true);
    expect(
      sRefit(
        Array.from({ length: 30 }, (_, i) => 30 + (i % 2)),
        5,
      ).enoughForCode,
    ).toBe(true);
  });
  it('β: recovers a known linear relation and names what is missing otherwise', () => {
    // water = 250 − 20·FM + 3·P75 + 0.3·slump  → β_FM = 20, β_75 = 3
    const rows = Array.from({ length: 16 }, (_, i) => {
      const fm = 2.4 + ((i * 3) % 7) * 0.1;
      const p75 = 2 + ((i * 5) % 6) * 0.4;
      const slump = 80 + ((i * 7) % 4) * 20;
      return {
        id: `b${i}`,
        fm,
        p75,
        slumpMm: slump,
        waterKgM3: 250 - 20 * fm + 3 * p75 + 0.3 * slump,
      };
    });
    const p = betaProposal(rows);
    expect(p.ok).toBe(true);
    expect(p.betaFm).toBeCloseTo(20, 4);
    expect(p.betaP75).toBeCloseTo(3, 4);
    expect(betaProposal(rows.slice(0, 11)).missing.map((m) => m.code)).toContain('too_few_batches');
    expect(betaProposal(rows.map((r) => ({ ...r, fm: 2.7 }))).missing.map((m) => m.code)).toContain(
      'no_fm_variation',
    );
  });
});

describe('combined 75 µm passing', () => {
  const fine = [
    { sieve_mm: 0.15, passing_pct: 10 },
    { sieve_mm: 0.075, passing_pct: 4 },
  ];
  const coarse = [
    { sieve_mm: 4.75, passing_pct: 2 },
    { sieve_mm: 0.15, passing_pct: 0 },
  ];
  it('mass-weights the entered point and what the data forces', () => {
    expect(
      combinedP75([
        { kg: 600, sieve: fine },
        { kg: 1200, sieve: coarse },
      ]),
    ).toBeCloseTo((600 * 4 + 1200 * 0) / 1800, 9);
    expect(combinedP75([{ kg: 100, sieve: [{ sieve_mm: 0.01, passing_pct: 100 }] }])).toBe(100);
  });
  it('is null when a gradation does not reach 75 µm or is missing', () => {
    expect(combinedP75([{ kg: 600, sieve: [{ sieve_mm: 4.75, passing_pct: 50 }] }])).toBeNull();
    expect(combinedP75([{ kg: 600, sieve: undefined }])).toBeNull();
    expect(combinedP75([])).toBeNull();
  });
});
