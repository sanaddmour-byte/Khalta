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
