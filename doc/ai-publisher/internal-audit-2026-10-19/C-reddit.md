# C1. Reddit-подсистема (P-R M1/M2, Админка) — E2E-RD-01/02 и гейты

> Внутренний аудит AI Publisher по плану v2 (19.10.2026), пакет C. Внутренняя независимость ролей, не внешний аудит. Код и требования не менялись. Подсистема введена после предаудита 13.10 — проверяется впервые в составе Publisher. Требования: `reddit-manual-mvp-adapted.md` (§2 M1.6, §3 M2.4/M2.6/M2.8, §4, §8.1, §9), отчёт `doc/reports/reddit-subsystem-audit-2026-10-15.md`.

## Условия

| Поле | Значение |
|---|---|
| Run ID | IA-C-E2E-RD-r1 |
| Commit | `4e644293` |
| Команда | `WORK=/tmp/ia-c-rd-r1 PG=postgresql://postgres:postgres@localhost:5432 DB=ia_c_rd PORT=4141 BACKEND_ROOT=/tmp/ia-c-backend bash scripts/publisher-e2e.sh --reddit` — сервер с `PUBLISHER_REDDIT_ENABLED=true`, `PUBLISHER_REDDIT_AI_ENABLED=true`, `PUBLISHER_STAND_FAKE_AI=true` (только стенд, NODE_ENV=development); драйвер `assist/scripts/publisher-e2e-reddit.ts` (md5 `1ac2d72e0c55efd18db0de6665356e6a`) — настоящий HTTP кабинета, декодеры клиента assist |
| Время | 2026-10-19 11:15:35Z – 11:15:56Z |
| Итог | **32 шага: 32 passed, 0 failed** (E2E-RD-01 — шаги 1–21, E2E-RD-02 — шаги 22–32) |
| Доказательства | `e2e-reddit.json` md5 `4b597e444a8022151e80b7f781efa7b7`, `seed.json` `b8003be9acdc4cde1f99030192deef0e`, `run.log` `8a522ea521935633ee7a328cd040f6f9`, `server.log` `b512b23a3520c781b89458cabe6f4f3f` |
| jest P-R | в общем прогоне Publisher (`/tmp/ia-c-jest.json`): 43 файла с Reddit, **490/490 passed** |
| Админка | backend `npx jest admin-reddit` — 3 набора, **62/62 passed** (`backend-admin-reddit.json` md5 `b194f2a06f4c1d0998a402c85d7a2d5e`); `admin/src/lib/reddit.test.ts` — ok (лог md5 `0ed5aeadb8e90fa1e619c02c2e02533a`); `sync-admin-reddit-shared --check` — 29 копий совпадают (md5 `238ef33101551401fa6aa96352ae369b`) |

## E2E-RD-01 (M1 Research) — **passed**, 21 шаг

| Шаг | Проверка | Факт | AT-RD |
|---|---|---|---|
| 1 | продукт и 6 ролей, флаг reddit | `features.reddit=true` | 17 |
| 2 | роли и изоляция кабинета | SA → `PUB_ROLE_REQUIRED`; VW — список 0, создание 403; чужой кабинет → `PUB_NOT_FOUND` | 01, 02 |
| 3 | проект: создание редактором, CAS | старая ревизия → 409 `currentRevision 2` | — |
| 4 | 10 сообществ: нормализация, канал community | дубль → `duplicate existingId`, мусор → 400 `format` | — |
| 5 | снимки правил, review PO, selfReview ED, VW 403, повтор 409 | r/entrepreneur `block` (promotion/links unknown), r/marketing `block` (promotion_prohibited) | 02, 03 |
| 6 | 6 ключевых запросов, дубль нормальной формы 409 | — | — |
| 7 | 20 возможностей: тред → канон, score v1, гейт | `scoreVersion v1`, неполные факторы → `missing evidence_gap`, priority null | 06 |
| 8 | дубль треда, чужое сообщество в ссылке, контакт в выдержке | 409 `duplicate`; 400 `community_mismatch`; 400 PII; строк 20 (не прибавилось) | 05, 15 |
| 9 | блокировки | qualify из blocked → 409 `policy_block`, score 100 не снимает; экран — причины словами | 03 |
| 10–13 | переходы, списки/курсор/CSV, архив | архивная → PATCH 409; архивный проект → 409 | — |
| 11 | новая версия правил | `recheck_required (rules_changed)` → review + score → `new` | 04 |
| 14 | импорт по URL Reddit | 400 `PUB_IMPORT_BLOCKED reddit_manual_only` (Р-RD-0) | 16 |
| 15 | декодеры кабинета | ни одного `PUB_RESPONSE_INVALID` | — |
| 16–21 | раунды аудита 13.10: редакции/отзыв выдержки, отзыв первоисточника правил → `rules_source_revoked`, часы +31 дн. → `rules_stale`, конкурентная правка факторов (409, без затирания), `r/u_*` → `profile_ref` | все passed | 04, 15 |

