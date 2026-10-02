# ADR 0010 — Characteristic profiles: layering, immutable versions, four-eyes approval

Status: accepted (2026-10-02, approved with the M3.3 plan defaults)

## Context

Plants repeat the same preferences (sand ratio band, excluded materials, default objective) request after request. Typing them each time is slow and drifts; silently remembering them would be a hidden assumption. The safety contract applies: user characteristics tighten and never loosen `CODE_HARD` or `PROJECT_HARD`; no silent assumptions; humans approve; evidence and origin stay visible.

## Options

| Option                                                        | For                                             | Against                                                 |
| ------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| A. Per-user saved forms                                       | Trivial                                         | Not shared, not reviewed, no history                    |
| B. Mutable shared profiles                                    | Simple                                          | A past design's inputs change under it; no review trail |
| C. Versioned profiles, immutable versions, approval, layering | Reproducible requests; reviewed; origin visible | More machinery (versions, matching, approval)           |

## Decision

1. **Option C.** A profile (`characteristic_profiles`) has a scope — company, plant or product family — and immutable versions (`characteristic_profile_versions`: applies_to, characteristics, materials, objective, rule-set mode, per-exposure check). A trigger refuses to change a stored version's content, to delete versions or profiles, or to flip `approved` back.
2. **Layering:** company → plant → product family → the request. Each layer is merged with `mergeLayers`; the request's own rows always win and are labelled. The hard-limit checker runs on the **merged** result, so no layer, and no combination, can loosen a code or project limit. Every resolved row carries its origin (`profile:<id>@<version>` or `request`), stored on the design request with the exact versions used.
3. **Matching:** a profile matches on its optional `applies_to` fields (f′c range, exposure, pumpable, placement, season) and, for families, the free-text label. Several matches at one scope: the narrowest wins; a tie is shown and the user chooses. A plant profile is visible and usable only at its plant.
4. **Approval is four-eyes:** QC engineers and managers draft; only a QC manager approves; the author never approves their own version (API check and a database CHECK `profile_version_four_eyes`). Editing an approved profile creates the next version as a draft; the approved version stays in force.
5. **Approval is blocked** while any exposure the profile covers would be rejected by ACI/JS; the rejected combinations are listed on the version (`check`).
6. **Drafts** may be used for evaluations, drafts and previews, but never for trial-candidate generation (the Studio disables Generate and the API refuses).
7. **Usage:** older-version designs are listed on the profile and through the API; a revalidation inbox item is M5.1.

## Consequences

- A design request can be reproduced from its stored snapshot even after a profile changes.
- Profiles are only as good as their reviewers; the Profiles screen shows the per-exposure check, the diff against the previous version and how many designs use the profile.
- Placement and season are summary labels on a request, not engineering inputs: a profile can restrict itself to them, nothing else reads them.
