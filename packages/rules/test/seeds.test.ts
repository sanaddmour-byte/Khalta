import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSeeds } from '../src/loader';
import {
  REQUIREMENT_CLASSES,
  RULE_KINDS,
  ruleSchema,
  seedFileSchema,
  toRecord,
  UNITS,
} from '../src/schema';

const { rules, rulesets, errors } = loadSeeds();
const by = (rs: string) => rules.filter((r) => r.ruleset === rs);

describe('seed files', () => {
  it('load without a single error', () => expect(errors).toEqual([]));

  it('define the four rulesets with an edition each', () => {
    expect(rulesets.map((r) => r.code).sort()).toEqual(['ACI', 'ENGINEERING', 'JS', 'SHARED']);
    for (const rs of rulesets) expect(rs.edition.length).toBeGreaterThan(3);
  });

  it('have unique keys per ruleset and only known kinds, classes and units', () => {
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    for (const r of rules) {
      expect(RULE_KINDS, r.id).toContain(r.kind);
      expect(REQUIREMENT_CLASSES, r.id).toContain(r.requirement_class);
      expect(UNITS, r.id).toContain(r.units);
      expect(r.requirement_class, `${r.id}: seeds never use USER_SPECIFIED`).not.toBe(
        'USER_SPECIFIED',
      );
    }
  });

  it('are ALL unverified: tests never turn a transcription into a verified rule', () => {
    expect(rules.filter((r) => r.verified)).toEqual([]);
  });

  it('carry a clause reference and bilingual notes on every rule', () => {
    for (const r of rules) {
      expect(r.clause_ref.length, r.id).toBeGreaterThan(2);
      expect(r.note_en?.length, `${r.id} note_en`).toBeGreaterThan(5);
      expect(r.note_ar?.length, `${r.id} note_ar`).toBeGreaterThan(5);
      expect(/[؀-ۿ]/.test(r.note_ar!), `${r.id} note_ar should be Arabic`).toBe(true);
    }
  });

  it('keep ACI 211.1 design aids classified DESIGN_AID, and nothing else in that group', () => {
    for (const r of by('ACI'))
      expect(r.key.startsWith('prop.'), r.id).toBe(r.requirement_class === 'DESIGN_AID');
  });

  it('mark engineering parameters as guardrails and leave Sanad-set values null', () => {
    for (const r of by('ENGINEERING')) expect(r.requirement_class).toBe('ENGINEERING_GUARDRAIL');
    const nulls = by('ENGINEERING')
      .filter((r) => r.value === null)
      .map((r) => r.key);
    for (const k of [
      'eng.water.beta_fm',
      'eng.water.beta_75',
      'eng.fines.max_pct_75um',
      'eng.shilstone.wf.min',
      'eng.grading.target.band_pct',
    ])
      expect(nulls).toContain(k);
  });
});

describe('Jordanian skeleton', () => {
  const aciCode = by('ACI').filter((r) => !r.key.startsWith('prop.'));
  const js = by('JS').filter((r) => !r.key.startsWith('cement.'));

  it('has exactly the same rule keys as the ACI code rules (every key from 02-codes §2, none missing)', () => {
    expect(js.map((r) => r.key).sort()).toEqual(aciCode.map((r) => r.key).sort());
  });

  it('is null everywhere, points at "JSC-2022 §TBD", and mirrors kind, class, units and applicability', () => {
    const aci = new Map(aciCode.map((r) => [r.key, r]));
    for (const r of js) {
      expect(r.value, r.id).toBeNull();
      expect(r.definition ?? null, r.id).toBeNull();
      expect(r.clause_ref).toBe('JSC-2022 §TBD');
      const a = aci.get(r.key)!;
      expect([r.kind, r.requirement_class, r.units, r.requirement]).toEqual([
        a.kind,
        a.requirement_class,
        a.units,
        a.requirement,
      ]);
      expect(r.applies_to).toEqual(a.applies_to);
    }
  });

  it('pre-fills only the cement taxonomy (JS 30-1 / EN 197-1) and SR definitions', () => {
    const filled = by('JS')
      .filter((r) => r.value !== null)
      .map((r) => r.key)
      .sort();
    expect(filled).toEqual([
      'cement.sr_definitions.SR0.max_c3a_pct',
      'cement.sr_definitions.SR3.max_c3a_pct',
      'cement.sr_definitions.SR5.max_c3a_pct',
      'cement.taxonomy',
    ]);
  });
});

