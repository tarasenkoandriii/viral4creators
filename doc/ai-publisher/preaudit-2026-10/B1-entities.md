> Внутренний предаудит. Не является независимым внешним аудитом по плану v1.1 §1; не заменяет внешнее заключение. Цель — подготовить пакет передачи (Приложение B) и снять очевидные дефекты до внешнего прохода.

# B1. Достаточность полей сущностей ТЗ §9

Дата: 13.10.2026. Исполнитель: Claude-агент (та же команда, что писала код). Глубина: чтение Prisma-схемы, миграции `20261016090000_publisher_core`, фикстур и названий тестов. Динамических проб в этом пакете нет. Проверяемая версия на этапе B1: манифест 1 696 файлов, sha256 `6374e3d0…95c2`; итоговая версия пакета — `manifest-sha256.txt` (см. `README.md`).

Источники:

- Схема: `sites-backend/prisma/schema.prisma`, 66 моделей `Pub*`. Реестр полей выгружен скриптом скриптом-сборщиком (рабочий каталог предаудита).
- Миграция `publisher_core`: 289 упоминаний `CREATE TRIGGER`, 122 функции, 6 частичных уникальных индексов.
- Фикстуры:
  - `sites-backend/src/prisma/publisher-schema.testing.ts` (`PubDb`);
  - `sites-backend/src/modules/publisher/testing/fixtures.testing.ts`;
  - `sites-backend/src/modules/publisher/reports/testing/td10.testing.ts` (TD-10).

Доказательство исполнения: финальный прогон jest Z-2c `sb-pub7.json` (md5 `734731ad6cc622b641500f854b8427aa`, 107 наборов / 858 тестов, 0 падений) — в нём проходят `publisher-triggers.db.spec`, `table-ownership.spec` и наборы AT, которые пишут эти записи. Исходная проверка этапа B1 опиралась на прогон Z-2b (`sb-pub4.json`, 104/832).

> **После Z-2c.** Схема таблиц не менялась. Добавлен 38-й ключ параметров `dev_investment {amountMinor, hours, note}` (Р-PUB-Z2-24): учёт пакета разработки для инвестиционных CPL/CAC — снимает структурную часть замечания по TimeEntry (B1-F-02, `ready_for_retest`); сумма и изменение объёма ждут владельца. Остальные оценки ниже не изменились.

## Общие правила (все сущности)

| Требование ТЗ §9 | Реализация | Оценка |
|---|---|---|
| `id, product_id, created_at, updated_at, created_by` | Есть `id` (cuid), `accountId`, `productId`, `createdAt timestamptz(3)` и `createdBy`. Формат `createdBy` проверяет триггер `pub_actor_format`. `updatedAt` + `revision` есть только у изменяемых «голов» и у AO-таблиц со сменой статуса (design §6.1). | **Частично.** У append-only таблиц `updatedAt` нет: `pub_audit_events`, `pub_payments`, `pub_reports`, `pub_claim_sources`, `pub_lead_decisions`, `pub_version_*`, `pub_campaigns`, `pub_lead_contacts`. По смыслу это оправдано: строки неизменяемы. Но отступление от буквы ТЗ не оформлено как ДТ (находка B1-F-15, S3). |
| Связность | Составные FK `(xId, accountId)` с `ON DELETE RESTRICT`. Триггер `pub_same_product` не даёт сослаться на строку другого продукта. Списки ссылок хранятся в таблицах связей, а не в `Json`. | Да. Исключения: `pub_approvals.objectId` и `pub_audit_events.objectId` полиморфны, см. Approval и AuditEvent. |
| Временные метки с поясом | Везде `@db.Timestamptz(3)`. Вехи Kyiv считает `core/kyiv-time.ts`. | Да |
| Конкуренция | Оптимистичная `revision` (409 `PUB_CONFLICT`). Идемпотентность — `pub_idempotency_keys` по `opKey`. Деньги — условный `UPDATE` в SQL-функциях. Согласование читается `FOR SHARE`. Цепочка отчётов — advisory-lock плюс частичный уникальный индекс. | Да. Проверено AT-CORE-10, AT-CORE-14, AT-F12-02, `reports-snapshots`. |

