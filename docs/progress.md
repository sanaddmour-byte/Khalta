# Progress log

## 2026-10-01 — M0.1 Repo and tooling

**Changed**

- pnpm workspace + Turborepo (`apps/api`, `apps/web`, `packages/{engine,validator,rules,db,ui}`, `tools/*`); exact versions pinned via a pnpm catalog (TypeScript 6.0.3, because typescript-eslint 8.71 supports `<6.1`).
- Strict TS base config, ESLint 10 flat config, Prettier (spec docs and `CLAUDE.md` are excluded so they stay verbatim).
- Local ESLint plugin `@khalta/eslint-plugin` with `no-hardcoded-ui-strings`, `no-physical-css`, `validator-isolation`, each with RuleTester tests including bypass attempts.
- `tools/boundaries`: dependency-cruiser rule forbidding any path from `packages/validator` to `packages/engine/src/optimizer` (catches barrel re-exports), tested on good/bad fixtures. Part of `pnpm lint`.
- Minimal API (`GET /health`, pino) and web placeholder; Vitest everywhere (engine/validator coverage thresholds 90%); Playwright + axe smoke; `pnpm screens` captures the placeholder AR/EN × 1440/1024/390 (identical until the language toggle exists in M0.3).
- CI workflow, `docker-compose.yml` (Postgres 17), `.env.example`, stubs for `db:migrate`, `db:seed:demo`, `fixtures:export`.

