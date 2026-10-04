# Khalta (خلطة) — full app summary, with UI and UX

_As of 2026-10-04. Everything below is built and tested (with SYNTHETIC data) unless marked otherwise; see `docs/readiness-matrix.md` for what has and has not been reviewed by a person._

## 1. What it is

A bilingual (Arabic / English, right-to-left aware) web app for a Jordanian ready-mix producer. It does two jobs:

1. **Evaluate** an existing concrete mix against codes (ACI 318 / ACI 211, the Jordanian Standard "JS", or both) and show cost, compliance and data quality.
2. **Design** a trial mix that meets the requirements at the lowest _delivered material cost_, then carry it through trial, approval, production and monitoring.

### The safety contract (it shapes every screen)

- **A solver's output is a candidate, never an approved mix.** Only a trial plus a QC sign-off approves a design.
- **An independent validator** re-checks every result with separate code. Nothing is shown as passing unless the validator agrees.
- **Evidence statuses, not confidence scores.** Every value says where it came from (tested, declared by a person, assumed, missing, model-predicted).
- **No silent assumptions.** Missing data is named as a blocker; the app never guesses a value to make a result look complete.
- **Code limits are not levers.** A user's own limits can tighten a code limit but never loosen it.
- **Humans approve.** Regulated actions (approve, attest, release, suspend) need a named person and a typed e-signature note. A design's author cannot approve it.

## 2. Who uses it and on what

| Role           | Context                                   | Main jobs                                                                                                        |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| QC Manager     | Head office, wide screen                  | Verify rules, approve designs, pass trials, review insights and savings                                          |
| QC Engineer    | Plant lab / site office, laptop or tablet | Evaluate and iterate designs, enter tests and trial results                                                      |
| Procurement    | Office                                    | Maintain the price matrix                                                                                        |
| Plant Manager  | Plant, tablet or phone                    | Own-plant designs, alerts, test entry, release/suspend                                                           |
| Sales Engineer | On the road, phone                        | Approved designs and PDFs (read-only)                                                                            |
| Admin          | Office                                    | Users, plants, settings, prices, imports; works the full design cycle but holds none of the sign-offs (ADR 0019) |

Desktop-first for the Design Studio and Price Matrix; usable on tablet; read-only on mobile for the library, design cards and PDFs.

## 3. Navigation and layout

- **Side navigation** (on the right in Arabic): Dashboard · Design Studio · Mix Library · Profiles · Insights · Savings · Materials · Prices · Plants · Rules · Imports · Settings. Each role sees only what it can use; hidden items are absent, not greyed out.
- **Top bar:** plant switcher (scopes prices, materials and designs everywhere) · command palette (Ctrl/Cmd+K) · language toggle · light/dark theme · notifications · user menu.
- **Critical banner:** the only thing that interrupts. Everything else lands in the Insights inbox.
- **First-run checklist:** plants → materials → tests → prices → rules verified → legacy designs attested → engineering parameters → first trial recommendation.

## 4. The screens

### Dashboard

**Built (phase 5).** A role-aware overview of counts and short worklists for your plants, each card a link to the screen behind it: QC managers see designs awaiting approval, designs needing revalidation, critical, unowned and overdue alerts and changes awaiting a decision; engineers see drafts and trials; procurement sees price alerts; plant managers see what is released and the alerts at their plant; sales and viewers see approved designs; administrators see users and failed background jobs (and no sign-off cards). No money figures appear here.

### Design Studio

Two entry paths, **Evaluate an existing mix** and **Generate a trial recommendation**, and four visible stages: **Requirements → Candidates → Inspect & Validate → Save / Request trial**.

