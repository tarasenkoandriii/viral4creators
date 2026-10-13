# AI-Publisher — Reddit Manual MVP (M1 + M2): ТЗ, адаптированное к коду

Версия 1.4-adapted · 13.10.2026 · основа — «AI-Publisher Reddit Manual MVP: подробное ТЗ M1 и M2» v1.3
(копия исходника: [reddit-manual-mvp-v1.3-source.md](reddit-manual-mvp-v1.3-source.md)).
Сверено с кодом в `main` после коммита `342db71e` (Publisher P0): модуль
`sites-backend/src/modules/publisher/**`, схема `sites-backend/prisma/schema.prisma`, миграции
`20261016*`, кабинет `assist/src/screens/publisher/**`, проектный документ
[IMPLEMENTATION-DESIGN.md](IMPLEMENTATION-DESIGN.md) (далее — ДИЗ).

Что меняет адаптация. Исходное ТЗ писалось без доступа к коду и предполагало отдельный модуль со
своими таблицами `reddit_*`, ролями, маршрутами `/api/reddit/manual/*`, UUID, down-миграциями и
422. В коде большая часть механики уже есть и проверена аудитами: изоляция кабинета, роли
продукта, идемпотентные операции с CAS, аудит, источники с отзывом, версии с hash-заморозкой,
QA, согласование по hash, ручная публикация, AI-шлюз с допуском и бюджетом. Поэтому Reddit MVP
строится как **пакет P-R внутри модуля Publisher**. Новыми становятся только Reddit-специфичные
сущности: сообщества, снимки правил, ключевые запросы, возможности, Reddit-бриф. Всё остальное
берётся из существующих механизмов. Требования ТЗ v1.3 сохранены по смыслу. Каждое отличие по
форме записано решением Р-RD-N (§11).

Режим не меняется: **только MANUAL_COPY**. Никаких Reddit API/OAuth, скрейпинга, браузерных
ботов, автоотправки или Reddit Pro export. Подтверждение публикации и SEO-трафик не обещаются.

---

## 0. Что из допущений ТЗ подтвердилось

| Допущение ТЗ v1.3 | Факт в коде | Следствие |
|---|---|---|
| auth | Telegram initData и веб-вход (Login Widget + cookie), `SiteAccountGuard` | своего auth не делать |
| tenant/workspace | кабинет `accountId` (заголовок `X-Site-Account`), внутри — продукт `pub_products` (один на сайт, `@@unique([siteId])`) | tenant = `accountId`, область = продукт `:pid` |
| brands | профиль бренда продукта (`content/brand.service.ts`), активная версия оффера `offer_active_version` | `brand_id` не нужен: бренд — это профиль продукта |
| PostgreSQL | Supabase Postgres, схема `sites`, рукописные миграции, CHECK запрещены (вместо них триггеры `23514`) | соблюдать конвенции §6.1 ДИЗ |
| LLM adapter | AI-шлюз `ai/gateway-core.ts` поверх `site-ai` (Gemini), допуск `ai_use`, eval, бюджет | новый генератор подключается к шлюзу, а не мимо него |
| React и NestJS | кабинет assist (Vite 5 + React 18.3), NestJS 11 | экраны — раздел кабинета Publisher |
| UUID | id = `cuid()`; UUID v4 используется только для `opKey` | все новые таблицы на cuid |
| up/down миграции | только forward, отката-скриптов в репозитории нет; откат — флагом и бэкапом (P-E) | Р-RD-12 |

---

## 1. Сопоставление сущностей

| ТЗ v1.3 | В коде | Решение |
|---|---|---|
| `reddit_projects` | `pub_products` (один на сайт) | **новая** `pub_reddit_projects` — группа внутри продукта: язык, рынок, статус (Р-RD-1) |
| `reddit_subreddits` | `pub_channels` (kind `community`), правила — только `adsAllowed` и `rulesNote` | **новая** `pub_reddit_communities` с обязательной ссылкой на канал `community` (Р-RD-2) |
| `reddit_rule_snapshots` | нет; ближе всего `pub_sources` с редакциями | **новая** append-only `pub_reddit_rule_snapshots` + первоисточник в `pub_sources` (Р-RD-3) |
| `reddit_keywords` | нет (`pub_question_groups` — про вопросы сайта) | **новая** `pub_reddit_keywords` |
| `reddit_opportunities` | нет (`pub_questions` ограничены рангом 1..6) | **новая** `pub_reddit_opportunities` |
| `reddit_evidence` | `pub_sources` (kind `discussion`, `visibility`, `usage`, отзыв, `injectionFlag`, `contentHash`) | **без новой таблицы**: выдержки — это источники; связи — колонками (Р-RD-4) |
| `reddit_audit_events` | `pub_audit_events` (append-only, закрытые `objectType`/`action`, pii-guard) | расширить закрытые списки |
| `reddit_briefs` | `pub_briefs` (жёстко привязан к вопросу сайта и формату статьи) | **новая** `pub_reddit_briefs` (Р-RD-5) |
| `reddit_draft_revisions` | `pub_contents` + `pub_content_versions` (заморозка, `hash`, неизменность, diff) | **переиспользовать**: новые `pub_contents.kind` = `reddit_post`, `reddit_comment` (Р-RD-6) |
| `reddit_quality_checks` | `pub_qa_checks` (`pass/fail/unknown` + `blockers`) | новый вид проверки `reddit_policy` + колонка `warnings` (Р-RD-8) |
| `reddit_approvals` | `pub_approvals` type `publish_version` по `versionHash` | **переиспользовать**; снимок правил входит в hash версии (Р-RD-7) |
| `reddit_manual_publications` | `pub_publications` (ручной `finalUrl`, `verifyStatus`) | **переиспользовать** с `reportKind='user_reported'` (Р-RD-10) |

Общие правила для новых таблиц (ДИЗ §6.1):
- `id cuid`, `accountId`, `productId`;
- составные FK `(xId, accountId)`, `@@unique([id, accountId])`, триггер `pub_same_product`;
- `createdAt`, `createdBy` в формате `member:…|system:…`;
- у «голов» `revision Int` и `updatedAt`, у append-only таблиц `updatedAt` нет;
- регистрация в `TABLE_OWNERS` (новый пакет `P-R`), `TENANT_COLUMNS`, `PUB_CLOSED_LISTS`, экспорте и восстановлении P-E;
- `REVOKE` у `PUBLIC`, `assist_public`, `publisher_public`.

Владение таблицами. P-R пишет только свои `pub_reddit_*`. Каналы, источники, материалы и версии, QA, согласования и публикации меняются через порты и сервисы их пакетов (`ContentPort`, порт источников, `ChannelsService`, `PublicationsService`) с новыми методами для Reddit-видов. Это сверяет `table-ownership.spec.ts`: `PackageId` расширяется значением `P-R`.

---

## 2. M1 Research MVP

### M1.0 Интеграция и ограничения

**Флаги.** Глобальный env-флаг `PUBLISHER_REDDIT_ENABLED`, по умолчанию `false`
(`config/publisher-env.ts`, по образцу `PUBLISHER_BACKUP_DISABLED`).
- Пока флаг выключен, все маршруты `…/reddit/**` отвечают 404 `PUB_NOT_FOUND` без `details` — неотличимо от отсутствия маршрута.
- `GET …/products/:pid` отдаёт `features.reddit: boolean`, по нему кабинет скрывает раздел.
- Флаг продукта не вводится: включение на продукт уже регулируют роли и гейт `reddit_publish` (Р-RD-9).

**Роли** без новой роли (Р-RD-11). Матрица — §5.

