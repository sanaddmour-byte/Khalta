# ADR 0012 — Batch conversion conventions, the independent batch check, and the PDF pipeline

Status: accepted (2026-10-02, approved with the M4.2 plan defaults)

## Context

Production needs wet batch weights from an approved SSD design and the day's moisture; clients need a printable submittal. Both must not create a second source of truth: the approved design is immutable, a wrong conversion is a production error, and an unapproved design must never look approved.

## Decisions

1. **Conversion (`toBatchWeights`, pure).** Per `01-domain` §6: M_od = M_ssd/(1+abs); M_wet = M_od×(1+total); W_free = M_od×(total−abs); batch water = design water − ΣW_free (− solution water, opt-in). Absorption and total moisture are separate named terms; wet mass is never labelled SSD. The batch weighs what the SSD design weighs (less any counted solution water): the mass balance is a returned figure.
2. **Rejection, never defaulting.** Missing QC limits (`eng.moisture.max_total_pct`, `eng.moisture.stale_hours`), missing readings or absorption, negative or over-limit moisture, stale or future readings each produce a named blocker; the conversion returns blockers instead of numbers.
3. **Admixture solution water** = mass × (1 − solids %); subtracted only when the tenant opts in (`admixtureSolutionWater`, default off) because the convention differs per product; the result records which convention was used.
4. **Independent check (`validateBatch`).** Own arithmetic written differently (wet = SSD×(1+total)/(1+abs); free = wet − SSD), re-derives the operational limits, checks signs and the mass balance. It imports only the production _types_ (a dependency-cruiser rule forbids reaching the conversion). A batch instance is stored only with a passing check (CHECK constraint) — a disagreement means the weights are not offered.
5. **Batch instances** are append-only production corrections (`batch_instances`) and never design versions; allowed for approved / in-production designs, and labelled "trial" for trial candidates.
6. **Strength results** are rows (`strength_results`); the trial gate judges only the latest batch's specimens at the design's test age. The legacy `trial_batches.strength_mpa` column from M4.1 fixtures stays in the schema, unread (dropping it needs an interactive migration prompt; to remove in a later cleanup).
7. **PDF pipeline.** HTML built on the server from stored records, printed by Chromium (`playwright-core`), fonts embedded as base64 (IBM Plex Sans / Plex Sans Arabic). Bilingual = labels side by side. The data the template reads has no cost fields. The watermark is rendered from the design's state with no off switch (any state but approved / in production; "SUPERSEDED"/"RETIRED" for terminal states), and a visible banner repeats it in text. The export is a POST so it is audited. A QR code links to `/library?design=<id>`.
8. **Visual proof.** The Arabic, bilingual and English first pages are rasterised (`pdftoppm`) from a fixed fixture and compared with stored baselines (mean absolute difference < 1/255); extraction checks are used where poppler's ligature handling allows.

## Consequences

- No real tenant can convert until QC enters the two moisture limits; the UI shows which are missing.
- Chromium must be present where the API runs (the spec's Docker image); `PLAYWRIGHT_CHROMIUM_EXECUTABLE` points at it in tests.
- The letterhead logo is accepted by the API (PNG/JPEG data URL, ≤ 150 kB) but the Settings screen edits names and addresses only.
