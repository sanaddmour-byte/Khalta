# Characteristics specification (Addendum A1 to Build Prompt v4)

This addendum extends **Build Prompt v4** so the builder works from characteristics the user provides. It does not replace v4. Where the two conflict, this addendum wins, except that the v4 Engineering Safety Contract always wins.

It adds four capabilities:

1. **Mix characteristics you set** — fix, bound or target any of ~20 mix characteristics; the engine solves only what you leave free.
2. **Material characteristics you enter** — type material properties directly (lab report, datasheet or your own values); the builder uses them immediately, with their source tracked.
3. **Saved characteristic profiles** — reusable sets (e.g. "C30 pump – Aqaba – summer") that pre-fill every new design.
4. **Feature manifest** — the list of app features in `06-features.md`; Claude Code builds exactly the approved items.

---

# 0. Amendments to the v4 files (applied in the branch `spec/addendum-a1`)

## A1. `CLAUDE.md`

**Spec map** — add these rows at the top of the table:

| File | Read when |
|---|---|
| `docs/spec/06-features.md` | **Always first.** Sanad's feature manifest — the build list |
| `docs/spec/07-characteristics.md` | Mix characteristics, material characteristic entry, profiles, objective modes |

**Insert a new section before "Session protocol":**

> ## What to build — precedence
>
> 1. The Engineering Safety Contract and non-negotiable rules (this file) always win.
> 2. The feature manifest (`06-features.md`) decides **what** is built. Build only features with status `approved` that belong to the active milestone. If something seems missing, add it to the manifest as `proposed` with a one-line rationale — never build it.
> 3. The specs (`01`–`05`, `07`) decide **how** it is built. Where `07` and an earlier spec conflict, `07` wins. If an approved feature has no spec coverage, write a short spec addendum inside the milestone plan for approval before building.
> 4. If a manifest feature conflicts with the safety contract or a spec, stop and ask, quoting both texts.

**Session protocol, step 1** — change to: read `06-features.md`, `04-phases.md` and `docs/progress.md`; state the active milestone, the feature IDs in scope, what is done, and the plan for this session.

**Engineering Safety Contract** — append to item 5: *"Values the user types are allowed and used, but always carry their source (`lab_report`, `supplier_datasheet`, `user_declared`)."* Add item 11:

> 11. **User characteristics tighten, never loosen.** A characteristic the user provides may narrow any limit, and may override engineering guardrails or model estimates (QC role, recorded, flagged). It may never relax a `CODE_HARD` or `PROJECT_HARD` limit; such input is rejected at entry — UI and API — with the governing rule and clause.

**Requirement classes table** — add:

| Class | Meaning | May be presented as compliance? | May appear in a "what-if" relaxation? |
|---|---|---|---|
| `USER_SPECIFIED` | A characteristic the user fixed, bounded or targeted (request or profile) | No — shown as the user's choice | Yes — the user may release it; conflict diagnostics name it |

**Evidence statuses** — add `USER_OVERRIDE` (a user characteristic replaced a model estimate or guardrail), `INPUT_USER_DECLARED` (material value typed by the user, not from a lab report or datasheet) and `MODEL_PREDICTS_SHORTFALL` (the user's characteristics leave the strength model below f'cr).

**Command contract** — add:

| Command | Must do |
|---|---|
| `pnpm features:check` | Validate `06-features.md` format and list the approved features for the active milestone |

## A2. `docs/spec/01-domain.md`

- Add at the top: *"`07-characteristics.md` extends §2 (data model), §3 (pipeline), §4 (optimizer), §10 (RBAC) and §14.1 (gates). Where they conflict, `07` wins."*
- §2.8 Settings — add: target-penalty default weight, rounding tolerance per characteristic, water-override warning threshold (%), material sanity ranges (warn only), `approval_requires_lab_source` (default on).
- §14.1 `approved` gate — add: *"…and every key material property is from `lab_report` or `supplier_datasheet`, or QC has accepted the user-declared values with an e-signature (07 §2.5)."*

## A3. `docs/spec/02-codes.md`

Add **§9 Precedence of user characteristics**:

> Layers resolve in this order: **CODE** (ACI / JS / Both) → **PROJECT** → **request characteristics** → **profile characteristics** (product family → plant → tenant) → **engine defaults** (guardrails and models). CODE and PROJECT limits always apply. A user characteristic may only make them stricter; a value that would loosen one is rejected with the governing rule and clause. Between user layers, the more specific layer replaces the same characteristic.

