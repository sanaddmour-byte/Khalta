# Domain, engine and governance

> `07-characteristics.md` extends §2 (data model), §3 (pipeline), §4 (optimizer), §10 (RBAC) and §14.1 (gates). Where they conflict, `07` wins.

## 1. Product summary

A bilingual (Arabic/English, full RTL) web app that:

- Stores **materials** with lab properties under Jordanian market names (رمل، ناعمة، سمسمية، عدسية، فولية، حمصية).
- Stores **prices per material, plant and supplier with effective dates** — the same cement can have a different delivered price at each of up to 20 plants.
- **Evaluates existing mixes** for compliance, cost and data quality, and establishes a trustworthy baseline.
- Accepts requests by **performance requirements** (strength class, exposure, slump, NMAS, pumpable, placement, season) under **ACI, JS or Both** (strictest envelope).
- **Generates trial-only candidate designs** that minimize delivered material cost per m³ at the chosen plant, ranks them, and explains which constraint governs each.
- Stores every design as a **versioned item** (name + kg/m³ SSD + L/m³ + absolute volume + cost/m³) under a controlled lifecycle.
- Is **proactive**: watches prices, tests and strength results; proposes re-evaluation and economic opportunities without being asked.

### 1.1 Operating model and value proof

Khalta is built in three capability layers, in order:

1. **Mix Intelligence** — import and evaluate existing approved mixes; normalize materials, tests and prices; expose compliance, cost and data-quality gaps; establish the baseline.
2. **Controlled Optimization** — generate trial-only recommendations once the evaluator and reference cases are validated; every recommendation passes the independent validator and needs trial batching before approval.
3. **Continuous Optimization** — use price, test and strength changes to propose re-evaluation and re-optimization; integrate with ERP/batching only after measured savings and QC governance are proven.

The first business proof is **verified savings on production volume without degrading agreed quality, compliance or operational performance** — not "the solver found a cheaper mix". Three savings states are tracked separately and never summed (§14.2). Baselines snapshot material prices, design version, product, plant and period so that price inflation or product-mix changes are never credited to optimization.

**Primary KPIs:** production volume covered by evaluated designs; theoretical / approved / realized JOD/m³ savings; annualized realized savings; recommendation acceptance rate; trial success rate; designs requiring revalidation; rejection/nonconformance cost; volume exposed to stale or unverified inputs.

## 2. Data model (Drizzle)

Every business table carries `tenant_id` (single-tenant v1, multi-tenant ready), `created_at`, `created_by`, and soft-delete/supersede fields.

### 2.1 Organization

- `plants` — code (e.g. `AMM-01`), name_ar, name_en, city, region, is_active, ambient_profile (`hot` | `moderate`), haul_cost_jod_per_m3_km (optional). Max count is a tenant setting (default 20).
- `users`, `user_plants` (plant scoping), roles per §10.

### 2.2 Materials

- `material_categories` — `cement`, `scm` (fly ash, GGBS, silica fume, natural pozzolan, limestone filler), `fine_agg`, `coarse_agg`, `water`, `admixture`, `fiber`, `pigment`.
- `materials` — category, **market_name_ar**, **market_name_en**, technical_name, supplier_id, source (quarry/plant of origin), standard_ref, is_active.
- Jordanian aggregate labels are **labels only**; size ranges are indicative and always overridden by each material's sieve test.

| market_name_ar | market_name_en | Role | Indicative size |
|---|---|---|---|
| رمل (طبيعي/زجاجي) | Raml (natural/silica sand) | fine | 0–4.75 mm |
| ناعمة / رمل مكسر | Na'meh (crushed sand) | fine | 0–4.75 mm |
| سمسمية | Simsimiyyeh | coarse | ~4.75–9.5 mm |
| عدسية | Adasiyyeh | coarse | ~9.5–12.5 mm |
| فولية | Fooliyyeh | coarse | ~12.5–19 mm |
| حمصية | Hummusiyyeh | coarse | ~19–25 mm |

