# syntax=docker/dockerfile:1.7

# ─── Stage 1: build ─────────────────────────────────────────────
# Compile TypeScript to JS in a stage that has dev deps + the
# native build chain for better-sqlite3. We DON'T ship this stage
# to production — only the compiled dist/ + node_modules go forward.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native build deps for better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# `--include=dev` is REQUIRED here. Coolify (and most orchestrators)
# inject NODE_ENV=production as a build-time env var so the runtime
# stage gets the right setting. When NODE_ENV=production is in scope,
# `npm ci` quietly skips devDependencies — which means `typescript`
# (and therefore `tsc`) never gets installed, and `npm run build` dies
# with `sh: 1: tsc: not found`. The explicit flag overrides NODE_ENV
# for this single command and guarantees the build toolchain lands.
# The final image is unaffected: `npm prune --omit=dev` below strips
# devDeps after the JS is compiled.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDeps so the production image carries only what runs.
RUN npm prune --omit=dev

# ─── Stage 2: runtime ───────────────────────────────────────────
# Minimal Node image — no compilers, no source, no devDeps.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MCP_DB_PATH=/app/data/mcp.sqlite

# Drop root — the container only needs to read its app dir and
# write to /app/data (mounted as a Coolify volume in prod).
RUN useradd --system --uid 10001 --create-home mcp && \
    mkdir -p /app/data && \
    chown -R mcp:mcp /app

COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --from=build --chown=mcp:mcp /app/package.json ./package.json
# Static assets (logo + favicon) served by express.static and used
# in the OAuth login page.
COPY --chown=mcp:mcp public ./public

USER mcp
EXPOSE 3000

# Coolify (and most orchestrators) probe /health every few seconds.
# Failing the check tears the container down and pulls a fresh one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http-server.js"]
