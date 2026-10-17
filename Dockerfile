# Build stage: compile TypeScript with the full dependency set.
#
# `npm ci --ignore-scripts` is deliberate rather than incidental: the package's
# `prepack` script runs a build, and with `files: ["build"]` the sources are not in
# the runtime layer, so an install hook that tried to compile could fail.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Runtime stage: production dependencies only, no compiler, no sources.
FROM node:24-alpine AS runtime

LABEL org.opencontainers.image.title="stackoverflow-mcp" \
      org.opencontainers.image.description="MCP server for querying Stack Overflow" \
      org.opencontainers.image.source="https://github.com/gscalzo/stackoverflow-mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3008

# The official image already provides an unprivileged `node` user, so none is created
# here. Depending on the base image's user keeps the uid stable across rebuilds, which
# matters as soon as a volume is mounted.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/build ./build
RUN chown -R node:node /app
USER node

EXPOSE 3008

# `/health` answers 200 without touching the Stack Exchange API, so this probes the
# listener rather than the upstream service.
#
# `HOST` is intentionally *not* set. The server binds loopback by default and refuses
# to bind a routable address without `MCP_AUTH_TOKEN` and `ALLOWED_HOSTS`; that refusal
# is deliberate (see docs/adr/0004-http-hardening.md), so publishing the port is an
# explicit choice made with:
#
#   docker run -p 3008:3008 \
#     -e HOST=0.0.0.0 -e MCP_AUTH_TOKEN=<secret> -e ALLOWED_HOSTS=<public-host> \
#     -e STACKOVERFLOW_API_KEY=<key> ghcr.io/<owner>/stackoverflow-mcp:latest
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3008') + '/health').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "build/index.js"]
