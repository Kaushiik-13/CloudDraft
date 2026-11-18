FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm mcp:build

ENV NODE_ENV=production \
  CHROMIUM_PATH=/usr/bin/chromium \
  CHROMIUM_NO_SANDBOX=1 \
  PORT=10000

EXPOSE 10000

CMD ["node", "tools/mcp/server.mjs", "--http"]
