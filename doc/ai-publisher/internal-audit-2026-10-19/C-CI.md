# C1. CI на 4e644293: статус, локальное воспроизведение и реальное покрытие — внутренний аудит v2

> Внутренний аудит AI Publisher по плану v2 (19.10.2026), пакет C. Внутренняя независимость ролей, не внешний аудит. Код и `ci.yml` не менялись.

## 1. Статус CI в GitHub — **не проверен из песочницы (blocked для пакета C)**

`curl https://api.github.com/repos/tarasenkoandriii/viral4creators/commits/4e644293…/check-runs` и `gh api`/`gh run list` → 403 «GitHub access to this repository is not enabled for this session». Ответ сохранён: `/tmp/ia-c-checkruns.json`.

**Что проверить главному агенту (браузер, GitHub Actions):**

1. Прогон workflow `CI` для `4e644293b3a40e834b28a603ff8ba01c0782f707`: итог сборщика `ci`, джобы `sites-backend`, `publisher-site`, `publisher-stand` («Publisher — сквозные E2E-01…05 против настоящего sites-backend и сайта»), `assist`, `repo` — success / skipped.
2. **Важно:** `scripts/ci-changes.mjs` на push сравнивает с коммитом последнего УСПЕШНОГО прогона. Сам `4e644293` (98 файлов, Story-Tales) не трогает ни одного пути правила `publisher_stand` и затрагивает 2 файла `sites-backend/` (`src/shared/ai-pricing*`) — поэтому при зелёном прогоне предыдущего коммита `publisher-stand` на `4e644293` будет **skipped**, а «зелёный CI» ничего не скажет о Publisher E2E. Нужно найти последний прогон, где `publisher-stand` реально исполнился (success), и убедиться, что его commit не раньше `9ec88dc8` (19.10 10:39 +03, последний коммит в путях `publisher_stand`: `qa-run-evidence.ts`), а также что исполнялись оба шага — `--site` и `--reddit`. Для `sites-backend` — последний прогон не раньше `e2f7d0cc`/`4e644293`.
3. Приложить ID прогона и время; без этого статус DEF-C-06 остаётся `blocked`.

Отчёт разработчика 15.10 называет зелёные прогоны 38756765752 (`f4920d9`) и 38758530397 (`7600cdf`) с «Publisher E2E»; это более ранние коммиты (до `875c131a`, `9bbec187`, `9b052f3e`, `9ec88dc8`, изменивших сайт и `qa-run-evidence`) и не доказательство для `4e644293`.

## 2. Локальное воспроизведение (Publisher-часть CI) на 4e644293

Среда: Node 22.22.0 (CI — 24 по `.nvmrc`), PostgreSQL 16.15 + pgvector 0.6.0 (CI — образ `pgvector/pgvector:pg16`), Chromium 141.0.7390.37. Сборки — вне дерева (`/tmp/ia-c-backend/dist`, `$WORK/site`).

