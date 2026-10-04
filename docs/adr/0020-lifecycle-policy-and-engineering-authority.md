# ADR 0020 — One transition policy, four outcomes, and engineering authority that administration cannot replace

Status: accepted (2026-10-04, from the improvement request of the same date)

## Context

Lifecycle rules were enforced correctly but spread across routes, the gate module and the engine graph; "pass" meant a validator result, a compliance verdict and a trial result in different places; an assumption could sit unnoticed in an approved design; a repeated or concurrent request relied on the state graph alone; and the administrator could change rule values (`import.run`) and safety-relevant tenant settings.

## Decisions

1. **One policy table** (`packages/engine/src/approval/policy.ts`). For every move: the outcome it records, the capability, the plant scope, separation of duties, the signature meaning, the graph evidence, named freshness conditions, and which evidence states may satisfy it (`mayRelyOn`), need a signed acceptance (`needsAcceptance`) or always block (`blocks`). `GET /api/designs/:id/gates` returns it with the gates, who may act and why not (`permitted.reasons`), the four outcomes and the evidence breakdown.
2. **Four outcomes, never conflated:** calculation checks passed · trial accepted · design approved · production released. "Pass" is no longer used for more than one of them.
3. **Evidence states:** tested, declared, assumed, missing, model-predicted. An assumption that _stands in for a missing input_ (water SG, an assumed test age, an ambiguous B-grade) needs a signed acceptance (`POST /api/designs/:id/accept-assumptions`) before approval. Modelling conventions the evaluator states (the published ACI 211.1 air value, the slump band) are listed but do not block: the trial's measured values supersede them.
4. **Repeat and concurrency protection.** Signed moves accept an `idempotencyKey` (a repeat returns the stored outcome and is audited as a replay) and an `expectedStatus` (a stale view is refused with `stale_state`). The row lock and the graph already made a second simultaneous approval fail; this is now tested. `design_transitions.at` defaults to `clock_timestamp()` so two moves in one transaction keep their order.
5. **Engineering authority.** New capabilities held only by the QC manager: `rules.edit` (rule values, JS value commit) and `config.engineering`. The admin keeps `rules.read`, `org.manage`, and a new `settings.edit` that opens the settings; per key, only the administrative keys (`ADMINISTRATIVE_SETTING_KEYS`: plant limit, sales cost visibility, number format, stale-price days, insight thresholds, letterhead) are changeable by the admin. Every other key (acceptance, validity limits, optimiser, margins, sanity ranges) needs `config.engineering`. A request touching both is refused whole. The audit row carries `_changed` and `_safetyRelevant`.
6. **Role changes.** Nobody changes their own role; granting or removing `qc_manager` / `qc_engineer` needs a recorded reason, which is audited with the before/after role. This reduces, but cannot eliminate, the fact that an administrator creates users: the engineering sign-offs remain attributable to a named QC person, and every role change is in the audit trail.
7. **A latent defect fixed on the way:** `PATCH /api/settings` used `.partial()`, which keeps schema defaults, so changing one key silently reset every other key to its default. The patch schema now names only the keys sent.

## Consequences

- Staging/demo data that fills rule values is written by the QC manager account, not the admin.
- The Settings screen for the admin shows only what the admin may change; a QC-manager settings screen is outstanding (the API supports it).
