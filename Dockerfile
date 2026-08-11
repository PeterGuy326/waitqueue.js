# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim AS node-base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable \
	&& corepack prepare pnpm@8.15.9 --activate \
	&& pnpm config set store-dir /pnpm/store


FROM node-base AS api-deps

WORKDIR /workspace/wait-queue
COPY wait-queue/package.json wait-queue/pnpm-lock.yaml ./
RUN --mount=type=cache,id=waitqueue-api-pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile


FROM node-base AS api-production-deps

WORKDIR /workspace/wait-queue
COPY wait-queue/package.json wait-queue/pnpm-lock.yaml ./
RUN --mount=type=cache,id=waitqueue-api-prod-pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile --prod


FROM api-deps AS api-build

COPY wait-queue/tsconfig.json ./
COPY wait-queue/src ./src
RUN pnpm build


FROM node:24.18.0-bookworm-slim AS api-runtime-base

WORKDIR /app
ENV NODE_ENV=production
ENV APP_PORT=3000

COPY --from=api-production-deps --chown=node:node /workspace/wait-queue/node_modules ./node_modules
COPY --from=api-build --chown=node:node /workspace/wait-queue/dist ./dist
COPY --chown=node:node wait-queue/package.json ./package.json

LABEL org.opencontainers.image.title="waitqueue-api"
LABEL org.opencontainers.image.source="https://github.com/PeterGuy326/waitqueue.js"

USER node


FROM api-runtime-base AS migrate

COPY --chown=node:node wait-queue/sql ./sql
CMD ["node", "dist/migrate.js"]


FROM api-runtime-base AS api

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
	CMD node -e "fetch('http://127.0.0.1:3000/waitqueue/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/app.js"]


FROM node-base AS dashboard-deps

WORKDIR /workspace/admin-dashboard
COPY admin-dashboard/package.json admin-dashboard/pnpm-lock.yaml ./
RUN --mount=type=cache,id=waitqueue-dashboard-pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile


FROM dashboard-deps AS dashboard-build

ARG WAITQUEUE_API_URL=http://api:3000
ENV WAITQUEUE_API_URL=$WAITQUEUE_API_URL
ENV NODE_ENV=production

COPY admin-dashboard/next.config.js admin-dashboard/tsconfig.json ./
COPY admin-dashboard/src ./src
RUN pnpm build


FROM node:24.18.0-bookworm-slim AS dashboard

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3001

COPY --from=dashboard-build --chown=node:node /workspace/admin-dashboard/.next/standalone ./
COPY --from=dashboard-build --chown=node:node /workspace/admin-dashboard/.next/static ./.next/static
COPY --from=dashboard-build --chown=node:node /workspace/admin-dashboard/src/public ./public

LABEL org.opencontainers.image.title="waitqueue-control-room"
LABEL org.opencontainers.image.source="https://github.com/PeterGuy326/waitqueue.js"

USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
	CMD node -e "fetch('http://127.0.0.1:3001/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]


FROM node:24.18.0-bookworm-slim AS mock-hook

WORKDIR /app
ENV NODE_ENV=production
ENV MOCK_HOOK_HOST=0.0.0.0
ENV MOCK_HOOK_PORT=3101

COPY --chown=node:node examples/mock-hook.mjs ./mock-hook.mjs

USER node
EXPOSE 3101
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3101/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "mock-hook.mjs"]