**Tenant.** Работают существующие `PubRoleGuard` и `ProductAccessService`: чужой кабинет или продукт даёт 404, как для несуществующего id. `REDDIT_ROUTES` и модуль P-R явно добавляются в реестр `z-isolation.spec.ts` (он импортирует контракты поимённо и падает на маршруте вне реестра) и в генератор матрицы ролей предаудита D1.

**Никаких внешних запросов к Reddit** (§8.3):
- правило графа импортов: `publisher/reddit/**` не импортирует `site-crawl/**` (там живёт `pinned-fetch`) и сетевые обёртки;
- `source-import.ts` отклоняет хосты `reddit.com`, `*.reddit.com`, `redd.it`, `*.redd.it`, `*.redditmedia.com`, `*.redditstatic.com` с причиной `reddit_manual_only`;
- runtime-тест с бросающими `fetch`, `http.request` и `https.request`.

**ADR «Manual only»** — §11 этого документа (Р-RD-0) и строка в §27+ ДИЗ.

**Приёмка:**
- cross-tenant запрос даёт 404 (AT-RD-01);
- при выключенном флаге API даёт 404, а кабинет не показывает раздел (AT-RD-17);
- матрица ролей §5 сверена `roles.spec.ts` (маршруты ↔ действия) и `assist/scripts/publisher-view.test.ts` (зеркало `assist/src/lib/publisher/permissions.ts`).

### M1.1 Схема БД и миграции

Одна новая миграция `2026102xxxxxxx_publisher_reddit` (forward-only). Поля указаны сверх общих правил §1.

**`pub_reddit_projects`** (голова, `revision`):
- `name` (1..120);
- `locale` (`uk|ru|en|…` — BCP-47, ≤ 16);
- `market` (≤ 64);
- `status` `active|archived`.

**`pub_reddit_communities`** (голова, `revision`):
- `projectId` — FK;
- `channelId` — FK на `pub_channels`, kind `community`, создаётся в той же операции (Р-RD-2);
- `name` — нормализованное `r/<name>` без префикса, в нижнем регистре, `^[a-z0-9_]{2,21}$`;
- `canonicalUrl` `https://www.reddit.com/r/<name>` — без завершающего `/`, как требует `canonicalUrl()` и триггер `pub_publications.finalUrl`;
- `descriptionManual` (≤ 2000), `language` (≤ 16), `topics` Json (≤ 20 строк ≤ 64);
- `status` `active|archived`;
- уникальность `(productId, name)` — частичный индекс по `status='active'` не нужен: сообщество одно на продукт, архивированное восстанавливается.

**`pub_reddit_rule_snapshots`** — append-only, кроме полей review:
- `communityId` — FK;
- `version` — int, `(communityId, version)` уникален, на 1 больше предыдущего; проверяет триггер;
- `sourceId` — FK на `pub_sources`: kind `url`, `importedVia='manual'`, `visibility='private'`; URL первоисточника и выдержка хранятся там;
- `promotionPolicy` `allowed_with_conditions|prohibited|unknown`;
- `linksPolicy` `allowed|restricted|prohibited|unknown`;
- `flairRequired` boolean|null;
- `conditions` Json (≤ 20 строк ≤ 300);
- `checkedAt` — когда оператор смотрел правила;
- `reviewState` `unreviewed|reviewed`; `stale` вычисляется (Р-RD-3);
- `reviewedBy` (`member:`), `reviewedAt`, `selfReview` boolean;
- `status` `current|superseded`.

Триггер snapshots:
- после `reviewState='reviewed'` неизменно всё, кроме `status` (`current → superseded` при новой версии);
- review требует `sourceId` с непустым `url` и `checkedAt`;
- review своего снимка не запрещён, а помечается `selfReview=true` — как `version.approve` (`core/roles.ts`): в кабинете из одного человека иначе работа встанет. Экран показывает пометку «перевірено автором».

**`pub_reddit_keywords`** (голова):
- `projectId`;
- `phrase` (1..200, без ПД — `pii-guard`);
- `intent` ∈ `how_to|comparison|alternative|troubleshooting|recommendation|discussion|other`;
- `locale`;
- `priority` 1..5;
- `status` `active|archived`;
- `phraseNorm` — хранимая нормализованная форма (нижний регистр, сжатые пробелы); уникальность `@@unique([projectId, phraseNorm])`. Индекс по выражению `lower()` Prisma не видит, и `migrate diff` перестал бы быть пустым.

**`pub_reddit_opportunities`** (голова, `revision`):
- `projectId`, `communityId`;
- `threadUrl` — канонический `https://www.reddit.com/r/<name>/comments/<id36>/<slug>` без завершающего `/`, query и fragment;
- `threadKey` = `<id36>`; уникальность `(projectId, threadKey)` → A05;
- `titleManual` (≤ 300);
- `excerptSourceId` — FK на `pub_sources`: kind `discussion`, `visibility='private'`, `usage='restricted'`, фрагмент ≤ 2000 (Р-RD-4);
- `intent` — как у keywords;
- `angle` (≤ 1000);
- `keywordIds` Json (≤ 10 id своего проекта; проверка в сервисе);
- `factors` Json — 8 факторов 0..100 или null + `why` (≤ 300) для каждого;
- `relevance`, `risk`, `priority` — numeric, вычисляются;
- `scoreVersion` `v1`;
- `ruleSnapshotId` — FK, снимок, по которому считался риск;
- `policy` `ok|block|recheck_required`;
- `status` `new|qualified|recheck_required|blocked|skipped|in_brief|archived`.

Индексы: `(productId, status)`, `(projectId, status)`, `(communityId)`.

**Закрытые списки.** Новые значения добавляются в `PUB_CLOSED_LISTS` и в функции-списки триггеров:
- `pub_object_types()`: `reddit_project`, `reddit_community`, `reddit_rule_snapshot`, `reddit_keyword`, `reddit_opportunity`, `reddit_brief`;
- `AUDIT_ACTIONS`: новые `copy` и `report_publication`; review правил пишется существующим `approve`, пересчёт score — `update`. Список действий — inline-массив в `pub_audit_events_guard`, поэтому функция триггера пересоздаётся (`CREATE OR REPLACE`) в миграции P-R.

**Seed** `sites-backend/test/publisher-reddit/seed.cjs`: 2 кабинета; роли PO, ED, OP, VW; 10 сообществ; 20 возможностей; снимки по 4 сценариям M1.3.

**Приёмка:**
- повторный тред даёт 409 `PUB_CONFLICT {existingId}` без дубля (AT-RD-05);
- `prisma migrate diff` пуст;
- восстановление P-E переносит новые таблицы (AT-RD-18);
- «rollback» — по Р-RD-12.

### M1.2 Интерфейсы исследования

Новый раздел кабинета **«Reddit»** (`assist/src/screens/publisher/reddit/`) регистрируется в `PUBLISHER_SECTIONS`, `actions` = `reddit.read`. Внутри вкладки: Проекты · Сообщества · Правила · Возможности · Запросы. Словари `assist/src/i18n/publisher-reddit-{uk,ru,en}.ts`.

**Компоненты** — существующие:
- `ListToolbar` (фильтры и CSV), `usePaged`/`LoadMore` по `nextBefore`, `Loadable` (empty/loading/error);
- `PubErrorAlert` (409 с перезагрузкой), `useMutation` (`opKey` на попытку), `ConfirmButton`, `StatusBadge`.

Цитаты из Reddit выводятся только текстом через `<pre>`/`textContent`, без markdown-рендера и без `dangerouslySetInnerHTML` (A14). Страницы Reddit никогда не подгружаются: ни превью, ни oEmbed, ни favicon. Ссылка «Открыть на Reddit» — обычная `<a rel="noopener noreferrer" target="_blank">` на сохранённый канонический URL.

