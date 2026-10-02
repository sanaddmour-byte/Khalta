// Specified strength → cylinder basis, and the required average strength f'cr (ACI 301 §4.2.3.3).
import { CODE_RULESETS, lookupTable, type Mode, type TableDefinition } from '@khalta/rules';
import type {
  EvalBlocker,
  DesignRequestInput,
  FcrBranch,
  StrengthBlock,
  StrengthRecordSummary,
} from './types';
import { isNum, type RuleIndex, type Tracer } from './util';

interface BasisRow {
  cylinder_mpa: number;
  cube_mpa: number;
  b_grade: string | null;
  b_grade_candidates?: string[];
}

export type Conversion = { ok: true; cylinderMpa: number } | { ok: false; blocker: EvalBlocker };

/** Converts the specified strength to the cylinder basis through `strength.basis_map` (never by formula). */
export function toCylinder(req: DesignRequestInput, rules: RuleIndex): Conversion {
  const fail = (detail: string, code: EvalBlocker['code'] = 'input_missing'): Conversion => ({
    ok: false,
    blocker: { code, detail },
  });
  if (req.fcMpa === null) return fail('specified strength is not stated');
  if (req.basis === null) return fail('strength basis (cylinder, cube or B-grade) is not stated');
  if (req.basis === 'cylinder') return { ok: true, cylinderMpa: req.fcMpa };
  const map = rules.value('SHARED', 'strength.basis_map');
  if (!Array.isArray(map)) return fail('strength.basis_map is not on file', 'rule_not_on_file');
  const rows = map as BasisRow[];
  if (req.basis === 'cube') {
    const hit = rows.find((r) => r.cube_mpa === req.fcMpa);
    return hit
      ? { ok: true, cylinderMpa: hit.cylinder_mpa }
      : fail(`cube strength ${req.fcMpa} MPa is not a class on the basis map`, 'out_of_domain');
  }
  const grade = `B${req.fcMpa}`;
  const hit = rows.find((r) => r.b_grade === grade);
  if (hit) return { ok: true, cylinderMpa: hit.cylinder_mpa };
  const ambiguous = rows.find((r) => r.b_grade_candidates?.includes(grade));
  return ambiguous
    ? fail(
        `${grade} is ambiguous on the basis map (candidates for ${ambiguous.cylinder_mpa} MPa)`,
        'rule_blocked',
      )
    : fail(`${grade} is not on the basis map`, 'out_of_domain');
}

const NO_DATA = [
  'fcr.no_data.lower_threshold_mpa',
  'fcr.threshold_mpa',
  'fcr.no_data.lt21.add',
  'fcr.no_data.mid.add',
  'fcr.no_data.gt35.factor',
  'fcr.no_data.gt35.add',
] as const;

/** One ruleset's f'cr, from its own parameters. Missing parameters are named, never defaulted. */
export function fcrFor(
  ruleset: string,
  fc: number,
  rules: RuleIndex,
  stats: StrengthRecordSummary | null,
  tr: Tracer,
): FcrBranch {
  const clause = rules.clause(ruleset, 'fcr.no_data.mid.add');
  const missing = (keys: readonly string[]) =>
    keys.filter((k) => rules.number(ruleset, k) === null);
  const n = (k: string) => rules.number(ruleset, k)!;

  // Statistical branch: needs a qualifying record (≥ min tests, f'c window) and every parameter.
  const minTests = rules.number(ruleset, 'fcr.statistical.min_tests');
  const window = rules.number(ruleset, 'fcr.statistical.fc_window_mpa');
  if (
    stats &&
    minTests !== null &&
    window !== null &&
    stats.n >= minTests &&
    Math.abs(stats.fcMpa - fc) <= window
  ) {
    const table = rules.value(ruleset, 'fcr.statistical.n_factor') as TableDefinition | null;
    const lookup = lookupTable(table, { col: stats.n });
    const le = fc <= (rules.number(ruleset, 'fcr.threshold_mpa') ?? Number.NaN);
    const keys = le
      ? ([
          'fcr.statistical.le35.k1',
          'fcr.statistical.le35.k2',
          'fcr.statistical.le35.offset',
        ] as const)
      : ([
          'fcr.statistical.gt35.k1',
          'fcr.statistical.gt35.k2',
          'fcr.statistical.gt35.factor',
        ] as const);
    const gaps = [...missing(keys), ...missing(['fcr.threshold_mpa'])];
    if (lookup.status === 'ok' && gaps.length === 0) {
      const s = stats.sdMpa * lookup.value;
      const k1 = n(keys[0]);
      const k2 = n(keys[1]);
      const third = n(keys[2]);
      const value = le
        ? Math.max(fc + k1 * s, fc + k2 * s - third)
        : Math.max(fc + k1 * s, third * fc + k2 * s);
      tr.add(
        `fcr.${ruleset}`,
        value,
        'MPa',
        le
          ? "f'cr = max(f'c + k1·s, f'c + k2·s − offset), s = SD × n-factor"
          : "f'cr = max(f'c + k1·s, factor·f'c + k2·s), s = SD × n-factor",
        { fc, sd: stats.sdMpa, tests: stats.n, nFactor: lookup.value, k1, k2, third },
        { ruleKey: keys[0], clause: rules.clause(ruleset, keys[0]) ?? undefined },
      );
      return {
        ruleset,
        value,
        branch: 'statistical',
        blocker: null,
        clause: rules.clause(ruleset, keys[0]),
      };
    }
    // fall through to the no-data branch (the statistical parameters are incomplete)
  }

  const gaps = missing(NO_DATA);
  if (gaps.length > 0)
    return {
      ruleset,
      value: null,
      branch: null,
      blocker: { code: 'rule_not_on_file', detail: `${ruleset}: ${gaps.join(', ')} not on file` },
      clause,
    };
  const lower = n('fcr.no_data.lower_threshold_mpa');
  const upper = n('fcr.threshold_mpa');
  let value: number;
  let formula: string;
  let inputs: Record<string, number>;
  let key: string;
  if (fc < lower) {
    key = 'fcr.no_data.lt21.add';
    value = fc + n(key);
    formula = "f'cr = f'c + add (f'c below the lower threshold)";
    inputs = { fc, add: n(key), lower };
  } else if (fc <= upper) {
    key = 'fcr.no_data.mid.add';
    value = fc + n(key);
    formula = "f'cr = f'c + add (lower threshold ≤ f'c ≤ upper threshold)";
    inputs = { fc, add: n(key), lower, upper };
  } else {
    key = 'fcr.no_data.gt35.add';
    value = n('fcr.no_data.gt35.factor') * fc + n(key);
    formula = "f'cr = factor·f'c + add (f'c above the upper threshold)";
    inputs = { fc, factor: n('fcr.no_data.gt35.factor'), add: n(key), upper };
  }
  tr.add(`fcr.${ruleset}`, value, 'MPa', formula, inputs, {
    ruleKey: key,
    ...(clause ? { clause } : {}),
  });
  return {
    ruleset,
    value,
    branch: 'no_data',
    blocker: null,
    clause,
  };
}

