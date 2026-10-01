# Code alignment, ACI ⇄ Jordanian

All values load as `verified: false`. They are **transcription candidates**, not authoritative until a QC manager checks each against the licensed current document on the Rules screen. Automated tests never convert an unverified transcription into a verified rule. Approval is blocked if any rule a design depends on (in the selected mode) is unverified or null.

## 1. Governing documents

| Ruleset | Documents | Role in engine |
|---|---|---|
| ACI | ACI 318-19 (Ch. 19 durability, Ch. 26 construction and acceptance) | Exposure, max w/cm, min f'c, cement, chlorides, air, SCM limits, NMAS, acceptance |
| | ACI 301-20 §4.2.3 | f'cr, statistical method, trial mixtures |
| | ACI 211.1 | Absolute volume proportioning and baseline tables |
| | ACI 214R | Strength statistics |
| | ACI 305.1 | Hot weather |
| | ACI 304.2R | Pumped concrete guidance |
| | ASTM C33, C94, C150, C595, C1157, C494, C618, C989, C1240, C1218 | Material compliance, grading, tolerances |
| JS | Jordanian National Building Code — Structural Concrete Code (كودة الخرسانة الإنشائية), 2022 edition, Parts 1 & 2 | Jordanian durability, strength and acceptance |
| | JS 30-1:2016 (cement; aligned with EN 197-1) | Cement taxonomy |
| | JS standards for aggregates, water, admixtures, ready-mix, testing — numbers filled by Sanad | Material compliance |
| | MPWH General Specifications (concrete works) | Optional PROJECT-layer source |
| PROJECT | Per-request project specification overrides | Consultant limits (e.g. max placing temperature 32 °C) |

Every constraint in the output carries a source badge, e.g. `ACI 318-19 T19.3.2.1`, `JSC-2022 §x.x`, `PROJECT`.

## 2. Engine step → clause map

| Engine step | ACI source | JS source (Sanad fills clause refs) | Rule keys |
|---|---|---|---|
| Exposure classification | ACI 318-19 T19.3.1.1 | JSC-2022 durability chapter | `exposure.*` |
| Durability limits | ACI 318-19 T19.3.2.1 | JSC-2022 durability chapter | `durability.<class>.*` |
| Air entrainment | ACI 318-19 T19.3.3.1 | JSC-2022 | `air.*` |
| SCM limits | ACI 318-19 T26.4.2.2(b) | JSC-2022 | `scm.max.*` |
| NMAS vs geometry | ACI 318-19 §26.4.2.1(a)(4) | JSC-2022 | `nmas.max_fraction.*` |
| f'cr | ACI 301 §4.2.3.3 | JSC-2022 quality chapter | `fcr.*` |
| Cube ⇄ cylinder | EN 206 class pairs (reference) | Jordanian practice / project | `strength.basis_map` |
| w/cm for strength | ACI 211.1 T6.3.4(a) (baseline) | — | `prop.wc_strength` |
| Water and entrapped air | ACI 211.1 T6.3.3 | — | `prop.water`, `prop.air_entrapped` |
| Coarse aggregate volume (sanity bound) | ACI 211.1 T6.3.6 | — | `prop.ca_volume` |
| Grading | ASTM C33 | JS aggregate standard | `grading.*` |
| Slump tolerance | ASTM C94 | JS ready-mix standard | `tolerance.slump` |
| Hot weather | ACI 305.1 | MPWH / project | `hot.*` |
| Acceptance | ACI 318-19 §26.12.3.1 | JSC-2022 acceptance clause | `accept.*` |

## 3. "Both" mode merge semantics (by rule `kind`)

