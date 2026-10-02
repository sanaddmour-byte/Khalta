# ADR 0009 — The optimizer: HiGHS behind an interface, ACI 211.1 as a baseline, every candidate re-proven

Status: accepted (2026-10-02, approved with the M3.1 plan defaults)

## Context

The optimizer is where a wrong number becomes a wrong mix. Three decisions shape M3.1: which solver and how it is called, how strength and water are handled while no plant model exists, and how a solver answer becomes something a person may trial. The safety contract applies: solver output is **not** an approved mix; an independent validator re-checks every candidate; no silent assumptions; humans approve.

## Options

**Solver**

| Option                                     | For                                                      | Against                                                         |
| ------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------- |
| A. HiGHS (`highs`, WASM, MIT) over LP text | Real LP solver with duals, no native build, runs in Node | Synchronous `solve()`; LP text round trip                       |
| B. A hand-written simplex                  | No dependency                                            | Our own numerical bugs in the one place they matter             |
| C. A heuristic search over proportions     | Simple                                                   | No optimality, no duals, no infeasibility proof for diagnostics |

**Strength and water without a plant model**

| Option                                                           | For                                            | Against                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| A. ACI 211.1 tables as an engineering baseline, labelled as such | Published, hand-checkable, no invented numbers | Not a plant prediction                                        |
| B. Fit a strength model now                                      | Tighter mixes                                  | There are no trial or strength data; any fit would be a guess |

## Decision

1. **HiGHS, behind a one-method `Solver` interface** (`solve(LpProblem) → LpSolution`). The engine's optimizer imports no solver; the HiGHS wrapper (`highsSolver.ts`) is injected, so tests can stub it and the engine stays pure. One LP per configuration (variables: binder B, added water W, one volume per aggregate), a fixed-point loop for the single non-linear term (the binder-dependent workability adjustment; stop at < 0.1 %, at most 5 iterations).
2. **The ACI 211.1 baseline is information, never a prediction.** The w/cm ceiling is the tighter of the ACI 211.1 w/c for f′cr and the durability maximum, minus the robustness margin (`eng.margin.wcm`). Water is the ACI 211.1 table value reduced by the admixture's dosage table. Every candidate carries `MODEL_BASELINE` and `TRIAL_REQUIRED`. A user who pins w/cm above the baseline gets `MODEL_PREDICTS_SHORTFALL` and needs a QC manager's authorization before the candidate can become a trial candidate; a user who fixes water below the model estimate gets `USER_OVERRIDE` (and "slump at risk" beyond a tenant threshold).
3. **A candidate is a proposal with five gates.** (a) The LP respects every resolved hard requirement and engineering guardrail. (b) Quantities are rounded to practical increments (§5 of the spec), the volume rebalanced, and **everything is evaluated again from scratch** by the evaluator. (c) The guardrails and every characteristic are re-measured on the rounded numbers. (d) The independent `validateCandidate` (own arithmetic, no optimizer import) must agree. (e) Only then is the candidate stored; a design is created from it only through the lifecycle edge `evaluated → trial_candidate`, whose evidence is the validator's pass. No path leads to `approved` without a trial.
4. **Nothing missing is invented.** If an engineering parameter, an ASTM C33 individual-grading limit or a code value the request depends on is not on file, the request is **blocked** and the missing items are named. Hard rows are never relaxed, in a candidate or in a diagnostic: conflicts are found by giving slack only to rows the user specified.
5. **Rounding is conservative and re-checked, not repaired.** Cement and SCM round up to 5 kg, water to 1 kg, admixture to 0.01, aggregates to 5 kg with the largest fine aggregate absorbing the volume residual. If a rounded mix fails anything, other roundings are tried (and up to three +5 kg cement top-ups); otherwise it is rejected with its reason.

## Consequences

- With the shipped seeds the optimizer **blocks** on every real request: the grading band, Shilstone WF bounds, fines cap, pumpable minimum and the ASTM C33 individual limits are empty (a QC manager must supply them), and the Jordanian values are not on file. Tests use a clearly labelled SYNTHETIC parameter set. This is the designed behaviour, not a defect.
- The ACI 211.1 w/c table stops at f′cr 40 MPa, so requests above about f′c 31 MPa are blocked ("no extrapolation") until the table or a plant model covers them; air-entrained (F1–F3) requests are blocked.
- A strong model of the plant does not exist yet: candidates are cheap-and-compliant **hypotheses**. Savings are still only claimed after trials (M4.x).
- HiGHS' `solve()` is synchronous; a request is bounded by a time budget (20 s) and cooperative yielding between configurations instead of a worker thread (a deviation from the plan; see `docs/progress.md`).

## Risks

A misreading of the spec would be repeated by the evaluator, the validator and the optimizer (same author). Mitigations: hand-worked golden example, the validator's own formulas, real approved designs as fixtures when available. The linear model ignores plant effects (water demand, strength) beyond published baselines; trials decide.

## Reversal path

The `Solver` interface isolates HiGHS; replacing it changes one file. Stored requests and candidates carry the solver name, optimizer version, snapshot and rule versions, so earlier results remain explainable.
