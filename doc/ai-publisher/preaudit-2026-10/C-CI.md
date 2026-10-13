# C1. Воспроизведение CI (часть Publisher) и что он реально покрывает

> Внутренний предаудит. Не является независимым внешним аудитом по плану v1.1 §1; не заменяет внешнее заключение. Цель — подготовить пакет передачи (Приложение B) и снять очевидные дефекты до внешнего прохода.

> **В репозиторий входят только markdown/csv.** Пути вида `logs/…`, `ev/…`, `evidence/…`, `e2e2/…`, `c3/…`, `probe/…` указывают на сырые доказательства в рабочем каталоге предаудита (scratchpad) — они хранятся отдельно и передаются внешнему исполнителю по запросу с ограниченным доступом (план §18); md5 приведены в тексте.

Источник: `.github/workflows/ci.yml` (sha256 в `manifest-stand.sha256`), джобы `sites-backend`, `assist`, `publisher-site`, часть `repo`. Локально, 13.10.2026, Node 24.21.0, PostgreSQL 16.13 (вместо `pgvector/pgvector:pg16`). Код не правился; сборки сайта — в копии `c/w/publisher-site` (общий `.next` не трогался), сборка assist — `vite build --outDir c/assist-dist` (удалена). Логи — `logs/ci-sb/`, `logs/ci-assist/`, `logs/ci-ps/`, `logs/ci-repo/`, md5 — `md5.txt` в каждом каталоге.

## Результаты

### sites-backend (`logs/ci-sb/`)

| Шаг CI | Локально | Итог |
|---|---|---|
| `npm ci`, `npm audit --audit-level=high --omit=dev` | не выполнялись: зависимости уже установлены в дереве; аудит зависимостей — этап D | not_run |
| `prisma validate` | выполнен | exit 0 |
| схемы + `migrate deploy` на чистой базе | накат всех `migrations/2*/migration.sql` через psql (`reset-db.sh`, 208 таблиц) — эквивалент без `_prisma_migrations` | ok |
| логин-роли `assist_widget_ci`, `publisher_public_ci` | уже существуют в кластере | ok |
| `migrate diff --exit-code` | нативный движок недоступен; wasm-движок падает на CHECK QA (`02-migrate-diff.log`, известное ограничение Р-PUB-A0-1/2); на временной базе со снятыми 7 CHECK вне `pub_*` — **пусто, exitCode 0** (`02c-migrate-diff.log`) | ok (с оговоркой) |
| `tsc --noEmit` | весь проект | exit 0 |
| `eslint "src/**/*.ts" prisma.config.ts --max-warnings 0` | весь src | exit 0 (64 с) |
| `jest --ci` (весь набор ~2 850 тестов) | **только часть Publisher**: `src/acceptance/publisher/*` по файлу (72 файла, 469 тестов) + `src/modules/publisher/`, `src/prisma/`, `app.setup.publisher` одним прогоном (42 набора, 602 теста) | 1 071/1 071 passed |
| `sync-sites-shared --check` | | exit 0 |
| граф импортов (самотест + проверка) | | exit 0 |

### assist (`logs/ci-assist/`)

`sync-site-tma-kit --check` 0; `tsc --noEmit` 0; `typecheck:scripts` 0; `lint` 0; `npm test` — 60 скриптов, exit 0 (в т. ч. `publisher-api`, `publisher-bodies`, `publisher-ops-api`, `publisher-ops-view`, `publisher-router`, `publisher-view`); `vite build` ok. `npm ci`/`npm audit` — not_run.

### publisher-site (`logs/ci-ps/`)

| Шаг CI | Итог |
|---|---|
| `tsc --noEmit`, `lint` | 0, 0 |
| `prettier --check` | 1 — только из-за файла пробы предаудита `scripts/c3-probe.mjs` в копии; без него — 0 (`03b-…`) |
| `npm test` (sync-shared `--check` + 13 unit-скриптов) | 0 |
| стенд API (`stand.ts`, :3221 вместо 3021) | поднят |
| сборка без `SITE_URL` падает с «SITE_URL не задан» | ok |
| тестовая сборка → `check:built --expect-noindex` | ok |
| сборка с двумя ключами → `check:built --expect-indexable` | ok |
| `budget:js` (контент ≤ 118 КБ, `/contact` ≤ 130 КБ, трекер ≤ 2 КБ) | ok: 105,1 КБ, трекер 1 957 Б |
| `next start` (:3220) + `check:built --base-url` | ok: 6 страниц, 410 снятых |
| `axe` | ok: 28 прогонов, 0 нарушений, 320/360 px |
| `e2e` | ok: 138 проверок |
| Lighthouse CI (Chromium 141 через `CHROME_PATH`) | ok: Perf 0,99 / A11y 1 / SEO 1 на трёх URL |
| `npm ci`, `npm audit`, `playwright-core install` | not_run (браузер — `/opt/pw-browsers`) |

