# Backup runbook

## What happens every night

The `worker` runs the `backup` job at **01:30 Asia/Amman** (`pg-boss`, retried with back-off). It:

1. opens one `REPEATABLE READ` read-only transaction, exports its snapshot, counts the critical tables and the migrations inside it, and runs `pg_dump --format=custom --snapshot=<id>` (so the counts in the manifest are exactly what is in the dump); the `pgboss` schema is excluded (queues rebuild);
2. writes `khalta/<BACKUP_ENV>/<yyyy>/<mm>/khalta-<timestamp>-<hash8>.dump`;
3. downloads it again and checks the SHA-256 (a dump that cannot be read back does not count);
4. writes the manifest beside it (`….manifest.json`: hash, size, PostgreSQL and application versions, migration count, row counts, excluded schemas);
5. applies retention: delete verified backups older than **30 days**, but **never fewer than the 7 newest verified**; remove a dump without a manifest once it is a day old (a failed upload);
6. records the run in `backup_runs` and in the audit log.

A dump is "verified" only when its manifest exists. **RPO is 24 hours** (nightly). There is no point-in-time recovery.

## Checking it

- Admin: `GET /api/system/backups` → `state` (`ok` / `stale` / `failed` / `none` / `disabled`), the last runs with hash, size and any error.
- `/ready` shows the same state; a stale backup (older than 26 h) never takes the service down but must be acted on the same day.
- `node dist/cli.js list` (needs `DATABASE_URL` and the `BACKUP_*` variables) lists verified backups, newest first.

## Taking one by hand

`node dist/cli.js backup` (same variables). Do this before a risky change (a migration, a bulk import) and note the key.

## If the state is not `ok`

1. `GET /api/system/backups`: read `error` of the last failed run.
2. `no backup storage is configured`: the `BACKUP_BUCKET_*` variables are missing on `worker`.
3. `pg_dump exited …`: connection or version problem; the image carries the PostgreSQL 17 client, the server must not be newer.
4. bucket errors (403/404): credentials or bucket name; rotate per `production.md`.
5. After fixing, run a backup by hand and confirm `ok`. Record the incident (`incident.md`).

## Access to the bucket

The bucket is private with server-side encryption. Only the backup credentials and the people who restore should have access. Dumps contain every table, including hashed passwords and the audit log: treat them like the database.
