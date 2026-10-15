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
- Пока флаг выключен, все маршруты `…/reddit/**` отвечают вошедшему участнику 404 `PUB_NOT_FOUND` без `details` — так же, как на несуществующий объект; анониму — обычный 401 проверки входа, как на любом маршруте кабинета (Р-RD-24).
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

### 8.1 Импорт чернового исследования (Р-RD-87)

Черновой реестр исследования (CSV `{сегмент}-{communities,opportunities,keywords}.csv`, формат —
бриф исследования) переносится в раздел «Reddit» одной командой ПОСЛЕ включения флага. Инструмент
работает только через HTTP API кабинета (не SQL), с правами того, чья сессия передана:

```
cd sites-backend
npm run reddit:import -- --dir=<каталог CSV> --project-title="Pilot research" --locale=en \
  --market="US/EU SMB+SaaS" [--segments=smb,saas,agency]                        # офлайн-план
PUB_REDDIT_IMPORT_HEADERS='<заголовки сессии владельца: JSON или строки «Имя: значение»>' \
  npm run reddit:import -- … --base-url=<API кабинета> --site=<siteId>|--product=<productId> \
  [--apply] [--out=report.json]
```

- По умолчанию — dry-run: печатает план (что будет создано, что уже есть, что отклонено и с каким
  кодом) и BLOCK по правилам — сейчас и после проверки снимка владельцем. `--apply` пишет.
- Авторизация — только переменная окружения `PUB_REDDIT_IMPORT_HEADERS` (cookie/заголовки сессии
  владельца); секретов в аргументах нет, значения заголовков не печатаются. Запросы — только на
  `--base-url` и только `/publisher/…`; адреса Reddit как `--base-url` запрещены; к Reddit
  инструмент не обращается (ноль запросов проверен тестом).
- Проект — по названию (`--project-title`, активный); сообщества — по имени (одно на продукт;
  сегменты сливаются в `topics`); ключевые запросы — все, дубли по нормальной форме — один;
  возможности — по ключу треда.
- Правила из вторичных источников НЕ становятся проверенными: снимок создаётся `unreviewed`,
  `conditions` из CSV и строка «secondary: <источник>», `sourceUrl` — первый URL поля `source_url`
  (reddit.com только хранится как текст, сервер его не загружает), остальное — в выдержке. Новый
  снимок — только если текущий отличается и не проверен владельцем (проверенный — `kept_reviewed`).
  Пока снимки не проверены, все возможности — BLOCK `rules_unreviewed`.
- Возможности — только треды, которые нормализуются (`/r/<name>/comments/<id>`), в сообществе из CSV
  (иначе `not_thread` / `community_missing` / `duplicate_in_csv`); факторы и обоснования — из CSV
  (`why` вида `tf: …; itf: …`, без обоснования — «research CSV (<сегмент>): no rationale given»),
  `policy_risk` считает сервер; выдержки нет (её нет в CSV), контекст исследователя — `angle`.
- Тексты с контактом или ником по правилу сервера: ссылка — до хоста, длинные числа — `…`; не
  помогло — отказ `pii`.
- Идемпотентность: перед записью — чтение списков; `opKey` — детерминированный UUID v4 от вида,
  ключа и тела; 409 `{reason:'duplicate', existingId}` — «уже есть». Повторный запуск дублей не
  создаёт.

Проверено на стенде (свой порт и база, сборка `dist`, сид E2E) с черновым реестром: 32 сообщества,
32 снимка `unreviewed`, 44 запроса, 14 возможностей (все BLOCK `rules_unreviewed`); отклонено 6 строк
(5 — «новый пост», не тред; 1 — сообщество вне CSV); повторный запуск — всё «уже есть».

---

## 9. Тесты приёмки AT-RD (вместо A01–A16)

| AT-RD | Исходный | Проверка в коде | Файл |
|---|---|---|---|
| 01 | A01 | чужой кабинет или продукт на всех маршрутах `…/reddit/**` → 404, без побочных эффектов | `z-isolation.spec.ts` (авто) + `reddit-m1-access.spec.ts` |
| 02 | A02 | VW: review правил и approve → 403 | `reddit-m1-access.spec.ts` |
| 03 | A03 | unknown или prohibited → `block`, score 100 не снимает | `reddit-m1-policy.spec.ts` |
| 04 | A04 | новый снимок → `recheck_required`, отзыв согласования, нужен повторный review | `reddit-m1-policy.spec.ts` |
| 05 | A05 | дубль треда → 409 `{existingId}`, строк не прибавилось | `reddit-m1-opportunities.spec.ts` |
| 06 | A06 | одинаковые входы → одинаковый score (свойства) | `reddit-m1-score.spec.ts` |
| 07 | A07 | вымышленный отзыв → BLOCK `reddit_fake_testimonial` | `reddit-m2-checks.spec.ts` |
| 08 | A08 | нет раскрытия → BLOCK `reddit_disclosure_missing` | `reddit-m2-checks.spec.ts` |
| 09 | A09 | правка после согласования → новая версия, согласование не действует (`PUB_APPROVAL_STALE`) | `reddit-m2-approval.spec.ts` |
| 10 | A10 | LLM недоступна или выключена → ручной редактор, версия создаётся вручную | `reddit-m2-manual.spec.ts` |
| 11 | A11 | копирование → 0 исходящих запросов, аудит `copy` | `reddit-m2-egress.spec.ts` |
| 12 | A12 | отчёт о публикации → только `user_reported`, `verify` → 409 | `reddit-m2-handoff.spec.ts` |
| 13 | A13 | comment без контекста → 400 `PUB_VALIDATION` (в ТЗ v1.3 — 422, Р-RD-14) | `reddit-m2-brief.spec.ts` |
| 14 | A14 | вредный текст в выдержке → `injectionFlag`, в промпте `trust="untrusted"`, в кабинете — текст | `reddit-m2-injection.spec.ts` + смоук assist |
| 15 | A15 | невалидный Reddit-URL или чужое сообщество → 400 | `reddit-m1-opportunities.spec.ts`, `reddit-m2-handoff.spec.ts` |
| 16 | A16 | инспекция сети → ноль запросов к Reddit-хостам по всем маршрутам | `reddit-m1-egress.spec.ts` (M1), `reddit-m2-egress.spec.ts` (M2) |
| 17 | — | флаг выключен → 404 на API, раздела нет в кабинете | `reddit-m1-flag.spec.ts` |
| 18 | — | бэкап и восстановление переносят Reddit-сущности по правилам P-E | `reddit-m1-restore.spec.ts` |

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

### Решения реализации M1 (13.10.2026, пакет P-R)

Статус: M1 Research реализован в sites-backend (экраны — отдельно). Трассировка — ДИЗ §18.5, итог — ДИЗ §28.

