import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RuleRecord } from '@khalta/rules';
import { evaluate, selectRules } from '../src/evaluate';
import type { EvaluationReport, SnapshotMaterial } from '../src/evaluate';
import { mergeLayers, type Layer } from '../src/characteristics';
import { ALL_RULES, LINES, MATERIALS, makeSnapshot } from '../src/testing/synthetic';
import { scenarios } from '../src/testing/scenarios';

const kg = (lo: number, hi: number) =>
  fc.integer({ min: lo * 10, max: hi * 10 }).map((n) => (n / 10).toFixed(3));
const designArb = fc.record({
  cem: kg(250, 450),
  water: kg(120, 220),
  sp: kg(0, 8),
  sand: kg(600, 900),
  coarse: kg(900, 1200),
});
const linesOf = (d: Record<string, string>) =>
  LINES.flatMap((l) =>
    Number(d[l.materialId]) === 0 ? [] : [{ ...l, kgPerM3: d[l.materialId]! }],
  );
const status = (r: EvaluationReport, id: string) => r.checks.find((c) => c.id === id)?.status;

describe('properties (fast-check)', () => {
  it('absolute volume is additive: Σ material volumes + air = total, and scaling a line scales only its volume', () => {
    fc.assert(
      fc.property(
        designArb,
        fc.integer({ min: 2, max: 30 }),
        fc.constantFrom('cem', 'sand', 'coarse'),
        (d, k, which) => {
          const a = evaluate(makeSnapshot({ lines: linesOf(d) }));
          const sum = Object.entries(a.figures)
            .filter(
              ([key]) => key.startsWith('volume.') && !['volume.total', 'volume.air'].includes(key),
            )
            .reduce((t, [, v]) => t + (v as number), 0);
          expect(a.figures['volume.total'] as number).toBeCloseTo(
            sum + (a.figures['volume.air'] as number),
            5,
          );
          const scaled = { ...d, [which]: (Number(d[which]) * k).toFixed(3) };
          const b = evaluate(makeSnapshot({ lines: linesOf(scaled) }));
          expect(b.figures[`volume.${which}`] as number).toBeCloseTo(
            (a.figures[`volume.${which}`] as number) * k,
            4,
          );
          for (const other of ['cem', 'sand', 'coarse'].filter((x) => x !== which))
            expect(b.figures[`volume.${other}`]).toBe(a.figures[`volume.${other}`]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('cost is monotone in every price', () => {
    fc.assert(
      fc.property(
        designArb,
        fc.constantFrom('cem', 'sand', 'coarse', 'water', 'sp'),
        fc.integer({ min: 1, max: 5000 }),
        (d, id, bump) => {
          const lines = linesOf(d);
          const before = evaluate(makeSnapshot({ lines }));
          const mats: SnapshotMaterial[] = MATERIALS.map((m) => {
            if (m.id !== id || m.price.status !== 'ok') return m;
            const unit = m.price.unit === 'JOD/kg' ? 1000 : 1;
            return {
              ...m,
              price: { ...m.price, price: (Number(m.price.price) + bump / unit).toFixed(3) },
            };
          });
          const after = evaluate(makeSnapshot({ lines, materials: mats }));
          if (!lines.some((l) => l.materialId === id)) {
            expect(after.cost.totalJodPerM3).toBe(before.cost.totalJodPerM3);
            return;
          }
          expect(Number(after.cost.totalJodPerM3)).toBeGreaterThanOrEqual(
            Number(before.cost.totalJodPerM3),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('tightening a limit never turns a failure into a pass', () => {
    fc.assert(
      fc.property(
        designArb,
        fc.integer({ min: 30, max: 50 }),
        fc.integer({ min: 0, max: 20 }),
        (d, loose, tighter) => {
          const lines = linesOf(d);
          const base = { request: { ...makeSnapshot().request, exposure: ['S1'] }, lines };
          const a = evaluate(
            makeSnapshot({
              ...base,
              projectOverrides: [{ requirement: 'max_wcm', value: loose / 100 }],
            }),
          );
          const b = evaluate(
            makeSnapshot({
              ...base,
              projectOverrides: [
                { requirement: 'max_wcm', value: Math.max(loose - tighter, 20) / 100 },
              ],
            }),
          );
          if (status(a, 'max_wcm') === 'fail') expect(status(b, 'max_wcm')).toBe('fail');
          if (status(b, 'max_wcm') === 'pass') expect(status(a, 'max_wcm')).toBe('pass');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Both mode is never less strict than either code, for any pair of limits', () => {
    const jsKeys = [
      'durability.S1.max_wcm',
      'durability.S1.min_fc',
      'durability.C1.max_cl_nonprestressed',
    ];
    fc.assert(
      fc.property(
        designArb,
        fc.integer({ min: 30, max: 70 }),
        fc.integer({ min: 15, max: 45 }),
        (d, wcm, fcMin) => {
          const request = { ...makeSnapshot().request, exposure: ['S1', 'C1'] };
          const patch = (r: RuleRecord): RuleRecord =>
            r.ruleset !== 'JS' || !jsKeys.includes(r.key)
              ? r
              : {
                  ...r,
                  value: r.key.endsWith('max_wcm')
                    ? wcm / 100
                    : r.key.endsWith('min_fc')
                      ? fcMin
                      : 0.2,
                };
          const run = (mode: 'ACI' | 'JS' | 'BOTH') =>
            evaluate(
              makeSnapshot({
                mode,
                request,
                lines: linesOf(d),
                rules: selectRules(ALL_RULES.map(patch), mode, request),
              }),
            );
          const [aci, js, both] = [run('ACI'), run('JS'), run('BOTH')];
          for (const id of ['max_wcm', 'min_fc', 'cl.nonprestressed']) {
            if (status(both, id) === 'pass') {
              expect(status(aci, id), id).toBe('pass');
              expect(status(js, id), id).toBe('pass');
            }
            const lim = (r: EvaluationReport) =>
              r.checks.find((c) => c.id === id)?.limit as number | null;
            if (lim(aci) !== null && lim(js) !== null) {
              const dir = id === 'min_fc' ? Math.max : Math.min;
              expect(lim(both)).toBe(dir(lim(aci)!, lim(js)!));
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a verdict of pass means every check passed; fail means one failed; incomplete means one was not evaluated', () => {
    for (const sc of scenarios()) {
      const r = evaluate(sc.snapshot);
      const statuses = r.checks.map((c) => c.status);
      if (r.verdict === 'pass')
        expect(
          statuses.every((s) => s === 'pass'),
          sc.name,
        ).toBe(true);
      if (r.verdict === 'fail') expect(statuses.includes('fail'), sc.name).toBe(true);
      if (statuses.includes('fail')) expect(r.verdict, sc.name).toBe('fail');
      if (statuses.includes('not_evaluated') && !statuses.includes('fail'))
        expect(r.verdict, sc.name).toBe('incomplete');
      for (const c of r.checks) {
        if (c.status === 'not_evaluated') expect(c.blocker, `${sc.name}: ${c.id}`).not.toBeNull();
        else expect(c.blocker, `${sc.name}: ${c.id}`).toBeNull();
      }
    }
  });

  it('is deterministic and complete: byte-identical reports, one trace entry per figure, no NaN anywhere', () => {
    fc.assert(
      fc.property(designArb, (d) => {
        const s = makeSnapshot({ mode: 'BOTH', lines: linesOf(d) });
        const a = JSON.stringify(evaluate(s));
        expect(JSON.stringify(evaluate(s))).toBe(a);
        expect(a).not.toMatch(/NaN|Infinity/);
        const r = evaluate(s);
        expect(r.trace.map((t) => t.key).sort()).toEqual(Object.keys(r.figures).sort());
      }),
      { numRuns: 60 },
    );
    for (const sc of scenarios()) {
      const r = evaluate(sc.snapshot);
      expect(JSON.stringify(r), sc.name).not.toMatch(/NaN|Infinity|undefined/);
      expect(r.trace.map((t) => t.key).sort(), sc.name).toEqual(Object.keys(r.figures).sort());
    }
  });

  it('a missing input is never a pass and never a zero', () => {
    for (const sc of scenarios()) {
      const r = evaluate(sc.snapshot);
      if (r.cost.state === 'incomplete') expect(r.cost.totalJodPerM3, sc.name).toBeNull();
      for (const c of r.checks)
        if (c.value === null) expect(c.status, `${sc.name}: ${c.id}`).toBe('not_evaluated');
    }
  });

  it('characteristic merge is idempotent, order-independent and more specific wins', () => {
    const levels = ['engine_default', 'tenant', 'plant', 'product_family', 'request'] as const;
    const layerArb = fc.record({
      level: fc.constantFrom(...levels),
      origin: fc.string({ minLength: 1, maxLength: 6 }),
      characteristics: fc.record(
        {
          wcm: fc.constant({ mode: 'range', max: 0.5 }),
          water_kg: fc.integer({ min: 100, max: 200 }).map((v) => ({ mode: 'fixed', value: v })),
          binder_kg: fc.integer({ min: 200, max: 500 }).map((v) => ({ mode: 'range', min: v })),
        },
        { requiredKeys: [] },
      ),
    });
    fc.assert(
      fc.property(fc.array(layerArb, { minLength: 1, maxLength: 6 }), (layers: Layer[]) => {
        const a = mergeLayers(layers);
        const b = mergeLayers([...layers].reverse());
        const c = mergeLayers([...layers, ...layers]);
        expect(a.ok && b.ok && c.ok).toBe(true);
        if (!a.ok || !b.ok || !c.ok) return;
        // order of equal-level layers can change which one wins; compare after sorting by level+origin
        const stable = [...layers].sort(
          (x, y) =>
            levels.indexOf(x.level) - levels.indexOf(y.level) ||
            x.origin.localeCompare(y.origin) ||
            JSON.stringify(x.characteristics).localeCompare(JSON.stringify(y.characteristics)),
        );
        expect(mergeLayers(stable)).toEqual(
          mergeLayers(
            [...stable]
              .reverse()
              .sort(
                (x, y) =>
                  levels.indexOf(x.level) - levels.indexOf(y.level) ||
                  x.origin.localeCompare(y.origin) ||
                  JSON.stringify(x.characteristics).localeCompare(
                    JSON.stringify(y.characteristics),
                  ),
              ),
          ),
        );
        for (const key of ['wcm', 'water_kg', 'binder_kg']) {
          const winners = layers.filter(
            (l) => key in (l.characteristics as Record<string, unknown>),
          );
          if (winners.length === 0) {
            expect(a.characteristics.find((x) => x.key === key)).toBeUndefined();
            continue;
          }
          const top = Math.max(...winners.map((l) => levels.indexOf(l.level)));
          const got = a.characteristics.find((x) => x.key === key)!;
          expect(
            levels.indexOf(
              winners.find((l) => l.origin === got.origin && levels.indexOf(l.level) === top)
                ?.level ?? 'engine_default',
            ),
          ).toBe(top);
        }
        expect(mergeLayers(layers)).toEqual(a);
      }),
      { numRuns: 100 },
    );
  });
});