- **Requirements:** plant; code mode (ACI / JS / both); target strength with its basis (cylinder, cube, B-grade); exposure classes (F, S, W, C) picked in plain language; slump; nominal maximum aggregate size; pumpable; objective (cheapest delivered cost etc.); **cement colour: any / white only / grey only** (new); a materials pool shown as chips grouped by category, where each cement carries its label (for example "OPC 42.5"); a characteristics panel (admixture, SCM, cement, air and similar choices that can only tighten limits); what-if materials that exist only inside the request; saved profiles. Re-solving is debounced and cancellable. If a required input is missing, the screen names it and disables Generate.
- **Candidates:** ranked cards with cost per m³ in large tabular numerals, difference to the best, binder, w/cm, a margin bar for each governing constraint, code badges, evidence chips and a "trial required" flag. Up to four can be pinned and compared. When nothing complies, a diagnostic panel names the binding hard rule (for example "max w/cm 0.45, JS S2, binding") and no saving is shown. A conflict names the exact value to release and re-runs on confirmation.
- **Inspect & Validate:** proportions, compliance (failures first, clause links to Rules), strength evidence, gradation, cost, traceability, validator report. What-if sliders are limited to prices, slump, safety margin and guardrails. "Compare plants" re-runs the request at other plants.
- **Save / Request trial:** save a draft; request a trial only after the validator passes, with a summary of evidence gaps.

### Mix Library

Dense table of designs with search and status filter, and tabs for **All designs · Portfolio · Data quality · Strength models · Needs revalidation · In trial · Awaiting approval**. Status chips for every lifecycle state (draft, trial candidate, in trial, trial passed, approved, in production, suspended, retired, legacy awaiting attestation). Import designs from Excel or CSV; export approved designs and batch weights as CSV for the batching system (no prices or costs in those files). A design detail view has a lifecycle stepper, transition history, version diff, trial log and strength chart, and the e-signature actions. Reports download as PDF.

### Materials

Per-category list (cement, SCM, fine and coarse aggregate, admixture, water, fibre, pigment) with name, category, plant, fineness modulus, tested date, source (lab / declared), freshness, and two readiness chips (can evaluate / can design). A material sheet shows test history, gradation chart and drift warnings. **Quick entry** has three tiers: needed to evaluate, needed to design, optional. Pasting a gradation from a spreadsheet computes the fineness modulus live. Declared values must carry a reason and are flagged everywhere they are used. Drafts are saved locally.

**New in M7.1 (cement classification):** type (OPC, PPC, SRC, low alkali, white) and strength class (32.5, 42.5, 52.5) as optional labels. Typing a market name suggests a label with an Apply button, never filled silently. The list shows the label, can be filtered by type, and marks cements with no label. If a label disagrees with the tested values (for example SRC with C₃A missing or above the limit, or a class whose 28-day mortar strength is below the minimum) a warning appears. Labels never decide a pass or fail.

### Prices

A spreadsheet-style matrix (materials × plants): inline edit, range paste from Excel, undo, keyboard navigation, stale cells flagged with their age, price history. Saving a change shows how many approved designs it affects and queues their re-evaluation.

### Plants, Rules, Imports, Settings

- **Plants:** the plants and their scope.
- **Rules:** every code rule grouped by ruleset and chapter, with value, class, clause, verification badge and "used by N designs". A QC Manager verifies rules; engineering parameters and JS values are entered here, and CSV import has a validation preview. Verified status is never assumed.
- **Imports:** legacy designs and JS rule values: upload, column mapping, fuzzy material matching (Arabic first), validation preview, commit, evaluation report, attestation queue.
- **Settings:** users, roles, tenant settings (for example whether sales may see cost), sanity ranges.

### Profiles, Insights, Savings

- **Profiles:** named, versioned sets of characteristic limits (QC Manager approves a version).
- **Insights:** an inbox of proactive findings (cheaper alternative after a price change, low strength, model invalidated). Accept creates a trial-only draft, dismiss needs a reason, snooze is available. Each shows a _theoretical_ saving.
- **Savings:** a ledger in three separate columns, **theoretical / approved / realized**, with period, volume and price basis. They are never added together.

## 5. Visual language

