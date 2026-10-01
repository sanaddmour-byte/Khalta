// Stub of the seed schema (full rule schema is M0.4). Enumerations come from CLAUDE.md / Appendix A.
import { z } from 'zod';

export const RULE_KINDS = [
  'limit_max',
  'limit_min',
  'allowed_set',
  'prohibition',
  'range',
  'tolerance',
  'table',
  'value',
  'info',
  'parameter',
] as const;

export const REQUIREMENT_CLASSES = [
  'CODE_HARD',
  'PROJECT_HARD',
  'EMPIRICAL_CALIBRATED',
  'ENGINEERING_GUARDRAIL',
  'OPTIMIZATION_PREFERENCE',
  'DESIGN_AID',
] as const;

export const seedFileSchema = z.object({
  ruleset: z.string().min(1),
  edition: z.string().min(1),
  source_doc: z.string().optional(),
  rules: z.array(
    z.looseObject({
      key: z.string().min(1),
      kind: z.enum(RULE_KINDS),
      requirement_class: z.enum(REQUIREMENT_CLASSES),
      verified: z.boolean(),
    }),
  ),
});
