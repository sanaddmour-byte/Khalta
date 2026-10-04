// Strength-model and trial governance: chronological validation, source changes, optional trial criteria.
import { describe, expect, it } from 'vitest';
import {
  chronologicalCheck,
  evaluateTrialAcceptance,
  FIT_VERSION,
  fitModel,
  groupKey,
  groupOf,
  invalidations,
  type StrengthPoint,
  type TrialBatch,
  type TrialCriteria,
} from '../src';

// ln f = 4.2 − 2.0·(w/cm) with ±3 % deterministic scatter, cast over many weeks: SYNTHETIC points.
const curve = (wcm: number) => Math.exp(4.2 - 2.0 * wcm);
const day = (i: number) =>
  `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
const noise = (i: number) => 1 + ((((i * 37) % 19) - 9) / 9) * 0.03;
/** `shiftFrom`: from that index on the process is `shift` times stronger (a new lot, a season). */
const points = (n: number, shiftFrom = Infinity, shift = 1): StrengthPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const wcm = 0.35 + ((i * 7) % 11) * 0.02;
    return {
      id: `p${String(i).padStart(3, '0')}`,
      wcm,
      mpa: curve(wcm) * noise(i) * (i >= shiftFrom ? shift : 1),
      castDate: day(i),
    };
  });

describe('chronological validation', () => {
  it('a stable process is validated forward in time and the fit says which rules it used', () => {
    const r = fitModel(points(60))!;
    expect(r.chronological).not.toBeNull();
    expect(r.chronological!.method).toBe('chronological');
    expect(r.chronological!.n).toBeGreaterThan(20);
    expect(r.reasons.map((x) => x.code).filter((c) => c.startsWith('chronological_'))).toEqual([]);
    expect(FIT_VERSION).toBe('2');
  });

  it('a step change after the early data fails forward-in-time validation even though the whole-data s hides it', () => {
    const r = fitModel(points(60, 45, 1.4))!;
    expect(r.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['chronological_miss']));
    expect(r.status).toBe('provisional');
    expect(r.chronological!.maxStandardised).toBeGreaterThan(3);
  });

  it('everything cast on one day cannot be validated chronologically, and says so', () => {
    const same = points(40).map((p) => ({ ...p, castDate: '2026-03-01' }));
    expect(chronologicalCheck(same, 3)).toBeNull();
    const r = fitModel(same)!;
    expect(r.reasons.map((x) => x.code)).toContain('no_chronological');
    expect(r.status).toBe('provisional');
  });

  it('only earlier-cast results ever train a prediction (no peeking)', () => {
    const base = points(40);
    const a = chronologicalCheck(base, 3)!;
    // a LATER wild result adds one tested point and cannot change any earlier prediction
    const withFuture = chronologicalCheck(
      [...base, { id: 'zz', wcm: 0.4, mpa: 1000, castDate: '2027-12-31' }],
      3,
    )!;
    expect(withFuture.n).toBe(a.n + 1);
    expect(withFuture.worstMissMpa).toBeGreaterThan(a.worstMissMpa);
  });
});

describe('source changes', () => {
  const mats = [
    { id: 'c1', category: 'cement' as const, kind: 'OPC', supplierId: 'S1' },
    { id: 'm1', category: 'scm' as const, kind: 'fly_ash', supplierId: 'S2' },
  ];
  const g = groupOf('plant', 'cylinder', 28, mats)!;
  it('records the suppliers without changing the group key', () => {
    expect(g.sources).toEqual({ c1: 'S1', m1: 'S2' });
    expect(groupKey(g)).toBe(groupKey({ ...g, sources: { c1: 'OTHER', m1: 'S2' } }));
  });
  it('an in-place supplier change invalidates the model by name; the same supplier does not', () => {
    expect(invalidations(g, mats, 5)).toEqual([]);
    const moved = mats.map((m) => (m.id === 'c1' ? { ...m, supplierId: 'S9' } : m));
    expect(invalidations(g, moved, 5).map((x) => x.code)).toEqual(['source_changed']);
  });
  it('a model fitted before sources were recorded is not invalidated by a supplier it never knew', () => {
    const { sources: _s, ...old } = g;
    const moved = mats.map((m) => ({ ...m, supplierId: 'S9' }));
    expect(invalidations(old, moved, 5)).toEqual([]);
  });
});

describe('optional trial criteria', () => {
  const base: TrialCriteria = {
    slumpToleranceMm: 25,
    airTolerancePct: 1.5,
    densityBandKgM3: 40,
    yieldBandM3: 0.01,
    temperatureMaxC: 32,
  };
  const batch: TrialBatch = {
    id: 'b1',
    batchedOn: '2026-10-01',
    slumpMm: 100,
    airPct: 2,
    temperatureC: 25,
    freshDensityKgM3: 2400,
    yieldM3: 1,
    strengthMpa: [40],
  };
  const targets = { slumpMm: 100, airPct: 2, densityKgM3: 2400, fcrMpa: 38 };
  const status = (c: TrialCriteria, b: TrialBatch, t = targets) =>
    Object.fromEntries(evaluateTrialAcceptance(c, t, [b]).criteria.map((x) => [x.id, x.status]));

  it('unconfigured criteria are not applied and do not block', () => {
    const r = evaluateTrialAcceptance(base, targets, [batch]);
    expect(r.ok).toBe(true);
    expect(status(base, batch)).toMatchObject({
      retention: 'not_applicable',
      stability: 'not_applicable',
      placement: 'not_applicable',
    });
  });

  it('a pumpable design with no placement criterion on file BLOCKS and names it', () => {
    const r = evaluateTrialAcceptance(base, { ...targets, pumpable: true }, [batch]);
    expect(r.ok).toBe(false);
    expect(r.criteria.find((c) => c.id === 'placement')).toMatchObject({
      status: 'missing',
      missing: 'eng.trial.placement_required',
    });
  });

  it('retention needs both parameters, a measurement taken late enough, and a high enough slump', () => {
    const half = { ...base, retentionMinSlumpMm: 80 };
    expect(
      evaluateTrialAcceptance(half, targets, [batch]).criteria.find((c) => c.id === 'retention'),
    ).toMatchObject({
      status: 'missing',
      missing: 'eng.trial.retention_minutes',
    });
    const cfg = { ...base, retentionMinSlumpMm: 80, retentionMinutes: 60 };
    expect(status(cfg, batch).retention).toBe('missing'); // nothing measured
    expect(status(cfg, { ...batch, retainedSlumpMm: 90, retentionMinutes: 30 }).retention).toBe(
      'missing',
    ); // too early
    expect(status(cfg, { ...batch, retainedSlumpMm: 90, retentionMinutes: 60 }).retention).toBe(
      'pass',
    );
    expect(status(cfg, { ...batch, retainedSlumpMm: 70, retentionMinutes: 90 }).retention).toBe(
      'fail',
    );
  });

  it('stability passes only when stable; placement only when acceptable', () => {
    const cfg = { ...base, stabilityRequired: 1, placementRequired: 1 };
    expect(status(cfg, batch)).toMatchObject({ stability: 'missing', placement: 'missing' });
    for (const bad of ['bleeding', 'segregation', 'bleeding_and_segregation'] as const)
      expect(status(cfg, { ...batch, stability: bad, placementAcceptable: true }).stability).toBe(
        'fail',
      );
    const ok = status(cfg, { ...batch, stability: 'stable', placementAcceptable: true });
    expect(ok).toMatchObject({ stability: 'pass', placement: 'pass' });
    expect(
      status(cfg, { ...batch, stability: 'stable', placementAcceptable: false }).placement,
    ).toBe('fail');
    expect(
      evaluateTrialAcceptance(cfg, targets, [
        { ...batch, stability: 'stable', placementAcceptable: true },
      ]).ok,
    ).toBe(true);
  });
});
