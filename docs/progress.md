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

## 2026-10-01 — M1.2 Price matrix (F-008)

**Changed**

- `docs/adr/0005-spreadsheet-grid.md`: hand-built ARIA grid with TanStack Virtual (TanStack Table adds nothing for a fixed matrix); AG Grid and Glide rejected (Enterprise-only range/clipboard; canvas vs Arabic/axe).
- `packages/engine` (pure): exact decimal arithmetic, `toJodPerKg` (per kg, per ton, per litre via SG; `JOD/m3` and missing SG return a named "not convertible", never a guess), `priceAt` (period in force, preferred supplier, "ambiguous" and "unavailable", never zero), price staleness (unset limit is "not configured", never fresh), Asia/Amman dates, Excel paste parser (Arabic digits, decimal commas), staging model with undo/redo.
- `packages/db`: migrations 0006–0007. `material_prices` is append-only (only closing a period and superseding a same-day correction may change), live periods cannot overlap (btree_gist exclusion constraint), snapshots and their lines are append-only.
- `apps/api`: `/api/prices` (matrix with conversion, staleness, ambiguity), `/history`, set (single/block), preferred supplier, bulk % change (preview equals apply; 0 % reconfirms), copy plant, import preview/commit (all-or-nothing, stale-preview check, `.xlsx`/`.csv`, EN/AR headers), logged export, coverage, `/api/price-snapshots` (hash re-verified on read). New `ApiRoutes.mutateFile`. Dev seed adds SYNTHETIC prices.
- `apps/web`: Prices screen (sticky first column, windowed rows, inline edit, range paste, copy, undo/redo, keyboard map that reverses left/right in RTL, pending changes shown dashed, stale hatch + age text, ex-delivery/ambiguous/needs-density markers, optional median heatmap with the delta as text, history sheet with trend and supplier preference, bulk, copy, import, snapshot, export, as-of date), Materials list shows "priced at N of M plants".

**Commands run (all green):** `typecheck`, `lint`, `test` (engine 52, api 125, web 25, rbac 161, ui 120, rules 159, …), `test:rules` (143), `features:check`, `e2e` (68, incl. 8 new with axe on matrix, history, import, snapshot and bulk dialogs, EN/AR), `screens` (`docs/screens/M1.2/`), `db:drift`.

**Gate:** pasting 20 plants × 200 materials (4,000 prices) commits in **≈ 0.83 s** (budget 2 s) and loads the matrix in ≈ 0.1 s on the test database; history is never overwritten (tested at the database level).

**Defects found by tests/review and fixed:** Drizzle expands array parameters, so the bulk close/supersede used a JSON recordset; an audit entry was missing for a no-op request (every request now leaves one); a `jod_` column had to be `numeric` (platform test); the edit input committed twice (Enter then blur) so one undo left the cell pending; stale-hatch text failed contrast (lighter hatch, heading-coloured age text); a bulk or import row dated before a later scheduled price is now an error in the preview, not a surprise at commit; bidi garbling of names/dates in the Arabic history sheet; two earlier e2e specs assumed fixed plant counts or lazy chunks.

**Verification note:** tests prove storage, history, conversion and workflow as implemented. They do **not** prove the prices are right, that your suppliers' prices are delivered or ex-works as flagged, or that the stale-price limit (unset) is the right policy. Scoped roles (Procurement, Plant Manager) see one plant at a time through the plant switcher.

**Open items:** `JOD/m3` prices stay "not convertible" until you provide bulk densities; the haul cost is not added to ex-works prices; the 15-minute "affects N approved designs" banner arrives with M5.1; Arabic strings are drafts in `docs/i18n-review.md`; the grid supports click/shift-click selection (no drag-select yet).

**Next:** M1.3 (demo data, legacy import, staging) — write `docs/plans/M1.3.md` and list questions.

## 2026-10-02 — M1.3 Demo data, legacy import, staging prep (F-009)

**Changed**

