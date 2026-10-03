# ADR 0013 — Background workers, insight lifecycle, and the three savings states

Status: accepted (2026-10-03, approved with the M5.1 plan defaults)

## Context

Khalta should watch itself: a price, test, rule or strength-result change should say what it means for approved designs. That needs background jobs without Redis, noise control, and a savings ledger whose three kinds of figure (theoretical, approved, realized) are never mixed. Nothing may change a design by itself.

## Decisions

1. **pg-boss on the existing PostgreSQL** (schema `pgboss`). A separate `worker` entry in staging; in-process (`JOBS_IN_PROCESS=1`) in dev, tests and e2e. Handlers are idempotent and audited as `system` (`withAudit` with `actor: null`, a `job.run` record when a run writes nothing else).
2. **Debounce and dedupe.** Queues use policy `short` so only one queued job per `singletonKey` exists; price changes use a 15-minute `startAfter` and one job per plant per burst. Insights have one open row per dedupe key; a repeat refreshes the row (severity can rise, never fall by itself); a snooze ends on its date.
3. **Insights never act.** Dismiss needs a reason, snooze is 1 day or 1 week, and **accept** (QC manager) re-runs the optimizer _now_ and creates a trial-only draft (the next version, parent linked) at `trial_candidate`. If it no longer beats the live design at today's prices the insight expires with a named reason.
4. **Critical alerts** (strength below f′cr, compliance failure after a test) go to a shell banner and the inbox for QC managers; no email or push. A daily digest is stored and shown, not sent.
5. **Suspension and reinstatement are manual** (QC manager, reason, e-signature); no job suspends anything.
6. **Savings states** are separate ledger rows, never summed across states:
   - _theoretical_: baseline and the accepted draft both priced at one new snapshot taken at accept time, so market movement is never credited;
   - _approved_: at approval of a version that replaces a baselined design, both priced at an "Approval" snapshot;
   - _realized_: per month, from the replacement's approval month to the month before the current one: both costs at that month's snapshot × the produced volume of that month. The nightly job takes a "Month close" snapshot when none exists. A missing volume, snapshot or price blocks the month and is named; nothing is estimated.
     Realized and approved savings may be negative (a replacement can cost more).
7. **Production volumes** are append-only; a correction is a new row with a note and the latest row per month is in force.
8. **Arithmetic** uses decimal strings with signed-safe rounding wrappers (the shared helpers truncate toward zero).

## Consequences

Jobs can be re-run safely; the ledger is auditable end to end (the controlled pilot test reconciles baseline → approval → volume → realized to a hand calculation). Season-switch drafts and material-unavailable substitutes are deferred.