- `material_tests` — versioned lab data with `tested_at`, `lab`, `is_current`, `valid_until` (test-age policy per category):
  - **Aggregates:** full sieve analysis (configurable ASTM/BS-EN sieve set), SSD specific gravity, absorption %, fineness modulus (computed), dry-rodded unit weight, latest total moisture, % finer than 75 µm, chlorides, sulfates; optional LA abrasion, flakiness/elongation, shape/texture descriptors.
  - **Cement / SCM:** specific gravity, 28-day mortar strength, `c3a_pct`, `pozzolan_pct`, `limestone_pct`, alkali content; optional Blaine.
  - **Admixture:** ASTM C494 type, specific gravity, solids %, min/max dosage, a **dosage → water-reduction table with ≥ 3 points**, set-retardation effect, and the water-content convention for its solution (§6).
- `suppliers` — name_ar, name_en, contact.

### 2.3 Prices

- `material_prices` — material_id, plant_id, supplier_id, price (`numeric(12,3)`), unit (`JOD/ton` | `JOD/m3` | `JOD/kg` | `JOD/L`), includes_delivery, effective_from, effective_to (nullable), entered_by.
- One active price per (material, plant, supplier) at any time; history is never overwritten.
- The engine converts everything to **JOD per kg delivered to that plant**. No current price at a plant = unavailable there.
- `price_snapshots` — immutable, named snapshots of the full price set used by baselines and the savings ledger.

### 2.4 Rules

- `rulesets` — code (`ACI`, `JS`, extensible to `EN206`), edition, status, verified_by, verified_at.
- `rules` — ruleset_id, rule_key, **kind** (drives Both-mode merging, `02-codes.md` §3), **requirement_class**, applies_to (scope json), prerequisites, value_json, units, clause_ref, source_doc, valid_from/valid_to, note_ar, note_en, verified, verified_by, verified_at.
- `rule_tables` — 1D/2D lookup tables with an interpolation policy.
- Seeds live in `packages/rules/seeds/{aci,js,shared,engineering}/*.yaml` (Appendix A). A third ruleset (e.g. BS EN 206) must be addable with seed files only.

### 2.5 Requests, candidates, designs and evidence

- `design_requests` — plant_id, ruleset_mode (`ACI` | `JS` | `BOTH`), project_overrides (json), strength value + basis (`cylinder` | `cube` | B-grade), test_age_days (default 28), exposure classes, slump target, NMAS (fixed or engine-chosen), pumpable, placement, season, haul_time_min, element geometry (optional), `special` flags (stored only, §12), allowed_material_ids, safety_margin_mpa (default 0), status.
- `design_candidates` — request_id, rank, cost_per_m3, binder_kg, wcm, governing_constraints, diagnostics (binding rows), guardrail_shadow_prices, proportions, warnings, solver_meta.
- `recommendation_evidence` — candidate/design id, evidence statuses, model versions, applicability result, stale/missing inputs, validator version and result, trial requirement, generated_at. Descriptive evidence, never a numeric score.
- `mix_designs` — name, code (e.g. `AMM01-C30-S2-20-P-SU-v3`), request_id, plant_id, ruleset_mode, version, **status** (§14.1), **approval_source** (`khalta` | `legacy_attested`), external_approval_ref, approved_by, approved_at, cost_per_m3_at_approval, parent_design_id, **inputs_snapshot** (everything needed to reproduce the design exactly).
- `mix_design_lines` — material_id, kg_per_m3_ssd, litres_per_m3, abs_volume_m3, price_per_kg_snapshot, cost_per_m3.
- `design_transitions` — design_id, from_state, to_state, actor, evidence refs, reason, at (append-only).

Every design displays kg/m³ (SSD), L/m³ (water, admixtures), absolute volume, total = 1.000 m³ including air, fresh density, w/cm, binder, SCM %, combined gradation, cost/m³ and cost breakdown %.

### 2.6 Quality feedback and production

