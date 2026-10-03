# Khalta production image (ADR 0017): one image, two start commands.
#   api    node dist/server.js   (HTTP: API + built web app on one origin, ADR 0006)
#   worker node dist/worker.js   (pg-boss jobs incl. the nightly backup; no HTTP)
# Compiled bundle (esbuild) + production dependencies only; Chromium for the PDF submittal; the PostgreSQL 17 client for
# pg_dump / pg_restore / psql (backups and restores). Runs as the unprivileged `node` user.
FROM node:22-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @khalta/web build
# dist/ (bundled API, worker, ops CLI) + migrations/ + seeds/
RUN pnpm --filter @khalta/api build --out /out
# production node_modules only (the workspace packages are bundled into dist/)
RUN pnpm --filter @khalta/api deploy --prod --legacy /deploy

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DEPLOY_ENV=production \
    WEB_DIST_DIR=/app/web \
    TRUST_PROXY=1 \
    PORT=3000 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/migrations ./migrations
COPY --from=build --chown=node:node /out/seeds ./seeds
COPY --from=build --chown=node:node /app/apps/web/dist ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# server.js runs the migrations, bootstraps the first admin (BOOTSTRAP_ADMIN_*) and syncs rule seeds, then listens.
# The worker service overrides this command with `node dist/worker.js` (see railway.worker.json).
CMD ["node", "dist/server.js"]