- `packages/engine` (pure): Arabic-first name normalization (diacritics, tatweel, alef/ya/ta-marbuta, digits) and Dice similarity used only to **order** suggestions; `matchMaterial` pre-selects only an exact normalized same-category match; Appendix D long-format parser/validator with header aliases (EN/AR); litres→kg through SG with exact decimals.
- `packages/db`: migrations 0008–0009: `mix_designs` (inputs immutable by trigger, status/approval bookkeeping only), `mix_design_lines` and `design_transitions` (append-only), `production_volumes`, `legacy_import_batches`; check constraints: legacy-attested needs reference + approver + date, approved/in-production needs an approval source.
- `apps/api`: legacy import (upload → re-runnable mapping/matching/validation preview → all-or-nothing, single-use commit; created materials flagged and test-less), `/api/designs` (list, detail, attestation queue), `POST /api/designs/:id/attest` (QC Manager, **four-eyes**, typed note; approved or in production, transitions recorded). Demo generator `pnpm db:seed:demo` is an **HTTP client of the app's own API** (deterministic PRNG; two QC managers; idempotent; refuses production unless `KHALTA_ALLOW_DEMO_SEED=1`). Web app served from the API (ADR 0006); `TRUST_PROXY`, `KHALTA_DEMO` flag in `/api/me`.
- `apps/web`: Imports wizard (columns → materials → review → import), Library (list, attestation queue, detail sheet with original and kg quantities, warnings, history, attest dialog), demo banner.
- Ops: `Dockerfile`, `.dockerignore`, `railway.json`, `docs/runbooks/staging.md`, `pnpm smoke:staging`, `templates/legacy-mix-designs.csv`, ADR 0006.

**Commands run (all green):** `typecheck`, `lint`, `test` (engine 65, api 145, web 25, rbac 161, ui 120, rules 159, …), `test:rules` (143), `features:check`, `e2e` (72, incl. 4 new: wizard with exact/unresolved/create decisions, importer refused then second QC manager attests with the legacy label, viewer read-only, Arabic RTL + axe), `screens` (`docs/screens/M1.3/`), `db:drift`.

**Verified locally:** a production-mode server (`NODE_ENV=production`, built web app via `WEB_DIST_DIR`) passed `pnpm smoke:staging` (health, app, client-route fallback, anonymous API guard, sign-in, `/api/me`, rules, materials); the demo seed ran against it (19 materials, two price waves, two snapshots, 6 legacy designs, 4 attested, 36 volume rows). Round trip: designs read back from the library equal the source file's lines.

**Not done: the Railway deploy.** Per your default I will not create or change anything on Railway without your yes, and I need the project/workspace and the domain. The Docker image was **not built here** (no Docker daemon in this sandbox); the first Railway build will be its first test, and any failure gets fixed before the milestone is closed. `docs/runbooks/staging.md` lists the variables and steps.

**Defects found by tests/review and fixed:** the authenticated router was catching static/SPA paths (static hosting moved before it); zod 4 `record` with an enum key requires every key (`partialRecord`); Better Auth rate limiting would treat all users behind Railway's proxy as one client (`TRUST_PROXY`); step headings like "1." reversed in Arabic; a rules axe check measured mid-fade colours (wait for the dialog animation); the screens needed a design created in their fresh database.

**Verification note:** tests prove parsing, matching rules, unit conversion, workflow states, four-eyes, immutability and deployment mechanics as implemented. They do **not** prove the legacy designs are correct or compliant, that a matched material is the physical material the plant uses, or that the demo numbers resemble real production. Imported designs show no compliance, cost or strength figure because none has been calculated; they are labelled "Legacy attested · not yet evaluated by Khalta".

**Open items / notes**