## A4. `docs/spec/03-ui.md`

- §4 Key screens — add: *"Characteristics panel, material quick entry and the Profiles screen are specified in `07-characteristics.md` §6."* Add **Profiles** to the side navigation after Mix Library.
- §8 Quality gate — add two checks: a code-loosening characteristic is visibly rejected with its clause; every value in a design shows its origin (profile, request, declared, lab, model).

## A5. `docs/spec/04-phases.md`

| Milestone | Add to scope | Add to milestone Done | Add to "Needs from Sanad" |
|---|---|---|---|
| M0.1 | `pnpm features:check`; apply Part 0 amendments (diff approved) | Manifest validates; amendments merged | Edited manifest |
| M1.1 | Material characteristic entry with source, minimum sets, quick entry, paste gradation, ad-hoc materials and promotion (07 §2) | Gradation and minimum-set validation tested | Pilot-plant material characteristics |
| M2.1 | Characteristic schema and resolver (layering, unit normalization, hard-limit rejection); evaluate reports requested vs achieved | Code-loosening input rejected at API level (tested) | — |
| M3.1 | Characteristic rows in the LP (07 §4), degrees of freedom, conflict diagnostics, objective modes, rounding tolerances | Every characteristic × mode satisfied exactly (property tests); conflict fixtures name the right characteristics | — |
| M3.2 | Characteristics panel, DoF meter, conflict panel, quick-entry drawer (07 §6) | Quality gate incl. the two new checks | — |
| **M3.3 (new)** | Characteristic profiles: CRUD, layering, versions, approval, "save as profile", Profiles screen (07 §3) | Layering resolution tests; profile version snapshotted on designs | First profiles per product family |
| M4.1 | Declared-values approval policy (07 §2.5) | Approval blocked without lab source or QC acceptance (tested) | — |

---

# 1. Mix characteristics you set

## 1.1 Modes

Every characteristic in a request or profile has one mode:

| Mode | Meaning | Solver treatment |
|---|---|---|
| `auto` | The engine decides within all limits | No extra row |
| `fixed` | Exact value | Equality row (class `USER_SPECIFIED`) |
| `range` | Min and/or max | Inequality rows (class `USER_SPECIFIED`) |
| `target` | Preferred value, may deviate | Deviation variables d⁺, d⁻ ≥ 0 with `expr − t = d⁺ − d⁻`, penalized in the objective (§4.3) |

## 1.2 Supported characteristics

Mᵢ = 1000·SGᵢ·Vᵢ (aggregate mass); all forms below are linear in the v4 decision variables B, W, Vᵢ.

| Characteristic | Key | Unit | Modes | Implementation |
|---|---|---|---|---|
| Water/cementitious ratio | `wcm` | ratio | fixed, range | W − v·B (=, ≤, ≥) 0 |
| Total binder | `binder_kg` | kg/m³ | fixed, range, target | B |
| Cement content | `cement_kg` | kg/m³ | fixed, range, target | (1 − p)·B |
| SCM product and % | `scm` | product, % of binder | fixed, range | Enumerate p only inside the range |
| Free water | `water_kg` | kg/m³ | fixed, range, target | W; when fixed or bounded it replaces the water-demand estimate as C4 (`USER_OVERRIDE`) |
| Air content | `air_pct` | % | fixed, range | Constant in C1; a range is enumerated at both bounds and the validator checks both |
| Admixture product and dosage | `admixture` | product, dosage level or % | fixed, range | Enumerate only products/levels inside the range; outside the product's min/max → rejected |
| Fine-to-total aggregate ratio | `sand_ratio_pct` | % (basis `mass` default, or `volume`) | fixed, range, target | Σ_fine Mᵢ − r·Σ_all Mᵢ (=, ≥, ≤) 0 (use Vᵢ for volume basis) |
| Share of one aggregate | `agg_share_pct.<material>` | % of total aggregate | fixed, range, target | M_k − s·Σ Mᵢ (=, ≥, ≤) 0 |
| Mass of one aggregate | `agg_kg.<material>` | kg/m³ | fixed, range | M_k |
| Paste volume | `paste_l` | L/m³ | range, target | 1000·(1 − Σ Vᵢ) |
| Combined fineness modulus | `fm_combined` | — | range, target | Σ Mᵢ·(FMᵢ − t) (=, ≥, ≤) 0 |
| Combined % passing a sieve | `passing_pct.<sieve_mm>` | % | range | Σ SGᵢ·Vᵢ·(Pᵢⱼ − v) (≥, ≤) 0 |
| Shilstone CF / WF | `shilstone.cf`, `shilstone.wf` | — | range | Replaces the C6/C7 guardrail bounds (QC role) |
| Max fines (75 µm) | `fines_max_pct` | % | range (max) | Replaces the C8 guardrail bound (QC role) |
| Fresh density | `fresh_density_kg_m3` | kg/m³ | range, target | B·(1 + d) + W + Σ Mᵢ |
| Slump | `slump_mm` | mm | fixed | Selects the water baseline; tolerance per C94/project |
| NMAS | `nmas_mm` | mm | fixed, list | Enumeration |
| Extra strength margin | `extra_margin_mpa` | MPa | fixed (≥ 0) | Added to f'cr |
| Design strength | `fcr_mpa` | MPa | fixed | Used only if ≥ code f'cr; lower values rejected |
| Max material cost | `max_cost_jod_m3` | JOD/m³ | range (max) | Objective expression ≤ value |
| Materials | `materials.include / exclude / prefer` | material ids | lists | Availability rows (C9); `prefer` adds a small objective bonus set in settings |