| ID | Решение | Почему |
|---|---|---|
| Р-RD-18 | В M1 добавлен только параметр `reddit_rules_stale_days` (`{days}`, 1..365, умолчание 30; 39 ключей). `reddit_excerpt_retention_days` с заданием `reddit-retention` и гейт `reddit_publish` (§4) — в M2 вместе с копированием | гейт нужен только копированию, ретенция — архиву возможностей; без M2 они были бы незадействованными ключами и заглушками |
| Р-RD-19 | P-R пишет только `pub_reddit_*`. Первоисточник правил и выдержку треда создаёт `SourcesService` (P-B1), канал `community` — `ChannelsService` (P-C): модули экспортируют сервисы, новых портов нет; `table-ownership` без исключений | владение §6.8 сохраняется, валидация источника и канала — та же, что у пакетов-владельцев |
| Р-RD-20 | Сверх таблицы §M1.5 — `GET /communities/:id` и `GET /opportunities/:id` (итого 23 маршрута; с Р-RD-46 — 25) | карточки экранов и перечитывание после 409 без загрузки списка |
| Р-RD-21 | В API имя проекта — `title`, сообщества — `subreddit` (колонка `name`); ошибки CAS — `PUB_CONFLICT {currentRevision}`, дубли — `{reason:'duplicate', existingId}`; списки — `id desc`, курсор `nextBefore` | ключ `name` запрещён в ответах мутаций (`runOperation`); формы ошибок и курсора — общие для модуля |
| Р-RD-22 | `relevance/risk/priority` — `Int` (формула округляет; целочисленная арифметика без float), колонка `policyReasons` (jsonb) хранит причины гейта; `stale` — календарные дни Kyiv от `checkedAt` (`addKyivCalendarDays`) | детерминизм A06; экран и аудит видят причину; правило модуля «без суточной арифметики в мс» (DST) |
| Р-RD-23 | Переходы возможности: `qualify` — только из `new` и при гейте `ok` по ТЕКУЩЕМУ снимку (иначе 409 `policy_block` / `policy_recheck` / `status`); пересчёт (`PATCH` факторов, `POST …/score`) переводит `blocked`/`recheck_required` → `new` при `ok` и обратно при block/stale; `skip` — из `new|qualified|recheck_required|blocked`; `archive` — из любого, кроме `archived`; триггер держит `qualified|in_brief` только при `policy=ok` | BLOCK не снимается score (A03) ни сервисом, ни прямой записью |
| Р-RD-24 | Флаг `PUBLISHER_REDDIT_ENABLED` — первый гвард контроллера: участнику — 404 без `details` до членства и ролей; анониму — обычный 401 глобальной проверки входа (как на любом маршруте кабинета) | проверка входа глобальная и идёт раньше гвардов контроллера; 404 участнику неотличим от отсутствия объекта |
| Р-RD-25 | Выдержка треда: ≤ 2000, `pii` (контакты) и `profile_ref` — 400. Выдержка и первоисточник правил — доказательства P-R (`pub_sources.origin='reddit'`, Р-RD-31): после вставки неизменны (триггер + 409 `reddit_evidence_locked` в общем `PATCH /sources/:id`); выдержка меняется только новой редакцией через `PATCH …/opportunities/:id` (новый источник с `supersedesId`, те же проверки P-R), правила — новым снимком | §8.2 «ников и ссылок на профили не хранит»; без блокировки общий маршрут P-B1 снимал все гарантии выдержки (аудит P-R S1-2) |
| Р-RD-26 | Заголовок первоисточника правил — без имени сообщества (`Правила спільноти Reddit · vN`); заголовок канала — `r/<name>`, а если имя похоже на телефон (7+ цифр) — `Reddit · спільнота` (имя остаётся в `code`) | `pii-guard` заголовков P-B1/P-C отверг бы такие имена |
| Р-RD-27 | Архив и восстановление сообщества — `PATCH status` (глагола нет в §M1.5); у проекта — `POST …/archive`; уникальны `(productId, name)` и `channelId` | сообщество одно на продукт (§M1.1) и одно на канал |
| Р-RD-28 | Каскад новой версии правил в M1 — только возможности (`new|qualified|in_brief` → `recheck_required`, `rules_changed`, аудит на каждую); каскад Reddit-материалов (`content/cascades.ts`, отзыв согласований) — в M2 вместе с видами `reddit_post|reddit_comment` | в M1 Reddit-материалов нет |
| Р-RD-29 | Каталог AT-RD — `AT_RD_CATALOG` отдельно от 44 сценариев P0 (шлюзы пустые, у M2 — план и статус `blocked`); `reddit-at.spec` сверяет метки `[AT-RD-NN]` | отчёт P0 и счёт шлюзов не меняются |
| Р-RD-30 | Граф: `publisher-reddit-no-network` (без `site-crawl/**`, импорта по URL, ревалидации), `publisher-reddit-no-network-io` (без сетевых пакетов Node, HTTP-клиентов, `fetch(`), AI-слой не берёт сервисы P-R (чистые `normalize/policy/score` — можно, для `pub.reddit.draft` в M2) и не называет таблицу снимков (`publisher-ai-no-reddit-rules`). Миграция `20261020090000_publisher_reddit` пересоздаёт функции-списки ядра (`CREATE OR REPLACE`), `states.spec` сверяет действующий SQL | «LLM не меняет policy» (§M1.3) статически; выкаченные миграции не правятся |

### Раунд исправлений внутреннего аудита M1 (13.10.2026)

| ID | Решение | Почему |
|---|---|---|
| Р-RD-31 | Новая колонка `pub_sources.origin` (`content`\|`reddit`, неизменна) в миграции P-R; гвард `pub_reddit_sources_guard`: вставка `reddit` — только url/discussion, private, manual, restricted, без автора и контактов, ≤ 5000/2000; после вставки неизменны `kind`, `url`, `fragment`, `contentHash`, `title`, `author`, `visibility`, `importedVia`, `supersedesId`, `usage` — только в `revoked`. `SourcesService.patch` отвечает 409 `PUB_CONFLICT {reason:'reddit_evidence_locked'}` до базы. NULL `origin` из старых копий бэкапа гвард заменяет на `content` | аудит S1-1/S1-2: отметка «проверено» и инварианты выдержки держатся базой, а не только вставкой P-R; колонка дешевле `EXISTS` по ссылкам и покрывает прежние редакции |
| Р-RD-32 | Доказательства P-R скрыты из общих `GET /sources` (список, фильтры, CSV), карточка `GET /sources/:id` → 404; видны только в маршрутах раздела (`reddit.read` + флаг). Отзыв (`POST /sources/:id/revoke`) по id доступен PO/ED | аудит S2-1: SA и выключенный флаг не обходят матрицу §5 |
| Р-RD-33 | Отозванный первоисточник текущего снимка → гейт `block` (`rules_source_revoked`); в той же транзакции отзыва (`RevocationService` → `reddit/cascade.ts`) возможности сообщества `new\|qualified\|in_brief` → `recheck_required` (`policy=block`) с аудитом | аудит S2-2: вывода о правилах без действующего источника нет |
| Р-RD-34 | Гейт «сейчас»: `policyNow` + `policyNowReasons` в карточке, списке и CSV возможностей пересчитываются при чтении (текущий снимок, `staleDays`, отзыв первоисточника; снимок сменился при гейте ok → `recheck_required`/`rules_changed`). Хранимые `policy`/`policyReasons` — «на момент оценки». `qualified` при `policyNow≠ok` экран подсвечивает; дальше (бриф M2) не переходит — проверка гейта при каждом следующем шаге | аудит S2-3: без пересчёта отобранная возможность на устаревших правилах выглядела «можно рекомендовать» |
| Р-RD-35 | Дубли при гонке: вставка под точкой сохранения, при 23505 — откат к ней и перечитывание → 409 `{reason:'duplicate', existingId}` (возможности, запросы — создание и смена фразы, сообщества) | аудит S3-1: экраны рассчитывают на `existingId` |
| Р-RD-36 | Ники и профили: после NFKC — `u/…`, `/u/…`, `/user/…`, `reddit.com/u\|user/…`, `r/u_…` → 400 `profile_ref` в выдержке, заголовке, `angle`, выдержке правил и `conditions[i]`; имена `u_*` — не сообщество и не тред | аудит S3-2 |
| Р-RD-37 | Операции над объектами архивного сообщества или проекта → 409 `community_archived`/`project_archived`: `qualify`, `score`, `PATCH` возможности, новый снимок правил, `PATCH` сообщества и запроса. `skip` и `archive` разрешены | аудит S3-6 |
| Р-RD-38 | `factors.policy_risk` отдаётся машиночитаемо: `why: null`, `reasons` — коды `rules_missing` \| `promotion_<политика>` + `links_<политика>`; экран переводит сам | замечание экранов: текст на одном языке в данных |
| Р-RD-39 | Правило графа `publisher-ai-no-reddit-rules` расширено на все имена `pub_reddit_*`/`pubReddit*`/`PubReddit*` в `publisher/ai/**` | аудит S3-5: AI-слой не пишет policy и статусы возможностей |

### Раунд 2 по повторному аудиту M1 (13.10.2026)

