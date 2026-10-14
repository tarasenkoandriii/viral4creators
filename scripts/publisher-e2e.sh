#!/bin/bash
# AI Publisher — стенд сквозных маршрутов E2E-01…05 (интеграция Z-2b):
# свежая база из всех миграций → сид (кабинет, участники, хост) → собранный
# sites-backend (`dist`, AI без сети) → [сайт publisher-site + Chromium] →
# драйвер assist/scripts/publisher-e2e.ts (HTTP-клиент кабинета).
#
#   WORK=/tmp/pub-e2e PG=postgresql://postgres@localhost:55432 \
#     bash scripts/publisher-e2e.sh [--site | --reddit]
#
# `--reddit` — E2E-RD-01 пакета P-R (Reddit Manual MVP, M1): сервер с
# `PUBLISHER_REDDIT_ENABLED=true`, драйвер `assist/scripts/publisher-e2e-
# reddit.ts` (проект → 10 сообществ → снимки/review → 20 возможностей →
# score → блокировки) и E2E-RD-02 (M2 Studio: бриф → варианты → правка →
# QA → согласование → копирование → отметка о публикации, post и comment);
# сайт не нужен. `BACKEND_ROOT` — каталог с готовым
# `dist` (и `node_modules`, например ссылкой) вместо `sites-backend`: сборка
# не запускается, сид копируется рядом с этим `dist` (стенд без записи в
# рабочее дерево).
#
# Нужны: роли CI `publisher_public_ci`/`assist_widget_ci` в Postgres (как в
# CI), для `--site` — Chromium (`PLAYWRIGHT_BROWSERS_PATH`). Предаудит
# DEF-C-01 (Р-PUB-Z2-28): `dist` sites-backend старше `src` — скрипт сам
# собирает его (`nest build`; `PUB_E2E_NO_BUILD=1` — вместо сборки падает);
# сайт собирается в СВОЕЙ копии `$WORK/site` (свой `.next`, общий
# `node_modules` — ссылкой), порт сайта уходит драйверу
# (`PUB_E2E_SITE_PORT`), https-домен продукта — через CONNECT-прокси на
# свободном порту (не :443): два стенда с разными `WORK`/`PORT`/`SITE_PORT`
# не мешают друг другу.
#
# Только стенд (Р-PUB-Z2-21/22): `PUBLISHER_STAND_CLOCK=true` — часы стенда
# (`/__stand/publisher/clock`, Bearer CRON_SECRET) и триггер времени БД
# (`sites-backend/test/publisher-e2e/stand-db-clock.sql`);
# `PUBLISHER_STAND_BACKUP_DIR` — копии в файлах `$WORK/backups` вместо Blob.
# Оба действуют лишь при NODE_ENV=development|test и не на Vercel.
# `TRUSTED_PROXY_CIDRS` — локальный адрес доверенный, как прокси Vercel на
# проде: драйвер шлёт заявки с разными `X-Forwarded-For`, лимит формы на IP
# (окно сервера БД, часы стенда его не двигают) не склеивает их в один адрес.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-/tmp/pub-e2e}
PG=${PG:-postgresql://postgres@localhost:55432}
DB=${DB:-sites_pube2e}
PORT=${PORT:-4141}
SITE_PORT=${SITE_PORT:-3020}
MODE=${1:-}
mkdir -p "$WORK"
U="$PG/$DB"

# Порты — по процессу-слушателю (`npx`/`next` порождают детей: kill PID
# обёртки оставляет сервер жить, и следующий прогон говорит со старым).
free_port() {
  if command -v fuser >/dev/null 2>&1; then fuser -k "$1/tcp" >/dev/null 2>&1 || true
  elif command -v lsof >/dev/null 2>&1; then lsof -ti "tcp:$1" | xargs -r kill 2>/dev/null || true
  fi
}
stop() { free_port "$PORT"; rm -f "$WORK/server.pid"; }
stop_site() { free_port "$SITE_PORT"; rm -f "$WORK/site.pid"; }
stop
stop_site
sleep 1
psql "$PG/postgres" -qc "drop database if exists $DB" -c "create database $DB" || exit 1
psql "$U" -qc "create schema sites" -c "create schema extensions" || exit 1
for f in "$ROOT"/sites-backend/prisma/migrations/2*/migration.sql; do
  PGOPTIONS='-c search_path=sites -c client_min_messages=warning' psql "$U" -q -v ON_ERROR_STOP=1 -f "$f" || { echo "миграция $f"; exit 1; }
done
psql "$U" -qc "GRANT CONNECT ON DATABASE $DB TO assist_widget_ci" -c "GRANT CONNECT ON DATABASE $DB TO publisher_public_ci" >/dev/null
# Часы сервера БД стенда (Р-PUB-Z2-21): триггер только в базе стенда.
psql "$U" -q -v ON_ERROR_STOP=1 -f "$ROOT/sites-backend/test/publisher-e2e/stand-db-clock.sql" || exit 1

BACK=${BACKEND_ROOT:-$ROOT/sites-backend}
if [ -n "${BACKEND_ROOT:-}" ]; then
  # Готовый dist вне рабочего дерева: сид — копией рядом (он ищет `../../dist`).
  [ -f "$BACK/dist/main.js" ] || { echo "BACKEND_ROOT: нет $BACK/dist/main.js"; exit 1; }
  mkdir -p "$BACK/test/publisher-e2e"
  cp "$ROOT/sites-backend/test/publisher-e2e/seed.cjs" "$BACK/test/publisher-e2e/seed.cjs"
fi
cd "$ROOT/sites-backend"
# dist ≡ src (DEF-C-01): метка последней сборки этим скриптом
# (`dist/.publisher-e2e-build`; tsc с инкрементом не переписывает
# неизменённые файлы, поэтому время dist/main.js — не признак). Исходник
# новее метки или метки нет — сборка.
STAMP=dist/.publisher-e2e-build
newest=$(find src prisma/schema.prisma tsconfig.json -type f -newer "$STAMP" 2>/dev/null | head -1)
if [ -z "${BACKEND_ROOT:-}" ] && { [ ! -f dist/main.js ] || [ ! -f "$STAMP" ] || [ -n "$newest" ]; }; then
  if [ -n "${PUB_E2E_NO_BUILD:-}" ]; then
    echo "dist устарел (${newest:-нет dist/main.js}) — соберите sites-backend"; exit 1
  fi
  echo "сборка sites-backend: dist старше src (${newest:-нет dist})"
  touch "$WORK/.build-start"
  npx nest build > "$WORK/backend-build.log" 2>&1 || { echo "сборка sites-backend упала (backend-build.log)"; exit 1; }
  # Метка — время НАЧАЛА сборки: правка во время сборки даст пересборку.
  touch -r "$WORK/.build-start" "$STAMP"
fi
SITES_DATABASE_URL=$U node "$BACK/test/publisher-e2e/seed.cjs" "$WORK/seed.json" "${SITE_HOST:-pubsite.test}" || exit 1
# Раздел Reddit (P-R) — только для `--reddit`; иначе флаг выключен (по умолчанию).
# M2 (E2E-RD-02): генерация по HTTP — флаг генерации и стендовый
# fake-провайдер (`PUBLISHER_STAND_FAKE_AI`, только NODE_ENV=development|test
# и не Vercel; включает `pub.reddit.draft` только на стенде, Р-RD-73).
if [ "$MODE" = "--reddit" ]; then export PUBLISHER_REDDIT_ENABLED=true PUBLISHER_REDDIT_AI_ENABLED=true PUBLISHER_STAND_FAKE_AI=true; else unset PUBLISHER_REDDIT_ENABLED PUBLISHER_REDDIT_AI_ENABLED PUBLISHER_STAND_FAKE_AI; fi

E2E_SECRETS_KEY=e2e-secrets-key-0123456789 # gitleaks:allow — поддельный ключ стенда
export NODE_ENV=development PORT SITES_DATABASE_URL=$U SITES_DIRECT_URL="$U?schema=sites" \
  PUBLISHER_PUBLIC_DATABASE_URL="postgresql://publisher_public_ci:publisher_public_ci@${PG#postgresql://*@}/$DB" \
  ASSIST_PUBLIC_DATABASE_URL="postgresql://assist_widget_ci:assist_widget_ci@${PG#postgresql://*@}/$DB" \
  ASSIST_BOT_TOKEN='111111:AA-тестовый-токен-помощника' QA_BOT_TOKEN='222222:BB-тестовый-токен-qa' \
  CRON_SECRET=e2e-cron-secret ASSIST_SECRETS_KEY="$E2E_SECRETS_KEY" ASSIST_SECRETS_KEY_VERSION=v1 \
  CORS_ORIGIN=http://localhost:5174 PUBLISHER_AI_ALLOW_UNEVALUATED=true \
  PUBLISHER_SITE_URL=http://localhost:$SITE_PORT PUBLISHER_REVALIDATE_SECRET=e2e-revalidate-secret-0123 \
  PUBLISHER_STAND_CLOCK=true PUBLISHER_STAND_BACKUP_DIR="$WORK/backups" \
  TRUSTED_PROXY_CIDRS="127.0.0.0/8,::1/128"
rm -rf "$WORK/backups"
NODE_OPTIONS=--max-old-space-size=1024 node "$BACK/dist/main.js" > "$WORK/server.log" 2>&1 &
echo $! > "$WORK/server.pid"
for i in $(seq 1 60); do curl -sf "localhost:$PORT/health" >/dev/null && break; sleep 1; done

cd "$ROOT/assist"
export PUB_E2E_API=http://localhost:$PORT PUB_E2E_SEED="$WORK/seed.json" PUB_E2E_DB="$U" PUB_E2E_SITE_PORT=$SITE_PORT
if [ "$MODE" = "--reddit" ]; then
  PUB_E2E_OUT="$WORK/e2e-reddit.json" npx tsx scripts/publisher-e2e-reddit.ts
  rc=$?
  [ -n "${KEEP_SERVER:-}" ] || stop
  exit $rc
fi
if [ "$MODE" != "--site" ]; then
  PUB_E2E_OUT="$WORK/e2e.json" npx tsx scripts/publisher-e2e.ts
  rc=$?
  [ -n "${KEEP_SERVER:-}" ] || stop
  exit $rc
fi

# ── С сайтом: фаза a (контент, закупка) → сборка и запуск publisher-site →
#    браузер (метка → материал → форма) → фаза b (кабинет по номеру заявки).
PUB_E2E_PHASE=a PUB_E2E_OUT="$WORK/e2e-a.json" npx tsx scripts/publisher-e2e.ts > "$WORK/phase-a.log" 2>&1
tail -3 "$WORK/phase-a.log"
KEY=$(node -e 'console.log(require(process.argv[1]).ctx.publicKey)' "$WORK/e2e-a.json")
# Своя копия сайта: `.next` стенда не трогает рабочее дерево и другие стенды.
rm -rf "$WORK/site"; mkdir -p "$WORK/site"
(cd "$ROOT/publisher-site" && tar --exclude=./node_modules --exclude=./.next -cf - .) | (cd "$WORK/site" && tar -xf -)
ln -s "$ROOT/publisher-site/node_modules" "$WORK/site/node_modules"
cd "$WORK/site"
env -u NODE_ENV SITE_URL=https://${SITE_HOST:-pubsite.test} PUBLISHER_API_ORIGIN=http://localhost:$PORT PUBLISHER_PUBLIC_KEY=$KEY \
  PUBLISHER_REVALIDATE_SECRET=e2e-revalidate-secret-0123 NODE_OPTIONS=--max-old-space-size=2048 \
  npx next build > "$WORK/site-build.log" 2>&1 || { echo "сборка сайта упала (site-build.log)"; stop; exit 1; }
env -u NODE_ENV SITE_URL=https://${SITE_HOST:-pubsite.test} PUBLISHER_API_ORIGIN=http://localhost:$PORT PUBLISHER_PUBLIC_KEY=$KEY \
  PUBLISHER_REVALIDATE_SECRET=e2e-revalidate-secret-0123 npx next start -p $SITE_PORT > "$WORK/site.log" 2>&1 &
echo $! > "$WORK/site.pid"
for i in $(seq 1 60); do curl -sf "localhost:$SITE_PORT/" >/dev/null && break; sleep 1; done
SITE_HOST=${SITE_HOST:-pubsite.test} NEXT_PORT=$SITE_PORT CTX="$WORK/e2e-a.json" \
  WORK="$WORK" OUT="$WORK/site.json" node scripts/built/z-e2e-site.mjs
site_rc=$?
cd "$ROOT/assist"
PUB_E2E_PHASE=b PUB_E2E_CTX="$WORK/e2e-a.json" PUB_E2E_SITE_RESULT="$WORK/site.json" PUB_E2E_OUT="$WORK/e2e.json" \
  npx tsx scripts/publisher-e2e.ts
rc=$?
stop_site
[ -n "${KEEP_SERVER:-}" ] || stop
[ $site_rc -ne 0 ] && rc=1
exit $rc