**Экраны:**
- **Сообщества:** ввод `r/name` или URL, нормализация на клиенте и сервере. Видны дата последней проверки правил, `reviewState` и `stale`.
- **Правила:** кнопка «Подтвердить проверку» видна только тем, у кого есть `reddit.rules.review`; автору снимка — с предупреждением о `selfReview`.

**Приёмка:** оператор вручную создаёт проект, 10 сообществ и 20 возможностей (E2E-RD-01).

### M1.3 Реестр правил и Policy Gate

Чистые функции `publisher/reddit/policy.ts`:

`snapshotState(snapshot, now, staleDays)` возвращает одно из трёх значений:
- `unreviewed`;
- `reviewed`;
- `stale` — `reviewed`, но `checkedAt + staleDays < now`.

`staleDays` — новый параметр продукта `reddit_rules_stale_days` (по умолчанию 30, 1..365). Как и любой параметр, проходит «предложение → решение». Свежесть не гарантирует актуальность правил.

`policyGate(snapshot, now, staleDays, contentKind, hasLinks)` возвращает `{verdict: 'ok'|'block'|'recheck_required', reasons[]}`:

| Условие | verdict | reason |
|---|---|---|
| снимка нет | `block` | `rules_missing` |
| `unreviewed` | `block` | `rules_unreviewed` |
| `stale` | `recheck_required` | `rules_stale` |
| `promotionPolicy = prohibited` | `block` | `promotion_prohibited` |
| `promotionPolicy = unknown` | `block` | `promotion_unknown` |
| `linksPolicy = unknown` | `block` | `links_unknown` |
| `linksPolicy = prohibited` и в тексте есть ссылка | `block` | `links_prohibited` |
| `linksPolicy = restricted` и в тексте есть ссылка | `ok` + WARN | `links_restricted` |

**Новый снимок** (`POST …/communities/:id/rules`) в одной операции:
- предыдущий снимок получает `status='superseded'`;
- все возможности этого сообщества в статусах `new|qualified|in_brief` получают `policy='recheck_required'` и `status='recheck_required'`;
- Reddit-материалы этого сообщества проходят существующий каскад (`content/cascades.ts`): действующие согласования переходят в `superseded`, опубликованный материал получает задачу проверки и `correction_required`;
- аудит пишется на каждый объект.

LLM не может менять policy. В AI-слое нет маршрута или инструмента, который пишет в `pub_reddit_rule_snapshots`; это правило графа `publisher-ai-no-authority` плюс тест.

**Приёмка** (AT-RD-03, AT-RD-04), четыре сценария:
- снимок unknown → `block`;
- prohibited → `block`;
- stale → `recheck_required`, публикацию рекомендовать нельзя;
- новая версия → зависимые возможности переходят в `recheck_required`.

### M1.4 Intent и Opportunity Score

Чистая функция `publisher/reddit/score.ts`, `scoreVersion: 'v1'`. Формулы ТЗ v1.3 взяты без изменений: веса начальные, не эмпирические, в коде — константы версии.

```
relevance = round(.35·topic_fit + .25·intent_fit + .20·audience_fit + .20·answerability)
risk      = round(.40·policy_risk + .25·promotionality + .20·evidence_gap + .15·context_uncertainty)
priority  = round(relevance · (1 − risk/100))   — только для сортировки
```

- Факторы 0..100, каждый с обоснованием `why`. Оператор вводит все факторы, кроме `policy_risk`.
- `policy_risk` выводится из снимка (при `promotionPolicy = allowed_with_conditions`): links `allowed` → 20; links `restricted` → 50; links `prohibited` → 60 (пост без ссылок возможен, ссылка даст BLOCK в M2.4). Если `promotionPolicy` или `linksPolicy` = `unknown`, либо `promotionPolicy = prohibited` → 100, и verdict уже `block`.
- Пропущенный фактор не превращается в 0. Если в группе есть `null`, score этой группы `null` («не рассчитано»), а в ответе — `missing[]`.
- Размер и активность сообщества не вводятся и не выдумываются: полей нет.
- `policy='block'` нельзя снять высоким score: перевести возможность в `qualified` или в бриф нельзя (409 `PUB_TRANSITION_INVALID {reason:'policy_block'}`).

**Приёмка:** одинаковые входы дают побайтно одинаковый результат, тест свойств (AT-RD-06). BLOCK не снимается score = 100 (AT-RD-03).

### M1.5 Backend API

Префикс модуля — `/publisher/products/:pid/reddit/…` (не `/api/reddit/manual`, Р-RD-13). Контракт — `contracts/reddit-api.ts` (`REDDIT_ROUTES`, по шаблону `_template.ts`). Тела наследуют `MutationBody {opKey}` или `RevisionedBody {opKey, expectedRevision}`.

| Метод и путь (после `…/reddit`) | Действие | Примечание |
|---|---|---|
| `GET /projects`, `POST /projects` | `reddit.read` / `reddit.manage` | |
| `GET /projects/:id`, `PATCH /projects/:id` | `reddit.read` / `reddit.manage` | CAS |
| `POST /projects/:id/archive` | `reddit.manage` | переход — глагол, не PATCH статуса |
| `GET /communities`, `POST /communities` | `reddit.read` / `reddit.manage` | создаёт и канал `community` |
| `PATCH /communities/:id` | `reddit.manage` | CAS |
| `GET /communities/:id/rules`, `POST /communities/:id/rules` | `reddit.read` / `reddit.manage` | новый снимок + каскад M1.3 |
| `POST /rules/:id/review` | `reddit.rules.review` | selfReview, требует URL и `checkedAt` |
| `GET /opportunities`, `POST /opportunities` | `reddit.read` / `reddit.manage` | дубль → 409 `{existingId}` |
| `PATCH /opportunities/:id` | `reddit.manage` | CAS; правка факторов пересчитывает score |
| `POST /opportunities/:id/score` | `reddit.manage` | явный пересчёт по текущему снимку |
| `POST /opportunities/:id/{qualify,skip,archive}` | `reddit.manage` | |
| `GET /keywords`, `POST /keywords`, `PATCH /keywords/:id` | `reddit.read` / `reddit.manage` | |

- **Списки:** `?before&limit≤100` → `{items, nextBefore}`, фильтры `status`, `projectId`, `communityId`, `q`, а также `?format=csv`. Выгрузка пишет аудит `export`.
- **Мутации:** через `PubOperations.run` — идемпотентность, транзакция, аудит, `mapDbError`.
- **Ошибки** — существующие коды (Р-RD-14):

| Код | HTTP | Когда |
|---|---|---|
| `PUB_VALIDATION` (`details.fields[{field,code}]`) | 400 | невалидный ввод (в ТЗ v1.3 — 422) |
| 401 | 401 | без входа (`SiteAccountGuard`) |
| `PUB_ROLE_REQUIRED` | 403 | нет прав |
| `PUB_NOT_FOUND` | 404 | нет объекта или чужой кабинет |
| `PUB_CONFLICT`, `PUB_TRANSITION_INVALID`, `PUB_IDEMPOTENCY_REUSED`, `PUB_GATE_CLOSED` | 409 | конфликты и переходы |

### M1.6 QA и выпуск M1