- `trial_batches` — mix_design_id, date, measured slump, air, temperature, fresh density, yield, water used to reach target slump, notes, **acceptance_result** against the trial criteria (§14.4).
- `strength_results` — mix_design_id or trial_batch_id, plant_id, cast_date, age_days, specimen_type, result_mpa, set_id.
- `strength_models` — per (plant, cement source, SCM family, admixture family, specimen basis): fitted curve, n, distinct w/cm levels, w/cm and age domain, standard deviation s, held-out diagnostics, status (`valid` | `provisional` | `invalidated`), fitted_at, approved_by.
- `batch_instances` — design_id/version, plant, timestamp, moisture inputs, full conversion trace, batch-validator result. Production corrections, **never** new design versions.

### 2.7 Proactive engine and savings

- `insights` — type, severity (`critical` | `high` | `info`), plant_id, related ids, message_ar, message_en, **theoretical_saving_jod_per_m3**, theoretical_annual_jod (labelled theoretical), ledger_entry_id (once accepted), dedupe_key, status (`new` | `accepted` | `dismissed` | `snoozed` | `expired`), created_at.
- `savings_ledger` — opportunity/design ids, baseline and proposed design versions, baseline and comparison price snapshots, normalization basis, theoretical / approved / realized values, eligible and actual volume, period, status, reason code, audit fields.
- `plant_volumes` — plant_id, mix_design_id, period, m3 (manual or imported).

### 2.8 Settings (tenant level)

Max plants, stale-price and test-age thresholds, robustness margins, insight thresholds, rounding steps, season dates, number format, `sales_can_view_cost` (default false), **minor-adjustment policy** (default: none — every proportion change needs a trial), moisture-input QC limits, target-penalty default weight, rounding tolerance per characteristic, water-override warning threshold (%), material sanity ranges (warn only), `approval_requires_lab_source` (default on).

## 3. Engine pipeline (deterministic kernel)

1. **Resolve requirements** from the selected ruleset(s) + PROJECT overrides with the Both-mode semantics (`02-codes.md` §3): max w/cm, min binder, min f'c, allowed cement properties, chloride limits, air, SCM limits, NMAS cap from geometry, grading envelope. Record governing source, clause and requirement class for each.
2. **Required average strength f'cr.** Convert cube/B-grade to cylinder via `strength.basis_map`. Use the statistical equations with the n-factor if a qualifying standard-deviation record exists (thresholds are seeds); otherwise the no-data table. In Both mode compute under each ruleset; the higher governs. Add `safety_margin_mpa`.
3. **w/cm for strength.** Use the plant strength model only if `valid`: ≥ 30 results at the test age, ≥ 3 distinct w/cm levels spanning ≥ 0.10, same plant, cement source, SCM and admixture family and specimen basis, within the last 12 months, and the target inside the model's w/cm domain. Fit ln(f) = a − b·(w/cm) by least squares; use held-out validation when data allow, otherwise mark `provisional`. Fallback: ACI 211.1 table, interpolated → evidence `MODEL_BASELINE` + `TRIAL_REQUIRED`. Final ceiling = min(strength w/cm, durability max w/cm) − robustness margin.
4. **Water demand.** Mode (a) baseline: ACI 211.1 table (slump × NMAS, interpolated) reduced by the admixture's water reduction at the evaluated dosage level → `MODEL_BASELINE`. Mode (b) plant-calibrated: adds blend, shape/texture, paste, admixture, temperature and haul terms when calibrated data exist. Never imply the baseline predicts plant water demand to production accuracy.
5. **Binder** = water ÷ w/cm, never below the governing minimum. Split into cement + SCM at the evaluated SCM fraction.
6. **Aggregate blend** — solved in the optimizer (§4) within the grading envelope, Shilstone bounds, fines cap and pumpability rows.
7. **Absolute volume**: cement + SCM + water + admixture + air + aggregates = 1.000 m³ exactly, using SSD specific gravities.
8. **Admixture dosage** — the evaluated discrete level; retarder level from season and haul time.
9. **Checks**: chlorides, alkali (if active), fresh density sanity range, yield 1.000 ± 0.005, every resolved constraint. Violation → hard fail; within the near-limit percentage → warning.
10. **Cost** = Σ (kg × JOD/kg delivered at plant) with breakdown and trace.

