> Внутренний аудит AI Publisher v2, пакет AB (A2 реестр + B1 трассировка). Независимость — только внутренняя, между ролями: все исполнители — агенты одной модели в одной сессии (план v2 §1). Это не внешний аудит.

# AB. Охват, дельта к предаудиту 13.10 и что перепроверить в C/D

- **Дата:** 19.10.2026.
- **Проверенная версия:** commit `4e644293` (= origin/main). Рабочее дерево совпадает с коммитом. Единственное отличие — неотслеживаемый `doc/ai-publisher/internal-audit-plan-v2.md`: sha256 `deece76a…4fcb`, в коммит не входит.
- **Исполнитель:** аудитор пакета AB. Код и требования не правились. git использовался только на чтение.
- **Глубина:**
  - чтение требований, дизайна, TODO, DEPLOYMENT и кода;
  - sha256-сверка;
  - выборочные jest-прогоны на собственной БД `ia_ab_sites`. Миграции накатаны psql, как в `scripts/publisher-e2e.sh`.
  - Стенд E2E и production не использовались.

## 1. Манифест

| | Предаудит 13.10 | AB 19.10 |
|---|---|---|
| Файл | `preaudit-2026-10/manifest-sha256.txt` | [`AB-manifest-sha256.txt`](AB-manifest-sha256.txt) |
| sha256 манифеста | `8114b558…54d0` | `af71afbc2fe7dab6cfbabaeeb59f699ed675a2ae0b1dfa8517fea1a17e0083dc` |
| Файлов | 1 702 | 1 893 |
| Корни | sites-backend/src, sites-backend/prisma, assist/src, publisher-site/src, doc/ai-publisher (без каталогов аудитов) | те же + `backend/src/modules/admin-panel/admin-reddit.*` (6) + `admin/src/app/reddit` (1) |

По корням: sites-backend/src — 1 454, prisma — 52, assist/src — 299, publisher-site/src — 40, doc/ai-publisher — 41, admin-reddit backend — 6, admin/app/reddit — 1.

**Корни плана v2 неполны (IA-AB-10):**

- корня `backend/src/modules/admin-reddit*` не существует: файлы лежат в `admin-panel/admin-reddit.*`;
- `admin/src/app/reddit` — это один `page.tsx`.

Дополнительный манифест [`AB-manifest-extra-sha256.txt`](AB-manifest-extra-sha256.txt) — 74 файла, sha256 `13839a54…7d44`. В него вошли:

- интерфейс «Reddit» Админки: `admin/src/components/reddit/**`, `admin/src/lib/reddit*.ts`, `admin/src/lib/reddit-shared/**`;
- `backend/src/app.setup.ts`, `admin-panel.module.ts`;
- `publisher-site/next.config.js` (CSP);
- `vercel.json` трёх проектов;
- скрипты стенда, `assist/scripts/publisher-*`, `sites-backend/test/publisher-*`;
- отчёты `doc/reports/reddit-*`;
- `doc/{TODO,DEPLOYMENT,CI}.md`, `README.md`, `ci.yml`.

**Манифест предаудита не равен коммиту `342db71e` (IA-AB-11).**

- 16 файлов отличаются по хешу, 7 файлов коммита в манифесте отсутствуют.
- Причина: предаудит снят с рабочего дерева до слияния параллельных коммитов 13.10 (`a25af592…61e46d1e`, assist/cron).
- Среди отличающихся — `publisher/ai/eval/fixtures.ts`: его версия в манифесте не совпадает ни с одним коммитом.
- Вывод: доказательства предаудита к коммиту не привязаны. Переносить их нельзя, можно только повторять.

## 2. Дельта (манифест 13.10 → 4e644293)

Полный список с модулем и коммитами — [`AB-delta-files.csv`](AB-delta-files.csv).

| Изменение | Файлов |
|---|---|
| изменено | 171 |
| добавлено | 192 |
| удалено | 1 (`platform-admin/internal-secret.guard.ts` → `common/internal-secret.guard.ts`, Р-RD-ADM-6) |
| из них не менялись после 342db71e (расхождение «дерево предаудита ≠ коммит») | 21 |

