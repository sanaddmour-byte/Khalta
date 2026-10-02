import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../src/i18n';
import { BlockedPanel, ConflictPanel, DofMeter } from '../src/studio/panels';
import { CharacteristicsPanel } from '../src/studio/CharacteristicsPanel';
import { referencedMaterials } from '../src/studio/ComparePlantsDialog';
import {
  buildCharacteristics,
  dofOf,
  emptyChar,
  release,
  specOf,
  type CharMap,
} from '../src/studio/characteristics';

const ch = (p: Partial<ReturnType<typeof emptyChar>>) => ({ ...emptyChar(), ...p });

describe('characteristics → Appendix E JSON', () => {
  it('auto and incomplete rows are not sent', () => {
    expect(specOf('wcm', ch({ mode: 'auto', value: '0.4' }))).toBeNull();
    expect(specOf('wcm', ch({ mode: 'fixed', value: '' }))).toBeNull();
    expect(specOf('wcm', ch({ mode: 'range' }))).toBeNull();
    expect(specOf('scm', ch({ mode: 'fixed', value: '10' }))).toBeNull();
  });

  it('builds fixed, range, target, scm, admixture and keyed rows', () => {
    const map: CharMap = {
      wcm: ch({ mode: 'fixed', value: '0.45' }),
      binder_kg: ch({ mode: 'range', max: '400' }),
      paste_l: ch({ mode: 'target', value: '300' }),
      scm: ch({ mode: 'range', product: 'fly', min: '10', max: '30' }),
      admixture: ch({ mode: 'fixed', product: 'sp', level: '2' }),
      'agg_kg.c20': ch({ mode: 'fixed', value: '700' }),
      'passing_pct.2.36': ch({ mode: 'range', min: '30' }),
      sand_ratio_pct: ch({ mode: 'range', min: '38', basis: 'volume' }),
      fm_combined: ch({ mode: 'auto' }),
    };
    expect(buildCharacteristics(map)).toEqual({
      wcm: { mode: 'fixed', value: 0.45 },
      binder_kg: { mode: 'range', max: 400 },
      paste_l: { mode: 'target', value: 300 },
      scm: { mode: 'range', product: 'fly', min: 10, max: 30 },
      admixture: { mode: 'fixed', product: 'sp', dosage_level: 2 },
      agg_kg: { c20: { mode: 'fixed', value: 700 } },
      passing_pct: { '2.36': { mode: 'range', min: 30 } },
      sand_ratio_pct: { mode: 'range', min: 38, basis: 'volume' },
    });
    expect(specOf('scm', ch({ mode: 'fixed', product: 'fly', value: '12' }))).toEqual({
      mode: 'fixed',
      product: 'fly',
      pct: 12,
    });
    expect(specOf('admixture', ch({ mode: 'fixed', product: '' }))).toBeNull();
  });

  it('counts degrees of freedom like the optimizer: quantities minus equalities', () => {
    expect(dofOf(4, {})).toMatchObject({ quantities: 6, equalities: 1, dof: 5, state: 'free' });
    const fixed = dofOf(2, {
      wcm: ch({ mode: 'fixed', value: '0.4' }),
      binder_kg: ch({ mode: 'fixed', value: '400' }),
    });
    expect(fixed).toMatchObject({ dof: 1, state: 'free' });
    const zero = dofOf(1, {
      wcm: ch({ mode: 'fixed', value: '0.4' }),
      'agg_kg.a': ch({ mode: 'fixed', value: '900' }),
    });
    expect(zero).toMatchObject({ dof: 0, state: 'fully_specified' });
    const over = dofOf(1, {
      wcm: ch({ mode: 'fixed', value: '0.4' }),
      binder_kg: ch({ mode: 'fixed', value: '400' }),
      water_kg: ch({ mode: 'fixed', value: '160' }),
    });
    expect(over).toMatchObject({ state: 'over_specified' });
    // ranges and targets are not equalities
    expect(dofOf(2, { wcm: ch({ mode: 'range', max: '0.4' }) }).dof).toBe(3);
  });

  it('release only sets a characteristic back to Auto', () => {
    const map: CharMap = {
      wcm: ch({ mode: 'fixed', value: '0.4' }),
      binder_kg: ch({ mode: 'fixed', value: '400' }),
    };
    const next = release(map, 'wcm');
    expect(next.wcm!.mode).toBe('auto');
    expect(next.binder_kg).toBe(map.binder_kg);
    expect(release(map, 'nope')).toBe(map);
  });
});