**Two workflows, one kernel.** `evaluate` takes given proportions and recomputes every applicable quantity and check (volume, w/cm, binder/SCM, grading, chlorides, cost) — supplying proportions never skips a check. Strength adequacy of an evaluated design is reported separately with its evidence status (`MODEL_IN_DOMAIN`, `MODEL_BASELINE` or "no model"), never as code compliance. `design` searches proportions and sends every result through the same evaluator and then the independent validator. Evaluate is built and validated first; it powers legacy imports, manual edits, baselines and re-checks.

### 3.1 Model governance and independent validation

Three separate layers:

1. **Compliance kernel** — deterministic code/project requirements and acceptance checks. Never optimizes, never depends on cost.
2. **Engineering models** — strength, water demand, workability, pumpability, admixture response, seasonal effects. Each has model_version, calibration_scope, valid_from/valid_to, input_domain, sample_count, diagnostics, approved_by.
3. **Economic optimizer** — searches the admissible domain and minimizes the configured cost objective. It consumes outputs and limits from layers 1–2 but cannot alter them.

`validateCandidate(snapshot)` lives in `packages/validator`, imports no optimizer code, and recomputes absolute volumes, w/cm, binder/SCM fractions, grading, chloride/alkali, availability, model applicability, guardrails and every resolved hard constraint. It runs after optimization, after rounding and (as `validateBatch`) after moisture conversion. A design reaches `trial_candidate` only when it passes. Validator failure always overrides solver status.

Strength models are invalidated or downgraded by any change of cement/SCM source, major admixture family, curing/test regime or specimen basis, or by operating outside the calibrated w/cm/age domain.

## 4. Optimizer

### 4.1 Enumeration of discrete choices

Each **configuration** fixes cement product, SCM product (or none), SCM fraction p (settings steps, up to the governing maximum), admixture product, dosage level (3–5 discrete levels from its table), and NMAS if not fixed. Skip configurations whose cement fails the cross-code property check (`02-codes.md` §5). Prune a configuration when its lower-bound cost already exceeds the current N-th best. Cap at 200 configurations per request; above that, search coarse-to-fine on p and dosage.

### 4.2 Mathematical program per configuration

**Objective** — minimize usable delivered **material** cost (JOD/m³) at the selected plant, subject to hard requirements and validated guardrails. Pumping, haul, rejection, production-time or carbon terms may be added only with reliable data and an ADR. Never call material-only cost "total concrete cost".

For each formulation, document why every decision-dependent term is linear. If an enabled relationship is nonlinear after transformation, do not force it into an LP — use enumeration, piecewise linearization or another solver through an ADR with regression fixtures.

Decision variables (all ≥ 0): **B** binder kg/m³; **W** free water kg/m³; **Vᵢ** SSD absolute volume of aggregate *i* (m³/m³), for each allowed aggregate priced at the plant. Derived: cement = (1 − p)·B; SCM = p·B; admixture = d·B; Mᵢ = 1000·SGᵢ·Vᵢ.

v1 objective:

`min  B·[(1 − p)·P_cement + p·P_SCM + d·P_admix] + W·P_water + Σᵢ 1000·SGᵢ·Vᵢ·Pᵢ`

| # | Constraint | Class | Linear form |
|---|---|---|---|
| C1 | Volume = 1 m³ | Physical identity (always enforced) | W/1000 + B·[(1−p)/(1000·SG_c) + p/(1000·SG_s) + d/(1000·SG_a)] + Σ Vᵢ = 1 − air |
| C2 | w/cm ceiling | CODE_HARD / EMPIRICAL_CALIBRATED | W − w\*·B ≤ 0, w\* = min(strength, durability) − margin |
| C3 | Minimum binder | CODE_HARD / PROJECT_HARD | B ≥ B_min |
| C4 | Water demand | EMPIRICAL_CALIBRATED or DESIGN_AID | W ≥ W₀·(1 − WR_d) + β_FM·(FM_ref − FM_comb) + β_75·(P75_comb − P75_ref) |
| C5 | Grading envelope, each sieve j (mass basis) | CODE_HARD or PROJECT_HARD | Σ SGᵢ·Vᵢ·(Pᵢⱼ − Lⱼ − m) ≥ 0 and Σ SGᵢ·Vᵢ·(Uⱼ − m − Pᵢⱼ) ≥ 0 |
| C6 | Shilstone coarseness factor | ENGINEERING_GUARDRAIL | Σ SGᵢ·Vᵢ·(R9.5ᵢ − CF_min/100·R2.36ᵢ) ≥ 0 (+ CF_max row) |
| C7 | Shilstone workability factor | ENGINEERING_GUARDRAIL | Σ SGᵢ·Vᵢ·(P2.36ᵢ − WF_min) + k_WF·(B − B_ref)·S_est ≥ 0 (+ WF_max row) |
| C8 | Fines cap, pumpability | ENGINEERING_GUARDRAIL | Σ SGᵢ·Vᵢ·(P0.075ᵢ − f_max) ≤ 0; pumpable adds min passing 0.3 mm |
| C9 | Availability, max share | OPTIMIZATION_PREFERENCE | Vᵢ = 0 if unpriced/inactive; optional max share per aggregate |

