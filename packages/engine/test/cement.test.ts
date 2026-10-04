import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CEMENT_CLASSES,
  CEMENT_KINDS,
  CEMENT_KINDS_CURRENT,
  cementGroupKind,
  cementLabel,
  cementLabelText,
  colourAllows,
  groupKey,
  groupOfParts,
  parseProperties,
  suggestCementLabel,
  type CementKind,
  type EvaluationSnapshot,
  type SnapshotMaterial,
} from '../src/index';
import { evaluate } from '../src/evaluate';
import { MATERIALS, makeSnapshot } from '../src/testing/synthetic';

const cementId = MATERIALS.find((m) => m.category === 'cement')!.id;
const withCement = (
  props: Record<string, unknown>,
  rules?: EvaluationSnapshot['rules'],
): EvaluationSnapshot => {
  const base = makeSnapshot(rules ? { rules } : {});
  return {
    ...base,
    materials: base.materials.map((m: SnapshotMaterial) =>
      m.id === cementId && m.test
        ? { ...m, test: { ...m.test, properties: { ...m.test.properties, ...props } } }
        : m,
    ),
  };
};
const labelItems = (s: EvaluationSnapshot) =>
  evaluate(s).dataQuality.filter((q) => q.code === 'cement_label_check');

describe('the two fields', () => {
  it('accept every kind and class, and refuse anything else', () => {
    for (const k of CEMENT_KINDS)
      for (const c of CEMENT_CLASSES)
        expect(parseProperties('cement', { cement_kind: k, cement_strength_class: c }).ok).toBe(
          true,
        );
    expect(parseProperties('cement', { cement_strength_class: 40 }).ok).toBe(false);
    expect(parseProperties('cement', { cement_kind: 'rapid' }).ok).toBe(false);
    expect(parseProperties('cement', { cement_type: 'CEM I 42.5N' }).ok).toBe(true); // old materials still valid
    expect(CEMENT_KINDS).toContain('white');
    expect([...CEMENT_CLASSES]).toEqual([32.5, 42.5, 52.5]);
  });
  it('read back as a label, with text', () => {
    // the legacy "white" type reads as a COLOUR with the type unstated, and is flagged for re-recording
    expect(cementLabel({ cement_kind: 'white', cement_strength_class: 52.5 })).toEqual({
      kind: null,
      strengthClass: 52.5,
      colour: 'white',
      legacyWhite: true,
    });
    expect(
      cementLabel({ cement_kind: 'opc', cement_colour: 'white', cement_strength_class: 52.5 }),
    ).toEqual({
      kind: 'opc',
      strengthClass: 52.5,
      colour: 'white',
      legacyWhite: false,
    });
    expect(cementLabel({ cement_kind: 'x', cement_strength_class: 40 })).toEqual({
      kind: null,
      strengthClass: null,
      colour: null,
      legacyWhite: false,
    });
    const L = (
      kind: CementKind | null,
      strengthClass: 32.5 | 42.5 | 52.5 | null,
      colour: 'white' | 'grey' | null = null,
    ) => ({
      kind,
      strengthClass,
      colour,
      legacyWhite: false,
    });
    expect(cementLabelText(L('opc', 42.5))).toBe('OPC 42.5');
    expect(cementLabelText(L('opc', 52.5, 'white'))).toBe('White OPC 52.5');
    expect(cementLabelText(L('low_alkali', null))).toBe('Low alkali');
    expect(cementLabelText(L(null, null))).toBeNull();
    expect(CEMENT_KINDS_CURRENT).not.toContain('white');
    expect(parseProperties('cement', { cement_colour: 'grey' }).ok).toBe(true);
    expect(parseProperties('cement', { cement_colour: 'pink' }).ok).toBe(false);
  });
});

