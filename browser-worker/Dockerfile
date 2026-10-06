# Браузерный воркер Э-С Ш3 (doc/DEPLOYMENT.md §6.25). НЕ Vercel и не узел
# реле живого входа: отдельный VPS (рекомендация) или отдельная сеть
# Docker на сервере, где нет секретов бэкенда (QA-ТЗ §4.2).
#
# Chromium — сборка Playwright ТОЙ ЖЕ версии, что `playwright-core` в
# package.json (протокол CDP совпадает); свежий браузер = обновить
# playwright-core и пересобрать образ (еженедельная пересборка — §6.25).
# Ставится только headless-оболочка Chromium и её системные зависимости
# (`--with-deps --only-shell`), без Firefox/WebKit и без полного Chrome.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp \
    BROWSER_WORKER_HEALTH_FILE=/tmp/browser-worker.health
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# dumb-init — PID 1 с пробросом SIGTERM: воркер успевает сдать идущие
# задания `shutdown` (повторяемый код), Chromium не остаётся сиротой.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init ca-certificates \
  && npx playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
  && chmod -R a+rX /ms-playwright

# Не root: песочница Chromium (user namespaces) требует непривилегированного
# пользователя; код в /app принадлежит root и только читается.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