## Реестр по сущностям

Обозначения:

- «пример» — где в фикстурах создаётся запись (путь:строка).
- «связность» — FK и триггеры.
- «конкуренция» — уникальные ключи и блокировки.

Колонки выписаны из `models.json`.

### Product

- **Поля ТЗ → колонки.**
  - Имя → `pub_products.name`.
  - Ниша, язык, рынок, оффер, лимиты, контакт → `pub_parameters` с ключами `niche`, `language`, `market`, `offer_active_version`, `budget_*`, `alt_contact`, `responsibles`. Значение (`value Json`) имеет статус `assumption|approved|rejected|revoked`. Журнал решений — `pub_parameter_decisions` (`basis`, `dependentStages`).
  - Роли → `pub_role_grants`.
  - Утверждённые факты → `pub_brand_facts`, `pub_offer_versions`.
  - Противопоказанные обещания → `pub_brand_facts.kind = forbidden_promise`.
- **Пример:**
  - `fixtures.testing.ts:141` (`seedProduct`: `kind`, `name`, `mode`);
  - `publisher-schema.testing.ts:488` (`decidedParam`);
  - E2E: шаг SETUP «создание рабочего продукта по API», `evidence.productId` в `pube2e4/e2e.json`.
- **Связность.** FK `(siteId, accountId) → site_sites RESTRICT`. `@@unique([siteId])` — один продукт на сайт. `kind`, `siteId`, `publicKey` неизменяемы (триггер).
- **Конкуренция.** `revision`. Блокировка `lockProduct` в операциях. `refreshGateFlags` выполняется под блокировкой.
- **Оценка: достаточно.** Замечание: все параметры пока в статусе «допущение». Решений владельца нет (см. B1-F-03 и B1-verdict).

### Source

- **Поля ТЗ → колонки.** Адрес/идентификатор → `url`/`externalRef`; тип → `kind`; разрешение → `usage`; автор → `author`; дата → `publishedOn`; фрагмент → `fragment`; язык → `language`; дата проверки → `checkedAt`; актуальность → `freshness`; закрытость → `visibility=private`.
- **Сверх ТЗ:** `contentHash`, `supersedesId` (редакции), `injectionFlag`, `isSynthetic`, `revoked*`.
- **Пример:** `publisher-schema.testing.ts:253`; TD-10 (`td10.testing.ts`, источник для отзыва).
- **Связность.** FK на себя (`supersedesId`). Отзыв пишется в `pub_source_revocations` и необратим (`usage=revoked`).
- **Конкуренция.** `revision`. Параллельная правка источника → одна новая редакция, вторая получает 409 (`content-after-approval.spec`).
- **Оценка: достаточно.**

### Question

- **Поля ТЗ → колонки.** Формулировка → `text`; аудитория → `audience`; стадия → `stage`; связанные источники → `pub_question_sources`; повторение → `observedRepeats` (NULL = неизвестно); приоритет с пояснением → `scores Json` (четыре критерия 0–2 с пояснением) + `priorityNote`. Группы — `pub_question_groups` (`task`, `rationale`, `mergeRisk`).
- **Пример:** `publisher-schema.testing.ts:280`.
- **Связность.** FK `groupId`, `frequencySourceId`.
- **Конкуренция.** `@@unique([productId, selectedRank])` — шесть выбранных тем без дублей ранга.
- **Оценка: достаточно.**

### Brief

