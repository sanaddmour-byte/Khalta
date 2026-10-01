# Khalta (خلطة)

Ready-mix concrete mix design evaluator and optimizer (AR/EN, ACI + Jordanian code). Read `CLAUDE.md` first, then `docs/spec/04-phases.md` and `docs/progress.md`.

## Requirements

Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker (Postgres, from M0.2).

## Commands

`pnpm install`, then `pnpm dev | typecheck | lint | test | test:rules | e2e | screens`.
`pnpm db:migrate` applies migrations to `$DATABASE_URL`; `pnpm db:drift` fails if the schema and committed migrations disagree. `db:seed:demo` and `fixtures:export` are placeholders until M1.3 / M2.2.

### Database

Local: `docker compose up -d postgres`, copy `.env.example` to `.env` (or export its variables), `pnpm db:migrate`, then optionally `pnpm --filter @khalta/api seed:dev` (one user per role, password printed). The API also migrates and bootstraps the first admin on start.

Tests need no setup: they use `TEST_DATABASE_URL` (a role allowed to `CREATE DATABASE`) if set, else start a throwaway local cluster from installed PostgreSQL binaries (`tools/test-db/start.sh`; no Docker needed). A migrated template database is cloned per test file.

In sandboxes with a pre-installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` before `pnpm e2e` / `pnpm screens`. CI installs its own browser.
