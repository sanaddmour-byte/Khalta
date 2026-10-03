# ADR 0016 — ERP / batching-system integration over REST

Status: **proposed** (not approved; no code exists). It stays proposed until Sanad provides the field mapping and a pilot sign-off (`04-phases.md` M6.1; `01-domain.md` §1 item 3: integrate only after measured savings and QC governance are proven).

## Context

M6.1 delivers CSV files. A direct integration would remove the manual loading step but adds a network surface, an identity problem, and a way for a wrong value to reach production without a person.

## Open questions (needed before this can be accepted)

1. **Field mapping**: which batching system or ERP, which fields (design code, material codes, units, batch size), and which of ours are authoritative.
2. **Direction**: push from Khalta, pull by the ERP, or both. Any write path from an ERP into Khalta (produced volumes, actual weights) is a separate decision.
3. **Identity and authorisation**: a service credential per plant, scoped to read approved designs and batch weights only; rotation; audit.
4. **Idempotency and versioning**: how a plant knows it has the current approved version (`design_hash`), and what happens to a design that is suspended after it was loaded.
5. **Acknowledgements**: whether the batching system confirms loading, and what Khalta does with a refusal.
6. **Pilot**: which plant, which designs, who signs the pilot, and the rollback.

## Shape if accepted (not decided)

Read-only OpenAPI endpoints returning the same rows as the CSV contract (same versions, same exclusions, no cost), a per-plant credential, rate limits, and API contract tests mirroring the CSV contract tests. Nothing would be pushed without a QC manager's release.