- **Поля ТЗ → колонки.** `question_id` → `questionId` (FK); цель → `goal`; формат → `format`; собственный вклад → `ownContribution`; источники → `pub_brief_sources`; CTA → `cta` + `ctaIntentNote`; каналы → `channels Json`; трудозатраты → `effortMinutes`; критерии готовности → `readinessCriteria Json`. Связь с оффером — `offerVersionId` (FK).
- **Пример:** `publisher-schema.testing.ts:289`.
- **Связность.** FK на вопрос, версию оффера и `aiCallId`.
- **Конкуренция.** `revision`.
- **Оценка: достаточно.** Замечание S3: `channels` хранится свободным списком строк, без FK на `pub_channels`. ТЗ требует только «ожидаемые каналы» как план, но связать бриф с фактическим каналом может только человек.

### ContentVersion

- **Поля ТЗ → колонки.** `content_id` → `contentId`; номер → `number`; текст → `body`; метаданные → `meta`; `source_ids` → `pub_version_sources`; `claim_ids` → `pub_version_claims`; `offer_version` → `offerVersionId`; автор → `authorMemberId`; статус → `status`; hash → `hash`.
- **Опубликованный текст отдельно от черновика:** `frozenAt` и `pub_contents.publishedVersionId`/`approvedVersionId`/`currentVersionId`. Факты бренда версии — `pub_version_facts`.
- **Пример:** `publisher-schema.testing.ts:325` (`version`), `:356` (`frozenVersion`); E2E-01.
- **Связность.**
  - `@@unique([contentId, number])`.
  - `parentVersionId` (адаптации).
  - После связи содержимое claims и источников не меняется (P2-14).
  - Hash включает содержимое claims и источников (`content-hash`, `pure.spec`).
- **Конкуренция.** Повторная правка той же ревизии → 409. Параллельные `approve` → одно активное согласование.
- **Оценка: достаточно.**

### Claim

- **Поля ТЗ → колонки.** Утверждение → `statement`; риск → `risk`; тип → `type`; `source_ids` → `pub_claim_sources` (`supports yes|no|partial|unknown`, `checkedBy`, `checkedAt`); проверивший → `verifiedBy`; дата проверки → `verifiedAt`; следующая проверка → `nextCheckAt`. Связь с экспериментом — `experimentId`.
- **Пример:** `td10.testing.ts:147` (критический claim «Пілот коштує 10 000 грн», `supports=yes`, затем `status=supported`).
- **Связность.**
  - `supersedesId`: правка создаёт новую строку.
  - `@@unique([claimId, sourceId])`.
  - Триггер требует у подтверждённого критического claim поддерживающее доказательство. Именно он поймал дефект восстановления Р-PUB-Z2-23.
- **Конкуренция.** `revision`.
- **Оценка: достаточно.**

### Approval

- **Поля ТЗ → колонки.** Тип действия → `type` (`publish_version|purchase|reserve_release|ai_extra_generation`); `object_id` → `objectType`/`objectId`; `version_hash` → `versionHash`; максимальная сумма → `maxAmountMinor`; валюта → `currency`; согласующий → `approverMemberId`/`approverDisplayName`; время → `decidedAt`; срок → `expiresAt` (у `purchase` — не больше 72 ч, триггер); статус → `status`. Самоаудит — `selfReview`.
- **Пример:** `publisher-schema.testing.ts:378` (`publishApproval`), `:464` (`purchaseApproval`).
- **Связность.**
  - Объект полиморфный, без FK. Существование и совпадение hash/валюты/суммы триггер `pub_approvals_guard` проверяет только для `publish_version` и `purchase`.
  - Для `reserve_release` и `ai_extra_generation` существование объекта не проверяется. Фикстура `reserveApproval` (`:529`) вставляет случайный `objectId: rid('bl')` — и вставка проходит. Находка B1-F-16, S3.
- **Конкуренция.** AO-таблица: переход статуса возможен только из `active`. Публикация читает согласование `FOR SHARE`.
- **Оценка: достаточно с замечанием S3.**

### Publication

