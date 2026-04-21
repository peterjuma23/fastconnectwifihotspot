FROM node:20-alpine AS base
RUN apk add --no-cache openssh-client curl

WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production

FROM base AS build
COPY package*.json ./
RUN npm ci
COPY . .

FROM base AS runner
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 fastconnect

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=fastconnect:nodejs . .

RUN mkdir -p logs backups && chown -R fastconnect:nodejs logs backups

USER fastconnect
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
