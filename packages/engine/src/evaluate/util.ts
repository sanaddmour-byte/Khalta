import { effectiveValue, type RuleRecord } from '@khalta/rules';
import type { EvidenceStatus, GoverningRef, SnapshotMaterial, TraceEntry } from './types';

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function propOf(m: SnapshotMaterial | undefined, field: string): unknown {
  const v = m?.test?.properties[field];
  return v === undefined || v === null || v === '' ? undefined : v;
}
export const numProp = (m: SnapshotMaterial | undefined, field: string): number | undefined => {
  const v = propOf(m, field);
  return isNum(v) ? v : undefined;
};

/** Specific gravity the volume calculation uses for a category (SSD for aggregates). */
export function sgField(category: SnapshotMaterial['category']): string {
  return category === 'fine_agg' || category === 'coarse_agg' ? 'sg_ssd' : 'sg';
}

/** Rules indexed for direct parameter access (`SHARED`, `ENGINEERING` and design-aid tables). */
export class RuleIndex {
  private readonly byRef: Map<string, RuleRecord>;
  /** Rule keys whose values this evaluation actually used, with their verified flag. */
  readonly used = new Map<string, boolean>();
  constructor(readonly rules: readonly RuleRecord[]) {
    this.byRef = new Map(rules.map((r) => [`${r.ruleset}:${r.key}`, r]));
  }
  get(ruleset: string, key: string): RuleRecord | undefined {
    return this.byRef.get(`${ruleset}:${key}`);
  }
  /** Value of a rule (following `inherits`), or null if the rule is absent or has no value on file. */
  value(ruleset: string, key: string, track = true): unknown | null {
    const r = this.get(ruleset, key);
    if (!r) return null;
    const v = effectiveValue(r, this.byRef);
    if (track && v !== null) this.used.set(`${ruleset}:${key}`, r.verified);
    return v;
  }
  number(ruleset: string, key: string): number | null {
    const v = this.value(ruleset, key);
    return isNum(v) ? v : null;
  }
  clause(ruleset: string, key: string): string | null {
    return this.get(ruleset, key)?.clause_ref ?? null;
  }
  governing(ruleset: string, key: string): GoverningRef | null {
    const r = this.get(ruleset, key);
    return r
      ? {
          source: ruleset,
          ruleKey: key,
          clause: r.clause_ref,
          requirementClass: r.requirement_class,
          verified: r.verified,
        }
      : null;
  }
}

export class Tracer {
  readonly entries: TraceEntry[] = [];
  readonly figures: Record<string, number | string | null> = {};
  /** Unrounded values: comparisons against limits use these, never the 6-place figures. */
  readonly raw: Record<string, number | string | null> = {};
  num(key: string): number | null {
    const v = this.raw[key];
    return typeof v === 'number' ? v : null;
  }
  add(
    key: string,
    value: number | string | null,
    unit: string,
    formula: string,
    inputs: Record<string, number | string | null>,
    opts: { ruleKey?: string; clause?: string; evidence?: EvidenceStatus[] } = {},
  ): number | string | null {
    const v = typeof value === 'number' ? round6(value) : value;
    this.figures[key] = v;
    this.raw[key] = value;
    this.entries.push({
      key,
      value: v,
      unit,
      formula,
      inputs,
      ...(opts.ruleKey ? { ruleKey: opts.ruleKey } : {}),
      ...(opts.clause ? { clause: opts.clause } : {}),
      evidence: opts.evidence ?? [],
    });
    return v;
  }
}