New characteristics must be added through the manifest and this table, never ad hoc.

## 1.3 Rules that protect the design

1. **Hard limits first.** Each characteristic is validated against the resolved CODE and PROJECT limits when entered (UI) and when received (API). Loosening input is rejected with the rule, clause and the allowed bound (e.g. "w/cm ≤ 0.45 — ACI 318-19 T19.3.2.1 (S2)").
2. **Guardrail overrides** (CF/WF, fines, robustness margins) need QC role, are recorded with a reason, and add `USER_OVERRIDE`.
3. **Model overrides.** When the user fixes water or w/cm, the model estimate is still computed and shown. If fixed water is below the water-demand estimate by more than the settings threshold, warn "slump at risk". If the user's w/cm (or the w/cm implied by fixed binder and water) is above the strength-model w/cm for f'cr, flag `MODEL_PREDICTS_SHORTFALL`: the candidate can be saved as a draft but becomes a `trial_candidate` only if QC authorizes a trial-only recommendation.
4. **Physical identity always holds.** Volume = 1.000 m³ is never relaxed; over-specified sets resolve by releasing user characteristics, never by breaking volume.

# 2. Material characteristics you enter

## 2.1 Sources

`material_tests.source` is one of:

| Source | Meaning | Evidence |
|---|---|---|
| `lab_report` | From a lab report (attachment required) | Normal |
| `supplier_datasheet` | From the supplier's datasheet or mill certificate (attachment recommended) | Normal |
| `user_declared` | Typed by the user from their own knowledge | `INPUT_USER_DECLARED` |

Each record also stores `declared_by`, `declared_at`, an optional reason, and remains versioned (v4 §2.2).

## 2.2 Minimum characteristic sets

The builder runs as soon as the minimum set for the chosen workflow exists. Missing fields show as named blockers.

| Category | Evaluate mode needs | Design mode also needs |
|---|---|---|
| Fine / coarse aggregate | SG (SSD), absorption | Full gradation on the configured sieves (FM computed); % finer than 75 µm |
| Cement | SG | `c3a_pct` when a sulfate class above S0 governs; alkali when an ASR rule is active |
| SCM | Type, SG | Same |
| Admixture | Type, SG, solids % | Min/max dosage and a dosage → water-reduction table with ≥ 3 points |
| Water | Source (SG defaults to 1.000, user-confirmed) | Chloride content if recycled water is used |

## 2.3 Quick entry

- Entry form per category with the minimum set highlighted and units on every field.
- Paste a gradation row (or a full sieve table) from Excel; FM computes instantly.
- **Hard validation** (physical): % passing must be non-increasing as sieves get smaller, 100% at the largest sieve, values 0–100.
- **Sanity warnings** (settings, warn only): e.g. aggregate SG outside 2.3–3.1, absorption outside 0–6%, FM of a fine aggregate outside its expected band.
- Attach a lab report or datasheet to upgrade the source later; history keeps both.

## 2.4 Ad-hoc materials and per-request overrides