Implementation notes:

- **Grading rows are exact and linear** because they are homogeneous: multiplying "combined % passing ≥ L" by total aggregate mass removes the ratio. Envelopes are by mass, so weight by SGᵢ. Pᵢⱼ = % passing, R = cumulative % retained, m = margin inside the envelope.
- **Fixed-point loop** for the non-homogeneous terms (FM_comb, P75_comb in C4; S_est in C7): use the previous iteration's total aggregate mass, starting from the baseline estimate; stop when it changes < 0.1% (max 5 iterations). Non-converged configurations are dropped and logged.
- If β coefficients are null, drop those terms — and then C6–C8 **must** be set, or the optimizer refuses to run and names the missing parameters.
- After ≥ 5 trial batches per plant, fit β by regression of measured water-to-target-slump against blend properties; propose the update as an insight; apply only after QC approval (new model version).
- Air-entrained mixes (F1–F3) need the air-entrained water table and entrained-air targets in seeds; if null, the request is blocked with a clear message.

### 4.3 Outputs

- **Top N feasible candidates** (default 5), ranked by cost/m³, each with evidence statuses and `TRIAL_REQUIRED`.
- **Diagnostics for hard rows.** Elastic slacks may identify which `CODE_HARD`/`PROJECT_HARD` rows prevent feasibility or bind the cost. They are reported only as diagnostics — "No compliant candidate under current inputs; max w/cm (JS S2) is binding" — never with a saving attached and never as a recommendation.
- **Guardrail shadow prices** — HiGHS duals for `ENGINEERING_GUARDRAIL` and `OPTIMIZATION_PREFERENCE` rows only, as JOD/m³ per unit, labelled hypothetical and visible to QC roles.
- **Margins** on every governing constraint.

### 4.4 Baseline proportioning path

A deterministic ACI 211.1 absolute-volume path (no optimizer) produces the starting point for the fixed-point loop and the design-mode golden test. Its results carry `MODEL_BASELINE`.

## 5. Rounding and finalization

1. Round cement and SCM **up** to the nearest 5 kg; water to the nearest 1 kg; admixture to 0.01 L; aggregates to the nearest 5 kg.
2. Rebalance volume to 1.000 m³ by adjusting the largest fine aggregate.
3. Run the independent validator from scratch. If w/cm or minimum binder fails, add 5 kg cement and repeat (max 3 times). If rebalancing breaks grading or any guardrail, reject the candidate.
4. Recompute cost with rounded quantities. The stored design is always the rounded, validated one.

## 6. Production conversion

Designs are stored at SSD. Conversion distinguishes total moisture, absorption and free moisture, and never conflates wet batch mass with SSD design mass. For aggregate *i* (percentages as fractions):

