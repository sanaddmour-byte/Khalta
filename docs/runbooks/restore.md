# Restore runbook

The tool **never restores over the live database**. You restore into a **new** database, verify it, and only then decide whether to switch to it. The drill in `restore-drill-2026-10-03.md` used exactly these steps.

## Decide first

| Situation                                                                       | Action                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The service is up but some data is wrong (a bad import, a mistaken bulk change) | Restore into a new database, read the old values from it, and correct through the app; do **not** swap. Everything in Khalta is append-only or versioned, so most mistakes are fixed forward. |
| The database is lost or corrupt                                                 | Restore into a new database, verify, then switch `DATABASE_URL` of `api` and `worker` to it (below).                                                                                          |
| You are unsure                                                                  | Take a backup of what exists now (`node dist/cli.js backup`), then restore into a new database; nothing is lost by looking.                                                                   |

## Steps

Run in a shell on the `worker` service (it has the client tools and the bucket variables) or any machine with the image's bundle.

1. **List**: `node dist/cli.js list`. Pick a key (default `latest`). Note its time: everything after it is lost (RPO 24 h).
2. **Create a target URL** for a new database on the same server, e.g. `postgres://…/khalta_restore_20261003`.
3. **Restore**: `node dist/cli.js restore --target <url> [--from <key|latest>]`. It downloads the dump, **checks its SHA-256 against the manifest** (a mismatch stops here), creates the database, runs `pg_restore`, and prints the **verification**: the migration count and the row count of every critical table must equal the manifest.
   - `already exists`: pick another name or add `--replace`.
   - `refusing to restore over the live database`: correct; see "Over the live database".
4. **Verify the application on the copy**: start `dist/server.js` with `DATABASE_URL=<target>` on another port (`PORT=3999 BETTER_AUTH_URL=http://127.0.0.1:3999 APP_BASE_URL=…`), then `node scripts/smoke-staging.mjs http://127.0.0.1:3999 <admin> <password>`; `/ready` must be 200 and sign-in must work (this proves the accounts restored).
5. **Switch** (only for a lost database): in Railway set `DATABASE_URL` on `api` and `worker` to the new database, redeploy both, run the smoke script against the public origin, check `/api/system/jobs` and `/api/system/backups`, and take a fresh backup immediately.
6. **Afterwards**: write down what was lost (the window between the backup and the incident), tell the QC manager, and re-enter or re-run anything that fell in that window (price edits, lab results, approvals are audited: compare the audit log of the old database if it is still readable).

## Over the live database (last resort)

Only when the platform cannot create a second database. Take a backup of the broken database first, stop `api` and `worker`, then: `node dist/cli.js restore --target <live url> --allow-live --confirm <live database name>`. Both flags are required and the name must be typed exactly.

## Verification failed

A `mismatches` list names the table, the restored count and the manifest count. Do not use that copy. Try the previous backup; if two in a row fail, stop and escalate (`incident.md`): the backup path itself is broken.
