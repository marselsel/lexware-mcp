# syntax=docker/dockerfile:1

# Dockerfile for a Skybridge MCP server.
#
# Detects npm, yarn, or pnpm from the lockfile in your project.
# (For bun or deno, adapt the install/build/prune commands below.)

# Build stage: install deps, compile the app, then prune dev deps.
FROM node:26-slim AS build
WORKDIR /app

COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* .npmrc* ./
# Note: no BuildKit `--mount=type=cache` here, so this builds on the classic
# Docker builder too (e.g. Cloud Build's default `docker build`).
RUN if [ -f package-lock.json ]; then \
      npm ci; \
    elif [ -f yarn.lock ]; then \
      corepack enable yarn && yarn install --frozen-lockfile; \
    elif [ -f pnpm-lock.yaml ]; then \
      corepack enable pnpm && pnpm install --frozen-lockfile; \
    else \
      echo "No lockfile found." && exit 1; \
    fi

ENV NODE_ENV=production

COPY . .
RUN if [ -f package-lock.json ]; then \
      npm run build && npm prune --omit=dev; \
    elif [ -f yarn.lock ]; then \
      corepack enable yarn && yarn build && yarn install --frozen-lockfile --production=true; \
    elif [ -f pnpm-lock.yaml ]; then \
      corepack enable pnpm && pnpm build && pnpm prune --prod; \
    fi

# Runtime stage: copy built artifacts and prod deps, run as non-root.
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Default listen port. Cloud Run overrides PORT at runtime; the server reads it.
ENV PORT=8080

USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run the built server directly rather than via `npm start` / `skybridge start`.
# Each wrapper adds a process layer that can swallow SIGTERM, which makes
# graceful shutdowns time out on platforms like Cloud Run, Fly, and k8s.
CMD ["node", "dist/server.js"]
