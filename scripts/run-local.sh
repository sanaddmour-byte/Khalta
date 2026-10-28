#!/usr/bin/env bash
# One-command local run with the SYNTHETIC demo data (macOS/Linux). Needs Docker, Node 22+ and pnpm.
# Opens http://localhost:5173 ; sign in as qc.manager@khalta.test / Khalta-Demo-2026!
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U khalta >/dev/null 2>&1; do sleep 1; done
pnpm install --frozen-lockfile

export DATABASE_URL=postgres://khalta:khalta@localhost:5432/khalta
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-local-dev-secret-at-least-32-characters-long}"
export BETTER_AUTH_URL=http://localhost:3000
export APP_BASE_URL=http://localhost:5173
export BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-admin@khalta.test}"
export BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-Khalta-Demo-2026!}"
export DEMO_PASSWORD='Khalta-Demo-2026!'
export NODE_ENV=development PORT=3000

pnpm db:migrate
# Start the API (it bootstraps the first admin), load the demo data once it is up, then start the web app.
pnpm --filter @khalta/api exec tsx src/server.ts &
API=$!
trap 'kill $API 2>/dev/null || true' EXIT
until curl -fs http://localhost:3000/health >/dev/null; do sleep 1; done
pnpm db:seed:demo
pnpm --filter @khalta/web dev