| Rule kind | Both-mode result |
|---|---|
| `limit_max` (max w/cm, max chloride) | Lower of the two values |
| `limit_min` (min f'c, min binder) | Higher of the two values |
| `allowed_set` (cement properties) | Intersection; empty → infeasible with reason |
| `prohibition` (CaCl₂ not permitted) | Prohibited if either code prohibits |
| `range` / grading envelope | Intersection at each sieve; empty → infeasible with reason |
| `tolerance` | Tighter of the two |
| f'cr | Computed under each ruleset; higher governs |
| `table` (design aids, e.g. ACI 211.1) | Never auto-merged. Resolved by an explicit applicability policy tied to ruleset/project; the selected source is recorded. Conflicting applicable tables block design mode until QC chooses a verified method |
| `info` | Shown in the compliance table only, never a constraint (e.g. C2 minimum cover is structural) |
| Null or unresolved on one side | Missing is never evidence that the other side suffices. The known requirement may drive provisional evaluation; JS/Both approval is blocked and the gap is surfaced |

The **PROJECT** layer merges on top with the same semantics and may only tighten limits.

## 4. Starter seed values — ACI (all `verified: false`)

**Sulfate exposure thresholds — ACI 318-19 T19.3.1.1**

| Class | Water-soluble SO₄ in soil (% by mass) | SO₄ in water (ppm) |
|---|---|---|
| S0 | < 0.10 | < 150 |
| S1 | 0.10–0.20 | 150–1,500, or seawater |
| S2 | 0.20–2.00 | 1,500–10,000 |
| S3 | > 2.00 | > 10,000 |

**Durability requirements — ACI 318-19 T19.3.2.1**

| Class | Max w/cm | Min f'c (MPa) | Cement / other | Max water-soluble Cl⁻ (% of cementitious, non-prestressed / prestressed) | CaCl₂ admixture |
|---|---|---|---|---|---|
| F0 | — | 17 | — | — | — |
| F1 | 0.55 | 24 | Air per T19.3.3.1 | — | — |
| F2 | 0.45 | 31 | Air per T19.3.3.1 | — | — |
| F3 | 0.40 | 35 | Air + SCM limits T26.4.2.2(b) | — | — |
| S0 | — | 17 | No restriction | — | Allowed |
| S1 | 0.50 | 28 | C150 Type II / C595 (MS) / C1157 MS | — | Allowed |
| S2 | 0.45 | 31 | C150 Type V / C595 (HS) / C1157 HS | — | Not permitted |
| S3 opt. 1 | 0.45 | 31 | Type V + pozzolan or slag | — | Not permitted |
| S3 opt. 2 | 0.40 | 35 | Type V | — | Not permitted |
| W0 | — | 17 | — | — | — |
| W1 | — | 17 | ASR mitigation per §26.4.2.2(d) | — | — |
| W2 | 0.50 | 28 | ASR mitigation | — | — |
| C0 | — | 17 | — | 1.00 / 0.06 | — |
| C1 | — | 17 | — | 0.30 / 0.06 | — |
| C2 | 0.40 | 35 | Min cover per Ch. 20 (kind `info`) | 0.15 / 0.06 | — |

**Air content for F classes — ACI 318-19 T19.3.3.1 (%, tolerance ± 1.5)**

| NMAS (mm) | 9.5 | 12.5 | 19 | 25 | 37.5 |
|---|---|---|---|---|---|
| F1 | 6.0 | 5.5 | 5.0 | 4.5 | 4.5 |
| F2 / F3 | 7.5 | 7.0 | 6.0 | 6.0 | 5.5 |

F classes are rare in Jordan except high-altitude sites; default exposure is F0.

**SCM limits for F3 — ACI 318-19 T26.4.2.2(b)** (% of total cementitious): fly ash / natural pozzolan ≤ 25; slag ≤ 50; silica fume ≤ 10; fly ash + silica fume ≤ 35; total fly ash + slag + silica fume ≤ 50.

**Max NMAS — ACI 318-19 §26.4.2.1(a)(4):** ≤ 1/5 narrowest form dimension; ≤ 1/3 slab depth; ≤ 3/4 minimum clear bar spacing.

**Required average strength — ACI 301 §4.2.3.3**

- With ≥ 15 consecutive tests (similar materials, f'c within 7 MPa of the specified value); s multiplied by the n-factor: 15 → 1.16, 20 → 1.08, 25 → 1.03, ≥ 30 → 1.00.
  - f'c ≤ 35 MPa: f'cr = max(f'c + 1.34s, f'c + 2.33s − 3.45)
  - f'c > 35 MPa: f'cr = max(f'c + 1.34s, 0.90·f'c + 2.33s)
- Without data: f'c < 21 → f'c + 7.0; 21 ≤ f'c ≤ 35 → f'c + 8.3; f'c > 35 → 1.10·f'c + 5.0.

**Acceptance — ACI 318-19 §26.12.3.1:** every average of 3 consecutive tests ≥ f'c; no single test below f'c − 3.5 MPa (f'c ≤ 35) or below 0.90·f'c (f'c > 35).

**ACI 211.1 baseline tables (SI, non-air-entrained)**

Water, kg/m³ — T6.3.3:

| Slump (mm) \ NMAS (mm) | 9.5 | 12.5 | 19 | 25 | 37.5 | 50 |
|---|---|---|---|---|---|---|
| 25–50 | 207 | 199 | 190 | 179 | 166 | 154 |
| 75–100 | 228 | 216 | 205 | 193 | 181 | 169 |
| 150–175 | 243 | 228 | 216 | 202 | 190 | 178 |
| Entrapped air (%) | 3.0 | 2.5 | 2.0 | 1.5 | 1.0 | 0.5 |

w/c vs 28-day cylinder strength — T6.3.4(a), non-air-entrained (interpolate linearly):

| f'cr (MPa) | 40 | 35 | 30 | 25 | 20 | 15 |
|---|---|---|---|---|---|---|
| w/c | 0.42 | 0.47 | 0.54 | 0.61 | 0.69 | 0.79 |

Dry-rodded coarse aggregate volume per unit volume of concrete — T6.3.6 (± 10% sanity bound on the optimized blend only):

| NMAS (mm) \ FM of sand | 2.40 | 2.60 | 2.80 | 3.00 |
|---|---|---|---|---|
| 9.5 | 0.50 | 0.48 | 0.46 | 0.44 |
| 12.5 | 0.59 | 0.57 | 0.55 | 0.53 |
| 19 | 0.66 | 0.64 | 0.62 | 0.60 |
| 25 | 0.71 | 0.69 | 0.67 | 0.65 |
| 37.5 | 0.75 | 0.73 | 0.71 | 0.69 |

**Slump tolerance — ASTM C94:** nominal ≤ 50 mm → ± 15 mm; 50–100 mm → ± 25 mm; > 100 mm → ± 40 mm.

**Hot weather — ACI 305.1 default:** max concrete temperature at placement 35 °C unless the PROJECT layer is stricter (many Jordanian specifications set 32 °C).

## 5. Cross-code equivalence (critical for Both mode)

ACI names cements by ASTM type; Jordan uses EN 197-1 naming through JS 30-1. **The engine checks mill-certificate properties, not labels.**

| ACI requirement | Satisfied by a Jordanian cement when… |
|---|---|
| Type II / (MS) — moderate sulfate | C₃A ≤ 8%, or CEM II/x-P with documented sulfate performance (flag for QC review) |
| Type V / (HS) — high sulfate | C₃A ≤ 5% (CEM I SR3 or SR5) |
| Type V + pozzolan or slag (S3 opt. 1) | Sulfate-resisting cement + SCM within the allowed range in the same mix |
| Air-entrained | AE admixture dosage achieving the T19.3.3.1 target |

If `c3a_pct` is missing, the candidate is infeasible with reason "cement C₃A not on file".

**JS seed skeleton:** every rule key from §2 with `value: null`, `clause_ref: "JSC-2022 §TBD"`, `verified: false`. Pre-fill only the cement taxonomy per JS 30-1:2016 / EN 197-1 (CEM I 42.5N, CEM I 52.5N, CEM I 42.5N-SR3, CEM II/A-P 42.5N, CEM II/B-P 32.5N, CEM II/B-P 42.5N, CEM II/B-LL 42.5N) and the EN 197-1 sulfate-resisting definitions for CEM I (SR0: C₃A = 0%; SR3: ≤ 3%; SR5: ≤ 5%). Where the Jordanian code adopts an ACI value verbatim, allow `inherits: "ACI:<rule_key>"` (still requires verification).

**Strength basis mapping** (`strength.basis_map`, editable; confirm against the Jordanian code and project specifications):

| Cylinder f'c (MPa) | Cube (MPa) | EN 206 class | Jordanian B-grade (cube, kg/cm²) |
|---|---|---|---|
| 20 | 25 | C20/25 | B250 |
| 25 | 30 | C25/30 | B300 |
| 30 | 37 | C30/37 | B350–B375 (confirm) |
| 35 | 45 | C35/45 | B450 |
| 40 | 50 | C40/50 | B500 |
| 45 | 55 | C45/55 | B550 |
| 50 | 60 | C50/60 | B600 |

ACI always computes on cylinder f'c; cube-based requests convert through this table and the conversion is recorded on the design.

## 6. Engineering parameters (not code values — Sanad confirms)

Stored in `packages/rules/seeds/engineering/*.yaml` as kind `parameter`, class `ENGINEERING_GUARDRAIL`, `verified: false`.

| Parameter | Starter value | Purpose | Needed by |
|---|---|---|---|
| Combined grading target | 0.45-power curve to NMAS, band ± (Sanad sets) | Default envelope when no project envelope exists | M3.1 |
| Shilstone CF band | 45–75 (starter — confirm) | Coarseness factor bounds | M3.1 |
| Shilstone WF band | Sanad sets per NMAS | Workability factor bounds | M3.1 |
| WF binder adjustment | +2.5 WF points per 56 kg/m³ binder above 335 kg/m³ | Shilstone binder correction | M3.1 |
| Max combined % passing 75 µm | Sanad sets (crushed-sand dependent) | Fines cap | M3.1 |
| Pumpable: min % passing 0.3 mm | Sanad sets | Pumpability | M3.1 |
| β_FM, β_75 water adjustments | null until calibrated from trial batches | Water demand vs blend | M5.2 |
| Robustness margins | w/cm − 0.02; grading 2 percentage points inside envelope | Keep designs off constraint edges | M3.1 |
| Trial acceptance criteria | Sanad/QC sets (`01-domain.md` §14.4) | Gate to `trial_passed` | M4.1 |
| Test-age limits per material category | Sanad/QC sets | When a test becomes stale | M1.1 |
| Moisture-input limits | Sanad/QC sets | Reject impossible moisture values | M4.2 |

## 7. Jordan exposure presets (suggestions; the user confirms)

- Marine / coastal (e.g. Aqaba sites): C2 + S1 (seawater).
- Saline / sabkha soils (Dead Sea, Jordan Valley, Azraq areas): prompt for soil/groundwater SO₄ and Cl⁻ results and classify with T19.3.1.1.
- Water-retaining structures (tanks, pools): W2.
- Foundations below groundwater: W1/W2 + sulfate classification from the soil report.
- High-altitude freezing sites (e.g. Shoubak, Ras Munif): F1.
- Interior elements: F0 / S0 / W0 / C0 (strength-governed).

## 8. Compliance report (every design and every PDF)

Columns: requirement | class | ACI value | JS value | PROJECT value | governing value | design value | margin | pass / warn / fail | evidence status | clause refs. Failures sort first. `info` rows (e.g. C2 cover) appear in a separate "structural requirements — not checked by mix design" block. Strength adequacy appears in its own block with its model evidence status, never mixed into code compliance. This table is the consultant's main deliverable, so it must be complete and bilingual.

## 9. Precedence of user characteristics

Layers resolve in this order: **CODE** (ACI / JS / Both) → **PROJECT** → **request characteristics** → **profile characteristics** (product family → plant → tenant) → **engine defaults** (guardrails and models). CODE and PROJECT limits always apply. A user characteristic may only make them stricter; a value that would loosen one is rejected with the governing rule and clause. Between user layers, the more specific layer replaces the same characteristic.