### По модулям реестра

| Модуль | Добавлено | Изменено | Суть |
|---|---|---|---|
| M29 Reddit P-R (M1/M2) | 103 | — | пакет `publisher/reddit/**`, контент-ветви Reddit, генератор `pub.reddit.draft`, набор eval 2.3, импорт, экраны assist, 4 миграции |
| M30 Reddit Админка | 18 | −1 (перенос) | внутренний API `/internal/admin/reddit/**`, актор `admin:`, прокси backend, `page.tsx` |
| M01 publisher — P0-код (не Reddit) | 3 | 75 | см. ниже: общий P0-код изменён ради P-R |
| M02 общие механизмы sites-backend | 7 | 17 | `app.setup.ts`, `config/publisher-env.ts`, `tenant.ts`, `common/*` (cron partial errors, provider status), ai-pricing/gemini-client |
| M03 qa-catalog / qa-stands | 54 | 18 | `acceptanceStatus` (automated passed без `runnerStatus=passed` → blocked), артефакты, планы, инвентарь, новый модуль qa-stands |
| M04 помощник/QA | 2 | 21 | chat-model, indexing, ui-plan, browser-jobs |
| M05 assist — экраны Publisher | 2 | 29 | Reddit-экраны, `common-pure` (повтор с тем же opKey), `confirmClick` |
| M06 assist — общие | 2 | 8 | кит, QA-экраны |
| M07 publisher-site | 1 | 2 | второй канал телеметрии `LandingVisits` (IA-AB-03) |
| M27 doc/ai-publisher | 2 | 1 | `reddit-manual-mvp-adapted.md`, `reddit-manual-mvp-v1.3-source.md`; IMPLEMENTATION-DESIGN (§12.6, §13, §18.5, §28) |

### P0-код, изменённый пакетом P-R

Это главный риск для переноса доказательств: менялись файлы, по которым 44 AT прошли 13.10.

- **AI-шлюз и eval.** Затронуты `gateway-core.ts`, `protocol.ts`, `tasks.ts`, `cli-gateway.ts`, `fake-answers.ts`, `auto-checks.ts`.
  - Порог обобщён на N задач. Для набора 2.2 он по-прежнему 30/24, для 2.3 — 42/34.
  - В режиме eval разрешён выключенный, но покрытый набором генератор.
  - Добавлен обход стенда `PUBLISHER_STAND_FAKE_AI`; по коду он действует только вне Vercel.
- **Контент:** `contents.service.ts` (+462), `approvals-publish.service.ts` (+120), `blockers.ts`, `revocation.service.ts`, `sources.service.ts`, `content-port.ts`, `rules.ts`, `source-import.ts` (отказ `reddit_manual_only`).
- **Гейты и параметры:** `gates.ts` — новый гейт `reddit_publish`; `purchases_disabled` при `per_purchase_max=0`. Ключей параметров 38 → 40.
- **Ядро:** `states.ts`, `operation.ts`, `roles.ts`, `ports.ts`, `table-registry.ts`.
- **Распространение:** `publications.service.ts` (+197), `budget-math.ts`, `placements.service.ts`.
- **Отчёты:** `restore.service.ts`.
- **Схема:** `schema.prisma` +301.
- **Триггеры P0, изменённые миграциями:**
  - `20261023090000_publisher_admin_actor`: `pub_is_actor`, `pub_is_admin`, `pub_is_person`, проверки `*By` во всех P0-таблицах;
  - `20261024094500_publisher_reddit_audit_m2`: `pub_publication_guard`.

### Группы коммитов (`git log 342db71e..HEAD` по корням)

- **Reddit P-R:**
  - `9cf9ff01` — ТЗ;
  - `37510b6b` — M1;
  - `0b0fa049` — M2;
  - `4b696ec8`, `d39a099c`, `1a19c99b` — импорт;
  - `08264424`, `f60e796c` — доработка импорта и проверки готовности;
  - `668a9b07`, `012006a5`, `943bef3e`, `f4920d9b` — аудит 15.10 и Р-RD-AUD-1…9.