| ID | Решение | Почему |
|---|---|---|
| Р-RD-40 | Отзыв выдержки окончателен: если текущая выдержка возможности `revoked`, `PATCH …/opportunities/:id` с `excerpt` (текст или `null`) → 409 `PUB_SOURCE_NOT_ALLOWED {sourceIds, reason:'revoked'}`, как правка отозванного источника в P-B1; остальные поля правятся. Отвязка `null` у неотозванной выдержки работает (до раунда отвечала 400 `required`) | реаудит N-1: правка одной ролью ED возвращала отозванный (ПД, права, жалоба) текст новой редакцией; отвязка + новый текст обошли бы проверку |
| Р-RD-41 | Ответ `POST /sources/:id/revoke` для доказательства P-R (`origin='reddit'`) — без содержимого: `url`, `title`, `author`, `externalRef` = `null`, `fragment` = `''`; состояние отзыва, `contentHash`, `revision` — как есть. Независимо от флага: карточка `/sources/:id` для доказательств P-R всегда 404 | реаудит N-6b: при выключенном флаге ответ отзыва отдавал полный текст и URL (и хранил его в `pub_idempotency_keys`) |
| Р-RD-42 | `profile_ref` после NFKC убирает невидимые символы (мягкий перенос, нулевой ширины, направление) и заменяет знаки, похожие на `/` (`∕ ⁄ ⧸ ╱ ⟋ ⧶ Ⳇ ノ ㇓ 丿` и т. п.), на `/`; `u/…` и `user/…` ловятся после любого знака, кроме латинской буквы и цифры (`see/user/…`, `x_u/…`); путь `…/user/<имя>` любого сайта тоже считается профилем. Пробелы внутри (`u /ник`), экранирование (`u\/ник`) и буквы-двойники — предел регулярного выражения, их отсекает ручная проверка PO | реаудит N-4 |
| Р-RD-43 | Гвард `pub_reddit_sources_guard` замораживает у доказательств P-R и `injectionFlag`, `language`, `externalRef`, `publishedOn`, `isSynthetic`, `createdAt`/`createdBy`; меняются только `checkedAt`, `freshness`, отзыв (`usage → revoked`, `revoked*`), `revision`, `updatedAt` | реаудит N-3: пометка «похоже на команду» выводится из замороженного фрагмента и не должна сниматься в обход (M2 строит бриф из выдержки) |
| Р-RD-44 | Восстановление P-E после переноса строк применяет каскад P-R к первоисточникам, отозванным ПОСЛЕ копии (`redditOnSourceRevoked` в целевом продукте): возможности → `recheck_required/block [rules_source_revoked]` с аудитом от `restore:<id>`; в отчёте `applied.redditOpportunitiesRecheck`. Хранимое состояние восстановленного продукта = живому гейту (AT-RD-18) | реаудит N-5 |
| Р-RD-45 | Список и CSV возможностей принимают `?policyNow=ok\|recheck_required\|block` (400 `enum` на прочее). `policyNow` вычисляемый, поэтому сервер просматривает строки пачками по 200 (`id desc`) до заполнения страницы; курсор `nextBefore` прежний. Ежедневное задание пересчёта хранимого `policy` не вводится | реаудит N-6a: «нужно пересчитать» выбирается на сервере; задание дало бы вторую истину |

### Раунд 3 по аудиту экранов M1 (13.10.2026)

| ID | Решение | Почему |
|---|---|---|
| Р-RD-46 | Два чтения доказательств в разделе (`reddit.read`, флаг; итого 25 маршрутов): `GET …/opportunities/:id/excerpts` — все выдержки треда возможности в продукте (`origin='reddit'`, `discussion`, `url = threadUrl`: цепочки `supersedesId` и отвязанные `null`) при любом статусе, с `revision`, `current`, `usage`, `revokedAt/Reason` и текстом; `GET …/communities/:id/rules/:sid/source` — первоисточник снимка, и `superseded`. Отозванные не скрываются. Отзыв — прежний `POST /sources/:id/revoke` (`source.manage`). Тот же тред в другом проекте того же продукта показывает и его выдержки (тот же публичный тред, роли продуктовые) | аудит экранов S2-2: у архивной возможности и у прежних редакций не было пути к отзыву, а `GET /sources/:id` для доказательств — 404 (Р-RD-32) |
| Р-RD-47 | `r/u_<ник>` как сообщество (имя, `r/…`, URL) и тред в `r/u_*` → 400 с кодом поля `profile_ref` (было `format`); прочие неверные вводы — `format`. Зеркало экрана проверяет `^u_` тем же кодом | аудит экранов S3-2: стабильный код для текста ошибки |

**Хвосты M2 (аудит S3-7):** (1) расширить отказ импорта по URL на `reddituploads.com`, `redditmail.com`, `redditinc.com`, `reddit.app.link`, `rdt.li`; (2) ретенция выдержек (`reddit-retention`) должна учитывать копии ответов мутаций с текстом выдержки и правил в `pub_idempotency_keys.responseBody` и иметь в гварде `pub_reddit_sources_guard` явный путь замены фрагмента (сейчас неизменен); (3) каскад Reddit-материалов и отзыв их согласований при новой версии правил и при отзыве первоисточника; (4) переход `qualified → in_brief` проверяет `policyNow`; (5) при росте числа возможностей (тысячи на продукт) фильтр `policyNow` (Р-RD-45) перевести на хранимый пересчёт или индексируемый признак.

### Решения реализации M2 (14.10.2026, пакет P-R)

Миграция `20261021090000_publisher_reddit_m2` (forward-only; M1-миграция не тронута). Маршрутов раздела — 39 (M1 25 + M2 14).

