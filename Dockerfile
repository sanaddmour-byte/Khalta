# Khalta API + built web app (same origin, ADR 0006). Staging simplification: the API runs its TypeScript
# sources through tsx, so the runtime image keeps the workspace (larger, simpler); compile in M6.2.
FROM node:22-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @khalta/web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/apps/web/dist \
    TRUST_PROXY=1 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# server.ts runs the migrations, bootstraps the first admin (BOOTSTRAP_ADMIN_*) and syncs rule seeds, then listens.
CMD ["apps/api/node_modules/.bin/tsx", "apps/api/src/server.ts"]
