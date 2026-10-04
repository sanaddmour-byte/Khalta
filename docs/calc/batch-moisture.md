# Batch preparation: moisture correction, rounding and reconciliation — calculation basis

Status: **derived and tested; awaiting engineering confirmation** (a QC engineer must confirm the formulas below against the plant's own procedure before production use).

## 1. Definitions (all masses per m³ of concrete)

| Symbol   | Meaning                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `M_ssd`  | Design mass of an aggregate, **saturated surface dry** (what the evaluator and the approved design hold)                  |
| `A`      | Absorption, % of oven-dry mass (from the aggregate's test)                                                                |
| `T`      | Total moisture, % of oven-dry mass (the reading entered for the day)                                                      |
| `M_od`   | Oven-dry mass                                                                                                             |
| `M_wet`  | Mass to weigh at the batcher (what the stockpile weighs)                                                                  |
| `W_free` | Free (surface) water carried by the aggregate; negative when the aggregate is drier than SSD and will absorb mixing water |
| `W_d`    | Design free water (SSD basis)                                                                                             |

## 2. Formulas

```
M_od   = M_ssd / (1 + A/100)
M_wet  = M_od × (1 + T/100)  =  M_ssd × (1 + T/100) / (1 + A/100)
W_free = M_wet − M_ssd       =  M_od × (T − A)/100
W_batch = W_d − Σ W_free  [ − Σ admixture solution water, only when the plant opted in ]
```

Cement, SCMs, fibres and pigments are weighed as designed. An admixture's solution water is counted only under the tenant opt-in (the convention differs by product).

**Mass balance.** Σ(batch masses) = Σ(design SSD masses) − (solution water subtracted). The pure conversion returns the residual; the independent validator recomputes it with different arithmetic (`wet = SSD × (1+T)/(1+A)`, `free = wet − SSD`).

## 3. Why these are the right formulas

- They keep the **oven-dry** aggregate content equal to the design's, which is how the Portland Cement Association's _Design and Control of Concrete Mixtures_ makes moisture adjustments (its adjustments are based on oven-dry masses), and they treat "total moisture = free moisture + absorption", so that the SSD design total and the batch total agree. Sources consulted (secondary; the standards' own text was not available in this environment): [PCA: Design and Control of Concrete Mixtures](https://www.concrete.org/publications/internationalconcreteabstractsportal/m/details/id/13199); [Montana DOT materials manual, SSD design and field moisture correction](https://ftp.mdt.mt.gov/other/webdata/external/materials/materials_manual/119.pdf).
- Physical checks that the tests enforce: `T = A` gives `M_wet = M_ssd` and `W_free = 0`; a drier aggregate (`T < A`) gives a negative `W_free`, so **more** water is added; the batch masses sum to the design masses.
- Absorption and total moisture are never conflated, and wet mass is never labelled SSD.

## 4. Readings and when they block

A reading is required for every aggregate in the design. Production export and batch saving are **blocked, with a named reason**, when: the QC limits `eng.moisture.max_total_pct` or `eng.moisture.stale_hours` are not on file; a reading or the aggregate's absorption is missing; a reading is negative, above the limit, in the future, or older than the stale limit. **The reading is judged again at export time**, not only when it was saved.

## 5. Batch size, equipment resolution and rounding (new)

`weigh_kg(line) = corrected_kg_per_m3 × batch_size_m3`, then rounded **to the equipment resolution of that line's category**:

```
rounded = round_half_up(weigh_kg / resolution) × resolution        (resolution > 0)
rounding_error = rounded − weigh_kg
deviation_pct  = |rounding_error| / weigh_kg × 100
```

Nothing is assumed: the resolutions (`eng.batch.resolution_kg.<category>`), the largest permitted rounding deviation (`eng.batch.max_rounding_deviation_pct`) and the largest batch (`eng.batch.max_size_m3`) are **configurable engineering parameters that ship empty**. A production batch plan cannot be saved, and a production export is refused, until QC has entered them. Rounding to the nearest resolution is the only mode implemented; a different approved rule would need a new, versioned convention.

**Reconciliation.** For every line the plan records design (SSD) kg/m³, corrected kg/m³, exact weighing mass, rounded mass, and error. It also records the total design mass × batch size, the total rounded mass, and the water balance. A plan whose any line exceeds the permitted deviation, or whose rounded totals differ from the exact totals by more than that deviation, is refused.

## 6. Binding

A saved plan is bound to: the design id, version and **version hash**; the plant; the current test version of every material used; every moisture reading (with source and time); the calculation version; the preparer; and the rounding parameters in force. A later change to the design or to a material test does not alter a saved plan, and an export checks the design's hash again.

## 7. Outstanding engineering input

Confirmation of the formulas against the plant's procedure; the resolution of each weigh hopper; the approved rounding tolerance; the largest batch; the moisture limits. None is invented here.
