# Optimizer formulation (M3.1)

Everything the optimizer solves is **linear** in the design quantities once the discrete choices are fixed. This note states every term, why it is linear, and every interpretation the engineering team must confirm. Symbols: kg per m³ of concrete unless stated; volumes in m³ per m³.

## Discrete choices (enumerated, not optimized)

cement product × SCM product × SCM fraction p × admixture product × dosage level d (% of binder; 3–5 levels from the product's water-reduction table) × NMAS × air content. Cap 200 configurations (coarsened to larger SCM steps, then to the end dosage levels, then evenly sampled; the reduction is reported). The order is deterministic.

## Continuous variables (per configuration)

`B` binder (cement + SCM), `W` added water, `V_j` the volume of each aggregate _j_. Derived: cement = (1−p)·B; SCM = p·B; admixture = (d/100)·B; free water `Wf = W + k·B` with `k = (d/100)(1 − solids/100)` when the product's liquid counts as water (else 0); aggregate mass `m_j = ρ_j·V_j` with `ρ_j = SG_ssd·1000`.

## Rows

| Row                    | Form                                                                                                                      | Linear because                                                                                                                   | Class                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `P:volume`             | `a·B + W/(1000·SG_w) + ΣV_j = 1 − air/100`, `a = (1−p)/(1000·SG_c) + p/(1000·SG_s) + (d/100)/(1000·SG_a)`                 | masses are fixed fractions of B                                                                                                  | physical                                 |
| `P:aggregate_volume`   | `ΣV_j ≥ minAggregateVolume` (default 0.45)                                                                                | linear; excludes the degenerate all-paste point                                                                                  | physical (guard, not engineering advice) |
| `C:wcm_limit`          | `Wf ≤ w_max·B` (durability limit, **no** margin)                                                                          | `w_max` is a constant                                                                                                            | code                                     |
| `E:wcm_ceiling`        | `Wf ≤ (min(w/c baseline, w_max) − margin)·B`                                                                              | constant ceiling                                                                                                                 | engineering                              |
| `E:water_demand`       | `Wf ≥ T(slump, NMAS)·(1 − red(d)/100)`                                                                                    | the table and the reduction depend only on enumerated d                                                                          | engineering                              |
| `C:chloride`           | `Σ ρ_j·cl_j/100·V_j + W·mg/L/(SG_w·10⁶) + (d/100)·cl_a/100·B ≤ (limit/100)·B`                                             | every term is a constant times a variable                                                                                        | code                                     |
| `E:grading@s` (± band) | `Σ m_j·(p_j(s) − (T(s) ± (band − margin − guard))) ≷ 0`, `T(s) = 100·(s/D_max)^0.45`                                      | homogeneous in the masses: P(s) = Σm_j p_j/Σm_j is a ratio of linear forms, so the band is linear after clearing the denominator | engineering                              |
| `E:cf:min/max`         | `Σ m_j·(100·(100−p_j(9.5)) − cf·(100−p_j(2.36))) ≷ 0`, `cf = bound ± guard`                                               | ratio of linear forms, cleared                                                                                                   | engineering                              |
| `E:wf:min/max`         | `Σ m_j·(p_j(2.36) − (bound ± guard + adj)) ≷ 0`, `adj = pts·max(0, B−above)/per_kg` frozen at B_est                       | the only non-linear term is `adj`; it is frozen at the last iteration's B and iterated                                           | engineering                              |
| `E:fines`              | `Σ m_j·(f_j − (cap − guard)) ≤ 0`, `f_j` = % passing 75 µm                                                                | ratio cleared                                                                                                                    | engineering                              |
| `E:pumpable`           | `Σ m_j·(p_j(0.3) − (min + guard)) ≥ 0` (pumpable requests)                                                                | ratio cleared                                                                                                                    | engineering                              |
| `E:ca_volume:min/max`  | `Σ_coarse m_j/DRUW_j ∈ [f(1∓band), f(1±band)]`, `f` = ACI 211.1 Table 6.3.6 at the previous iteration's fine-aggregate FM | table value frozen per iteration                                                                                                 | engineering (sanity)                     |
| `U:<characteristic>`   | see below                                                                                                                 |                                                                                                                                  | user                                     |

Individual aggregate acceptance (each fine aggregate against `grading.fine.limits`, each coarse against `grading.coarse.limits`, tightest of the selected codes) is a **pre-filter** on materials, not an LP row; a failing aggregate is excluded with its reason.

`guard` (`guardrailGuard`, default 0.25 points) keeps a margin inside every guardrail so rounding cannot push a candidate over it; the final check on the rounded mix uses the limits **without** the guard. `margin` is `eng.margin.grading_pct_points`.

## Characteristics (all USER_SPECIFIED)

A ratio quantity `num/den` with bound `b` becomes `num − b·den ≷ 0` (linear because `den` is a variable and `b` a constant). Fixed → equality; range → one inequality per bound; target → deviation variables `d⁺, d⁻` with `(num − t·den)/den_est = d⁺ − d⁻`, cost `weight·(d⁺ + d⁻)`. Quantities: `wcm = Wf/B`, `binder`, `cement`, `water` (free), `sand_ratio` (mass or volume), `agg_share`, `agg_kg`, `paste_l = 1000(1 − ΣV)`, `fm_combined = Σm_j·FM_j/Σm_j`, `passing_pct` at a sieve, `fresh_density`, `max_cost`, Shilstone CF/WF, `fines_max_pct`. Enumerated characteristics: `scm` (product and %), `admixture` (product and level or %), `air_pct`, `nmas_mm`; `slump_mm`, `extra_margin_mpa`, `fcr_mpa` act on the request/strength.

The engineering ceiling `E:wcm_ceiling` **yields to an explicit user choice** that pins w/cm above it (a fixed or minimum w/cm, or a fixed binder with a fixed free water); the code limit `C:wcm_limit` never yields. The candidate then carries `MODEL_PREDICTS_SHORTFALL`. A fixed or ranged water replaces `E:water_demand`; below the model estimate it is `USER_OVERRIDE`.

## Objective

`cheapest`: minimise `Σ cost·quantity + Σ weight·deviation`. `closest_to_targets`: stage 1 minimises `Σ weight·deviation`; stage 2 minimises cost subject to deviation ≤ stage-1 optimum (+10⁻⁶ relative). Costs are delivered JOD/kg from the price in force; the final cost is recomputed in exact decimals by the evaluator.

## Degrees of freedom and conflicts

DoF = free quantities (B, W, one V per aggregate) − equalities (the volume balance plus every Fixed characteristic): positive = free, 0 = fully specified, negative = over-specified. If no configuration is feasible, a phase-1 LP gives slack only to the USER rows (rows normalised so a unit of slack means the same everywhere) and the report names each characteristic with the distance (in its own unit) to a value that works. If it is still infeasible with every USER row released, the binding hard rows are named with no saving. Hard rows are never given slack in a candidate.

## Interpretations the engineering team must confirm

1. **Maximum size D_max** = the smallest ASTM E11 sieve above the NMAS; grading sieves = ASTM sieves from 0.15 mm up to (not including) D_max. The 0.45-power curve is the target; the ASTM C33 limits act per aggregate.
2. **Workability-factor adjustment** is one-sided, subtracting `pts` per `per_kg` of binder above `above_kg` (the seed key says "above").
3. **Fines cap** = combined % passing 75 µm of the aggregate blend (the seed key `eng.fines.max_pct_75um`).
4. **Individual grading limit format** (`grading.fine.limits`, `grading.coarse.limits`): a list of `{ sieve_mm, min_pct, max_pct }`; the coarse list applies to every coarse aggregate (the test schema has no size number).
5. **Shilstone WF bounds** may be one number or a table keyed by NMAS.
6. The ACI 211.1 w/c baseline ends at f′cr 40 MPa; beyond it the request is blocked.
