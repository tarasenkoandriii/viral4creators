# doc/LIVE-LOGIN-RELAY-SPEC.md §11. Не используется для Vercel — этот
# сервис не деплоится туда вообще (§7.4.9 doc/CLIENT-SITE-TUTORIAL-SPEC.md
# — постоянный контейнер, площадка Dokploy).

FROM node:24-bookworm-slim

# Chromium + минимальные системные библиотеки (шрифты — иначе часть
# страниц с кастомными шрифтами рендерится «коробками», что мешает
# человеку прочитать капчу/форму входа). dumb-init — PID 1 с корректным
# пробросом сигналов: без него SIGTERM от Dokploy при остановке/
# передеплое не долетает штатно до дочерних процессов Chromium, и
# грейсфул-шатдаун (§13) не успевает отработать.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Путь подтверждается на этапе первой сборки образа
# (`docker run --rm <образ> which chromium`) — если у конкретной версии
# Debian-пакета он отличается, меняется ТОЛЬКО эта строка: весь
# остальной код реле не завязан на конкретный путь, только на
# переменную окружения (см. src/launch-browser.ts, §6 спеки).
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Двухфазная установка — сначала рантайм-зависимости, потом временно
# докатить dev-зависимости для сборки TS и prune их обратно: финальный
# слой образа не тащит typescript/jest в прод-контейнер.
COPY package*.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --include=dev && npm run build && npm prune --omit=dev

# Не root (Ш0.2, риск К-1 аудита docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md).
# Chromium здесь исполняет JS чужих сайтов с `--no-sandbox` (без
# user namespaces песочница в контейнере не поднимается). Эксплойт
# рендерера при root-процессе получал бы root в контейнере; под `node`
# (uid 1000, есть в базовом образе) — непривилегированного пользователя
# без прав на код в /app (он принадлежит root и только читается).
# Профиль браузера puppeteer кладёт во временный каталог (/tmp), HOME
# пользователя — /home/node: обоим `node` писать может.
USER node

EXPOSE 8088
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