## E2E-RD-02 (M2 Content Studio) — **passed**, 11 шагов (comment и post)

| Шаг | Проверка | Факт |
|---|---|---|
| 22 | гейты | `reddit_publish` open (параметры утверждены), `ai_use` закрыт (1 missing) — генерация только стендовым fake |
| 23 | comment-бриф | без треда → 400 `opportunityId required` (A13); не ready без affiliation — причины словами |
| 24 | генерация по HTTP (fake, 3 варианта) → выбор → правка → submit → `reddit_policy` | policy pass; контакт в `meta.uncertainties` → 400 pii |
| 25 | QA человека → согласование | WARN нет → approved |
| 26 | **копирование** | отметка до копирования → 409 `not_copied`; редактор копировать не может (`PUB_ROLE_REQUIRED`); новый WARN после согласования (`reddit_duplicate`) → согласование без подтверждения 409 `warnings_not_acknowledged`, с подтверждением — проходит; **копируется ровно утверждённое тело** (драйвер: `c1.body === approvedVersion.body`), для comment заголовка нет, инструкция в тексте — текстом; повторное копирование — только аудит |
| 27 | **отчёт о публикации** | чужое сообщество / без id комментария / другой тред / будущее / профиль / раньше материала → 400 с кодом; запись `user_reported`, `stage test`, `verify not_checked`; повтор → `already_published`; `verify` → 409 `manual_only` (VERIFIED не бывает, A12) |
| 28 | правка после копирования | новая версия при `scheduled` → 409 `PUB_TRANSITION_INVALID`; снять с плана (OP) → черновик → утверждённый текст больше не копируется |
| 29 | post | бриф → ручной черновик → 3 варианта → PATCH выбора → правка → QA → согласование (дрейф WARN подтверждён) → копирование title+body → URL канонизирован без slug |
| 30 | **BLOCK** | запрещённое сообщество: генерация → `policy_block promotion_prohibited`; согласование → `reddit_policy_block`; копирование → отказ; причины словами |
| 31 | XSS/injection/ПД | сырой HTML → 400 `raw_html`; инструкция не исполняется; контакт → BLOCK `reddit_pii`, согласование `PUB_BLOCKERS_OPEN` |
| 32 | списки и CSV | брифы, публикации `user_reported` |

## Ключевые проверки гейтов

