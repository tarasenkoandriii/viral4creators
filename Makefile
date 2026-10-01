# Полный локальный стенд (db + backend + TMA + admin + landing, все
# dev-входы включены) — см. docker-compose.dev.yml, doc/TELEGRAM-ADMIN.md.
# Базовый docker-compose.yml (без Telegram-контекста) этим Makefile'ом
# не управляется — см. docker-compose.yml.

COMPOSE = docker compose -f docker-compose.dev.yml

.PHONY: up down restart reset logs ps psql shell-backend seed-dev test ci ci-docs ci-sites

up:
	@test -f .env.docker || cp .env.docker.example .env.docker
	$(COMPOSE) --env-file .env.docker up -d --build

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart backend

# Сносит том с БД и поднимает заново с нуля.
reset:
	$(COMPOSE) down -v
	$(MAKE) up

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

psql:
	$(COMPOSE) exec db psql -U postgres -d viral4creators

shell-backend:
	$(COMPOSE) exec backend sh

test:
	$(COMPOSE) exec backend npm test

# ── Проверки, те же что в CI (.github/workflows/ci.yml, ТЗ §27) ────────
#
# Запускается БЕЗ докера, прямо в рабочей копии: `make ci`. Отличие от CI
# одно и важное: там Prisma-клиент сгенерирован (есть сеть до
# binaries.prisma.sh), поэтому `tsc` на бэкенде чист. В песочнице
# разработки клиента нет, и tsc выдаёт известный шум про PrismaService —
# поэтому здесь он не запускается вовсе, чтобы `make ci` не приучал
# игнорировать красный вывод. Тесты по той же причине идут с
# отключёнными диагностиками ts-jest.
#
# `prisma validate` первым шагом — под защитой, и это не мелочь.
# Команде нужна сеть до binaries.prisma.sh (она тянет schema-engine), а
# три строки выше прямо сказано, что в песочнице этой сети нет. То есть
# цель, написанная ДЛЯ песочницы, падала на первой же своей строке и
# ни разу не доходила до остальных.
#
# Цена этого выяснилась 27.09.2026 (сквозной аудит, находка Д-6):
# пороги покрытия живут в шаге 3, `make ci` до него не добирался, и
# четыре файла проседали ниже порога незамеченными — CI был красным, а
# смотрели на сборку Vercel. Один сломанный первый шаг спрятал всё, что
# за ним.
#
# Поэтому: недоступность binaries.prisma.sh — это пропуск с явным
# сообщением (схему всё равно проверит CI), а вот НЕВЕРНАЯ схема
# по-прежнему останавливает прогон. Разница между «не смогли
# проверить» и «проверили и плохо» здесь и проводится.
ci:
	@cd backend && out=$$(npx prisma validate 2>&1); status=$$?; \
	if [ $$status -eq 0 ]; then \
		echo "prisma validate: схема в порядке"; \
	elif echo "$$out" | grep -q 'binaries.prisma.sh'; then \
		echo "prisma validate ПРОПУЩЕН: нет сети до binaries.prisma.sh." \
			"Схему проверит CI — остальные шаги идут как обычно."; \
	else \
		echo "$$out"; exit $$status; \
	fi
	cd backend && npx eslint "src/**/*.ts" --max-warnings 0
	cd backend && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/viral4creators npx jest --ci \
		--transform '{"^.+\\.(t|j)s$$":["ts-jest",{"diagnostics":false}]}' \
		--coverage --coverageReporters=text-summary \
		--json --outputFile=jest-results.json
	cd frontend && npx tsc --noEmit -p tsconfig.json
	cd frontend && npm run -s lint
	cd frontend && for f in scripts/*.test.ts; do npx tsx "$$f" >/dev/null || exit 1; done
	cd frontend && npx vite build
	cd admin && npx tsc --noEmit -p tsconfig.json && npx next lint --max-warnings 0 && npx next build
	cd landing && npx tsc --noEmit -p tsconfig.json && npx next lint --max-warnings 0 && npx next build
	$(MAKE) ci-sites
	node scripts/sync-site-tma-kit.mjs --check
	cd assist && npx tsc --noEmit -p tsconfig.json
	cd assist && npm run -s typecheck:scripts
	cd assist && npm run -s lint
	cd assist && for f in scripts/*.test.ts; do npx tsx "$$f" >/dev/null || exit 1; done
	cd assist && npx vite build
	$(MAKE) ci-docs

# Только документы — быстрая проверка перед коммитом правок в doc/.
ci-docs:
	node scripts/sync-legal.mjs --check
	node scripts/check-docs.mjs

# sites-backend (Э0 ИИ-помощника; джоба `sites-backend` в CI). Тот же
# принцип, что у `ci`: недоступность binaries.prisma.sh — пропуск
# `prisma validate` с сообщением, неверная схема — остановка. Миграции и
# `migrate diff` — только в CI (нужен движок и Postgres с pgvector);
# тест изоляции под `assist_public` без SITES_DIRECT_URL пропускается с
# причиной в названии, а в CI обязателен.
#
# Клиент Prisma для `tsc`/`jest` в песочнице — генерацией с заглушкой
# движка (см. doc/DEPLOYMENT.md, раздел sites-backend).
ci-sites:
	@cd sites-backend && out=$$(npx prisma validate 2>&1); status=$$?; \
	if [ $$status -eq 0 ]; then \
		echo "sites-backend prisma validate: схема в порядке"; \
	elif echo "$$out" | grep -q 'binaries.prisma.sh'; then \
		echo "sites-backend prisma validate ПРОПУЩЕН: нет сети до binaries.prisma.sh." \
			"Схему проверит CI — остальные шаги идут как обычно."; \
	else \
		echo "$$out"; exit $$status; \
	fi
	cd sites-backend && npx tsc --noEmit
	cd sites-backend && npx eslint "src/**/*.ts" prisma.config.ts --max-warnings 0
	cd sites-backend && npx jest --ci
	node scripts/sync-sites-shared.mjs --check
	node scripts/check-sites-import-graph.mjs --self-test
	node scripts/check-sites-import-graph.mjs