| Джоба / шаг CI | Локально | Итог |
|---|---|---|
| sites-backend: `npm ci`, `npm audit` | зависимости уже установлены; аудит зависимостей — пакет D1 | not_run |
| sites-backend: схемы + миграции на чистой базе | все 50 `migrations/2*/migration.sql` через psql (как `publisher-e2e.sh`); `prisma migrate deploy` невозможен — нативный schema-engine не скачивается (403 `binaries.prisma.sh`) | ok (эквивалент) |
| sites-backend: логин-роли CI | тем же SQL, что `ci.yml` 300–315 | ok |
| sites-backend: `migrate diff --exit-code`, `tsc --noEmit`, `eslint` | не выполнялись (нет schema-engine; типы/линт — не предмет C1; сборка `tsc -p tsconfig.build.json` — exit 0) | not_run (частично) |
| sites-backend: `jest --ci` | **только часть Publisher**: 171 набор — 1 632/1 657 passed; 25 падений — условия среды: 1 тест ждёт `_prisma_migrations` (создаёт `migrate deploy`) → после воссоздания таблицы 118/118 passed; 24 теста `qa-catalog/*.database.spec` требуют базу с именем `sites` → на отдельном кластере аудитора 174/174 passed (18 наборов). Итог — **все наборы Publisher зелёные** | passed |
| sites-backend: полный jest (~5 300 тестов, не-Publisher модули) | вне охвата C | not_run |
| publisher-site: `tsc --noEmit` | exit 0 (`ps-tsc.log` md5 `ccbcc4e49f4bdecbe89ab8a3188af082`) | passed |
| publisher-site: `npm test` (sync-shared `--check` + 13 unit-скриптов) | exit 0 (`ps-test.log` md5 `ce7e55d13973db6beb4ec33247b0699d`) | passed |
| publisher-site: `budget:js` | на сборке стенда: контент 105,5 КБ, `/contact` 111,2 КБ, трекер 2 079 Б (бюджет 2 560) | passed |
| publisher-site: lint, prettier, check:built, axe, e2e на моке, Lighthouse | не выполнялись (prettier запрещён брифом; браузерные проверки исполнены против настоящего API в C3) | not_run |
| **publisher-stand: `publisher-e2e.sh --site`** | 51/51 passed, сайт 7/7 (`C-E2E-protocols.md`) | passed |
| **publisher-stand: `publisher-e2e.sh --reddit`** | 32/32 passed (`C-reddit.md`) | passed |
| backend `jest admin-reddit` (джоба backend, часть Reddit Админки) | 3 набора, 62/62 | passed |
| admin `reddit.test.ts`, `sync-admin-reddit-shared --check` | ok; 29 копий совпадают | passed |
| repo: `ci-changes.mjs --self-test` | «правил 14, джоб с условием 13, сборщик ci ждёт 16, самотест — 149 случаев» (`ci-selftest.log` md5 `154095cd6cc0e2dde7735506f06003fe`) | passed |

**Итог воспроизведения:** всё исполненное — зелёное; не исполнены `npm ci`/`npm audit` (D1), `migrate diff` (нет движка), линт/формат, полный jest sites-backend вне Publisher, браузерные CI-проверки сайта на моке.

## 3. Что CI реально покрывает (на 4e644293)

1. **Серверная логика Publisher на настоящей Postgres** — 101 приёмочный набор `src/acceptance/publisher/*.spec.ts` с метками `[AT-…]` для всех 44 P0 и AT-RD-01…18 + модульные наборы `src/modules/publisher/` (контракты, гейты, триггеры, часы стенда, роль `publisher_public`). При `CI=true` без базы наборы падают, а не пропускаются (`ciDescribe`). Это основная доказательная база C1.
2. **Сквозные маршруты на настоящем backend и сайте** — джоба `publisher-stand` (закрывает DEF-C-06 по содержанию): E2E-01…05 в Chromium и E2E-RD-01/02 (Reddit M1/M2) по HTTP, артефакт `publisher-e2e` с JSON и журналами.
3. **Схема и миграции** (`prisma validate`, `migrate deploy` на чистой базе, `migrate diff` нативным движком), типы/линт трёх пакетов, синхронность копий, граф импортов.
4. **Публичный сайт против мок-стенда** — сборки noindex/index, бюджет JS, axe/320 px, e2e 138 проверок, Lighthouse.
5. **Reddit Админки** — backend `admin-reddit*`, admin `reddit.test.ts`, синхронность копий.

## 4. Чего CI не покрывает

