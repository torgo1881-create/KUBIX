# syntax=docker/dockerfile:1
# Сборка и запуск Next-приложения. Тот же образ подходит для Railway,
# Render, Fly или любого VPS с Docker: PORT берётся из окружения.

FROM node:22-alpine AS deps
WORKDIR /app
# Playwright нужен только для браузерных тестов — браузеры в образ не качаем.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prebuild собирает автономную страницу и кладёт её в public/m, затем next build.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN addgroup -S app && adduser -S app -G app
# output: 'standalone' — сервер со всем нужным, без devDependencies.
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