| ID | Решение | Почему |
|---|---|---|
| Р-RD-48 | Миграция M2 пересоздаёт (`CREATE OR REPLACE`) общие гварды, которые знают закрытые списки: `pub_parameter_keys` (40 ключей), `pub_generators`, `pub_contents_guard`, `pub_content_versions_guard`, `pub_qa_checks_guard`, `pub_parameter_decisions_guard`, `pub_eval_guard`, `pub_ai_eval_results_guard`, `pub_reddit_sources_guard`, триггер `pub_contents_same_product` (+`redditBriefId`); новые — `pub_eval_set_size`, `pub_publication_report_guard`, гварды `pub_reddit_briefs`. `states.spec` сверяет списки по ДЕЙСТВУЮЩЕМУ SQL цепочки миграций (последнее определение функции) | правило «новая миграция, старые не трогать»; одна истина закрытых списков в TS и SQL |
| Р-RD-49 | Reddit-материал (`reddit_post`/`reddit_comment`, `redditBriefId`, без `briefId`/родителя/slug) создаётся только `POST …/reddit/briefs/:id/contents` из `ready`-брифа (иначе 409 `PUB_BRIEF_NOT_READY {missing:['brief_ready',…]}`), один активный на бриф (409 `PUB_CONFLICT {duplicate, existingId}`); общий `POST /contents` с Reddit-видом → 400 `kind: reddit_route`. Версии, отправка, QA, согласование, отказ — общие маршруты P-B1 с ветвью Reddit: у комментария служебный заголовок `r/<sub> · <тред>` (не копируется), клиентская `meta` — `disclosure`, `flairSuggestion`, `claimMap`, `uncertainties`; серверная — `ruleSnapshotId`, `affiliation`, `threadUrl` (клиент → 400 `derived`), обновляется при заморозке ДО hash; источники версии — из `claimMap` (только `origin=content`, иначе 400 `restricted_source`), выдержка треда в `pub_version_sources` не попадает; `aiCallId`+`variantIndex` — вызов `pub.reddit.draft` этого брифа (иначе 400 `ai_call`/`range`) | «не article = адаптация» в P-B1 разделено; Reddit-текст — не адаптация статьи |
| Р-RD-50 | `REDDIT_PORT` (владелец P-R): `materialContext`, `check`, `rulesStale`; строки `pub_qa_checks` пишет P-B1 (`content/reddit-policy-check.ts`). Каскад `stale_check` по решённым Reddit-версиям сообщества — при новом снимке правил, при отзыве первоисточника правил и при провале `POST …/check` после согласования (задача на версию, согласование `superseded`) | таблицы по владельцам пакетов; хвост M2 (3) |
| Р-RD-51 | `reddit_policy`: 17 кодов BLOCK и 5 WARN (`reddit/checks.ts`, таблица §M2.4 построчно); устаревшие правила — BLOCK `reddit_rules_stale`; снимок версии ≠ текущему — BLOCK `reddit_rules_changed`. Строка пишется при заморозке (фиксируется), перед согласованием и копированием (в той же транзакции: при отказе откатывается), по `POST …/check` (фиксируется, каскад) | «проверки P-R пройдены на снимке vN» — всегда по текущему снимку |
| Р-RD-52 | Согласование Reddit-версии: сначала свежесть правил (`PUB_APPROVAL_STALE {reason:'rules_changed'\|'rules_stale', ruleSnapshotId, currentSnapshotId}`), затем новая `reddit_policy`, блокеры (`reddit_policy_block`), затем WARN: `acknowledgedWarnings` — ровно множество кодов последней проверки, иначе 409 `PUB_CONFLICT {reason:'warnings_not_acknowledged', codes}`; у прочих материалов непустой список → 400. В meta аудита — `acknowledgedWarnings`, `policyCheckId`, `ruleSnapshotId` | WARN решает человек явно; Р-RD-8 |
| Р-RD-53 | Гейт `reddit_publish` = 6 ключей §4; продукт `test` или `working` (отступление от «нужен working»: стенд и приёмка — на `test`, стадия публикации всё равно `test` по общему правилу) | приёмка без рабочего продукта; живые отчёты — только `working`+`live` |
| Р-RD-54 | Копирование (`reddit.handoff`: PO, OP): статусы `approved\|scheduled\|published\|revised`; гейт `reddit_publish`, свежесть правил, `reddit_policy`, `recheckPublishable` (как публикация); первое — `approved → scheduled` (аудит `cause:'reddit_copy'`), повтор — только аудит `copy`. Ответ — точный текст согласованной версии и `copyToken` = sha256(`versionHash:copiedAt`); в meta аудита то же значение под ключом `copyHash` (ключи `token` в аудите запрещены pii-guard). Общий переход в `scheduled` для Reddit → 409 `hint:'use_dedicated_action:copy'`; общий `POST /publications` для Reddit-версии → 409 `manual_only` | A11: сервер Reddit не открывает; один путь планирования |
| Р-RD-55 | Язык вариантов = язык брифа (правило инструкции приоритетнее общего «українська»); задачи AI-31…42 — английские, проверка языка набора — по задаче (`isEnglish`) | Reddit-сообщества англоязычные |
| Р-RD-56 | Генерация: флаг `PUBLISHER_REDDIT_AI_ENABLED` (выкл. → 409 `PUB_AI_DISABLED {manual:true}` без записи вызова) → тело → бриф `ready` → гейт правил сейчас (`policy_block`/`policy_recheck`) → шлюз. Задача = бриф (`objectType='reddit_brief'`), «перегенерировать абзац» (`rewrite`) — та же задача. Шлюз: хук `inputFindings` (находки, видящие вход); в режиме eval генераторы набора исполняются при `enabledInP0=false` | деньги не тратятся до проверок; живая модель — после eval 2.3 (Р-RD-17) |
| Р-RD-57 | Наборы задач — версии: `2.2` (30 задач P0, четыре генератора) и `2.3` (+12 задач Reddit AI-31…42 и `pub.reddit.draft`); порог — `pub_eval_set_size(версия)`: все N оценены, все `criticalPass`, `usefulnessPass ≥ ⌈0,8·N⌉` (2.2: 30/24, 2.3: 42/34). Текущая конфигурация P0 — `2.2` (см. Р-RD-64) | M2.3.1; смена набора — новая конфигурация и прогон |
| Р-RD-58 | Отчёт о публикации: URL → канон (пост — канон треда; комментарий — `/r/<sub>/comments/<key>/comment/<cid>`), то же сообщество; у comment — ссылка на комментарий в треде возможности; у post — без id комментария; `postedAt` не в будущем (допуск 5 мин); `notes` → `reason` аудита (без контактов); до первого копирования → 409 `not_copied`. Строка `pub_publications`: `reportKind='user_reported'`, `verifyStatus='not_checked'` навсегда (триггер; `verify` → 409 `manual_only`), стадия — общее правило (`live` только `working`+`mode=live`+`public_publish`), материал → `published` только при `live` | A12, A15; отчёты P0 не смешиваются |
| Р-RD-59 | Ретенция `reddit-retention` (ежедневно, владелец P-R): тред — когда все его возможности `archived\|skipped` дольше `reddit_excerpt_retention_days` (Kyiv, по умолчанию 180) и брифы архивированы; фрагмент выдержки → `[видалено за терміном зберігання]` с новым `contentHash` через порт P-B1 (единственный путь в гварде), `context` архивных брифов — тоже; копии текста в `pub_idempotency_keys.responseBody` заменяются (`redactStoredResponses`); аудит `erase`. `pub_ai_calls` (вход/выход генерации) не трогаются — хвост | хвост M2 (2) |
| Р-RD-60 | Отказ импорта по URL — и для `reddituploads.com`, `redditmail.com`, `redditinc.com`, `reddit.app.link`, `rdt.li` (с поддоменами) | хвост M2 (1) |
| Р-RD-61 | Бриф по возможности: `qualified → in_brief` с аудитом, только если гейт правил СЕЙЧАС `ok` (иначе 409 `policy_block`/`policy_recheck`); `in_brief` допускает новые брифы; контекст comment по умолчанию — выдержка | хвост M2 (4) |
| Р-RD-62 | Сверх таблицы §M2.7: `GET …/contents/:cid` (сводка материала: версии, проверка, копии, публикации, «Открыть Reddit») и `POST …/briefs/:id/archive` | экраны без N запросов; архив вместо удаления |
| Р-RD-63 | Тесты сети разделены: M1 — `reddit-m1-egress.spec.ts` (25), M2 — `reddit-m2-egress.spec.ts` (14, `REDDIT_M1/M2_ROUTE_NAMES`); помощник подмены сети — в `acceptance/publisher` (в `reddit/**` сетевые модули запрещены графом) | AT-RD-11, AT-RD-16 |

**Хвосты M2 после реализации:** (1)–(4) выше закрыты (Р-RD-60, Р-RD-59, Р-RD-50, Р-RD-61); остаются: (5) фильтр `policyNow` при росте; (6) ~~ретенция и журнал AI~~ — закрыто Р-RD-70; прежние редакции `context` брифа в ответах `PATCH` (их тексты не хранятся отдельно) — не заменяются; (7) живая модель `pub.reddit.draft` — после живого прогона 2.3 и решения владельца (`enabledInP0` в коде — `false`); (8) E2E-RD-02 в `scripts/publisher-e2e.sh --reddit` и экраны — вместе с assist (сценарий закрыт приёмкой `reddit-m2-generate.spec.ts`); (9) словари `markers@3` (роли и отрицания раскрытия, слова результата, зоны и «не ссылки», личный опыт) — стартовые, утверждает владелец (§12 п.4); WARN раунда 2 подтверждает проверяющий.

### Раунд исправлений M2 по внутреннему аудиту (14.10.2026; S1×1, S2×5, S3×11, замечания экранов)

Миграция M2 ещё не выкачена — правки внесены в неё же (колонка `pub_reddit_briefs.brand`, гварды набора задач по версии).