**Commands run (all exit 0):** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:rules`, `pnpm e2e` (1 test, 0 serious axe violations), `pnpm screens` (6 screenshots in `docs/screens/M0.1/`).
Also verified by temporarily adding violating files: lint reported all three custom rules, and depcruise reported the validator→optimizer path; the files were removed.

**Verification note:** tests prove the tooling enforces the three policies and the command contract runs. They say nothing about concrete engineering. Coverage thresholds are trivially met by placeholder code.

**Notes / open items**

- Context7 MCP not available in this session; versions were taken from the npm registry. Library docs should be read before each library's first real use.
- `esbuild` build script is not approved in pnpm (tsx works without it so far); revisit if `pnpm dev` for the API misbehaves.
- Docs formatting: markdown under `docs/plans` is Prettier-formatted.

**Next:** M0.2 (database, auth, RBAC, audit) — write `docs/plans/M0.2.md` and list questions.

## 2026-10-01 — M0.2 Database, auth, RBAC, audit

**Changed**

- `packages/rbac` (new): roles, capabilities and the role × capability matrix from `01-domain.md` §10 (plus `audit.read`), plant-scope rules, and the four-eyes guard. Pure and dependency-free so the web app can reuse it.
- `packages/db`: Drizzle schema (tenants, users/sessions/accounts/verifications, plants, user_plants, suppliers, tenant_settings, audit_log), migrations `0000_foundation` and hand-written `0001_integrity_triggers` (append-only `audit_log`; DELETE rejected on business tables), `withAudit`, `assertFourEyes`, migrator.
- `apps/api`: Better Auth (credentials/sessions only; only `sign-in/email`, `sign-out`, `get-session` are reachable), authenticate middleware (role/tenant/plants/settings loaded from our tables per request), `ApiRoutes` helper (audited mutations + OpenAPI), routes for `/api/me`, users, plants, settings, audit, config validation, pino with credential redaction, first-admin bootstrap, `seed:dev`.
- Test database: `tools/test-db/start.sh` starts a throwaway local PostgreSQL (no Docker needed); CI uses a Postgres service. A migrated template database is cloned per test file.
- ADRs 0001 (tenancy), 0002 (auth/session), 0003 (audit). Lint rule against hard deletes on business tables. CI: Postgres service + `pnpm db:drift`.

**Commands run (all exit 0):** `pnpm typecheck` (10/10), `pnpm lint`, `pnpm test` (rbac 133, api 52, eslint plugin 43, boundaries 2, …; api coverage ≈97% statements), `pnpm test:rules`, `pnpm e2e`. Also ran the real server against a fresh database: migrate → `seed:dev` → sign in → `/api/plants` worked.

**Defects found by the tests and fixed:** unique-constraint violations returned 500 (Drizzle wraps the Postgres error); pg pool had no `error` listener (an idle-client termination would crash the process); request logs contained the session cookie (now redacted, with a test).

**Verification note:** tests prove the access-control matrix, plant scoping, tenant isolation, audit completeness/atomicity/append-only behaviour, soft delete, four-eyes locking and the auth flows _as implemented_, against a real PostgreSQL. They do not prove that the role matrix is the right business policy (Sanad should confirm §10), nor that production database roles are locked down (the audit triggers can be dropped by a table owner; M6.2 runbook must run the app as a limited role).

**Notes / open items**

- Better Auth docs site was unreachable from the sandbox (egress proxy); configuration was derived from the installed package's types and source and verified by tests. Re-check against the docs when network allows.
- Four-eyes is tested with `plants` as a stand-in record; the real design/attestation endpoints arrive in M4.1.
- Sign-in/out events are not audited yet; self-service password change and email reset are deferred (no email provider).
- `users.email` is globally unique (Better Auth looks users up by email); noted in ADR 0001.

**Next:** M0.3 (design system and app shell) — write `docs/plans/M0.3.md` and list questions.

## 2026-10-01 — M0.3 Design system and app shell

**Changed**

- `packages/ui`: tokens (light/dark, text-safe status variants), 20+ wrapped Radix components with logical CSS only, domain chips (`StatusChip`, `CodeBadge`, `EvidenceChip` closed set of the nine evidence statuses, `SavingStateLabel`), `Ltr` bidi wrapper, `CommandPalette`, number/date formatters (Western digits default, Arabic-Indic opt-in, Asia/Amman), glossary (20 spec terms exposed to i18n as `glossary.<id>`).
- `apps/web`: Vite + React 19 + Tailwind v4 + TanStack Router/Query, i18next (EN/AR) with `lang`/`dir`/Radix `DirectionProvider`, theme (system/light/dark) and density preferences stored locally, sign-in, session guards, role-aware sidebar (derived from `@khalta/rbac` capabilities), plant switcher, Ctrl/Cmd+K palette (search works across both languages), notifications placeholder, user menu, eleven teaching placeholder sections, `/dev/components` (LTR and RTL panels; development builds only, verified absent from the production bundle).
- API: `/api/me` now also returns `settings.numberFormat` (tested).
- `docs/i18n-review.md`: 152 drafted strings awaiting native review.

**Commands run (all green):** `pnpm typecheck`, `pnpm lint`, `pnpm test` (ui 114, web 16, rbac 133, api 52, …), `pnpm test:rules`, `pnpm e2e` (37 tests: sign-in/out, nav per role ×7, RTL mirroring, menus and drawer at the end/start edge, palette in both languages, theme persistence, axe on shell/sign-in/gallery in EN/AR × light/dark plus open overlays: zero serious violations), `pnpm screens` (30 screenshots in `docs/screens/M0.3/`, AR/EN × 1440/1024/390 + dark + open states).

**Quality-gate review (screenshots read one by one) — defects found and fixed**

- Colour-token swatches rendered blank (`@theme inline` does not emit the variables I referenced) → static utility classes.
- User-menu screenshot captured mid-fade → wait for the animation.
- A global `:focus-visible` rule was unlayered and overrode component `outline-none`, drawing a stray line in the palette input → moved to `@layer base`, explicit inset ring on the palette input.
- Radix modal dropdown aria-hid the whole app (axe `aria-hidden-focus`) → dropdown menus are non-modal.
- `useLogicalAlign` flipped menu alignment a second time (floating-ui `start`/`end` are already direction-aware) → removed; menus verified at the end edge in both directions.
- The dev gallery chunk was still emitted in production builds → route created inside the DEV condition; verified absent.
- Test helper overwrote saved preferences on every reload, hiding that persistence works → seeds defaults only.

**Deviation from the spec to confirm (Sanad):** the spec's own palette fails its own ≥ 4.5:1 rule for status text in light mode (e.g. `--warn` on `--warn-bg` is 3.3:1, `--pass` on `--pass-bg` 3.9:1, `--olive-600` on `--olive-100` 4.1:1; dark `--fail` on `--fail-bg` 4.45:1). The spec values are kept for fills, icons and borders (≥ 3:1 verified); added darker/lighter `--pass-text`, `--warn-text`, `--fail-text`, `--olive-text` for text. Also derived `--on-primary` and `--on-olive` (not in the spec table). All pairs are checked by `packages/ui/test/contrast.test.ts`.

**Verification note:** tests prove the shell renders and behaves correctly in both directions, contrast and axe pass, and nav visibility matches the role matrix. They do not prove the Arabic wording is idiomatic (see `docs/i18n-review.md`), that the layout suits plant-floor tablets, or that Arabic typography is right in every case: I reviewed the screenshots myself and found no clipping or mirrored numbers/codes, but a native reader should look.

**Notes / open items**

- Production bundle is ~655 kB (≈ 215 kB gzip): i18next-icu/intl-messageformat and Radix dominate; code-splitting by route is deferred until real screens exist.
- date-fns is not used: `Intl.DateTimeFormat` with `timeZone: 'Asia/Amman'` covers the display rule.
- Better Auth rate limiting is off under `NODE_ENV=test` (used by e2e); on in development and production.
- The web build is not yet served by anything in production (decided in M1.3 with the Railway deploy).

**Next:** M0.4 (rules package) — but see the pending Addendum A1 (user-provided characteristics, feature manifest), which changes later milestones and needs approval of its Part 0 amendments first.

## 2026-10-01 — M0.4 Rules package (F-003, F-004)

**Changed**

- `packages/rules`: full rule schema (kinds, seven classes incl. `USER_SPECIFIED`, closed unit list, tables with bin/numeric rows, fractions, `inherits`), YAML loader, **26 seed files / ~140 rules** (ACI from `02-codes.md` §4, shared mappings, a Jordanian skeleton with every key `null`, engineering parameters), `lookupTable` (linear, never extrapolates, no invented policy between bins), applicability (three-valued), merge per kind, **resolver** (ACI / JS / BOTH, project overrides tighten-only, provisional on one-sided gaps, table policy, `approvalBlockers`).
- `packages/db`: migrations 0002–0003 (rulesets, rules versions, append-only `rule_verifications`, import batches; triggers: content immutable, no delete, verified needs a value).
- `apps/api`: rules service (`syncRules`, `supersede`), CSV import (preview stored immutably, all-or-nothing commit, stale-preview check), routes (`/api/rules`, detail with history, verify with typed note + four-eyes, correct value, import preview/commit, `/api/rules/resolve`), new capability `rules.read` (admin, QC manager, QC engineer), `rules:sync` / `rules:export-seed`, server syncs seeds on start.
- `apps/web`: Rules screen (banner, filters, grouped table, detail sheet from the end edge, table-grid viewer, verify and correct dialogs, import with validation preview, engineering tab), responsive layout, AR/EN.
- `tools/features-check` + `pnpm features:check` (Addendum A1 follow-up), `templates/js-rule-values.csv`, ADR 0004.

**Commands run (all green):** `typecheck` (11/11), `lint`, `test` (rules 159, api 84, rbac 140, web, ui, features-check, …), `test:rules` (143), `e2e` (51, incl. 14 for the Rules screen, axe EN/AR × light/dark on list, sheet and dialog), `screens` (40 in `docs/screens/M0.4/`), `db:drift`.

**Defects found by tests/review and fixed:** jsonb reorders object keys, so seed drift and "unchanged" checks gave false results (canonical comparison); `info` rows (C2 cover) counted as "missing" and would have blocked approval forever; PATCH could blank a value (now rejected); edits create a new row id, which closed the open detail sheet (open rule tracked by ruleset+key); a `<dl>` with nested wrappers failed axe; the status column was pushed out of view at 1024 px and below, chips wrapped in Arabic, raw units (`kg/m3`) in the sheet, table shape numbers reversed in RTL.

**Verification note:** tests prove seeds equal the tables in `02-codes.md`, the resolver implements the documented semantics (properties hold over generated inputs), versions/verification/four-eyes cannot be bypassed (also at the database level), and import is all-or-nothing. They do **not** prove any value matches ACI 318-19/301/211.1/C94/305.1 or the Jordanian code; every rule is unverified until a QC manager checks it. Seed `note_ar` strings are my drafts and need a native review (not yet in `docs/i18n-review.md`, which covers UI strings only).

**Findings to confirm (Sanad)**

- 79 rule values are not on file: the Jordanian skeleton (all), ASTM C33 grading limits (ACI/JS), and the air-entrained design aids. Both/JS mode runs provisionally on ACI and **cannot approve** until JS values are imported and verified.
- `strength.basis_map`: C30/37 keeps B350 and B375 as unresolved candidates (B-grade input for C30/37 stays blocked).
- API error messages (e.g. CSV preview) are English even in the Arabic UI; the native file picker text is the browser's.
- `rules:export-seed` writes `verified: false` always.

**Next:** M1.1 (materials and tests, with F-007 material characteristics entry) — write `docs/plans/M1.1.md` and list questions.

## 2026-10-01 — M1.1 Materials and tests (F-005, F-006, F-007)

**Changed**

- `packages/engine` (pure): sieve parsing (ASTM/ISO labels, µm, Arabic digits), gradation validation (six error codes), fineness modulus from the configured series (infers 0 % / 100 % retained only where the data forces it, otherwise names the missing sieves), Excel paste parser (row pair or two columns, header detection, decimal commas, returns its assumptions), per-category property schemas, minimum sets per workflow (07 §2.2), freshness (a missing limit is "not configured", never "fresh"), drift (null tolerance reports the raw delta only), warn-only sanity ranges, ad-hoc material schema.
- `packages/db`: migrations 0004–0005 (`materials`, versioned `material_tests` with per-field provenance, `attachments`; suppliers gain contact fields). Triggers/constraints: no hard delete, test content immutable, attachments append-only, one current test per material, a `lab_report` needs its attachment, a declared record needs its author, 10 MB cap.
- `packages/rbac`: `materials.read`, `materials.write`, `suppliers.write` (matrix and spec table updated).
- `packages/rules`: seed `eng.fm.sieves` and null `eng.drift.tolerance.*` parameters.
- `apps/api`: `/api/suppliers`, `/api/materials` (list, detail, create, patch, soft delete, params, readiness, promote), `/api/materials/:id/tests`, `/api/attachments` (raw upload, signature-checked PDF/PNG/JPEG, authorized `attachment` + `nosniff` download). New `ApiRoutes.upload`/`file` helpers (audited, in the OpenAPI doc). Settings gain `sanityRanges` and `approvalRequiresLabSource`; `/api/me` exposes the sanity ranges. Dev seed adds four materials labelled SYNTHETIC.
- `apps/web`: Materials (list, detail sheet, quick-entry with paste gradation, live FM, tiered fields, source/reason/attachment rules, offline-safe local drafts cleared at sign-out, ECharts gradation curve on a log axis never mirrored in Arabic with a table alternative, trend sparklines, drift/freshness/source chips, "attach a report to declared values" upgrade), Plants, Settings (general + Users). `EvidenceChip` now covers the twelve statuses (adds `INPUT_USER_DECLARED`, `USER_OVERRIDE`, `MODEL_PREDICTS_SHORTFALL`).
- `docs/i18n-review.md`: 231 more drafted Arabic strings.

**Commands run (all green):** `typecheck`, `lint`, `test` (engine 37, rbac 161, rules 159, ui 120, web 25, api 106), `test:rules` (143), `features:check`, `e2e` (60, incl. 9 new: F-007 flows, lab-report needs file, upgrade keeps both versions, drafts survive reload, sanity warnings, plant manager cannot create, Arabic chart not mirrored, plants/users/settings, axe on the new screens EN/AR), `screens` (`docs/screens/M1.1/`, 41 images + dark), `db:drift`.

**Defects found by tests/review and fixed**

- Fineness-modulus inference had the sieve direction reversed (a sand entered from 9.5 mm down could not compute); caught by the hand-calculated test.
- The first versioning logic treated "same values, better source" as "nothing changed", which would have blocked the declared→lab upgrade; a source change now counts as a change.
- i18n used ICU single braces while my first strings used `{{x}}`; all fixed.
- Materials table overflowed at 1024 px and wrapped dates; secondary columns now hide by breakpoint and the table scrolls.
- Chart axis labels collided at the fine end; trend cards no longer show for a single test.
- Two older e2e specs were racy/brittle (lazy gallery chunk; fixed plant count) and now wait/derive.

**Verification note:** tests prove FM arithmetic, gradation/sanity/readiness rules, provenance and versioning, plant scoping, attachment checks and database integrity as implemented. They do **not** prove the FM sieve series, sanity ranges, age limits or drift tolerances are the right engineering policy (age limits and tolerances are deliberately unset), nor that entered lab values are true. Arabic wording and tablet ergonomics need your review.

**Open items / notes**

- Ad-hoc promotion (F-007 AC4) is covered by the API only; its UI arrives with the Studio. A promoted material's price is returned, not stored (prices are M1.2).
- `approvalRequiresLabSource` is stored but enforced only when approvals exist (M4.1).
- Material rename/archive UI is not built (API exists and is tested).
- Main bundle ≈ 884 kB (was 655 kB); the chart is a separate lazy chunk (≈ 495 kB). Route-level code splitting is deferred.
- At 390 px the materials table scrolls horizontally in Arabic; acceptable for now.
- `06-features.md` statuses left for you to flip.

**Next:** M1.2 (price matrix) — write `docs/plans/M1.2.md` and list questions.