| Требование | Доказательство на 4e644293 | Итог |
|---|---|---|
| BLOCK не обходится (unknown/prohibited, нет раскрытия, фальшивый отзыв, ПД, comment без контекста) | E2E 9, 17, 30, 31; jest `reddit-m2-checks` (AT-RD-07/08), `reddit-m2-pure`, `reddit-m2-markers4` (51), `reddit-m1-policy` (AT-RD-03/04) | passed |
| WARN — только с подтверждением, совпадающим с кодами последней проверки | E2E 25, 26, 29 (`warnings_not_acknowledged`) | passed |
| Утверждённый текст нельзя подменить | E2E 26 (копируется ровно утверждённое тело), 28 (после копирования правка → новая версия, прежнее согласование не копируется); jest `reddit-m2-approval` AT-RD-09 (`PUB_APPROVAL_STALE`); **динамическая проба аудитора**: в базе стенда `ia_c_rd` прямой `UPDATE sites.pub_content_versions SET body = body || ' PS: buy now'` по утверждённой версии `cmwngfbib00bf…` (reddit_post, scheduled) — отказ триггера «после frozenAt содержимое неизменно — новая версия», правка `hash` — отказ проверки формата (транзакции откатаны) | passed |
| Отчёт о публикации — факт о скопированной версии, только `user_reported`, без проверки | E2E 27; jest `reddit-m2-handoff` (AT-RD-12/15, 11 тестов) | passed |
| Ноль запросов к Reddit | jest `reddit-m1-egress`, `reddit-m2-egress`, `reddit-admin-egress` (AT-RD-16, 11 — копирование без исходящих) | passed |
| Флаг выключен → 404, раздела нет | jest `reddit-m1-flag` (AT-RD-17) | passed |
| Восстановление переносит сущности P-R | jest `reddit-m1-restore`, `reddit-m2-restore` (AT-RD-18) | passed |
| Импорт исследования (§8.1) | E2E 14 (импорт по URL Reddit запрещён); jest `reddit-import` (3), `research-import` (18), `research-import-boundaries` (10), `reddit-admin-import` (6); **CLI аудитора** `reddit-import.ts` (dry-run, offline) на синтетических CSV из фикстуры спека: план — проект 1, сообществ 2 (+1 отклонено `format`), правил 2 `unreviewed` (первоисточника нет → «перевірка лише після нового знімка»), возможностей 1 (+3 отклонено: `not_thread`, `duplicate_in_csv`, `community_missing`), запросов 2; предупреждения `sanitized`, `dropped_columns`, `enum_default` — exit 0 (`ok.log` md5 `c175d5d5b209d554002884df450b848b`, `ok-report.json` md5 `e42765567e5a2a9a5a1c76887ffec287`); незакрытая кавычка в CSV → отказ, exit 1, ничего не записано (`bad.log` md5 `8b93a1b3c750bf54d95d5e181d6de642`); `--base-url=https://www.reddit.com` → отказ «адреса Reddit запрещены» (`redditurl.log` md5 `2a1cef4a35c067c9cfc98339a0303123`) | passed; замечание IA-C-04 (S3) |
| Админка (вкладка «Reddit») | backend `admin-reddit.controller.e2e` (25), `client` (33), `contract` (4) — 62/62; sites-backend `reddit-admin-*` (access, isolation, flow, import, egress, audit, v12, ai) — passed; `admin/src/lib/reddit.test.ts` ok | passed |

## AT-RD-01…18 (jest, метки в названиях тестов)

| AT-RD | Файлы (passed) | passed | failed |
|---|---|---|---|
| AT-RD-01 | `reddit-m1-evidence.spec` 1, `reddit-m1-access.spec` 3 | 4 | 0 |
| AT-RD-02 | `reddit-m1-evidence.spec` 1, `reddit-m1-access.spec` 2 | 3 | 0 |
| AT-RD-03 | `reddit-m1-evidence.spec` 5, `reddit-m1-policy.spec` 4 | 9 | 0 |
| AT-RD-04 | `reddit-m1-evidence.spec` 5, `reddit-m2-approval.spec` 1, `reddit-m1-policy.spec` 4 | 10 | 0 |
| AT-RD-05 | `reddit-m1-evidence.spec` 2, `reddit-m1-opportunities.spec` 2 | 4 | 0 |
| AT-RD-06 | `reddit-m1-score.spec` 5 | 5 | 0 |
| AT-RD-07 | `reddit-m2-checks.spec` 5, `reddit-m2-pure.spec` 2 | 7 | 0 |
| AT-RD-08 | `reddit-m2-checks.spec` 4, `reddit-m2-pure.spec` 3 | 7 | 0 |
| AT-RD-09 | `reddit-m2-approval.spec` 1 | 1 | 0 |
| AT-RD-10 | `reddit-m2-manual.spec` 4 | 4 | 0 |
| AT-RD-11 | `reddit-m2-egress.spec` 2 | 2 | 0 |
| AT-RD-12 | `reddit-m2-handoff.spec` 2 | 2 | 0 |
| AT-RD-13 | `reddit-m2-brief.spec` 3 | 3 | 0 |
| AT-RD-14 | `ai-eval-run.spec` 1, `reddit-m2-injection.spec` 2, `ai-eval-tasks.spec` 1 | 4 | 0 |
| AT-RD-15 | `reddit-m1-evidence.spec` 2, `reddit-m2-handoff.spec` 1, `reddit-m1-opportunities.spec` 8 | 11 | 0 |
| AT-RD-16 | `reddit-admin-egress.spec` 1, `reddit-m1-egress.spec` 2, `reddit-m2-egress.spec` 2 | 5 | 0 |
| AT-RD-17 | `reddit-m1-flag.spec` 3 | 3 | 0 |
| AT-RD-18 | `reddit-m1-restore.spec` 2, `reddit-m2-restore.spec` 1 | 3 | 0 |