describe('compare plants: which materials need a mapping', () => {
  it('collects every material id the request pins', () => {
    const ids = referencedMaterials({
      materials: { include: ['a'], exclude: ['b'] },
      characteristics: {
        agg_kg: { c: {} },
        agg_share_pct: { d: {} },
        scm: { product: 'e' },
        admixture: { product: 'f' },
        wcm: {},
      },
    });
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(referencedMaterials({})).toEqual([]);
  });
});

describe('panels', () => {
  it('the DoF meter states the three cases in words', () => {
    const { rerender } = render(
      <DofMeter dof={{ dof: 3, state: 'free', quantities: 6, equalities: 3 }} />,
    );
    expect(screen.getByTestId('dof-meter')).toHaveTextContent('3 quantities left');
    rerender(<DofMeter dof={{ dof: 0, state: 'fully_specified', quantities: 6, equalities: 6 }} />);
    expect(screen.getByTestId('dof-meter')).toHaveTextContent('Fully specified');
    rerender(<DofMeter dof={{ dof: -2, state: 'over_specified', quantities: 6, equalities: 8 }} />);
    expect(screen.getByTestId('dof-meter')).toHaveTextContent('Over-specified by 2');
  });

  it('the conflict panel offers Release for user values only, never for hard rows', () => {
    const onRelease = vi.fn();
    const { unmount } = render(
      <ConflictPanel
        conflicts={{
          kind: 'user_specified',
          items: [{ id: 'wcm', klass: 'USER', relaxBy: 0.067, unit: 'ratio', detail: '' }],
        }}
        onRelease={onRelease}
        label={(id) => id}
      />,
    );
    fireEvent.click(screen.getByTestId('release-wcm'));
    expect(onRelease).toHaveBeenCalledWith('wcm');
    expect(screen.getByTestId('conflict-item')).toHaveTextContent('0.067');
    unmount();
    render(
      <ConflictPanel
        conflicts={{
          kind: 'hard_rows',
          items: [{ id: 'C:wcm_limit', klass: 'CODE', relaxBy: null, unit: 'ratio', detail: '' }],
        }}
        onRelease={onRelease}
        label={(id) => id}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('conflict-panel')).toHaveTextContent('no saving');
  });

  it('the blocked panel names every missing parameter', () => {
    render(
      <BlockedPanel
        blockers={[
          {
            code: 'parameter_missing',
            subject: 'eng.fines.max_pct_75um',
            detail: 'Fines cap is not on file',
          },
        ]}
      />,
    );
    expect(screen.getByTestId('blocker')).toHaveTextContent('eng.fines.max_pct_75um');
  });
});

describe('characteristics panel', () => {
  const pool = [
    {
      id: 'c20',
      category: 'coarse_agg',
      nameEn: 'C20',
      nameAr: null,
      usable: true,
      reason: null,
      hasTest: true,
      source: null,
    },
  ];
  it('shows the live limit beside the input and a rejected value inline with its clause', () => {
    render(
      <CharacteristicsPanel
        pool={pool}
        map={{ wcm: ch({ mode: 'fixed', value: '0.7' }) }}
        onChange={() => {}}
        bounds={[
          {
            requirement: 'max_wcm',
            value: 0.5,
            status: 'resolved',
            source: 'ACI',
            clause: 'ACI 318 Table 19.3.2.1',
            verified: false,
          },
        ]}
        rejected={[
          {
            key: 'wcm',
            code: 'override_loosens',
            message: '',
            proposed: 0.7,
            allowed: 0.5,
            rule: 'max_wcm',
            clause: 'ACI 318 Table 19.3.2.1',
            source: 'ACI',
          },
        ]}
        nameOf={(m) => m.nameEn}
      />,
    );
    expect(screen.getByTestId('char-bound-wcm')).toHaveTextContent('0.5');
    expect(screen.getByTestId('char-rejected-wcm')).toHaveTextContent('ACI 318 Table 19.3.2.1');
    expect(screen.getByTestId('char-rejected-wcm')).toHaveTextContent('0.7');
    // one row per aggregate for keyed characteristics
    expect(screen.getByTestId('char-row-agg_kg.c20')).toBeInTheDocument();
  });
});