describe('suggestions from a market name (never applied silently)', () => {
  const cases: [string, string | null, number | null][] = [
    ['OPC 42.5N', 'opc', 42.5],
    ['Ordinary Portland Cement 32.5', 'opc', 32.5],
    ['CEM I 52.5R', 'opc', 52.5],
    ['PPC 42.5', 'ppc', 42.5],
    ['Portland pozzolana cement', 'ppc', null],
    ['CEM II/B-P 32.5N', 'ppc', 32.5],
    ['SRC 32.5', 'src', 32.5],
    ['Sulfate resisting cement 42.5', 'src', 42.5],
    ['CEM I 42.5N-SR3', 'src', 42.5],
    ['Low alkali cement 42.5', 'low_alkali', 42.5],
    ['White cement 52.5', null, 52.5],
    ['White OPC 52.5', 'opc', 52.5],
    ['إسمنت أبيض 42.5', null, 42.5],
    ['إسمنت مقاوم للكبريتات', 'src', null],
    ['إسمنت بورتلاندي عادي 32.5', 'opc', 32.5],
    ['Some cement 40', null, null],
    ['batch 142.55', null, null],
  ];
  for (const [name, kind, cls] of cases)
    it(`${name} → ${kind ?? '–'} ${cls ?? '–'}`, () => {
      const got = suggestCementLabel(name);
      expect({ kind: got.kind, strengthClass: got.strengthClass }).toEqual({
        kind,
        strengthClass: cls,
      });
      // a colour is suggested as a colour, never as a type
      expect(got.colour).toBe(/white|أبيض/i.test(name) ? 'white' : null);
    });
});

describe('colour requests', () => {
  it('white only needs a cement recorded as white; grey only excludes white; any allows all', () => {
    for (const c of ['white', 'grey', null] as const) {
      expect(colourAllows('any', c)).toBe(true);
      expect(colourAllows('white', c)).toBe(c === 'white');
      expect(colourAllows('grey', c)).toBe(c !== 'white');
    }
    // a legacy "white" record still counts as white for a colour request
    expect(colourAllows('white', cementLabel({ cement_kind: 'white' }).colour)).toBe(true);
    expect(colourAllows('grey', cementLabel({ cement_kind: 'white' }).colour)).toBe(false);
  });
});

describe('the label defines the strength-model group, and only the group', () => {
  const parts = (props: Record<string, unknown>) => {
    const s = withCement(props);
    return groupOfParts(
      s.design.plantId,
      { basis: 'cylinder', testAgeDays: 28 },
      s.lines,
      s.materials,
    )!;
  };
  it('a different kind, class or certificate wording is a different group', () => {
    const a = groupKey(
      parts({ cement_kind: 'opc', cement_strength_class: 42.5, cement_type: 'CEM I 42.5N' }),
    );
    expect(
      groupKey(
        parts({ cement_kind: 'opc', cement_strength_class: 42.5, cement_type: 'CEM I 42.5N' }),
      ),
    ).toBe(a);
    expect(
      groupKey(
        parts({ cement_kind: 'white', cement_strength_class: 42.5, cement_type: 'CEM I 42.5N' }),
      ),
    ).not.toBe(a);
    expect(
      groupKey(
        parts({ cement_kind: 'opc', cement_strength_class: 52.5, cement_type: 'CEM I 42.5N' }),
      ),
    ).not.toBe(a);
    expect(
      groupKey(
        parts({ cement_kind: 'opc', cement_strength_class: 42.5, cement_type: 'CEM I 52.5N' }),
      ),
    ).not.toBe(a);
    // reclassifying the vocabulary never regroups a legacy record: its string is exactly what it was
    expect(cementGroupKind({ cement_kind: 'white', cement_strength_class: 42.5 })).toBe(
      'white|42.5',
    );
    // once the colour is recorded on its own it is part of the group
    expect(cementGroupKind({ cement_kind: 'opc', cement_colour: 'white' })).not.toBe(
      cementGroupKind({ cement_kind: 'opc', cement_colour: 'grey' }),
    );
    expect(cementGroupKind({})).toBeNull();
    expect(cementGroupKind({ cement_type: 'CEM I 42.5N' })).toBe('CEM I 42.5N');
  });
});