- Matching is plant-agnostic: the same Arabic name used by two plants maps to one library material per decision (the demo gives Aqaba's aggregates a place suffix). Plant-aware matching is a candidate for M2.x.
- The runtime image runs TypeScript through tsx and keeps the whole workspace (large); compilation is a M6.2 item.
- The demo seeds synthetic test-age (365 d) and stale-price (30 d) limits in the demo tenant only; the real seeds stay null.
- Arabic strings are drafts in `docs/i18n-review.md` (attestation wording first).

**Next:** your go-ahead and Railway details to deploy staging; then M2.1 (evaluator, compliance kernel, validator) — write `docs/plans/M2.1.md` and list questions.

## 2026-10-02 — M2.1 Evaluator, compliance kernel, independent validator (F-010, F-011)

**Changed**

- `packages/engine` (pure): `evaluate/` kernel (f′cr per ruleset with ACI 301 no-data equations, statistical branch built and tested but unreachable from stored data, higher governs, margin; basis conversion via `strength.basis_map`; absolute volume/yield with SSD SG and air; w/cm, binder, SCM shares, dosage; tri-state compliance checks with named blockers: max w/cm, min f′c, chlorides, SCM limits, cement C₃A class, S3 SCM, CaCl₂, air, yield, admixture range; strength adequacy and water baseline as `MODEL_BASELINE` information, never compliance; cost in exact decimals, incomplete (never zero) when a line cannot be priced; data quality; a trace entry for every figure). `characteristics/` (App. E schema, layer merge, unit normalization, rejection of loosening input with rule/clause/bound, requested vs achieved). `lifecycle.ts` (full §14.1 graph, evidence, milestone gating). Fixture format (App. B) + 5 SYNTHETIC hand-computed fixtures.
- `packages/validator`: independent second implementation (exact rationals, own table interpolation and comparison code; shares only the rules resolver and decimal helpers); any difference is a hard failure. ADR 0007; dependency-cruiser rule so the validator cannot reach evaluator calculation code.
- `packages/db`: migrations 0010–0011: `design_evaluations` (append-only by trigger), `mix_designs.needs_revalidation` and latest-evaluation columns.
- `apps/api`: `POST /api/designs/:id/evaluate`, `GET /api/designs/:id/evaluations[/:evalId]`, `POST /api/characteristics/validate`; evaluation settings (`nearLimitPct`, `safetyMarginMpa`, `yieldTolerance`); cost stripped server-side without `cost.view`; attestation now allowed from `evaluated` and enforced through the lifecycle graph; Library list gains verdict and revalidation fields.
- `apps/web`: Evaluation tab and Evaluate action in the design sheet, verdict/validator/evidence chips, revalidation chip and tab in the Library, new Settings fields, admixture `chloride_pct` field (counted in the chloride check); EN/AR strings (drafts in `docs/i18n-review.md`).

**Commands run (all green):** `typecheck`, `lint` (incl. boundaries), `test` (engine 171, validator 146, api 167, web 25, rbac 161, ui 120, rules 159), `test:rules` (143), `features:check`, `e2e` (78, incl. 6 new with axe, EN/AR), `screens` (`docs/screens/M2.1/`; every screen shot and the evaluation pass/fail views reviewed), `db:drift`. Engine coverage 98.5 % statements / 94 % branches; validator 98 % / 92 %.

**Gates:** 200 designs evaluated and validated in well under 5 s; the validator agrees with the evaluator on 111 branch-covering scenarios and 216 generated designs; its corruption suite catches altered volume, w/cm, binder, chloride, cost, a claimed pass, missing trace entries, changed limits/SG/prices and rounding without reading the evaluator's flags. Writing the validator found a real evaluator bug (a check pointing at a trace entry that did not exist), fixed.

**Verification note:** tests prove the arithmetic, tri-state logic, traceability, lifecycle rules and validator independence as implemented. They do **not** prove any rule value matches ACI/JS (all unverified, so every result is provisional and says so), that the ACI 211.1 baseline predicts your plant, or that a design is acceptable to produce; nothing here approves a mix. Both implementations were written from the same spec by the same author: a misreading of the spec itself would pass both, so real approved designs as fixtures matter.

**Decisions to confirm (not blocking)**

- Chloride check counts aggregates, water and admixtures only (cement/SCM chloride is not in the test schema); a partial sum over the limit fails, otherwise missing data keep it "not evaluated". C-class designs therefore need admixture `chloride_pct` and water/aggregate chlorides to pass.
- Slump between two ACI 211.1 slump ranges is interpolated between their nearest edges (stated in the report).
- F1–F3 exposure implies air-entrained; the air-entrained ACI 211.1 tables are not on file, so baselines are unavailable there.
- Water without a test uses SG 1.000 (flagged); every other line needs its SG for the design to become `evaluated`.

**Open items:** the engine's blocker/assumption texts are English only (Arabic with the M2.2 compliance table); the checks table is cramped at 390 px (M2.2 polish); JS values and rule verification still pending; Railway staging awaits your go-ahead; real approved designs wanted as fixtures.

**Next:** M2.2 (manual editor, cost baselines, compliance table) — write `docs/plans/M2.2.md`.

## 2026-10-02 — M2.2 Mix intelligence pilot (F-012, F-013)

**Changed**

- `packages/engine`: structured reasons: every English explanation the evaluator writes (blockers, notes, assumptions, data-quality and cost details) also carries a stable key and parameters (`reasonOf`, `REASON_KEYS`); evaluator version 1.1.0; a test over all 111 scenarios fails if a sentence has no key.
- `packages/db`: migrations 0012–0013: `cost_baselines` and `savings_entries` (append-only; the ledger state is the database constant `theoretical`, saving must be positive); `design_evaluations` gains `summary` and `test_versions` for the portfolio views.
- `apps/api`: `POST /api/designs/:id/versions` (edits become the next **draft** version; source untouched), `GET .../versions`, `GET .../diff/:otherId`, `POST .../preview` (evaluates and validates an unsaved edit, stores nothing), `POST /api/designs/evaluate-batch` (≤ 200, one audit entry per design), `GET /api/portfolio`, `GET /api/data-quality`, `POST /api/portfolio/export` (logged CSV, formula characters neutralized), `POST/GET /api/baselines` (new capability `baseline.create`, QC manager only), `POST /api/savings/theoretical`, `GET /api/savings`. One shared `evaluateAndStore` serves the single, batch, baseline and opportunity paths.
- `apps/web`: compliance table (failures first; filters by result, source and class; clause links to the Rules screen; traceability popover with formula, inputs, rule and evidence; reasons translated); Portfolio and Data-quality tabs in the Library (evaluate all, filters, counts, CSV); "Edit as new version" dialog with live check; Versions section with diff and "Price as an opportunity"; Savings screen (baselines, theoretical opportunities, no totals).
- ADR 0008 (savings baseline). Arabic drafts in `docs/i18n-review.md`.

**Commands run (all green):** `typecheck`, `lint` (incl. boundaries), `test` (engine 173, validator 146, api 180, web 26, rbac 168, ui 120, rules 159), `test:rules`, `features:check`, `e2e` (83 incl. 5 new: portfolio, compliance table EN/AR, editor, import → evaluate → attest → baseline → variant → THEORETICAL entry), `screens` (`docs/screens/M2.2/`, reviewed), `db:drift`.

**Gates:** import → evaluate → attest → baseline → manual variant → theoretical entry is tested end to end (API with real Postgres and browser). A live price change after a baseline cannot change it, and a variant is priced at the baseline's own snapshot (hand-computed: 10 kg cement at 0.075 JOD/kg replaced by 20 kg coarse at 0.007 JOD/kg = 0.610 JOD/m³, 8,784 JOD/year at 1,200 m³/month, both labelled estimates).

**Deviations from the plan (and why)**

- The live preview runs on the server (`/preview`: same pure evaluator and validator, nothing stored) instead of in the browser; this avoids shipping rules, tests and prices to the client and keeps one snapshot builder.
- No lifecycle edge `evaluated → draft` was needed: an edit creates version N+1 as a new row in `draft`, so the existing version never changes state. The edge stays off.
- A baseline needs an **existing** price snapshot (the QC manager has no `price.edit`, so I did not let this screen create one); the dialog says so when none exists. Creating the snapshot stays on the Prices screen.
- A new baseline's cost must be complete and validator-verified, so a design with an unpriced material cannot be baselined until it is priced.

**Verification note:** tests prove baselines are fixed to their snapshot, edits never overwrite an existing version, only compliant, validator-verified, cheaper variants become theoretical entries, and cost never reaches cost-blind roles. They do **not** prove any saving is achievable in production, that the volumes (averages from your file) are real, or that a variant is acceptable to produce; nothing here is approved or realized.

**Open items:** Arabic strings are drafts (engineering wording first); `e2e` plant-switcher spec was made race-tolerant (a parallel spec can add a plant); JS values and rule verification pending; Railway staging awaits your go-ahead; real attested designs and volumes still wanted.

**Next:** M3.1 (controlled optimizer) — write `docs/plans/M3.1.md`.

## 2026-10-02 — M3.1 Controlled optimizer (F-017, F-014, F-015, F-016)

**Changed**

- `packages/engine/src/optimizer` (pure; the solver and the validator are injected): required-parameter reader that **blocks and names every missing value**; preparation (usable materials with a stated reason for every exclusion, governing limits, ACI 211.1 baselines per NMAS); enumeration (cement × SCM × SCM % × admixture × dosage level × NMAS × air, cap 200, coarsened and reported above it, deterministic order); one LP per configuration (binder, water, one volume per aggregate; fixed-point loop on the binder-dependent workability adjustment); HiGHS (`highs` 1.15.3, WASM, MIT) behind a `Solver` interface; characteristic rows for every Appendix E key and mode (Fixed → equality, Range → inequalities, Target → deviation variables); objective modes `cheapest` and `closest_to_targets` (two-stage lexicographic); degrees-of-freedom report; conflict diagnostics (slack on user-specified rows only; hard rows are named with no saving); rounding (cement/SCM up to 5 kg, water 1 kg, admixture 0.01, aggregates 5 kg, volume rebalanced on the largest fine aggregate, other roundings and up to three +5 kg cement top-ups tried, otherwise rejected with the reason); finalization that **re-evaluates from scratch**, re-measures every guardrail on the rounded numbers and calls the independent validator; the ACI 211.1 baseline proportioning path (golden test).
- `packages/validator`: `validateCandidate` with its own arithmetic (availability, rounding grid, combined grading against the 0.45-power band, Shilstone CF/WF, fines cap, pumpability, individual aggregate limits, the w/cm ceiling, the characteristics the evaluator cannot read, cost and evidence labels) and a corruption suite over stored optimizer records; dependency rules still keep the validator away from the optimizer.
- `packages/engine`: lifecycle edges `draft/evaluated → trial_candidate` turned on (evidence `validated_candidate`; `ACTIVE_MILESTONE` = M3.1); candidate types in `evaluate/types.ts`; `tableWater` extracted from the water baseline (behaviour unchanged).
- `packages/db`: migrations 0014–0015: `design_requests`, `design_candidates` (append-only by trigger; only validator-passed candidates can be stored), `mix_designs.source_candidate_id` (set once).
- `packages/rbac`: capability `candidate.authorize` (QC manager).
- `apps/api`: `POST /api/design-requests`, `GET /api/design-requests[/:id]`, `POST /api/design-requests/:id/candidates/:cid/trial-candidate` (re-runs evaluator and validator at that moment; creates the design, evaluates it, moves it to `trial_candidate`; `MODEL_PREDICTS_SHORTFALL` needs a QC manager and a reason); cost, shadow prices and weighted deviations stripped without `cost.view`; optimizer settings (`settings.optimizer`).
- Docs: ADR 0009, `docs/formulation-m3.1.md` (every row, why it is linear, and the interpretations to confirm).

**Commands run (all green):** `typecheck`, `lint` (incl. boundaries and formatting), `test` (engine 291, validator 164, api 204, web 26, rbac 175, ui 120, rules 159), `test:rules`, `features:check`, `e2e` (83), `screens` (119; M3.1 has no UI, so the existing screens were re-run as a regression check and no new images were kept), `db:drift`. Engine coverage 98.0 % statements / 90.4 % branches; validator 98.3 % / 92.2 %.

**Gates:** the golden ACI 211.1 example (f′c 30 MPa, 100 mm slump, 19 mm, f′cr 38.3 MPa → w/c 0.437, water 205, cement 469.1, coarse 998.4, sand 664.3 kg/m³) reproduces the hand-worked numbers through the seeded tables. Every candidate in 12 request kinds (both codes, sulfate class, targets, fixed SCM/admixture, exclusions…) passes the independent validator; tampering with the proportions or the claimed guardrails is refused. A 200-configuration search runs in about 0.5 s on the synthetic world. Same request → identical candidates (tested). A user conflict is reported with the characteristic and the distance to a value that works; with the user rows released, the hard rows are named and no saving is offered.

**Missing parameters (the optimizer blocks on real requests until these are entered; tests use a labelled SYNTHETIC set)**

- `eng.grading.target.band_pct`, `eng.shilstone.wf.min`, `eng.shilstone.wf.max`, `eng.fines.max_pct_75um`, `eng.pumpable.min_passing_0_3mm_pct` (pumpable requests only).
- `grading.fine.limits` and `grading.coarse.limits` for ACI and JS (ASTM C33 individual limits; format described in `docs/formulation-m3.1.md`).
- All Jordanian (JS) rule values, as before: JS and Both requests are blocked and the missing rules are named.

**Deviations from the plan (and why)**

- **No worker thread.** HiGHS' WASM `solve()` is synchronous (about 3 ms per configuration here). The request is bounded by a time budget (20 s) and the event loop is yielded between configurations; a worker thread can follow if a real plant's load needs it.
- **Combined grading** is held to the 0.45-power curve ± (`eng.grading.target.band_pct` − `eng.margin.grading_pct_points`) (spec C5); the ASTM C33 limits act per aggregate (an aggregate that fails them is excluded with its reason), because the limits are per material, not per blend.
- **SCM search cap.** Where no governing SCM maximum is on file the search stops at a tenant setting (40 %) and says so; ACI's SCM limits exist only for F3 (air-entrained, unsupported).
- Two guards that are not engineering recommendations, both tenant settings and stated in the formulation note: `guardrailGuard` (0.25 points kept inside each guardrail so rounding cannot break it) and `minAggregateVolume` (0.45 m³/m³, to exclude a degenerate all-paste point).
- The ACI 211.1 w/c table ends at f′cr 40 MPa (f′c ≈ 31.7 MPa), so stronger requests are **blocked, not extrapolated**.

**Verification note:** tests prove the formulation is solved exactly for the synthetic world, constraints and characteristics hold after rounding, the evaluator and the independent validator agree on every candidate, and nothing can reach `approved` from here. They do **not** prove that a candidate will reach strength or slump in your plant (ACI baselines only, trial required), that any rule value is right, that the synthetic parameters resemble yours, or that the SCM-rich cheapest mixes are acceptable early-age. Evaluator, validator and optimizer were written by the same author from the same spec; real approved designs as fixtures matter.

**Decisions to confirm (not blocking)** — the six interpretations at the end of `docs/formulation-m3.1.md` (D_max and grading sieves, one-sided workability adjustment, fines cap definition, individual-limit format, per-NMAS WF bounds, table domain).

**Open items:** Studio, characteristics panel, DoF meter and conflict panel are M3.2; Arabic strings are drafts (no new UI strings here); Railway staging still awaits your go-ahead; JS values and rule verification pending; real attested designs and volumes still wanted.

**Next:** M3.2 (Design Studio) — write `docs/plans/M3.2.md`.

## 2026-10-02 — M3.2 Design Studio (F-018, F-019, F-020)

**Changed**

- `apps/web/src/studio`: the Studio (`/studio`): Evaluate and Generate paths, four stages (Requirements → Candidates → Inspect & Validate → Save / Request trial), plain-language exposure picker (F1–F3 turns Generate off with the reason), material pool chips with the optimizer's reason for every unusable material, characteristics panel (Auto / Fixed / Range / Target, live code limit beside each input, rejected values shown inline with rule and clause, objective toggle), DoF meter, blocked panel (named missing parameters), conflict panel with Release (user values only; hard rows are listed with no control and no saving), candidate cards (cost for cost-visible roles, Δ vs best, margin bars, evidence chips, "n of m characteristics met", notes), pin up to 4 with a side-by-side table, Inspect tabs (proportions with Σ volume, compliance table, strength evidence, gradation and Shilstone charts that are never mirrored, cost with hypothetical shadow prices, traceability, validator report), Save as draft and Request trial (enabled only after a validator pass and for a fresh result; shortfall needs a QC manager and a reason), what-if material quick-entry drawer, Compare plants with a confirmed mapping.
- `apps/api`: `POST /api/design-requests/preflight` (usable pool with reasons, live limits, characteristics check, named blockers; writes nothing), `POST /api/design-requests/evaluate-mix` (typed mix, evaluator + validator, nothing stored), `POST /api/designs` (draft from a typed mix), `POST /api/design-requests/compare-plants` (one stored request per plant, mapping applied to material references, unmapped = skipped with a reason, audited), request-level `adHoc` what-if materials (user-declared; a candidate that uses one cannot become a design). Candidate view now carries validator version and counts.
- **Fix found while building the UI:** the grading limits were read as a list, but the rules system stores a `range` rule as an object keyed by sieve (`{ "4.75": { min, max } }`), so a QC manager could not have entered them. The optimizer, the validator, the synthetic parameters, the fixtures and the formulation note now use the rules system's shape.
- EN/AR strings (264 keys under `studio.*`; Arabic drafts listed in `docs/i18n-review.md`).

**Commands run (all green):** `typecheck`, `lint` (incl. boundaries, formatting, the hard-coded-string rule), `test` (engine 291, validator 164, api 209, web 35, rbac 175, ui 120, rules 159), `test:rules`, `features:check`, `e2e` (93, incl. 10 new: generate → compare → inspect → validator → request trial; inline rejection with clause; air-entrained disabled; named blockers; conflict → Release → candidates; typed mix → draft; what-if material; compare plants; role check; Arabic RTL; axe on every Studio stage), `screens` (125; `docs/screens/M3.2/` holds the Studio screens EN/AR × 1440/1024/390, reviewed), `db:drift`.

**Deviations from the plan (and why)**

- **Demo-tenant SYNTHETIC parameters:** the e2e and screen runs write the labelled SYNTHETIC engineering parameters into their own test database through the Rules API; I did not add them to the demo seed script, so the demo tenant (and every real tenant) still blocks with named parameters until a QC manager enters real values.
- **No live strength conversion** in the strength picker (cube / B-grade are converted by the server through `strength.basis_map` when the request runs); the f′cr and limits are shown from the preflight.
- **Quick entry** is the what-if (request-only) material drawer; entering characteristics for an existing library material still happens on the Materials screen.
- **Typed mixes cannot request a trial** from the Studio: the lifecycle edge is turned on, but its evidence is the candidate validator, which only generated candidates have. A typed mix can be saved as a draft and evaluated.
- Compare plants shows "not available" for delivered estimates (no site distance or haul cost exists yet).

**Verification note:** tests prove the Studio shows what the API returns, cannot request a trial without a validator pass or after the request changed, never offers to release a code or engineering limit, shows blocked parameters by name, rejects a loosening value with its clause, and shows no cost to cost-blind roles (API tests). They do **not** prove any candidate will perform in your plant, that the synthetic parameters resemble yours, or that the Arabic wording is final.

**Open items:** Railway staging still awaits your go-ahead; real engineering parameters (grading band, WF bounds, fines cap, pumpable minimum, ASTM C33 limits) and JS values still to be entered by a QC manager; Arabic review; real attested designs and volumes.

**Next:** M3.3 (characteristic profiles) — write `docs/plans/M3.3.md`.

## 2026-10-02 — M3.3 Characteristic profiles (F-021)

**Changed**

- `packages/db`: `characteristic_profiles` and immutable `characteristic_profile_versions` (migrations 0016–0017: guard trigger that refuses content edits, deletes and un-approval; CHECK `profile_version_four_eyes`); design requests store the profile versions and per-row origins they used.
- `packages/engine/src/profiles`: layering (company → plant → product family → request, request always wins), matching on `applies_to` (f′c range, exposure, pumpable, placement, season) with narrowest-wins and listed ties, version diff, material-preference merge.
- `apps/api`: `/api/profiles` (list, create, new version, get, diff, usage, match, approve). QC engineers and managers draft; only a QC manager approves, never the author (API and DB). Save and approval check every covered exposure against ACI/JS and list rejected combinations; approval is blocked while any is rejected. Design requests resolve profiles server-side (hard-limit check on the merged result); a draft profile is refused for trial-candidate generation; a plant profile is visible and usable only at its plant.
- `apps/web`: Profiles screen (`/profiles`: list with scope/plant/family filters, versions, content, per-exposure code check, diff, approve, "used by N designs" with older-version designs); create / new-version dialog sharing the Studio characteristics rows; Studio profile picker with suggestions, tie choice, placement and season, origin lines on every characteristic row ("from X v3", "your value overrides X v3"), applied-profiles line, Generate disabled while a selected profile is a draft (Evaluate unaffected), "Save these characteristics as a profile…".
- ADR 0010; EN/AR strings (Arabic drafts in `docs/i18n-review.md`); nav gains Profiles for roles with `design.write`.

**Commands run (all green):** `typecheck`, `lint`, `test` (engine 301, validator 164, api 218, web 38, rbac 182, ui 120, rules 159), `test:rules`, `features:check`, `e2e` (97, incl. 4 new: list → detail → code check → new version needs another approver; suggested profile → origin badge → save as profile; draft blocks Generate but not Evaluate; Arabic RTL; axe on each), `screens` (`docs/screens/M3.3/`: profiles list, detail and Studio picker, EN/AR × 1440/1024/390), `db:drift`.

**Deviations from the plan (and why)**

- **The approval flow in the browser is exercised as "disabled for the author"**: the e2e world has one QC manager account, so the two-person approval itself is covered by API tests and the database CHECK, and by the e2e seed (engineer drafts, manager approves through the API).
- The two seeded SYNTHETIC profiles exist only in the e2e/test databases; the e2e one at company scope (a plant-scoped draft needs a plant-assigned engineer, which that world does not have).
- Usage insight is the stored older-version list on the profile and the API; the revalidation inbox item is M5.1.
- The e2e world seed is now idempotent per database (spec files run in separate workers).

**Verification note:** tests prove a profile can only tighten (the hard-limit checker runs on the merged result), versions are immutable, an author cannot approve their own version, a draft cannot drive trial-candidate generation, a plant profile does not leak to other plants, ties are shown rather than guessed, and the Studio labels where every value came from. They do **not** prove any profile's values are good engineering, that the synthetic profiles resemble yours, or that the Arabic wording is final.

**Open items:** Railway staging still awaits your go-ahead; real engineering parameters (grading band, WF bounds, fines cap, pumpable minimum, ASTM C33 limits) and JS values still to be entered by a QC manager; Arabic review; real attested designs and volumes.

**Next:** M4.1 (Library and lifecycle) — write `docs/plans/M4.1.md` when you say "Proceed".
