# Feature manifest

**This file is Sanad's.** Claude Code builds only features with status `approved` for the active milestone, in priority order, and nothing else. It may add `proposed` features with a rationale but never builds them until Sanad approves. Features without written acceptance criteria get draft criteria in the milestone plan for approval before building.

**Statuses:** `proposed` → `approved` → `building` → `done` (or `rejected`).
**Priority:** Must · Should · Could.

## Format for a new feature

```markdown
### F-0XX — <Title>
- Status: proposed | approved | building | done | rejected
- Priority: Must | Should | Could
- Milestone: Mx.y
- User story: As a <role>, I want <capability>, so that <benefit>.
- Acceptance criteria:
  - Given <context>, when <action>, then <result>.
- Depends on: F-0..
- Spec refs: 01-domain §.., 07-characteristics §..
- Out of scope: ..
```

## Feature list (seeded from v4 + Addendum A1 — edit freely)

| ID | Feature | Priority | Milestone | Status |
|---|---|---|---|---|
| F-001 | Bilingual AR/EN with full RTL | Must | M0.3 | approved |
| F-002 | Roles, plant scoping, four-eyes approval, audit log | Must | M0.2 | approved |
| F-003 | Rules library (ACI/JS) with verification workflow and JS CSV import | Must | M0.4 | approved |
| F-004 | Both mode and PROJECT layer (tighten-only) | Must | M0.4 | approved |
| F-005 | Plants (up to 20, configurable) | Must | M1.1 | approved |
| F-006 | Materials library with Jordanian market names | Must | M1.1 | approved |
| F-007 | **Material characteristics entry** (lab / datasheet / declared, quick entry, paste gradation, ad-hoc materials) | Must | M1.1 | approved |
| F-008 | Price matrix per plant, supplier and date, with history and Excel import | Must | M1.2 | approved |
| F-009 | Legacy mix import with QC attestation | Must | M1.3 | approved |
| F-010 | Evaluate an existing mix (compliance, cost, data quality) | Must | M2.1 | approved |
| F-011 | Independent validator | Must | M2.1 | approved |
| F-012 | Bilingual compliance table with clause references | Must | M2.2 | approved |
| F-013 | Cost baseline and theoretical opportunities | Must | M2.2 | approved |
| F-014 | **Mix characteristics: Auto / Fixed / Range / Target** | Must | M3.1 | approved |
| F-015 | **Degrees-of-freedom meter and conflict diagnostics** | Must | M3.1 | approved |
| F-016 | **Objective modes: cheapest / closest to my targets** | Should | M3.1 | approved |
| F-017 | Optimizer: lowest delivered material cost per plant | Must | M3.1 | approved |
| F-018 | Four-stage Design Studio with Evaluate / Generate paths | Must | M3.2 | approved |
| F-019 | Candidate comparison (up to 4) | Should | M3.2 | approved |
| F-020 | Compare plants | Should | M3.2 | approved |
| F-021 | **Characteristic profiles** (tenant / plant / product family) | Must | M3.3 | approved |
| F-022 | Lifecycle and approval workflow with e-signature | Must | M4.1 | approved |
| F-023 | Trial batches and strength results | Must | M4.2 | approved |
| F-024 | Batch weights with moisture correction | Must | M4.2 | approved |
| F-025 | Bilingual PDF submittal with QR code | Must | M4.2 | approved |
| F-026 | Savings ledger (theoretical / approved / realized) | Must | M5.1 | approved |
| F-027 | Proactive insights inbox and daily digest | Should | M5.1 | approved |
| F-028 | Strength models and low-strength alerts | Should | M5.2 | approved |
| F-029 | CSV export for batch plants / ERP | Should | M6.1 | approved |
| F-030 | Dark mode | Could | M0.3 | approved |
| F-031 | Command palette | Could | M0.3 | approved |

## Detailed entries for the new features

### F-007 — Material characteristics entry

- Status: approved · Priority: Must · Milestone: M1.1
- User story: As a QC engineer, I want to type material characteristics directly or from a report, so that the builder can design with the materials I actually have.
- Acceptance criteria:
  - Given a new aggregate, when I paste a gradation row from Excel, then FM computes and non-monotonic values are rejected.
  - Given an aggregate with SG and absorption only, when I run Evaluate, then it runs; when I run Generate, then it lists "gradation" as a named blocker.
  - Given a value I typed myself, when it is used in a design, then the design shows `INPUT_USER_DECLARED`.
  - Given an ad-hoc material in a request, when I click Promote, then it becomes a library material with a `user_declared` test.
- Spec refs: 07 §2

### F-014 — Mix characteristics: Auto / Fixed / Range / Target

- Status: approved · Priority: Must · Milestone: M3.1
- User story: As a QC engineer, I want to fix, bound or target any mix characteristic, so that the builder respects how my plant makes concrete.
- Acceptance criteria:
  - Given sand ratio fixed at 44% (mass), when candidates generate, then every candidate's sand ratio is 44% within the rounding tolerance.
  - Given S2 exposure, when I enter w/cm 0.50, then the field rejects it showing "≤ 0.45 · ACI 318-19 T19.3.2.1", and the API rejects the same payload.
  - Given water fixed below the model estimate by more than the threshold, when candidates generate, then each shows "slump at risk" and `USER_OVERRIDE`.
  - Given a w/cm above the strength-model value for f'cr, then the candidate shows `MODEL_PREDICTS_SHORTFALL` and cannot become `trial_candidate` without QC authorization.
- Spec refs: 07 §1, §4

### F-015 — Degrees-of-freedom meter and conflict diagnostics

- Status: approved · Priority: Must · Milestone: M3.1
- User story: As a QC engineer, I want to see how much freedom I've left the optimizer and exactly which of my characteristics conflict, so that I can fix an impossible set quickly.
- Acceptance criteria:
  - Given cement, water and every aggregate fixed, then the meter shows "Fully specified — evaluate only".
  - Given an impossible set, when I generate, then the conflict panel lists only my conflicting characteristics with feasible values, and "Release" re-solves.
  - Given infeasibility caused by code limits alone, then the panel shows the binding rules as diagnostics with no saving attached.
- Spec refs: 07 §4.1–4.2

### F-016 — Objective modes

- Status: approved · Priority: Should · Milestone: M3.1
- User story: As a QC engineer, I want to choose between the cheapest design and the design closest to my targets, so that I control the trade-off.
- Acceptance criteria:
  - Given targets and "Closest to my targets", then the result has the minimum weighted deviation, and among equal-deviation designs the lowest cost.
  - Given a max cost, then no candidate exceeds it in either mode.
- Spec refs: 07 §4.3

### F-021 — Characteristic profiles

- Status: approved · Priority: Must · Milestone: M3.3
- User story: As a QC manager, I want saved characteristic profiles per plant and product family, so that every engineer starts from our approved way of making each product.
- Acceptance criteria:
  - Given a tenant, plant and product-family profile setting the same characteristic, when a request matches all three, then the product-family value applies and its origin is shown.
  - Given a profile edited to version 4, then designs built on version 3 keep their snapshot unchanged and an info insight lists them.
  - Given a draft profile, when I generate a trial recommendation from it, then the action is blocked until a QC manager approves the profile.
- Spec refs: 07 §3