describe('schema rejects bad rules', () => {
  const good = {
    key: 'a.b',
    kind: 'limit_max',
    requirement_class: 'CODE_HARD',
    units: 'ratio',
    clause_ref: 'x',
    verified: false,
    value: 0.45,
  };
  const bad = (patch: Record<string, unknown>) => ruleSchema.safeParse({ ...good, ...patch });

  it('accepts the baseline', () => expect(bad({}).success).toBe(true));
  it.each([
    ['unknown kind', { kind: 'limit_maybe' }],
    ['unknown class', { requirement_class: 'NICE_TO_HAVE' }],
    ['USER_SPECIFIED in a seed', { requirement_class: 'USER_SPECIFIED' }],
    ['unknown unit', { units: 'psi' }],
    ['empty clause', { clause_ref: '' }],
    ['unknown field (typo)', { claus_ref: 'x' }],
    ['bad key', { key: 'bad key!' }],
    ['limit with a string', { value: 'high' }],
    ['prohibition with a number', { kind: 'prohibition', value: 1 }],
    ['allowed_set with numbers', { kind: 'allowed_set', value: [1, 2] }],
    ['range with min above max', { kind: 'range', value: { '19': { min: 5, max: 1 } } }],
    ['table with a value', { kind: 'table', value: 1 }],
    [
      'definition on a non-table',
      { definition: { cols: { name: 'x', values: [1] }, data: [[1]], interpolation: 'linear' } },
    ],
    ['inherits AND value', { inherits: 'ACI:a.b' }],
    ['malformed inherits', { value: undefined, inherits: 'aci.a.b' }],
  ])('%s', (_n, patch) => expect(bad(patch).success).toBe(false));

  it('accepts null ("not on file"), fractions and inheritance', () => {
    expect(bad({ value: null }).success).toBe(true);
    expect(bad({ value: '1/3', units: 'fraction' }).success).toBe(true);
    expect(bad({ value: undefined, inherits: 'ACI:a.b' }).success).toBe(true);
  });

  it('rejects malformed tables', () => {
    const t = (def: unknown) =>
      ruleSchema.safeParse({ ...good, kind: 'table', value: undefined, definition: def });
    const ok = { cols: { name: 'n', values: [1, 2] }, data: [[1, 2]], interpolation: 'linear' };
    expect(t(ok).success).toBe(true);
    expect(t({ ...ok, data: [[1]] }).success).toBe(false); // wrong width
    expect(
      t({
        ...ok,
        data: [
          [1, 2],
          [3, 4],
        ],
      }).success,
    ).toBe(false); // too many rows
    expect(t({ ...ok, cols: { name: 'n', values: [2, 1] } }).success).toBe(false); // not ascending
    expect(t({ ...ok, interpolation: 'cubic' }).success).toBe(false);
    expect(
      t({
        ...ok,
        rows: { name: 'r', values: [3, 1] },
        data: [
          [1, 2],
          [3, 4],
        ],
      }).success,
    ).toBe(false);
  });

  it('seed file envelope needs a ruleset code and an edition', () => {
    expect(seedFileSchema.safeParse({ ruleset: 'aci', edition: 'x', rules: [] }).success).toBe(
      false,
    );
    expect(seedFileSchema.safeParse({ ruleset: 'ACI', edition: '', rules: [] }).success).toBe(
      false,
    );
    expect(seedFileSchema.safeParse({ ruleset: 'ACI', edition: 'x', rules: [] }).success).toBe(
      true,
    );
  });
});

describe('loader', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'khalta-seeds-'));
  const file = (d: string, name: string, body: string) => writeFileSync(join(d, name), body);

  it('reports duplicate keys, bad YAML, schema errors and dangling inherits with file names', () => {
    const d = dir();
    file(
      d,
      'a.yaml',
      'ruleset: "ACI"\nedition: "x"\nrules:\n  - {key: "k", kind: "limit_max", requirement_class: "CODE_HARD", units: "ratio", clause_ref: "c", verified: false, value: 1}\n  - {key: "k", kind: "limit_max", requirement_class: "CODE_HARD", units: "ratio", clause_ref: "c", verified: false, value: 2}\n',
    );
    file(d, 'b.yaml', 'ruleset: [unclosed');
    file(
      d,
      'c.yaml',
      'ruleset: "JS"\nedition: "x"\nrules:\n  - {key: "j", kind: "nope", requirement_class: "CODE_HARD", units: "ratio", clause_ref: "c", verified: false}\n  - {key: "i", kind: "limit_max", requirement_class: "CODE_HARD", units: "ratio", clause_ref: "c", verified: false, inherits: "ACI:missing"}\n',
    );
    const r = loadSeeds(d);
    expect(r.errors.join('\n')).toMatch(/a\.yaml: duplicate rule ACI:k/);
    expect(r.errors.join('\n')).toMatch(/b\.yaml: not valid YAML/);
    expect(r.errors.join('\n')).toMatch(/c\.yaml: rules\.0\.kind/);
  });

  it('adds a third ruleset (EN 206) with seed files only', () => {
    const d = dir();
    file(
      d,
      'en206.yaml',
      'ruleset: "EN206"\nedition: "EN 206:2013+A2:2021"\nrules:\n  - {key: "durability.XA2.max_wcm", requirement: "max_wcm", kind: "limit_max", requirement_class: "CODE_HARD", units: "ratio", clause_ref: "EN 206 Table F.1", verified: false, value: 0.50, applies_to: {exposure: ["XA2"]}}\n',
    );
    const r = loadSeeds(d);
    expect(r.errors).toEqual([]);
    expect(r.rules[0]?.ruleset).toBe('EN206');
  });

  it('resolves `inherits` as a reference and detects dangling targets', () => {
    const d = dir();
    file(
      d,
      'x.yaml',
      'ruleset: "JS"\nedition: "x"\nrules:\n  - {key: "j", kind: "limit_max", requirement_class: "CODE_HARD", units: "ratio", clause_ref: "c", verified: false, inherits: "ACI:a"}\n',
    );
    expect(loadSeeds(d).errors.join()).toMatch(/inherits unknown rule ACI:a/);
    expect(
      toRecord(
        ruleSchema.parse({
          key: 'j',
          kind: 'limit_max',
          requirement_class: 'CODE_HARD',
          units: 'ratio',
          clause_ref: 'c',
          verified: false,
          inherits: 'ACI:a',
        }),
        'JS',
      ).inherits,
    ).toBe('ACI:a');
  });
});
