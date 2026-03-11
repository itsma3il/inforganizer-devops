# ─── Stage 1: install dependencies ──────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Install production deps only
RUN pnpm install --prod --frozen-lockfile

# ─── Stage 2: final image ─────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy installed modules from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY server/   ./server/
COPY client/   ./client/
COPY package.json ./

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server/server.js"]
