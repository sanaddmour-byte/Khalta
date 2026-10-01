# ADR 0004 — Rule normalization and Both-mode conflict handling

Status: accepted (M0.4)

## Context

Code values (ACI, Jordanian JS, later EN 206) must be data with provenance, merge predictably in "Both" mode, accept project overrides that can only tighten, and block approval while any value is unverified or missing.

## Alternatives

1. **Hard-code limits in the engine.** Fast, but values become invisible to QC, cannot be verified, and cannot add a ruleset without code.
2. **One flat key/value table.** Simple, but exposure-class applicability, tables, sets and tolerances do not fit, and Both-mode merging becomes ad-hoc per key.
3. **Typed rules with a `kind` that drives merging, a `requirement` that groups rules, explicit applicability, versioned rows and a resolver (chosen).**

## Decision

- **Rule = key + requirement + kind + class + applies_to + value/definition + units + clause + verified.** `requirement` is the quantity (e.g. `max_wcm`); many rules (one per exposure class, per code) feed one requirement. `kind` (limit_max, limit_min, allowed_set, prohibition, range, tolerance, table, value, parameter, info) fixes the merge. Units come from a closed list.
- **Applicability is explicit and three-valued** (applies / does not / undetermined). A rule whose condition names a field the request lacks (e.g. S3 without an option, a slump tolerance without a slump) yields a named `context_missing` blocker; it is never guessed.
- **Merge** (within a code across exposure classes, then across codes in Both mode): lower of limit_max/tolerance, higher of limit_min, union of prohibitions, intersection of allowed sets and ranges (empty means infeasible with a reason). `table`/`value`/`parameter` are never auto-merged: identical values pass, different values need a policy (`tablePolicy`) or the requirement is blocked. `info` rows are listed, never constraints, never "missing".
- **Missing is never evidence the other side suffices.** If one code has no value, the other drives a **provisional** result flagged `other_side_missing`; approval stays blocked.
- **PROJECT layer is tighten-only.** Overrides are compared with the resolved base per kind; a looser value is rejected and the result names the code limit, its source and clause. Only limit/tolerance/prohibition/set/range kinds are overridable. `isTighterOrEqual` is exported so the characteristics layer (Addendum A1, M2.1) reuses the identical rule.
- **Approval gate:** `approvalBlockers` lists every contributing rule that is unverified or null (selected sources only), and every requirement that is provisional or blocked.
- **Versioning:** each edit inserts a new version (unverified) and supersedes the old one; a database trigger rejects in-place content changes, so a verified value can never be silently altered. Verification history is append-only. Verification applies to one version and requires a typed note.
- **Seeds vs database (Q1):** seeds are the initial state. After first sync the database is authoritative; `syncRules` inserts missing keys only and reports drift; `rules:export-seed` writes the database back to YAML (always `verified: false`) for a reviewed commit.
- **JS values arrive as data:** skeleton rows with `value: null` and `inherits: "ACI:<key>"` as an explicit, separately verified reference.
- **A third ruleset (EN 206)** is added with seed files only (proven by a loader test); `CODE_RULESETS` lists the codes Both mode merges.

## Evidence

`test:rules` (schema, loader, 55 cross-checks of every seeded number against the tables in `02-codes.md`, resolver examples per kind, fast-check properties: Both never looser than either code, PROJECT never looser than the base, order independence); API tests for verification, four-eyes, immutability triggers, CSV import and tenant isolation.

## Risks

- A seed can match `02-codes.md` and still differ from ACI/JS: only QC verification against the licensed documents can catch that. Tests never set `verified`.
- Applicability conditions are matched against a free-form context; typos in a seed `applies_to` are caught by the cross-check tests, not by the schema. A later milestone may type the context.
- Both mode has no policy yet for two conflicting tables; it blocks and asks.

## Reversal path

The resolver is pure and independent of storage; replacing the database model does not change its contract. Rule versions keep their full history, so moving to another store is an export.