## Ограничения и замечания

- Генератор `pub.reddit.draft` на живой модели — отдельный шлюз после eval 2.3 (Р-RD-17); здесь — только стендовый fake (пакет D2).
- Публикации Reddit на стенде записываются `stage=test` (до выпуска сайта — вопрос владельцу §12 ТЗ P-R); в отчёты не входят.
- Ретенция выдержек (180 дней + очередь `retention_review`) доказана jest `reddit-m2-retention` (7/7); первый production-запуск крона — не подтверждён (отчёт 15.10), вне стенда.
- CI: правило `publisher_stand` в `scripts/ci-changes.mjs` не включает миграции Reddit (`20261020…`, `20261021…`, `20261023…`, `20261024…`) — их изменение не запускает E2E-RD (IA-C-02, см. `C-CI.md`).
- IA-C-04 (S3): при незакрытой кавычке CLI импорта пишет общее «Ошибка чтения CSV: проверьте доступ к каталогу и формат файлов» без файла/строки (спек `research-import` различает `malformed`, но CLI сводит к общему тексту) — отказ честный, ничего не записано, страдает только диагностика.

**Итог по Reddit-подсистеме (внутренний, 4e644293):** E2E-RD-01 и E2E-RD-02 passed, AT-RD-01…18 passed (jest), гейты BLOCK/WARN, неизменность утверждённого текста, отчёт о публикации и импорт подтверждены; дефектов S0–S2 пакет C не нашёл.

---

## Перепроверка 19.10 после исправлений (E1)

**Проверенная версия:** HEAD `4e644293` + незакоммиченные исправления FX-A/FX-B/FX-C: `git diff` 48 файлов (+1771/−235), sha256 диффа `0f11b3c23aa258f5a3fcf6bccbb739951b2d630af58a714be9a262d391ace7a0`; 13 новых файлов (в т. ч. миграция `20261026100000_publisher_reddit_policy_version`, `publisher-site/src/lib/landing-visits.ts`), список sha256 — `/tmp/ia-c-e1/untracked-sha256.txt` (sha256 `5256651d…e563225`). Дифф перепроверен в конце прогонов — не менялся. Сборка backend — `tsc` в `/tmp/ia-c-e1/backend/dist` (exit 0); все стенды — `flock -o` (фоновые серверы замок не держат). Время 12:56–13:19 UTC. Среда та же, что в первом проходе.

- **E2E-RD-01/02:** `WORK=/tmp/ia-c-e1/rd-r2 DB=ia_c_rd2`, 12:57:48–12:58:09Z — **32/32 passed** (`e2e-reddit.json` md5 `99fcae0d187553507e88ffae037b2b01`, `server.log` `8fb261e6bf1a48ff5df8a3441390ee1b`); схема — с новой миграцией `20261026100000_publisher_reddit_policy_version`.
- **jest P-R** в общем прогоне E1 — все Reddit-наборы passed, включая новые `reddit-policy-version.db.spec`, `admin-queue-attest.db.spec`, дополненные `research-import*` и `reddit-admin-import`; регрессий против первого прохода нет.
- **IA-C-04 → verified_closed:** тот же битый каталог → «Ошибка чтения CSV: saas-opportunities.csv, строка 2: незакрытая кавычка», exit 1; второй случай (`saas-keywords.csv`, строка 3) — так же; корректный каталог — dry-run как прежде (`/tmp/ia-c-e1/import/{ok,bad,bad2}.log`).
- **IA-C-02 → verified_closed:** миграции Reddit/Админки теперь запускают `publisher-stand` (`C-CI.md`).
- Гейты BLOCK/WARN, неизменность утверждённого текста, отчёт о публикации, импорт — без изменений результата.
