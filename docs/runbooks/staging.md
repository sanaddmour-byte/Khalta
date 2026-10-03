# Staging runbook (Railway)

> M6.2: staging and production now share the compiled image and the `api` + `worker` services described in `production.md`. Staging sets `DEPLOY_ENV=staging` (not held to the production guard). Demo data: `node dist/demo.js` in a shell on `api`.

Staging is one Railway project with an `api` service (built from the root `Dockerfile`, serving the web app from the same origin, ADR 0006) and a managed PostgreSQL. It auto-deploys from `main`.

## First-time setup

1. Create a Railway project, add **PostgreSQL**, add a service from the GitHub repo `sanaddmour-byte/khalta` (branch `main`). Railway reads `railway.json` (Dockerfile build, `/health` check).
2. Generate a public domain for the service. That URL is the **origin** used below.
3. Set the service variables (never commit them):

| Variable                                             | Value                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                                       | reference to the Postgres plugin's connection string                        |
| `BETTER_AUTH_SECRET`                                 | a random string of 32+ characters (`openssl rand -base64 48`)               |
| `BETTER_AUTH_URL`                                    | the staging origin, e.g. `https://khalta-staging.up.railway.app`            |
| `APP_BASE_URL`                                       | the same staging origin                                                     |
| `NODE_ENV`                                           | `production`                                                                |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | first admin (used once, only while no users exist; password 12+ characters) |
| `KHALTA_DEMO`                                        | `1` to show the SYNTHETIC banner when the demo dataset is loaded            |

`TRUST_PROXY=1` is set in the image (Railway forwards the client IP in `X-Forwarded-For`; without it sign-in rate limiting would treat every user as one client). `PORT` is provided by Railway. Migrations run automatically at start (a failing migration aborts the deploy, and Railway keeps the previous version running).

## Demo data (staging only)

Open a shell on the service (Railway CLI `railway run` or the dashboard) and run, with the variables above plus a demo password:

```
KHALTA_ALLOW_DEMO_SEED=1 DEMO_PASSWORD='<12+ characters>' node dist/demo.js
```

It creates users `<role>@khalta.test` (+ `qc.manager2@khalta.test`), materials, prices, snapshots, legacy designs (four attested by the second QC manager) and volumes, all labelled SYNTHETIC. Running it again changes nothing. Do **not** run it against production.

## Smoke test

```
pnpm smoke:staging https://<staging-origin> admin@example.com '<password>'
```

Checks `/health`, the web app, the client-route fallback, the anonymous API guard, sign-in, `/api/me`, and `/api/rules`, `/api/materials`.

## Rollback

Redeploy the previous successful deployment from the Railway dashboard. Migrations are additive, so the previous image runs against the newer schema. If a migration itself is bad, fix forward with a new migration; never edit an applied one.

## Troubleshooting

- **Sign-in fails with a 403 about the origin**: `BETTER_AUTH_URL` / `APP_BASE_URL` must equal the browser's origin exactly (scheme and host, no trailing slash).
- **Blank page after deploy**: confirm `WEB_DIST_DIR` is set in the image (`/app/apps/web/dist`) and `/` returns HTML via the smoke test.
- **Health check never passes**: read the deploy logs; the usual cause is a missing `DATABASE_URL` or `BETTER_AUTH_SECRET` (the API fails fast with a readable message).
