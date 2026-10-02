# ADR 0007 — Design lifecycle as pure code; the validator as a second implementation

Status: accepted (2026-10-02, approved with the M2.1 plan defaults)

## Context

Two safety-contract rules need a mechanism, not a convention:

1. **Transitions are server-enforced and named** (`01-domain.md §14.1`): there is no path to `approved` without a trial except legacy attestation, and every move needs named evidence.
2. **No number is shown as verified unless an independent check agrees** (`§3.1`). A validator that reuses the evaluator's arithmetic would repeat the evaluator's mistakes and prove nothing.

## Decisions

### Lifecycle

- The full §14.1 graph is data in `packages/engine/src/lifecycle.ts` (`EDGES`), with the evidence each edge requires and the milestone that turns it on. `canTransition(from, to, evidence, activeMilestone)` returns the edge or a named refusal (`no_such_transition`, `not_yet_available`, `evidence_missing`, `unknown_state`); an unknown milestone never counts as reached.
- The server asks `canTransition` before it moves a design and stores the evidence in the append-only `design_transitions` row. In M2.1 the active edges are `draft → evaluated` (evidence: a stored evaluation whose validator passed), re-evaluation (`evaluated → evaluated`, no new transition row), legacy attestation (`draft`/`evaluated → approved`) and release (`approved → in_production`). Everything else is in the graph and tested, and refused with "available from M3.1 / M4.1 / M5.1".
- `evaluated` implies no approval. A design that fails compliance still becomes `evaluated` (failures are shown, not hidden); only a validator disagreement or missing minimum data (a specific gravity) keeps it `draft`.
- A legacy-attested design keeps its state when evaluated. If a hard check fails, `mix_designs.needs_revalidation` is raised (bookkeeping column, not an input); nothing is suspended automatically (that is §14.3, M5.1).

### Validator independence

| Option                                                              | For                                                     | Against                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| A. Validator re-runs the evaluator and compares                     | No duplicate code                                       | Same bug passes both: proves determinism, not truth    |
| B. Validator has its own arithmetic, shares only the rules resolver | Catches formula, rounding and unit mistakes in one side | Two implementations to keep aligned (tests align them) |
| C. Validator in another language / process                          | Strongest isolation                                     | Out of proportion for the current stage                |

**Option B.** `packages/validator`:

- recomputes every figure, check status, strength value, baseline, cost line and characteristic row from the stored **snapshot** with exact rationals (`Rat`, bigint) and exact decimals for money; the evaluator uses floating point and the shared decimal helpers for money. It has its own table interpolation and its own comparison code;
- shares only the **rules resolver** (the same merged limits must apply to both) and the **decimal helpers**; it reads the evaluation **types** and nothing else from the engine;
- compares each figure within 1 × 10⁻⁶ and each money figure exactly; any difference, a missing or extra figure/check/trace entry, a check that points at a trace entry that does not exist, a verdict it cannot reproduce, or a result presented as clean while unverified rules are in use is a **hard failure that overrides the evaluator**;
- is protected by: the ESLint rule `validator-isolation` (no optimizer), dependency-cruiser rules (`validator-must-not-reach-optimizer`, `validator-must-not-reach-evaluator`: only `evaluate/types.ts` is reachable), and a test that scans the validator's imports.

The evaluator's comparisons use unrounded values; reported figures are rounded to six decimals, so the two sides cannot disagree at a rounding boundary.

## Risks

Both implementations were written by the same team from the same specification: a misreading of the spec itself is not caught (the hand-computed fixtures and, later, real approved designs are the remaining defence). Every evaluation carries `RULE_UNVERIFIED` until a QC manager verifies the rules; the validator proves the arithmetic, not the rule values.

## Reversal path

The lifecycle graph and the validator interface (`validateEvaluation(snapshot, report)`) are small and replaceable; stored evaluations keep their snapshot, so any evaluation can be re-validated by a future validator.