- **Reddit Админка:** `eae0cc7c`, `8b1703de`, `67c6e59f`, `2d4d1813` (production: флаг и sandbox-сайт).
- **QA-стенды и каталог** (вне P0, но qa-catalog — носитель `launch_evidence`): `6a44223e…5c793ce3`, 18 коммитов; затем `9ec88dc8`, `d0006699`, `e2f7d0cc`.
- **Помощник, голос, AI:** `b0d1fe71…b1628480`, 8 коммитов.
- **Телеметрия лендингов → publisher-site:** `875c131a`, `9bbec187`, `9b052f3e`.
- **Story-Tales / Tutorial / browser-jobs:** `d4702bdf`, `66e65fb9`, `94b6d3f1`, `4e644293` (только подписи операций в `ai-pricing.ts`, влияния на Publisher нет), `11182b9a`, `73538782`.

## 3. Production — состояние на 19.10 по документам и коду

Сверено с `doc/DEPLOYMENT.md`, `doc/TODO.md`, `doc/reports/reddit-*-2026-10-15.md` и механизмом сборки. Сам production из песочницы не проверялся.

| Утверждение | Подтверждение в репозитории | Противоречие |
|---|---|---|
| ai-publisher.org развёрнут 15.10: проект Vercel `ai-publisher-site`, режим closed, noindex | DEPLOYMENT:4186–4192 — production `E74YKE9E…`, main/7d606d8; HTTPS 200; www → 308; «Сайт ще не приймає звернень»; `X-Robots-Tag: noindex, nofollow`; гейты не открывались | TODO:9822 «регистрация не подтверждена»; отчёт инвестору v3.17:1157 (16.10) «запуск не подтверждён» (IA-AB-01) |
| Publisher-миграции применены на production | сборка assist-api выполняет `prisma migrate deploy` (`scripts/build-prisma-migrations.mjs`; DEPLOYMENT:3714 «накатывается при обычном деплое»); assist-api `f4920d9` Ready 15.10; на production есть данные `pub_*` — продукт «Платформа (Reddit)», Pilot research, 32 сообщества | TODO:9834 «миграции … (не выкачены)»; шапка дизайна v1.6 «Рабочей production-базы Publisher нет» (IA-AB-01, B1-F-20 reopened) |
| Роль `publisher_public` создана | NOLOGIN-роль создаёт миграция `…_publisher_core`. Логин-роль — шаг владельца: прямой записи нет. Косвенно: `/site-config` отвечает (страница показывает `cfg.mode='closed'`), а публичные маршруты работают только под `PublisherPublicDb` | TODO:9846 открыт; запись о дате и SQL создания отсутствует (IA-AB-01) |
| Reddit включён на production | TODO:9861 `[x]` (15.10): `PUBLISHER_REDDIT_ENABLED=true`, `ASSIST_INTERNAL_SITE_IDS` = sandbox (Р-RD-ADM-17) | TODO:9855 `[ ] Включить флаг` (IA-AB-01) |
| Закупки платформенного продукта отключены (`per_purchase_max=0`) | код: `gates.ts` `purchasesDisabledMissing`, `budget-math.ts`, `errors.ts`; Р-RD-ADM-14; `budget-purchase-gate.spec` 9/9 passed (AB) | противоречий нет. Фактическое значение параметра на production не подтверждено |
| Регион, таймауты | `sites-backend/vercel.json` и `backend/vercel.json` — `lhr1`; DEPLOYMENT: Max Duration 300 с; цепочка импорт 200 → прокси 240 → функции 300 | — |

**Неизвестно.** Эти пункты передаются D1 и главному агенту.

