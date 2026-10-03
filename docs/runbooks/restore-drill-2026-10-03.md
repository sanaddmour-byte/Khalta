# Restore drill — 2026-10-03

**What this is:** the drill that M6.2 requires, executed on the build machine of this milestone with the **compiled production bundle** and a local PostgreSQL. **What it is not:** a drill on Railway's managed PostgreSQL, a real bucket, or the container image (no container daemon exists here). Those are repeated at go-live (`go-live.md`) and by the CI `image` job. All data is the SYNTHETIC demo dataset (and, in run B, SYNTHETIC filler in a scratch database).

Command (repeatable): `pnpm build:api` and `pnpm --filter @khalta/api deploy --prod --legacy <dir>` to make the bundle, then
`node scripts/restore-drill.mjs --bundle <dir> --admin-url <postgres admin url> --web apps/web/dist [--pad-mb N]`.

## What the drill does

1. Creates a scratch database; **starts the bundle** (`node dist/server.js`), which runs the 28 migrations, bootstraps the first admin and syncs the rules; seeds the SYNTHETIC demo data (`node dist/demo.js`); runs the smoke script (health, ready, headers/CSP, web app, API guard, sign-in, rules, materials); records what the API reports (rules, materials, designs, users).
2. **Backs up** (`node dist/cli.js backup`) to a local-directory store: consistent `pg_dump -Fc` with the manifest, hash re-read.
3. **Restores** (`node dist/cli.js restore --target …`) into a **new** database: hash checked against the manifest, `pg_restore`, then the verification (migration count and the row count of 18 critical tables equal to the manifest).
4. **Starts the bundle on the restored copy**, runs the smoke script again, signs in with the restored accounts, renders a PDF submittal (Chromium), compares the API's counts with step 1, and starts the **worker** to confirm it schedules `khalta.backup 30 1 * * *` and `khalta.nightly 0 2 * * *`.

## Results

|                                                   | Run A: demo dataset                                                                                         | Run B: demo + 400 MB filler                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Database size                                     | 11 MB                                                                                                       | 468 MB                                      |
| Dump size (compressed)                            | 227,002 bytes                                                                                               | 241,930,460 bytes                           |
| Backup (snapshot, dump, upload, re-read, hash)    | 0.77 s                                                                                                      | 24.3 s                                      |
| Restore (fetch, hash check, create, `pg_restore`) | 1.7 s                                                                                                       | 7.1 s                                       |
| Verification                                      | **ok**: 28 of 28 migrations; 0 mismatches over 18 tables                                                    | **ok**: same                                |
| Application on the restored copy                  | ready in 2.1 s; smoke **pass**; same API counts as the source (rules 204, materials 19, designs 6, users 9) | ready in 1.8 s; smoke **pass**; same counts |
| PDF from the bundle (Chromium)                    | ok (77,838 bytes)                                                                                           | ok (77,856 bytes)                           |
| Worker                                            | running; both schedules registered                                                                          | same                                        |
| Total                                             | 2.5 s of backup + restore                                                                                   | 31.4 s                                      |

Counts verified against the manifest (run A): users 9, plants 2, rules 209 (all versions), materials 19, material tests 19, material prices 49, designs 6 with 42 lines, design transitions 14, production volumes 36, audit log 78; the other critical tables were empty.

Environment: PostgreSQL 16.14 server and client, Node 22.22.0, `fsync=off` on the local cluster, local-directory store.

## What this says about RPO and RTO

- **RPO: 24 hours**, by design (nightly dump, no WAL archiving). Anything entered after the last 01:30 backup is lost in a restore.
- **RTO:** the mechanical part (fetch, verify, restore, boot, smoke) took seconds at 0.5 GB here. Do **not** extrapolate: this cluster ran without `fsync`, on local disk, with no network transfer. On a managed database over a network expect minutes per GB; the go-live drill measures it. The **2-hour RTO target** is dominated by the human steps (deciding, creating the target database, switching `DATABASE_URL`, redeploying, checking), which `restore.md` lists in order.
- The verification is strict (every critical count and the migration journal), so a restore that "worked" but dropped rows would have failed it; the automated test `restore: round trip` checks the same thing and also checks that a tampered dump, a live target, an existing target, and a count mismatch are each refused or reported.

## Defects found and fixed during the drill

- Bundling `@khalta/db` made its "run migrations when executed directly" guard fire for every bundle entry point (including the ops CLI): the CLI and the server migrated `DATABASE_URL` on start. The guard moved to its own entry (`migrate-cli.ts`) so a library import never has side effects.
- The bundle needed `pg` and `highs` as direct dependencies of the API package (the build now fails if the output imports a package that is not a direct dependency).