- **Поля ТЗ → колонки.** `content_version_id` → `versionId`; канал → `channelId`; `final_url` → `finalUrl`; дата → `publishedAt`; статус → `status`; `evidence_url` → `evidenceUrl`; `last_verified_at` → `lastVerifiedAt`. Кроме того, хранятся `approvalId` (FK), `stage`, `verifyStatus` и `opKey`.
- **Пример:** `td10.testing.ts:183`; E2E-01 «режим live … опубликован на сайте».
- **Связность.** FK на версию, канал и согласование; `pub_same_product`.
- **Конкуренция.**
  - `@@unique([productId, opKey])`.
  - `@@unique([channelId, finalUrl, versionId])`.
  - Частичный индекс `pub_publications_active_url_uq` (одна активная публикация на URL и стадию).
- **Оценка: достаточно.**

### Placement

- **Поля ТЗ → колонки.**
  - Площадка → `pub_venues` (критерии, `check*`, `linkMarking`) + `pub_venue_evidence`; ссылка из закупки — `venueId`.
  - Версия → `versionId`; `campaign_id` → `campaignId`; `placement_id` → `placementCode`; UTM → `issuedUrl`.
  - Цена → `basePriceMinor`/`feesMinor`/`totalPriceMinor`, `fx*`; условия → `terms`; внешний номер → `externalOrderId`.
  - Статус заказа → `status`; статус оплаты → `paymentStatus`; срок публикации → `publishDueAt`; проверка → `verifiedAt`; претензия → `claimStatus`/`claimOwnerMemberId`/`nextActionAt`.
  - Кроме того: `purchaseSeq`, `observationOk`, `reportDecisionId`.
- **Пример:** `publisher-schema.testing.ts:424` (900 + 100 = 1 000 UAH); E2E-03.
- **Связность.** FK на площадку, версию, кампанию, согласование, расход и отчёт-решение; `pub_same_product`.
- **Конкуренция.** `@@unique([productId, placementCode])`, `@@unique([campaignId, purchaseSeq])`, `@@unique([venueId, externalOrderId])`. Резерв идёт через SQL-функции бюджета.
- **Оценка: достаточно.**

### Expense

- **Поля ТЗ → колонки.** Категория → `category`; сумма → `amountTotalMinor`; валюта → `currency`; `paid_amount` → `paidMinor`; `source_document` → `sourceDocument`; `placement_id` → `placementId`. Для валюты хранятся исходная валюта, курс, источник и время (`origCurrency`, `origAmountMinor`, `fxRate`, `fxSource`, `fxAt`). Движения — `pub_expense_entries` (`commit|pay|deliver|cancel|refund`, `externalRef`, `opKey`, `confirmedAt`/`confirmedBy`).
- **Производные поля:**
  - `open_commitment_amount` и `delivered_unpaid_amount` не хранятся колонками. Их считают функции `budget-math.ts` и SQL из `amountTotal/paid/delivered/cancelled/refunded`.
  - Резерв бюджета — `pub_budget_limits.protectedReserveMinor`, счётчики `netPaidMinor`/`openCommitMinor`.
- **Пример:** `td10.testing.ts:243` (100 000 коп., `commit` → `pay` → `deliver`); E2E-03 (вектор 5 000).
- **Связность.** Триггер: `amountTotalMinor ≤ maxAmountMinor` согласования. Положительная корректировка без нового согласования отвергается.
- **Конкуренция.**
  - `@@unique([expenseId, kind, externalRef])`, `@@unique([expenseId, opKey])`.
  - Флаг `reconcileRequired` блокирует движение.
  - Атомарный резерв: 20 параллельных → ровно один успех.
- **Оценка: достаточно.** Производные величины воспроизводимы; ручной пересчёт есть в `reports-economics.spec` («снимок TD-09 … посчитаны вручную»).

### TimeEntry

