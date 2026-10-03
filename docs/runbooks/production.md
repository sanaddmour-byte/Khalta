# Production runbook

Environments: **staging** (auto-deploys from `main`) and **production** (promoted by hand). Nothing is created or changed on Railway until the go-live approval (see `go-live.md`). Topology and reasons: ADR 0017.

## Services

| Service    | Start command         | Notes                                                                                                                                                                                                                  |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`      | `node dist/server.js` | HTTP: API plus the built web app on one origin (ADR 0006). Runs the migrations, then listens. Config file `railway.json` (`/health` check).                                                                            |
| `worker`   | `node dist/worker.js` | pg-boss jobs: price/test/rule/strength triggers, the 01:30 backup, the 02:00 nightly sweep. No HTTP. Config file `railway.worker.json` (set it as the service's config file; Docker's own HEALTHCHECK does not apply). |
| PostgreSQL | managed (Railway)     | Version 17. The `pgboss` schema lives in the same database.                                                                                                                                                            |

Both services use the **same image** (root `Dockerfile`). `JOBS_IN_PROCESS` must be `0` (unset) in production so jobs run only in `worker`.

## Environment variables

Set per service; never commit them. `api` needs all of the first block; `worker` needs `DATABASE_URL`, `BACKUP_*`, `APP_VERSION`, `NODE_ENV`, `DEPLOY_ENV`.

| Variable                                                                                                                                 | Production value                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DEPLOY_ENV`                                                                                                                             | `production` (turns on the guard: the API **refuses to start** on any unsafe value below) |
| `NODE_ENV`                                                                                                                               | `production`                                                                              |
| `DATABASE_URL`                                                                                                                           | the Postgres plugin's connection string                                                   |
| `BETTER_AUTH_SECRET`                                                                                                                     | 32+ random characters (`openssl rand -base64 48`); not a placeholder                      |
| `BETTER_AUTH_URL`, `APP_BASE_URL`                                                                                                        | the production origin, `https://…`, no trailing slash, equal to the browser's origin      |
| `PDF_BASE_URL`                                                                                                                           | optional; the origin QR codes point to (https)                                            |
| `TRUST_PROXY`                                                                                                                            | `1` (the image sets it)                                                                   |
| `KHALTA_DEMO`                                                                                                                            | `0` or unset; `KHALTA_ALLOW_DEMO_SEED` must be **unset**                                  |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`                                                                                     | the first admin, used once while no users exist; remove after first sign-in               |
| `APP_VERSION`                                                                                                                            | the git SHA (Railway: `RAILWAY_GIT_COMMIT_SHA`)                                           |
| `BACKUP_ENABLED`                                                                                                                         | `1` (default). `0` switches the job off                                                   |
| `BACKUP_ENV`                                                                                                                             | `production` (the bucket prefix `khalta/production/`)                                     |
| `BACKUP_BUCKET_NAME`, `BACKUP_BUCKET_ENDPOINT`, `BACKUP_BUCKET_REGION`, `BACKUP_BUCKET_ACCESS_KEY_ID`, `BACKUP_BUCKET_SECRET_ACCESS_KEY` | an S3-compatible **private** bucket with server-side encryption                           |
| `LOG_LEVEL`                                                                                                                              | `info`                                                                                    |

## Build (what the image contains)

`pnpm --filter @khalta/api build --out <dir>` bundles `dist/server.js`, `dist/worker.js`, `dist/cli.js` (backup, list, restore, verify) and `dist/demo.js` (staging only), and copies `migrations/` and `seeds/` next to `dist/`. Third-party packages stay external and are shipped by `pnpm deploy --prod`; the build fails if the bundle imports a package that is not a direct dependency. The image adds Chromium, the PostgreSQL 17 client and the built web app (`/app/web`). CI builds it, boots it, smoke-tests it and runs the restore drill from it.

## Deploy and promote

1. Merge to `main`: **staging** deploys. The migrations run before the new version listens; a failing migration aborts the deploy and the previous version keeps running.
2. In staging: `pnpm smoke:staging https://<staging-origin> <admin> <password>` (health, **ready**, headers and CSP, web app, API guard, sign-in, rules, materials). Look at `/api/system/jobs` and `/api/system/backups` (admin).
3. **Promote** the same image to `production` by hand in the Railway dashboard (never a branch auto-deploy). Wait for `/ready` = 200 (the deploy gate), then run the smoke script against production.
4. Confirm the worker log says `worker started`.

## Rollback

Redeploy the previous successful deployment of `api` **and** `worker`. Migrations are additive, so the previous image runs against the newer schema. A bad migration is fixed forward with a new migration; never edit an applied one. If data was damaged, follow `restore.md`.

## Secrets and access

- Secrets live only in Railway variables. Rotating `BETTER_AUTH_SECRET` signs everyone out (acceptable). Rotating bucket keys: create the new key, set the variables on both services, redeploy, run `node dist/cli.js list` to prove access, then revoke the old key.
- Admin accounts are created in the app (Users screen). Remove `BOOTSTRAP_ADMIN_*` once the first admin exists.
- Logs are structured (pino) with a request id; credentials are not logged. Alert on: `/ready` not 200 for 5 minutes, `/health` failing, `/api/system/backups` state not `ok`, repeated `job … failed` lines.

## Health endpoints

`/health` is liveness (cheap). `/ready` checks the database and that every migration is applied (503 otherwise) and reports the backup state (`ok`, `stale` after 26 h, `failed`, `none`, `disabled`) as information only.
