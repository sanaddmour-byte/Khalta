# Khalta (خلطة)

Ready-mix concrete mix design evaluator and optimizer (AR/EN, ACI + Jordanian code). Read `CLAUDE.md` first, then `docs/spec/04-phases.md` and `docs/progress.md`.

## Requirements

Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker (Postgres, from M0.2).

## Commands

`pnpm install`, then `pnpm dev | typecheck | lint | test | test:rules | e2e | screens`.
`db:migrate`, `db:seed:demo` and `fixtures:export` are placeholders until M0.2 / M1.3 / M2.2.

In sandboxes with a pre-installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` before `pnpm e2e` / `pnpm screens`. CI installs its own browser.