export interface StrengthInputs {
  request: DesignRequestInput;
  mode: Mode;
  safetyMarginMpa: number | null;
  /** From characteristics: fixed extra margin / fixed f'cr (MPa), already normalized. */
  extraMarginMpa: number | null;
  fixedFcrMpa: number | null;
  stats: StrengthRecordSummary | null;
}

export function computeStrength(i: StrengthInputs, rules: RuleIndex, tr: Tracer): StrengthBlock {
  const conv = toCylinder(i.request, rules);
  const base: StrengthBlock = {
    specifiedMpa: i.request.fcMpa,
    basis: i.request.basis,
    cylinderMpa: null,
    branches: [],
    safetyMarginMpa: i.safetyMarginMpa ?? 0,
    marginConfigured: i.safetyMarginMpa !== null,
    fcrMpa: null,
    governingRuleset: null,
    blocker: null,
  };
  if (!conv.ok) return { ...base, blocker: conv.blocker };
  const fc = conv.cylinderMpa;
  tr.add(
    'strength.fc_cylinder',
    fc,
    'MPa',
    i.request.basis === 'cylinder'
      ? 'specified on the cylinder basis (no conversion)'
      : 'strength.basis_map lookup',
    { specified: i.request.fcMpa, basis: i.request.basis },
    i.request.basis === 'cylinder' ? {} : { ruleKey: 'strength.basis_map' },
  );
  const codes = i.mode === 'BOTH' ? [...CODE_RULESETS] : [i.mode];
  const branches = codes.map((rs) => fcrFor(rs, fc, rules, i.stats, tr));
  const known = branches.filter((b): b is FcrBranch & { value: number } => isNum(b.value));
  if (known.length === 0)
    return {
      ...base,
      cylinderMpa: fc,
      branches,
      blocker: {
        code: 'rule_not_on_file',
        detail: branches
          .map((b) => b.blocker?.detail)
          .filter(Boolean)
          .join('; '),
      },
    };
  const gov = known.reduce((a, b) => (b.value > a.value ? b : a));
  const margin = i.safetyMarginMpa ?? 0;
  const extra = i.extraMarginMpa ?? 0;
  const code = gov.value + margin + extra;
  const fixedUsed = i.fixedFcrMpa !== null && i.fixedFcrMpa > code;
  const total = fixedUsed ? (i.fixedFcrMpa as number) : code;
  tr.add(
    'fcr.governing',
    gov.value,
    'MPa',
    "higher of the rulesets' f'cr governs",
    Object.fromEntries(known.map((b) => [b.ruleset, b.value])),
  );
  tr.add(
    'fcr.total',
    total,
    'MPa',
    fixedUsed
      ? "user-fixed f'cr (above the code value)"
      : "f'cr governing + safety margin + extra margin",
    { governing: gov.value, safetyMargin: margin, extraMargin: extra, fixed: i.fixedFcrMpa },
    fixedUsed ? { evidence: ['USER_OVERRIDE'] } : {},
  );
  return {
    ...base,
    cylinderMpa: fc,
    branches,
    fcrMpa: total,
    governingRuleset: gov.ruleset,
  };
}
