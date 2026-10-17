FROM node:24-bookworm-slim AS runtime

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY . .
RUN pnpm install --prod --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 4002 4003 4004 4005 4006
USER node
ENTRYPOINT ["/app/docker/entrypoint.sh"]

FROM node:24-bookworm-slim AS migrations

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile

USER node
ENTRYPOINT ["pnpm", "exec", "drizzle-kit", "migrate"]
