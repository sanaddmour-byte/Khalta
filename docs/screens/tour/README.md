# Khalta app tour (English)

One screenshot per page and main state, taken at 1440 px with SYNTHETIC data. Numbers, names and prices are made up; the screens show how the app works, not real plant values.

## Sign in

![Sign in](01-sign-in.png)

Every user signs in with an email and password. There is no self-registration: an admin creates accounts.

## Dashboard

![Dashboard](02-dashboard.png)

The home screen. The sidebar lists only what your role may use; the top bar has the plant switcher, search/command palette, language, theme and your account.

## Design Studio: requirements

![Design Studio: requirements](03-studio-requirements.png)

Stage 1 of 4. Choose a plant and code (ACI, JS or both), the strength, slump and exposure, and what the optimizer may use. Candidates are trial proposals, never approved mixes.

## Design Studio: candidates

![Design Studio: candidates](04-studio-candidates.png)

Stage 2. Ranked trial candidates with cost per m³, the evidence behind each and what governs it. Pin two to compare.

## Design Studio: inspect and validate

![Design Studio: inspect and validate](05-studio-inspect.png)

Stage 3. Every figure with its trace, the combined grading, and the independent validator's verdict. From here you request a trial, which saves the design as TRIAL CANDIDATE.

## Mix Library

![Mix Library](06-library.png)

All designs with their lifecycle state (draft, evaluated, trial, approved, in production, suspended, retired). Tabs below filter by what needs attention. Admin-only actions are hidden for roles that cannot use them.

## A design: details

![A design: details](07-design-details.png)

The design sheet: proportions, the author and approval, lifecycle actions (suspend, release, retire), trial batches and strength results, batch weights (with the independent check), production volumes and the PDF submittal.

## A design: evaluation

![A design: evaluation](08-design-evaluation.png)

Compliance checks with clause references and evidence chips, the f′cr derivation, strength adequacy, cost per m³, data quality, and the validator result. Nothing here approves a design.

## Library: portfolio

![Library: portfolio](09-library-portfolio.png)

Every design at a glance: verdict counts, filters, evaluate all, and export of the portfolio (prices and costs, logged).

## Library: data quality

![Library: data quality](10-library-quality.png)

What is blocking or weakening designs: missing tests, stale prices, unverified rules, grouped by cause.

## Library: strength models

![Library: strength models](11-library-strength.png)

Plant strength models fitted from your own results: proposals with their evidence, approved by a QC manager with an e-signature. Also the proposals for s and β.

## Library: in trial

![Library: in trial](12-library-trial.png)

Designs at TRIAL CANDIDATE or TRIAL IN PROGRESS.

## Library: awaiting approval

![Library: awaiting approval](13-library-awaiting.png)

Designs whose trial passed. A different QC manager than the author approves them (four-eyes).

## Profiles

![Profiles](14-profiles.png)

Characteristic profiles: reusable sets of your own preferences (sand ratio, minimum binder, admixture choices, material preferences) that tighten, and never loosen, code limits. Versioned and approved by a QC manager.

## Insights

![Insights](15-insights.png)

The proactive inbox: cost opportunities (theoretical, trial-only), expired tests, stale prices, drift, rule changes and strength alerts. Accept creates a trial draft; snooze and dismiss need no code change. Critical alerts also show a banner at the top.

## Savings

![Savings](16-savings.png)

Cost baselines at a named price snapshot, then savings in three separate states: theoretical, approved and realized. They are never added together. Months that cannot be measured yet are listed with the reason.

## Materials

![Materials](17-materials.png)

Every material with its current test and price freshness. Tests are versioned; a new test never overwrites an old one.

## A material: tests and history

![A material: tests and history](18-material-sheet.png)

The latest test values with their source (lab report, supplier datasheet, or declared by a user), the grading chart and the version history.

## Prices

![Prices](19-prices.png)

The price matrix: materials by plant, edited like a spreadsheet and saved with a reason. Tools: bulk change, copy between plants, import, snapshots and export.

## Rules

![Rules](20-rules.png)

Every code value (ACI 318, ACI 211.1, JS) and engineering parameter, with its clause, class and verification state. Unverified rules make results provisional until a QC manager checks them against the licensed document.

## A rule

![A rule](21-rule-sheet.png)

One rule: value or table, applicability, source clause, version history and the verify action with a signed note.

## Imports

![Imports](22-imports.png)

Bring in legacy mix designs (a CSV or Excel file) or JS rule values. You map columns, confirm material matches (Arabic names first) and see a validation preview before anything is created. Imported designs are legacy and need attestation.

## Plants

![Plants](23-plants.png)

Create and edit plants (Arabic and English names, code). Users are assigned to plants; most roles only see their own.

## Settings: general

![Settings: general](24-settings.png)

Organisation settings: number format, whether sales may see cost, stale-price and near-limit thresholds, production and letterhead settings, insight thresholds.

## Settings: users

![Settings: users](25-settings-users.png)

Create users, set their role and plants, deactivate them. Every change is audited.
