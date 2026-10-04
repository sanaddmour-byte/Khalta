# ADR 0019 — The admin works the whole design cycle, but never signs it off

Status: accepted (2026-10-04, decided by Sanad)

## Context

The first admin could manage users, plants, settings, prices and imports, but could not see Design Studio, enter materials or tests, request trials or export CSV, so it could not follow a mix through its cycle.

## Decision

The admin also holds `design.write`, `trial.request`, `lab.enter`, `materials.write`, `suppliers.write`, `insight.draft` and `export.csv`: it can build materials, run Studio, evaluate, save drafts, request trials, enter lab results and export CSV. It does **not** hold the sign-off capabilities: `trial.pass`, `design.approve`, `design.attest`, `rules.verify`, `profile.approve`, `candidate.authorize`, `baseline.create`, `production.release`, `insight.accept`. Those stay with the QC Manager (and plant managers for production release), so a signature and an approval always name a QC role. The four-eyes rule is unchanged.

## Consequences

An admin who authors a draft still needs a QC Manager to pass the trial and approve it. The test matrix (`packages/rbac/test`) states the sign-off list explicitly.