- **Поля ТЗ → колонки.** Роль → `role`; задача → `task`; `feature_id` → `featureId`; `content_id` → `contentId` (FK); минуты → `minutes`; ставка → `rateMinorPerHour` (NULL — ставка не утверждена) + `rateParamVersion`; дата → `workDate` (Kyiv); категория → `category` (`setup|research|production|distribution|analytics_ops|qa_reports|development`); `isInvestment` (триггер).
- **Пример:** `td10.testing.ts:380` (60 мин, `analytics_ops`).
- **Связность.** Есть FK на материал. `memberId` — без FK, со снимком имени (design §4.1).
- **Конкуренция.** `revision`.
- **Оценка.** Поля достаточны. Пакет разработки учитывается параметром `dev_investment` (Р-PUB-Z2-24), пока сумма не утверждена — инвестиционные показатели «не менее» (B1-F-02, `ready_for_retest`).

### Lead

- **Поля ТЗ → колонки.**
  - Контакт в защищённом хранилище → `pub_lead_contacts.contactEnc` (AES-GCM, AAD = `leadId`). В шифре: имя, способ, контакт, сайт/описание, **задача**, самоотчёт. Есть `matchHash` (HMAC с `productId`).
  - `prospect_id` → `prospectId` + `pub_prospects` + история `pub_lead_prospect_links`.
  - Атрибуция → `attribution Json`, `campaignId`/`contentId`/`placementId`/`sessionRef`.
  - `self_reported_source` → `selfReportedChannel`; статус → `status`; `reason` → `pub_lead_decisions.reasonCode` (+ `noteEnc`); `responsible` → `responsibleMemberId`; `test_flag` → `testFlag`/`testReason`; `duplicate_of` → `duplicateOfLeadId`; история → `pub_lead_decisions` (AO) + `pub_audit_events`.
  - Также хранятся `campaign_id`, `consent_state`, `session_ref`. Удаление — `erasedAt` + `pub_erasures`. Ретенция — `reviewDueAt`/`retentionBasis`.
- **Пример:** `publisher-schema.testing.ts:542` (`lead`), `:560` (`prospect`); E2E-02 (номер `L-…`, контакт синтетический, в отчёт не переносится).
- **Связность.** FK на проспект, кампанию, материал, закупку, дубль.
- **Конкуренция.** `@@unique([productId, submissionKey])`: 10 одинаковых параллельных отправок дают одну заявку (AT-CORE-04).
- **Оценка: достаточно.**

### Payment

- **Поля ТЗ → колонки.** `occurred_at` → `occurredAt`; `payment_id` → `paymentRef`; `prospect_id` → `prospectId` (FK); сумма → `amountMinor`; валюта → `currency`; подтверждение → `confirmation`/`confirmedBy`/`confirmedAt`/`status`. Сверх ТЗ: `recordType`, `payerKind`, `isNewCustomer`, `opKey`, `leadId`.
- **Пример:** `td10.testing.ts:347` (`external`, `payment_received`, `confirmed`, `isNewCustomer=yes`).
- **Связность.** FK на проспект и заявку. Заявка должна принадлежать своему проспекту (S3-6).
- **Конкуренция.** `@@unique([productId, paymentRef])`, `@@unique([productId, opKey])`: повтор `paymentRef` → 409.
- **Оценка: достаточно.** Замечание: у `pub_payments` есть `status`, но нет `updatedAt` (см. общие правила).

### AICall

- **Поля ТЗ → колонки.** Назначение → `purpose`/`generator`; `instruction_version` → `instructionVersion` (+ `contextRulesVersion`); `source_ids` → `sourceIds Json`, существование проверяет триггер при вставке; provider/model → `provider`/`model`; usage → `inputTokens`/`cachedInputTokens`/`outputTokens`; cost/status → `costMicroUsd` (NULL — неизвестно) + `costStatus` + `status`. Также `configId`, `attemptNo`, `opKey`, `output`, `errorCode`.
- **Пример:** `publisher-schema.testing.ts:578` (`gemini-2.5-flash`, `pub.brief.draft@1`, `ctx@1`).
- **Связность.** FK на задачу и конфигурацию.
- **Конкуренция.** `@@unique([taskId, attemptNo])` — не больше двух генераторных попыток. `@@unique([productId, opKey])`. Месячный потолок — условный `UPDATE` `pub_ai_budget_months`.
- **Оценка: достаточно.**

