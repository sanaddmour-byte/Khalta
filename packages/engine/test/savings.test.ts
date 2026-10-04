import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  annualised,
  dedupeParts,
  driftSeverity,
  monthEnd,
  monthsBetween,
  opportunityEligible,
  realizedForMonth,
  reevaluationSeverity,
  savingPerM3,
  totalSaving,
  totalsByState,
} from '../src';

const cost = fc.integer({ min: 1000, max: 400000 }).map((n) => (n / 1000).toFixed(3));

describe('savings arithmetic (exact decimals)', () => {
  it('hand-worked: 52.400 → 51.560 per m³ saves 0.840; × 1,250 m³ = 1,050.000', () => {
    expect(savingPerM3('52.400', '51.560')).toBe('0.840');
    expect(totalSaving('0.840', '1250')).toBe('1050.000');
    expect(annualised('0.840', '1250')).toBe('12600.000');
  });
  it('a replacement that costs more gives a negative saving, never hidden', () => {
    expect(savingPerM3('50.000', '50.250')).toBe('-0.250');
    expect(totalSaving('-0.250', '100')).toBe('-25.000');
  });
  it('realized for a month uses that month’s costs for BOTH designs', () => {
    // same price movement on both sides leaves the saving unchanged: market movement is not credited
    const a = realizedForMonth({
      baselineCostAtMonth: '52.400',
      replacementCostAtMonth: '51.560',
      producedM3: '800',
    });
    const b = realizedForMonth({
      baselineCostAtMonth: '55.400',
      replacementCostAtMonth: '54.560',
      producedM3: '800',
    });
    expect(a).toEqual({ perM3: '0.840', total: '672.000' });
    expect(b.perM3).toBe(a.perM3);
  });
  it('property: a uniform price shift on both costs never changes the per-m³ saving', () => {
    fc.assert(
      fc.property(cost, cost, fc.integer({ min: 0, max: 50000 }), (b, r, shift) => {
        const s = (shift / 1000).toFixed(3);
        const add = (x: string) => ((Math.round(Number(x) * 1000) + shift) / 1000).toFixed(3);
        void s;
        return savingPerM3(b, r) === savingPerM3(add(b), add(r));
      }),
    );
  });
  it('property: realized total = per m³ × volume, and is zero with zero volume', () => {
    fc.assert(
      fc.property(cost, cost, fc.integer({ min: 0, max: 100000 }), (b, r, v) => {
        const out = realizedForMonth({
          baselineCostAtMonth: b,
          replacementCostAtMonth: r,
          producedM3: String(v),
        });
        return v === 0
          ? Number(out.total) === 0
          : Math.abs(Number(out.total) - Number(out.perM3) * v) <
              0.001 + Math.abs(Number(out.perM3)) * 1e-9 * v;
      }),
    );
  });
  it('totals are kept by state and never combined', () => {
    const t = totalsByState([
      { state: 'theoretical', total: '100.000' },
      { state: 'theoretical', total: '50.500' },
      { state: 'approved', total: '10.000' },
      { state: 'realized', total: '-2.000' },
    ]);
    expect(t).toEqual({ theoretical: '150.500', approved: '10.000', realized: '-2.000' });
    expect(Object.keys(t)).not.toContain('total');
  });
});

