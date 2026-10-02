import { describe, expect, it } from 'vitest';
import { evaluate, reasonOf } from '../src/evaluate';
import { scenarios } from '../src/testing/scenarios';

describe('structured reasons', () => {
  it('every explanation the evaluator writes across the scenario catalogue has a key', () => {
    const unknown = new Set<string>();
    for (const sc of scenarios()) {
      const r = evaluate(sc.snapshot);
      const all = [
        ...r.checks.flatMap((c) => [
          c.blocker,
          c.noteReason && { reason: c.noteReason, detail: c.note },
        ]),
        r.strength.blocker,
        r.strengthAdequacy.blocker,
        r.waterBaseline.blocker,
        ...r.strength.branches.map((b) => b.blocker),
        ...r.characteristics.rows.map((x) => x.blocker),
        ...r.dataQuality,
        ...r.cost.lines
          .filter((l) => l.detail)
          .map((l) => ({ reason: l.reason, detail: l.detail })),
      ].filter(Boolean) as { reason?: { key: string }; detail?: string }[];
      for (const x of all) {
        expect(x.reason, `${sc.name}: ${x.detail}`).toBeTruthy();
        if (x.reason!.key === 'other') unknown.add(x.detail ?? '');
      }
      r.assumptions.forEach((a, i) => {
        expect(r.assumptionReasons![i]!.key, a).not.toBe('other');
      });
    }
    expect([...unknown]).toEqual([]);
  });
  it('extracts parameters and keeps unknown text visible', () => {
    expect(reasonOf('C3A is not on file for CEM I')).toEqual({
      key: 'c3a_missing',
      params: { materials: 'CEM I' },
    });
    expect(reasonOf('price is 300 days old (limit exceeded)').params).toEqual({ days: '300' });
    expect(reasonOf('something new')).toEqual({ key: 'other', params: { text: 'something new' } });
  });
});
