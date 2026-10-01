import { toRecord, type RuleRecord, type RuleSeed } from '../src/schema';

export function mk(p: Partial<RuleSeed> & { key: string; ruleset: string }): RuleRecord {
  const { ruleset, ...rest } = p;
  const seed = {
    kind: 'limit_max',
    requirement_class: 'CODE_HARD',
    applies_to: {},
    prerequisites: [],
    units: 'ratio',
    clause_ref: `${ruleset} test clause`,
    verified: true,
    value: null,
    ...rest,
  } as RuleSeed;
  return toRecord(seed, ruleset);
}
