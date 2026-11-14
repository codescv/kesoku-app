# syntax=docker/dockerfile:1.7
# Kesoku relay image. Build from the REPO ROOT:
#   docker build -f apps/relay/Dockerfile -t kesoku-relay .
# (apps/relay/Dockerfile.dockerignore trims the context.)

# ───────────── build stage ─────────────
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /repo

# Manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

# Client PWA (served as static files) + relay bundle.
RUN pnpm --filter @kesoku/client run build \
 && pnpm --filter @kesoku/relay run build

# Production-only node_modules for the externals (ws, firebase-admin, @google-cloud/storage).
RUN pnpm --filter @kesoku/relay deploy --prod --legacy /out

# ───────────── runtime stage ─────────────
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    STATIC_DIR=/app/public \
    PORT=8080
COPY --from=build --chown=nonroot:nonroot /out/package.json ./package.json
COPY --from=build --chown=nonroot:nonroot /out/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /repo/apps/relay/dist ./dist
COPY --from=build --chown=nonroot:nonroot /repo/apps/client/dist ./public
USER nonroot
EXPOSE 8080
# distroless entrypoint is `node`.
CMD ["dist/index.js"]