describe('thresholds, periods, insight rules', () => {
  it('an opportunity needs ≥ 0.250 JOD/m³ or ≥ 1,000 JOD a year, and must save something', () => {
    const t = { minPerM3: 0.25, minAnnualJod: 1000 };
    expect(opportunityEligible('0.300', null, t)).toBe(true);
    expect(opportunityEligible('0.100', '1200.000', t)).toBe(true);
    expect(opportunityEligible('0.100', '900.000', t)).toBe(false);
    expect(opportunityEligible('0.100', null, t)).toBe(false);
    expect(opportunityEligible('-0.500', '99999', t)).toBe(false);
    expect(opportunityEligible('0.000', '99999', t)).toBe(false);
  });
  it('months', () => {
    expect(monthEnd('2026-02-01')).toBe('2026-02-28');
    expect(monthEnd('2028-02-01')).toBe('2028-02-29');
    expect(monthsBetween('2026-11-01', '2027-02-01')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
  });
  it('dedupe parts are stable and order-sensitive', () => {
    expect(dedupeParts('opportunity', ['d1', 'snap', null])).toBe(
      dedupeParts('opportunity', ['d1', 'snap', null]),
    );
    expect(dedupeParts('opportunity', ['a', 'b'])).not.toBe(dedupeParts('opportunity', ['b', 'a']));
    expect(dedupeParts('test_drift', ['a'])).not.toBe(dedupeParts('opportunity', ['a']));
  });
  it('an unset drift tolerance is never "within": it is a named review', () => {
    expect(driftSeverity([{ status: 'no_tolerance' }], false)).toBe('medium');
    expect(driftSeverity([{ status: 'within' }], false)).toBe('info');
    expect(driftSeverity([{ status: 'within' }, { status: 'beyond' }], false)).toBe('high');
    expect(driftSeverity([], true)).toBe('medium');
    expect(driftSeverity([], false)).toBeNull();
  });
  it('a newly failing check on a passing design is critical; yield drift over 2 % is high', () => {
    expect(reevaluationSeverity({ newFailures: 1, yieldDriftPct: null, wasPassing: true })).toBe(
      'critical',
    );
    expect(reevaluationSeverity({ newFailures: 1, yieldDriftPct: null, wasPassing: false })).toBe(
      'high',
    );
    expect(reevaluationSeverity({ newFailures: 0, yieldDriftPct: 2.5, wasPassing: true })).toBe(
      'high',
    );
    expect(
      reevaluationSeverity({ newFailures: 0, yieldDriftPct: 1.5, wasPassing: true }),
    ).toBeNull();
  });
});

describe('attribution: reversals, costs and reconciliation', () => {
  it('shows gross, costs and net; a reversal withdraws the gross but real costs stand', async () => {
    const { netSaving } = await import('../src');
    expect(netSaving('1000.000', [])).toEqual({
      gross: '1000.000',
      reversed: false,
      costs: '0.000',
      net: '1000.000',
    });
    expect(
      netSaving('1000.000', [
        { kind: 'trial_cost', amountJod: '120.500' },
        { kind: 'implementation_cost', amountJod: '79.500' },
      ]),
    ).toEqual({ gross: '1000.000', reversed: false, costs: '200.000', net: '800.000' });
    expect(
      netSaving('1000.000', [
        { kind: 'reversal', amountJod: '1000.000' },
        { kind: 'extra_cost', amountJod: '10.000' },
      ]),
    ).toEqual({
      gross: '1000.000',
      reversed: true,
      costs: '10.000',
      net: '-10.000',
    });
    // a negative gross (the replacement cost more) nets correctly
    expect(netSaving('-50.250', [{ kind: 'trial_cost', amountJod: '0.250' }]).net).toBe('-50.500');
    expect(() => netSaving('1.000', [{ kind: 'trial_cost', amountJod: '-5.000' }])).toThrow();
  });
  it('reconciliation never rounds up: only a ticket or import volume under verified rules is reconciled', async () => {
    const { reconciliationOf } = await import('../src');
    expect(reconciliationOf({ volumeSource: null, provisional: false })).toBe('no_volume');
    expect(reconciliationOf({ volumeSource: 'demo', provisional: false })).toBe('demo_volume');
    expect(reconciliationOf({ volumeSource: 'manual', provisional: false })).toBe('manual_volume');
    expect(reconciliationOf({ volumeSource: 'batch_tickets', provisional: true })).toBe(
      'provisional_rules',
    );
    expect(reconciliationOf({ volumeSource: 'import', provisional: false })).toBe('reconciled');
  });
});
