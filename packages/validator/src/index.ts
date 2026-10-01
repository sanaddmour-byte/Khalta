// Independent validator. Must never import optimizer code (enforced by lint + depcruise).
import type { Trace } from '@khalta/engine';

export const VALIDATOR_API_VERSION = 1;

export type ValidatorTrace = Trace;