describe('label against certificate (warnings, both sides of every threshold)', () => {
  it('SRC: C3A missing, above the limit (5 %), at the limit', () => {
    expect(labelItems(withCement({ cement_kind: 'src', c3a_pct: undefined }))[0]?.detail).toMatch(
      /labelled SRC but C3A is not on file/,
    );
    expect(labelItems(withCement({ cement_kind: 'src', c3a_pct: 5.1 }))[0]?.detail).toMatch(
      /C3A 5.1 % is above the sulfate-resisting limit 5 %/,
    );
    expect(labelItems(withCement({ cement_kind: 'src', c3a_pct: 5 }))).toEqual([]);
    expect(labelItems(withCement({ cement_kind: 'src', c3a_pct: 2.9 }))).toEqual([]);
  });
  it('low alkali: the limit is QC’s to enter; named while empty, judged once entered', () => {
    const s0 = withCement({ cement_kind: 'low_alkali', alkali_na2o_eq_pct: 0.55 });
    expect(labelItems(s0)[0]?.detail).toMatch(/low-alkali limit is not on file/);
    const KEY = 'eng.cement.low_alkali.max_na2o_eq_pct';
    const withLimit = (v: number) => {
      const all = makeSnapshot({}).rules.filter((r) => r.key !== KEY);
      const rule = {
        id: 'x',
        ruleset: 'ENGINEERING',
        version: 1,
        key: KEY,
        requirement: KEY,
        kind: 'parameter',
        requirement_class: 'ENGINEERING_GUARDRAIL',
        value: v,
        applies_to: {},
        prerequisites: [],
        units: '%',
        clause_ref: 'QC',
        verified: false,
      } as never;
      return withCement({ cement_kind: 'low_alkali', alkali_na2o_eq_pct: 0.55 }, [...all, rule]);
    };
    expect(labelItems(withLimit(0.6))).toEqual([]);
    expect(labelItems(withLimit(0.5))[0]?.detail).toMatch(/alkali 0.55 % is above the limit 0.5 %/);
    expect(labelItems(withCement({ cement_kind: 'low_alkali' }))[0]?.detail).toMatch(
      /alkali content is not on file/,
    );
  });
  it('PPC without pozzolan content; with it, nothing', () => {
    expect(labelItems(withCement({ cement_kind: 'ppc' }))[0]?.detail).toMatch(
      /labelled PPC but its pozzolan content is not on file/,
    );
    expect(labelItems(withCement({ cement_kind: 'ppc', pozzolan_pct: 18 }))).toEqual([]);
  });
  it('class against the 28-day mortar strength: below the minimum warns, at it does not, none on file is silent', () => {
    expect(
      labelItems(withCement({ cement_strength_class: 42.5, mortar_strength_28d_mpa: 41.9 }))[0]
        ?.detail,
    ).toMatch(/labelled class 42.5 .* 41.9 MPa is below the class minimum 42.5 MPa/);
    expect(
      labelItems(withCement({ cement_strength_class: 42.5, mortar_strength_28d_mpa: 42.5 })),
    ).toEqual([]);
    expect(
      labelItems(withCement({ cement_strength_class: 52.5, mortar_strength_28d_mpa: 51 }))[0]
        ?.detail,
    ).toMatch(/class 52.5/);
    expect(
      labelItems(withCement({ cement_strength_class: 32.5, mortar_strength_28d_mpa: 33 })),
    ).toEqual([]);
    expect(labelItems(withCement({ cement_strength_class: 52.5 }))).toEqual([]);
  });
  it('white cement is judged like any other: its class and numbers, not its colour', () => {
    expect(
      labelItems(
        withCement({
          cement_kind: 'white',
          cement_strength_class: 42.5,
          mortar_strength_28d_mpa: 40,
        }),
      ),
    ).toHaveLength(1);
    expect(
      labelItems(
        withCement({
          cement_kind: 'white',
          cement_strength_class: 42.5,
          mortar_strength_28d_mpa: 43,
        }),
      ),
    ).toEqual([]);
  });
  it('an unlabelled cement says nothing here', () => {
    expect(labelItems(withCement({}))).toEqual([]);
  });
});

describe('a label never changes a check', () => {
  it('every kind and class leaves the figures, checks, verdict and strength block exactly as without a label', () => {
    const plain = evaluate(withCement({}));
    fc.assert(
      fc.property(
        fc.constantFrom(...CEMENT_KINDS),
        fc.constantFrom(...CEMENT_CLASSES),
        (kind, cls) => {
          const r = evaluate(withCement({ cement_kind: kind, cement_strength_class: cls }));
          expect(r.checks).toEqual(plain.checks);
          expect(r.figures).toEqual(plain.figures);
          expect(r.verdict).toEqual(plain.verdict);
          expect(r.strengthAdequacy).toEqual(plain.strengthAdequacy);
          expect(r.cost).toEqual(plain.cost);
        },
      ),
    );
  });
  it('a mislabelled cement still passes or fails every check, including sulfate, on its numbers alone', () => {
    const exposure = { ...makeSnapshot().request, exposure: ['F0', 'S2', 'W0', 'C1'] };
    const run = (props: Record<string, unknown>) =>
      evaluate({ ...withCement(props), request: exposure });
    for (const c3a of [3, 5, 9]) {
      const plain = run({ c3a_pct: c3a });
      for (const kind of CEMENT_KINDS) {
        const r = run({ cement_kind: kind, c3a_pct: c3a });
        expect(r.checks).toEqual(plain.checks);
        expect(r.verdict).toBe(plain.verdict);
      }
    }
  });
});