- **Unit:** нормализация `r/name` и URL треда; `policyGate`; `score` (свойства и детерминизм); `snapshotState`; дубли.
- **db:** триггеры (неизменность после review, `version`+1, selfReview, закрытые списки), каскад нового снимка.
- **HTTP и приёмка:** `src/acceptance/publisher/reddit-m1-*.spec.ts`, по AT-RD (§9).
- **Изоляция и ПД:** `REDDIT_ROUTES` добавляются в `z-isolation`; новые таблицы — в `z-pii-scan`. Новое правило P-R: сервис проверяет `fragment` Reddit-выдержки с `pii:true` и отклоняет контакты (обычные источники P-B1 фрагмент не проверяют — Р-PUB-Z2-18). В сценарий скана добавляется выдержка с телефоном и email (ожидается 400), а белый список скана для `pub_sources.fragment` сужается: Reddit-выдержки из него исключаются.
- **E2E-RD-01** в `scripts/publisher-e2e.sh` (новая секция `--reddit`): проект → 10 сообществ → снимки → 20 возможностей → score → блокировки.
- **XSS и prompt-injection** в цитатах: тест рендера кабинета и `injectionFlag` у выдержки (A14).
- **Egress-тест** (A16) — §8.3.
- **Мутации:** 6–8 на гарды (policy, score, selfReview, дубль, флаг, egress).

**Gate M1:** все AT-RD M1 passed; ноль внешних запросов к Reddit-хостам (тест); у каждого вывода о правилах есть `sourceId` с URL и `checkedAt`. Внутренний аудит пакета по `pub-audit-rules` пройден без S0/S1.

---

## 3. M2 AI Content Studio

### M2.1 Данные и workflow

**`pub_reddit_briefs`** (голова, `revision`; Р-RD-5):
- `projectId`, `opportunityId` (обязателен для comment, необязателен для post), `communityId`;
- `offerVersionId` — активная версия оффера на момент создания (нужна версии материала: `pub_content_versions.offerVersionId` NOT NULL);
- `contentType` `post|comment`;
- `objective` (≤ 500), `audience` (≤ 500);
- `context` (≤ 2000; для comment копируется из выдержки возможности и редактируется);
- `keyPoints` Json — 2..5 элементов `{text ≤ 300, sourceIds[] | 'needs_verification'}`;
- `affiliation` `founder|employee|agency|customer|none` — обязателен до генерации;
- `linksAllowed` boolean;
- `tone` (≤ 64), `language`;
- `constraints` Json (≤ 10 строк ≤ 300), `forbiddenClaims` Json (≤ 20 строк ≤ 300);
- `cta` (≤ 300 | null);
- `status` `draft|ready|archived`.

**При создании** (`POST /briefs`) для comment сразу обязательны `opportunityId` и непустой `context` — иначе 400 (A13).

**Требования к `ready`** (триггер + сервис):
- `affiliation` задан;
- у каждого пункта `keyPoints` есть allowed-источник или пометка `needs_verification`.

**Материал и версии** — существующие `pub_contents` и `pub_content_versions` (Р-RD-6).
- Новые `pub_contents.kind`: `reddit_post`, `reddit_comment`. Для них вместо `briefId`/`parentContentId` обязателен `redditBriefId` (новая колонка, FK). Триггер видов материалов расширяется.
- Ветки `kind !== 'article'` в сервисах сейчас означают «адаптация» и требуют родителя. Для Reddit-видов их нужно развести: `approvalBlockers` — без `adaptation_meaning` и родителя, но с `reddit_policy`; `createVersion` — без `parentVersionId`, `offerVersionId` из брифа; `assertAiCall` — принимает вызовы `pub.reddit.draft`.
- «Revision» ТЗ — это версия `pub_content_versions`: `number`, неизменна после заморозки (`submit`), `hash`. Черновик у материала один (`draft_exists`), это инвариант кода.
- **Варианты** живут в `pub_ai_calls.output` (2–3 штуки). Редактор выбирает один, и он становится единственным черновиком версии (`aiCallId` + индекс варианта в аудите). Остальные остаются в журнале вызова и доступны для сравнения и повторного выбора, пока черновик не отправлен.
- **Comment и title.** `pub_content_versions.title` NOT NULL (1..300). Для comment сервис пишет служебный заголовок `r/<name> · <titleManual>` (≤ 300); в копируемый текст он не входит.
- Выдержка треда (`usage='restricted'`) **не связывается** с `pub_version_sources`: иначе сработал бы блокер `source_not_allowed`. Она хранится ссылкой на возможность.
- В `meta` версии Reddit-материала (белый список `rules.ts`):

```json
{ "disclosure": "...", "flairSuggestion": "...|null", "claimMap": [{"text":"...","sourceIds":[...]|"needs_verification"}],
  "uncertainties": ["..."], "ruleSnapshotId": "<cuid>", "affiliation": "founder|…", "threadUrl": "...|null" }
```

- `ruleSnapshotId`, `affiliation` и `claimMap` входят во вход hash (`content/version-hash.ts` + `contentVersionHash`). Согласование по hash автоматически привязано к снимку правил (Р-RD-7).
- Модель, `instructionVersion`, токены, стоимость и ошибки уже пишутся в `pub_ai_calls`. Версия ссылается на вызов через `aiCallId`.

Соответствие статусов ТЗ и кода:

| ТЗ v1.3 | Код |
|---|---|
| BRIEF | `pub_reddit_briefs.status` draft → ready |
| DRAFT | версия `draft` |
| QA_REQUIRED | версия `submitted` (заморожена при `submit` одним UPDATE), QA ещё нет |
| REVIEW_REQUIRED | та же версия `submitted`, QA `pass` — отдельного состояния нет, различаются наличием проверок |
| APPROVED | версия `approved` + `pub_approvals` active (`publish_version`, `versionHash`) |
| COPIED | аудит `copy` + `pub_contents.status` `scheduled` (новых статусов не вводим) |
| USER_REPORTED_PUBLISHED | `pub_publications` `status=published`, `reportKind=user_reported`, `verifyStatus=not_checked` |
| NEEDS_CHANGES | версия `changes_requested` |
| BLOCKED | QA `fail` с блокерами или `policyGate=block` |
| ARCHIVED | `pub_reddit_briefs.status='archived'`; материал остаётся в своём статусе или снимается переходом `withdraw` |

Любая правка утверждённого текста создаёт новую версию: замороженную версию менять нельзя (триггер), а согласование привязано к hash (A09).

### M2.2 Brief Builder

Экран «Бриф» во вкладке «Reddit». Форма — по полям `pub_reddit_briefs`. Тезисы выбираются из источников продукта; если источника нет, тезис получает пометку `needs_verification` и попадает в `claimMap` как неподтверждённый.

**Приёмка:**
- comment без контекста или без треда → 400 `PUB_VALIDATION`, `details.fields=[{field:'context', code:'required'}]` уже при создании брифа (A13, Р-RD-14);
- без `affiliation` генерация недоступна: 409 `PUB_BRIEF_NOT_READY` (существующий код).

### M2.3 AI Generation

Новый генератор **`pub.reddit.draft`**. Один генератор с пятью шаблонами внутри одной инструкции: `helpful_answer|educational_post|comparison|troubleshooting|feedback_request`. Это одна схема и одна версия инструкции вместо пяти генераторов. Вход:

```
{ template, contentType: post|comment, brief: {objective, audience, keyPoints, affiliation, tone, language,
  constraints, forbiddenClaims, cta, linksAllowed}, community: {name, rules: {promotionPolicy, linksPolicy,
  flairRequired, conditions}}, thread?: {title, excerpt}, variants: 2|3 }
```

Схема ответа (строгая, `ai-schemas.ts`):

```
{ variants: [ { title: string|null (≤300; null для comment), body (≤ 10000), disclosure (≤ 300),
  flair_suggestion: string|null, claim_map: [{text, source_ids[] | "needs_verification"}],
  uncertainties: [string] } ] (2..3) }
```

