import { describe, expect, it } from 'vitest';
import { parseOrigin } from '../src/profiles/api';
import { draftOf } from '../src/profiles/ProfileDialog';
import { buildCharacteristics, describeSpec, mapOfResolved } from '../src/studio/characteristics';

const ID = '8b1f3c0e-2f0e-4a53-9a77-0d6a1c3a9b11';

describe('profile origins', () => {
  it('parses profile:<id>@<n> and leaves request alone', () => {
    expect(parseOrigin(`profile:${ID}@3`)).toEqual({ profileId: ID, version: 3 });
    expect(parseOrigin('request')).toBeNull();
    expect(parseOrigin('profile:nope@1')).toBeNull();
  });
});

describe('profile content in the form', () => {
  it('round-trips a stored version through the form state', () => {
    const characteristics = {
      wcm: { mode: 'range', min: 0.4, max: 0.45 },
      water_kg: { mode: 'fixed', value: 180 },
      scm: { mode: 'fixed', product: 'fa', pct: 20 },
      agg_share_pct: { 'm-1': { mode: 'fixed', value: 40 } },
    };
    const d = draftOf(
      { scope: 'product_family', plantId: null, nameAr: 'ع', nameEn: 'E', family: null },
      {
        appliesTo: { fcMin: 30 },
        characteristics,
        materials: { exclude: ['x'] },
        objective: 'cheapest',
        mode: 'ACI',
      },
    );
    expect(d.family).toBe('');
    expect(d.exclude).toEqual(['x']);
    expect(d.chars['agg_share_pct.m-1']?.mode).toBe('fixed');
    expect(buildCharacteristics(d.chars)).toEqual(characteristics);
  });

  it('describes specs and maps a resolved list to rows', () => {
    expect(describeSpec({ mode: 'range', min: 38, max: 42 })).toBe('38–42');
    expect(describeSpec({ mode: 'range', max: 0.45 })).toBe('≤ 0.45');
    expect(describeSpec({ mode: 'target', value: 380 })).toBe('→ 380');
    expect(describeSpec({ mode: 'fixed', value: 0.4 })).toBe('= 0.4');
    const m = mapOfResolved([{ id: 'wcm', key: 'wcm', spec: { mode: 'fixed', value: 0.4 } }]);
    expect(m['wcm']?.value).toBe('0.4');
  });
});
