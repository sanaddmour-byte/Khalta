# Go-live checklist

Nothing below is done on Railway until Sanad says **go**. Items marked **(approval)** are decisions only Sanad can give.

## Before

- [ ] **(approval) Railway go-ahead**: project/workspace, services `api` and `worker`, managed PostgreSQL 17, `production` environment with **manual** promotion.
- [ ] **(approval) Production origin** (domain with https) and DNS.
- [ ] **(approval) Backup bucket** provider and credentials: private, server-side encryption; `BACKUP_*` set on `worker`.
- [ ] Variables set per `production.md`; `DEPLOY_ENV=production`; `KHALTA_DEMO` off; no demo seed.
- [ ] First admin bootstrapped, then `BOOTSTRAP_ADMIN_*` removed.
- [ ] CI is green on the commit being promoted, including the **image** job (container build, smoke test, restore drill from the image).
- [ ] The engineering inputs the app cannot invent are entered by a QC manager and **verified**: engineering parameters, JS rule values, trial criteria, moisture limits, letterhead (see `docs/progress.md` open items). Until then evaluations say "provisional".

## Drill on the real platform (repeat of `restore-drill-2026-10-03.md`)

- [ ] Run a backup by hand on `worker`: `node dist/cli.js backup`; confirm `/api/system/backups` = `ok` and the object is in the bucket.
- [ ] Restore it into a new database (`restore.md`), verify the counts, boot `api` on it, run the smoke script. Record timings and the RTO next to the figures in the first drill.
- [ ] Drop the drill database.

## Go

- [ ] Promote to `production`; `/ready` 200; smoke test; `worker started` in the log; `/api/system/jobs` shows the queues; `/api/system/backups` `ok` after the first night.
- [ ] Tell the QC manager and plant managers which roles can export CSV and what the files are.

## After (first week)

- [ ] Daily: `/api/system/backups` is `ok`; weekly: list backups and run `verify` against the newest one into a scratch database.
- [ ] Review `incident.md` with whoever is on call; add names and contact paths here: **on call: ____ / escalation: ____** (not decided yet).