- **Ad-hoc material:** defined inside one request for a what-if (e.g. "a new supplier's فولية"), with an optional ad-hoc price. Stored only in the request snapshot, flagged `INPUT_USER_DECLARED`, and its cost is theoretical. One click promotes it to the library (creates the material and a `user_declared` test).
- **Per-request override:** change one property of a library material for one request (e.g. today's absorption), with a reason. Recorded in the snapshot; the library is unchanged.

## 2.5 Approval policy for declared values

- Designs using declared values can reach `trial_candidate` normally.
- With `approval_requires_lab_source` on (default), `approved` requires every **key property** to come from `lab_report` or `supplier_datasheet`: aggregate gradation, SG and absorption; cement `c3a_pct` when sulfate governs; admixture dosage response. Otherwise a QC manager must accept the declared values with an e-signature, recorded in `recommendation_evidence`.

# 3. Saved characteristic profiles

## 3.1 What a profile holds

`characteristic_profiles`: id, name_ar, name_en, scope (`tenant` | `plant` | `product_family`), plant_id (nullable), **applies_to** (strength class range, exposure classes, pumpable, placement, season), **characteristics** (Appendix E schema), material preferences (include / exclude / prefer), default objective mode, default ruleset mode, status (`draft` | `approved`), version, owner, approved_by.

## 3.2 Layering

1. Tenant profile → plant profile → product-family profile (matching `applies_to`) → request.
2. For the same characteristic key, the more specific layer replaces the less specific one.
3. CODE and PROJECT limits still apply on top (A3 precedence).
4. Every resolved characteristic stores its origin (profile id + version, or "request"). Designs snapshot the profile versions they used, so later profile edits never change existing designs.

## 3.3 Governance

- QC engineers create `draft` profiles; QC managers approve. Draft profiles can be used for drafts and evaluations only; approved profiles are required for `trial_candidate` generation from a profile.
- On save, a profile is checked against ACI and JS for every exposure in its `applies_to`; combinations that would be rejected are listed before approval.
- When a profile gets a new version, an info insight lists designs built on older versions (no state change).

# 4. Engine changes

## 4.1 Pipeline step 0 — resolve characteristics (before v4 §3 step 1)

1. Merge layers (§3.2) and normalize units.
2. Validate each characteristic against CODE/PROJECT limits; reject loosening values (§1.3).
3. Compute **degrees of freedom**: free continuous quantities (B, W, each Vᵢ) minus equality rows (volume + every `fixed` characteristic expressed as an equality).
   - DoF ≥ 1 → the optimizer has room.
   - DoF = 0 → fully determined: the engine evaluates and checks only.
   - DoF < 0 → over-specified: go straight to conflict diagnostics.
4. Emit `USER_SPECIFIED` rows for the LP and record `USER_OVERRIDE` wherever a characteristic replaced a model estimate or guardrail.

Evaluate mode is the special case where every quantity is fixed.

## 4.2 Conflict diagnostics

When the user rows make the problem infeasible, re-solve with elastic slack variables on `USER_SPECIFIED` rows only (hard rows stay hard), minimizing total normalized slack. Report each characteristic with non-zero slack and the value that would work, e.g.:

> "Your characteristics conflict. Release or change one of: sand ratio 42% (feasible from 44.8%), cement 330 kg/m³ (feasible from 352 kg/m³)."

If the problem stays infeasible with every user row released, report the binding hard rows as in v4 §4.3 — diagnostics only, no savings attached.

## 4.3 Objective modes

| Mode | Behavior |
|---|---|
| `cheapest` (default) | Minimize material cost + Σ (weight × deviation) over `target` characteristics. Weight is in JOD/m³ per unit of deviation (default from settings) |
| `closest_to_targets` | Two-stage (lexicographic) LP: stage 1 minimizes Σ weight × deviation / scale; stage 2 fixes that optimum within a tolerance and minimizes cost |

`max_cost_jod_m3` applies in both modes.

## 4.4 Rounding and validation

After v4 §5 rounding, the independent validator also checks every `fixed` and `range` characteristic within its rounding tolerance (settings, e.g. sand ratio ± 0.5 percentage points). Outside tolerance → reject the candidate and report which characteristic rounding broke.

## 4.5 Outputs

Each candidate lists "your characteristics": requested vs achieved, met / within target band / deviated, and their origin. The compliance table gets a separate "Your characteristics" block — never mixed with code compliance.

# 5. Data model additions

- `design_requests.characteristics` (json, Appendix E), `design_requests.profile_versions` (array), `design_requests.objective_mode`.
- `characteristic_profiles` (§3.1) and `characteristic_profile_versions` (immutable).
- `material_tests.source`, `declared_by`, `declared_at`, `declaration_reason`, `attachment_id`.
- `request_materials_adhoc` (request-scoped materials and prices) and `request_material_overrides`.
- `recommendation_evidence.declared_value_acceptance` (QC e-signature reference).

# 6. UI additions

**Characteristics panel** (Studio, Requirements stage)

- Grouped sections: Strength & durability · Binder & water · Aggregates · Fresh properties · Economics.
- Each row: name, mode control (Auto | Fixed | Range | Target), inputs with units, origin badge (profile name + version, Request, Code bound), and the live code/project bound beside the input ("≤ 0.45 · ACI S2").
- Rejected values show inline with the rule and clause; the field never accepts them.
- **DoF meter**: "3 quantities left for the optimizer" / "Fully specified — evaluate only" / "Over-specified".
- **Conflict panel**: the characteristics to release, each with the feasible value and a one-click "Release".
- Objective toggle: Cheapest | Closest to my targets.
- Profile picker at the top: suggests matching profiles, shows "applied from C30 pump – Aqaba v3 · 2 overrides", and "Save these characteristics as a profile…".

**Material quick entry** — "+ Enter characteristics" on any material chip opens a drawer with the minimum set highlighted, source selector, attachment, paste-gradation box and live FM; "Use for this request only" creates an ad-hoc material.

**Profiles screen** — list filtered by scope, plant and product family; versions and diff; approve (QC manager); "used by N designs".

**Candidates and designs** — chips "6 of 7 characteristics met exactly", plus `USER_OVERRIDE`, `INPUT_USER_DECLARED` or `MODEL_PREDICTS_SHORTFALL` where they apply.

**PDF submittal** — a "Specified characteristics" block with values and origins; declared material values marked as such.

# 7. Roles and permissions additions

| Capability | Admin | QC Mgr | QC Eng | Procurement | Plant Mgr | Sales | Viewer |
|---|---|---|---|---|---|---|---|
| Enter / declare material characteristics | | ✓ | ✓ | | own plants | | |
| Set request characteristics | | ✓ | ✓ | | | | |
| Override guardrails through characteristics | | ✓ | request only (QC Mgr approves) | | | | |
| Create profiles (draft) | | ✓ | ✓ | | | | |
| Approve profiles | | ✓ | | | | | |
| Accept declared values for approval | | ✓ | | | | | |

# 8. Tests

- Every characteristic × every supported mode is satisfied exactly by the optimizer and re-checked by the validator (property tests).
- Code-loosening values are rejected by both UI and API (the API cannot be used to bypass the form).
- Over-specified fixtures: diagnostics name exactly the conflicting characteristics and feasible values.
- DoF calculation tests for 0, positive and negative cases.
- Profile layering: more specific layer wins per key; origins recorded; profile edits never change existing designs.
- `closest_to_targets` returns the minimum-deviation solution and then the cheapest among those.
- Gradation validation rejects non-monotonic input; declared values propagate `INPUT_USER_DECLARED` to every dependent design.
- Approval blocked for declared key properties without QC acceptance.

# 9. Appendix E — Characteristics schema

`characteristics` json used by requests and profiles (validated with Zod; keys from §1.2 only):

```json
{
  "objective": "cheapest",
  "characteristics": {
    "wcm":            { "mode": "range", "max": 0.45 },
    "cement_kg":      { "mode": "range", "min": 330, "max": 380 },
    "scm":            { "mode": "fixed", "product": "np-pozzolan-01", "pct": 15 },
    "water_kg":       { "mode": "auto" },
    "admixture":      { "mode": "fixed", "product": "sp-typeF-01", "dosage_level": 2 },
    "sand_ratio_pct": { "mode": "target", "value": 44, "basis": "mass", "weight_jod_per_unit": 0.05 },
    "agg_share_pct":  { "simsimiyyeh-amm-01": { "mode": "range", "min": 10, "max": 20 } },
    "slump_mm":       { "mode": "fixed", "value": 150 },
    "extra_margin_mpa": { "mode": "fixed", "value": 2 },
    "max_cost_jod_m3":  { "mode": "range", "max": 32.000 }
  },
  "materials": {
    "include": ["cem-I-42.5N-amm", "simsimiyyeh-amm-01", "fooliyyeh-amm-02"],
    "exclude": ["raml-amm-03"],
    "prefer":  ["naameh-amm-01"]
  },
  "origin": {
    "profiles": ["c30-pump-aqaba@3"],
    "request_overrides": ["cement_kg"]
  }
}
```

Values above illustrate the format only. `weight_jod_per_unit` is JOD/m³ per unit of deviation (here per percentage point of sand ratio).

---

*Generated designs are proposals that require trial batching and QC approval before production.*
