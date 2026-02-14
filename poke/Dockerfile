FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy dependency files first for caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/orchestrator/package.json ./packages/orchestrator/
COPY packages/sandbox/package.json ./packages/sandbox/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY poke/ ./poke/
COPY generated-repos/ ./generated-repos/

# Build workspace
RUN pnpm build

EXPOSE 8787

CMD ["npx", "tsx", "poke/server.ts"]
