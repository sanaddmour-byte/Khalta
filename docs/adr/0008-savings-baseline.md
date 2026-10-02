# ADR 0008 — Savings baselines are fixed to a named price snapshot; opportunities stay theoretical

Status: accepted (2026-10-02, approved with the M2.2 plan defaults)

## Context

The first business proof is verified savings, not "the solver found a cheaper mix" (`01-domain.md §1.1`). Two things make a saving false: comparing at different prices (inflation credited to a change), and calling an estimate a result. M2.2 has no optimizer, trials or production volumes, so it can establish only a reference and estimates.

## Options

| Option                                                      | For                                             | Against                                                                |
| ----------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| A. Compare designs at live prices whenever shown            | Always current                                  | Price movement leaks into every "saving"; numbers change by themselves |
| B. Baseline = design cost at one stored snapshot, immutable | Reproducible; comparisons use the same snapshot | A baseline ages; a new one is a new record                             |
| C. Baseline stores only a number                            | Simple                                          | Not reproducible: no evaluation, snapshot or inputs behind it          |

## Decision

Option B. A `cost_baselines` row stores the design version, the **stored evaluation** it came from, the **price snapshot** id, plant, cost per m³ (exact decimal), and the volume stated in the import file (labelled an estimate; annual = × 12). It is append-only and never re-priced. Only an attested/approved design with a complete, validator-verified cost can have one; only QC managers create them (`baseline.create`).

A `savings_entries` row is a ledger entry whose state is the database-enforced constant `theoretical` (`CHECK (state = 'theoretical')`) and whose saving must be positive. It stores baseline, variant, the variant's stored evaluation and the **same snapshot** as the baseline, the per-m³ difference and the annual estimate, and whether the result is provisional. The variant is priced at the baseline's snapshot, never at live prices. A variant is eligible only if the independent validator passed, every check passed (none "not evaluated"), the cost is complete and it is cheaper at those prices. Approved and realized states, volume actuals and totals arrive with trials and production data (M4.x, M5.1); entries are never summed across states or baselines.

## Risks

Volumes in the file are averages, not production records; annual figures are estimates and say so. While rules are unverified every entry is provisional. A manual variant is a hypothesis: a trial and approval are still required.

## Reversal path

Ledger and baselines are derived from stored evaluations and snapshots and can be rebuilt; the state constraint is relaxed by a later migration when approved/realized states exist.
