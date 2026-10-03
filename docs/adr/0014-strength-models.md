# ADR 0014 — Plant strength models: fitting, validity, approval and use

Status: accepted (2026-10-03, approved with the M5.2 plan defaults)

## Context

The ACI 211.1 w/c table is a published heuristic. A plant's own results can describe its materials better, but a fitted curve can mislead (mixed cements, narrow range, extrapolation, stale data). It must never loosen a code limit, never act before a person approves it, and never be shown as compliance.

## Decisions

1. **Model.** ln f = a − b·(w/cm) by ordinary least squares (doubles, figures rounded to six decimals; statistical figures, not money), per group: plant, cement material, SCM set, admixture set (with their types), specimen basis, test age. One point per **set** (the average of its specimens: an ACI "test"), with the w/cm of the design's stored evaluation. Results whose design has no evaluation, or lies outside the 12-month window, are listed as excluded with the reason; designs whose materials cannot be identified (not exactly one cement) are listed as unassigned, never guessed.
2. **Validity (01-domain §3).** `valid` needs ≥ 30 tests, ≥ 3 distinct w/cm levels, a w/cm span ≥ 0.10, a falling curve, and a held-out check (leave-one-out up to 200 points, five-fold beyond): held-out RMSE ≤ 1.5 × s and no miss beyond 3 s. Otherwise `provisional` with every failed condition named. `invalidated` is set only by the nightly check, when a material of the group is gone or its type changed, or no result is inside the window. All limits are tenant settings with these defaults.
3. **Every fit is a new row and a proposal.** An unchanged input set stores nothing new. Only a model a QC manager approved (reason, e-signature, DB check that an approved row has both) and that is `valid` and not retired is in force; one in force per group; approval must be of the newest fit of the group and replaces the old one.
4. **Use.** The evaluator (`strengthAdequacy`) and the optimizer take the model's w/cm for f′cr as the strength-governed w/cm only inside the model's own w/cm range and for its own test age and basis (evidence `MODEL_IN_DOMAIN` + `TRIAL_REQUIRED`); otherwise the ACI baseline governs and the report says why (`modelUse`). The durability ceiling still wins. Reports without a model are byte-identical to before. The independent validator recomputes the model w/cm and the comparison from the stored coefficients and checks the report's claim.
5. **Optimizer scope.** A model is attached only when exactly one in-force model has all its group materials in the request's pool; after the run, if any candidate is outside the model's group (it dropped or added an SCM or admixture), the whole run falls back to the baseline. Never a mix.
6. **Alerts (critical insights, QC decides).** The latest tests judged against the acceptance rule values stored per ruleset (running average of 3, single-test rule); a recovered sequence expires the alert. A sequence of N tests under the model's 1.64 s lower band. A missing or unverified rule value is named on the alert, never silent. Nothing suspends automatically.
7. **Proposals.** s refit (sample SD, n, the 30-test condition, flagged if above the model's s) and a β_FM / β_75 least-squares proposal (needs ≥ 12 batches with variation in FM and 75 µm, with standard errors) are read-only; the code never writes a rule value.
8. **Cement reduction** is not a new path: with an approved model the M5.1 opportunity trigger re-optimises; the nightly sweep nudges it when a live design's tests average ≥ 10 % above f′cr over ≥ 10 sets. Theoretical, trial-only on Accept.

## Consequences

A plant can replace a heuristic with its own evidence, deliberately and reversibly (retire at any time). The cost: a model helps the optimizer only when the request pins one group of materials.
