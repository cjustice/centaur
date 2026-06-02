FROM oven/bun:1.3.13-slim AS builder

WORKDIR /repo
ENV NODE_ENV=production

RUN bun install -g pnpm@10.28.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/harness-events/package.json packages/harness-events/package.json
COPY packages/rendering/package.json packages/rendering/package.json
COPY services/web/package.json services/web/package.json
RUN pnpm install --filter centaur-web... --frozen-lockfile

COPY packages/harness-events/ packages/harness-events/
COPY packages/rendering/ packages/rendering/
COPY services/web/ services/web/
RUN pnpm --filter centaur-web build

FROM oven/bun:1.3.13-slim

WORKDIR /repo
ENV NODE_ENV=production

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/harness-events ./packages/harness-events
COPY --from=builder /repo/packages/rendering ./packages/rendering
COPY --from=builder /repo/services/web ./services/web

WORKDIR /repo/services/web

EXPOSE 3003
ENV PORT=3003
CMD ["bun", "src/server.ts"]
