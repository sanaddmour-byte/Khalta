# ADR 0017 — Production topology, the compiled build, and backup / restore

Status: accepted (2026-10-03, approved with the M6.2 plan defaults)

## Context

Staging ran the TypeScript sources through tsx in a large image with no Chromium (so no PDFs), no worker service, and no backups. Production holds real plant data and approvals. The platform has no container daemon in this build environment, and no bucket, domain or Railway project exists until Sanad approves go-live.

## Decisions

1. **One image, two commands.** `api` (`node dist/server.js`: API plus the built web app on one origin, ADR 0006) and `worker` (`node dist/worker.js`). The build bundles the workspace packages with esbuild; third-party packages stay external and are shipped by `pnpm deploy --prod`; the build fails if the output imports a package that is not a direct dependency. `migrations/` and `seeds/` ship next to `dist/`. The runtime adds Chromium (PDF), the PostgreSQL 17 client and runs as `node`.
2. **A strict production guard.** `DEPLOY_ENV=production` makes the API refuse to start on: non-https origins, a placeholder secret, the demo banner or demo-seed flag, `TRUST_PROXY` off, `NODE_ENV` not production. Staging is not held to it. Session cookies are `Secure` in production.
3. **Readiness separate from liveness.** `/health` is cheap; `/ready` checks the database and that every migration is applied (503 otherwise) and only **reports** backup freshness. Security headers on every response (HSTS in production); the served app gets a CSP with no `unsafe-inline` script (its one inline bootstrap script is allowed by hash, computed from the served file).
4. **Backups.** A nightly worker job (01:30 Asia/Amman): one `REPEATABLE READ` read-only transaction exports a snapshot, counts the critical tables and migrations inside it, and `pg_dump -Fc --snapshot` dumps the same snapshot (the `pgboss` schema excluded). The dump is uploaded to an S3-compatible bucket (or a directory in tests and drills), **read back and hash-checked**, and only then given a manifest; a dump without a manifest is not a backup. Retention: 30 days, never fewer than the 7 newest verified. Every run is recorded in `backup_runs` and the audit log; a failure is visible (`/api/system/backups`, `/ready`), never silent. RPO 24 h; no PITR.
5. **Restore.** Always into a **new** database; the live URL needs `--allow-live` and the typed database name. The SHA-256 is checked against the manifest before `pg_restore`; the verification compares the migration count and every critical table's row count with the manifest. The drill (`restore-drill-2026-10-03.md`) and an automated round-trip test run this end to end.
6. **No client-side encryption** of dumps: a private bucket with server-side encryption. Dumps hold every table; they are handled like the database.
7. **Nothing is created on Railway** until the go-live approval; the runbooks and CI are ready.

## Consequences

A plant can run on a smaller, stricter image with PDFs, a separate worker, verified nightly backups and a restore that has been performed. Untested until go-live: the container build and the bucket upload (CI and the live drill cover them); managed-database restore timings.
