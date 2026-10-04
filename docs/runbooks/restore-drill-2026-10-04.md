# Restore drill — 2026-10-04 (improvement programme, phase 6)

**What this is:** the isolated drill (`scripts/restore-drill.mjs`) run again on the **current build** (39 migrations, the new worker heartbeat and escalation schedule) against a **local** PostgreSQL 16 and a local-directory store. **What it is not:** a drill on Railway's managed PostgreSQL, a real bucket or the container image. **The live recovery has not been verified.** All data is the SYNTHETIC demo dataset.

Command: `pnpm build:api`, `pnpm --filter @khalta/api deploy --prod --legacy <dir>`, copy `apps/api/out/*` into `<dir>`, then
`node scripts/restore-drill.mjs --bundle <dir> --admin-url postgres://…/postgres --web apps/web/dist`.

## Result

| Step                              | Outcome                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle boot on a scratch database | ready in 2.5 s; 39 migrations                                                                                                                                 |
| Smoke on the source               | **pass** (health, ready, headers/CSP, web app, API guard, sign-in, dashboard and change-impact endpoints including anonymous refusal, rules, materials)       |
| Backup                            | 279,004 bytes, 0.8 s, hash re-read                                                                                                                            |
| Restore into a **new** database   | 0.5 s; verification **ok**: 39 of 39 migrations, 0 mismatches over 18 critical tables (users 9, rules 320, materials 23, designs 6, audit log 179, and so on) |
| Application on the restored copy  | ready in 1.8 s; smoke **pass**; same API counts as the source (rules 222, materials 23, designs 6, users 9)                                                   |
| Worker                            | running; schedules `khalta.backup 30 1 * * *`, `khalta.escalation 5 * * * *`, `khalta.nightly 0 2 * * *`                                                      |
| PDF from the bundle               | skipped here (no Chromium path given)                                                                                                                         |
| Backup + restore                  | 2.5 s on a 12 MB database with `fsync=off`. **Do not extrapolate**: see the 2026-10-03 drill for sizing caveats                                               |

## Defect found and fixed by this drill

The demo seeder (used for staging) signs in as several roles after phase 2. The sign-in route is rate limited, so a seeding run against a production-mode server stopped with `429`. A staging redeploy with the new commits would have failed to seed. The seeder now waits out the limit (it is a one-off tool, never a request path), and the drill prints the tail of a failing step's output instead of the head, which hid the real error under warnings.

## Still unverified

Recovery on Railway's PostgreSQL and a real bucket (RTO measured there); the container image build; Chromium PDF inside the image. Those remain go-live items (`go-live.md`).
