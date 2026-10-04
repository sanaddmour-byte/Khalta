# ADR 0022 — Batch preparation, equipment rounding and the v2 production export

Status: accepted (formulas await engineering confirmation; see `docs/calc/batch-moisture.md`)

## Context

Moisture correction existed (ADR 0012) but a batch had no size, no equipment resolution and no rounding. The v1 export carried no moisture age and no design hash, so a stale or superseded plan could reach the batcher.

## Decision

1. **Plan = conversion + rounding.** `planBatch` (engine) multiplies the moisture-corrected kg/m³ by a batch size and rounds each line half-up to the resolution of its category. Every line keeps design, corrected, exact, rounded and error values; totals are reconciled.
2. **No invented values.** Resolutions (`eng.batch.resolution_kg.<category>`), the largest permitted rounding deviation and the largest batch are `eng.batch.*` rules that ship **empty**. Saving a plan and exporting one are blocked, with each missing parameter named, until QC enters them.
3. **Independent check.** `validatePlan` (validator package, integer micro-kg arithmetic, no engine import) must agree with the plan before it can be stored.
4. **Binding.** A stored plan (`batch_instances`, append-only) records design id, version and version hash, plant, current test version of each material, moisture readings, calculation and validator versions, rounding parameters and preparer.
5. **Export `khalta.batch-weights.v2`** (v1 untouched) is all-or-nothing and re-checks at export time: design still approved/in production, version hash unchanged, no material test changed, every moisture reading inside the stale limit now, equipment parameters still on file, frozen project requirements still verified. Every refusal lists all reasons. The export is audited (`export.batch_plans`) and contains no cost.

## Consequences

- A plan cannot silently outlive its design, test or reading. The cost is that a plan must be prepared again after any change; this is intended.
- Rounding is nearest-resolution only; another approved convention would be a new versioned calculation.
- Outstanding: QC must confirm the formulas and enter the equipment parameters; the ERP column mapping (ADR 0016) is still proposed.
