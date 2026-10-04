# ADR 0023 — Optimizer transparency, trial and strength-model governance, change-impact workflows

Status: accepted. The statistical defaults named below await QC review; none is an engineering value from a code.

## Optimizer transparency (engine 1.1.0)

- **Taxonomy.** Every result carries a `termination`: `optimal_within_search`, `feasible_unproven`, `timed_out`, `infeasible`, `invalid_input`, `solver_failure`, `no_valid_candidate`, `cancelled`. The wording never says "optimal" without "within the search": the method is one LP per discrete configuration (ADR 0009), so the first candidate is the _lowest cost found within the selected constraints_, not a proven global optimum.
- **Not infeasibility.** Running out of time or a solver error is never reported as infeasibility (it used to be: zero solved configurations became a conflict diagnosis). Those cases now return `no_valid_candidate` with a named termination and no conflict claim.
- **Per candidate**: LP cost before rounding, the rounding gap, fixed-point iterations and convergence (`design_candidates.solve`). Per result: configurations enumerated/solved/infeasible/errored/not attempted, constraint counts by owner, the validator's accept/reject counts, price basis and the strength model frozen into the request. Money figures (gap, price basis, `solve`) are withheld without `cost.view`.
- **Cancellation**: `optimize(…, { signal })` throws `OptimizeCancelled`; nothing is stored. The HTTP layer does not yet pass the request's abort signal; the UI discards stale responses as before.
- **Supersession.** Requests are immutable (a trigger enforces it), so "request B replaces A" is its own append-only row (`design_request_supersessions`). A superseded result stays readable but no design can be made from it (`409 request_superseded`). A late older result cannot overwrite a newer one: nothing is ever overwritten.
- **Sensitivity.** `priceSensitivity` re-prices the stored candidates for what-if price moves of one material at a time and gives exact break-even changes (costs are linear in a price). It never re-solves and never touches a constraint; the response says so.

## Strength-model governance (fit version 2)

- **Chronological validation.** Each result is predicted from results cast on earlier dates only, and its miss is judged against the scatter that earlier fit showed (a whole-data s would hide a step change, which a test demonstrates). It reuses the existing limits (`rmseFactor`, `missS`) in units of the then-known scatter. A model that cannot be validated forward in time (for example everything cast on one day) is `provisional` with reason `no_chronological`, so it cannot be approved.
- **Statistical default awaiting review:** `chronologicalMinTrain = 10` earlier results before a result is tested (never below 5).
- **Validation report** stored with every model: fit version, group and sources, training summary with a fingerprint of the exact points, limits used, domain, both checks, figures, reasons.
- **Source changes.** A source change should be recorded as a new material (a different group key). A supplier changed in place on a group material now invalidates an approved model (`source_changed`). Limit: results cast before an in-place change cannot be separated retroactively; the report says so.
- **Frozen into recommendations**: the plant model used is part of the request snapshot, so retiring it later does not alter a stored result.

## Trial criteria beyond the five

Slump retained after a stated time, stability (bleeding/segregation) and placement (pumping/finishing) are configurable rules that ship **empty** (`eng.trial.retention_min_slump_mm`, `…retention_minutes`, `…stability_required`, `…placement_required`). Unconfigured means not applied, except that a **pumpable** design with no placement criterion on file blocks the trial pass and names the rule. Nothing is defaulted.

## Change-impact workflows

`change_impacts` (one row per distinct change: trigger + subject + version token, unique) and `change_impact_items` (one per approved design touched). `assessChange` is idempotent (completed changes are skipped), records `pending/running/failed/completed` with attempts and the last error, and a retry reuses the same row. Classes: `no_action`, `review`, `revalidate`, `requalify`, `suspend_recommended`. Approved versions are never altered; a QC manager records a disposition (with a reason, once, fitted to the class; a suspension recommendation cannot be dismissed), enforced by a database guard too. Triggers: price change, material test change (drift, source), nightly test expiry, rule revision, a newly verified requirements revision, a strength result. The Insights page lists them.

## Outstanding

Review of the statistical defaults; HTTP abort wiring; the retroactive source-change limitation; real expiry and drift tolerances remain tenant settings.