1. Совпадает ли текущий production assist-api, admin и ai-publisher-site с 4e644293. Изменения publisher-site от 17.10 (телеметрия, CSP) на production не подтверждены.
2. Фактические значения `PUBLISHER_INDEXING`, `PUBLISHER_REDDIT_AI_ENABLED` и параметров платформенного продукта.
3. Делались ли публикации в Reddit 17.10 через цепочку P-R: бриф → QA → согласование → копирование → user_reported. TODO:6 и TODO:110 фиксируют пост в r/AIPublisher и «продвижение там остановлено» без ссылки на запись в системе.
4. Выполнен ли дамп БД перед миграциями 20261020…20261025 (регламент DEPLOYMENT «AI Publisher: резервные копии»).

## 4. Выполненные прогоны AB (4e644293)

| Набор | Результат | Доказательство |
|---|---|---|
| sites-backend unit: launch-evidence, contracts, reddit-pure, reddit-m2-pure, admin-reddit, table-ownership, roles | 7 наборов / 162 теста passed | `/tmp/ia-AB-work/jest-unit.json` md5 `5c1ac12a3284a672a0e2c781e780da0f` |
| sites-backend на БД: `reddit\|admin-actor\|qa-run-evidence\|launch-evidence\|budget-purchase-gate` | 46 наборов / 505 тестов passed | `jest-reddit.json` md5 `cd53ee226becce870619646616ee1386`, лог md5 `5ba22077e30bd787a6d6fed49719a777` |
| z-isolation, z-pii-scan, publisher-triggers.db, migrations, ai-eval-tasks/run, ai-gateway, at-report | 10 наборов: 252 passed / 1 failed | `jest-z.json` md5 `2a16568c155c6a56b764de284b132c61`. Отказ `publisher-public-role.spec` («relation _prisma_migrations does not exist») — артефакт стенда AB: миграции накатаны psql без таблицы Prisma. Не дефект; повтор — C на стенде CI |
| backend: admin-reddit (client, contract, controller.e2e), app.setup | 4 набора / 76 тестов passed | `jest-backend-reddit.json` md5 `7e5b32d21cbf18af7f0a5c405887a75b` |
| admin `src/lib/reddit.test.ts`; assist `publisher-reddit-{api,studio,view}.test.ts`; `sync-admin-reddit-shared --check` | ok; 40 маршрутов; 29/29 копий | логи в `/tmp/ia-AB-work/*.log` |

Не выполнялось:

- полный jest sites-backend и backend;
- E2E `--site` и `--reddit`;
- CI на GitHub: API вернул 403;
- production.

## 5. Что перепроверить в C/D (обязательная повторная проверка по дельте)

**C1/C3:**

- Все 44 AT P0 на 4e644293. По файлам затронуты AT-CORE-10/16/20/21, AT-F12, гейты D0 и закупки (`gates.ts`, `approvals-publish`, `publications.service`, `restore.service`, `revocation.service`), а также всё, что идёт через `contents.service`.
- E2E-01…05 и E2E-RD-01/02 (`--reddit`).
- C3: publisher-site — бюджет JS (телеметрия ≤ 2,5 КБ), axe, noindex; изменён Track/LandingVisits.
- Регрессия «Помощника» после выноса `InternalSecretGuard` (B1-F-13 → blocked).
- Импорт at-report → qa-catalog → `launch_evidence` на новой семантике `acceptanceStatus`.

**D1:**

- 72 внутренних маршрута Админки: секрет до тела, актор, `PubAccess.only` 17, журнал доступа и 499, изоляция внутри кабинета.
- Прокси backend: `assertOperator`, allowlist, 504 и повтор с тем же opKey.
- Актор `admin:` в P0-триггерах.
- publisher-site: CSP `connect-src` с адресом backend, приём `landing-visits` (CORS без credentials).
- Production-проход ai-publisher.org.

**D2:**

- Протокол N-задач и сохранение 30/24 для 2.2.
- Набор 2.3 (AI-31…42) только в коде (IA-AB-05).
- Обход eval для покрытого генератора; `PUBLISHER_STAND_FAKE_AI` не действует на Vercel.
- Живой 2.3 — верхняя оценка ≈ $4,2 — не помещается в лимит $3.

**B1 (повтор после исправлений):** IA-AB-01…11, IA-AB-40 (B1-F-20 reopened).