- oven-dry mass M_od = M_ssd / (1 + absorption)
- wet batch mass M_wet = M_od × (1 + total_moisture)
- free-water contribution W_free = M_od × (total_moisture − absorption) — negative when drier than SSD
- batch water to add = design free water − Σ W_free, then subtract only explicitly modelled liquid contributions (e.g. admixture solution water per the product's convention)

`toBatchWeights(design, moisture[])` returns every intermediate term and a mass/water balance trace. Define and test the admixture solution-water convention before counting it in effective w/cm. Reject impossible or stale moisture inputs per the configured QC limits. `validateBatch` checks water balance and operational limits. The result is saved as a `batch_instance`; the approved SSD design stays immutable.

## 7. Tests

- **Evaluate fixtures (M2.1):** 3–5 approved plant designs; the evaluator must reproduce volumes, w/cm, binder, cost and compliance results exactly (volume 1.000 ± 0.002 m³).
- **Design golden tests (M3.1):** the ACI 211.1 worked example through the baseline path; cement ± 3 kg/m³, water ± 3 kg/m³, aggregates ± 10 kg/m³.
- **Property tests (fast-check):** volume sums to 1 m³; cost monotonic in every price; tightening w/cm never decreases binder; rounding never breaks a hard limit; Both mode never less strict than either code.
- **Validator tests:** deliberately corrupt solver output, rounding and traces; the validator detects every violation without reading solver flags.
- **Moisture tests:** dry-of-SSD, SSD and wet-of-SSD cases conserve solids and water; sign conventions explicit.
- **Model applicability tests:** source, material, regime or domain changes invalidate or downgrade models as specified.
- **Savings tests:** the three states never aggregate; price-only changes never appear as realized mix savings.
- **Solver tests:** infeasible requests return diagnostics, never an empty result, and never a hard-row relaxation with a saving.

## 8. Proactive engine (from M5.1)

All jobs run on **pg-boss** workers.

| Trigger | Action | Output | Effect on design state |
|---|---|---|---|
| Price change | Debounced re-optimization of `approved`/`in_production` designs at that plant | "Theoretical opportunity 0.840 JOD/m³ at current prices" → one-click trial-only draft | None (price-only) |
| New material test, within tolerance | Re-evaluate affected designs | Info | None |
| Material property drift or source change | Re-evaluate; flag yield drift > 2% or any failure | High/critical insight | May move to `suspended` pending QC (§14.3) |
| Test expired | Nudge | List of expired tests | Blocks new approvals using it |
| New strength results | Refit model, update s | Theoretical cement-reduction opportunity, or risk alert | None / review |
| Result below acceptance criteria | Immediate alert | Critical insight to QC manager | QC decides `suspended` |
| Rule or project change | Re-evaluate designs depending on it | Compliance impact list | May require revalidation |
| Season switch date | Draft seasonal variants | Trial-only drafts | New drafts only |
| Material unavailable at a plant | Find substitutes | Ranked trial-only alternatives | None |
| Stale prices | Nudge | Stale cells | None |
| Nightly 02:00 Asia/Amman | Full sweep | Digest | Per rows above |

**Noise and load control:** one debounced job per plant per price edit burst (singleton key, 15-minute delay); create an insight only if theoretical saving ≥ 0.250 JOD/m³ or theoretical annual ≥ 1,000 JOD (tenant settings); `dedupe_key` = hash(design, trigger, inputs) — an open match is updated, not duplicated; insights expire when inputs change; only critical items interrupt, everything else goes to the inbox and daily digest.

## 9. Approved libraries

**Default is reuse.** Custom code only for the domain core (evaluator, validator, rules resolver, optimizer formulation, proactive triggers, domain UI). Anything else needs an ADR (≤ 3 candidates; MIT/Apache/BSD/ISC; release < 12 months; adoption; TS types; RTL support; bundle size). Wrap third-party UI in `packages/ui`. Open-source ACI 211.1 or blending code may be used only to cross-check golden tests (credited in `docs/references.md`).

| Concern | Library | Notes |
|---|---|---|
| Monorepo | pnpm workspaces, Turborepo | |
| API | Express 5 | Parity with RMC ERP |
| Validation / contracts | zod, drizzle-zod, @asteasolutions/zod-to-openapi | One schema → DB, API, forms, OpenAPI |
| ORM / migrations | drizzle-orm, drizzle-kit | |
| Auth & roles | Better Auth (Drizzle adapter, admin/roles plugin) | Never hand-roll auth |
| Background jobs | pg-boss | From M5.1; no Redis |
| LP solver | highs (HiGHS WASM) | Fallback javascript-lp-solver only via ADR |
| Statistics | simple-statistics | Regression, std dev |
| Money | decimal.js | |
| YAML | yaml | |
| CSV / Excel | papaparse, exceljs | Avoid SheetJS (license change) |
| Logging | pino, pino-http | |
| Routing / URL state | TanStack Router (search params) | Studio state shareable via URL |
| Server state | TanStack Query | |
| Forms | react-hook-form + @hookform/resolvers/zod | |
| UI primitives | shadcn/ui on Radix + Tailwind CSS v4 | DirectionProvider; logical utilities only |
| Tables | TanStack Table + TanStack Virtual | |
| Spreadsheet grid | **ADR required:** AG Grid Community, Glide Data Grid, RevoGrid | RTL, range paste, keyboard nav, MIT, smooth at 20 × 200 |
| Charts | Apache ECharts (echarts-for-react) | Log-scale gradation, envelope bands, control charts |
| Palette / toasts / icons | cmdk, sonner, lucide-react | |
| i18n / dates | i18next, react-i18next, i18next-icu, date-fns (+ ar) | `Intl.NumberFormat('ar-JO-u-nu-latn')` |
| Fonts | @fontsource IBM Plex Sans Arabic, IBM Plex Sans, IBM Plex Mono | Self-hosted |
| PDF | Playwright `page.pdf()` from HTML | Correct Arabic shaping and bidi |
| Version diff | jsondiffpatch | |
| Testing | Vitest, fast-check, Playwright, MSW, @axe-core/playwright | |
| Lint / format | ESLint + typescript-eslint, Prettier | |

## 10. Roles and permissions (server-enforced; the UI omits what a role cannot see)

| Capability | Admin | QC Mgr | QC Eng | Procurement | Plant Mgr | Sales | Viewer |
|---|---|---|---|---|---|---|---|
| Users, plants, settings | ✓ | | | | | | |
| View supplier prices | ✓ | ✓ | ✓ | ✓ | own plants | | |
| Edit prices | ✓ | | | ✓ | | | |
| View cost/m³ | ✓ | ✓ | ✓ | ✓ | own plants | setting\* | |
| Create / edit drafts, run evaluate and design | ✓ | ✓ | ✓ | | | | |
| Request trial | ✓ | ✓ | ✓ | | | | |
| Enter tests, trial batches, strength results | ✓ | ✓ | ✓ | | ✓ | | |
| Mark trial passed | | ✓ | | | | | |
| Approve designs, verify rules | | ✓ (not own design) | | | | | |
| Attest legacy designs | | ✓ | | | | | |
| Release to / suspend in production | | ✓ | | | own plants | | |
| Accept insights | | ✓ | creates trial-only draft | | | | |
| Read approved library and PDFs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Import legacy designs / JS rule values | ✓ | ✓ | | | | | |
| Export prices or costs (logged) | ✓ | ✓ | | ✓ | | | |

\* `sales_can_view_cost`, default off. **Four-eyes rule:** a design's author cannot approve it. Users are scoped to assigned plants except Admin and QC Manager.

## 11. Deployment and operations

- **Railway**: `staging` (auto-deploy from main) and `production` (manual promote).
- Services: `api` (Docker image with Playwright Chromium for PDFs), `worker` (from M5.1, same image), `web` (static), managed PostgreSQL.
- Env vars: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_BASE_URL`, `PDF_BASE_URL`, `BACKUP_BUCKET_*`. Timestamps stored in UTC, displayed in Asia/Amman.
- Nightly `pg_dump` to S3-compatible storage, 30-day retention; restore drill in `docs/runbooks/restore.md`.
- `/health`, structured pino logs, migrations before each deploy.

## 12. Out of scope for v1 (store, don't design)

Self-compacting, fiber-reinforced, integral-waterproofing/crystalline, mass-concrete thermal control (low-heat), lightweight/heavyweight, shotcrete, roller-compacted concrete, and air-entrained proportioning until its seeds are filled. These `special` flags show a "manual design required" banner; the evaluator can still check a manually entered design for compliance and cost.

## 13. Cross-plant comparison and legacy import

- **Compare plants:** run the same request at every active plant with materials mapped by category and specification (user confirms the mapping). Show best cost/m³, Δ vs current plant, and — if site distance and haul cost exist — an estimated delivered cost. Cost-visible roles only. Results are theoretical and trial-only.
- **Legacy import:** CSV/Excel (Appendix D) → column mapping → fuzzy material matching (Arabic first) → validation preview → designs created as `evaluated` with the evaluator's compliance, cost and data-quality results. A QC manager then **attests** each design with its external approval reference, moving it to `approved` (`approval_source: legacy_attested`) and, if it is currently produced, `in_production`. Attested designs become the savings baseline. Any design can be exported as a fixture.

## 14. Governance, lifecycle and savings

### 14.1 Design states and gates

| State | Meaning | Gate to enter |
|---|---|---|
| `draft` | Editable; incomplete inputs allowed | — |
| `evaluated` | Existing/manual mix evaluated; warnings allowed; implies no approval | Evaluator run with current inputs |
| `trial_candidate` | Recommendation passed independent validation; trial required | Validator pass after rounding |
| `trial_in_progress` | Trial batch recorded, acceptance incomplete | ≥ 1 trial batch logged |
| `trial_passed` | Trial criteria met and QC reviewed | All criteria in §14.4 pass; QC manager sign-off |
| `approved` | Approved for production use | Four-eyes approval; all governing rules verified; evidence current; and every key material property is from `lab_report` or `supplier_datasheet`, or QC has accepted the user-declared values with an e-signature (07 §2.5); or legacy attestation |
| `in_production` | Released to a named plant | QC manager or plant manager (own plant) release |
| `suspended` | Production use blocked pending review | Triggered per §14.3; QC decision |
| `superseded` / `retired` | Immutable history | New version approved / QC decision |

Transitions are server-enforced, append-only in `design_transitions`, and require named evidence. There is **no path from the optimizer to `approved` without a trial**, except legacy attestation and the minor-adjustment policy (§14.3), which defaults to none.

### 14.2 Savings ledger

Each opportunity stores baseline design/version, proposed design/version, baseline and comparison price snapshots, eligible volume, period and reason code. All comparisons use the **same price snapshot** for both designs, so market price movement never counts as optimization.

| State | Definition |
|---|---|
| Theoretical | (baseline cost − proposed cost) at the current price snapshot, per m³; × eligible volume when annualized. Before trial/approval. |
| Approved | Same calculation for an approved replacement at the approval-date price snapshot. |
| Realized | Σ over the period of (baseline cost − approved cost, both at that period's price snapshot) × actual produced volume of the replacement. |

Dashboard totals never mix states; every figure shows its state, period and price basis.

### 14.3 Change classes and revalidation

| Change | Default effect |
|---|---|
| Price only | Economic opportunity; no engineering effect on existing designs |
| Same material, new test within tolerance | Re-evaluate; no state change |
| Material property drift beyond tolerance, source change, expired key test | Re-evaluate; QC decides revalidation, trial or `suspended` |
| Strength deterioration or acceptance failure | Critical alert; QC decides `suspended` |
| Rule or project specification change | Re-evaluate dependents; may require revalidation |
| Proportion change | New version through trial — unless within the QC-configured minor-adjustment policy (default: none) |
| Admixture product change | New version through trial |

### 14.4 Trial acceptance criteria (QC-configured seeds, kind `parameter`)

Slump within the C94/project tolerance; air within tolerance; fresh density and yield within the configured band; temperature within the hot-weather limit; strength per the ACI 301 trial-mixture provisions (average of trial specimens at the test age ≥ f'cr) or the project's stricter criterion. Missing criteria block `trial_passed`.

## 15. Non-functional requirements

- One design request (≤ 200 configurations, including fixed-point iterations) solves in < 3 s in a worker thread; Studio re-solves are debounced and cancellable.
- Full audit log (who changed which price, rule, design or ledger entry, before/after); exports of prices/costs are logged.
- Every approved design reproducible exactly from its inputs snapshot.
- Every output carries the disclaimer: designs are proposals requiring trial batching and QC approval.
