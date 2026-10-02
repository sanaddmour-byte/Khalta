import {
  applicability,
  CODE_RULESETS,
  type Context,
  type Mode,
  type RuleRecord,
} from '@khalta/rules';
import type { DesignRequestInput } from './types';

/** F1–F3 exposure classes require air entrainment; this is how the rules' `air_entrained` condition is set. */
export const AIR_ENTRAINED_CLASSES = ['F1', 'F2', 'F3'];

/** The rules context for a request. `fcCylinderMpa` is null until the strength basis has been converted. */
export function evaluationContext(
  request: DesignRequestInput,
  fcCylinderMpa: number | null,
): Context {
  const ctx: Context = {
    exposure: request.exposure,
    air_entrained: request.exposure.some((e) => AIR_ENTRAINED_CLASSES.includes(e)),
  };
  if (request.s3Option !== null) ctx.s3_option = request.s3Option;
  if (request.slumpMm !== null) ctx.slump_mm = request.slumpMm;
  if (request.nmasMm !== null) ctx.nmas_mm = request.nmasMm;
  if (fcCylinderMpa !== null) ctx.fc_mpa = fcCylinderMpa;
  return ctx;
}

/**
 * The rules a snapshot must carry so the evaluation can be reproduced: the selected code rulesets, the ACI
 * design-aid tables (ACI 211.1 baselines are information in every mode), and the shared / engineering
 * parameters. Rules whose conditions already rule them out for this request are dropped.
 */
export function selectRules(
  all: readonly RuleRecord[],
  mode: Mode,
  request: DesignRequestInput,
): RuleRecord[] {
  const ctx = evaluationContext(request, null);
  const codes: readonly string[] = mode === 'BOTH' ? CODE_RULESETS : [mode];
  return all.filter((r) => {
    const wanted =
      codes.includes(r.ruleset) ||
      (r.ruleset === 'ACI' && r.requirement_class === 'DESIGN_AID') ||
      r.ruleset === 'SHARED' ||
      r.ruleset === 'ENGINEERING';
    return wanted && applicability(r, ctx).applies !== 'no';
  });
}