- **Tone:** an engineering instrument, calm and precise, not a marketing site.
- **Palette:** about 80% grey, 15% dark green (primary: buttons, active nav, links), 5% olive (secondary accent). Red and green are reserved for status; pass is always the brighter green with a ✓ and a word. Full light and dark themes via CSS variables; no hex values in components.
- **Type:** IBM Plex Sans (Latin), IBM Plex Sans Arabic, IBM Plex Mono for codes like `CEM II/A-P 42.5N`; tabular numerals in numeric cells; Arabic line height 1.7.
- **Density and motion:** compact tables by default; transitions of 150 ms or less; skeleton loaders rather than spinners.
- **Never colour alone:** every status is icon + text + colour.

## 6. UX principles (and where you see them)

1. **Explain every number.** Click a computed value to see formula, inputs, rule and clause, test record and price record.
2. **Evidence, not confidence.** Chips such as _tested_, _declared by user_, _assumed_, _missing_, _model-predicted_; never a percentage score.
3. **Money is shown honestly.** Cost and savings only to roles allowed to see them, always with state and price basis.
4. **Hard limits are not levers.** They appear as "binding" diagnostics, never as sliders.
5. **Proactive, not noisy.** Insights go to an inbox; only critical items interrupt.
6. **Plant context is global.** One persistent switcher.
7. **Undo over confirm** for edits; regulated actions need a typed e-signature.
8. **Keyboard-first.** Command palette (works in both languages), full grid keyboard navigation, visible focus rings.
9. **Empty states teach.** For example, an empty Mix Library says to import your existing designs from Excel or CSV.
10. **Role-aware.** Fields and screens a role cannot use are absent, not blurred.
11. **Accessible.** WCAG 2.2 AA is the target; every screen is checked with axe in the end-to-end suite.

### Arabic and right-to-left

Layout is mirrored with logical CSS properties, but charts, sieve axes, numbers and product codes are never mirrored. Mixed-direction tokens (units, codes, clause references) are isolated so they read correctly. Western digits by default. No hard-coded UI strings (enforced by lint); an Arabic string identical to English fails a test. All Arabic text is a **draft awaiting your review** (`docs/i18n-review.md`).

## 7. Behind the screens (short)

- **Engine:** the evaluator and the optimizer (HiGHS solver), the strength models (a regression of strength against w/cm, valid only with enough results, enough w/cm range and held-out checks, and only for approved, in-domain, same-group materials), and the cement label checks.
- **Independent validator:** separate package that may not import the evaluator; a boundary check enforces this.
- **Lifecycle:** draft → trial candidate → in trial → trial passed → approved → in production → suspended / retired; legacy imports wait for attestation. Every transition is audited with an e-signature where regulated.
- **Background jobs:** price-change re-evaluation and re-optimization, test-expiry and strength triggers, nightly sweep, nightly backup (01:30 Amman).
- **Exports:** PDF submittal and batch-weight sheets, CSV for batching systems (frozen versioned headers; every export is audited).
- **Production setup:** Express API serving the built web app on one origin, PostgreSQL, a worker, S3-compatible backups with a tested restore, a strict production guard and security headers.

## 8. Current state

- **Built:** milestones M0 to M7.1 and the October 2026 improvement programme (lifecycle policy, project requirements, batch preparation and the v2 export, optimizer transparency, strength and trial governance, change-impact workflows, role dashboards, alert ownership, savings attribution, cement type/class/colour). See `docs/audit/2026-10-gap-map.md` and `docs/readiness-matrix.md`.
- **Live on Railway** (`api-production-eee0.up.railway.app`): the API and web app are running; the worker was being fixed and redeployed at the time of writing.
- **Not done:** the live backup and restore drill and smoke test; the Vercel front end (needs re-authentication and an `/api` rewrite); real data. The app is empty until you add plants, materials with tests, prices and verified rules.
- **Needs your input:** the real engineering parameters, JS rule values, trial criteria, moisture limits, letterhead; the Arabic review; an on-call person; the ERP field mapping (ADR 0016 stays proposed).
- **Not proven by tests:** that real mill certificates match the cement labels people enter, and the restore time on managed PostgreSQL.