1. **Условность запуска:** `publisher-stand` и `publisher-site` исполняются только при изменении своих путей с последнего успешного прогона — «зелёный CI на commit X» не означает, что E2E исполнялся на X (см. п. 1.2).
2. **IA-C-02 (S3):** правило `publisher_stand` (`scripts/ci-changes.mjs` стр. 162–174) не содержит миграций Reddit и Админки Publisher (`20261020090000_publisher_reddit`, `20261021090000_publisher_reddit_m2`, `20261023090000_publisher_admin_actor`, `20261024090000/093000/094500_publisher_reddit_audit_*`) и QA (`20261022…`, `20261025…`), хотя E2E-RD-01/02 исполняются этой джобой: изменение одной такой миграции запустит только jest `sites-backend`, но не E2E-RD. Правило `publisher_site` также не включает эти миграции (сайт их не читает — допустимо).
3. **Реальные устройства/браузеры** — только Chromium; Safari/WebKit/телефоны нет.
4. **Production:** Vercel, HTTPS домена `ai-publisher.org`, Blob (копии — файлы стенда), Vercel Cron (в т. ч. ретенция Reddit), реальные уведомления Telegram, второй канал телеметрии сайта (включён только при `VERCEL_ENV=production`, IA-C-01) — не проверяются.
5. **Целевое время и нагрузка** — порогов нет (DEF-C-08), Lighthouse на моке.
6. **Реальная модель AI** — только fake (пакет D2).
7. **Ручные остатки AT** (телефон, публичный URL после выпуска, утверждение уведомления о данных и `consent_map`, регламент ежедневной проверки очереди) — вне CI по определению.
8. **Отклонение среды CI ↔ аудит:** Node 24 в CI против 22 локально; результат локального прогона Node 24 не подтверждает.

Зелёный CI не заменяет сквозной протокол (внешний план §4 C): для шлюзов нужны `C-E2E-protocols.md`, `C-reddit.md`, `C3-nonfunctional.md`.

---

## Перепроверка 19.10 после исправлений (E1)

**Проверенная версия:** HEAD `4e644293` + незакоммиченные исправления FX-A/FX-B/FX-C: `git diff` 48 файлов (+1771/−235), sha256 диффа `0f11b3c23aa258f5a3fcf6bccbb739951b2d630af58a714be9a262d391ace7a0`; 13 новых файлов (в т. ч. миграция `20261026100000_publisher_reddit_policy_version`, `publisher-site/src/lib/landing-visits.ts`), список sha256 — `/tmp/ia-c-e1/untracked-sha256.txt` (sha256 `5256651d…e563225`). Дифф перепроверен в конце прогонов — не менялся. Сборка backend — `tsc` в `/tmp/ia-c-e1/backend/dist` (exit 0); все стенды — `flock -o` (фоновые серверы замок не держат). Время 12:56–13:19 UTC. Среда та же, что в первом проходе.

- **IA-C-02 → verified_closed.** `ci-changes.mjs`: правило `publisher_stand` содержит шаблон `PUBLISHER_MIGRATIONS` (каталоги миграций с `publisher`/`reddit` в имени). `--self-test`: «самотест — 172 случаев», ok (`/tmp/ia-c-e1/ci-selftest.log`). Исходный сценарий через `decide()` по каждой миграции ≥ 20261016 (`/tmp/ia-c-e1/ci-decide.log`): все 10 миграций Publisher/Reddit/Админки (включая новую `20261026100000_publisher_reddit_policy_version`) → `publisher_stand=true`; `qa_stands`, `qa_artifacts`, `qa_plans` → `false`. Наблюдение (не дефект): сид стенда пишет в таблицы QA (`seedQaRun`), а их миграции E2E не запускают — изменение QA-схемы проверит только jest.
- Новый workflow `.github/workflows/publisher-ai-eval.yml` (не закоммичен) — предмет пакета D2; в C не исполнялся.
- Статус CI в GitHub для исправлений неприменим, пока они не закоммичены; после коммита — проверить по п. 1 (DEF-C-06 остаётся `blocked`).
- Локально: jest Publisher 1 804/1 828 (24 — условие имени базы) + qa-catalog 179/179; E2E `--site` 51/51, `--reddit` 32/32; publisher-site `npm test` — exit 0, в т. ч. новый `landing-visits.test.ts` 126 проверок (`/tmp/ia-c-e1/ps-test.log` md5 `da03386cb6b55e1da12b19e09bc1834a`).
