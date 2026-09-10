# Build context is the REPO ROOT, not apps/api:
#   docker build -f apps/api/Dockerfile .
# This is a pnpm workspace — @roster/api depends on @roster/types via `workspace:*`,
# which only resolves if the root manifest, pnpm-workspace.yaml and BOTH package
# directories are present. A single-package copy silently breaks that link.
#
# Install with pnpm (the workspace's package manager, so the lockfile is honoured),
# run with bun. Node exists only in the build stage.

# ---- deps: resolve + link the whole workspace -------------------------------
FROM node:22-alpine AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable

# Manifests first: this layer stays cached until a package.json or the lockfile changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/types/package.json packages/types/

# ponytail: --no-frozen-lockfile so the image builds even before pnpm-lock.yaml is
# committed. Switch to --frozen-lockfile once it is in git — that is what makes the
# build reproducible.
RUN pnpm install --no-frozen-lockfile

# ---- runtime: bun + node_modules + source ------------------------------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# Whole tree in one COPY: keeps pnpm's node_modules symlinks (root .pnpm store and
# the per-package links) intact, which a per-directory copy would not.
COPY --from=deps /app ./
COPY packages/types ./packages/types
COPY apps/api ./apps/api
# db/schema.sql + db/seed.sql come in with apps/api above — reset-db.ts reads them at runtime.

# Non-root. Created explicitly rather than relying on the base image's `bun` user.
RUN addgroup -S app && adduser -S -G app app
USER app

WORKDIR /app/apps/api
ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

# DATABASE_URL / CORS_ORIGIN are injected by Dokploy (or compose). Never baked in.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3000/api/health || exit 1

CMD ["bun", "src/index.ts"]