### Experiment

- **Поля ТЗ → колонки.** Гипотеза → `hypothesis`; изменение → `change`; выбор материалов → `pub_experiment_contents`; метрика → `metric`; окно → `windowStart`/`windowEnd`; лимит → `limitMinor`; условия остановки → `stopConditions`; дата регистрации → `registeredAt`; заключение → `conclusion`/`conclusionReason`/`decision`. Сверх ТЗ: `thresholds` (заморожены триггером), `t0Planned`, `t0…t90`, `lateCohortEnd`, `version`, `supersedesId`.
- **Пример:** `publisher-schema.testing.ts:596`.
- **Связность.** FK на версии `baseline`/`new`; `supersedesId`.
- **Конкуренция.** `@@unique([productId, key, version])`. `t0` ставится один раз (условный `UPDATE`).
- **Оценка: достаточно.** Зависит от ДТ-1 (B1-F-01).

### Report

- **Поля ТЗ → колонки.** Период → `periodStart`/`periodEnd`; `snapshot_at` → `snapshotAt`; источник → `sources Json`; модель атрибуции → `attributionModel`; покрытие данных → внутри `sources`/`metrics` (у колонки нет отдельного имени); показатели → `metrics`; расходы → `costs`; допущения → `assumptions`; решение → `decision`. Сверх ТЗ: `inputsHash`, `supersedesReportId`, `recomputeReason`, `cohort`.
- **Пример:** `td10.testing.ts:218` и `:223` (снимок и наследник `decision`); E2E-05 (d42/d72/d90).
- **Связность.** Снимок неизменяем (UPDATE/DELETE → 23514). У снимка не больше одного наследника (частичный индекс `pub_reports_supersedes_uq` + advisory-lock).
- **Конкуренция.** Два параллельных решения по одному снимку → одно успешно, второе 409.
- **Оценка: достаточно.** Замечание: «покрытие данных» хранится не колонкой, а в JSON. Структуру фиксирует только код `report-compute.ts`, схема JSON не версионирована.

### AuditEvent

- **Поля ТЗ → колонки.** Действующее лицо → `actor`; объект → `objectType`/`objectId`; действие → `action`; прежний/новый статус → `fromStatus`/`toStatus`; время → `occurredAt`; причина → `reason` (`pii-guard`). Секретов и контактов нет: триггер отвергает ключи `contact, email, phone, name, task, …` в `meta`.
- **Пример:** `td10.testing.ts:404`.
- **Связность.** `objectId` полиморфный, без FK (журнал).
- **Конкуренция.** AO; пишется в транзакции операции.
- **Оценка: достаточно.**

## Итог по сущностям

- Все 17 сущностей ТЗ §9 имеют таблицы, поля и пример записи в фикстурах. 16 из 17 достаточны без оговорок.
- **Approval** — замечание S3: существование объекта не проверяется для двух служебных типов.
- **Общее отступление `updated_at`** — S3, не оформлено как ДТ.
- **TimeEntry** — структура достаточна; учёт разработки вынесен в параметр `dev_investment` (B1-F-02, `ready_for_retest`, утверждение суммы — владелец).

Ограничения связности и конкуренции проверены автотестами. Это внутренний прогон, а не внешняя перепроверка.

Ручной режим (права записи, чеклист, порядок сверки — план §9 B1) неприменим: выбран программный режим (Р-PUB-0 №5). Ручной реестр не ведётся.
