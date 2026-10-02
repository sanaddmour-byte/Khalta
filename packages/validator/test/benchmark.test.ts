import { describe, expect, it } from 'vitest';
import { evaluate } from '@khalta/engine/evaluate';
import { LINES, makeSnapshot } from '@khalta/engine/testing';
import { validateEvaluation } from '../src';

describe('performance', () => {
  it('evaluates and validates 200 designs in a few seconds (the Library re-check of a large import)', () => {
    const designs = Array.from({ length: 200 }, (_, i) =>
      makeSnapshot({
        mode: 'BOTH',
        request: {
          ...makeSnapshot().request,
          exposure: [['F0'], ['S1'], ['S2'], ['C2'], ['F1']][i % 5]!,
          fcMpa: 20 + (i % 4) * 5,
        },
        lines: LINES.map((l) =>
          l.materialId === 'water' ? { ...l, kgPerM3: (150 + (i % 10) * 5).toFixed(3) } : l,
        ),
      }),
    );
    const t0 = performance.now();
    let failures = 0;
    for (const s of designs) if (validateEvaluation(s, evaluate(s)).status !== 'pass') failures++;
    const ms = performance.now() - t0;
    expect(failures).toBe(0);
    expect(ms).toBeLessThan(5000);
  });
});