**Правила:**
- **Варианты.** 2–3 варианта возвращаются массивом в одном вызове и хранятся в `pub_ai_calls.output`, поэтому они не съедают лимит `BASE_GENERATIONS` (Р-RD-15).
- **Изоляция недоверенного текста.** Выдержка треда и правила сообщества идут в промпт блоками `<thread trust="untrusted">` и `<community_rules trust="untrusted">`: экранирование, `injectionFlag`, маска ПД (`preparePrompt`/`maskDeep`). Источники бренда — как обычно, `<source trust="untrusted">`.
- **Restricted-источник.** Выдержка (`usage='restricted'`) не может подтверждать claims (Р-RD-4).
- **Инструкция `pub.reddit.draft.v1`** = `COMMON_RULES_V1` плюс запреты: личные истории от первого лица, отзывы и testimonials, статистика вне контекста, ссылки, если `linksAllowed=false` или `linksPolicy ∈ {prohibited, unknown}`.
- **Раскрытие.** Обязательно раскрыть аффилированность (`disclosure` не пуст, если `affiliation ≠ none`) и пройти проверку правил сообщества.
- **`postCheck`:**
  - `source_outside_context` и `forbidden_promise` — critical;
  - `number_not_in_context` — warning;
  - новые находки: `link_present` (по политике), `first_person_experience` (маркеры «я купив / я пользуюсь / I've been using …» при `affiliation ≠ customer`) — critical; `disclosure_missing` — critical.
- **Повторы** (Р-RD-16): общий шлюз не меняется — он общий с P0 и прошёл аудит D2.
  - Генерация списывается при создании вызова, в том числе при техническом сбое. Вторая генерация задачи (`BASE_GENERATIONS = 2`) и служит повтором после сбоя; дальше — `extra` по общим правилам.
  - Повтор при `schema_invalid` (одна попытка «ремонта» схемы) сохраняется: это механизм шлюза, а не «перегенерация ради лучшего ответа».
  - Отклонение от ТЗ v1.3 («retry только при техническом сбое») — в форме: автоматического повтора при сбое нет, повтор делает человек в пределах лимита.
- **Kill switch.** Env `PUBLISHER_REDDIT_AI_ENABLED`, по умолчанию `false`.
  - Выключен — маршрут генерации отвечает 409 `PUB_AI_DISABLED {generator, manual:true}`, экран показывает ручной редактор.
  - Независимо от флага генератор не работает, пока не допущен: `enabledInP0`, `ai_use`, eval (M2.3.1).
  - Исследование (M1) от этих флагов не зависит.
- **Без LLM** ручной редактор работает всегда: обычные мутации версии, `aiCallId` не обязателен (A10).

#### M2.3.1 Допуск генератора (eval)

- Добавление допущенного генератора меняет `configHash`: `coveredGenerators`, `instructionVersions`, `callParams`. Привязанная конфигурация закрывает `ai_use` **для всех генераторов**, пока не пройден новый прогон.
- Поэтому включение `pub.reddit.draft` — отдельное событие выпуска:
  1. **Новый eval-набор `EVAL_SET_VERSION = '2.3'`** (сейчас `'2.2'`, ≤ 20 знаков) = 30 базовых задач P0 (без изменений) + **12 задач Reddit** (AI-31…AI-42): 5 шаблонов × 2 (post и comment), injection в выдержке треда, сообщество с `links prohibited`.
  2. Порог допуска обобщается. В `pub_eval_guard` число 30 заменяется размером набора, а «≥ 24 полезных из 30» — долей ≥ 80 % (`ceil(0,8·N)`); критические — все N. Триггер и константы `ai/eval/protocol.ts` меняются одной миграцией.
  3. Регистрация генератора: `GENERATOR_IDS`/`GeneratorId`, SQL `pub_generators()`, операция `pub-reddit-draft` в `site-ai/operations.ts`, `GENERATOR_SCHEMAS`/`EVAL_SCHEMA_OF`/`AI_EVAL_SCHEMAS`, `INSTRUCTIONS` + `INSTRUCTION_SHA256`.
  4. Fake-прогон проверяет контур в CI. Живой прогон на модели — после ключа и утверждённого потолка (§12).
  5. До живого прогона генератор остаётся в коде выключенным (`enabledInP0=false`); M2 принимается на ручном пути + fake-контуре (Р-RD-17).

### M2.4 Content QA & Policy Gate

Новый вид QA **`reddit_policy`** в `pub_qa_checks.kind` (закрытый список). Триггер `pub_qa_checks_guard` сейчас разрешает системного актёра только для `ai_review`; миграция P-R расширяет его: `reddit_policy` ↔ `system:reddit-policy`. Пишется автоматически при заморозке версии и повторно — перед согласованием и перед копированием. Это детерминированные чистые функции `publisher/reddit/checks.ts`, без LLM.

| Проверка | Результат |
|---|---|
| актуальность правил (`policyGate`) | BLOCK / `recheck_required` |
| реклама при `promotion_prohibited` | BLOCK |
| ссылки против `linksPolicy` | BLOCK (prohibited/unknown) / WARN (restricted) |
| раскрытие аффилированности: `affiliation ≠ none` и пустой `disclosure`, либо disclosure не виден в первых 300 знаках body | BLOCK (A08) |
| неподтверждённые факты: пункт `claimMap` с `needs_verification` или источник не allowed/отозван | BLOCK; `needs_verification` без числа и обещания — WARN |
| фальшивые отзывы: маркеры личного опыта при `affiliation ≠ customer`, цитата «клиента» без источника | BLOCK (A07) |
| ПД: `pii-guard` и `looksLikeContact` в title/body/disclosure | BLOCK |
| дубли: Жаккар ≥ 0,6 с другой Reddit-версией продукта за 90 дней (`rules.ts` — расширить) | WARN |
| оскорбления: словарь uk/ru/en (версионируемый список) | WARN |
| контекст треда: comment без треда/выдержки | BLOCK |
| флейр обязателен, а `flairSuggestion` пуст | WARN |

- **Хранение.** BLOCK = `blockers[]` с новыми кодами `reddit_*`, `result='fail'`. WARN = новая колонка **`warnings Json`** в `pub_qa_checks` (Р-RD-8).
- **Блокировка согласования.** `approvalBlockers` для Reddit-материалов требует последний `reddit_policy` без блокеров, а также editorial и technical `pass`, как у всех. В `ApprovalBlocker` добавляется `reddit_policy_block`.
- **Подтверждение WARN.** При согласовании передаётся `acknowledgedWarnings: string[]`. Сервер требует, чтобы список совпал с кодами WARN последней проверки, иначе 409 `{reason:'warnings_not_acknowledged', codes}`. Подтверждение хранится в `meta` аудита согласования — `pub_approvals.reason` для этого не годится, его перезаписывает каскад.
- **AI-ревью** (`pub.qa.review`) остаётся совещательным: в согласовании оно не учитывается (ДИЗ §12.5). Это сознательно: «фальшивые отзывы» и «неподтверждённые факты» блокируют детерминированные правила, а модель только подсказывает.
- В интерфейсе нет формулировок «юридически корректно» или «соответствует правилам Reddit». Есть только «проверки P-R пройдены на снимке правил vN от <дата>».

### M2.5 Editor & revision diff

Экран материала:
- **Сравнение вариантов.** 2–3 версии-черновика рядом, плюс существующий `diff` (`content-api` маршрут `diff`, `lineDiff`) между любыми двумя версиями.
- **Редактирование** — существующие мутации черновика. После `submit` — только новая версия; материал в `scheduled` (после копирования) сначала снимается переходом `unschedule` (PO/OP, причина обязательна).
- **Панели.** Evidence (источники и `claimMap`), правила (снимок, `reviewState`/`stale`, условия), disclosure preview, счётчик слов и знаков.
- **Предпросмотр Markdown.** Приблизительный, на клиенте, через безопасный рендерер подмножества Reddit-markdown: абзацы, списки, `**`/`*`, `>`, inline-код. Без HTML, без автоссылок на изображения. Пометка «приблизительно».
- **«Перегенерировать абзац»** — вызов `pub.reddit.draft` с `request` на конкретный абзац (одна генерация задачи). Результат подставляется в текущий черновик (до `submit` он изменяем), прежний текст остаётся в истории вызовов и в аудите; замороженная версия не меняется никогда.
- **Согласования неизменны:** `pub_approvals` append-only.

### M2.6 Review & Manual handoff

**Согласование** — существующий `POST /publisher/products/:pid/versions/:vid/approve`, действие `version.approve` (PO, selfReview). Сервер дополнительно проверяет:
- hash актуален (`assertHashCurrent`);
- снимок `meta.ruleSnapshotId` текущий, `reviewed` и не `stale`; иначе `PUB_APPROVAL_STALE {reason:'rules_changed'|'rules_stale'}`;
- `policyGate` даёт `ok`;
- WARN подтверждены.

Отказ — существующий переход `request_changes` (`POST …/contents/:cid/transition`, причина обязательна): версия переходит в `changes_requested` и возвращается автору.

**Копирование** — `POST …/reddit/contents/:cid/copy` (`reddit.handoff`: PO, OP — как переход `schedule` и `publication.manage` в `core/state-machines.ts` и `roles.ts`):
- повторно проверяет согласование, hash, снимок, `policyGate` и гейт `reddit_publish` (Р-RD-9);
- возвращает **точный утверждённый текст** (для post — `title` и `body`, для comment — только `body`; плюс `flairSuggestion`) и `copyToken` — sha256 от `versionHash` + время;
- пишет аудит `copy`, материал переходит в `scheduled` (существующий переход `schedule`);
- исходящих запросов нет (A11);
- в кабинете — `copyText` из kit (запасной путь для WebView Telegram); сейчас функция не экспортируется — экспортировать в `site-tma-kit` и разнести `kit:sync`.

Копирование ≠ публикация: экран это говорит явно.

**«Открыть Reddit»** — ссылка на сохранённый `threadUrl` (comment) или `canonicalUrl` сообщества (post). Сервер её не открывает и не проверяет.

**«Отметить опубликованным»** — `POST …/reddit/contents/:cid/report-publication` (`reddit.handoff`). Тело: `{opKey, url, postedAt, notes?}`.
- `url` — только `https://(www.|old.)?reddit.com/r/<name>/comments/<id36>/…`, приводится к канонической форме. Сообщество в URL должно совпасть с сообществом брифа (A15: иначе 400 `PUB_VALIDATION {field:'url'}`).
- `postedAt` не в будущем.
- Создаётся `pub_publications` с `channelId` канала сообщества, `status='published'`, `reportKind='user_reported'` (новая колонка, Р-RD-10), `verifyStatus='not_checked'` навсегда. `stage` вычисляется существующим правилом: `live` только в продукте `working` + `mode=live` и при открытом `public_publish` (сервис и триггер); иначе `test`. Материал отмечается через `ContentPort.markPublished` (при `stage=test` материал не меняется — ДТ-1).
- Повторное копирование уже скопированного материала разрешено и не делает второй `schedule`: пишется только аудит `copy`.
- Маршрут `verify` для `user_reported` отвечает 409 `{reason:'manual_only'}` — статуса VERIFIED не бывает (A12).

### M2.7 API (дополнение к M1.5)

| Метод и путь (после `…/reddit`) | Действие |
|---|---|
| `POST /briefs`, `GET /briefs`, `GET /briefs/:id`, `PATCH /briefs/:id`, `POST /briefs/:id/ready` | `reddit.read` / `reddit.manage` |
| `POST /briefs/:id/generate` | `ai.generate` (PO, ED); гейт `ai_use` + флаг |
| `GET /briefs/:id/contents` | `reddit.read` |
| `POST /contents/:cid/check` | `qa.technical` — ручной перезапуск `reddit_policy` |
| `POST /contents/:cid/copy`, `POST /contents/:cid/report-publication` | `reddit.handoff` |
| `GET /publications` | `reddit.read` — фильтр Reddit-каналов поверх `pub_publications` |

Версии (`…/contents/:cid/versions[/:vid]`), отправка (`…/versions/:vid/submit`), QA (`…/versions/:vid/qa-checks`), согласование (`…/versions/:vid/approve`), отказ (`…/contents/:cid/transition`), diff (`…/versions/:a/diff/:b`) — **существующие маршруты** контента (`contracts/content-api.ts`), отдельных не создаём.

- **Идемпотентность.** `opKey` у генерации, согласования, копирования и отчёта о публикации, как у всех мутаций.
- **Optimistic concurrency.** `expectedRevision` на головах.
- **Ошибки LLM** не удаляют черновики: вызов пишется в `pub_ai_calls`, версия не создаётся, ручной путь доступен.

### M2.8 QA и выпуск M2

- **Unit:** схема `pub.reddit.draft`; `postCheck`; `checks.ts` (каждая строка таблицы M2.4); переходы; hash с `ruleSnapshotId`.
- **db:** триггеры видов материала и `reportKind`; `warnings`; eval-guard с N задач.
- **Приёмка:** `reddit-m2-*.spec.ts` — согласование и его инвалидирование, stale rules, тайм-аут LLM (fake), аудит.
- **E2E-RD-02:** бриф → 3 варианта (fake) → правка → QA → согласование → копирование → ручной URL. Отдельно для post и comment. Плюс блокировка запрещённого сообщества, правка после согласования, XSS и injection.
- **Мутации:** 8–10.
- **Внутренний аудит** пакета, затем включение в пакет внешнего аудита (§10).

**Gate M2:** E2E-RD-02 passed; ноль запросов к Reddit-хостам; статуса VERIFIED у `user_reported` нет (тест); согласования привязаны к неизменяемой версии и снимку правил. Генератор на живой модели — отдельный шлюз после eval `2.3` (Р-RD-17).

---

## 4. Гейт `reddit_publish` и параметры

Гейт `public_publish` требует параметры сайта: `domain_host`, `hosting`, `perf_targets`, `consent_map`, `event_map` и т. п. Для **копирования** Reddit-текста они не нужны, поэтому вводится **гейт `reddit_publish`** (Р-RD-9). Он не заменяет правило стадии публикации: запись `stage=live` по-прежнему требует продукта `mode=live` и `public_publish` (сервис + триггер `pub_publications`). До выпуска сайта реальные Reddit-публикации записываются как `test` и в отчёты не входят — это вопрос владельцу (§12):
- ключи: `niche`, `language`, `market`, `offer_active_version`, `responsibles`, `reddit_rules_stale_days`;
- нужен продукт `working`.

Гейт проверяется при копировании: закрыт — 409 `PUB_GATE_CLOSED {gate:'reddit_publish', missing}`. Регистрация гейта: `GATE_NAMES` (`contracts/common.ts`), `GATE_PARAMETER_KEYS`, ветка `evaluateGate`, `DEPENDENT_STAGES` (`contracts/states.ts`) и SQL-список в `pub_parameter_decisions_guard`.

Новые параметры (`PARAMETER_KEYS` 38 → 40):
- `reddit_rules_stale_days`;
- `reddit_excerpt_retention_days` — по умолчанию 180: собственное задание P-R `reddit-retention` (не общий `housekeeping` P-A1 — `pub_sources` принадлежат P-B1, это сверяет `table-ownership.spec.ts`) через порт источников заменяет фрагмент выдержек архивированных и пропущенных возможностей на `[видалено за терміном зберігання]` и пересчитывает `contentHash`. Выдержки не связаны с версиями, поэтому неизменность источника не мешает.

Оба добавляются по процедуре §6 ДИЗ: SQL `pub_parameter_keys()`, посев строк `assumption` для существующих продуктов, `contracts.spec`.

---

## 5. Роли и действия

Новой роли REVIEWER нет (Р-RD-11). Её функции распределены по существующим ролям. Как и везде в Publisher, проверка собственной работы не запрещена, а помечается `selfReview=true` и видна в аудите и на экране.

| ТЗ v1.3 | Роль продукта |
|---|---|
| OWNER | PO (`product_owner`); управление ролями — AD или владелец кабинета |
| EDITOR | ED (`editor`) |
| REVIEWER | PO для согласования текста (`version.approve`); PO и ED для review правил (`reddit.rules.review`, пометка selfReview) |
| VIEWER | VW (`viewer`), AN (`analyst`) — только чтение |
| — | OP (`operator`) — копирование и отчёт о публикации (`reddit.handoff`), как в ручной публикации P0 |
| — | SA (`sales`) — нет доступа |

Новые действия в `PUB_PERMISSIONS`:

| Действие | PO | ED | OP | AN | VW | AD | Признаки |
|---|---|---|---|---|---|---|---|
| `reddit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `reddit.manage` | ✓ | ✓ | | | | | |
| `reddit.rules.review` | ✓ | ✓ | | | | | selfReview |
| `reddit.handoff` | ✓ | | ✓ | | | | |

`version.approve`, `ai.generate`, `qa.*` — без изменений.

**Приёмка:**
- A02: VW на `POST /rules/:id/review` и на approve → 403 `PUB_ROLE_REQUIRED`;
- матрица сверяется `roles.spec.ts` (все маршруты `…/reddit/**`) и `assist/scripts/publisher-view.test.ts`.

---

## 6. Связь с P0 и отчётами

- **Объём.** Reddit MVP — **дополнение вне P0 ТЗ 2.2**. Шлюзы P0 (D0, закупка), 44 AT и 30 AI-задач P0 он не меняет, кроме eval `2.3` (M2.3.1). Его включение — отдельное решение владельца (Р-RD-0).
- **Атрибуция.** Канал `community` с `utmSource='reddit'`. Переходы с reddit.com уже распознаются `core/attribution.ts` как community/social. Если ссылки разрешены и использованы, они получают UTM канала. Заявки и сессии из Reddit попадают в существующие отчёты F11/F17 по каналу.
- **Трафик.** «SEO-трафик» и «публикация подтверждена» нигде не обещаются. Отчёт показывает публикации `user_reported` отдельной строкой.
- **Бэкап и восстановление P-E.** Новые таблицы входят в экспорт. При восстановлении снимки правил переносятся `reviewed`, возможности — без изменений, гранты — отозванными (как в P-E).

---

## 7. Кабинет: что добавить

- Раздел `reddit` в `PUBLISHER_SECTIONS` (группа «Контент», после «Материалы»).
- `lib/publisher/reddit-api.ts` с декодерами, сверка с `REDDIT_ROUTES` в `assist/scripts/publisher-bodies.test.ts`.
- Тип владельца раздела в `registry.ts` расширить: `'P-G1'|'P-G2'|'P-R'`.
- Экраны: Projects, Communities, Rules, Opportunities, Keywords, Brief, Studio (варианты, редактор, diff, панели, проверки, согласование, копирование, отчёт).
- Словари uk/ru/en, паритет — `i18n.test.ts`.
- Смоук 1280/360, axe, тексты цитат без HTML.

---

## 8. Эксплуатация и безопасность

1. **Tenant и RBAC** на сервере. Это существующие механизмы: проверены матрицей ролей предаудита D1 (1969 ячеек), новые маршруты добавляются в неё автоматически.
2. **ПД.**
   - `pii-guard` на вводе (выдержки, тезисы, тексты), маска ПД перед моделью;
   - журналы без текста промпта — в `pub_ai_calls` только маскированный вывод и `rawExcerpt`;
   - выдержки ≤ 2000 знаков, `retention` — §4;
   - целые чужие треды и профили не импортируются: ограничение длины, сервис P-R не заполняет `pub_sources.author`, ников и ссылок на профили не хранит.
3. **Нет запросов к Reddit:**
   - правило графа импортов;
   - отказ `source-import` для Reddit-хостов;
   - runtime-тест: `fetch`, `http(s).request` подменены бросающими функциями, по всем маршрутам `…/reddit/**` (A16).
4. **XSS и CSRF.** Текст выводится только как текст; предпросмотр markdown — безопасное подмножество без HTML; CSP кабинета не меняется. От CSRF защищают существующие барьеры веб-кабинета (заголовок `X-Telegram-App`/проверка Origin, cookie `SameSite=Lax`) и правило D1-02: действия с побочным эффектом — только POST.
5. **Расходы LLM.** Бюджет `ai_budget_usd_month` и резерв шлюза — общие с P0. Генерации Reddit видны в журнале AI с генератором `pub.reddit.draft`.
6. **Аудит** каждого review правил, копирования, согласования и отчёта о публикации.
7. **Откат** — Р-RD-12.
8. **Kill switch:** `PUBLISHER_REDDIT_AI_ENABLED` для генерации и `PUBLISHER_REDDIT_ENABLED` для всего раздела. Исследование остаётся доступным при выключенной генерации.

---

## 9. Тесты приёмки AT-RD (вместо A01–A16)

| AT-RD | Исходный | Проверка в коде | Файл (план) |
|---|---|---|---|
| 01 | A01 | чужой кабинет или продукт на всех маршрутах `…/reddit/**` → 404, без побочных эффектов | `z-isolation.spec.ts` (авто) + `reddit-m1-access.spec.ts` |
| 02 | A02 | VW: review правил и approve → 403 | `reddit-m1-access.spec.ts` |
| 03 | A03 | unknown или prohibited → `block`, score 100 не снимает | `reddit-m1-policy.spec.ts` |
| 04 | A04 | новый снимок → `recheck_required`, отзыв согласования, нужен повторный review | `reddit-m1-policy.spec.ts` |
| 05 | A05 | дубль треда → 409 `{existingId}`, строк не прибавилось | `reddit-m1-opportunities.spec.ts` |
| 06 | A06 | одинаковые входы → одинаковый score (свойства) | `reddit-score.spec.ts` |
| 07 | A07 | вымышленный отзыв → BLOCK `reddit_fake_testimonial` | `reddit-m2-checks.spec.ts` |
| 08 | A08 | нет раскрытия → BLOCK `reddit_disclosure_missing` | `reddit-m2-checks.spec.ts` |
| 09 | A09 | правка после согласования → новая версия, согласование не действует (`PUB_APPROVAL_STALE`) | `reddit-m2-approval.spec.ts` |
| 10 | A10 | LLM недоступна или выключена → ручной редактор, версия создаётся вручную | `reddit-m2-manual.spec.ts` |
| 11 | A11 | копирование → 0 исходящих запросов, аудит `copy` | `reddit-egress.spec.ts` |
| 12 | A12 | отчёт о публикации → только `user_reported`, `verify` → 409 | `reddit-m2-handoff.spec.ts` |
| 13 | A13 | comment без контекста → 400 `PUB_VALIDATION` (в ТЗ v1.3 — 422, Р-RD-14) | `reddit-m2-brief.spec.ts` |
| 14 | A14 | вредный текст в выдержке → `injectionFlag`, в промпте `trust="untrusted"`, в кабинете — текст | `reddit-m2-injection.spec.ts` + смоук assist |
| 15 | A15 | невалидный Reddit-URL или чужое сообщество → 400 | `reddit-m1-opportunities.spec.ts`, `reddit-m2-handoff.spec.ts` |
| 16 | A16 | инспекция сети → ноль запросов к Reddit-хостам по всем маршрутам | `reddit-egress.spec.ts` |
| 17 | — | флаг выключен → 404 на API, раздела нет в кабинете | `reddit-m1-flag.spec.ts` |
| 18 | — | бэкап и восстановление переносят Reddit-сущности по правилам P-E | `restore-*.spec.ts` (расширить) |

Каталог `at-catalog.ts` и трассировку §18 ДИЗ дополнить AT-RD-01…18 и E2E-RD-01/02.

---

## 10. Спринты и оценка (пересчёт под код)

Переиспользуются изоляция, роли, операции, аудит, источники, версии, hash, согласование, публикации, AI-шлюз, eval и экраны-компоненты. Поэтому объём меньше исходных 15–27 дней, но добавляется дисциплина закрытых списков и триггеров.

| Спринт | Содержание | Зависимость | Оценка, engineer-days |
|---|---|---|---:|
| R1 | M1.0–M1.1: флаг, миграция, таблицы, закрытые списки, роли, seed | P0 в main | 2–3 |
| R2 | M1.2–M1.6: policy, score, API, экраны, E2E-RD-01, egress, аудит пакета | R1 | 3–5 |
| R3 | M2.1–M2.3: Reddit-бриф, виды материала (развести ветки «не article = адаптация»), `pub.reddit.draft` (fake), eval `2.3` (fake) | Gate M1 | 3–5 |
| R4 | M2.4–M2.6: `reddit_policy`, WARN и подтверждение, гейт `reddit_publish`, студия, копирование и отчёт | R3 | 3–4 |
| R5 | M2.7–M2.8: E2E-RD-02, мутации, внутренний аудит, документы | R4 | 1–2 |

Итого **12–19 дней** + резерв 2–3 дня. **Внешние зависимости вне оценки:**
- ключ модели и утверждённый потолок — для живого eval `2.3`;
- решение владельца о включении (Р-RD-0);
- внешний аудит, если требуется.

Сначала принимается M1, затем M2. Оценки предварительные, не SLA.

---

## 11. Решения адаптации (Р-RD)

| ID | Решение | Почему |
|---|---|---|
| Р-RD-0 | Reddit MVP — пакет P-R в модуле Publisher, вне объёма P0 2.2; включение — решение владельца; режим только MANUAL_COPY (ADR) | переиспользование проверенных механизмов; P0-шлюзы не трогаются |
| Р-RD-1 | `pub_reddit_projects` — группа внутри продукта, без `brand_id` | продукт один на сайт; бренд — профиль продукта |
| Р-RD-2 | сообщество = `pub_reddit_communities` + обязательный канал `community` | публикации, UTM и отчёты работают через каналы |
| Р-RD-3 | снимки правил — отдельная append-only таблица; первоисточник — `pub_sources`; `stale` вычисляется, а не хранится | нет cron и гонок; отзыв и hash источника — общие |
| Р-RD-4 | выдержки и доказательства — `pub_sources` (`discussion`, private, restricted ≤ 2000); restricted не подтверждает claims | ПД, injection, отзыв, retention — общие |
| Р-RD-5 | отдельная `pub_reddit_briefs` | `pub_briefs` привязан к вопросу сайта и формату статьи |
| Р-RD-6 | версии Reddit = `pub_content_versions` (`kind` `reddit_post`/`reddit_comment`); варианты — в `pub_ai_calls.output`, выбранный становится единственным черновиком | заморозка, hash, diff, каскады, согласование готовы; инвариант «один черновик» сохраняется |
| Р-RD-7 | `ruleSnapshotId`, `affiliation`, `claimMap` входят в hash версии | согласование автоматически привязано к снимку (требование M2.6) |
| Р-RD-8 | BLOCK — `blockers` + `fail`; WARN — новая колонка `warnings` + `acknowledgedWarnings` при согласовании (хранится в `meta` аудита) | в `pub_qa_checks` нет уровня WARN |
| Р-RD-9 | гейт `reddit_publish` для копирования; стадия публикации — по общему правилу (`live` ⇔ продукт live + `public_publish`); env-флаг вместо параметра продукта | параметры сайта для копирования не нужны; инвариант стадии в триггере не трогаем; флаг ТЗ — тумблер, а не бизнес-условие |
| Р-RD-10 | ручная публикация — `pub_publications` с `reportKind='user_reported'`, `verify` запрещён | нет ложного VERIFIED |
| Р-RD-11 | новой роли REVIEWER нет: PO согласует, PO/ED проверяют правила; своё — с пометкой `selfReview`; копирование и отчёт — PO/OP | закрытый список ролей; selfReview в коде — пометка, а не запрет (иначе кабинет из одного человека встанет) |
| Р-RD-12 | миграции forward-only; откат = флаг off + компенсирующая миграция + бэкап P-E; таблицы P-R изолированы | так устроен репозиторий; down-скриптов нет нигде |
| Р-RD-13 | префикс `/publisher/products/:pid/reddit/**` | область продукта, guard и изоляция работают автоматически |
| Р-RD-14 | ошибки валидации — 400 `PUB_VALIDATION {fields}`, не 422 | единый контракт клиента; 422 в модуле только у `PUB_AI_SCHEMA_INVALID` |
| Р-RD-15 | 2–3 варианта — массивом в одном вызове | не съедать `BASE_GENERATIONS = 2` |
| Р-RD-16 | общий шлюз не меняется: генерация списывается при вызове, повтор после сбоя — второй генерацией или `extra`; «ремонт» схемы сохраняется | шлюз общий с P0 и прошёл D2; правка затронула бы допуск всех генераторов |
| Р-RD-17 | `pub.reddit.draft` включается только после eval `2.3` (30 + 12 задач, порог 80 %, критические — все) на живой модели; до этого M2 работает вручную и на fake-контуре | новый генератор меняет `configHash` и закрывает `ai_use` всем |

## 12. Вопросы владельцу

1. Включать ли Reddit MVP в ближайший цикл (Р-RD-0)? Если да — до или после внешнего аудита P0? Рекомендация: после внутреннего аудита P-R и вместе с внешним, одним охватом.
2. Ключ модели и потолок для eval `2.3` (42 задачи). По оценкам предаудита D2 для 30 задач (реалистично ≈ $0,25–0,30, верхняя оценка кода $3,01) пропорционально: реалистично ≈ $0,35–0,45 за прогон, верхняя ≈ $4,2. Предлагаемый жёсткий потолок `--max-usd` — $5 за запуск.
5. До выпуска сайта (`mode=live`) реальные Reddit-публикации пишутся как `test` и не входят в отчёты (Р-RD-9). Оставить так (рекомендация: Reddit — после D0) или вводить отдельное правило стадии для внешних каналов? Второе меняет триггер P0 и требует повторной проверки.
3. Язык и рынок первого проекта (`locale`, `market`) и список 10 сообществ для приёмки — нужны для seed и E2E. Без них используются синтетические.
4. Словарь «оскорблений» и маркеров «личного опыта» — утверждает владелец или ED; без него используется стартовый список из кода с пометкой `assumption`.