### repo (часть)

`check-docs.mjs --no-jest` 0; `ci-changes.mjs --self-test` 0.

**Итог воспроизведения: все исполненные шаги зелёные; не исполнены `npm ci`/`npm audit` (этап D) и полный jest sites-backend вне Publisher (вне охвата этапа C).**

## Что CI реально покрывает

1. **Серверную логику Publisher на настоящей Postgres** — 70 приёмочных наборов с метками `[AT-…]` для всех 44 P0 и модульные наборы (контракты, гейты, часы стенда, ротация копий, роль `publisher_public`). При `CI=true` без базы наборы падают, а не пропускаются (`ciDescribe`). Это основная доказательная база C1.
2. **Схему и миграции**: `prisma validate`, накат на чистую базу, `migrate diff` (в CI — нативный движок).
3. **Типы/линт/формат** всех трёх пакетов, синхронность копий (`sync-sites-shared`, `site-tma-kit`, `lead-validation` сайта), граф импортов.
4. **UI-кабинет (assist)** — unit-скрипты на модели представлений: «не розраховується» (AT-CORE-18), балл ≠ полнота (AT-F10-01), 409 → перезагрузка (AT-CORE-10), контракт клиента ↔ контракты сервера.
5. **Публичный сайт против мок-стенда**: сборки noindex/index, метаданные, sitemap/robots, 410; бюджет JS; axe/320 px; e2e 138 проверок (клавиатура, отказы, повтор, 5 параллельных, 429, sessionRef/unknown, без JS); Lighthouse.

## Чего CI не покрывает

1. **Сквозные маршруты E2E-01…05 на настоящем backend** (`scripts/publisher-e2e.sh --site`, 49 шагов) — вне CI (`doc/CI.md`: нужны dist, `next build`, Chromium, порт 443). Запуск — вручную; результат зависит от свежести `sites-backend/dist` (DEF-C-01).
2. **Сайт ↔ настоящий публичный API**: все браузерные проверки CI — против мока `stand.ts`; правка публичных контроллеров backend не запускает джобу сайта (`ci-changes.mjs`: `publisher_site` смотрит только `publisher-site/`, `brand.ts`, `publisher/contracts/`, `core/content-hash.ts`) — DEF-C-06.
3. **Реальные устройства/браузеры** — только Chromium (CI ставит `playwright-core install chromium`); Safari/WebKit/мобильные устройства нет.
4. **Целевое время и нагрузка** — Lighthouse с порогами на моке; протокол `perf_targets` «без жёсткого порога в CI» (IMPLEMENTATION-DESIGN §16.8), нагрузочного профиля нет.
5. **Реальная модель AI** — только fake (набор 30 задач в CI — механика, «fake никогда не открывает порог»); прогон на реальной модели — этап D.
6. **Развёртывание**: Vercel, HTTPS домена, Blob (резервные копии — только локальное хранилище стенда), cron Vercel, реальные уведомления Telegram — не проверяются.
7. **Ручные остатки AT** (телефон, публичный URL после выпуска, утверждение уведомления о данных и `consent_map`, регламент ежедневной проверки очереди) — вне CI по определению.
8. **Полный jest sites-backend** (не-Publisher модули) в этом воспроизведении не запускался; CI запускает его целиком.

Зелёный CI не заменяет сквозной протокол (план §4 C): для шлюзов нужны `C-E2E-protocols.md` и `C3-nonfunctional.md`.


## Изменения CI после предаудита (Z-2c, Р-PUB-Z2-29; закрывают DEF-C-06 до внешней перепроверки)

- `scripts/ci-changes.mjs`: правило `publisher_site` теперь срабатывает и на `modules/publisher/public/` и миграции ядра Publisher; новое правило `publisher_stand` — модуль Publisher, его три миграции, `qa-catalog/qa-run-evidence.ts`, стенд, сайт, клиент assist, драйвер E2E. Самотест — 117 случаев, ok.
- `.github/workflows/ci.yml`: новая джоба `publisher-stand` — Postgres-сервис (pgvector, как у `sites-backend`), три `npm ci`, Chromium, миграции и логин-роли, `bash scripts/publisher-e2e.sh --site`, артефакт JSON и журналы, лимит 45 мин. Имя без цифр — требование парсера `ci-changes`.
- Проверено локально: `actionlint` 1.7.7 — чисто; `check-vercel-ignore` — ok; `ci-changes --self-test` — ok.
- **Не проверено:** реальный запуск джобы в GitHub Actions (раннера в песочнице нет). Время и стабильность покажет первый прогон; локально скрипт идёт около 8 минут без `npm ci`.
- Зелёный CI по-прежнему не заменяет сквозной протокол (план §4 C).