| ID | Решение | Почему |
|---|---|---|
| Р-RD-64 | P0 не трогаем: `EVAL_SET_VERSION='2.2'`, конфигурация P0 — четыре генератора, её `configHash` = hash до M2 (тест). Набор `2.3` с `pub.reddit.draft` — отдельная конфигурация (`currentConfigSpec(…, '2.3')`, CLI `--set=2.3`) и привязка только решением владельца. Гварды: результат прогона — задача из набора ВЕРСИИ конфигурации (2.2 — AI-01…30), `passed` считает только задачи набора | аудит S2-5, S3-8: выкатка M2 закрывала `ai_use` P0 и удорожала прогон |
| Р-RD-65 | Раскрытие (A08) — осмысленный текст: ≥ 20 знаков, маркер аффилированности (en/uk/ru: founder, I work at, I built, disclosure, affiliated, засновник, працюю в, розкриття, основатель, работаю в…), имя продукта/бренда брифа (`brand`, по умолчанию — имя продукта; при `affiliation≠none` обязательно для `ready`), начинается в первых 300 знаках ВИДИМОГО текста (спойлеры `>!…!<`, HTML-комментарии, `^(…)`, невидимые символы не считаются). То же правило — находка AI `disclosure_missing` | аудит S1-1, проба T1 |
| Р-RD-66 | Проверка `reddit_policy` берёт `affiliation` замороженной версии (`meta`, hash); заморозка, согласование и копирование — только при `ready`-брифе с пустым `missing` (иначе 409 `PUB_BRIEF_NOT_READY {missing:['brief_ready',…]}`: бриф правили → `draft`, архив — стоп) | аудит S2-1, S3-5, S3-6 |
| Р-RD-67 | Факты тела: числа (после NFKC; проценты, деньги, количества; маркеры списков и `r/…` — не числа) и гарантии (guarantee/promise/risk-free/гарант/обіця/обеща — без отрицания рядом) — только с пунктом claimMap с разрешённым источником; числа из контекста брифа (цель, аудитория, контекст, тезисы) и текста оффера допустимы; иначе BLOCK `reddit_unverified_claim` (с числом в тексте) | аудит S2-3 |
| Р-RD-68 | Нормализация до сопоставления (`markers@2`): NFKC, невидимые символы, все апострофы, двойники букв в словах смешанного письма → латиница (слова целиком кириллицей не трогаются); словарь личного опыта расширен (I'm/I am/we use/been using/saved me, використовую/юзаю/користуємось, использую/пользуемся, наш досвід/опыт); запрещённые брифом утверждения — по нормальной форме; ссылки — любой «домен.зона» (2–24 буквы), punycode, кириллические зоны, `[.]`/`(.)`/` dot com`, markdown; не ссылки — расширения файлов (`Node.js`) и упоминание `reddit.com`/`www.reddit.com` без пути; контакты и ники — во всех строках `meta` (claimMap, uncertainties) | аудит S2-2, S3-1, S3-2, S3-7 |
| Р-RD-69 | Копирование: WARN текущей проверки ⊆ подтверждённых при согласовании ∪ `acknowledgedWarnings` тела копирования, иначе 409 `warnings_not_acknowledged {codes}` (новые коды); подтверждение — в meta аудита `copy`. Блокер `reddit_policy_block` — `{code, codes}` без id строки проверки (она откатывается вместе с отказом) | аудит S3-3, S3-4 |
| Р-RD-70 | Ретенция маскирует и журнал AI: строки выхода (`output`, `rawExcerpt`) вызовов генерации брифов треда, содержащие выдержку целиком или любые 6 слов подряд, → плейсхолдер (статус и стоимость не меняются); то же — в сохранённых ответах `…/generate` (`pub_idempotency_keys`) | аудит S3-9, хвост 6 (разрешение координатора в пределах P-R) |
| Р-RD-71 | Ретенция отбирает в SQL только треды с вышедшим сроком (все возможности `archived\|skipped` старше параметра продукта по календарю Kyiv) и без неархивного брифа; курсор `(accountId, productId, threadUrl)` пачками до исчерпания или срока задания | аудит S2-4 (проба R2) |
| Р-RD-72 | Для экранов: `normalizeReportedUrl` понимает `…/comments/<id>/<slug>/comment/<cid>`; типы `CreateRedditVersionBody`/`PatchRedditVersionBody`/`RedditVersionClientMeta` (без `title` у comment, без `offerVersionId`/`sourceIds`, с `aiCallId`/`variantIndex`); `RedditMaterialView.lastGeneration {callId, status, requestedAt}` | замечания экранов M2 |
| Р-RD-73 | Стендовый fake-провайдер AI `PUBLISHER_STAND_FAKE_AI=true` (только `NODE_ENV=development\|test` и не Vercel — правило Р-PUB-Z2-21, иначе игнор с предупреждением): модель без сети отвечает на промпт `pub.reddit.draft` (варианты по брифу, раскрытие с брендом, claim_map тезисов), прочим генераторам — `unavailable`; при нём `pub.reddit.draft` включён на стенде. E2E-RD-02 стенда больше не вставляет вызов SQL-ом | замечание экранов «E2E без записи в базу» |
| Р-RD-74 | Принцип проверки `reddit_policy` (раунд 2, решение владельца по умолчанию): детерминированная проверка БЛОКИРУЕТ только при высокой уверенности; неоднозначное — WARN, его подтверждает проверяющий при согласовании (и при копировании — новые WARN). Честный текст не должен застревать в неснимаемом BLOCK; регресс-корпус «честные ответы → без BLOCK» (≥ 20 текстов en/uk/ru с кодом, версиями, датами) — в тестах. Словари — `markers@3` | повторный аудит M2 (S2-D), координатор |
| Р-RD-75 | Раскрытие (A08): после длины и бренда — РОЛЬ автора без отрицания: founder/employee/agency — основатель, команда («on the X team», «з команди», «из команды»), «behind», «side project», «I built/made/run/wrote», «I'm building», «мы делаем», розробник/разработчик рядом с брендом; customer — клиент/пользователь или «not affiliated». Отрицание роли или чужая роль у founder/employee/agency («Not affiliated with X», «just a (happy) customer», «I'm a user», «не працюю», «не основатель», «не повʼязаний») → BLOCK `reddit_disclosure_negated`; бренд есть, а роль не названа (или роль вместе с отрицанием, вопрос «Are you the founder?») → WARN `reddit_disclosure_unclear`. Бренд — целым словом (не «demonstration»), ≥ 3 знаков и не стоп-слово (`missing:'brand'`, гвард `ready` в базе — ≥ 3) | повторный аудит S2-A, S2-D п.4 |
| Р-RD-76 | Детекторы нарушений (ссылки, личный опыт, числа, гарантии) — по ПОЛНОМУ тексту вместе со спойлерами `>!…!<`, надстрочным `^(…)`, зачёркнутым и HTML-комментариями (читатель и модератор их видят). Раскрытие засчитывается только в обычном тексте: спойлеры, комментарии, невидимые символы и HTML-сущности (`&#x200B;`) не занимают места; надстрочный, зачёркнутый, код и цитата `>` занимают место в окне 300 знаков, но раскрытием не являются; у поста заголовок — начало видимого текста | повторный аудит S2-B, S3-5 |
| Р-RD-77 | Нормализация `markers@3`: HTML-сущности, NFKC, невидимые символы, апострофы, нижний регистр и ДВЕ свёртки двойников — «латинская» (смешанное слово → латиница) и «кириллическая» (смешанное слово → кириллица; греческие и армянские двойники учтены); короткое слово только из двойников рядом со словом другого письма (`І'м using`, `я працюю y Demo`) сворачивается в письмо соседа. Все словари (опыт, роль, отрицание, гарантии, оскорбления, запреты брифа, бренд) сверяются с обеими свёртками; бренд — ещё и по «скелету» транслитерации (Demo ↔ Демо) | повторный аудит S2-C |
| Р-RD-78 | Числа тела — только «числа результата»: проценты, деньги, множители (`3x`, «в 3 рази», «N times faster», `triple`/`double`/«вдвічі»/«потроїть» рядом со словом результата или «your/ваш») и число в ± 4 словах от слова результата (ROI, revenue, sales, save, cut, growth, зростання, економія, рост, экономия…). Не утверждения: версии (`Node 20`, `v2.0`, `1.2.3`, `pkg@1.2.3`), годы с предлогом, время, даты, `B2B`/`GPT-4`/`Q3`/`9am`, `24/7`, коды, маркеры списков, `100%` в «I 100% agree». Без пункта claimMap с разрешённым источником О ТОМ ЖЕ утверждении (то же число и единица и общая основа слова) — BLOCK `reddit_unverified_claim`; число только из контекста брифа/оффера — WARN `reddit_claim_from_brief` (контекст пишет ED, это не источник). Пункт `needs_verification` — BLOCK только с числом результата или гарантией, иначе WARN | повторный аудит S2-D п.1, S3-3 |
| Р-RD-79 | Ссылки: BLOCK — схема, `www.`, markdown-ссылка, домен с путём, обходы (`[.]`, `(dot)`, ` dot `, ` d0t `, ` . `, `\.`, `。｡．․·`, `demo,com`, `h t t p s : / /`); голый `слово.зона` известной зоны — WARN `reddit_link_suspect` там, где ссылки запрещены брифом или правилами; не ссылки — код и имена с точкой (`Object.keys`, `ASP.NET`, `main.go`, `main.rs`, `works.Then`, `St.Louis`, `foo.io(`), «dot com era», `reddit.com` без пути. Находка AI `link_present` — по обоим спискам (подсказка строже проверки) | повторный аудит S2-D п.2, S3-2 |
| Р-RD-80 | Гарантии — узкий словарь: guarantee (кроме «guarantees memory/type/thread safety…»), «I/we promise», «promise you/that», assured, money-back, risk-free, «точно спрацює/сработает», гарантую/гарантирую, обіцяю/обещаю (не «As promised», не «як і обіцяв», не `Promise.all`); отрицание — только непосредственно перед словом (≤ 2 слов в той же части фразы: «no guarantee», «не гарантуємо»; «No joke, … guaranteed» — гарантия). Гарантия — WARN `reddit_guarantee`; вместе с числом результата в том же предложении (даже подтверждённым) — BLOCK `reddit_unverified_claim`; гарантия, подтверждённая пунктом claimMap с обещанием, — без замечаний | повторный аудит S2-D п.3, S3-4 |
| Р-RD-81 | Контакт в Reddit-тексте (`redditContact`, правило P-R; общий `pii-guard` не меняется): e-mail с доменной зоной (не `git@host:repo`, не `user@example`), `@handle` (не `@scope/pkg`, не `pkg@1.2.3`, не аннотации кода `@Override`/`@Injectable(`), мессенджер и телефон по `PII_RULE` (после вырезания дат, сумм и версий). То же — для строк `meta` Reddit-версии (400 `pii`) | повторный аудит S2-D п.5 |
| Р-RD-82 | Вымышленный отзыв (A07): личный опыт от первого лица О ПРОДУКТЕ брифа (бренд в том же предложении; «…using it»/«It worked great for me» сразу после предложения с брендом) при `affiliation≠customer` — BLOCK `reddit_fake_testimonial`; личный опыт без связи с продуктом («I've been using Postgres for years») — WARN `reddit_personal_experience`. Словарь опыта расширен: I've had, started using, switched over to, moved to, signed up, installed, rolled out, lifesaver/game-changer for me, can't recommend … enough, my team runs … on, купувала, внедрили, у меня … уже, мені сподобався | повторный аудит S3-1 |
| Р-RD-83 | «Перегенерировать абзац» — ОТДЕЛЬНАЯ AI-задача черновика (`pub_ai_tasks.objectType='content_version'`, id версии) со своим лимитом генераций и общим бюджетом; выбор варианта генерации брифа закрывает задачу брифа (повторная генерация брифа — 409 `ai_task done`, как прежде), а переписывание абзаца выбранного черновика остаётся доступным. Вариант переписывания принимается только в материал того же брифа (`aiCallId` + `variantIndex`, иначе 400 `ai_call`); `lastGeneration` материала учитывает и переписывания; ретенция маскирует их выход так же, как выход генерации брифа | дефект экранов (409 после выбора варианта) |
| Р-RD-84 | Ретенция выдержек обрабатывает и архивные продукты (`working|test`, любой статус): приватность важнее «заморозки» архива; условия треда прежние (возможности `archived|skipped` старше срока, брифы архивированы) | повторный аудит S3-6, решение по умолчанию |
| Р-RD-85 | Раунд 3 (точечная перепроверка S3-R2-1…4): явное «not affiliated / no affiliation / zero affiliation / unaffiliated / не повʼязаний / не связан / не аффилирован» у founder/employee/agency — всегда BLOCK `reddit_disclosure_negated`, какие бы слова роли ни стояли рядом (у customer — честное раскрытие); числа результата словами — числительные en/uk/ru перед percent/відсотків/процентов, «N times/разів + сравнение», «у N разів», «tenfold», «сотні/сотни/hundreds of …» и правильные дроби `1/3` рядом со словом результата; личный опыт uk/ru латиницей («ya ispolzuyu», «ya vykorystovuyu», «my polzuemsya», «mne pomog»); бренд — по «скелету» с цифрами-двойниками (`0→o`, `1→l`, `3→e`) и без дефиса/точки внутри слова (`Dem0`, `D-emo`); текст BLOCK `no_brand` подсказывает бренд из брифа («напишіть бренд так, як у брифі: «…»»), сложной транслитерации нет | повторная перепроверка аудитора, координатор |
| Р-RD-86 | Раунд 4 (серверные части аудита экранов M2): (S2-1) 409 `warnings_not_acknowledged` при согласовании — свежая проверка `reddit_policy` СОХРАНЯЕТСЯ отдельной транзакцией (аудит `qa_check create`, `outcome: warnings_not_acknowledged`), в `details` — `codes`, `warnings: [{code, params}]` и `policyCheckId`; повтор с этими кодами — 201. (S3-4) находки `reddit_policy` машиночитаемые: `{code, text: code, params}` (`found`, `reason`, `brand`, `claims`), тексты делает клиент; 409 копирования — тоже `warnings: [{code, params}]`. (S3-5) `postedAt` отчёта о публикации — не раньше создания материала (допуск 1 минута) → иначе 400 `before_material`; будущее — 400 `future`, как прежде. (S3-6) `RedditBriefView.injectionFlag` — пометка выдержки возможности (отозванная — null); в промпте — `flag="possible_instruction"` у `<thread>`, как прежде. (S3-10) вид материала `ContentView.redditStudio: true` у Reddit-материала — общий экран прячет общие действия публикации и согласования | аудит экранов M2 (`pub-r-m2-ui-audit.md`), координатор |
| Р-RD-87 | Импорт чернового исследования Reddit (CSV) — CLI `npm run reddit:import` через HTTP API кабинета: dry-run по умолчанию, `--apply` — запись с детерминированными `opKey`, повтор — «уже есть»; правила из вторичных источников — снимки `unreviewed` с пометкой «secondary», только валидные треды, факторы и обоснования из CSV, все ключевые запросы; авторизация — только переменная окружения с заголовками сессии владельца, значения не печатаются; к Reddit — ноль запросов (§8.1) | координатор: перенос реестра после включения флага |
| Р-RD-53, пост-бриф | Приняты владельцем: гейт `reddit_publish` и для `kind=test`; пост-бриф в сообщество с закрытым гейтом создаётся (блок — на генерации, проверке, копировании) | решение координатора |


## 12. Вопросы владельцу

1. Включать ли Reddit MVP в ближайший цикл (Р-RD-0)? Если да — до или после внешнего аудита P0? Рекомендация: после внутреннего аудита P-R и вместе с внешним, одним охватом.
2. Ключ модели и потолок для eval `2.3` (42 задачи). По оценкам предаудита D2 для 30 задач (реалистично ≈ $0,25–0,30, верхняя оценка кода $3,01) пропорционально: реалистично ≈ $0,35–0,45 за прогон, верхняя ≈ $4,2. Предлагаемый жёсткий потолок `--max-usd` — $5 за запуск.
5. До выпуска сайта (`mode=live`) реальные Reddit-публикации пишутся как `test` и не входят в отчёты (Р-RD-9). Оставить так (рекомендация: Reddit — после D0) или вводить отдельное правило стадии для внешних каналов? Второе меняет триггер P0 и требует повторной проверки.
3. Язык и рынок первого проекта (`locale`, `market`) и список 10 сообществ для приёмки — нужны для seed и E2E. Без них используются синтетические.
4. Словарь «оскорблений» и маркеров «личного опыта» — утверждает владелец или ED; без него используется стартовый список из кода с пометкой `assumption`.

## 13. Админка платформы: вкладка «Reddit» (P-R-ADM, 14.10.2026)

Решение владельца: вся работа с разделом Reddit — ещё и из Админки (`admin/`, вкладка «Reddit»):
импорт исследования, правила, отбор тредов, бриф, студия, проверки, согласование, копирование,
отметка «опубликовано». Режим прежний — только MANUAL_COPY, без запросов к Reddit. Кабинет assist —
второй вход к тем же данным (`pub_reddit_*`, `pub_contents`), ничего не дублируется.

Цепочка: Админка → backend `admin-panel/admin-reddit.controller.ts` (`AdminSessionGuard` +
`assertOperator`, allowlist путей) → sites-backend `/internal/admin/reddit/**` (секрет
`SITES_INTERNAL_SECRET`, заголовки `X-Sites-Internal-Secret`, `X-Admin-Actor`). Контракт внутреннего
API — `publisher/reddit/admin/admin-reddit-routes.ts` и комментарий контроллера; маршруты:
`GET status`, `POST setup`, `GET|POST|PATCH rx/<путь REDDIT_ROUTES>` (все 39),
`GET|POST|PATCH cx/<путь кабинета>` (24 маршрута, v1.2), `GET params`,
`GET params/:key/proposals`, `POST params/:key/{propose,decide}`, `POST import/{plan,apply}`.

| Решение | Содержание |
|---|---|
| Р-RD-ADM-1 | **Платформенный продукт** — Publisher-продукт сайта, id которого первый в `ASSIST_INTERNAL_SITE_IDS` (sites-backend; = `ASSIST_LANDING_SITE_ID` backend). id продукта в пути нет — подставляет сервер, другие продукты Админка не видит и не адресует (объект чужого кабинета — тот же 404, что несуществующий). `setup` идемпотентно заводит продукт (`kind=working`, `mode=closed`, имя «Платформа (Reddit)», параметры-допущения и шаги пакетов — как при создании из кабинета); продукт сайта уже есть (любого вида) — 200 и он; гонка двух операторов — один продукт. Список не задан — `setup` 409 `platform_site_not_configured`, сайта нет — 409 `platform_site_missing`, продукта нет — разделы 404 `PUB_PRODUCT_NONE` |
| Р-RD-ADM-2 | **Актор `admin:<userId>`** (id пользователя backend ≤ 58 знаков: актор ≤ 64, как столбцы `…MemberId`). Миграция `20261023090000_publisher_admin_actor` (forward-only): `pub_is_actor` (+admin, все `createdBy`/`*By` через `pub_actor_format`), новые `pub_is_admin`, `pub_is_person`; admin допускается ТОЛЬКО в закрытом списке «решает/проверяет человек»: `pub_parameters.approvedBy`, `pub_parameter_decisions.decidedBy`, `pub_reddit_rule_snapshots.reviewedBy`, `pub_qa_checks.checkedBy` (editorial/technical — только версия Reddit-материала), `pub_ai_calls.requestedBy` (только `pub.reddit.draft`); проверка утверждений, заявки, eval, `adaptation_meaning` — по-прежнему `member:` (оффер и факты бренда — с v1.2, Р-RD-ADM-11). На внутреннем пути — синтетическое членство «оператор платформы» (`core/admin-actor.ts`): `memberId = admin:<userId>`, роль кабинета `operator` без ролей продуктов, роли продукта PO+ED+OP+AN и закрытый список действий `PubAccess.only` (v1: 12 — `reddit.*`, `product.read`, `version.manage`, `qa.editorial`, `qa.technical`, `version.approve`, `ai.generate`, `parameter.propose/decide`; v1.2 — 17, Р-RD-ADM-12) — `can()` отказывает во всём прочем при любых ролях (гвард, `runOperation`, `recordRead`): раскрытие контактов, заявки, роли, бэкап/восстановление, бюджеты, площадки, продукт, журнал недоступны. `memberActor('admin:…')` = `admin:…`; selfReview (оператор проверяет/согласует своё) — пометка, не запрет; имя согласующего — «Адмін платформи …». Кабинетный путь не меняется (у участников `only` нет). Очередь AI (`recheckCall`) принимает admin только для `pub.reddit.draft` платформенного продукта |
| Р-RD-ADM-3 | **Проксирование в процессе**: `rx/*` вызывает ТЕ ЖЕ обработчики `PublisherRedditController` (экземпляры из контейнера Nest, аргументы — явные лямбды, действие — из `@PubAllow` обработчика), `cx/*` — обработчики `ContentMaterialsController` только для `kind ∈ {reddit_post, reddit_comment}` платформенного продукта (статья P0 — 404, как несуществующая) с сужениями: QA — `editorial`/`technical` (иное — 400 `kind:enum`), переход — только `request_changes` (иное — 409 `PUB_TRANSITION_INVALID {reason:'admin_scope'}`). HTTP-петли нет; тела, ответы, статусы, CSV, коды ошибок — как у кабинета (конверт Publisher, `Accept-Language`). Путь вне таблиц — 404 |
| Р-RD-ADM-4 | **Импорт CSV** (`communities`/`opportunities`/`keywords`, формат `research-import.ts`): тело `{communitiesCsv, opportunitiesCsv, keywordsCsv, projectTitle, locale, market, segment?}` ≤ 1 МБ (свой JSON-парсер пути в `app.setup.ts`, больше — 413 `PUB_PAYLOAD_TOO_LARGE`); `plan` — dry-run, `apply` — запись; `ImportHttp` поверх того же in-process вызова `rx/*` (детерминированные `opKey`, повтор — «уже есть», проверенный снимок — `kept_reviewed`). Отчёт — как у CLI, но строки CSV, похожие на контакт или ник, в отчёте скрыты («(приховано: схоже на контакт)») |
| Р-RD-ADM-5 | **Параметры гейта**: только ключи `reddit_publish` (`niche`, `language`, `market`, `offer_active_version`, `responsibles`, `reddit_rules_stale_days`) и `reddit_excerpt_retention_days` (v1.4 — ещё ключи AI и бюджета месяца AI, Р-RD-ADM-14); прочие — 404. `GET params` — виды параметров, гейт и подсказки `hints.offerActiveVersion` (активная версия оффера; оффер ведёт кабинет) и `hints.accountOwnerMemberId` (для `responsibles`); `GET params/:key/proposals` — открытые предложения (id для решения); предложить и утвердить — обработчики кабинета (`propose`/`decide`), решает актор admin |
| Р-RD-ADM-6 | **Секрет**: `InternalSecretGuard` вынесен в `src/common/internal-secret.guard.ts` (Publisher не импортирует `platform-admin`, правило `publisher-scope`, фикстуры графа), вкладка «Помощник» — без изменения поведения (нет актора — 401, `:` в акторе допустим). Вкладка «Reddit»: секрет (нет/неверный — 401 одинаково, env не задан — 503) → актор `X-Admin-Actor` `^[A-Za-z0-9_-]{1,58}$` (нет/формат — 400 `ADMIN_ACTOR_REQUIRED`) → флаг → продукт → маршрут/действие |
| Р-RD-ADM-7 | **Журнал**: мутации — `pub_audit_events` с `actor=admin:<userId>` в транзакции (как у кабинета). Доступ (v1.2) — таблица `pub_reddit_admin_access_log` (вне тенанта, как `pub_rate_hits`; append-only: правка и TRUNCATE запрещены, удаление — только строк старше 365 дней): актор, метод, ШАБЛОН маршрута без id, статус, время; тел и query нет. Пишется после ответа на каждый запрос с актором, ретенция — задание `admin-access-log-retention` (daily, P-R). Почему таблица, а не журнал процесса: журналы функций Vercel хранятся коротко, а журнал доступа должен переживать разбор инцидента; таблица «Помощника» (`assist_platform_access_log`) Publisher недоступна по графу (`publisher-names`). Плюс строка журнала процесса `AdminReddit` |
| Р-RD-ADM-8 | **Флаг** `PUBLISHER_REDDIT_ENABLED` — главный выключатель: выключен — `status` отвечает `enabled:false` (Админка показывает «раздел выключен: переменная PUBLISHER_REDDIT_ENABLED на assist-api»), все остальные маршруты, включая `setup` и импорт, — 404 `PUB_NOT_FOUND` без `details`, без записей. `aiEnabled` в `status` — `PUBLISHER_REDDIT_AI_ENABLED` |

**Тесты (sites-backend):** юнит `reddit/admin/admin-reddit.spec.ts` (таблицы = обработчики, контроллер,
разбор пути, членство и список действий, гварды, env, отчёт), db `reddit/admin/admin-actor.db.spec.ts`
(функции формата = регулярки TS, закрытый список мест admin); приёмка
`acceptance/publisher/reddit-admin-{access,isolation,flow,import,egress}.spec.ts` (секрет/актор/флаг/
setup, изоляция и запреты, полный путь бриф → вариант → черновик → проверка → согласование →
копирование → отчёт на fake-AI, импорт, ноль запросов к Reddit по всем 49 маршрутам);
`z-isolation` и `z-pii-scan` — новые маршруты.
| Р-RD-ADM-9 | **Полная работа из Админки (v1.2, решение владельца)**: `cx/*` расширен до 24 маршрутов кабинета, всё — только в платформенном продукте и только для Reddit/платформенных объектов (проверка объекта пути `scope`): отзыв согласования Reddit-материала (`approvals/:id/revoke`, причина обязательна), «снять с плана» (`unschedule`) в переходах материала наряду с `request_changes` (причина обязательна), снятие отметки о публикации Reddit-материала (`publications/:id/transition`, только `to:'withdrawn'` с причиной), опрос вызова `pub.reddit.draft` (`ai/calls/:callId`, только этот генератор) |
| Р-RD-ADM-10 | **Отзыв доказательств Reddit** — `sources/:id/revoke` только для `origin='reddit'` (первоисточник снимка правил, выдержка треда) платформенного продукта; источник контента и чужой — 404 (как несуществующий); каскад P-R (гейт `rules_source_revoked`, возможности на пересмотр) — тот же, что в кабинете |
| Р-RD-ADM-11 | **Источники, оффер и бренд платформенного продукта** — чтобы гейт `reddit_publish` (`offer_active_version`) и тезисы брифов закрывались из Админки: список источников контента (без доказательств Reddit), ручной источник только `manual_text|url` (ссылка хранится, загрузки по сети нет — `sources/import-url` не открыт), оффер (`offers`, `offers/:id/activate`) и факты бренда (`brand-facts`, `…/activate|resolve|retire`) — пути кабинета. Актор `admin:` допущен в `pub_offer_versions.approvedBy` и `pub_brand_facts.approvedBy`; база не знает, какой продукт платформенный, — `admin:` возникает только на внутреннем пути, где продукт всегда платформенный (это держит код и тесты изоляции). Проверка утверждений (`claim.verify`), вопросы и брифы статей — по-прежнему только кабинет |
| Р-RD-ADM-12 | **Список действий оператора** расширен ровно на нужное маршрутам v1.2: `source.manage`, `brand.draft`, `brand.activate`, `approval.revoke`, `publication.manage` (итого 17); раскрытие контактов, заявки, роли, бэкап/восстановление, бюджеты, площадки, продукт, журнал, проверка утверждений, вопросы, AI-помощник, eval — по-прежнему `can()=false` |
| Р-RD-ADM-13 | **Секрет до тела**: middleware `/internal/admin/reddit` в `app.setup.ts` проверяет `X-Sites-Internal-Secret` ДО любого парсера (импорт ≤ 1 МБ, общий парсер Nest): тело без секрета не читается (401, не 413), ответ — тот же конверт и текст, что у гварда; гвард маршрута проверяет секрет ещё раз |
| Р-RD-ADM-14 | **AI и бюджет платформенного продукта — из Админки** (v1.4, аудит S2-1, решение владельца «полная работа из Админки»). Ключи параметров Админки +6 (всего 13): гейт `ai_use` (`ai_budget_usd_month`, `ai_fx_rate`), `ai_unpriced_allowed` и бюджет, без которого `ai-month-open` не открывает месяц (`budget_total`, `budget_split` — гейт `spend`; `per_purchase_max` — сборка `pub_budget_limits`); предлагает и утверждает `admin:<userId>`. Расходы, переводы резерва, закупки, площадки — по-прежнему не Админка. `GET params` → `hints.budget` «только AI»: закупок у платформенного продукта нет — размещения, резерв и потолок закупки 0, инструменты = обязательство месяца AI (`ceil(центы) × курс`) × 12; схема `per_purchase_max` допускает 0 («закупок нет»; функция лимитов P-C принимала 0 и раньше); при 0 гейт `purchases` честно закрыт пунктом `budget/per_purchase_max/purchases_disabled`, ошибки закупки (`PUB_GATE_CLOSED`, `PUB_BUDGET_INSUFFICIENT`) несут `reason:'purchases_disabled'` и текст «Закупки отключены: максимум одной закупки — 0» (аудит, раунд 2); гейт `spend` не задет. `status` → `aiGate {open, missing, generatorEnabled, reason: flag_off|generator_disabled|gate_closed|null}` (генератор `pub.reddit.draft` выключен до eval 2.3 — честно `generator_disabled`; модель/инструкция проверяются при генерации) и `aiMonth {month, open, reason: ai_params_missing|spend_gate_closed|month_not_open|cap_exhausted|null, missing}` |
| Р-RD-ADM-15 | **Причина `PUB_AI_BUDGET`**: код и 409 прежние, `details.reason` = `month_not_open` (месяц AI не открыт) или `cap_exhausted` (потолок исчерпан; «budget_exhausted» аудита) — из `errorCode` вызова (`PUB_AI_BUDGET:<reason>`), та же пара, что у `POST …/ai/tasks/:id/extra`; поле добавлено и генерации кабинета (Reddit и общий AI) |
| Р-RD-ADM-16 | **Импорт: условия правил** (аудит S3-7) — колонка `conditions` делится по `; ` и переводу строки, но не внутри `()`/`[]` и кавычек `"…"`, `«…»`, `“…”`; перевод строки делит всегда (незакрытая скобка не склеивает столбец). Общий разбор CLI и Админки (`splitConditions`) |
| Р-RD-ADM-17 | **Платформенный сайт на проде — sandbox** (15.10.2026, решение владельца). Отдельного сайта платформы в помощнике нет (лендинг `assist.viral4creators.app` без виджета; единственный кабинет — собственный QA-кабинет владельца). `ASSIST_INTERNAL_SITE_IDS` на `assist-api` (Production, Config) = id сайта `sandbox.viral4creators.app` (тот же, что `QA_CI_SITE_ID`); вместе с ним — `PUBLISHER_REDDIT_ENABLED=true`. Следствие: Reddit-продукт Админки живёт на sandbox, сайт — на внутреннем тарифе (бессрочный pro без стопа единиц, деньги держат суточные $-потолки). Когда появится сайт лендинга (Э-С Ш5), его id дописывается **вторым** (`<sandbox>,<лендинг>`): первый id выбирает продукт вкладки, порядок не менять — иначе Админка «потеряет» исследование. QA-стенды и `sandbox-daily` данных `pub_*` не трогают |

**Тесты v1.2:** приёмка `reddit-admin-v12.spec.ts` (8: источники, отзыв доказательства, оффер и факты,
согласование и `unschedule`, снятие отметки, опрос AI, журнал доступа и ретенция, секрет до тела),
`reddit-admin-egress.spec.ts` — все 63 маршрута `rx`/`cx`; `z-isolation` — 39 + 24 маршрута;
`z-pii-scan` — источник и причина отзыва с контактом; db — оффер и факты бренда от admin.

**Тесты v1.4:** приёмка `reddit-admin-ai.spec.ts` — без засева параметров и месяца в базу: `setup` →
`status.aiGate` (`flag_off` → `generator_disabled` → `gate_closed`) → оффер, источник, ключи
`reddit_publish`, `ai_use` и бюджета — решения оператора (значения бюджета — из `hints.budget`) →
генерация 409 `PUB_AI_BUDGET {month_not_open}` → проход `ai-month-open` → 200 → снижение потолка →
`aiMonth.reason=cap_exhausted` и 409 `{cap_exhausted}`; юнит — ключи, `aiGate`/`aiMonth`, подсказка
бюджета (проходит утверждение и согласованность), `splitConditions`.

**Хвосты:** проверка утверждений (`claim.verify`) и вопросы/брифы статей P0 — только кабинет;
backend-прокси и экраны Админки — обновить allowlist до 24 `cx/*` (контракт v1.2).
Привязка AI и eval — не Админка: без них `aiGate.missing` содержит `ai_config` (на стенде без eval —
`PUBLISHER_AI_ALLOW_UNEVALUATED`, как у шлюза).
