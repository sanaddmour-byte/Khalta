# ADR 0021 — Versioned project requirements, frozen into each design version

Status: accepted (2026-10-04)

## Context

`ACI / JS / both` says which code applies. A project adds a specification: standards and editions, a strength designation and how it is judged, exposure, material restrictions, and its own governing limits. These were typed per request and not versioned.

## Decisions

1. **A `project_requirements` row per revision** (`project_ref`, `revision`, validated `content`, hash). A draft can be edited; **verification** by a second person (`rules.verify`, e-signed, four-eyes enforced by the API and a database trigger) freezes it; a change is a new revision that supersedes the old one on verification. Verified content is immutable; rows are never deleted.
2. **Designs freeze a verified revision** at creation (`requirements_revision_id` + a copy `requirements_frozen`), immutable with the version. A draft or superseded revision cannot be frozen. A new version of a design takes the project's current verified revision.
3. **Only comparable limits are compared.** `resolveGoverningLimits` chooses the stricter of limits with the same key, direction, unit **and test basis** (specimen, age, method). Limits that differ in any of those are reported as `incompatible` and nothing is chosen; verification is refused until they are restated on a common basis. No conversion between specimens, ages or units is guessed.
4. **Project limits reach the evaluation as `projectOverrides`** (the existing tighten-only path, which rejects an override that loosens a code limit). Code and approved-internal limits stay in the rules.
5. **Gates.** Approval and release carry a `project_requirements` gate: a design whose frozen revision was superseded must be re-versioned. A tenant setting `requireProjectRequirements` (default off; a safety-relevant key) makes a missing revision block approval and release.
6. **Release record.** The transition evidence stores the design version hash, plant, every material's test version at that moment, the requirements revision (id, reference, number, hash) and the releasing authority.
7. **Infeasibility classes.** Conflicts and blockers carry one of: code requirement, project requirement, approved internal requirement, user preference, material availability, missing evidence. Only a user preference is `adjustable`; the Studio shows a release control for nothing else.

## Not done here

Material restrictions and permitted substitutions are stored and verified but not yet enforced by the optimizer's material pool (see the readiness matrix). Legacy designs have no revision recorded; they are classified "none recorded", not backfilled.
