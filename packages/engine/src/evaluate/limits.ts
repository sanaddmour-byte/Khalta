// The context the entry-time check needs (UI and API): the resolved requirements for a request and the
// code f'cr, computed without any user characteristics so they cannot loosen their own limits.
import { resolve } from '@khalta/rules';
import type { LimitContext } from '../characteristics/resolve';
import { evaluationContext } from './select';
import { computeStrength } from './strength';
import type { EvaluationSnapshot } from './types';
import { RuleIndex, Tracer } from './util';

export function limitContextFor(s: EvaluationSnapshot): LimitContext {
  const rules = new RuleIndex(s.rules);
  const strength = computeStrength(
    {
      request: s.request,
      mode: s.mode,
      safetyMarginMpa: s.settings.safetyMarginMpa,
      extraMarginMpa: null,
      fixedFcrMpa: null,
      stats: s.strengthRecords,
    },
    rules,
    new Tracer(),
  );
  const resolved = resolve(s.rules, {
    mode: s.mode,
    context: evaluationContext(s.request, strength.cylinderMpa),
    projectOverrides: s.projectOverrides,
    tablePolicy: s.tablePolicy,
  });
  return {
    resolved,
    materials: s.materials,
    codeFcrMpa: strength.fcrMpa,
    nmasMm: s.request.nmasMm,
  };
}
