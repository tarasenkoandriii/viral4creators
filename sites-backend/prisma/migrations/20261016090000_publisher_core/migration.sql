-- AI Publisher, этап 0, пакет P-A0 — схема модуля `publisher` (таблицы pub_*).
-- Основание: doc/ai-publisher/IMPLEMENTATION-DESIGN.md v1.1, разделы 5.2, 6,
-- 6.9, 16.1 (требования — pilot-spec-v2.md §9–§10, §21).
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем; после этой таблицы pub_* заморожены
-- (изменение — запрос координатору и новая последовательная миграция).
--
-- Что здесь:
--  1. 66 таблиц pub_* (+ индексы и составные FK `(xId, accountId)` — строку
--     чужого кабинета не привязать даже ошибкой сервиса; ON DELETE RESTRICT —
--     история не исчезает каскадом).
--  2. Частичные уникальные индексы «одна активная строка» (Р-PUB-4). Prisma
--     их не описывает, `migrate diff` их не видит (проверено пакетом P-A0 до
--     миграции: частичный уникальный индекс — пустой diff, полный — DROP INDEX).
--  3. Функции и триггеры: закрытые списки, диапазоны, межколоночные условия
--     (`pub_<таблица>_guard`, SQLSTATE 23514), append-only, неизменяемые
--     колонки, формат актёра, ссылки внутри одного продукта, ключи ПД в jsonb,
--     защита публикации, денег, оценки AI. CHECK в pub_* НЕТ (раздел 5.2):
--     wasm-движок схем локального migrate diff на CHECK падает.
--  4. Представления pub_public_products и pub_public_contents.
--  5. NOLOGIN-роль publisher_public и её явные права (колонки/представления).
--
-- Функции движения денег (`pub_budget_*`), сверки счётчиков и функции
-- доменов пакетов — в их миграциях-слотах (20261016091000…094000), не здесь.

-- ══ Таблицы, индексы, внешние ключи (из schema.prisma) ══════════════════

-- CreateTable
CREATE TABLE "pub_products" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'closed',
    "liveSince" TIMESTAMPTZ(3),
    "paramsPublicPublishOk" BOOLEAN NOT NULL DEFAULT false,
    "paramsRealLeadsOk" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "restoredFromBackupId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_parameters" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assumption',
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_parameter_proposals" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "parameterKey" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "proposedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'open',
    "decisionId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_parameter_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_parameter_decisions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "parameterKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "proposalId" TEXT,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "valueSnapshot" JSONB NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "basis" TEXT NOT NULL,
    "dependentStages" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_parameter_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_role_grants" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "memberDisplayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedBy" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_role_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_audit_events" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reason" TEXT,
    "meta" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_idempotency_keys" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT,
    "siteId" TEXT,
    "opKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_review_tasks" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "triggerRef" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigneeMemberId" TEXT,
    "dueAt" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_review_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_integrations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastCheckedAt" TIMESTAMPTZ(3),
    "staleAfterHours" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_campaigns" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "experimentId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_rate_hits" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_rate_hits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_sources" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT,
    "externalRef" TEXT,
    "title" TEXT,
    "author" TEXT,
    "publishedOn" TIMESTAMPTZ(3),
    "fragment" TEXT NOT NULL,
    "language" TEXT,
    "usage" TEXT NOT NULL DEFAULT 'restricted',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "checkedAt" TIMESTAMPTZ(3),
    "freshness" TEXT NOT NULL DEFAULT 'unknown',
    "importedVia" TEXT NOT NULL DEFAULT 'manual',
    "contentHash" TEXT NOT NULL,
    "supersedesId" TEXT,
    "injectionFlag" TEXT,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_source_revocations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "revokedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_source_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_question_groups" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "audience" TEXT,
    "rationale" TEXT NOT NULL,
    "mergeRisk" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "aiCallId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_question_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_questions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "audience" TEXT,
    "stage" TEXT NOT NULL,
    "groupId" TEXT,
    "observedRepeats" INTEGER,
    "frequency" INTEGER,
    "frequencySourceId" TEXT,
    "scores" JSONB NOT NULL,
    "priorityNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "selectedRank" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_question_sources" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "fragment" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_question_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_brand_facts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "scope" TEXT,
    "sourceId" TEXT,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "conflictWithId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_brand_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_offer_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "priceNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_offer_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_offer_facts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "offerVersionId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_offer_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_briefs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "offerVersionId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "ownContribution" TEXT,
    "shortAnswer" TEXT,
    "cta" TEXT,
    "ctaIntentNote" TEXT,
    "structure" JSONB NOT NULL,
    "channels" JSONB NOT NULL,
    "readinessCriteria" JSONB NOT NULL,
    "effortMinutes" INTEGER,
    "unresolved" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "aiCallId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_brief_sources" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_brief_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_contents" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "parentContentId" TEXT,
    "briefId" TEXT,
    "slug" TEXT,
    "status" TEXT NOT NULL DEFAULT 'brief',
    "currentVersionId" TEXT,
    "approvedVersionId" TEXT,
    "publishedVersionId" TEXT,
    "ownerMemberId" TEXT,
    "ownerDisplayName" TEXT,
    "nextDueAt" TIMESTAMPTZ(3),
    "blockReason" TEXT,
    "criticalStale" BOOLEAN NOT NULL DEFAULT false,
    "firstPublishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_content_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "meta" JSONB NOT NULL,
    "format" TEXT NOT NULL,
    "parentVersionId" TEXT,
    "offerVersionId" TEXT NOT NULL,
    "authorMemberId" TEXT NOT NULL,
    "aiCallId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "hash" TEXT,
    "frozenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_version_sources" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_version_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_version_claims" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_version_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_version_facts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_version_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_claims" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "extractedFromVersionId" TEXT,
    "experimentId" TEXT,
    "supersedesId" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "nextCheckAt" TIMESTAMPTZ(3),
    "aiCallId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_claim_sources" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "supports" TEXT NOT NULL,
    "checkedBy" TEXT,
    "checkedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_claim_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_qa_checks" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "blockers" JSONB NOT NULL,
    "checkedBy" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selfReview" BOOLEAN NOT NULL DEFAULT false,
    "aiCallId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_qa_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_approvals" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "versionHash" TEXT,
    "priceSnapshotHash" TEXT,
    "maxAmountMinor" BIGINT,
    "currency" TEXT,
    "approverMemberId" TEXT NOT NULL,
    "approverDisplayName" TEXT NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "selfReview" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_channels" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "utmSource" TEXT NOT NULL,
    "utmMedium" TEXT NOT NULL,
    "adsAllowed" BOOLEAN,
    "rulesNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'available',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_distribution_actions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "plannedAt" TIMESTAMPTZ(3) NOT NULL,
    "ownerMemberId" TEXT NOT NULL,
    "ownerDisplayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "blockReason" TEXT,
    "measurableUrl" TEXT NOT NULL,
    "publicationId" TEXT,
    "aiCallId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_distribution_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_publications" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "finalUrl" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verifyStatus" TEXT NOT NULL DEFAULT 'not_checked',
    "evidenceUrl" TEXT,
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "verifiedBy" TEXT,
    "verifyResult" TEXT,
    "opKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_venues" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "topic" TEXT,
    "market" TEXT,
    "language" TEXT,
    "audienceNote" TEXT,
    "formats" JSONB NOT NULL,
    "criteria" JSONB NOT NULL,
    "completeness" INTEGER NOT NULL DEFAULT 0,
    "checkTopicMarket" BOOLEAN NOT NULL DEFAULT false,
    "checkPriceConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "checkFormatConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "checkTermSet" BOOLEAN NOT NULL DEFAULT false,
    "checkSupplierKnown" BOOLEAN NOT NULL DEFAULT false,
    "linkMarking" TEXT NOT NULL DEFAULT 'unknown',
    "riskNote" TEXT,
    "rejectReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_venue_evidence" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "criterion" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_venue_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_placements" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "placementCode" TEXT NOT NULL,
    "issuedUrl" TEXT,
    "purchaseSeq" INTEGER NOT NULL,
    "basePriceMinor" BIGINT NOT NULL,
    "feesMinor" BIGINT NOT NULL,
    "totalPriceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "origCurrency" TEXT,
    "origAmountMinor" BIGINT,
    "fxRate" DECIMAL(18,8),
    "fxSource" TEXT,
    "fxAt" TIMESTAMPTZ(3),
    "priceConfirmedAt" TIMESTAMPTZ(3),
    "priceSource" TEXT,
    "offerExpiresAt" TIMESTAMPTZ(3),
    "terms" TEXT,
    "externalOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "approvalId" TEXT,
    "expenseId" TEXT,
    "reportDecisionId" TEXT,
    "publishDueAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "verifiedAt" TIMESTAMPTZ(3),
    "claimStatus" TEXT NOT NULL DEFAULT 'none',
    "claimOwnerMemberId" TEXT,
    "nextActionAt" TIMESTAMPTZ(3),
    "observationOk" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_budget_limits" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "totalLimitMinor" BIGINT NOT NULL DEFAULT 0,
    "placementsLimitMinor" BIGINT NOT NULL DEFAULT 0,
    "toolsLimitMinor" BIGINT NOT NULL DEFAULT 0,
    "protectedReserveMinor" BIGINT NOT NULL DEFAULT 0,
    "perPurchaseMaxMinor" BIGINT NOT NULL DEFAULT 0,
    "netPaidMinor" BIGINT NOT NULL DEFAULT 0,
    "openCommitMinor" BIGINT NOT NULL DEFAULT 0,
    "usedPlacementsMinor" BIGINT NOT NULL DEFAULT 0,
    "usedToolsMinor" BIGINT NOT NULL DEFAULT 0,
    "aiMonthMinor" BIGINT NOT NULL DEFAULT 0,
    "warnRatioBp" INTEGER NOT NULL DEFAULT 8000,
    "paramVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_budget_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_reserve_moves" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "toCategory" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "movedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_reserve_moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_expenses" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "placementId" TEXT,
    "amountTotalMinor" BIGINT NOT NULL,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    "cancelledMinor" BIGINT NOT NULL DEFAULT 0,
    "deliveredMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "origCurrency" TEXT,
    "origAmountMinor" BIGINT,
    "fxRate" DECIMAL(18,8),
    "fxSource" TEXT,
    "fxAt" TIMESTAMPTZ(3),
    "sourceDocument" TEXT,
    "reconcileRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_expense_entries" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "externalRef" TEXT,
    "sourceDocument" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedBy" TEXT,
    "opKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_expense_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_time_entries" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "memberDisplayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "featureId" TEXT,
    "contentId" TEXT,
    "minutes" INTEGER NOT NULL,
    "rateMinorPerHour" BIGINT,
    "rateParamVersion" INTEGER,
    "workDate" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "isInvestment" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_prospects" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isExternal" BOOLEAN NOT NULL,
    "isTeamOrPartner" BOOLEAN NOT NULL,
    "priorExternalPayment" TEXT NOT NULL DEFAULT 'unknown',
    "mergedIntoId" TEXT,
    "noteEnc" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_lead_prospect_links" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "validFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_lead_prospect_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_leads" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "submissionKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "publicRef" TEXT NOT NULL,
    "prospectId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "responsibleMemberId" TEXT,
    "responsibleDisplayName" TEXT,
    "testFlag" BOOLEAN NOT NULL,
    "testReason" TEXT,
    "suspectedSpam" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOfLeadId" TEXT,
    "contactMethod" TEXT NOT NULL,
    "budgetRange" TEXT,
    "selfReportedChannel" TEXT,
    "contentSlugRaw" TEXT,
    "placementCodeRaw" TEXT,
    "campaignId" TEXT,
    "contentId" TEXT,
    "placementId" TEXT,
    "sessionRef" TEXT,
    "consentState" TEXT NOT NULL,
    "attribution" JSONB,
    "enrichedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactDueAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "reviewDueAt" TIMESTAMPTZ(3) NOT NULL,
    "retentionBasis" TEXT,
    "erasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'public',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_lead_contacts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactEnc" TEXT NOT NULL,
    "matchHash" TEXT,
    "keyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'public',

    CONSTRAINT "pub_lead_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_lead_decisions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reasonCode" TEXT,
    "noteEnc" TEXT,
    "confirmedInterestAt" TIMESTAMPTZ(3),
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_lead_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_erasures" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "erasedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erasedBy" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_erasures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_payments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "leadId" TEXT,
    "recordType" TEXT NOT NULL,
    "payerKind" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "confirmation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "isNewCustomer" TEXT NOT NULL DEFAULT 'unknown',
    "opKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sessionRef" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "landingPath" TEXT NOT NULL,
    "contentSlugRaw" TEXT,
    "placementCodeRaw" TEXT,
    "utm" JSONB NOT NULL,
    "consentState" TEXT NOT NULL,
    "testFlag" BOOLEAN NOT NULL,
    "landingContentId" TEXT,
    "placementId" TEXT,
    "channelGroup" TEXT,
    "enrichedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'public',

    CONSTRAINT "pub_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_events" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientAt" TIMESTAMPTZ(3),
    "contentSlugRaw" TEXT,
    "placementCodeRaw" TEXT,
    "referrerHost" TEXT,
    "contentId" TEXT,
    "placementId" TEXT,
    "channelGroup" TEXT,
    "sessionRef" TEXT,
    "utm" JSONB,
    "utmRedacted" BOOLEAN NOT NULL DEFAULT false,
    "leadId" TEXT,
    "testFlag" BOOLEAN NOT NULL,
    "enrichedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'public',

    CONSTRAINT "pub_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_lead_outbox" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'lead_received',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'public',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_lead_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_notifications" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipientMemberId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_queue_checks" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "checkedBy" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workDate" DATE NOT NULL,
    "openCount" INTEGER NOT NULL,
    "overdueCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_queue_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_metric_imports" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "granularity" TEXT NOT NULL DEFAULT 'kyiv_day',
    "payload" JSONB NOT NULL,
    "importedBy" TEXT NOT NULL,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileRef" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_metric_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_experiments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "expectedSignal" TEXT NOT NULL,
    "stopConditions" TEXT NOT NULL,
    "baselineVersionId" TEXT,
    "newVersionId" TEXT,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "limitMinor" BIGINT,
    "thresholds" JSONB NOT NULL,
    "t0Planned" TIMESTAMPTZ(3),
    "t0" TIMESTAMPTZ(3),
    "t42" TIMESTAMPTZ(3),
    "t72" TIMESTAMPTZ(3),
    "t90" TIMESTAMPTZ(3),
    "lateCohortEnd" TIMESTAMPTZ(3),
    "registeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'registered',
    "conclusion" TEXT,
    "conclusionReason" TEXT,
    "decision" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "supersedesId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_experiment_contents" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_experiment_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_reports" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "snapshotAt" TIMESTAMPTZ(3) NOT NULL,
    "experimentId" TEXT,
    "cohort" JSONB NOT NULL,
    "attributionModel" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "costs" JSONB NOT NULL,
    "assumptions" TEXT,
    "decision" TEXT,
    "inputsHash" TEXT NOT NULL,
    "supersedesReportId" TEXT,
    "recomputeReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_backups" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "blobPathEnc" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "tableCounts" JSONB NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "rotationUntil" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_restores" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "targetProductId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "report" JSONB NOT NULL,
    "startedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_restores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_ai_configs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "contextRulesVersion" TEXT NOT NULL,
    "schemaSetVersion" TEXT NOT NULL,
    "instructionVersions" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "coveredGenerators" JSONB NOT NULL,
    "evalSetVersion" TEXT NOT NULL DEFAULT '2.2',
    "evalStatus" TEXT NOT NULL DEFAULT 'not_run',
    "evalRunId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "basis" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_ai_config_bindings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "boundBy" TEXT NOT NULL,
    "boundAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "basis" TEXT NOT NULL,
    "unboundAt" TIMESTAMPTZ(3),
    "unboundBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_ai_config_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_ai_tasks" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "generator" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "generationsUsed" INTEGER NOT NULL DEFAULT 0,
    "extraAllowance" INTEGER NOT NULL DEFAULT 0,
    "extraApprovalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_ai_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_ai_budget_months" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "capMicroUsd" BIGINT NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "expenseId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_ai_budget_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_ai_calls" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "generator" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "configId" TEXT,
    "instructionVersion" TEXT NOT NULL,
    "contextRulesVersion" TEXT NOT NULL,
    "sourceIds" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "opKey" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costMicroUsd" BIGINT,
    "costStatus" TEXT NOT NULL DEFAULT 'unknown',
    "output" JSONB,
    "rawExcerpt" TEXT,
    "errorCode" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_ai_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_ai_eval_runs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "totals" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_ai_eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_ai_eval_results" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskCode" TEXT NOT NULL,
    "schema" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "allowedSourceIds" JSONB NOT NULL,
    "firstAnswer" JSONB,
    "firstAnswerRaw" TEXT,
    "claimSources" JSONB,
    "autoHardFail" JSONB NOT NULL,
    "autoFlags" JSONB NOT NULL,
    "flagResolutions" JSONB NOT NULL,
    "criticalPass" BOOLEAN,
    "usefulnessPass" BOOLEAN,
    "explanation" TEXT,
    "reviewerMemberId" TEXT,
    "secondReviewerMemberId" TEXT,
    "costMicroUsd" BIGINT,
    "costStatus" TEXT NOT NULL DEFAULT 'unknown',
    "retryOfResultId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_ai_eval_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pub_products_publicKey_key" ON "pub_products"("publicKey");

-- CreateIndex
CREATE INDEX "pub_products_accountId_idx" ON "pub_products"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_products_id_accountId_key" ON "pub_products"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_products_siteId_key" ON "pub_products"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_parameters_id_accountId_key" ON "pub_parameters"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_parameters_productId_key_key" ON "pub_parameters"("productId", "key");

-- CreateIndex
CREATE INDEX "pub_parameter_proposals_productId_parameterKey_status_idx" ON "pub_parameter_proposals"("productId", "parameterKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_parameter_proposals_id_accountId_key" ON "pub_parameter_proposals"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_parameter_decisions_id_accountId_key" ON "pub_parameter_decisions"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_parameter_decisions_productId_parameterKey_version_key" ON "pub_parameter_decisions"("productId", "parameterKey", "version");

-- CreateIndex
CREATE INDEX "pub_role_grants_productId_memberId_idx" ON "pub_role_grants"("productId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_role_grants_id_accountId_key" ON "pub_role_grants"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_audit_events_productId_occurredAt_idx" ON "pub_audit_events"("productId", "occurredAt");

-- CreateIndex
CREATE INDEX "pub_audit_events_productId_objectType_objectId_idx" ON "pub_audit_events"("productId", "objectType", "objectId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_audit_events_id_accountId_key" ON "pub_audit_events"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_idempotency_keys_expiresAt_idx" ON "pub_idempotency_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_idempotency_keys_id_accountId_key" ON "pub_idempotency_keys"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_idempotency_keys_accountId_opKey_key" ON "pub_idempotency_keys"("accountId", "opKey");

-- CreateIndex
CREATE INDEX "pub_review_tasks_productId_status_idx" ON "pub_review_tasks"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_review_tasks_id_accountId_key" ON "pub_review_tasks"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_review_tasks_productId_objectType_objectId_reason_trigg_key" ON "pub_review_tasks"("productId", "objectType", "objectId", "reason", "triggerRef");

-- CreateIndex
CREATE UNIQUE INDEX "pub_integrations_id_accountId_key" ON "pub_integrations"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_integrations_productId_kind_key" ON "pub_integrations"("productId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "pub_campaigns_id_accountId_key" ON "pub_campaigns"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_campaigns_productId_code_key" ON "pub_campaigns"("productId", "code");

-- CreateIndex
CREATE INDEX "pub_rate_hits_key_at_idx" ON "pub_rate_hits"("key", "at");

-- CreateIndex
CREATE INDEX "pub_rate_hits_at_idx" ON "pub_rate_hits"("at");

-- CreateIndex
CREATE INDEX "pub_sources_productId_usage_idx" ON "pub_sources"("productId", "usage");

-- CreateIndex
CREATE UNIQUE INDEX "pub_sources_id_accountId_key" ON "pub_sources"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_source_revocations_productId_idx" ON "pub_source_revocations"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_source_revocations_id_accountId_key" ON "pub_source_revocations"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_question_groups_id_accountId_key" ON "pub_question_groups"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_question_groups_productId_key_key" ON "pub_question_groups"("productId", "key");

-- CreateIndex
CREATE INDEX "pub_questions_productId_status_idx" ON "pub_questions"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_questions_id_accountId_key" ON "pub_questions"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_questions_productId_selectedRank_key" ON "pub_questions"("productId", "selectedRank");

-- CreateIndex
CREATE INDEX "pub_question_sources_sourceId_idx" ON "pub_question_sources"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_question_sources_id_accountId_key" ON "pub_question_sources"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_question_sources_questionId_sourceId_key" ON "pub_question_sources"("questionId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_brand_facts_id_accountId_key" ON "pub_brand_facts"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_brand_facts_productId_factKey_version_key" ON "pub_brand_facts"("productId", "factKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "pub_offer_versions_id_accountId_key" ON "pub_offer_versions"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_offer_versions_productId_version_key" ON "pub_offer_versions"("productId", "version");

-- CreateIndex
CREATE INDEX "pub_offer_facts_factId_idx" ON "pub_offer_facts"("factId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_offer_facts_id_accountId_key" ON "pub_offer_facts"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_offer_facts_offerVersionId_factId_key" ON "pub_offer_facts"("offerVersionId", "factId");

-- CreateIndex
CREATE INDEX "pub_briefs_productId_status_idx" ON "pub_briefs"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_briefs_id_accountId_key" ON "pub_briefs"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_brief_sources_sourceId_idx" ON "pub_brief_sources"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_brief_sources_id_accountId_key" ON "pub_brief_sources"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_brief_sources_briefId_sourceId_key" ON "pub_brief_sources"("briefId", "sourceId");

-- CreateIndex
CREATE INDEX "pub_contents_productId_status_idx" ON "pub_contents"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_contents_id_accountId_key" ON "pub_contents"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_contents_productId_slug_key" ON "pub_contents"("productId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "pub_content_versions_id_accountId_key" ON "pub_content_versions"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_content_versions_contentId_number_key" ON "pub_content_versions"("contentId", "number");

-- CreateIndex
CREATE INDEX "pub_version_sources_sourceId_idx" ON "pub_version_sources"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_version_sources_id_accountId_key" ON "pub_version_sources"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_version_sources_versionId_sourceId_key" ON "pub_version_sources"("versionId", "sourceId");

-- CreateIndex
CREATE INDEX "pub_version_claims_claimId_idx" ON "pub_version_claims"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_version_claims_id_accountId_key" ON "pub_version_claims"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_version_claims_versionId_claimId_key" ON "pub_version_claims"("versionId", "claimId");

-- CreateIndex
CREATE INDEX "pub_version_facts_factId_idx" ON "pub_version_facts"("factId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_version_facts_id_accountId_key" ON "pub_version_facts"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_version_facts_versionId_factId_key" ON "pub_version_facts"("versionId", "factId");

-- CreateIndex
CREATE INDEX "pub_claims_productId_status_idx" ON "pub_claims"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_claims_id_accountId_key" ON "pub_claims"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_claim_sources_sourceId_idx" ON "pub_claim_sources"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_claim_sources_id_accountId_key" ON "pub_claim_sources"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_claim_sources_claimId_sourceId_key" ON "pub_claim_sources"("claimId", "sourceId");

-- CreateIndex
CREATE INDEX "pub_qa_checks_versionId_kind_idx" ON "pub_qa_checks"("versionId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "pub_qa_checks_id_accountId_key" ON "pub_qa_checks"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_approvals_productId_objectType_objectId_idx" ON "pub_approvals"("productId", "objectType", "objectId");

-- CreateIndex
CREATE INDEX "pub_approvals_status_expiresAt_idx" ON "pub_approvals"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_approvals_id_accountId_key" ON "pub_approvals"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_channels_id_accountId_key" ON "pub_channels"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_channels_productId_code_key" ON "pub_channels"("productId", "code");

-- CreateIndex
CREATE INDEX "pub_distribution_actions_productId_status_idx" ON "pub_distribution_actions"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_distribution_actions_id_accountId_key" ON "pub_distribution_actions"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_publications_versionId_idx" ON "pub_publications"("versionId");

-- CreateIndex
CREATE INDEX "pub_publications_productId_stage_status_idx" ON "pub_publications"("productId", "stage", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_publications_id_accountId_key" ON "pub_publications"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_publications_productId_opKey_key" ON "pub_publications"("productId", "opKey");

-- CreateIndex
CREATE UNIQUE INDEX "pub_publications_channelId_finalUrl_versionId_key" ON "pub_publications"("channelId", "finalUrl", "versionId");

-- CreateIndex
CREATE INDEX "pub_venues_productId_status_idx" ON "pub_venues"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_venues_id_accountId_key" ON "pub_venues"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_venue_evidence_sourceId_idx" ON "pub_venue_evidence"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_venue_evidence_id_accountId_key" ON "pub_venue_evidence"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_venue_evidence_venueId_criterion_sourceId_key" ON "pub_venue_evidence"("venueId", "criterion", "sourceId");

-- CreateIndex
CREATE INDEX "pub_placements_productId_status_idx" ON "pub_placements"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_placements_id_accountId_key" ON "pub_placements"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_placements_productId_placementCode_key" ON "pub_placements"("productId", "placementCode");

-- CreateIndex
CREATE UNIQUE INDEX "pub_placements_campaignId_purchaseSeq_key" ON "pub_placements"("campaignId", "purchaseSeq");

-- CreateIndex
CREATE UNIQUE INDEX "pub_placements_venueId_externalOrderId_key" ON "pub_placements"("venueId", "externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_budget_limits_id_accountId_key" ON "pub_budget_limits"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_budget_limits_productId_key" ON "pub_budget_limits"("productId");

-- CreateIndex
CREATE INDEX "pub_reserve_moves_productId_idx" ON "pub_reserve_moves"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reserve_moves_id_accountId_key" ON "pub_reserve_moves"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_expenses_productId_category_status_idx" ON "pub_expenses"("productId", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_expenses_id_accountId_key" ON "pub_expenses"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_expense_entries_productId_status_idx" ON "pub_expense_entries"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_expense_entries_id_accountId_key" ON "pub_expense_entries"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_expense_entries_expenseId_kind_externalRef_key" ON "pub_expense_entries"("expenseId", "kind", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "pub_expense_entries_expenseId_opKey_key" ON "pub_expense_entries"("expenseId", "opKey");

-- CreateIndex
CREATE INDEX "pub_time_entries_productId_workDate_idx" ON "pub_time_entries"("productId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "pub_time_entries_id_accountId_key" ON "pub_time_entries"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_prospects_id_accountId_key" ON "pub_prospects"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_prospects_productId_code_key" ON "pub_prospects"("productId", "code");

-- CreateIndex
CREATE INDEX "pub_lead_prospect_links_leadId_validFrom_idx" ON "pub_lead_prospect_links"("leadId", "validFrom");

-- CreateIndex
CREATE INDEX "pub_lead_prospect_links_prospectId_idx" ON "pub_lead_prospect_links"("prospectId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_lead_prospect_links_id_accountId_key" ON "pub_lead_prospect_links"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_leads_publicRef_key" ON "pub_leads"("publicRef");

-- CreateIndex
CREATE INDEX "pub_leads_productId_status_receivedAt_idx" ON "pub_leads"("productId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "pub_leads_reviewDueAt_idx" ON "pub_leads"("reviewDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_leads_id_accountId_key" ON "pub_leads"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_leads_productId_submissionKey_key" ON "pub_leads"("productId", "submissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "pub_lead_contacts_leadId_key" ON "pub_lead_contacts"("leadId");

-- CreateIndex
CREATE INDEX "pub_lead_contacts_productId_matchHash_idx" ON "pub_lead_contacts"("productId", "matchHash");

-- CreateIndex
CREATE UNIQUE INDEX "pub_lead_contacts_id_accountId_key" ON "pub_lead_contacts"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_lead_decisions_leadId_decidedAt_idx" ON "pub_lead_decisions"("leadId", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_lead_decisions_id_accountId_key" ON "pub_lead_decisions"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_erasures_productId_idx" ON "pub_erasures"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_erasures_id_accountId_key" ON "pub_erasures"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_payments_prospectId_idx" ON "pub_payments"("prospectId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_payments_id_accountId_key" ON "pub_payments"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_payments_productId_paymentRef_key" ON "pub_payments"("productId", "paymentRef");

-- CreateIndex
CREATE UNIQUE INDEX "pub_payments_productId_opKey_key" ON "pub_payments"("productId", "opKey");

-- CreateIndex
CREATE INDEX "pub_sessions_productId_startedAt_idx" ON "pub_sessions"("productId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_sessions_id_accountId_key" ON "pub_sessions"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_sessions_productId_sessionRef_key" ON "pub_sessions"("productId", "sessionRef");

-- CreateIndex
CREATE INDEX "pub_events_productId_occurredAt_idx" ON "pub_events"("productId", "occurredAt");

-- CreateIndex
CREATE INDEX "pub_events_productId_sessionRef_idx" ON "pub_events"("productId", "sessionRef");

-- CreateIndex
CREATE UNIQUE INDEX "pub_events_id_accountId_key" ON "pub_events"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_events_productId_eventId_key" ON "pub_events"("productId", "eventId");

-- CreateIndex
CREATE INDEX "pub_lead_outbox_status_leaseUntil_idx" ON "pub_lead_outbox"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "pub_lead_outbox_id_accountId_key" ON "pub_lead_outbox"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_lead_outbox_leadId_kind_key" ON "pub_lead_outbox"("leadId", "kind");

-- CreateIndex
CREATE INDEX "pub_notifications_status_nextAttemptAt_idx" ON "pub_notifications"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_notifications_id_accountId_key" ON "pub_notifications"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_notifications_leadId_kind_recipientMemberId_key" ON "pub_notifications"("leadId", "kind", "recipientMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_queue_checks_id_accountId_key" ON "pub_queue_checks"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_queue_checks_productId_workDate_checkedBy_key" ON "pub_queue_checks"("productId", "workDate", "checkedBy");

-- CreateIndex
CREATE INDEX "pub_metric_imports_productId_source_periodStart_idx" ON "pub_metric_imports"("productId", "source", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "pub_metric_imports_id_accountId_key" ON "pub_metric_imports"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_experiments_id_accountId_key" ON "pub_experiments"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_experiments_productId_key_version_key" ON "pub_experiments"("productId", "key", "version");

-- CreateIndex
CREATE INDEX "pub_experiment_contents_contentId_idx" ON "pub_experiment_contents"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_experiment_contents_id_accountId_key" ON "pub_experiment_contents"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_experiment_contents_experimentId_contentId_key" ON "pub_experiment_contents"("experimentId", "contentId");

-- CreateIndex
CREATE INDEX "pub_reports_productId_kind_snapshotAt_idx" ON "pub_reports"("productId", "kind", "snapshotAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reports_id_accountId_key" ON "pub_reports"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_backups_productId_createdAt_idx" ON "pub_backups"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "pub_backups_rotationUntil_idx" ON "pub_backups"("rotationUntil");

-- CreateIndex
CREATE UNIQUE INDEX "pub_backups_id_accountId_key" ON "pub_backups"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_restores_productId_idx" ON "pub_restores"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_restores_id_accountId_key" ON "pub_restores"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_configs_id_accountId_key" ON "pub_ai_configs"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_configs_productId_configHash_key" ON "pub_ai_configs"("productId", "configHash");

-- CreateIndex
CREATE INDEX "pub_ai_config_bindings_productId_idx" ON "pub_ai_config_bindings"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_config_bindings_id_accountId_key" ON "pub_ai_config_bindings"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_tasks_id_accountId_key" ON "pub_ai_tasks"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_tasks_productId_generator_objectType_objectId_key" ON "pub_ai_tasks"("productId", "generator", "objectType", "objectId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_budget_months_id_accountId_key" ON "pub_ai_budget_months"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_budget_months_productId_month_key" ON "pub_ai_budget_months"("productId", "month");

-- CreateIndex
CREATE INDEX "pub_ai_calls_status_requestedAt_idx" ON "pub_ai_calls"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_calls_id_accountId_key" ON "pub_ai_calls"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_calls_taskId_attemptNo_key" ON "pub_ai_calls"("taskId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_calls_productId_opKey_key" ON "pub_ai_calls"("productId", "opKey");

-- CreateIndex
CREATE INDEX "pub_ai_eval_runs_configId_idx" ON "pub_ai_eval_runs"("configId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_eval_runs_id_accountId_key" ON "pub_ai_eval_runs"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_ai_eval_results_runId_taskCode_idx" ON "pub_ai_eval_results"("runId", "taskCode");

-- CreateIndex
CREATE UNIQUE INDEX "pub_ai_eval_results_id_accountId_key" ON "pub_ai_eval_results"("id", "accountId");

-- AddForeignKey
ALTER TABLE "pub_products" ADD CONSTRAINT "pub_products_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_products" ADD CONSTRAINT "pub_products_restoredFromBackupId_accountId_fkey" FOREIGN KEY ("restoredFromBackupId", "accountId") REFERENCES "pub_backups"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_parameters" ADD CONSTRAINT "pub_parameters_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_parameter_proposals" ADD CONSTRAINT "pub_parameter_proposals_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_parameter_proposals" ADD CONSTRAINT "pub_parameter_proposals_decisionId_accountId_fkey" FOREIGN KEY ("decisionId", "accountId") REFERENCES "pub_parameter_decisions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_parameter_decisions" ADD CONSTRAINT "pub_parameter_decisions_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_parameter_decisions" ADD CONSTRAINT "pub_parameter_decisions_proposalId_accountId_fkey" FOREIGN KEY ("proposalId", "accountId") REFERENCES "pub_parameter_proposals"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_role_grants" ADD CONSTRAINT "pub_role_grants_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_audit_events" ADD CONSTRAINT "pub_audit_events_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_idempotency_keys" ADD CONSTRAINT "pub_idempotency_keys_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_review_tasks" ADD CONSTRAINT "pub_review_tasks_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_integrations" ADD CONSTRAINT "pub_integrations_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_campaigns" ADD CONSTRAINT "pub_campaigns_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_campaigns" ADD CONSTRAINT "pub_campaigns_experimentId_accountId_fkey" FOREIGN KEY ("experimentId", "accountId") REFERENCES "pub_experiments"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_sources" ADD CONSTRAINT "pub_sources_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_sources" ADD CONSTRAINT "pub_sources_supersedesId_accountId_fkey" FOREIGN KEY ("supersedesId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_source_revocations" ADD CONSTRAINT "pub_source_revocations_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_source_revocations" ADD CONSTRAINT "pub_source_revocations_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_question_groups" ADD CONSTRAINT "pub_question_groups_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_question_groups" ADD CONSTRAINT "pub_question_groups_aiCallId_accountId_fkey" FOREIGN KEY ("aiCallId", "accountId") REFERENCES "pub_ai_calls"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_questions" ADD CONSTRAINT "pub_questions_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_questions" ADD CONSTRAINT "pub_questions_groupId_accountId_fkey" FOREIGN KEY ("groupId", "accountId") REFERENCES "pub_question_groups"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_questions" ADD CONSTRAINT "pub_questions_frequencySourceId_accountId_fkey" FOREIGN KEY ("frequencySourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_question_sources" ADD CONSTRAINT "pub_question_sources_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_question_sources" ADD CONSTRAINT "pub_question_sources_questionId_accountId_fkey" FOREIGN KEY ("questionId", "accountId") REFERENCES "pub_questions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_question_sources" ADD CONSTRAINT "pub_question_sources_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_brand_facts" ADD CONSTRAINT "pub_brand_facts_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_brand_facts" ADD CONSTRAINT "pub_brand_facts_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_brand_facts" ADD CONSTRAINT "pub_brand_facts_conflictWithId_accountId_fkey" FOREIGN KEY ("conflictWithId", "accountId") REFERENCES "pub_brand_facts"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_offer_versions" ADD CONSTRAINT "pub_offer_versions_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_offer_facts" ADD CONSTRAINT "pub_offer_facts_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_offer_facts" ADD CONSTRAINT "pub_offer_facts_offerVersionId_accountId_fkey" FOREIGN KEY ("offerVersionId", "accountId") REFERENCES "pub_offer_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_offer_facts" ADD CONSTRAINT "pub_offer_facts_factId_accountId_fkey" FOREIGN KEY ("factId", "accountId") REFERENCES "pub_brand_facts"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_briefs" ADD CONSTRAINT "pub_briefs_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_briefs" ADD CONSTRAINT "pub_briefs_questionId_accountId_fkey" FOREIGN KEY ("questionId", "accountId") REFERENCES "pub_questions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_briefs" ADD CONSTRAINT "pub_briefs_offerVersionId_accountId_fkey" FOREIGN KEY ("offerVersionId", "accountId") REFERENCES "pub_offer_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_briefs" ADD CONSTRAINT "pub_briefs_aiCallId_accountId_fkey" FOREIGN KEY ("aiCallId", "accountId") REFERENCES "pub_ai_calls"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_brief_sources" ADD CONSTRAINT "pub_brief_sources_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_brief_sources" ADD CONSTRAINT "pub_brief_sources_briefId_accountId_fkey" FOREIGN KEY ("briefId", "accountId") REFERENCES "pub_briefs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_brief_sources" ADD CONSTRAINT "pub_brief_sources_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_contents" ADD CONSTRAINT "pub_contents_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_contents" ADD CONSTRAINT "pub_contents_parentContentId_accountId_fkey" FOREIGN KEY ("parentContentId", "accountId") REFERENCES "pub_contents"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_contents" ADD CONSTRAINT "pub_contents_briefId_accountId_fkey" FOREIGN KEY ("briefId", "accountId") REFERENCES "pub_briefs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_contents" ADD CONSTRAINT "pub_contents_currentVersionId_accountId_fkey" FOREIGN KEY ("currentVersionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_contents" ADD CONSTRAINT "pub_contents_approvedVersionId_accountId_fkey" FOREIGN KEY ("approvedVersionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_contents" ADD CONSTRAINT "pub_contents_publishedVersionId_accountId_fkey" FOREIGN KEY ("publishedVersionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_content_versions" ADD CONSTRAINT "pub_content_versions_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_content_versions" ADD CONSTRAINT "pub_content_versions_contentId_accountId_fkey" FOREIGN KEY ("contentId", "accountId") REFERENCES "pub_contents"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_content_versions" ADD CONSTRAINT "pub_content_versions_parentVersionId_accountId_fkey" FOREIGN KEY ("parentVersionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_content_versions" ADD CONSTRAINT "pub_content_versions_offerVersionId_accountId_fkey" FOREIGN KEY ("offerVersionId", "accountId") REFERENCES "pub_offer_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_content_versions" ADD CONSTRAINT "pub_content_versions_aiCallId_accountId_fkey" FOREIGN KEY ("aiCallId", "accountId") REFERENCES "pub_ai_calls"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_sources" ADD CONSTRAINT "pub_version_sources_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_sources" ADD CONSTRAINT "pub_version_sources_versionId_accountId_fkey" FOREIGN KEY ("versionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_sources" ADD CONSTRAINT "pub_version_sources_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_claims" ADD CONSTRAINT "pub_version_claims_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_claims" ADD CONSTRAINT "pub_version_claims_versionId_accountId_fkey" FOREIGN KEY ("versionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_claims" ADD CONSTRAINT "pub_version_claims_claimId_accountId_fkey" FOREIGN KEY ("claimId", "accountId") REFERENCES "pub_claims"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_facts" ADD CONSTRAINT "pub_version_facts_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_facts" ADD CONSTRAINT "pub_version_facts_versionId_accountId_fkey" FOREIGN KEY ("versionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_version_facts" ADD CONSTRAINT "pub_version_facts_factId_accountId_fkey" FOREIGN KEY ("factId", "accountId") REFERENCES "pub_brand_facts"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claims" ADD CONSTRAINT "pub_claims_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claims" ADD CONSTRAINT "pub_claims_extractedFromVersionId_accountId_fkey" FOREIGN KEY ("extractedFromVersionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claims" ADD CONSTRAINT "pub_claims_experimentId_accountId_fkey" FOREIGN KEY ("experimentId", "accountId") REFERENCES "pub_experiments"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claims" ADD CONSTRAINT "pub_claims_supersedesId_accountId_fkey" FOREIGN KEY ("supersedesId", "accountId") REFERENCES "pub_claims"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claims" ADD CONSTRAINT "pub_claims_aiCallId_accountId_fkey" FOREIGN KEY ("aiCallId", "accountId") REFERENCES "pub_ai_calls"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claim_sources" ADD CONSTRAINT "pub_claim_sources_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claim_sources" ADD CONSTRAINT "pub_claim_sources_claimId_accountId_fkey" FOREIGN KEY ("claimId", "accountId") REFERENCES "pub_claims"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_claim_sources" ADD CONSTRAINT "pub_claim_sources_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_qa_checks" ADD CONSTRAINT "pub_qa_checks_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_qa_checks" ADD CONSTRAINT "pub_qa_checks_versionId_accountId_fkey" FOREIGN KEY ("versionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_qa_checks" ADD CONSTRAINT "pub_qa_checks_aiCallId_accountId_fkey" FOREIGN KEY ("aiCallId", "accountId") REFERENCES "pub_ai_calls"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_approvals" ADD CONSTRAINT "pub_approvals_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_channels" ADD CONSTRAINT "pub_channels_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_distribution_actions" ADD CONSTRAINT "pub_distribution_actions_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_distribution_actions" ADD CONSTRAINT "pub_distribution_actions_versionId_accountId_fkey" FOREIGN KEY ("versionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_distribution_actions" ADD CONSTRAINT "pub_distribution_actions_channelId_accountId_fkey" FOREIGN KEY ("channelId", "accountId") REFERENCES "pub_channels"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_distribution_actions" ADD CONSTRAINT "pub_distribution_actions_publicationId_accountId_fkey" FOREIGN KEY ("publicationId", "accountId") REFERENCES "pub_publications"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_distribution_actions" ADD CONSTRAINT "pub_distribution_actions_aiCallId_accountId_fkey" FOREIGN KEY ("aiCallId", "accountId") REFERENCES "pub_ai_calls"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_publications" ADD CONSTRAINT "pub_publications_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_publications" ADD CONSTRAINT "pub_publications_versionId_accountId_fkey" FOREIGN KEY ("versionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_publications" ADD CONSTRAINT "pub_publications_channelId_accountId_fkey" FOREIGN KEY ("channelId", "accountId") REFERENCES "pub_channels"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_publications" ADD CONSTRAINT "pub_publications_approvalId_accountId_fkey" FOREIGN KEY ("approvalId", "accountId") REFERENCES "pub_approvals"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_venues" ADD CONSTRAINT "pub_venues_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_venue_evidence" ADD CONSTRAINT "pub_venue_evidence_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_venue_evidence" ADD CONSTRAINT "pub_venue_evidence_venueId_accountId_fkey" FOREIGN KEY ("venueId", "accountId") REFERENCES "pub_venues"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_venue_evidence" ADD CONSTRAINT "pub_venue_evidence_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_placements" ADD CONSTRAINT "pub_placements_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_placements" ADD CONSTRAINT "pub_placements_venueId_accountId_fkey" FOREIGN KEY ("venueId", "accountId") REFERENCES "pub_venues"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_placements" ADD CONSTRAINT "pub_placements_versionId_accountId_fkey" FOREIGN KEY ("versionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_placements" ADD CONSTRAINT "pub_placements_campaignId_accountId_fkey" FOREIGN KEY ("campaignId", "accountId") REFERENCES "pub_campaigns"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_placements" ADD CONSTRAINT "pub_placements_approvalId_accountId_fkey" FOREIGN KEY ("approvalId", "accountId") REFERENCES "pub_approvals"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_placements" ADD CONSTRAINT "pub_placements_expenseId_accountId_fkey" FOREIGN KEY ("expenseId", "accountId") REFERENCES "pub_expenses"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_placements" ADD CONSTRAINT "pub_placements_reportDecisionId_accountId_fkey" FOREIGN KEY ("reportDecisionId", "accountId") REFERENCES "pub_reports"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_budget_limits" ADD CONSTRAINT "pub_budget_limits_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reserve_moves" ADD CONSTRAINT "pub_reserve_moves_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reserve_moves" ADD CONSTRAINT "pub_reserve_moves_approvalId_accountId_fkey" FOREIGN KEY ("approvalId", "accountId") REFERENCES "pub_approvals"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_expenses" ADD CONSTRAINT "pub_expenses_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_expenses" ADD CONSTRAINT "pub_expenses_placementId_accountId_fkey" FOREIGN KEY ("placementId", "accountId") REFERENCES "pub_placements"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_expense_entries" ADD CONSTRAINT "pub_expense_entries_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_expense_entries" ADD CONSTRAINT "pub_expense_entries_expenseId_accountId_fkey" FOREIGN KEY ("expenseId", "accountId") REFERENCES "pub_expenses"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_time_entries" ADD CONSTRAINT "pub_time_entries_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_time_entries" ADD CONSTRAINT "pub_time_entries_contentId_accountId_fkey" FOREIGN KEY ("contentId", "accountId") REFERENCES "pub_contents"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_prospects" ADD CONSTRAINT "pub_prospects_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_prospects" ADD CONSTRAINT "pub_prospects_mergedIntoId_accountId_fkey" FOREIGN KEY ("mergedIntoId", "accountId") REFERENCES "pub_prospects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_prospect_links" ADD CONSTRAINT "pub_lead_prospect_links_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_prospect_links" ADD CONSTRAINT "pub_lead_prospect_links_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_prospect_links" ADD CONSTRAINT "pub_lead_prospect_links_prospectId_accountId_fkey" FOREIGN KEY ("prospectId", "accountId") REFERENCES "pub_prospects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_leads" ADD CONSTRAINT "pub_leads_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_leads" ADD CONSTRAINT "pub_leads_prospectId_accountId_fkey" FOREIGN KEY ("prospectId", "accountId") REFERENCES "pub_prospects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_leads" ADD CONSTRAINT "pub_leads_duplicateOfLeadId_accountId_fkey" FOREIGN KEY ("duplicateOfLeadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_leads" ADD CONSTRAINT "pub_leads_campaignId_accountId_fkey" FOREIGN KEY ("campaignId", "accountId") REFERENCES "pub_campaigns"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_leads" ADD CONSTRAINT "pub_leads_contentId_accountId_fkey" FOREIGN KEY ("contentId", "accountId") REFERENCES "pub_contents"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_leads" ADD CONSTRAINT "pub_leads_placementId_accountId_fkey" FOREIGN KEY ("placementId", "accountId") REFERENCES "pub_placements"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_contacts" ADD CONSTRAINT "pub_lead_contacts_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_contacts" ADD CONSTRAINT "pub_lead_contacts_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_decisions" ADD CONSTRAINT "pub_lead_decisions_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_decisions" ADD CONSTRAINT "pub_lead_decisions_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_decisions" ADD CONSTRAINT "pub_lead_decisions_supersedesId_accountId_fkey" FOREIGN KEY ("supersedesId", "accountId") REFERENCES "pub_lead_decisions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_erasures" ADD CONSTRAINT "pub_erasures_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_erasures" ADD CONSTRAINT "pub_erasures_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_payments" ADD CONSTRAINT "pub_payments_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_payments" ADD CONSTRAINT "pub_payments_prospectId_accountId_fkey" FOREIGN KEY ("prospectId", "accountId") REFERENCES "pub_prospects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_payments" ADD CONSTRAINT "pub_payments_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_sessions" ADD CONSTRAINT "pub_sessions_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_sessions" ADD CONSTRAINT "pub_sessions_landingContentId_accountId_fkey" FOREIGN KEY ("landingContentId", "accountId") REFERENCES "pub_contents"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_sessions" ADD CONSTRAINT "pub_sessions_placementId_accountId_fkey" FOREIGN KEY ("placementId", "accountId") REFERENCES "pub_placements"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_events" ADD CONSTRAINT "pub_events_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_events" ADD CONSTRAINT "pub_events_contentId_accountId_fkey" FOREIGN KEY ("contentId", "accountId") REFERENCES "pub_contents"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_events" ADD CONSTRAINT "pub_events_placementId_accountId_fkey" FOREIGN KEY ("placementId", "accountId") REFERENCES "pub_placements"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_events" ADD CONSTRAINT "pub_events_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_outbox" ADD CONSTRAINT "pub_lead_outbox_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_lead_outbox" ADD CONSTRAINT "pub_lead_outbox_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_notifications" ADD CONSTRAINT "pub_notifications_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_notifications" ADD CONSTRAINT "pub_notifications_leadId_accountId_fkey" FOREIGN KEY ("leadId", "accountId") REFERENCES "pub_leads"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_queue_checks" ADD CONSTRAINT "pub_queue_checks_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_metric_imports" ADD CONSTRAINT "pub_metric_imports_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_experiments" ADD CONSTRAINT "pub_experiments_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_experiments" ADD CONSTRAINT "pub_experiments_baselineVersionId_accountId_fkey" FOREIGN KEY ("baselineVersionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_experiments" ADD CONSTRAINT "pub_experiments_newVersionId_accountId_fkey" FOREIGN KEY ("newVersionId", "accountId") REFERENCES "pub_content_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_experiments" ADD CONSTRAINT "pub_experiments_supersedesId_accountId_fkey" FOREIGN KEY ("supersedesId", "accountId") REFERENCES "pub_experiments"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_experiment_contents" ADD CONSTRAINT "pub_experiment_contents_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_experiment_contents" ADD CONSTRAINT "pub_experiment_contents_experimentId_accountId_fkey" FOREIGN KEY ("experimentId", "accountId") REFERENCES "pub_experiments"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_experiment_contents" ADD CONSTRAINT "pub_experiment_contents_contentId_accountId_fkey" FOREIGN KEY ("contentId", "accountId") REFERENCES "pub_contents"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reports" ADD CONSTRAINT "pub_reports_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reports" ADD CONSTRAINT "pub_reports_experimentId_accountId_fkey" FOREIGN KEY ("experimentId", "accountId") REFERENCES "pub_experiments"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reports" ADD CONSTRAINT "pub_reports_supersedesReportId_accountId_fkey" FOREIGN KEY ("supersedesReportId", "accountId") REFERENCES "pub_reports"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_backups" ADD CONSTRAINT "pub_backups_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_restores" ADD CONSTRAINT "pub_restores_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_restores" ADD CONSTRAINT "pub_restores_backupId_accountId_fkey" FOREIGN KEY ("backupId", "accountId") REFERENCES "pub_backups"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_restores" ADD CONSTRAINT "pub_restores_targetProductId_accountId_fkey" FOREIGN KEY ("targetProductId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_configs" ADD CONSTRAINT "pub_ai_configs_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_configs" ADD CONSTRAINT "pub_ai_configs_evalRunId_accountId_fkey" FOREIGN KEY ("evalRunId", "accountId") REFERENCES "pub_ai_eval_runs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_config_bindings" ADD CONSTRAINT "pub_ai_config_bindings_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_config_bindings" ADD CONSTRAINT "pub_ai_config_bindings_configId_accountId_fkey" FOREIGN KEY ("configId", "accountId") REFERENCES "pub_ai_configs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_tasks" ADD CONSTRAINT "pub_ai_tasks_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_tasks" ADD CONSTRAINT "pub_ai_tasks_extraApprovalId_accountId_fkey" FOREIGN KEY ("extraApprovalId", "accountId") REFERENCES "pub_approvals"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_budget_months" ADD CONSTRAINT "pub_ai_budget_months_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_budget_months" ADD CONSTRAINT "pub_ai_budget_months_expenseId_accountId_fkey" FOREIGN KEY ("expenseId", "accountId") REFERENCES "pub_expenses"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_calls" ADD CONSTRAINT "pub_ai_calls_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_calls" ADD CONSTRAINT "pub_ai_calls_taskId_accountId_fkey" FOREIGN KEY ("taskId", "accountId") REFERENCES "pub_ai_tasks"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_calls" ADD CONSTRAINT "pub_ai_calls_configId_accountId_fkey" FOREIGN KEY ("configId", "accountId") REFERENCES "pub_ai_configs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_eval_runs" ADD CONSTRAINT "pub_ai_eval_runs_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_eval_runs" ADD CONSTRAINT "pub_ai_eval_runs_configId_accountId_fkey" FOREIGN KEY ("configId", "accountId") REFERENCES "pub_ai_configs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_eval_results" ADD CONSTRAINT "pub_ai_eval_results_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_eval_results" ADD CONSTRAINT "pub_ai_eval_results_runId_accountId_fkey" FOREIGN KEY ("runId", "accountId") REFERENCES "pub_ai_eval_runs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_ai_eval_results" ADD CONSTRAINT "pub_ai_eval_results_retryOfResultId_accountId_fkey" FOREIGN KEY ("retryOfResultId", "accountId") REFERENCES "pub_ai_eval_results"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ══ «Одна активная строка» — частичные уникальные индексы (Р-PUB-4) ══════
-- Триггер, считающий строки, при двух параллельных активациях в READ
-- COMMITTED пропустил бы обе; уникальный индекс — нет.

-- Две активные одинаковые роли одному участнику (раздел 4.1).
CREATE UNIQUE INDEX "pub_role_grants_active_uq"
    ON "pub_role_grants" ("productId", "memberId", "role")
    WHERE "revokedAt" IS NULL;

-- Не больше одного активного значения ключа факта бренда (AT-F02-02).
CREATE UNIQUE INDEX "pub_brand_facts_active_uq"
    ON "pub_brand_facts" ("productId", "factKey")
    WHERE "status" = 'active';

-- Одна активная версия оффера на продукт.
CREATE UNIQUE INDEX "pub_offer_versions_active_uq"
    ON "pub_offer_versions" ("productId")
    WHERE "status" = 'active';

-- По одному URL одновременно активна одна публикация (аудит P1-1).
CREATE UNIQUE INDEX "pub_publications_active_url_uq"
    ON "pub_publications" ("channelId", "finalUrl", "stage")
    WHERE "status" IN ('pending', 'published');

-- Одна действующая привязка AI-конфигурации у рабочего продукта.
CREATE UNIQUE INDEX "pub_ai_config_bindings_active_uq"
    ON "pub_ai_config_bindings" ("productId")
    WHERE "unboundAt" IS NULL;

-- У снимка отчёта — не больше одного наследника (цепочка пересчётов и
-- решений линейна; вторая линия к advisory-lock `lockChain`, аудит P-E
-- S2-1; Р-PUB-Z2-4).
CREATE UNIQUE INDEX "pub_reports_supersedes_uq"
    ON "pub_reports" ("supersedesReportId")
    WHERE "supersedesReportId" IS NOT NULL;

-- ══ Общие функции-проверки ══════════════════════════════════════════════
--
-- Правило раздела 5.2: в pub_* НЕТ CHECK. Закрытые списки, диапазоны и
-- межколоночные условия держат триггеры с SQLSTATE 23514 (тот же код, что у
-- CHECK, — сервис ловит его так же).
--
-- Правило функций (раунд исправлений аудита, P3-12): триггерные функции и
-- функции, читающие таблицы, — SECURITY DEFINER с `search_path =
-- pg_catalog, pg_temp` и явными именами `"sites".…` (прецедент —
-- `assist_vc_trip`): часть таблиц пишет роль publisher_public, у которой нет
-- прав читать pub_products и прочее, нужное проверкам. Чистые помощники
-- (без таблиц: длины, списки, форматы) — БЕЗ DEFINER и SET: тогда Postgres
-- встраивает SQL-функции в выражение и не переключает search_path на
-- каждом вызове (×5 дешевле на строку). Подмены через search_path у них
-- нет: внутри только встроенные функции и операторы pg_catalog, вызывают
-- их DEFINER-триггеры (search_path = pg_catalog, pg_temp) по имени
-- `"sites".…`. Правило проверяет migrations.spec.ts. EXECUTE у PUBLIC снят
-- у всех функций в конце файла.

-- Нарушение → 23514 с текстом «<таблица>.<правило>: …».
CREATE FUNCTION "pub_chk"(p_ok BOOLEAN, p_msg TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL — тоже нарушение: условие, которое не смогло вычислиться,
  -- не должно молча пропускать строку.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION '%', p_msg USING ERRCODE = '23514';
  END IF;
END;
$$;

-- Необязательное значение: NULL проходит, иначе — длина в [lo, hi].
CREATE FUNCTION "pub_len"(p_v TEXT, p_lo INTEGER, p_hi INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR char_length(p_v) BETWEEN p_lo AND p_hi
$$;

-- Необязательное значение: NULL проходит, иначе — из списка.
CREATE FUNCTION "pub_in"(p_v TEXT, p_list TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR p_v = ANY (p_list)
$$;

-- jsonb не больше p_max байт текста (защита от раздувания, раздел 6.1).
CREATE FUNCTION "pub_jsize"(p_j JSONB, p_max INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_j IS NULL OR octet_length(p_j::text) <= p_max
$$;

CREATE FUNCTION "pub_hex64"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR p_v ~ '^[0-9a-f]{64}$'
$$;

CREATE FUNCTION "pub_uuid"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR p_v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- opKey — UUID v4 в нижнем регистре (раздел 11.1).
CREATE FUNCTION "pub_uuid4"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR p_v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;

CREATE FUNCTION "pub_currency"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR p_v ~ '^[A-Z]{3}$'
$$;

-- https-ссылка без пробелов, не длиннее p_max.
CREATE FUNCTION "pub_https"(p_v TEXT, p_max INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR (char_length(p_v) <= p_max AND p_v ~ '^https://[^[:space:]/?#]+[^[:space:]]*$')
$$;

-- Формат актёра (раздел 4.1): AI актёром не бывает.
CREATE FUNCTION "pub_is_actor"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL
      OR p_v ~ '^(member:[A-Za-z0-9_-]{1,64}|system:[a-z0-9][a-z0-9-]{0,63}|public|restore:[A-Za-z0-9_-]{1,64})$'
$$;

CREATE FUNCTION "pub_is_member"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR p_v ~ '^member:[A-Za-z0-9_-]{1,64}$'
$$;

-- Похоже на контакт (раздел 6.1, 11.4; правка P-A1 по аудиту P2-2/P2-3).
-- ОДНО правило с `core/pii-guard.ts` (PII_RULE): шаблоны вставлены
-- дословно, общая таблица векторов прогоняется в TS и здесь. Шаги: NFKC;
-- `@` или ссылка мессенджера (t.me/, telegram.me/, wa.me/, viber://, tg://,
-- whatsapp://); вырезаются даты, время, суммы с валютой и номера с меткой
-- (ID/No/#); телефон — ≥ 7 цифр с разделителями ` \t\n\r().,/_:–—-`.
CREATE FUNCTION "pub_looks_contact"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NOT NULL AND (
    normalize(p_v, NFKC) ~ '@'
    OR normalize(p_v, NFKC) ~ '(^|[^A-Za-z0-9_])([tT]|[tT][eE][lL][eE][gG][rR][aA][mM]|[wW][aA])[.][mM][eE]/|([vV][iI][bB][eE][rR]|[tT][gG]|[wW][hH][aA][tT][sS][aA][pP][pP])://'
    OR regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(normalize(p_v, NFKC),
        '(?<![0-9])(?<![0-9][-.:/])(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(?![0-9])(?![-.:/][0-9])', ' ', 'g'),
        '(?<![0-9])(?<![0-9][.:/])(0?[1-9]|[12][0-9]|3[01])[.](0?[1-9]|1[0-2])[.]((19|20)[0-9]{2}|[0-9]{2})(?![0-9])(?![.:/][0-9])', ' ', 'g'),
        '(?<![0-9])(?<![0-9][.:/])(0?[1-9]|[12][0-9]|3[01])/(0?[1-9]|1[0-2])/(19|20)[0-9]{2}(?![0-9])(?![.:/][0-9])', ' ', 'g'),
        '(?<![0-9])(?<![0-9][.:/])([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]{1,6})?)?(?![0-9])(?![.:/][0-9])', ' ', 'g'),
        '(?<![0-9])(?<![0-9][.:/])([0-9]{1,3}([ ,.][0-9]{3})+([.,][0-9]{1,2})?|[0-9]+([.,][0-9]{1,2})?)[ ]?([тТ][иИ][сС][.]?[ ]?|[мМ][лЛ][нН][.]?[ ]?)?([гГ][рР][нН]|[кК][оО][пП]|[uU][aA][hH]|[uU][sS][dD]|[eE][uU][rR]|[$€₴])', ' ', 'g'),
        '([$€₴]|[uU][aA][hH]|[uU][sS][dD]|[eE][uU][rR])[ ]?([0-9]{1,3}([ ,.][0-9]{3})+([.,][0-9]{1,2})?|[0-9]+([.,][0-9]{1,2})?)(?![0-9])', ' ', 'g'),
        '(?<![A-Za-z])([iI][dD]|[nN][oO]|#)[ ]?[:=.]?[ ]?[0-9]+', ' ', 'g') ~ '[0-9]([ \t\n\r().,/_:–—-]*[0-9]){6,}')
$$;

-- Все ключи объектов jsonb на любом уровне вложенности.
CREATE FUNCTION "pub_json_keys_deep"(p_j JSONB) RETURNS SETOF TEXT
LANGUAGE sql IMMUTABLE AS $$
  WITH RECURSIVE t(v) AS (
    SELECT p_j
    UNION ALL
    SELECT c.value
      FROM t,
           LATERAL (
             SELECT e.value FROM jsonb_each(CASE WHEN jsonb_typeof(t.v) = 'object' THEN t.v ELSE '{}'::jsonb END) e
             UNION ALL
             SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.v) = 'array' THEN t.v ELSE '[]'::jsonb END) a
           ) c
  )
  SELECT k FROM t, LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(t.v) = 'object' THEN t.v ELSE '{}'::jsonb END) k
$$;

-- Вставка восстановления (раздел 15.4): строки нового продукта kind=restored
-- с createdBy = restore:<id> переносят историю как есть, в порядке FK. Для
-- них при INSERT не проверяются условия «текущего состояния» соседних строк
-- (готовность брифа, активное согласование, связи замороженной версии, вид
-- продукта) — они были проверены, когда история писалась впервые.
-- Аудит P1-2: обход действует, только если <id> — ИДУЩЕЕ восстановление
-- (`pub_restores.status='running'`, `mode='apply_new_product'`) именно в
-- этот продукт, и продукт — `kind='restored'` (всегда closed, в публичных
-- представлениях его нет). Строка «restore:…» без восстановления — обычная
-- вставка со всеми проверками.
CREATE FUNCTION "pub_restoring"(p_op TEXT, p_created_by TEXT, p_product TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_op = 'INSERT' AND p_created_by LIKE 'restore:%' AND EXISTS (
    SELECT 1 FROM "sites"."pub_restores" r
      JOIN "sites"."pub_products" p ON p."id" = r."targetProductId"
     WHERE r."id" = substr(p_created_by, 9) AND r."status" = 'running'
       AND r."mode" = 'apply_new_product' AND p."id" = p_product AND p."kind" = 'restored')
$$;

-- Есть ли среди ключей запрещённые. Аудит P3-11: ключ сравнивается
-- нормализованным (нижний регистр, без `_`, `-`, пробелов: `e-mail`,
-- `contact_enc`, `ContactEnc` — одно и то же), а ещё запрещены ключи с
-- `email`/`phone`/`password`/`secret` внутри, `contact…` (кроме
-- `contactMethod`/`contactDueAt` — это не контакт) и имена человека
-- (`fullName`, `firstName`, …). `memberDisplayName` (снимок имени
-- участника кабинета, §4.1) — не ПД заявителя и не запрещён.
CREATE FUNCTION "pub_json_has_keys"(p_j JSONB, p_keys TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_j IS NOT NULL AND EXISTS (
    SELECT 1
      FROM "sites"."pub_json_keys_deep"(p_j) k,
           LATERAL (SELECT regexp_replace(lower(k), '[^a-z0-9]', '', 'g') AS n) x
     WHERE x.n IN (SELECT regexp_replace(lower(t), '[^a-z0-9]', '', 'g') FROM unnest(p_keys) t)
        OR x.n LIKE '%email%' OR x.n LIKE '%phone%' OR x.n LIKE '%password%' OR x.n LIKE '%secret%'
        OR (x.n LIKE 'contact%' AND x.n NOT IN ('contactmethod', 'contactdueat'))
        OR x.n IN ('fullname', 'firstname', 'lastname', 'middlename', 'surname', 'personname', 'applicantname'))
$$;

-- Закрытые списки, общие для нескольких таблиц (= contracts/states.ts P-A1).
CREATE FUNCTION "pub_parameter_keys"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['niche', 'language', 'market', 'offer_active_version', 'own_channels', 'domain_host',
               'hosting', 'attribution_tool', 'consent_map', 'analytics_storage', 'event_map', 'perf_targets',
               'data_notice_version', 'retention_policy', 'budget_total', 'budget_split', 'per_purchase_max',
               'ai_budget_usd_month', 'ai_fx_rate', 'ai_unpriced_allowed', 'rates_by_role', 'allowed_cpl_inputs',
               'investment_cpl_limit', 'dev_investment', 'cac_payment_window', 'd42_thresholds', 'd90_thresholds',
               'late_cohort_rules', 'qualification_rules', 'responsibles', 'sales_hours_t42_t72', 'contact_sla',
               'form_limit', 'alt_contact', 'test_hosts', 'pilot_calendar', 'launch_evidence_d0',
               'launch_evidence_purchase']
$$;

CREATE FUNCTION "pub_object_types"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['product', 'parameter', 'parameter_proposal', 'parameter_decision', 'role_grant', 'member',
               'review_task', 'integration', 'campaign', 'source', 'question_group', 'question', 'brand_fact',
               'offer_version', 'brief', 'content', 'content_version', 'claim', 'qa_check', 'approval',
               'channel', 'distribution_action', 'publication', 'venue', 'placement', 'budget_limit',
               'reserve_move', 'expense', 'expense_entry', 'time_entry', 'prospect', 'lead', 'lead_contact',
               'lead_decision', 'payment', 'notification', 'queue_check', 'session', 'event', 'metric_import',
               'experiment', 'report', 'backup', 'restore', 'ai_config', 'ai_config_binding', 'ai_task',
               'ai_call', 'ai_budget_month', 'ai_eval_run', 'ai_eval_result']
$$;

CREATE FUNCTION "pub_generators"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['pub.helper.answer', 'pub.brief.draft', 'pub.qa.review', 'pub.adaptation.make',
               'pub.questions.cluster', 'pub.draft.write', 'pub.claims.extract', 'pub.distribution.plan',
               'pub.venues.compare']
$$;

CREATE FUNCTION "pub_lead_statuses"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['new', 'contacted', 'qualified', 'rejected', 'proposal_sent', 'won', 'lost']
$$;

CREATE FUNCTION "pub_channel_groups"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['organic_search', 'unpaid_social_community', 'paid_placement', 'other_referral', 'direct_unknown']
$$;

-- ── Общие триггеры (аргументы — имена колонок) ───────────────────────────

-- Формат актёра во всех колонках `*By`/`actor` (раздел 4.1, 6.9).
CREATE FUNCTION "pub_actor_format"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r JSONB := to_jsonb(NEW);
  c TEXT;
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    PERFORM "sites"."pub_chk"("sites"."pub_is_actor"(r ->> c),
      format('%s.%s: актёр не member:/system:/public/restore:', TG_TABLE_NAME, c));
  END LOOP;
  RETURN NEW;
END;
$$;

-- Неизменяемые колонки (идентичность строки, тенант, продукт; у продукта —
-- ещё сайт, публичный ключ и вид): продукт не переносится между кабинетами
-- и сайтами, строка — между продуктами (раздел 3.1, 6.9).
CREATE FUNCTION "pub_immutable_cols"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n JSONB := to_jsonb(NEW);
  o JSONB := to_jsonb(OLD);
  c TEXT;
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    PERFORM "sites"."pub_chk"((n -> c) IS NOT DISTINCT FROM (o -> c),
      format('%s.%s: колонка неизменяема', TG_TABLE_NAME, c));
  END LOOP;
  RETURN NEW;
END;
$$;

-- Append-only (раздел 6.1): DELETE запрещён, UPDATE — только колонок из
-- аргументов (сверка статуса, поля завершения, оценка человека).
CREATE FUNCTION "pub_append_only"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  allowed TEXT[] := COALESCE(TG_ARGV::text[], ARRAY[]::text[]);
BEGIN
  -- Аудит P3-4: TRUNCATE (триггер FOR EACH STATEMENT) — тоже удаление.
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM "sites"."pub_chk"(false, format('%s: append-only, TRUNCATE запрещён', TG_TABLE_NAME));
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM "sites"."pub_chk"(false, format('%s: append-only, удаление запрещено', TG_TABLE_NAME));
    RETURN OLD;
  END IF;
  PERFORM "sites"."pub_chk"((to_jsonb(NEW) - allowed) IS NOT DISTINCT FROM (to_jsonb(OLD) - allowed),
    format('%s: append-only, разрешено менять только %s', TG_TABLE_NAME, array_to_string(allowed, ', ')));
  RETURN NEW;
END;
$$;

-- Ссылки внутри одного продукта. Составные FK (xId, accountId) держат
-- кабинет; этот триггер — ещё и продукт: источник тестового продукта не
-- привязать к версии рабочего (аргументы — пары «колонка, таблица»).
CREATE FUNCTION "pub_same_product"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r JSONB := to_jsonb(NEW);
  i INTEGER := 0;
  v TEXT;
  ok BOOLEAN;
BEGIN
  WHILE i < TG_NARGS LOOP
    v := r ->> TG_ARGV[i];
    IF v IS NOT NULL AND (TG_OP = 'INSERT' OR v IS DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[i])) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM "sites".%I WHERE "id" = $1 AND "productId" = $2)', TG_ARGV[i + 1])
        INTO ok USING v, NEW."productId";
      PERFORM "sites"."pub_chk"(ok, format('%s.%s: ссылка на строку другого продукта', TG_TABLE_NAME, TG_ARGV[i]));
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ── Общие триггеры по таблицам: актёр, неизменяемые колонки, один продукт ──

CREATE TRIGGER "pub_products_actor" BEFORE INSERT OR UPDATE ON "pub_products"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_products_identity" BEFORE UPDATE ON "pub_products"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'siteId', 'publicKey', 'kind', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_parameters_actor" BEFORE INSERT OR UPDATE ON "pub_parameters"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'approvedBy');
CREATE TRIGGER "pub_parameters_identity" BEFORE UPDATE ON "pub_parameters"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_parameter_proposals_actor" BEFORE INSERT OR UPDATE ON "pub_parameter_proposals"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'proposedBy');
CREATE TRIGGER "pub_parameter_proposals_identity" BEFORE UPDATE ON "pub_parameter_proposals"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_parameter_proposals_same_product" BEFORE INSERT OR UPDATE ON "pub_parameter_proposals"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('decisionId', 'pub_parameter_decisions');

CREATE TRIGGER "pub_parameter_decisions_actor" BEFORE INSERT OR UPDATE ON "pub_parameter_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'decidedBy');
CREATE TRIGGER "pub_parameter_decisions_identity" BEFORE UPDATE ON "pub_parameter_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_parameter_decisions_same_product" BEFORE INSERT OR UPDATE ON "pub_parameter_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('proposalId', 'pub_parameter_proposals');

CREATE TRIGGER "pub_role_grants_actor" BEFORE INSERT OR UPDATE ON "pub_role_grants"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'grantedBy', 'revokedBy');
CREATE TRIGGER "pub_role_grants_identity" BEFORE UPDATE ON "pub_role_grants"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_audit_events_actor" BEFORE INSERT OR UPDATE ON "pub_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'actor');
CREATE TRIGGER "pub_audit_events_identity" BEFORE UPDATE ON "pub_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_idempotency_keys_actor" BEFORE INSERT OR UPDATE ON "pub_idempotency_keys"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_idempotency_keys_identity" BEFORE UPDATE ON "pub_idempotency_keys"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_review_tasks_actor" BEFORE INSERT OR UPDATE ON "pub_review_tasks"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'resolvedBy');
CREATE TRIGGER "pub_review_tasks_identity" BEFORE UPDATE ON "pub_review_tasks"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_integrations_actor" BEFORE INSERT OR UPDATE ON "pub_integrations"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_integrations_identity" BEFORE UPDATE ON "pub_integrations"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_campaigns_actor" BEFORE INSERT OR UPDATE ON "pub_campaigns"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_campaigns_identity" BEFORE UPDATE ON "pub_campaigns"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_campaigns_same_product" BEFORE INSERT OR UPDATE ON "pub_campaigns"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('experimentId', 'pub_experiments');

CREATE TRIGGER "pub_sources_actor" BEFORE INSERT OR UPDATE ON "pub_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'revokedBy');
CREATE TRIGGER "pub_sources_identity" BEFORE UPDATE ON "pub_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_sources_same_product" BEFORE INSERT OR UPDATE ON "pub_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('supersedesId', 'pub_sources');

CREATE TRIGGER "pub_source_revocations_actor" BEFORE INSERT OR UPDATE ON "pub_source_revocations"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'revokedBy');
CREATE TRIGGER "pub_source_revocations_identity" BEFORE UPDATE ON "pub_source_revocations"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_source_revocations_same_product" BEFORE INSERT OR UPDATE ON "pub_source_revocations"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('sourceId', 'pub_sources');

CREATE TRIGGER "pub_question_groups_actor" BEFORE INSERT OR UPDATE ON "pub_question_groups"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_question_groups_identity" BEFORE UPDATE ON "pub_question_groups"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_question_groups_same_product" BEFORE INSERT OR UPDATE ON "pub_question_groups"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('aiCallId', 'pub_ai_calls');

CREATE TRIGGER "pub_questions_actor" BEFORE INSERT OR UPDATE ON "pub_questions"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_questions_identity" BEFORE UPDATE ON "pub_questions"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_questions_same_product" BEFORE INSERT OR UPDATE ON "pub_questions"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('groupId', 'pub_question_groups', 'frequencySourceId', 'pub_sources');

CREATE TRIGGER "pub_question_sources_actor" BEFORE INSERT OR UPDATE ON "pub_question_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_question_sources_identity" BEFORE UPDATE ON "pub_question_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_question_sources_same_product" BEFORE INSERT OR UPDATE ON "pub_question_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('questionId', 'pub_questions', 'sourceId', 'pub_sources');

CREATE TRIGGER "pub_brand_facts_actor" BEFORE INSERT OR UPDATE ON "pub_brand_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'approvedBy');
CREATE TRIGGER "pub_brand_facts_identity" BEFORE UPDATE ON "pub_brand_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_brand_facts_same_product" BEFORE INSERT OR UPDATE ON "pub_brand_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('sourceId', 'pub_sources', 'conflictWithId', 'pub_brand_facts');

CREATE TRIGGER "pub_offer_versions_actor" BEFORE INSERT OR UPDATE ON "pub_offer_versions"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'approvedBy');
CREATE TRIGGER "pub_offer_versions_identity" BEFORE UPDATE ON "pub_offer_versions"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_offer_facts_actor" BEFORE INSERT OR UPDATE ON "pub_offer_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_offer_facts_identity" BEFORE UPDATE ON "pub_offer_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_offer_facts_same_product" BEFORE INSERT OR UPDATE ON "pub_offer_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('offerVersionId', 'pub_offer_versions', 'factId', 'pub_brand_facts');

CREATE TRIGGER "pub_briefs_actor" BEFORE INSERT OR UPDATE ON "pub_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_briefs_identity" BEFORE UPDATE ON "pub_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_briefs_same_product" BEFORE INSERT OR UPDATE ON "pub_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('questionId', 'pub_questions', 'offerVersionId', 'pub_offer_versions', 'aiCallId', 'pub_ai_calls');

CREATE TRIGGER "pub_brief_sources_actor" BEFORE INSERT OR UPDATE ON "pub_brief_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_brief_sources_identity" BEFORE UPDATE ON "pub_brief_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_brief_sources_same_product" BEFORE INSERT OR UPDATE ON "pub_brief_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('briefId', 'pub_briefs', 'sourceId', 'pub_sources');

CREATE TRIGGER "pub_contents_actor" BEFORE INSERT OR UPDATE ON "pub_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_contents_identity" BEFORE UPDATE ON "pub_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_contents_same_product" BEFORE INSERT OR UPDATE ON "pub_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('parentContentId', 'pub_contents', 'briefId', 'pub_briefs', 'currentVersionId', 'pub_content_versions', 'approvedVersionId', 'pub_content_versions', 'publishedVersionId', 'pub_content_versions');

CREATE TRIGGER "pub_content_versions_actor" BEFORE INSERT OR UPDATE ON "pub_content_versions"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_content_versions_identity" BEFORE UPDATE ON "pub_content_versions"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_content_versions_same_product" BEFORE INSERT OR UPDATE ON "pub_content_versions"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('contentId', 'pub_contents', 'parentVersionId', 'pub_content_versions', 'offerVersionId', 'pub_offer_versions', 'aiCallId', 'pub_ai_calls');

CREATE TRIGGER "pub_version_sources_actor" BEFORE INSERT OR UPDATE ON "pub_version_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_version_sources_identity" BEFORE UPDATE ON "pub_version_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_version_sources_same_product" BEFORE INSERT OR UPDATE ON "pub_version_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('versionId', 'pub_content_versions', 'sourceId', 'pub_sources');

CREATE TRIGGER "pub_version_claims_actor" BEFORE INSERT OR UPDATE ON "pub_version_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_version_claims_identity" BEFORE UPDATE ON "pub_version_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_version_claims_same_product" BEFORE INSERT OR UPDATE ON "pub_version_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('versionId', 'pub_content_versions', 'claimId', 'pub_claims');

CREATE TRIGGER "pub_version_facts_actor" BEFORE INSERT OR UPDATE ON "pub_version_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_version_facts_identity" BEFORE UPDATE ON "pub_version_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_version_facts_same_product" BEFORE INSERT OR UPDATE ON "pub_version_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('versionId', 'pub_content_versions', 'factId', 'pub_brand_facts');

CREATE TRIGGER "pub_claims_actor" BEFORE INSERT OR UPDATE ON "pub_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'verifiedBy');
CREATE TRIGGER "pub_claims_identity" BEFORE UPDATE ON "pub_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_claims_same_product" BEFORE INSERT OR UPDATE ON "pub_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('extractedFromVersionId', 'pub_content_versions', 'experimentId', 'pub_experiments', 'supersedesId', 'pub_claims', 'aiCallId', 'pub_ai_calls');

CREATE TRIGGER "pub_claim_sources_actor" BEFORE INSERT OR UPDATE ON "pub_claim_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'checkedBy');
CREATE TRIGGER "pub_claim_sources_identity" BEFORE UPDATE ON "pub_claim_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_claim_sources_same_product" BEFORE INSERT OR UPDATE ON "pub_claim_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('claimId', 'pub_claims', 'sourceId', 'pub_sources');

CREATE TRIGGER "pub_qa_checks_actor" BEFORE INSERT OR UPDATE ON "pub_qa_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'checkedBy');
CREATE TRIGGER "pub_qa_checks_identity" BEFORE UPDATE ON "pub_qa_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_qa_checks_same_product" BEFORE INSERT OR UPDATE ON "pub_qa_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('versionId', 'pub_content_versions', 'aiCallId', 'pub_ai_calls');

CREATE TRIGGER "pub_approvals_actor" BEFORE INSERT OR UPDATE ON "pub_approvals"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_approvals_identity" BEFORE UPDATE ON "pub_approvals"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_channels_actor" BEFORE INSERT OR UPDATE ON "pub_channels"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_channels_identity" BEFORE UPDATE ON "pub_channels"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_distribution_actions_actor" BEFORE INSERT OR UPDATE ON "pub_distribution_actions"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_distribution_actions_identity" BEFORE UPDATE ON "pub_distribution_actions"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_distribution_actions_same_product" BEFORE INSERT OR UPDATE ON "pub_distribution_actions"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('versionId', 'pub_content_versions', 'channelId', 'pub_channels', 'publicationId', 'pub_publications', 'aiCallId', 'pub_ai_calls');

CREATE TRIGGER "pub_publications_actor" BEFORE INSERT OR UPDATE ON "pub_publications"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'verifiedBy');
CREATE TRIGGER "pub_publications_identity" BEFORE UPDATE ON "pub_publications"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_publications_same_product" BEFORE INSERT OR UPDATE ON "pub_publications"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('versionId', 'pub_content_versions', 'channelId', 'pub_channels', 'approvalId', 'pub_approvals');

CREATE TRIGGER "pub_venues_actor" BEFORE INSERT OR UPDATE ON "pub_venues"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_venues_identity" BEFORE UPDATE ON "pub_venues"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_venue_evidence_actor" BEFORE INSERT OR UPDATE ON "pub_venue_evidence"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_venue_evidence_identity" BEFORE UPDATE ON "pub_venue_evidence"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_venue_evidence_same_product" BEFORE INSERT OR UPDATE ON "pub_venue_evidence"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('venueId', 'pub_venues', 'sourceId', 'pub_sources');

CREATE TRIGGER "pub_placements_actor" BEFORE INSERT OR UPDATE ON "pub_placements"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_placements_identity" BEFORE UPDATE ON "pub_placements"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_placements_same_product" BEFORE INSERT OR UPDATE ON "pub_placements"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('venueId', 'pub_venues', 'versionId', 'pub_content_versions', 'campaignId', 'pub_campaigns', 'approvalId', 'pub_approvals', 'expenseId', 'pub_expenses', 'reportDecisionId', 'pub_reports');

CREATE TRIGGER "pub_budget_limits_actor" BEFORE INSERT OR UPDATE ON "pub_budget_limits"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_budget_limits_identity" BEFORE UPDATE ON "pub_budget_limits"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_reserve_moves_actor" BEFORE INSERT OR UPDATE ON "pub_reserve_moves"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_reserve_moves_identity" BEFORE UPDATE ON "pub_reserve_moves"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_reserve_moves_same_product" BEFORE INSERT OR UPDATE ON "pub_reserve_moves"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('approvalId', 'pub_approvals');

CREATE TRIGGER "pub_expenses_actor" BEFORE INSERT OR UPDATE ON "pub_expenses"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_expenses_identity" BEFORE UPDATE ON "pub_expenses"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_expenses_same_product" BEFORE INSERT OR UPDATE ON "pub_expenses"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('placementId', 'pub_placements');

CREATE TRIGGER "pub_expense_entries_actor" BEFORE INSERT OR UPDATE ON "pub_expense_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'confirmedBy');
CREATE TRIGGER "pub_expense_entries_identity" BEFORE UPDATE ON "pub_expense_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_expense_entries_same_product" BEFORE INSERT OR UPDATE ON "pub_expense_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('expenseId', 'pub_expenses');

CREATE TRIGGER "pub_time_entries_actor" BEFORE INSERT OR UPDATE ON "pub_time_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_time_entries_identity" BEFORE UPDATE ON "pub_time_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_time_entries_same_product" BEFORE INSERT OR UPDATE ON "pub_time_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('contentId', 'pub_contents');

CREATE TRIGGER "pub_prospects_actor" BEFORE INSERT OR UPDATE ON "pub_prospects"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_prospects_identity" BEFORE UPDATE ON "pub_prospects"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_prospects_same_product" BEFORE INSERT OR UPDATE ON "pub_prospects"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('mergedIntoId', 'pub_prospects');

CREATE TRIGGER "pub_lead_prospect_links_actor" BEFORE INSERT OR UPDATE ON "pub_lead_prospect_links"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'decidedBy');
CREATE TRIGGER "pub_lead_prospect_links_identity" BEFORE UPDATE ON "pub_lead_prospect_links"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_lead_prospect_links_same_product" BEFORE INSERT OR UPDATE ON "pub_lead_prospect_links"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('leadId', 'pub_leads', 'prospectId', 'pub_prospects');

CREATE TRIGGER "pub_leads_actor" BEFORE INSERT OR UPDATE ON "pub_leads"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_leads_identity" BEFORE UPDATE ON "pub_leads"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_leads_same_product" BEFORE INSERT OR UPDATE ON "pub_leads"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('prospectId', 'pub_prospects', 'duplicateOfLeadId', 'pub_leads', 'campaignId', 'pub_campaigns', 'contentId', 'pub_contents', 'placementId', 'pub_placements');

CREATE TRIGGER "pub_lead_contacts_actor" BEFORE INSERT OR UPDATE ON "pub_lead_contacts"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_lead_contacts_identity" BEFORE UPDATE ON "pub_lead_contacts"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_lead_contacts_same_product" BEFORE INSERT OR UPDATE ON "pub_lead_contacts"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('leadId', 'pub_leads');

CREATE TRIGGER "pub_lead_decisions_actor" BEFORE INSERT OR UPDATE ON "pub_lead_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'decidedBy');
CREATE TRIGGER "pub_lead_decisions_identity" BEFORE UPDATE ON "pub_lead_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_lead_decisions_same_product" BEFORE INSERT OR UPDATE ON "pub_lead_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('leadId', 'pub_leads', 'supersedesId', 'pub_lead_decisions');

CREATE TRIGGER "pub_erasures_actor" BEFORE INSERT OR UPDATE ON "pub_erasures"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'erasedBy');
CREATE TRIGGER "pub_erasures_identity" BEFORE UPDATE ON "pub_erasures"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_erasures_same_product" BEFORE INSERT OR UPDATE ON "pub_erasures"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('leadId', 'pub_leads');

CREATE TRIGGER "pub_payments_actor" BEFORE INSERT OR UPDATE ON "pub_payments"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'confirmedBy');
CREATE TRIGGER "pub_payments_identity" BEFORE UPDATE ON "pub_payments"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_payments_same_product" BEFORE INSERT OR UPDATE ON "pub_payments"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('prospectId', 'pub_prospects', 'leadId', 'pub_leads');

CREATE TRIGGER "pub_sessions_actor" BEFORE INSERT OR UPDATE ON "pub_sessions"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_sessions_identity" BEFORE UPDATE ON "pub_sessions"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_sessions_same_product" BEFORE INSERT OR UPDATE ON "pub_sessions"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('landingContentId', 'pub_contents', 'placementId', 'pub_placements');

CREATE TRIGGER "pub_events_actor" BEFORE INSERT OR UPDATE ON "pub_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_events_identity" BEFORE UPDATE ON "pub_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_events_same_product" BEFORE INSERT OR UPDATE ON "pub_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('contentId', 'pub_contents', 'placementId', 'pub_placements', 'leadId', 'pub_leads');

CREATE TRIGGER "pub_lead_outbox_actor" BEFORE INSERT OR UPDATE ON "pub_lead_outbox"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_lead_outbox_identity" BEFORE UPDATE ON "pub_lead_outbox"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_lead_outbox_same_product" BEFORE INSERT OR UPDATE ON "pub_lead_outbox"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('leadId', 'pub_leads');

CREATE TRIGGER "pub_notifications_actor" BEFORE INSERT OR UPDATE ON "pub_notifications"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_notifications_identity" BEFORE UPDATE ON "pub_notifications"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_notifications_same_product" BEFORE INSERT OR UPDATE ON "pub_notifications"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('leadId', 'pub_leads');

CREATE TRIGGER "pub_queue_checks_actor" BEFORE INSERT OR UPDATE ON "pub_queue_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'checkedBy');
CREATE TRIGGER "pub_queue_checks_identity" BEFORE UPDATE ON "pub_queue_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_metric_imports_actor" BEFORE INSERT OR UPDATE ON "pub_metric_imports"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'importedBy');
CREATE TRIGGER "pub_metric_imports_identity" BEFORE UPDATE ON "pub_metric_imports"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_experiments_actor" BEFORE INSERT OR UPDATE ON "pub_experiments"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'decidedBy');
CREATE TRIGGER "pub_experiments_identity" BEFORE UPDATE ON "pub_experiments"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_experiments_same_product" BEFORE INSERT OR UPDATE ON "pub_experiments"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('baselineVersionId', 'pub_content_versions', 'newVersionId', 'pub_content_versions', 'supersedesId', 'pub_experiments');

CREATE TRIGGER "pub_experiment_contents_actor" BEFORE INSERT OR UPDATE ON "pub_experiment_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_experiment_contents_identity" BEFORE UPDATE ON "pub_experiment_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_experiment_contents_same_product" BEFORE INSERT OR UPDATE ON "pub_experiment_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('experimentId', 'pub_experiments', 'contentId', 'pub_contents');

CREATE TRIGGER "pub_reports_actor" BEFORE INSERT OR UPDATE ON "pub_reports"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_reports_identity" BEFORE UPDATE ON "pub_reports"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_reports_same_product" BEFORE INSERT OR UPDATE ON "pub_reports"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('experimentId', 'pub_experiments', 'supersedesReportId', 'pub_reports');

CREATE TRIGGER "pub_backups_actor" BEFORE INSERT OR UPDATE ON "pub_backups"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_backups_identity" BEFORE UPDATE ON "pub_backups"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_restores_actor" BEFORE INSERT OR UPDATE ON "pub_restores"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'startedBy');
CREATE TRIGGER "pub_restores_identity" BEFORE UPDATE ON "pub_restores"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_restores_same_product" BEFORE INSERT OR UPDATE ON "pub_restores"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('backupId', 'pub_backups');

CREATE TRIGGER "pub_ai_configs_actor" BEFORE INSERT OR UPDATE ON "pub_ai_configs"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'decidedBy');
CREATE TRIGGER "pub_ai_configs_identity" BEFORE UPDATE ON "pub_ai_configs"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_ai_configs_same_product" BEFORE INSERT OR UPDATE ON "pub_ai_configs"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('evalRunId', 'pub_ai_eval_runs');

CREATE TRIGGER "pub_ai_config_bindings_actor" BEFORE INSERT OR UPDATE ON "pub_ai_config_bindings"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'boundBy', 'unboundBy');
CREATE TRIGGER "pub_ai_config_bindings_identity" BEFORE UPDATE ON "pub_ai_config_bindings"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_ai_tasks_actor" BEFORE INSERT OR UPDATE ON "pub_ai_tasks"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_ai_tasks_identity" BEFORE UPDATE ON "pub_ai_tasks"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_ai_tasks_same_product" BEFORE INSERT OR UPDATE ON "pub_ai_tasks"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('extraApprovalId', 'pub_approvals');

CREATE TRIGGER "pub_ai_budget_months_actor" BEFORE INSERT OR UPDATE ON "pub_ai_budget_months"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_ai_budget_months_identity" BEFORE UPDATE ON "pub_ai_budget_months"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_ai_budget_months_same_product" BEFORE INSERT OR UPDATE ON "pub_ai_budget_months"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('expenseId', 'pub_expenses');

CREATE TRIGGER "pub_ai_calls_actor" BEFORE INSERT OR UPDATE ON "pub_ai_calls"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'requestedBy');
CREATE TRIGGER "pub_ai_calls_identity" BEFORE UPDATE ON "pub_ai_calls"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_ai_calls_same_product" BEFORE INSERT OR UPDATE ON "pub_ai_calls"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('taskId', 'pub_ai_tasks');

CREATE TRIGGER "pub_ai_eval_runs_actor" BEFORE INSERT OR UPDATE ON "pub_ai_eval_runs"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_ai_eval_runs_identity" BEFORE UPDATE ON "pub_ai_eval_runs"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_ai_eval_runs_same_product" BEFORE INSERT OR UPDATE ON "pub_ai_eval_runs"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('configId', 'pub_ai_configs');

CREATE TRIGGER "pub_ai_eval_results_actor" BEFORE INSERT OR UPDATE ON "pub_ai_eval_results"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_ai_eval_results_identity" BEFORE UPDATE ON "pub_ai_eval_results"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_ai_eval_results_same_product" BEFORE INSERT OR UPDATE ON "pub_ai_eval_results"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('runId', 'pub_ai_eval_runs', 'retryOfResultId', 'pub_ai_eval_results');

-- ══ Гварды таблиц: ядро (6.2) ═════════════════════════════════════════════

CREATE FUNCTION "pub_products_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['working', 'test', 'eval', 'restored']), 'pub_products.kind: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."name") BETWEEN 1 AND 120, 'pub_products.name: длина 1..120');
  PERFORM "sites"."pub_chk"(NEW."publicKey" ~ '^pp_[A-Za-z0-9]{24}$', 'pub_products.publicKey: формат pp_ + 24 base62');
  PERFORM "sites"."pub_chk"(NEW."mode" = ANY (ARRAY['closed', 'test', 'live']), 'pub_products.mode: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['active', 'archived']), 'pub_products.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."mode" <> 'live' OR NEW."kind" = 'working', 'pub_products.mode: live только у kind=working');
  PERFORM "sites"."pub_chk"(NEW."mode" <> 'live' OR NEW."liveSince" IS NOT NULL, 'pub_products.liveSince: обязателен при mode=live');
  PERFORM "sites"."pub_chk"(NEW."kind" <> 'restored' OR NEW."mode" = 'closed', 'pub_products.mode: восстановленный продукт всегда closed');
  PERFORM "sites"."pub_chk"((NEW."restoredFromBackupId" IS NOT NULL) = (NEW."kind" = 'restored'),
    'pub_products.restoredFromBackupId: обязателен ⇔ kind=restored');
  PERFORM "sites"."pub_chk"(NEW."revision" >= 1, 'pub_products.revision: ≥ 1');
  -- Машина режима (раздел 3.2): closed ↔ test, closed|test → live, live → closed.
  IF TG_OP = 'UPDATE' AND NEW."mode" IS DISTINCT FROM OLD."mode" THEN
    PERFORM "sites"."pub_chk"((OLD."mode", NEW."mode") IN
        (('closed', 'test'), ('test', 'closed'), ('closed', 'live'), ('test', 'live'), ('live', 'closed')),
      'pub_products.mode: переход вне машины режима');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_products_guard" BEFORE INSERT OR UPDATE ON "pub_products"
  FOR EACH ROW EXECUTE FUNCTION "pub_products_guard"();

CREATE FUNCTION "pub_parameters_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."key" = ANY ("sites"."pub_parameter_keys"()), 'pub_parameters.key: вне PARAMETER_KEYS');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['assumption', 'approved', 'rejected', 'revoked']), 'pub_parameters.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_parameters.version: ≥ 1');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."value", 65536), 'pub_parameters.value: больше 64 КБ');
  PERFORM "sites"."pub_chk"((NEW."status" = 'approved') = (NEW."approvedAt" IS NOT NULL AND NEW."approvedBy" IS NOT NULL),
    'pub_parameters.approvedAt/approvedBy: заполнены ⇔ status=approved');
  PERFORM "sites"."pub_chk"("sites"."pub_is_member"(NEW."approvedBy"), 'pub_parameters.approvedBy: утверждает человек (member:)');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."key" = OLD."key", 'pub_parameters.key: неизменяем');
    PERFORM "sites"."pub_chk"(NEW."version" >= OLD."version", 'pub_parameters.version: не уменьшается');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_parameters_guard" BEFORE INSERT OR UPDATE ON "pub_parameters"
  FOR EACH ROW EXECUTE FUNCTION "pub_parameters_guard"();

-- Изменение параметра — только вместе с решением той же версии (раздел 6.2):
-- AFTER-триггер ищет строку pub_parameter_decisions той же версии, статуса и
-- значения. Порядок в транзакции — СНАЧАЛА решение, потом параметр.
-- Не CONSTRAINT TRIGGER (DEFERRABLE): он создаёт строку pg_constraint
-- contype='t', на которой wasm-движок схем migrate diff падает так же, как
-- на CHECK (проверено пакетом P-A0).
-- Аудит P2-1: журнал не обойти удалением и повторной вставкой. Голова
-- параметра не удаляется (триггер ниже); вставка без решений по ключу —
-- только посев (`assumption`, версия 1); если решения по ключу уже есть,
-- вставка обязана совпасть с ПОСЛЕДНИМ решением (версия = максимум,
-- статус и значение — его). Изменение — решение `fromStatus` = прежний
-- статус.
CREATE FUNCTION "pub_parameters_decision_required"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  changed BOOLEAN;
  last_version INTEGER;
BEGIN
  SELECT max(d."version") INTO last_version FROM "sites"."pub_parameter_decisions" d
   WHERE d."productId" = NEW."productId" AND d."parameterKey" = NEW."key";
  IF TG_OP = 'INSERT' THEN
    IF last_version IS NULL THEN
      PERFORM "sites"."pub_chk"(NEW."status" = 'assumption' AND NEW."version" = 1,
        'pub_parameters: без решений по ключу вставляется только посев (assumption, версия 1)');
      RETURN NULL;
    END IF;
    PERFORM "sites"."pub_chk"(NEW."version" = last_version,
      'pub_parameters: вставка обязана совпасть с последним решением по ключу');
    changed := true;
  ELSE
    changed := (NEW."value", NEW."status", NEW."version") IS DISTINCT FROM (OLD."value", OLD."status", OLD."version");
    IF changed THEN
      PERFORM "sites"."pub_chk"(NEW."version" > OLD."version", 'pub_parameters.version: растёт при каждом решении');
    END IF;
  END IF;
  IF changed THEN
    PERFORM "sites"."pub_chk"(EXISTS (
        SELECT 1 FROM "sites"."pub_parameter_decisions" d
         WHERE d."productId" = NEW."productId" AND d."accountId" = NEW."accountId"
           AND d."parameterKey" = NEW."key" AND d."version" = NEW."version"
           AND d."toStatus" = NEW."status" AND d."valueSnapshot" = NEW."value"
           AND (TG_OP = 'INSERT' OR d."fromStatus" = OLD."status")),
      'pub_parameters: изменение без решения той же версии (pub_parameter_decisions)');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "pub_parameters_decision_required" AFTER INSERT OR UPDATE ON "pub_parameters"
  FOR EACH ROW EXECUTE FUNCTION "pub_parameters_decision_required"();

-- Голова параметра не удаляется (отзыв — статус revoked решением).
CREATE FUNCTION "pub_no_delete"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(false, format('%s: удаление запрещено', TG_TABLE_NAME));
  RETURN NULL;
END;
$$;
CREATE TRIGGER "pub_parameters_no_delete" BEFORE DELETE ON "pub_parameters"
  FOR EACH ROW EXECUTE FUNCTION "pub_no_delete"();

CREATE FUNCTION "pub_parameter_proposals_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."parameterKey" = ANY ("sites"."pub_parameter_keys"()), 'pub_parameter_proposals.parameterKey: вне PARAMETER_KEYS');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['open', 'accepted', 'rejected', 'withdrawn']), 'pub_parameter_proposals.status: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."value", 65536), 'pub_parameter_proposals.value: больше 64 КБ');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'accepted' OR NEW."decisionId" IS NOT NULL, 'pub_parameter_proposals.decisionId: обязателен при accepted');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."parameterKey" = OLD."parameterKey" AND NEW."value" = OLD."value",
      'pub_parameter_proposals: ключ и значение предложения неизменны');
    PERFORM "sites"."pub_chk"(OLD."status" = 'open' OR NEW."status" = OLD."status", 'pub_parameter_proposals.status: меняется только из open');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_parameter_proposals_guard" BEFORE INSERT OR UPDATE ON "pub_parameter_proposals"
  FOR EACH ROW EXECUTE FUNCTION "pub_parameter_proposals_guard"();

CREATE FUNCTION "pub_parameter_decisions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."parameterKey" = ANY ("sites"."pub_parameter_keys"()), 'pub_parameter_decisions.parameterKey: вне PARAMETER_KEYS');
  PERFORM "sites"."pub_chk"(NEW."fromStatus" = ANY (ARRAY['assumption', 'approved', 'rejected', 'revoked'])
                       AND NEW."toStatus" = ANY (ARRAY['assumption', 'approved', 'rejected', 'revoked']), 'pub_parameter_decisions.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_parameter_decisions.version: ≥ 1');
  PERFORM "sites"."pub_chk"(NEW."decidedBy" ~ '^member:', 'pub_parameter_decisions.decidedBy: решает человек (member:)');
  PERFORM "sites"."pub_chk"(char_length(NEW."basis") <= 2000
      AND (NEW."toStatus" NOT IN ('approved', 'rejected', 'revoked') OR char_length(btrim(NEW."basis")) >= 10),
    'pub_parameter_decisions.basis: ≥ 10 символов при approved/rejected/revoked, ≤ 2000');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."valueSnapshot", 65536), 'pub_parameter_decisions.valueSnapshot: больше 64 КБ');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."dependentStages") = 'array' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."dependentStages") e
       WHERE jsonb_typeof(e) <> 'string'
          OR (e #>> '{}') <> ALL (ARRAY['public_publish', 'real_leads', 'spend', 'purchases', 'ai_use', 'reports'])),
    'pub_parameter_decisions.dependentStages: массив из public_publish|real_leads|spend|purchases|ai_use|reports');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_parameter_decisions_guard" BEFORE INSERT OR UPDATE ON "pub_parameter_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_parameter_decisions_guard"();
CREATE TRIGGER "pub_parameter_decisions_ao" BEFORE UPDATE OR DELETE ON "pub_parameter_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

CREATE FUNCTION "pub_role_grants_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."role" = ANY (ARRAY['product_owner', 'editor', 'operator', 'analyst', 'sales', 'viewer']),
    'pub_role_grants.role: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."memberId") BETWEEN 1 AND 64, 'pub_role_grants.memberId: длина 1..64');
  PERFORM "sites"."pub_chk"(char_length(NEW."memberDisplayName") <= 200, 'pub_role_grants.memberDisplayName: ≤ 200');
  PERFORM "sites"."pub_chk"((NEW."revokedAt" IS NULL) = (NEW."revokedBy" IS NULL), 'pub_role_grants.revoked*: вместе');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."reason", 1, 2000), 'pub_role_grants.reason: длина 1..2000');
  IF TG_OP = 'UPDATE' THEN
    -- Отзыв — однократное заполнение revoked* (раздел 4.1); снятый грант не оживает.
    PERFORM "sites"."pub_chk"(OLD."revokedAt" IS NULL, 'pub_role_grants: отозванный грант неизменен');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_role_grants_guard" BEFORE INSERT OR UPDATE ON "pub_role_grants"
  FOR EACH ROW EXECUTE FUNCTION "pub_role_grants_guard"();
CREATE TRIGGER "pub_role_grants_ao" BEFORE UPDATE OR DELETE ON "pub_role_grants"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('revokedBy', 'revokedAt', 'reason');

CREATE FUNCTION "pub_audit_events_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."objectType" = ANY ("sites"."pub_object_types"()), 'pub_audit_events.objectType: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."objectId") BETWEEN 1 AND 100, 'pub_audit_events.objectId: длина 1..100');
  PERFORM "sites"."pub_chk"(NEW."action" = ANY (ARRAY['create', 'update', 'transition', 'approve', 'reject', 'revoke', 'grant',
      'reveal_contact', 'export', 'erase', 'restore', 'backup', 'import', 'merge', 'split', 'assign', 'bind', 'unbind',
      'resolve', 'dismiss', 'retry', 'reset']), 'pub_audit_events.action: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."fromStatus", 1, 64) AND "sites"."pub_len"(NEW."toStatus", 1, 64),
    'pub_audit_events.fromStatus/toStatus: длина ≤ 64');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."reason", 1, 2000), 'pub_audit_events.reason: длина 1..2000');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_audit_events_guard" BEFORE INSERT OR UPDATE ON "pub_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_audit_events_guard"();
CREATE TRIGGER "pub_audit_events_ao" BEFORE UPDATE OR DELETE ON "pub_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

-- Ключи ПД в meta журнала аудита — на любом уровне (раздел 6.2).
CREATE FUNCTION "pub_audit_meta_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."meta", 8192), 'pub_audit_events.meta: больше 8 КБ');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_json_has_keys"(NEW."meta",
      ARRAY['contact', 'email', 'phone', 'name', 'task', 'fieldsEnc', 'contactEnc', 'noteEnc', 'token', 'secret']),
    'pub_audit_events.meta: ключи персональных данных и секретов запрещены');
  -- Аудит P3-11: email и в значениях meta (идентификаторы «@» не содержат).
  PERFORM "sites"."pub_chk"(NEW."meta" IS NULL OR NOT jsonb_path_exists(NEW."meta",
      '$.** ? (@.type() == "string" && @ like_regex "[^[:space:]@]+@[^[:space:]@]+[.][A-Za-z]")'),
    'pub_audit_events.meta: email в значениях запрещён');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_audit_meta_guard" BEFORE INSERT OR UPDATE ON "pub_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_audit_meta_guard"();

-- Ответ идемпотентного ключа без ПД (аудит P1-3).
CREATE FUNCTION "pub_idempotency_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"("sites"."pub_uuid4"(NEW."opKey"), 'pub_idempotency_keys.opKey: UUID v4');
  PERFORM "sites"."pub_chk"(char_length(NEW."scope") BETWEEN 1 AND 100, 'pub_idempotency_keys.scope: длина 1..100');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."requestHash"), 'pub_idempotency_keys.requestHash: sha256 hex');
  PERFORM "sites"."pub_chk"(NEW."responseStatus" IS NULL OR NEW."responseStatus" BETWEEN 100 AND 599,
    'pub_idempotency_keys.responseStatus: 100..599');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."responseBody", 65536), 'pub_idempotency_keys.responseBody: больше 64 КБ');
  -- Р-PUB-Z2-5 (запрос P-C S2-3): + `displayName` (имя участника).
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_json_has_keys"(NEW."responseBody",
      ARRAY['contact', 'name', 'task', 'fieldsEnc', 'contactEnc', 'noteEnc', 'displayName']),
    'pub_idempotency_keys.responseBody: ключи персональных данных запрещены');
  PERFORM "sites"."pub_chk"(NEW."expiresAt" > NEW."createdAt", 'pub_idempotency_keys.expiresAt: позже createdAt');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."opKey" = OLD."opKey" AND NEW."scope" = OLD."scope" AND NEW."requestHash" = OLD."requestHash",
      'pub_idempotency_keys: opKey, scope и requestHash неизменны');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_idempotency_guard" BEFORE INSERT OR UPDATE ON "pub_idempotency_keys"
  FOR EACH ROW EXECUTE FUNCTION "pub_idempotency_guard"();

CREATE FUNCTION "pub_review_tasks_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."objectType" = ANY ("sites"."pub_object_types"()), 'pub_review_tasks.objectType: вне списка');
  PERFORM "sites"."pub_chk"(NEW."reason" = ANY (ARRAY['offer_changed', 'fact_changed', 'source_revoked', 'claim_changed',
      'fact_conflict', 'stale_check', 'retention_review', 'approval_expired', 'member_removed', 'publication_unverified',
      'form_after_t72', 'report_late_decision', 'other']), 'pub_review_tasks.reason: вне списка');
  PERFORM "sites"."pub_chk"(NEW."severity" = ANY (ARRAY['critical', 'normal']), 'pub_review_tasks.severity: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['open', 'resolved', 'dismissed']), 'pub_review_tasks.status: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."objectId") BETWEEN 1 AND 100 AND char_length(NEW."triggerRef") BETWEEN 1 AND 200,
    'pub_review_tasks.objectId/triggerRef: длина');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."resolution", 1, 2000), 'pub_review_tasks.resolution: длина 1..2000');
  -- Решение и автор обязательны (раздел 7.5).
  PERFORM "sites"."pub_chk"((NEW."status" = 'open') = (NEW."resolvedAt" IS NULL)
      AND (NEW."status" = 'open' OR (NEW."resolution" IS NOT NULL AND NEW."resolvedBy" IS NOT NULL)),
    'pub_review_tasks: resolved/dismissed требует resolution, resolvedBy, resolvedAt');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(OLD."status" = 'open' OR NEW."status" = OLD."status", 'pub_review_tasks.status: меняется только из open');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_review_tasks_guard" BEFORE INSERT OR UPDATE ON "pub_review_tasks"
  FOR EACH ROW EXECUTE FUNCTION "pub_review_tasks_guard"();

CREATE FUNCTION "pub_integrations_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['events_collector', 'web_analytics', 'search_console', 'crm_registry', 'ai_provider', 'cms']),
    'pub_integrations.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['connected', 'degraded', 'disconnected']), 'pub_integrations.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."staleAfterHours" BETWEEN 1 AND 8760, 'pub_integrations.staleAfterHours: 1..8760');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."note", 1, 2000), 'pub_integrations.note: длина 1..2000');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_integrations_guard" BEFORE INSERT OR UPDATE ON "pub_integrations"
  FOR EACH ROW EXECUTE FUNCTION "pub_integrations_guard"();

CREATE FUNCTION "pub_campaigns_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."code" ~ '^[a-z0-9][a-z0-9_-]{0,63}$', 'pub_campaigns.code: [a-z0-9_-], ≤ 64 (идёт в utm_campaign)');
  PERFORM "sites"."pub_chk"(char_length(NEW."name") BETWEEN 1 AND 300, 'pub_campaigns.name: длина 1..300');
  PERFORM "sites"."pub_chk"(NEW."endsAt" IS NULL OR NEW."startsAt" IS NULL OR NEW."endsAt" > NEW."startsAt", 'pub_campaigns.endsAt: позже startsAt');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_campaigns_guard" BEFORE INSERT OR UPDATE ON "pub_campaigns"
  FOR EACH ROW EXECUTE FUNCTION "pub_campaigns_guard"();

CREATE FUNCTION "pub_rate_hits_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(NEW."key") BETWEEN 1 AND 200, 'pub_rate_hits.key: длина 1..200');
  PERFORM "sites"."pub_chk"(char_length(NEW."id") BETWEEN 1 AND 64, 'pub_rate_hits.id: длина 1..64');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_rate_hits_guard" BEFORE INSERT OR UPDATE ON "pub_rate_hits"
  FOR EACH ROW EXECUTE FUNCTION "pub_rate_hits_guard"();

-- ══ Гварды таблиц: контент (6.3) ═════════════════════════════════════════

-- Содержимое источника заморожено, если он связан с замороженной версией
-- или с подтверждённым claim (аудит P2-14).
CREATE FUNCTION "pub_source_locked"(p_source TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
           SELECT 1 FROM "sites"."pub_version_sources" vs
             JOIN "sites"."pub_content_versions" v ON v."id" = vs."versionId"
            WHERE vs."sourceId" = p_source AND v."frozenAt" IS NOT NULL)
      OR EXISTS (
           SELECT 1 FROM "sites"."pub_claim_sources" cs
             JOIN "sites"."pub_claims" c ON c."id" = cs."claimId"
            WHERE cs."sourceId" = p_source AND c."status" = 'supported')
$$;

CREATE FUNCTION "pub_sources_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['url', 'interview', 'customer_question', 'discussion', 'search_data',
      'document', 'manual_text', 'experiment_record']), 'pub_sources.kind: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_https"(NEW."url", 2048), 'pub_sources.url: https, ≤ 2048');
  PERFORM "sites"."pub_chk"(NEW."kind" <> 'url' OR NEW."url" IS NOT NULL, 'pub_sources.url: обязателен при kind=url');
  PERFORM "sites"."pub_chk"(char_length(NEW."fragment") BETWEEN 1 AND 20000, 'pub_sources.fragment: длина 1..20000');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."externalRef", 1, 2000) AND "sites"."pub_len"(NEW."title", 1, 300)
      AND "sites"."pub_len"(NEW."author", 1, 300) AND "sites"."pub_len"(NEW."injectionFlag", 1, 200)
      AND "sites"."pub_len"(NEW."revokeReason", 1, 2000), 'pub_sources: длина текстового поля');
  PERFORM "sites"."pub_chk"(NEW."language" IS NULL OR NEW."language" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$',
    'pub_sources.language: BCP-47');
  PERFORM "sites"."pub_chk"(NEW."usage" = ANY (ARRAY['allowed', 'restricted', 'revoked']), 'pub_sources.usage: вне списка');
  PERFORM "sites"."pub_chk"(NEW."visibility" = ANY (ARRAY['public', 'private']), 'pub_sources.visibility: вне списка');
  PERFORM "sites"."pub_chk"(NEW."freshness" = ANY (ARRAY['current', 'stale', 'unknown']), 'pub_sources.freshness: вне списка');
  PERFORM "sites"."pub_chk"(NEW."importedVia" = ANY (ARRAY['manual', 'url_import']), 'pub_sources.importedVia: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."contentHash"), 'pub_sources.contentHash: sha256 hex');
  PERFORM "sites"."pub_chk"((NEW."usage" = 'revoked') = (NEW."revokedAt" IS NOT NULL AND NEW."revokedBy" IS NOT NULL AND NEW."revokeReason" IS NOT NULL),
    'pub_sources.revoked*: заполнены ⇔ usage=revoked');
  PERFORM "sites"."pub_chk"(NEW."supersedesId" IS NULL OR NEW."supersedesId" <> NEW."id", 'pub_sources.supersedesId: не на себя');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(OLD."usage" <> 'revoked' OR NEW."usage" = 'revoked', 'pub_sources.usage: revoked необратим');
    IF (NEW."url", NEW."fragment", NEW."contentHash") IS DISTINCT FROM (OLD."url", OLD."fragment", OLD."contentHash") THEN
      PERFORM "sites"."pub_chk"(NOT "sites"."pub_source_locked"(NEW."id"),
        'pub_sources: содержимое неизменно после связи с замороженной версией или подтверждённым claim — новая строка с supersedesId');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_sources_guard" BEFORE INSERT OR UPDATE ON "pub_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_sources_guard"();

-- Синтетика S1–S7 — только в продукте kind=eval (раздел 12.6).
CREATE FUNCTION "pub_synthetic_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."isSynthetic" THEN
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_products" p WHERE p."id" = NEW."productId" AND p."kind" = 'eval'),
      'pub_sources.isSynthetic: синтетика только в продукте kind=eval');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_synthetic_guard" BEFORE INSERT OR UPDATE ON "pub_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_synthetic_guard"();

CREATE FUNCTION "pub_source_revocations_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(btrim(NEW."reason")) BETWEEN 1 AND 2000, 'pub_source_revocations.reason: длина 1..2000');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_source_revocations_guard" BEFORE INSERT OR UPDATE ON "pub_source_revocations"
  FOR EACH ROW EXECUTE FUNCTION "pub_source_revocations_guard"();
CREATE TRIGGER "pub_source_revocations_ao" BEFORE UPDATE OR DELETE ON "pub_source_revocations"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

CREATE FUNCTION "pub_question_groups_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."key" ~ '^[a-z0-9][a-z0-9_.-]{0,99}$', 'pub_question_groups.key: [a-z0-9_.-], ≤ 100');
  PERFORM "sites"."pub_chk"(NEW."stage" = ANY (ARRAY['awareness', 'consideration', 'decision', 'unknown']), 'pub_question_groups.stage: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['proposed', 'confirmed', 'split', 'rejected']), 'pub_question_groups.status: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."task") BETWEEN 1 AND 2000 AND char_length(NEW."rationale") BETWEEN 1 AND 2000
      AND "sites"."pub_len"(NEW."audience", 1, 300) AND "sites"."pub_len"(NEW."mergeRisk", 1, 2000), 'pub_question_groups: длина текстового поля');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_question_groups_guard" BEFORE INSERT OR UPDATE ON "pub_question_groups"
  FOR EACH ROW EXECUTE FUNCTION "pub_question_groups_guard"();

CREATE FUNCTION "pub_questions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(NEW."text") BETWEEN 1 AND 1000, 'pub_questions.text: длина 1..1000');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."audience", 1, 300) AND "sites"."pub_len"(NEW."priorityNote", 1, 2000),
    'pub_questions: длина текстового поля');
  PERFORM "sites"."pub_chk"(NEW."stage" = ANY (ARRAY['awareness', 'consideration', 'decision', 'unknown']), 'pub_questions.stage: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['candidate', 'selected', 'rejected']), 'pub_questions.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."observedRepeats" IS NULL OR NEW."observedRepeats" >= 0, 'pub_questions.observedRepeats: ≥ 0');
  -- Частотность — только с источником измерения (F01).
  PERFORM "sites"."pub_chk"((NEW."frequency" IS NULL) = (NEW."frequencySourceId" IS NULL) AND (NEW."frequency" IS NULL OR NEW."frequency" >= 0),
    'pub_questions.frequency: вместе с frequencySourceId, ≥ 0');
  PERFORM "sites"."pub_chk"((NEW."status" = 'selected') = (NEW."selectedRank" IS NOT NULL)
      AND (NEW."selectedRank" IS NULL OR NEW."selectedRank" BETWEEN 1 AND 6), 'pub_questions.selectedRank: 1..6 ⇔ status=selected');
  -- Оценки: объект; известные критерии; score ∈ 0|1|2|null; why — строка.
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."scores") = 'object' AND "sites"."pub_jsize"(NEW."scores", 8192) AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(NEW."scores") e
       WHERE e.key <> ALL (ARRAY['offer_fit', 'confirmed_task', 'own_answer', 'cost'])
          OR jsonb_typeof(e.value) <> 'object'
          OR NOT (e.value ? 'score') OR NOT (e.value -> 'score' IN ('null'::jsonb, '0'::jsonb, '1'::jsonb, '2'::jsonb))
          OR (e.value ? 'why' AND jsonb_typeof(e.value -> 'why') NOT IN ('string', 'null'))),
    'pub_questions.scores: {offer_fit|confirmed_task|own_answer|cost → {score: 0|1|2|null, why}}');
  IF NEW."status" = 'selected' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"((SELECT count(*) FROM unnest(ARRAY['offer_fit', 'confirmed_task', 'own_answer', 'cost']) k
                                WHERE jsonb_typeof(NEW."scores" -> k -> 'why') = 'string'
                                  AND char_length(btrim(NEW."scores" -> k ->> 'why')) > 0) = 4,
      'pub_questions: selected требует пояснение why у всех четырёх оценок');
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_question_sources" qs
                                 JOIN "sites"."pub_sources" s ON s."id" = qs."sourceId"
                                WHERE qs."questionId" = NEW."id" AND s."usage" = 'allowed'),
      'pub_questions: selected требует ≥ 1 источника с usage=allowed');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_questions_guard" BEFORE INSERT OR UPDATE ON "pub_questions"
  FOR EACH ROW EXECUTE FUNCTION "pub_questions_guard"();

CREATE FUNCTION "pub_question_sources_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."fragment", 1, 2000), 'pub_question_sources.fragment: длина 1..2000');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_question_sources_guard" BEFORE INSERT OR UPDATE ON "pub_question_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_question_sources_guard"();

CREATE FUNCTION "pub_brand_facts_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."factKey" ~ '^[a-z0-9][a-z0-9_.-]{0,99}$', 'pub_brand_facts.factKey: [a-z0-9_.-], ≤ 100');
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['fact', 'price', 'condition', 'example', 'case', 'contact', 'tone',
      'limitation', 'forbidden_promise', 'faq']), 'pub_brand_facts.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['draft', 'active', 'superseded', 'needs_resolution', 'rejected']),
    'pub_brand_facts.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_brand_facts.version: ≥ 1');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."value", 65536) AND "sites"."pub_len"(NEW."scope", 1, 200), 'pub_brand_facts: размер value/scope');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'active' OR (NEW."approvedBy" IS NOT NULL AND NEW."approvedAt" IS NOT NULL),
    'pub_brand_facts: active требует approvedBy и approvedAt');
  PERFORM "sites"."pub_chk"("sites"."pub_is_member"(NEW."approvedBy"), 'pub_brand_facts.approvedBy: утверждает человек (member:)');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'needs_resolution' OR NEW."conflictWithId" IS NOT NULL,
    'pub_brand_facts.conflictWithId: обязателен при needs_resolution');
  PERFORM "sites"."pub_chk"(NEW."conflictWithId" IS NULL OR NEW."conflictWithId" <> NEW."id", 'pub_brand_facts.conflictWithId: не на себя');
  PERFORM "sites"."pub_chk"(NEW."kind" <> 'price' OR (jsonb_typeof(NEW."value") = 'object'
      AND jsonb_typeof(NEW."value" -> 'amountMinor') = 'number' AND (NEW."value" ->> 'amountMinor') ~ '^[0-9]{1,18}$'
      AND "sites"."pub_currency"(NEW."value" ->> 'currency') AND NEW."value" ? 'currency'),
    'pub_brand_facts.value: цена {amountMinor ≥ 0 целое, currency ISO 4217, note}');
  PERFORM "sites"."pub_chk"(NEW."kind" <> 'faq' OR (jsonb_typeof(NEW."value" -> 'question') = 'string'
      AND jsonb_typeof(NEW."value" -> 'answer') = 'string'
      AND char_length(btrim(NEW."value" ->> 'question')) > 0 AND char_length(btrim(NEW."value" ->> 'answer')) > 0),
    'pub_brand_facts.value: faq {question, answer}');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_brand_facts_guard" BEFORE INSERT OR UPDATE ON "pub_brand_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_brand_facts_guard"();

CREATE FUNCTION "pub_offer_versions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_offer_versions.version: ≥ 1');
  PERFORM "sites"."pub_chk"(char_length(NEW."title") BETWEEN 1 AND 300 AND char_length(NEW."text") BETWEEN 1 AND 20000
      AND "sites"."pub_len"(NEW."priceNote", 1, 2000), 'pub_offer_versions: длина title/text/priceNote');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['draft', 'active', 'superseded', 'historical']), 'pub_offer_versions.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'active' OR (NEW."approvedBy" IS NOT NULL AND NEW."approvedAt" IS NOT NULL),
    'pub_offer_versions: active требует approvedBy и approvedAt');
  PERFORM "sites"."pub_chk"("sites"."pub_is_member"(NEW."approvedBy"), 'pub_offer_versions.approvedBy: утверждает человек (member:)');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."hash"), 'pub_offer_versions.hash: sha256 hex');
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'draft' THEN
    PERFORM "sites"."pub_chk"((NEW."title", NEW."text", NEW."priceNote", NEW."hash", NEW."version")
                               IS NOT DISTINCT FROM (OLD."title", OLD."text", OLD."priceNote", OLD."hash", OLD."version"),
      'pub_offer_versions: содержимое неизменно после выхода из draft');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_offer_versions_guard" BEFORE INSERT OR UPDATE ON "pub_offer_versions"
  FOR EACH ROW EXECUTE FUNCTION "pub_offer_versions_guard"();

-- Бриф: ready требует собственный вклад, CTA, активный оффер и ≥ 1
-- разрешённый источник (AT-F03-02).
CREATE FUNCTION "pub_brief_ready_ok"(p_brief TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "sites"."pub_brief_sources" bs
                   JOIN "sites"."pub_sources" s ON s."id" = bs."sourceId"
                  WHERE bs."briefId" = p_brief AND s."usage" = 'allowed')
$$;

CREATE FUNCTION "pub_briefs_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."format" = ANY (ARRAY['instruction', 'case_review', 'choice_guide']), 'pub_briefs.format: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['draft', 'ready', 'rejected']), 'pub_briefs.status: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."goal") BETWEEN 1 AND 2000 AND "sites"."pub_len"(NEW."ownContribution", 0, 4000)
      AND "sites"."pub_len"(NEW."shortAnswer", 0, 2000) AND "sites"."pub_len"(NEW."cta", 0, 300)
      AND "sites"."pub_len"(NEW."ctaIntentNote", 0, 2000), 'pub_briefs: длина текстового поля');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."structure", 65536) AND "sites"."pub_jsize"(NEW."channels", 8192)
      AND "sites"."pub_jsize"(NEW."readinessCriteria", 8192) AND "sites"."pub_jsize"(NEW."unresolved", 8192)
      AND jsonb_typeof(NEW."unresolved") = 'array', 'pub_briefs: размер jsonb, unresolved — массив');
  PERFORM "sites"."pub_chk"(NEW."effortMinutes" IS NULL OR NEW."effortMinutes" >= 0, 'pub_briefs.effortMinutes: ≥ 0');
  IF NEW."status" = 'ready' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"(char_length(btrim(COALESCE(NEW."ownContribution", ''))) > 0, 'pub_briefs: ready требует собственный вклад');
    PERFORM "sites"."pub_chk"(char_length(btrim(COALESCE(NEW."cta", ''))) > 0 AND char_length(btrim(COALESCE(NEW."ctaIntentNote", ''))) > 0,
      'pub_briefs: ready требует CTA и ctaIntentNote');
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_offer_versions" o WHERE o."id" = NEW."offerVersionId" AND o."status" = 'active'),
      'pub_briefs: ready требует активную версию оффера');
    PERFORM "sites"."pub_chk"("sites"."pub_brief_ready_ok"(NEW."id"), 'pub_briefs: ready требует ≥ 1 источника с usage=allowed');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_briefs_guard" BEFORE INSERT OR UPDATE ON "pub_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_briefs_guard"();

-- Связка: у готового брифа нельзя снять последний разрешённый источник.
CREATE FUNCTION "pub_brief_sources_after"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sites"."pub_briefs" b WHERE b."id" = OLD."briefId" AND b."status" = 'ready') THEN
    PERFORM "sites"."pub_chk"("sites"."pub_brief_ready_ok"(OLD."briefId"),
      'pub_brief_sources: у брифа ready должен остаться ≥ 1 источник с usage=allowed');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "pub_brief_sources_after" AFTER UPDATE OR DELETE ON "pub_brief_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_brief_sources_after"();

CREATE FUNCTION "pub_contents_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['article', 'post', 'cards', 'checklist', 'video_script']), 'pub_contents.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['brief', 'drafting', 'editorial_review', 'changes_requested', 'approved',
      'scheduled', 'published', 'correction_required', 'revised', 'withdrawn']), 'pub_contents.status: вне списка');
  PERFORM "sites"."pub_chk"((NEW."kind" = 'article') = (NEW."parentContentId" IS NULL),
    'pub_contents.parentContentId: обязателен для адаптаций, запрещён для article');
  PERFORM "sites"."pub_chk"(NEW."kind" <> 'article' OR NEW."briefId" IS NOT NULL, 'pub_contents.briefId: обязателен для article');
  PERFORM "sites"."pub_chk"(NEW."slug" IS NULL OR (NEW."kind" = 'article' AND NEW."slug" ~ '^[a-z0-9-]{3,80}$'),
    'pub_contents.slug: только у article, ^[a-z0-9-]{3,80}$');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."blockReason", ARRAY['source', 'approval', 'access', 'measurement', 'budget', 'vendor', 'no_venue']),
    'pub_contents.blockReason: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."ownerDisplayName", 1, 200), 'pub_contents.ownerDisplayName: ≤ 200');
  PERFORM "sites"."pub_chk"(NEW."parentContentId" IS NULL OR NEW."parentContentId" <> NEW."id", 'pub_contents.parentContentId: не на себя');
  -- Указатели версий — только на версии ЭТОГО материала.
  PERFORM "sites"."pub_chk"(
      (NEW."currentVersionId" IS NULL OR EXISTS (SELECT 1 FROM "sites"."pub_content_versions" v WHERE v."id" = NEW."currentVersionId" AND v."contentId" = NEW."id"))
      AND (NEW."approvedVersionId" IS NULL OR EXISTS (SELECT 1 FROM "sites"."pub_content_versions" v WHERE v."id" = NEW."approvedVersionId" AND v."contentId" = NEW."id"))
      AND (NEW."publishedVersionId" IS NULL OR EXISTS (SELECT 1 FROM "sites"."pub_content_versions" v WHERE v."id" = NEW."publishedVersionId" AND v."contentId" = NEW."id")),
    'pub_contents: currentVersionId/approvedVersionId/publishedVersionId — версии этого материала');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."kind" = OLD."kind" AND NEW."parentContentId" IS NOT DISTINCT FROM OLD."parentContentId",
      'pub_contents: kind и parentContentId неизменны');
    -- firstPublishedAt ставится один раз (ДТ-1).
    PERFORM "sites"."pub_chk"(OLD."firstPublishedAt" IS NULL OR NEW."firstPublishedAt" = OLD."firstPublishedAt",
      'pub_contents.firstPublishedAt: ставится один раз');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_contents_guard" BEFORE INSERT OR UPDATE ON "pub_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_contents_guard"();

CREATE FUNCTION "pub_content_versions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_kind TEXT;
  c_parent TEXT;
BEGIN
  SELECT c."kind", c."parentContentId" INTO c_kind, c_parent FROM "sites"."pub_contents" c WHERE c."id" = NEW."contentId";
  PERFORM "sites"."pub_chk"(NEW."number" >= 1, 'pub_content_versions.number: ≥ 1');
  PERFORM "sites"."pub_chk"(char_length(NEW."title") BETWEEN 1 AND 300, 'pub_content_versions.title: длина 1..300');
  PERFORM "sites"."pub_chk"(char_length(NEW."body") <= 200000, 'pub_content_versions.body: ≤ 200 000');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."meta") = 'object' AND "sites"."pub_jsize"(NEW."meta", 65536), 'pub_content_versions.meta: объект ≤ 64 КБ');
  PERFORM "sites"."pub_chk"(NEW."format" = c_kind, 'pub_content_versions.format: = kind материала');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['draft', 'submitted', 'changes_requested', 'approved', 'rejected', 'superseded']),
    'pub_content_versions.status: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."authorMemberId") BETWEEN 1 AND 64, 'pub_content_versions.authorMemberId: длина 1..64');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."hash"), 'pub_content_versions.hash: sha256 hex');
  PERFORM "sites"."pub_chk"(NEW."status" = 'draft' OR (NEW."hash" IS NOT NULL AND NEW."frozenAt" IS NOT NULL),
    'pub_content_versions: вне draft нужны hash и frozenAt');
  -- Аудит P1-1: hash — только у замороженной версии. Иначе черновик с
  -- hash согласованной версии публикуется по чужому согласованию, а его
  -- тело правится уже на сайте.
  PERFORM "sites"."pub_chk"((NEW."hash" IS NULL) = (NEW."frozenAt" IS NULL),
    'pub_content_versions: hash есть ⇔ версия заморожена (frozenAt)');
  -- Адаптация опирается на версию своей статьи (F06 parent_version).
  PERFORM "sites"."pub_chk"(CASE WHEN c_parent IS NULL THEN NEW."parentVersionId" IS NULL
      ELSE NEW."parentVersionId" IS NOT NULL AND EXISTS (SELECT 1 FROM "sites"."pub_content_versions" pv
                                                          WHERE pv."id" = NEW."parentVersionId" AND pv."contentId" = c_parent) END,
    'pub_content_versions.parentVersionId: у адаптации — версия родительской статьи, у статьи — NULL');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."contentId" = OLD."contentId" AND NEW."number" = OLD."number", 'pub_content_versions: contentId и number неизменны');
    IF OLD."frozenAt" IS NOT NULL THEN
      PERFORM "sites"."pub_chk"((NEW."title", NEW."body", NEW."meta", NEW."format", NEW."offerVersionId", NEW."parentVersionId",
                                  NEW."hash", NEW."frozenAt", NEW."authorMemberId", NEW."aiCallId")
                                 IS NOT DISTINCT FROM
                                 (OLD."title", OLD."body", OLD."meta", OLD."format", OLD."offerVersionId", OLD."parentVersionId",
                                  OLD."hash", OLD."frozenAt", OLD."authorMemberId", OLD."aiCallId"),
        'pub_content_versions: после frozenAt содержимое неизменно — новая версия');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_content_versions_guard" BEFORE INSERT OR UPDATE ON "pub_content_versions"
  FOR EACH ROW EXECUTE FUNCTION "pub_content_versions_guard"();

-- Связи замороженной версии (источники, утверждения, факты) неизменны.
CREATE FUNCTION "pub_version_links_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "sites"."pub_chk"(NOT EXISTS (SELECT 1 FROM "sites"."pub_content_versions" v WHERE v."id" = OLD."versionId" AND v."frozenAt" IS NOT NULL),
      format('%s: связи замороженной версии неизменны', TG_TABLE_NAME));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM "sites"."pub_chk"("sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") OR NOT EXISTS (SELECT 1 FROM "sites"."pub_content_versions" v WHERE v."id" = NEW."versionId" AND v."frozenAt" IS NOT NULL),
      format('%s: связи замороженной версии неизменны', TG_TABLE_NAME));
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "pub_version_sources_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "pub_version_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_version_links_guard"();
CREATE TRIGGER "pub_version_claims_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "pub_version_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_version_links_guard"();
CREATE TRIGGER "pub_version_facts_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "pub_version_facts"
  FOR EACH ROW EXECUTE FUNCTION "pub_version_links_guard"();

-- Критический claim «supported» — только человек и поддерживающий
-- разрешённый источник, проверенный после его последнего изменения (F04).
CREATE FUNCTION "pub_claim_support_ok"(p_claim TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "sites"."pub_claim_sources" cs
                   JOIN "sites"."pub_sources" s ON s."id" = cs."sourceId"
                  WHERE cs."claimId" = p_claim AND cs."supports" = 'yes' AND s."usage" = 'allowed'
                    AND cs."checkedAt" IS NOT NULL AND cs."checkedAt" >= s."updatedAt")
$$;

CREATE FUNCTION "pub_claims_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'pub_claim_sources' THEN
    -- AFTER по связке: снятие/ослабление доказательства у подтверждённого
    -- критического claim запрещено.
    IF EXISTS (SELECT 1 FROM "sites"."pub_claims" c
                WHERE c."id" = COALESCE(OLD."claimId", NEW."claimId") AND c."status" = 'supported' AND c."risk" = 'critical') THEN
      PERFORM "sites"."pub_chk"("sites"."pub_claim_support_ok"(COALESCE(OLD."claimId", NEW."claimId")),
        'pub_claim_sources: у подтверждённого критического claim должно остаться поддерживающее доказательство');
    END IF;
    RETURN NULL;
  END IF;
  PERFORM "sites"."pub_chk"(char_length(NEW."statement") BETWEEN 1 AND 1000, 'pub_claims.statement: длина 1..1000');
  PERFORM "sites"."pub_chk"(NEW."type" = ANY (ARRAY['fact', 'estimate', 'hypothesis', 'example']), 'pub_claims.type: вне списка');
  PERFORM "sites"."pub_chk"(NEW."risk" = ANY (ARRAY['critical', 'high', 'normal']), 'pub_claims.risk: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['unverified', 'supported', 'unsupported', 'unknown', 'needs_review']),
    'pub_claims.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."supersedesId" IS NULL OR NEW."supersedesId" <> NEW."id", 'pub_claims.supersedesId: не на себя');
  PERFORM "sites"."pub_chk"("sites"."pub_is_member"(NEW."verifiedBy"), 'pub_claims.verifiedBy: проверяет человек (member:)');
  IF NEW."status" = 'supported' AND NEW."risk" = 'critical' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"(NEW."verifiedBy" IS NOT NULL AND NEW."verifiedAt" IS NOT NULL,
      'pub_claims: supported критического claim требует verifiedBy (человек) и verifiedAt');
    PERFORM "sites"."pub_chk"("sites"."pub_claim_support_ok"(NEW."id"),
      'pub_claims: supported критического claim требует связь supports=yes с разрешённым источником, проверенную после его изменения');
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."statement", NEW."type", NEW."risk") IS DISTINCT FROM (OLD."statement", OLD."type", OLD."risk") THEN
    PERFORM "sites"."pub_chk"(NOT EXISTS (SELECT 1 FROM "sites"."pub_version_claims" vc
                                           JOIN "sites"."pub_content_versions" v ON v."id" = vc."versionId"
                                          WHERE vc."claimId" = NEW."id" AND v."frozenAt" IS NOT NULL),
      'pub_claims: statement/type/risk неизменны после связи с замороженной версией — новая строка с supersedesId');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_claims_guard" BEFORE INSERT OR UPDATE ON "pub_claims"
  FOR EACH ROW EXECUTE FUNCTION "pub_claims_guard"();
CREATE TRIGGER "pub_claim_sources_support" AFTER INSERT OR UPDATE OR DELETE ON "pub_claim_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_claims_guard"();

CREATE FUNCTION "pub_claim_sources_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."supports" = ANY (ARRAY['yes', 'no', 'partial', 'unknown']), 'pub_claim_sources.supports: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."note", 1, 2000), 'pub_claim_sources.note: длина 1..2000');
  PERFORM "sites"."pub_chk"((NEW."checkedBy" IS NULL) = (NEW."checkedAt" IS NULL), 'pub_claim_sources.checkedBy/checkedAt: вместе');
  PERFORM "sites"."pub_chk"("sites"."pub_is_member"(NEW."checkedBy"), 'pub_claim_sources.checkedBy: проверяет человек (member:)');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_claim_sources_guard" BEFORE INSERT OR UPDATE ON "pub_claim_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_claim_sources_guard"();

CREATE FUNCTION "pub_qa_checks_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['editorial', 'technical', 'ai_review', 'adaptation_meaning']), 'pub_qa_checks.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."result" = ANY (ARRAY['pass', 'fail', 'unknown']), 'pub_qa_checks.result: вне списка');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."blockers") = 'array' AND "sites"."pub_jsize"(NEW."blockers", 65536), 'pub_qa_checks.blockers: массив ≤ 64 КБ');
  -- ai_review — системный актёр и ссылка на вызов; остальные проверки — человек.
  PERFORM "sites"."pub_chk"(CASE WHEN NEW."kind" = 'ai_review'
                                 THEN NEW."checkedBy" = 'system:ai-review' AND NEW."aiCallId" IS NOT NULL
                                 ELSE NEW."checkedBy" ~ '^member:' END,
    'pub_qa_checks.checkedBy: ai_review — system:ai-review с aiCallId, иначе member:');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_qa_checks_guard" BEFORE INSERT OR UPDATE ON "pub_qa_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_qa_checks_guard"();
CREATE TRIGGER "pub_qa_checks_ao" BEFORE UPDATE OR DELETE ON "pub_qa_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

CREATE FUNCTION "pub_approvals_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."type" = ANY (ARRAY['publish_version', 'purchase', 'reserve_release', 'ai_extra_generation']),
    'pub_approvals.type: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['active', 'revoked', 'expired', 'superseded', 'consumed']), 'pub_approvals.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."objectType" = ANY ("sites"."pub_object_types"()), 'pub_approvals.objectType: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."objectId") BETWEEN 1 AND 100, 'pub_approvals.objectId: длина 1..100');
  PERFORM "sites"."pub_chk"(char_length(NEW."approverMemberId") BETWEEN 1 AND 64 AND char_length(NEW."approverDisplayName") <= 200,
    'pub_approvals.approver*: длина');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."versionHash") AND "sites"."pub_hex64"(NEW."priceSnapshotHash"), 'pub_approvals: hash — sha256 hex');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."reason", 1, 2000), 'pub_approvals.reason: длина 1..2000');
  PERFORM "sites"."pub_chk"(NEW."type" NOT IN ('publish_version', 'purchase') OR NEW."versionHash" IS NOT NULL,
    'pub_approvals.versionHash: обязателен для publish_version и purchase');
  -- Аудит P1-1/P2-2: объект согласования соответствует его типу.
  PERFORM "sites"."pub_chk"(NEW."objectType" = CASE NEW."type"
        WHEN 'publish_version' THEN 'content_version' WHEN 'purchase' THEN 'placement'
        WHEN 'reserve_release' THEN 'budget_limit' WHEN 'ai_extra_generation' THEN 'ai_task' END,
    'pub_approvals.objectType: publish_version → content_version, purchase → placement, reserve_release → budget_limit, ai_extra_generation → ai_task');
  PERFORM "sites"."pub_chk"((NEW."maxAmountMinor" IS NULL) = (NEW."currency" IS NULL) AND "sites"."pub_currency"(NEW."currency")
      AND (NEW."maxAmountMinor" IS NULL OR NEW."maxAmountMinor" > 0), 'pub_approvals.maxAmountMinor/currency: вместе, сумма > 0');
  PERFORM "sites"."pub_chk"(NEW."type" NOT IN ('purchase', 'reserve_release') OR NEW."maxAmountMinor" IS NOT NULL,
    'pub_approvals: purchase/reserve_release требуют сумму и валюту');
  PERFORM "sites"."pub_chk"(NEW."type" <> 'purchase' OR (NEW."priceSnapshotHash" IS NOT NULL AND NEW."expiresAt" IS NOT NULL
      AND NEW."expiresAt" <= NEW."decidedAt" + interval '72 hours'),
    'pub_approvals: purchase требует priceSnapshotHash и expiresAt ≤ decidedAt + 72 ч');
  PERFORM "sites"."pub_chk"(NEW."type" <> 'publish_version' OR NEW."expiresAt" IS NULL, 'pub_approvals.expiresAt: у publish_version — NULL');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'consumed' OR NEW."type" = 'purchase', 'pub_approvals.status: consumed — только purchase');
  -- Существование объекта — после дешёвых проверок формы.
  IF TG_OP = 'INSERT' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    IF NEW."type" = 'publish_version' THEN
      PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_content_versions" v
                                         WHERE v."id" = NEW."objectId" AND v."productId" = NEW."productId"
                                           AND v."frozenAt" IS NOT NULL AND v."hash" = NEW."versionHash"),
        'pub_approvals: publish_version — замороженная версия этого продукта с тем же hash');
    ELSIF NEW."type" = 'purchase' THEN
      PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_placements" pl
                                         WHERE pl."id" = NEW."objectId" AND pl."productId" = NEW."productId"
                                           AND pl."currency" = NEW."currency" AND pl."totalPriceMinor" <= NEW."maxAmountMinor"),
        'pub_approvals: purchase — закупка этого продукта в той же валюте, сумма не меньше её цены');
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM "sites"."pub_chk"(NEW."status" = 'active' OR "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId"),
      'pub_approvals.status: создаётся active');
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
    PERFORM "sites"."pub_chk"(OLD."status" = 'active', 'pub_approvals.status: переход только из active');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_approvals_guard" BEFORE INSERT OR UPDATE ON "pub_approvals"
  FOR EACH ROW EXECUTE FUNCTION "pub_approvals_guard"();
CREATE TRIGGER "pub_approvals_ao" BEFORE UPDATE OR DELETE ON "pub_approvals"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('status', 'reason', 'updatedAt');

-- ══ Гварды таблиц: распространение и деньги (6.4) ════════════════════════

CREATE FUNCTION "pub_channels_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."code" ~ '^[a-z0-9][a-z0-9_-]{0,63}$', 'pub_channels.code: [a-z0-9_-], ≤ 64');
  PERFORM "sites"."pub_chk"(char_length(NEW."name") BETWEEN 1 AND 200, 'pub_channels.name: длина 1..200');
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['own', 'community', 'paid_venue', 'site']), 'pub_channels.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['available', 'unavailable']), 'pub_channels.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."utmSource" ~ '^[[:alnum:] ._:/-]{1,100}$' AND NEW."utmMedium" ~ '^[[:alnum:] ._:/-]{1,100}$',
    'pub_channels.utmSource/utmMedium: [букви цифри ._:/-], ≤ 100');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."rulesNote", 1, 2000), 'pub_channels.rulesNote: длина 1..2000');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."code" = OLD."code" AND NEW."kind" = OLD."kind", 'pub_channels: code и kind неизменны');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_channels_guard" BEFORE INSERT OR UPDATE ON "pub_channels"
  FOR EACH ROW EXECUTE FUNCTION "pub_channels_guard"();

CREATE FUNCTION "pub_distribution_actions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ch_kind TEXT;
BEGIN
  SELECT ch."kind" INTO ch_kind FROM "sites"."pub_channels" ch WHERE ch."id" = NEW."channelId";
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['planned', 'blocked', 'done', 'cancelled']), 'pub_distribution_actions.status: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."format") BETWEEN 1 AND 100 AND char_length(NEW."goal") BETWEEN 1 AND 2000
      AND char_length(NEW."ownerMemberId") BETWEEN 1 AND 64 AND char_length(NEW."ownerDisplayName") <= 200,
    'pub_distribution_actions: длина текстового поля');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."blockReason", ARRAY['ads_not_allowed', 'channel_unavailable', 'content_stale',
      'source', 'approval', 'access', 'measurement', 'budget', 'vendor', 'no_venue', 'other']), 'pub_distribution_actions.blockReason: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'blocked' OR NEW."blockReason" IS NOT NULL, 'pub_distribution_actions: blocked требует blockReason');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'done' OR NEW."publicationId" IS NOT NULL, 'pub_distribution_actions: done только с publicationId');
  PERFORM "sites"."pub_chk"("sites"."pub_https"(NEW."measurableUrl", 2048), 'pub_distribution_actions.measurableUrl: https, ≤ 2048');
  -- UTM: у внешних каналов обязателен, у собственного сайта — запрещён (F09).
  PERFORM "sites"."pub_chk"(CASE WHEN ch_kind = 'site' THEN NEW."measurableUrl" !~* '[?&]utm_'
                                 ELSE NEW."measurableUrl" ~* '[?&]utm_source=' AND NEW."measurableUrl" ~* '[?&]utm_medium='
                                      AND NEW."measurableUrl" ~* '[?&]utm_campaign=' END,
    'pub_distribution_actions.measurableUrl: UTM у внешних каналов обязателен, у канала site — запрещён');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_distribution_actions_guard" BEFORE INSERT OR UPDATE ON "pub_distribution_actions"
  FOR EACH ROW EXECUTE FUNCTION "pub_distribution_actions_guard"();

-- Публикация = действующее согласование того же hash (аудит P1-1, P2-7).
CREATE FUNCTION "pub_publication_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  a_type TEXT;
  a_status TEXT;
  a_hash TEXT;
  a_object_type TEXT;
  a_object_id TEXT;
  v_hash TEXT;
  v_frozen TIMESTAMPTZ;
  p_kind TEXT;
  p_mode TEXT;
BEGIN
  PERFORM "sites"."pub_chk"(NEW."stage" = ANY (ARRAY['test', 'live']), 'pub_publications.stage: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['pending', 'published', 'replaced', 'failed', 'withdrawn']), 'pub_publications.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."verifyStatus" = ANY (ARRAY['not_checked', 'ok', 'mismatch', 'unreachable']), 'pub_publications.verifyStatus: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_https"(NEW."finalUrl", 2048) AND "sites"."pub_https"(NEW."evidenceUrl", 2048),
    'pub_publications.finalUrl/evidenceUrl: https, ≤ 2048');
  PERFORM "sites"."pub_chk"("sites"."pub_uuid4"(NEW."opKey"), 'pub_publications.opKey: UUID v4');
  -- Аудит P3-10: URL в каноническом виде (хост в нижнем регистре, без порта
  -- 443, без `#` и завершающего `/`) — иначе `…/a` и `…/a/` обходят
  -- «одну активную публикацию URL».
  PERFORM "sites"."pub_chk"(NEW."finalUrl" ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^#[:space:]]*)?$'
      AND NEW."finalUrl" !~ '^https://[^/]+:443(/|$)' AND NEW."finalUrl" !~ '/$',
    'pub_publications.finalUrl: канонический вид (хост строчными, без :443, # и завершающего /)');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."verifyResult", 1, 2000), 'pub_publications.verifyResult: длина 1..2000');
  PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('published', 'replaced') OR NEW."publishedAt" IS NOT NULL,
    'pub_publications.publishedAt: обязателен при published/replaced');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"((NEW."versionId", NEW."channelId", NEW."approvalId", NEW."stage", NEW."finalUrl", NEW."opKey")
                               IS NOT DISTINCT FROM (OLD."versionId", OLD."channelId", OLD."approvalId", OLD."stage", OLD."finalUrl", OLD."opKey"),
      'pub_publications: версия, канал, согласование, стадия, URL и opKey неизменны');
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      PERFORM "sites"."pub_chk"((OLD."status", NEW."status") IN
          (('pending', 'published'), ('pending', 'failed'), ('pending', 'withdrawn'), ('published', 'replaced'), ('published', 'withdrawn')),
        'pub_publications.status: переход вне машины 7.5');
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."status" = 'published' AND OLD."status" IS DISTINCT FROM 'published') THEN
    -- FOR SHARE: параллельный отзыв согласования сериализуется с публикацией.
    SELECT a."type", a."status", a."versionHash", a."objectType", a."objectId"
      INTO a_type, a_status, a_hash, a_object_type, a_object_id
      FROM "sites"."pub_approvals" a WHERE a."id" = NEW."approvalId" AND a."accountId" = NEW."accountId" FOR SHARE;
    SELECT v."hash", v."frozenAt" INTO v_hash, v_frozen FROM "sites"."pub_content_versions" v WHERE v."id" = NEW."versionId";
    PERFORM "sites"."pub_chk"(a_type = 'publish_version' AND a_hash IS NOT NULL AND a_hash = v_hash,
      'pub_publications: согласование publish_version с hash этой версии');
    -- Аудит P1-1: согласование именно этой версии, и версия заморожена.
    PERFORM "sites"."pub_chk"(a_object_type = 'content_version' AND a_object_id = NEW."versionId" AND v_frozen IS NOT NULL,
      'pub_publications: согласование выдано на эту замороженную версию (objectId = versionId)');
    PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('pending', 'published') OR a_status = 'active'
        OR "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId"),
      'pub_publications: публикация только при активном согласовании');
    IF NEW."stage" = 'live' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
      SELECT p."kind", p."mode" INTO p_kind, p_mode FROM "sites"."pub_products" p WHERE p."id" = NEW."productId";
      PERFORM "sites"."pub_chk"(p_kind = 'working' AND p_mode = 'live', 'pub_publications.stage: live только в продукте kind=working, mode=live');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_publication_guard" BEFORE INSERT OR UPDATE ON "pub_publications"
  FOR EACH ROW EXECUTE FUNCTION "pub_publication_guard"();

CREATE FUNCTION "pub_venue_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(NEW."name") BETWEEN 1 AND 300 AND "sites"."pub_https"(NEW."url", 2048),
    'pub_venues.name/url: длина, https');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."topic", 1, 300) AND "sites"."pub_len"(NEW."market", 1, 100)
      AND "sites"."pub_len"(NEW."language", 1, 35) AND "sites"."pub_len"(NEW."audienceNote", 1, 2000)
      AND "sites"."pub_len"(NEW."riskNote", 1, 2000) AND "sites"."pub_len"(NEW."rejectReason", 1, 2000), 'pub_venues: длина текстового поля');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."formats", 8192) AND jsonb_typeof(NEW."criteria") = 'object'
      AND "sites"."pub_jsize"(NEW."criteria", 8192), 'pub_venues.formats/criteria: размер, criteria — объект');
  PERFORM "sites"."pub_chk"(NOT EXISTS (SELECT 1 FROM jsonb_each(NEW."criteria") e
       WHERE e.key <> ALL (ARRAY['topic', 'geo_language', 'format', 'evidence_freshness', 'real_distribution'])
          OR jsonb_typeof(e.value) <> 'object' OR NOT (e.value ? 'score')
          OR NOT (e.value -> 'score' IN ('null'::jsonb, '0'::jsonb, '1'::jsonb, '2'::jsonb))),
    'pub_venues.criteria: {topic|geo_language|format|evidence_freshness|real_distribution → {score: 0|1|2|null, why}}');
  PERFORM "sites"."pub_chk"(NEW."completeness" BETWEEN 0 AND 5, 'pub_venues.completeness: 0..5');
  PERFORM "sites"."pub_chk"(NEW."linkMarking" = ANY (ARRAY['sponsored', 'nofollow', 'unknown']), 'pub_venues.linkMarking: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['candidate', 'verified', 'rejected']), 'pub_venues.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'verified' OR (NEW."checkTopicMarket" AND NEW."checkPriceConfirmed" AND NEW."checkFormatConfirmed"
      AND NEW."checkTermSet" AND NEW."checkSupplierKnown" AND NEW."linkMarking" <> 'unknown'),
    'pub_venues: verified требует все пять проверок и известную маркировку ссылки (F10)');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'rejected' OR NEW."rejectReason" IS NOT NULL, 'pub_venues: rejected требует rejectReason');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_venue_guard" BEFORE INSERT OR UPDATE ON "pub_venues"
  FOR EACH ROW EXECUTE FUNCTION "pub_venue_guard"();

CREATE FUNCTION "pub_venue_evidence_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."criterion" = ANY (ARRAY['topic', 'geo_language', 'format', 'evidence_freshness', 'real_distribution']),
    'pub_venue_evidence.criterion: вне списка');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_venue_evidence_guard" BEFORE INSERT OR UPDATE ON "pub_venue_evidence"
  FOR EACH ROW EXECUTE FUNCTION "pub_venue_evidence_guard"();

-- Валюта не лимита — только с курсом, источником и временем (AT-CORE-13).
CREATE FUNCTION "pub_fx_ok"(p_cur TEXT, p_orig TEXT, p_amount BIGINT, p_rate NUMERIC, p_src TEXT, p_at TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_orig IS NULL THEN p_amount IS NULL AND p_rate IS NULL AND p_src IS NULL AND p_at IS NULL
    ELSE p_orig ~ '^[A-Z]{3}$' AND p_orig <> p_cur AND p_amount IS NOT NULL AND p_amount > 0
         AND p_rate IS NOT NULL AND p_rate > 0 AND p_src IS NOT NULL AND char_length(p_src) BETWEEN 1 AND 300 AND p_at IS NOT NULL
  END
$$;

CREATE FUNCTION "pub_placement_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."placementCode" ~ '^[a-z0-9][a-z0-9_-]{0,63}$', 'pub_placements.placementCode: [a-z0-9_-], ≤ 64 (utm_content)');
  PERFORM "sites"."pub_chk"("sites"."pub_https"(NEW."issuedUrl", 2048), 'pub_placements.issuedUrl: https, ≤ 2048');
  PERFORM "sites"."pub_chk"(NEW."purchaseSeq" >= 1, 'pub_placements.purchaseSeq: ≥ 1');
  PERFORM "sites"."pub_chk"(NEW."basePriceMinor" >= 0 AND NEW."feesMinor" >= 0 AND NEW."totalPriceMinor" >= 0, 'pub_placements: суммы ≥ 0');
  PERFORM "sites"."pub_chk"(NEW."totalPriceMinor" = NEW."basePriceMinor" + NEW."feesMinor", 'pub_placements.totalPriceMinor: = base + fees');
  PERFORM "sites"."pub_chk"("sites"."pub_currency"(NEW."currency"), 'pub_placements.currency: ISO 4217');
  PERFORM "sites"."pub_chk"("sites"."pub_fx_ok"(NEW."currency", NEW."origCurrency", NEW."origAmountMinor", NEW."fxRate", NEW."fxSource", NEW."fxAt"),
    'pub_placements: цена в другой валюте — origAmountMinor, fxRate, fxSource, fxAt обязательны');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."priceSource", 1, 300) AND "sites"."pub_len"(NEW."terms", 1, 2000)
      AND "sites"."pub_len"(NEW."externalOrderId", 1, 200), 'pub_placements: длина текстового поля');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['proposed', 'approved', 'budget_reserved', 'ordered', 'publication_pending', 'published',
      'verified_complete', 'rejected', 'cancelled', 'disputed']), 'pub_placements.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."paymentStatus" = ANY (ARRAY['unpaid', 'pending', 'paid', 'refunded', 'unknown']), 'pub_placements.paymentStatus: вне списка');
  PERFORM "sites"."pub_chk"(NEW."claimStatus" = ANY (ARRAY['none', 'open', 'resolved']), 'pub_placements.claimStatus: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" IN ('proposed', 'rejected', 'cancelled')
      OR (NEW."priceConfirmedAt" IS NOT NULL AND NEW."priceSource" IS NOT NULL), 'pub_placements: от approved нужны priceConfirmedAt и priceSource');
  PERFORM "sites"."pub_chk"(NEW."status" IN ('proposed', 'rejected') OR NEW."purchaseSeq" < 3 OR NEW."reportDecisionId" IS NOT NULL,
    'pub_placements: третья и следующие закупки требуют reportDecisionId (ТЗ §13)');
  PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('ordered', 'publication_pending', 'published', 'verified_complete') OR NEW."externalOrderId" IS NOT NULL,
    'pub_placements: от ordered нужен externalOrderId');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'publication_pending' OR NEW."publishDueAt" IS NOT NULL, 'pub_placements: publication_pending требует publishDueAt');
  PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('published', 'verified_complete') OR NEW."publishedAt" IS NOT NULL, 'pub_placements: published требует publishedAt');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'verified_complete' OR NEW."verifiedAt" IS NOT NULL, 'pub_placements: verified_complete требует verifiedAt');
  PERFORM "sites"."pub_chk"((NEW."status" <> 'disputed' AND NEW."claimStatus" <> 'open')
      OR (NEW."claimOwnerMemberId" IS NOT NULL AND NEW."nextActionAt" IS NOT NULL),
    'pub_placements: disputed/claimStatus=open требуют claimOwnerMemberId и nextActionAt (AT-CORE-16)');
  -- Аудит P2-2: валюта закупки — валюта лимита (если лимит собран);
  -- согласование — purchase именно этой закупки, в той же валюте, на сумму
  -- не меньше цены.
  PERFORM "sites"."pub_chk"(NOT EXISTS (SELECT 1 FROM "sites"."pub_budget_limits" bl
                                         WHERE bl."productId" = NEW."productId" AND bl."currency" <> NEW."currency"),
    'pub_placements.currency: валюта лимита бюджета');
  IF NEW."approvalId" IS NOT NULL AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId")
     AND (TG_OP = 'INSERT' OR NEW."approvalId" IS DISTINCT FROM OLD."approvalId"
          OR NEW."totalPriceMinor" <> OLD."totalPriceMinor" OR NEW."currency" <> OLD."currency") THEN
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_approvals" a
                                       WHERE a."id" = NEW."approvalId" AND a."type" = 'purchase' AND a."objectType" = 'placement'
                                         AND a."objectId" = NEW."id" AND a."currency" = NEW."currency"
                                         AND a."maxAmountMinor" >= NEW."totalPriceMinor"),
      'pub_placements.approvalId: согласование purchase этой закупки, в её валюте, на сумму не меньше цены');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"((NEW."placementCode", NEW."purchaseSeq", NEW."campaignId", NEW."venueId")
                               IS NOT DISTINCT FROM (OLD."placementCode", OLD."purchaseSeq", OLD."campaignId", OLD."venueId"),
      'pub_placements: код, порядковый номер, кампания и площадка неизменны');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_placement_guard" BEFORE INSERT OR UPDATE ON "pub_placements"
  FOR EACH ROW EXECUTE FUNCTION "pub_placement_guard"();

CREATE FUNCTION "pub_budget_limits_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"("sites"."pub_currency"(NEW."currency"), 'pub_budget_limits.currency: ISO 4217');
  PERFORM "sites"."pub_chk"(NEW."totalLimitMinor" >= 0 AND NEW."placementsLimitMinor" >= 0 AND NEW."toolsLimitMinor" >= 0
      AND NEW."protectedReserveMinor" >= 0 AND NEW."perPurchaseMaxMinor" >= 0 AND NEW."netPaidMinor" >= 0
      AND NEW."openCommitMinor" >= 0 AND NEW."usedPlacementsMinor" >= 0 AND NEW."usedToolsMinor" >= 0 AND NEW."aiMonthMinor" >= 0,
    'pub_budget_limits: суммы и счётчики ≥ 0');
  PERFORM "sites"."pub_chk"(NEW."warnRatioBp" BETWEEN 0 AND 10000 AND NEW."paramVersion" >= 0, 'pub_budget_limits: warnRatioBp 0..10000, paramVersion ≥ 0');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_budget_limits_guard" BEFORE INSERT OR UPDATE ON "pub_budget_limits"
  FOR EACH ROW EXECUTE FUNCTION "pub_budget_limits_guard"();

CREATE FUNCTION "pub_reserve_moves_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."toCategory" = ANY (ARRAY['placements', 'tools']), 'pub_reserve_moves.toCategory: вне списка');
  PERFORM "sites"."pub_chk"(NEW."amountMinor" > 0, 'pub_reserve_moves.amountMinor: > 0');
  -- Аудит P2-2: действующее согласование reserve_release в валюте лимита;
  -- все переводы по нему вместе — не больше его суммы.
  PERFORM "sites"."pub_chk"(EXISTS (
      SELECT 1 FROM "sites"."pub_approvals" a
        JOIN "sites"."pub_budget_limits" bl ON bl."productId" = NEW."productId" AND bl."currency" = a."currency"
       WHERE a."id" = NEW."approvalId" AND a."type" = 'reserve_release' AND a."status" = 'active'
         AND a."maxAmountMinor" >= NEW."amountMinor" + COALESCE((
               SELECT sum(m."amountMinor") FROM "sites"."pub_reserve_moves" m
                WHERE m."approvalId" = NEW."approvalId" AND m."id" <> NEW."id"), 0)),
    'pub_reserve_moves: действующее согласование reserve_release в валюте лимита на сумму не меньше всех переводов по нему');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reserve_moves_guard" BEFORE INSERT OR UPDATE ON "pub_reserve_moves"
  FOR EACH ROW EXECUTE FUNCTION "pub_reserve_moves_guard"();
CREATE TRIGGER "pub_reserve_moves_ao" BEFORE UPDATE OR DELETE ON "pub_reserve_moves"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

-- Обязательство: paid + cancelled ≤ total, refunded ≤ paid, delivered ≤
-- total − cancelled; закупка — не больше суммы её согласования (аудит P2-2).
CREATE FUNCTION "pub_expenses_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  max_amount BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'pub_expense_entries' THEN
    PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['commit', 'pay', 'refund', 'cancel', 'deliver', 'adjust']), 'pub_expense_entries.kind: вне списка');
    PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['confirmed', 'pending', 'unknown', 'void']), 'pub_expense_entries.status: вне списка');
    PERFORM "sites"."pub_chk"(CASE WHEN NEW."kind" = 'adjust' THEN NEW."amountMinor" <> 0 AND char_length(btrim(COALESCE(NEW."note", ''))) > 0
                                   ELSE NEW."amountMinor" > 0 END,
      'pub_expense_entries.amountMinor: > 0; adjust — со знаком и причиной в note');
    PERFORM "sites"."pub_chk"("sites"."pub_uuid4"(NEW."opKey"), 'pub_expense_entries.opKey: UUID v4');
    PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."externalRef", 1, 200) AND "sites"."pub_len"(NEW."sourceDocument", 1, 2000)
        AND "sites"."pub_len"(NEW."note", 1, 2000), 'pub_expense_entries: длина текстового поля');
    PERFORM "sites"."pub_chk"(NEW."status" <> 'confirmed' OR NEW."kind" NOT IN ('pay', 'refund', 'cancel')
        OR (NEW."confirmedAt" IS NOT NULL AND NEW."confirmedBy" IS NOT NULL),
      'pub_expense_entries: confirmed pay/refund/cancel требует confirmedAt и confirmedBy');
    IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      -- Сверка: только pending|unknown → confirmed|void (раздел 6.4).
      PERFORM "sites"."pub_chk"(OLD."status" IN ('pending', 'unknown') AND NEW."status" IN ('confirmed', 'void'),
        'pub_expense_entries.status: только pending|unknown → confirmed|void');
    END IF;
    RETURN NEW;
  END IF;
  PERFORM "sites"."pub_chk"(NEW."category" = ANY (ARRAY['placements', 'tools', 'other']), 'pub_expenses.category: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."description") BETWEEN 1 AND 2000 AND "sites"."pub_len"(NEW."sourceDocument", 1, 2000),
    'pub_expenses: длина текстового поля');
  PERFORM "sites"."pub_chk"((NEW."category" = 'placements') = (NEW."placementId" IS NOT NULL),
    'pub_expenses.placementId: обязателен для placements и только для них');
  PERFORM "sites"."pub_chk"(NEW."amountTotalMinor" > 0, 'pub_expenses.amountTotalMinor: > 0');
  PERFORM "sites"."pub_chk"(NEW."paidMinor" >= 0 AND NEW."refundedMinor" >= 0 AND NEW."cancelledMinor" >= 0 AND NEW."deliveredMinor" >= 0,
    'pub_expenses: суммы ≥ 0');
  PERFORM "sites"."pub_chk"(NEW."paidMinor" + NEW."cancelledMinor" <= NEW."amountTotalMinor", 'pub_expenses: paid + cancelled ≤ amountTotal');
  PERFORM "sites"."pub_chk"(NEW."refundedMinor" <= NEW."paidMinor", 'pub_expenses: refunded ≤ paid');
  PERFORM "sites"."pub_chk"(NEW."deliveredMinor" <= NEW."amountTotalMinor" - NEW."cancelledMinor", 'pub_expenses: delivered ≤ amountTotal − cancelled');
  PERFORM "sites"."pub_chk"("sites"."pub_currency"(NEW."currency"), 'pub_expenses.currency: ISO 4217');
  PERFORM "sites"."pub_chk"("sites"."pub_fx_ok"(NEW."currency", NEW."origCurrency", NEW."origAmountMinor", NEW."fxRate", NEW."fxSource", NEW."fxAt"),
    'pub_expenses: сумма в другой валюте — origAmountMinor, fxRate, fxSource, fxAt обязательны');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['open', 'closed']), 'pub_expenses.status: вне списка');
  -- Аудит P2-2: обязательство — в валюте лимита бюджета (лимит собран).
  IF NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId")
     AND (TG_OP = 'INSERT' OR NEW."currency" <> OLD."currency") THEN
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_budget_limits" bl
                                       WHERE bl."productId" = NEW."productId" AND bl."currency" = NEW."currency"),
      'pub_expenses.currency: валюта лимита бюджета (строка лимита собрана)');
  END IF;
  IF NEW."category" = 'placements' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId")
     AND (TG_OP = 'INSERT' OR NEW."amountTotalMinor" <> OLD."amountTotalMinor"
                                        OR NEW."placementId" IS DISTINCT FROM OLD."placementId") THEN
    -- Согласование purchase ЭТОЙ закупки, в той же валюте; для нового
    -- обязательства — действующее (active или только что consumed резервом)
    -- и не истёкшее.
    SELECT a."maxAmountMinor" INTO max_amount
      FROM "sites"."pub_placements" pl JOIN "sites"."pub_approvals" a ON a."id" = pl."approvalId"
     WHERE pl."id" = NEW."placementId" AND a."type" = 'purchase' AND a."objectType" = 'placement'
       AND a."objectId" = NEW."placementId" AND a."currency" = NEW."currency"
       AND (TG_OP = 'UPDATE' OR (a."status" IN ('active', 'consumed') AND a."expiresAt" > now()));
    PERFORM "sites"."pub_chk"(max_amount IS NOT NULL AND NEW."amountTotalMinor" <= max_amount,
      'pub_expenses: обязательство закупки — по действующему согласованию purchase этой закупки, в её валюте, не больше maxAmountMinor');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_expenses_guard" BEFORE INSERT OR UPDATE ON "pub_expenses"
  FOR EACH ROW EXECUTE FUNCTION "pub_expenses_guard"();
CREATE TRIGGER "pub_expense_entries_guard" BEFORE INSERT OR UPDATE ON "pub_expense_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_expenses_guard"();
CREATE TRIGGER "pub_expense_entries_ao" BEFORE UPDATE OR DELETE ON "pub_expense_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('status', 'confirmedAt', 'confirmedBy', 'updatedAt');

CREATE FUNCTION "pub_time_entries_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(NEW."memberId") BETWEEN 1 AND 64 AND char_length(NEW."memberDisplayName") <= 200
      AND char_length(NEW."task") BETWEEN 1 AND 2000, 'pub_time_entries: длина текстового поля');
  PERFORM "sites"."pub_chk"(NEW."role" = ANY (ARRAY['product_owner', 'editor', 'operator', 'analyst', 'sales', 'viewer', 'admin']),
    'pub_time_entries.role: вне списка');
  PERFORM "sites"."pub_chk"(NEW."featureId" IS NULL OR NEW."featureId" ~ '^F[0-9]{2}$', 'pub_time_entries.featureId: F01…F24');
  PERFORM "sites"."pub_chk"(NEW."minutes" BETWEEN 1 AND 1440, 'pub_time_entries.minutes: 1..1440');
  PERFORM "sites"."pub_chk"((NEW."rateMinorPerHour" IS NULL OR NEW."rateMinorPerHour" >= 0)
      AND (NEW."rateParamVersion" IS NULL OR NEW."rateParamVersion" >= 1), 'pub_time_entries: ставка ≥ 0, версия параметра ≥ 1');
  PERFORM "sites"."pub_chk"(NEW."category" = ANY (ARRAY['setup', 'research', 'production', 'distribution', 'analytics_ops', 'qa_reports', 'development']),
    'pub_time_entries.category: вне списка');
  PERFORM "sites"."pub_chk"(NEW."isInvestment" = (NEW."category" IN ('setup', 'development')), 'pub_time_entries.isInvestment: = setup|development');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_time_entries_guard" BEFORE INSERT OR UPDATE ON "pub_time_entries"
  FOR EACH ROW EXECUTE FUNCTION "pub_time_entries_guard"();

-- ══ Гварды таблиц: заявки и аналитика (6.5) ══════════════════════════════
-- pub_leads, pub_lead_contacts, pub_events, pub_sessions, pub_lead_outbox,
-- pub_rate_hits пишет роль publisher_public: её функции триггеров обязаны
-- быть SECURITY DEFINER (читают pub_products, к которым у роли прав нет).

-- Аудит P3-2: приём (заявка, событие, сессия) — только в действующий
-- продукт рабочего или тестового вида, режим test или live; заявка в live —
-- ещё и при открытых гейтах public_publish и real_leads (= formOpen
-- представления pub_public_products). Вставка восстановления — без этого.
CREATE FUNCTION "pub_accepts_intake"(p_product TEXT, p_lead BOOLEAN) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "sites"."pub_products" p
     WHERE p."id" = p_product AND p."status" = 'active' AND p."kind" IN ('working', 'test')
       AND (p."mode" = 'test'
            OR (p."mode" = 'live' AND (NOT p_lead OR (p."paramsPublicPublishOk" AND p."paramsRealLeadsOk")))))
$$;

CREATE FUNCTION "pub_prospects_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."code" ~ '^P-[0-9]{4,9}$', 'pub_prospects.code: P-0001');
  PERFORM "sites"."pub_chk"(NEW."priorExternalPayment" = ANY (ARRAY['yes', 'no', 'unknown']), 'pub_prospects.priorExternalPayment: вне списка');
  PERFORM "sites"."pub_chk"(NEW."mergedIntoId" IS NULL OR NEW."mergedIntoId" <> NEW."id", 'pub_prospects.mergedIntoId: не на себя');
  PERFORM "sites"."pub_chk"(NEW."noteEnc" IS NULL OR (NEW."noteEnc" ~ '^v[0-9]+\.' AND char_length(NEW."noteEnc") <= 16384),
    'pub_prospects.noteEnc: только шифротекст (v<N>.…), ≤ 16 КБ');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_prospects_guard" BEFORE INSERT OR UPDATE ON "pub_prospects"
  FOR EACH ROW EXECUTE FUNCTION "pub_prospects_guard"();

CREATE FUNCTION "pub_lead_prospect_links_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."reason" = ANY (ARRAY['intake_exact_match', 'new', 'manual_merge', 'manual_split', 'manual_assign']),
    'pub_lead_prospect_links.reason: вне списка');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_lead_prospect_links_guard" BEFORE INSERT OR UPDATE ON "pub_lead_prospect_links"
  FOR EACH ROW EXECUTE FUNCTION "pub_lead_prospect_links_guard"();
CREATE TRIGGER "pub_lead_prospect_links_ao" BEFORE UPDATE OR DELETE ON "pub_lead_prospect_links"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

CREATE FUNCTION "pub_leads_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p_kind TEXT;
  p_mode TEXT;
BEGIN
  SELECT p."kind", p."mode" INTO p_kind, p_mode FROM "sites"."pub_products" p WHERE p."id" = NEW."productId";
  PERFORM "sites"."pub_chk"("sites"."pub_uuid"(NEW."submissionKey"), 'pub_leads.submissionKey: UUID');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."requestHash"), 'pub_leads.requestHash: sha256 hex');
  PERFORM "sites"."pub_chk"(NEW."publicRef" ~ '^L-[A-Z2-7]{10}$', 'pub_leads.publicRef: L- + 10 base32');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY ("sites"."pub_lead_statuses"()), 'pub_leads.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('qualified', 'proposal_sent', 'won', 'lost') OR NEW."prospectId" IS NOT NULL,
    'pub_leads: qualified и далее требуют prospectId');
  PERFORM "sites"."pub_chk"(CASE WHEN NEW."testFlag" THEN NEW."testReason" = ANY (ARRAY['test_mode', 'test_product', 'team', 'manual'])
                                 ELSE NEW."testReason" IS NULL END,
    'pub_leads.testReason: обязателен ⇔ testFlag (test_mode|test_product|team|manual)');
  PERFORM "sites"."pub_chk"(NEW."testFlag" OR p_kind = 'working' OR "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId"),
    'pub_leads.testFlag: в продукте kind≠working заявки только тестовые');
  IF TG_OP = 'INSERT' AND p_mode = 'test' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"(NEW."testFlag", 'pub_leads.testFlag: в режиме test принудительно true');
  END IF;
  IF TG_OP = 'INSERT' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"("sites"."pub_accepts_intake"(NEW."productId", true),
      'pub_leads: продукт не принимает заявки (закрыт, архивный, не тот вид или гейты не открыты)');
  END IF;
  PERFORM "sites"."pub_chk"((NEW."status" IN ('rejected', 'won', 'lost')) = (NEW."closedAt" IS NOT NULL),
    'pub_leads.closedAt: заполнен ⇔ status ∈ rejected|won|lost');
  PERFORM "sites"."pub_chk"(NEW."contactMethod" = ANY (ARRAY['email', 'phone', 'telegram', 'other']), 'pub_leads.contactMethod: вне списка');
  PERFORM "sites"."pub_chk"(NEW."consentState" = ANY (ARRAY['granted', 'denied', 'unknown', 'not_required']), 'pub_leads.consentState: вне списка');
  PERFORM "sites"."pub_chk"(NEW."budgetRange" IS NULL OR NEW."budgetRange" ~ '^[a-z0-9_]{1,50}$', 'pub_leads.budgetRange: ключ диапазона');
  PERFORM "sites"."pub_chk"(NEW."selfReportedChannel" IS NULL OR NEW."selfReportedChannel" ~ '^[a-z0-9_]{1,50}$',
    'pub_leads.selfReportedChannel: категория из списка (свободный текст — только в шифре)');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."contentSlugRaw", 1, 100) AND "sites"."pub_len"(NEW."placementCodeRaw", 1, 100)
      AND "sites"."pub_len"(NEW."sessionRef", 1, 100) AND "sites"."pub_len"(NEW."responsibleDisplayName", 1, 200)
      AND "sites"."pub_len"(NEW."retentionBasis", 1, 2000), 'pub_leads: длина текстового поля');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_looks_contact"(NEW."contentSlugRaw") AND NOT "sites"."pub_looks_contact"(NEW."placementCodeRaw"),
    'pub_leads: контакт в сырых полях атрибуции запрещён');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."attribution", 8192), 'pub_leads.attribution: ≤ 8 КБ');
  PERFORM "sites"."pub_chk"(NEW."duplicateOfLeadId" IS NULL OR NEW."duplicateOfLeadId" <> NEW."id", 'pub_leads.duplicateOfLeadId: не на себя');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"((NEW."submissionKey", NEW."requestHash", NEW."publicRef", NEW."receivedAt")
                               IS NOT DISTINCT FROM (OLD."submissionKey", OLD."requestHash", OLD."publicRef", OLD."receivedAt"),
      'pub_leads: submissionKey, requestHash, publicRef, receivedAt неизменны');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_leads_guard" BEFORE INSERT OR UPDATE ON "pub_leads"
  FOR EACH ROW EXECUTE FUNCTION "pub_leads_guard"();

CREATE FUNCTION "pub_lead_contacts_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Контакт — только шифротекст `v1.<iv>.<tag>.<шифр>` (раздел 6.5).
  PERFORM "sites"."pub_chk"(NEW."contactEnc" ~ '^v[0-9]+\.[A-Za-z0-9_=+/-]+\.[A-Za-z0-9_=+/-]+\.[A-Za-z0-9_=+/-]+$'
      AND char_length(NEW."contactEnc") <= 16384, 'pub_lead_contacts.contactEnc: только шифротекст v<N>.<iv>.<tag>.<шифр>, ≤ 16 КБ');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."matchHash"), 'pub_lead_contacts.matchHash: HMAC-SHA256 hex');
  -- Аудит P3-8: версия ключа в префиксе шифротекста = keyVersion.
  PERFORM "sites"."pub_chk"(split_part(NEW."contactEnc", '.', 1) = NEW."keyVersion",
    'pub_lead_contacts.keyVersion: совпадает с версией в шифротексте');
  PERFORM "sites"."pub_chk"(char_length(NEW."keyVersion") BETWEEN 1 AND 20, 'pub_lead_contacts.keyVersion: длина 1..20');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."leadId" = OLD."leadId", 'pub_lead_contacts.leadId: неизменен');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_lead_contacts_guard" BEFORE INSERT OR UPDATE ON "pub_lead_contacts"
  FOR EACH ROW EXECUTE FUNCTION "pub_lead_contacts_guard"();

CREATE FUNCTION "pub_lead_decisions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."fromStatus" = ANY ("sites"."pub_lead_statuses"()) AND NEW."toStatus" = ANY ("sites"."pub_lead_statuses"()),
    'pub_lead_decisions.status: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."reasonCode", ARRAY['spam', 'vendor_offer', 'team', 'fake', 'out_of_scope', 'unreachable',
      'price', 'timing', 'other']), 'pub_lead_decisions.reasonCode: вне списка');
  -- Код причины обязателен для rejected|lost и отмены решения (раздел 6.5).
  PERFORM "sites"."pub_chk"(NOT (NEW."toStatus" IN ('rejected', 'lost')
                                 OR (NEW."toStatus" = 'contacted' AND NEW."fromStatus" IN ('qualified', 'rejected', 'lost')))
                            OR NEW."reasonCode" IS NOT NULL,
    'pub_lead_decisions.reasonCode: обязателен для rejected|lost и отмены решения');
  PERFORM "sites"."pub_chk"(NEW."toStatus" <> 'qualified' OR NEW."confirmedInterestAt" IS NOT NULL,
    'pub_lead_decisions.confirmedInterestAt: обязателен для qualified');
  PERFORM "sites"."pub_chk"(NEW."decidedBy" ~ '^member:' OR "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId"),
    'pub_lead_decisions.decidedBy: решает человек (member:)');
  PERFORM "sites"."pub_chk"(NEW."noteEnc" IS NULL OR (NEW."noteEnc" ~ '^v[0-9]+\.' AND char_length(NEW."noteEnc") <= 16384),
    'pub_lead_decisions.noteEnc: только шифротекст');
  -- Ретенция: шифрованную заметку можно обнулить (раздел 15.3). Ротация
  -- ключа (запрос P-A1): заменить шифротекст можно только на шифротекст
  -- ДРУГОЙ версии ключа (то же содержание под новым ключом).
  IF TG_OP = 'UPDATE' AND NEW."noteEnc" IS DISTINCT FROM OLD."noteEnc" THEN
    PERFORM "sites"."pub_chk"(NEW."noteEnc" IS NULL
        OR (OLD."noteEnc" IS NOT NULL AND split_part(NEW."noteEnc", '.', 1) <> split_part(OLD."noteEnc", '.', 1)),
      'pub_lead_decisions.noteEnc: только обнуление (ретенция) или перешифровка другой версией ключа (ротация)');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_lead_decisions_guard" BEFORE INSERT OR UPDATE ON "pub_lead_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_lead_decisions_guard"();
CREATE TRIGGER "pub_lead_decisions_ao" BEFORE UPDATE OR DELETE ON "pub_lead_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('noteEnc');

CREATE FUNCTION "pub_erasures_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(btrim(NEW."basis")) BETWEEN 1 AND 2000, 'pub_erasures.basis: длина 1..2000');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."scope") = 'object' AND "sites"."pub_jsize"(NEW."scope", 4096), 'pub_erasures.scope: объект ≤ 4 КБ');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_erasures_guard" BEFORE INSERT OR UPDATE ON "pub_erasures"
  FOR EACH ROW EXECUTE FUNCTION "pub_erasures_guard"();
CREATE TRIGGER "pub_erasures_ao" BEFORE UPDATE OR DELETE ON "pub_erasures"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

CREATE FUNCTION "pub_payments_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."recordType" = ANY (ARRAY['payment_received', 'refund', 'contract_signed']), 'pub_payments.recordType: вне списка');
  PERFORM "sites"."pub_chk"(NEW."payerKind" = ANY (ARRAY['external', 'internal', 'test', 'self']), 'pub_payments.payerKind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."amountMinor" > 0 AND "sites"."pub_currency"(NEW."currency"), 'pub_payments: сумма > 0, валюта ISO 4217');
  PERFORM "sites"."pub_chk"(char_length(NEW."paymentRef") BETWEEN 1 AND 200 AND "sites"."pub_len"(NEW."confirmation", 1, 2000),
    'pub_payments: длина paymentRef/confirmation');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['pending', 'confirmed', 'refunded', 'cancelled']), 'pub_payments.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('confirmed', 'refunded') OR (NEW."confirmedBy" IS NOT NULL AND NEW."confirmedAt" IS NOT NULL),
    'pub_payments: confirmed требует confirmedBy и confirmedAt');
  PERFORM "sites"."pub_chk"(NEW."isNewCustomer" = ANY (ARRAY['yes', 'no', 'unknown']), 'pub_payments.isNewCustomer: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_uuid4"(NEW."opKey"), 'pub_payments.opKey: UUID v4');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"((NEW."prospectId", NEW."recordType", NEW."payerKind", NEW."amountMinor", NEW."currency", NEW."paymentRef", NEW."opKey")
                               IS NOT DISTINCT FROM (OLD."prospectId", OLD."recordType", OLD."payerKind", OLD."amountMinor", OLD."currency", OLD."paymentRef", OLD."opKey"),
      'pub_payments: суть оплаты неизменна — исправление новой записью');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_payments_guard" BEFORE INSERT OR UPDATE ON "pub_payments"
  FOR EACH ROW EXECUTE FUNCTION "pub_payments_guard"();

-- UTM: только четыре ключа, значения ≤ 100 без email/телефона (AT-CORE-09).
CREATE FUNCTION "pub_utm_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."utm" IS NULL OR (jsonb_typeof(NEW."utm") = 'object' AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(NEW."utm") e
       WHERE e.key <> ALL (ARRAY['source', 'medium', 'campaign', 'content'])
          OR jsonb_typeof(e.value) <> 'string'
          OR NOT ((e.value #>> '{}') = '[redacted]'
                  OR ((e.value #>> '{}') ~ '^[[:alnum:] ._:/-]{1,100}$' AND NOT "sites"."pub_looks_contact"(e.value #>> '{}'))))),
    format('%s.utm: только source|medium|campaign|content, [букви цифри ._:/-] ≤ 100, без email/телефона', TG_TABLE_NAME));
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_utm_guard" BEFORE INSERT OR UPDATE ON "pub_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_utm_guard"();
CREATE TRIGGER "pub_utm_guard" BEFORE INSERT OR UPDATE ON "pub_sessions"
  FOR EACH ROW EXECUTE FUNCTION "pub_utm_guard"();

CREATE FUNCTION "pub_sessions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."sessionRef" ~ '^[A-Za-z0-9_-]{8,100}$', 'pub_sessions.sessionRef: [A-Za-z0-9_-]{8,100}');
  PERFORM "sites"."pub_chk"(NEW."landingPath" ~ '^/' AND char_length(NEW."landingPath") <= 2048, 'pub_sessions.landingPath: путь от /, ≤ 2048');
  -- Аудит P3-5: только путь — без query и фрагмента (там бывают контакты),
  -- без `@`. Телефонное правило к пути не применяется: slug вида
  -- `guide-2026-10-16` — 8 цифр с разделителями, не телефон.
  PERFORM "sites"."pub_chk"(NEW."landingPath" !~ '[@?#]', 'pub_sessions.landingPath: путь без query, фрагмента и @');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."contentSlugRaw", 1, 100) AND "sites"."pub_len"(NEW."placementCodeRaw", 1, 100),
    'pub_sessions: длина сырых полей ≤ 100');
  PERFORM "sites"."pub_chk"(NEW."utm" IS NOT NULL, 'pub_sessions.utm: объект (может быть пустым)');
  IF TG_OP = 'INSERT' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"("sites"."pub_accepts_intake"(NEW."productId", false),
      'pub_sessions: продукт не принимает события (закрыт, архивный или не тот вид)');
  END IF;
  PERFORM "sites"."pub_chk"(NEW."consentState" = ANY (ARRAY['granted', 'denied', 'unknown', 'not_required']), 'pub_sessions.consentState: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."channelGroup", "sites"."pub_channel_groups"()), 'pub_sessions.channelGroup: вне списка');
  PERFORM "sites"."pub_chk"(NEW."channelGroup" IS DISTINCT FROM 'paid_placement' OR NEW."placementId" IS NOT NULL,
    'pub_sessions: paid_placement только при найденном размещении');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_sessions_guard" BEFORE INSERT OR UPDATE ON "pub_sessions"
  FOR EACH ROW EXECUTE FUNCTION "pub_sessions_guard"();

CREATE FUNCTION "pub_events_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"("sites"."pub_uuid"(NEW."eventId"), 'pub_events.eventId: UUID');
  PERFORM "sites"."pub_chk"(NEW."name" = ANY (ARRAY['content_view', 'cta_click', 'lead_submit_success']), 'pub_events.name: вне списка');
  IF TG_OP = 'INSERT' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"("sites"."pub_accepts_intake"(NEW."productId", false),
      'pub_events: продукт не принимает события (закрыт, архивный или не тот вид)');
  END IF;
  PERFORM "sites"."pub_chk"((NEW."leadId" IS NOT NULL) = (NEW."name" = 'lead_submit_success'),
    'pub_events.leadId: только и обязательно у lead_submit_success');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."contentSlugRaw", 1, 100) AND "sites"."pub_len"(NEW."placementCodeRaw", 1, 100)
      AND "sites"."pub_len"(NEW."sessionRef", 1, 100), 'pub_events: длина сырых полей ≤ 100');
  PERFORM "sites"."pub_chk"(NEW."referrerHost" IS NULL OR NEW."referrerHost" ~ '^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$',
    'pub_events.referrerHost: только хост');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_looks_contact"(NEW."contentSlugRaw") AND NOT "sites"."pub_looks_contact"(NEW."placementCodeRaw"),
    'pub_events: контакт в сырых полях запрещён');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."channelGroup", "sites"."pub_channel_groups"()), 'pub_events.channelGroup: вне списка');
  PERFORM "sites"."pub_chk"(NEW."channelGroup" IS DISTINCT FROM 'paid_placement' OR NEW."placementId" IS NOT NULL,
    'pub_events: paid_placement только при найденном размещении');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"((NEW."eventId", NEW."name", NEW."occurredAt", NEW."leadId", NEW."sessionRef")
                               IS NOT DISTINCT FROM (OLD."eventId", OLD."name", OLD."occurredAt", OLD."leadId", OLD."sessionRef"),
      'pub_events: событие неизменно (обогащение пишет только свои поля)');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_events_guard" BEFORE INSERT OR UPDATE ON "pub_events"
  FOR EACH ROW EXECUTE FUNCTION "pub_events_guard"();

CREATE FUNCTION "pub_lead_outbox_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = 'lead_received', 'pub_lead_outbox.kind: lead_received');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['pending', 'processing', 'done', 'failed']), 'pub_lead_outbox.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."attempts" >= 0 AND "sites"."pub_len"(NEW."lastErrorCode", 1, 100), 'pub_lead_outbox: attempts ≥ 0, код ошибки ≤ 100');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_lead_outbox_guard" BEFORE INSERT OR UPDATE ON "pub_lead_outbox"
  FOR EACH ROW EXECUTE FUNCTION "pub_lead_outbox_guard"();

CREATE FUNCTION "pub_notifications_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['new_lead', 'retention_review', 'contact_overdue']), 'pub_notifications.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['pending', 'sending', 'sent', 'failed', 'dead', 'suppressed']), 'pub_notifications.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."attempts" >= 0 AND "sites"."pub_len"(NEW."lastErrorCode", 1, 100), 'pub_notifications: attempts ≥ 0, код ошибки ≤ 100');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'sent' OR NEW."sentAt" IS NOT NULL, 'pub_notifications: sent требует sentAt');
  -- Не рабочий продукт — реальным получателям не доставляется (раздел 3.1).
  PERFORM "sites"."pub_chk"(NEW."status" = 'suppressed'
      OR EXISTS (SELECT 1 FROM "sites"."pub_products" p WHERE p."id" = NEW."productId" AND p."kind" = 'working'),
    'pub_notifications.status: в продукте kind≠working только suppressed');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_notifications_guard" BEFORE INSERT OR UPDATE ON "pub_notifications"
  FOR EACH ROW EXECUTE FUNCTION "pub_notifications_guard"();

CREATE FUNCTION "pub_queue_checks_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."openCount" >= 0 AND NEW."overdueCount" >= 0, 'pub_queue_checks: счётчики ≥ 0');
  PERFORM "sites"."pub_chk"(NEW."checkedBy" ~ '^member:', 'pub_queue_checks.checkedBy: отмечает человек (member:)');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_queue_checks_guard" BEFORE INSERT OR UPDATE ON "pub_queue_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_queue_checks_guard"();
CREATE TRIGGER "pub_queue_checks_ao" BEFORE UPDATE OR DELETE ON "pub_queue_checks"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

-- ══ Гварды таблиц: отчёты, эксперименты, бэкап (6.6) ═════════════════════

CREATE FUNCTION "pub_metric_imports_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."source" = ANY (ARRAY['search_console', 'web_analytics', 'manual']), 'pub_metric_imports.source: вне списка');
  PERFORM "sites"."pub_chk"(NEW."granularity" = 'kyiv_day', 'pub_metric_imports.granularity: kyiv_day');
  PERFORM "sites"."pub_chk"(NEW."periodEnd" >= NEW."periodStart", 'pub_metric_imports.periodEnd: не раньше periodStart');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."payload", 1048576), 'pub_metric_imports.payload: ≤ 1 МБ');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."fileRef", 1, 500) AND "sites"."pub_len"(NEW."note", 1, 2000), 'pub_metric_imports: длина текстового поля');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_metric_imports_guard" BEFORE INSERT OR UPDATE ON "pub_metric_imports"
  FOR EACH ROW EXECUTE FUNCTION "pub_metric_imports_guard"();
CREATE TRIGGER "pub_metric_imports_ao" BEFORE UPDATE OR DELETE ON "pub_metric_imports"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

-- Эксперимент: существенные поля неизменны после регистрации, вехи t0…t90 —
-- однократно NULL → значение (AT-CORE-23 на уровне базы, раздел 6.6).
CREATE FUNCTION "pub_experiments_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "sites"."pub_chk"(false, 'pub_experiments: удаление запрещено — новая версия (supersedes)');
    RETURN OLD;
  END IF;
  PERFORM "sites"."pub_chk"(NEW."key" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$' AND NEW."version" >= 1, 'pub_experiments.key/version');
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['pilot', 'change']), 'pub_experiments.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['registered', 'running', 'concluded', 'cancelled', 'superseded']), 'pub_experiments.status: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."conclusion", ARRAY['supported', 'not_supported', 'inconclusive']), 'pub_experiments.conclusion: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."decision", ARRAY['continue_limited', 'fix_stage', 'stop_purchases', 'test_external_order', 'scale']),
    'pub_experiments.decision: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."hypothesis") BETWEEN 1 AND 2000 AND char_length(NEW."change") BETWEEN 1 AND 2000
      AND char_length(NEW."metric") BETWEEN 1 AND 2000 AND char_length(NEW."expectedSignal") BETWEEN 1 AND 2000
      AND char_length(NEW."stopConditions") BETWEEN 1 AND 2000 AND "sites"."pub_len"(NEW."conclusionReason", 1, 2000),
    'pub_experiments: длина текстового поля');
  PERFORM "sites"."pub_chk"(NEW."windowEnd" > NEW."windowStart", 'pub_experiments.windowEnd: позже windowStart');
  PERFORM "sites"."pub_chk"(NEW."limitMinor" IS NULL OR NEW."limitMinor" >= 0, 'pub_experiments.limitMinor: ≥ 0');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."thresholds") = 'object' AND "sites"."pub_jsize"(NEW."thresholds", 16384), 'pub_experiments.thresholds: объект ≤ 16 КБ');
  PERFORM "sites"."pub_chk"(NEW."appliedAt" IS NULL OR NEW."appliedAt" >= NEW."registeredAt",
    'pub_experiments.appliedAt: изменение регистрируется до применения');
  PERFORM "sites"."pub_chk"(NEW."kind" = 'pilot' OR (NEW."t0Planned" IS NULL AND NEW."t0" IS NULL),
    'pub_experiments: t0Planned/t0…t90 — только у pilot');
  PERFORM "sites"."pub_chk"((NEW."t0" IS NULL AND NEW."t42" IS NULL AND NEW."t72" IS NULL AND NEW."t90" IS NULL)
      OR (NEW."t0" IS NOT NULL AND NEW."t42" > NEW."t0" AND NEW."t72" > NEW."t42" AND NEW."t90" > NEW."t72"),
    'pub_experiments: t0, t42, t72, t90 ставятся вместе и по порядку');
  PERFORM "sites"."pub_chk"(NEW."supersedesId" IS NULL OR NEW."supersedesId" <> NEW."id", 'pub_experiments.supersedesId: не на себя');
  PERFORM "sites"."pub_chk"(NEW."decision" IS NULL OR (NEW."decidedBy" IS NOT NULL AND NEW."decidedAt" IS NOT NULL),
    'pub_experiments: решение требует decidedBy и decidedAt');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"((NEW."key", NEW."version", NEW."kind", NEW."hypothesis", NEW."change", NEW."metric", NEW."expectedSignal",
                                NEW."stopConditions", NEW."thresholds", NEW."windowStart", NEW."windowEnd", NEW."limitMinor",
                                NEW."baselineVersionId", NEW."newVersionId", NEW."registeredAt")
                               IS NOT DISTINCT FROM
                               (OLD."key", OLD."version", OLD."kind", OLD."hypothesis", OLD."change", OLD."metric", OLD."expectedSignal",
                                OLD."stopConditions", OLD."thresholds", OLD."windowStart", OLD."windowEnd", OLD."limitMinor",
                                OLD."baselineVersionId", OLD."newVersionId", OLD."registeredAt"),
      'pub_experiments: гипотеза, изменение, метрика, пороги, окно, лимит и версии неизменны — новая версия эксперимента');
    PERFORM "sites"."pub_chk"(OLD."t0" IS NULL OR (NEW."t0", NEW."t42", NEW."t72", NEW."t90") IS NOT DISTINCT FROM (OLD."t0", OLD."t42", OLD."t72", OLD."t90"),
      'pub_experiments: t0…t90 ставятся один раз');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_experiments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pub_experiments"
  FOR EACH ROW EXECUTE FUNCTION "pub_experiments_guard"();

-- Материалы эксперимента: добавляются, пока он registered; не удаляются.
CREATE FUNCTION "pub_experiment_contents_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "sites"."pub_chk"(false, 'pub_experiment_contents: связи материалов неизменны — новая версия эксперимента');
    RETURN OLD;
  END IF;
  PERFORM "sites"."pub_chk"("sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId")
      OR EXISTS (SELECT 1 FROM "sites"."pub_experiments" e WHERE e."id" = NEW."experimentId" AND e."status" = 'registered'),
    'pub_experiment_contents: материалы добавляются только к эксперименту в статусе registered');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_experiment_contents_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pub_experiment_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_experiment_contents_guard"();

CREATE FUNCTION "pub_reports_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['weekly', 'd42', 'd72', 'd90', 'late_cohort', 'ad_hoc']), 'pub_reports.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."periodEnd" >= NEW."periodStart", 'pub_reports.periodEnd: не раньше periodStart');
  PERFORM "sites"."pub_chk"(NEW."attributionModel" = 'last_non_direct_30d', 'pub_reports.attributionModel: last_non_direct_30d');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."inputsHash"), 'pub_reports.inputsHash: sha256 hex');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."recomputeReason", ARRAY['late_decision', 'late_payment', 'identity_change', 'manual', 'decision']),
    'pub_reports.recomputeReason: вне списка');
  PERFORM "sites"."pub_chk"((NEW."supersedesReportId" IS NULL) = (NEW."recomputeReason" IS NULL),
    'pub_reports: снимок-наследник ⇔ причина пересчёта');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."metrics", 1048576) AND "sites"."pub_jsize"(NEW."costs", 262144)
      AND "sites"."pub_jsize"(NEW."sources", 65536) AND "sites"."pub_jsize"(NEW."cohort", 8192), 'pub_reports: размер jsonb');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."assumptions", 1, 20000) AND "sites"."pub_len"(NEW."decision", 1, 4000), 'pub_reports: длина текстового поля');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reports_guard" BEFORE INSERT OR UPDATE ON "pub_reports"
  FOR EACH ROW EXECUTE FUNCTION "pub_reports_guard"();
CREATE TRIGGER "pub_reports_ao" BEFORE UPDATE OR DELETE ON "pub_reports"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"();

CREATE FUNCTION "pub_backups_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['weekly', 'post_purchase', 'manual']), 'pub_backups.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['ok', 'failed', 'expired_deleted']), 'pub_backups.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."sizeBytes" >= 0 AND char_length(NEW."keyVersion") BETWEEN 1 AND 20
      AND char_length(NEW."blobPathEnc") BETWEEN 1 AND 4096, 'pub_backups: размер, версия ключа, путь');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'ok' OR "sites"."pub_hex64"(NEW."sha256"), 'pub_backups.sha256: hex у успешной копии');
  -- Аудит P3-8: путь копии — только шифротекст v<N>.<iv>.<tag>.<шифр>
  -- версии keyVersion (путь в Blob открытым текстом не хранится).
  PERFORM "sites"."pub_chk"(NEW."blobPathEnc" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
      AND split_part(NEW."blobPathEnc", '.', 1) = NEW."keyVersion",
    'pub_backups.blobPathEnc: только шифротекст версии keyVersion');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."tableCounts") = 'object', 'pub_backups.tableCounts: объект');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_backups_guard" BEFORE INSERT OR UPDATE ON "pub_backups"
  FOR EACH ROW EXECUTE FUNCTION "pub_backups_guard"();

CREATE FUNCTION "pub_restores_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."mode" = ANY (ARRAY['dry_run', 'apply_new_product']), 'pub_restores.mode: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['running', 'done', 'failed']), 'pub_restores.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."mode" = 'apply_new_product' OR NEW."targetProductId" IS NULL, 'pub_restores.targetProductId: у dry_run — NULL');
  PERFORM "sites"."pub_chk"(NOT (NEW."mode" = 'apply_new_product' AND NEW."status" = 'done') OR NEW."targetProductId" IS NOT NULL,
    'pub_restores: применённое восстановление указывает новый продукт');
  PERFORM "sites"."pub_chk"(NEW."targetProductId" IS NULL
      OR EXISTS (SELECT 1 FROM "sites"."pub_products" p WHERE p."id" = NEW."targetProductId" AND p."kind" = 'restored'),
    'pub_restores.targetProductId: продукт kind=restored');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."report") = 'object' AND "sites"."pub_jsize"(NEW."report", 262144), 'pub_restores.report: объект ≤ 256 КБ');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_restores_guard" BEFORE INSERT OR UPDATE ON "pub_restores"
  FOR EACH ROW EXECUTE FUNCTION "pub_restores_guard"();

-- ══ Гварды таблиц: AI (6.7) ══════════════════════════════════════════════

-- Конфигурация — в eval-продукте; passed — только по live-прогону, где все 30
-- задач оценены человеком: criticalPass у всех, usefulnessPass ≥ 24 (12.6).
CREATE FUNCTION "pub_eval_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r_mode TEXT;
  graded INTEGER;
  critical_ok INTEGER;
  useful INTEGER;
  blocking INTEGER;
BEGIN
  PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_products" p WHERE p."id" = NEW."productId" AND p."kind" = 'eval'),
    'pub_ai_configs: конфигурация принадлежит продукту kind=eval');
  PERFORM "sites"."pub_chk"(NEW."evalStatus" = ANY (ARRAY['not_run', 'passed', 'failed', 'blocked']), 'pub_ai_configs.evalStatus: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."configHash"), 'pub_ai_configs.configHash: sha256 hex');
  PERFORM "sites"."pub_chk"(char_length(NEW."provider") BETWEEN 1 AND 50 AND char_length(NEW."model") BETWEEN 1 AND 100
      AND char_length(NEW."contextRulesVersion") BETWEEN 1 AND 50 AND char_length(NEW."schemaSetVersion") BETWEEN 1 AND 50
      AND char_length(NEW."evalSetVersion") BETWEEN 1 AND 20 AND "sites"."pub_len"(NEW."basis", 1, 2000), 'pub_ai_configs: длина текстового поля');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."instructionVersions") = 'object' AND jsonb_typeof(NEW."coveredGenerators") = 'array'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."coveredGenerators") g
                       WHERE jsonb_typeof(g) <> 'string' OR (g #>> '{}') <> ALL ("sites"."pub_generators"())),
    'pub_ai_configs: instructionVersions — объект, coveredGenerators — массив генераторов');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"((NEW."provider", NEW."model", NEW."contextRulesVersion", NEW."schemaSetVersion", NEW."instructionVersions",
                                NEW."configHash", NEW."coveredGenerators", NEW."evalSetVersion")
                               IS NOT DISTINCT FROM (OLD."provider", OLD."model", OLD."contextRulesVersion", OLD."schemaSetVersion",
                                OLD."instructionVersions", OLD."configHash", OLD."coveredGenerators", OLD."evalSetVersion"),
      'pub_ai_configs: состав конфигурации неизменен — новая конфигурация');
  END IF;
  IF NEW."evalStatus" = 'passed' THEN
    PERFORM "sites"."pub_chk"(NEW."decidedBy" ~ '^member:' AND NEW."decidedAt" IS NOT NULL AND char_length(btrim(COALESCE(NEW."basis", ''))) >= 10,
      'pub_ai_configs: passed — решение человека с основанием');
    SELECT r."mode" INTO r_mode FROM "sites"."pub_ai_eval_runs" r WHERE r."id" = NEW."evalRunId" AND r."configId" = NEW."id";
    PERFORM "sites"."pub_chk"(r_mode = 'live' AND NEW."provider" <> 'fake', 'pub_ai_configs: passed только по прогону mode=live этой конфигурации (не fake)');
    -- Аудит P-B2 S1-1: допуск по ПЕРВОМУ ответу каждой задачи (самая
    -- ранняя строка с ответом модели; повтор — отдельная строка и первый
    -- не заменяет); жёсткий автопровал или criticalPass ≠ true в ЛЮБОЙ
    -- строке с ответом (в т. ч. в повторе) блокирует допуск. Ответом не
    -- считаются только строки not_run:* (модель не вызывалась) и
    -- no_answer:* (провайдер не вернул ответа, расхода нет); обрезанный,
    -- пустой, не-JSON оплаченный ответ — ответ и провал (предаудит D2-01).
    SELECT count(*), count(*) FILTER (WHERE x."criticalPass"), count(*) FILTER (WHERE x."usefulnessPass")
      INTO graded, critical_ok, useful
      FROM (SELECT DISTINCT ON (er."taskCode") er."taskCode", er."criticalPass", er."usefulnessPass"
              FROM "sites"."pub_ai_eval_results" er
             WHERE er."runId" = NEW."evalRunId"
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(er."autoHardFail") h WHERE h ->> 'code' ~ '^(not_run|no_answer):')
             ORDER BY er."taskCode", er."createdAt" ASC, er."id" ASC) x
     WHERE x."criticalPass" IS NOT NULL AND x."usefulnessPass" IS NOT NULL;
    SELECT count(*) INTO blocking
      FROM "sites"."pub_ai_eval_results" er
     WHERE er."runId" = NEW."evalRunId"
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(er."autoHardFail") h WHERE h ->> 'code' ~ '^(not_run|no_answer):')
       AND (er."criticalPass" IS DISTINCT FROM TRUE OR jsonb_array_length(er."autoHardFail") > 0);
    PERFORM "sites"."pub_chk"(graded = 30 AND critical_ok = 30 AND useful >= 24 AND blocking = 0,
      'pub_ai_configs: passed требует 30 оценённых задач по первому ответу, criticalPass у всех строк (и повторов), usefulnessPass ≥ 24');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_eval_guard" BEFORE INSERT OR UPDATE ON "pub_ai_configs"
  FOR EACH ROW EXECUTE FUNCTION "pub_eval_guard"();

CREATE FUNCTION "pub_ai_config_bindings_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"("sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId")
      OR EXISTS (SELECT 1 FROM "sites"."pub_products" p WHERE p."id" = NEW."productId" AND p."kind" = 'working'),
    'pub_ai_config_bindings: привязка — у рабочего продукта (kind=working)');
  PERFORM "sites"."pub_chk"(char_length(btrim(NEW."basis")) BETWEEN 1 AND 2000, 'pub_ai_config_bindings.basis: длина 1..2000');
  PERFORM "sites"."pub_chk"((NEW."unboundAt" IS NULL) = (NEW."unboundBy" IS NULL), 'pub_ai_config_bindings.unbound*: вместе');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(OLD."unboundAt" IS NULL, 'pub_ai_config_bindings: снятая привязка неизменна');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_ai_config_bindings_guard" BEFORE INSERT OR UPDATE ON "pub_ai_config_bindings"
  FOR EACH ROW EXECUTE FUNCTION "pub_ai_config_bindings_guard"();
CREATE TRIGGER "pub_ai_config_bindings_ao" BEFORE UPDATE OR DELETE ON "pub_ai_config_bindings"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('unboundAt', 'unboundBy');

CREATE FUNCTION "pub_ai_tasks_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."generator" = ANY ("sites"."pub_generators"()), 'pub_ai_tasks.generator: вне списка');
  PERFORM "sites"."pub_chk"(NEW."objectType" = ANY ("sites"."pub_object_types"()) AND char_length(NEW."objectId") BETWEEN 1 AND 100,
    'pub_ai_tasks.objectType/objectId');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['open', 'done', 'needs_human']), 'pub_ai_tasks.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."extraAllowance" >= 0 AND NEW."generationsUsed" >= 0, 'pub_ai_tasks: счётчики ≥ 0');
  PERFORM "sites"."pub_chk"(NEW."generationsUsed" <= 2 + NEW."extraAllowance", 'pub_ai_tasks: генераций не больше 2 + extraAllowance');
  PERFORM "sites"."pub_chk"(NEW."extraAllowance" = 0 OR EXISTS (SELECT 1 FROM "sites"."pub_approvals" a
                                                               WHERE a."id" = NEW."extraApprovalId" AND a."type" = 'ai_extra_generation'),
    'pub_ai_tasks: доп. генерация только по согласованию ai_extra_generation');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_ai_tasks_guard" BEFORE INSERT OR UPDATE ON "pub_ai_tasks"
  FOR EACH ROW EXECUTE FUNCTION "pub_ai_tasks_guard"();

CREATE FUNCTION "pub_ai_budget_months_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$', 'pub_ai_budget_months.month: YYYY-MM');
  PERFORM "sites"."pub_chk"(NEW."capMicroUsd" >= 0 AND NEW."reservedMicroUsd" >= 0 AND NEW."spentMicroUsd" >= 0, 'pub_ai_budget_months: суммы ≥ 0');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_ai_budget_months_guard" BEFORE INSERT OR UPDATE ON "pub_ai_budget_months"
  FOR EACH ROW EXECUTE FUNCTION "pub_ai_budget_months_guard"();

CREATE FUNCTION "pub_ai_calls_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."generator" = ANY ("sites"."pub_generators"()), 'pub_ai_calls.generator: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['running', 'ok', 'schema_invalid', 'refused', 'timeout', 'unavailable', 'empty', 'truncated',
      'budget_blocked', 'unpriced_blocked', 'not_evaluated', 'disabled']), 'pub_ai_calls.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."costStatus" = ANY (ARRAY['priced', 'unpriced', 'unknown']), 'pub_ai_calls.costStatus: вне списка');
  -- Неизвестная стоимость — не ноль (принцип 2).
  PERFORM "sites"."pub_chk"((NEW."costStatus" = 'priced') = (NEW."costMicroUsd" IS NOT NULL) AND (NEW."costMicroUsd" IS NULL OR NEW."costMicroUsd" >= 0),
    'pub_ai_calls.costMicroUsd: задан ⇔ costStatus=priced, ≥ 0');
  PERFORM "sites"."pub_chk"((NEW."status" = 'running') = (NEW."finishedAt" IS NULL), 'pub_ai_calls.finishedAt: NULL ⇔ running');
  PERFORM "sites"."pub_chk"(NEW."attemptNo" >= 1, 'pub_ai_calls.attemptNo: ≥ 1');
  PERFORM "sites"."pub_chk"((NEW."inputTokens" IS NULL OR NEW."inputTokens" >= 0) AND (NEW."cachedInputTokens" IS NULL OR NEW."cachedInputTokens" >= 0)
      AND (NEW."outputTokens" IS NULL OR NEW."outputTokens" >= 0), 'pub_ai_calls: токены ≥ 0');
  PERFORM "sites"."pub_chk"(NEW."rawExcerpt" IS NULL OR (NEW."status" = 'schema_invalid' AND char_length(NEW."rawExcerpt") <= 4000),
    'pub_ai_calls.rawExcerpt: ≤ 4000 и только при schema_invalid');
  PERFORM "sites"."pub_chk"("sites"."pub_uuid4"(NEW."opKey"), 'pub_ai_calls.opKey: UUID v4');
  PERFORM "sites"."pub_chk"(NEW."requestedBy" ~ '^member:' OR NEW."requestedBy" = 'system:eval' OR "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId"),
    'pub_ai_calls.requestedBy: member: или system:eval');
  PERFORM "sites"."pub_chk"(char_length(NEW."purpose") BETWEEN 1 AND 200 AND char_length(NEW."instructionVersion") BETWEEN 1 AND 100
      AND char_length(NEW."contextRulesVersion") BETWEEN 1 AND 50 AND char_length(NEW."provider") BETWEEN 1 AND 50
      AND char_length(NEW."model") BETWEEN 1 AND 100 AND "sites"."pub_len"(NEW."errorCode", 1, 100), 'pub_ai_calls: длина текстового поля');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."output", 262144), 'pub_ai_calls.output: ≤ 256 КБ');
  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    PERFORM "sites"."pub_chk"(OLD."status" = 'running', 'pub_ai_calls.status: завершённый вызов неизменен');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_ai_calls_guard" BEFORE INSERT OR UPDATE ON "pub_ai_calls"
  FOR EACH ROW EXECUTE FUNCTION "pub_ai_calls_guard"();
CREATE TRIGGER "pub_ai_calls_ao" BEFORE UPDATE OR DELETE ON "pub_ai_calls"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('finishedAt', 'status', 'inputTokens', 'cachedInputTokens', 'outputTokens',
    'costMicroUsd', 'costStatus', 'output', 'rawExcerpt', 'errorCode', 'updatedAt');

-- Журнальный снимок источников вызова: только существующие источники
-- этого продукта (аудит P2-27).
CREATE FUNCTION "pub_ai_sources_exist"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."sourceIds") = 'array' AND jsonb_array_length(NEW."sourceIds") <= 500, 'pub_ai_calls.sourceIds: массив ≤ 500');
  PERFORM "sites"."pub_chk"(NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."sourceIds") e
       WHERE jsonb_typeof(e) <> 'string'
          OR NOT EXISTS (SELECT 1 FROM "sites"."pub_sources" s WHERE s."id" = (e #>> '{}') AND s."productId" = NEW."productId")),
    'pub_ai_calls.sourceIds: id источников этого продукта');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_ai_sources_exist" BEFORE INSERT ON "pub_ai_calls"
  FOR EACH ROW EXECUTE FUNCTION "pub_ai_sources_exist"();

CREATE FUNCTION "pub_ai_eval_runs_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."mode" = ANY (ARRAY['fake', 'live']), 'pub_ai_eval_runs.mode: вне списка');
  -- Аудит P-B2 S2-3: прогон live — только у конфигурации не-fake провайдера.
  PERFORM "sites"."pub_chk"(NEW."mode" <> 'live' OR EXISTS (SELECT 1 FROM "sites"."pub_ai_configs" c
                                                           WHERE c."id" = NEW."configId" AND c."provider" <> 'fake'),
    'pub_ai_eval_runs: mode=live — не у fake-конфигурации');
  PERFORM "sites"."pub_chk"(NEW."finishedAt" IS NULL OR NEW."finishedAt" >= NEW."startedAt", 'pub_ai_eval_runs.finishedAt: не раньше startedAt');
  PERFORM "sites"."pub_chk"(NEW."totals" IS NULL OR (jsonb_typeof(NEW."totals") = 'object' AND "sites"."pub_jsize"(NEW."totals", 65536)),
    'pub_ai_eval_runs.totals: объект ≤ 64 КБ');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."mode" = OLD."mode" AND NEW."configId" = OLD."configId", 'pub_ai_eval_runs: режим и конфигурация неизменны');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_ai_eval_runs_guard" BEFORE INSERT OR UPDATE ON "pub_ai_eval_runs"
  FOR EACH ROW EXECUTE FUNCTION "pub_ai_eval_runs_guard"();

CREATE FUNCTION "pub_ai_eval_results_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."taskCode" ~ '^AI-(0[1-9]|[12][0-9]|30)$', 'pub_ai_eval_results.taskCode: AI-01…AI-30');
  PERFORM "sites"."pub_chk"(NEW."schema" = ANY (ARRAY['answer', 'brief', 'qa', 'adaptation']), 'pub_ai_eval_results.schema: вне списка');
  PERFORM "sites"."pub_chk"(NEW."costStatus" = ANY (ARRAY['priced', 'unpriced', 'unknown']), 'pub_ai_eval_results.costStatus: вне списка');
  PERFORM "sites"."pub_chk"((NEW."costStatus" = 'priced') = (NEW."costMicroUsd" IS NOT NULL), 'pub_ai_eval_results.costMicroUsd: задан ⇔ priced');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."autoHardFail") = 'array' AND jsonb_typeof(NEW."autoFlags") = 'array'
      AND jsonb_typeof(NEW."flagResolutions") = 'array' AND jsonb_typeof(NEW."allowedSourceIds") = 'array',
    'pub_ai_eval_results: autoHardFail, autoFlags, flagResolutions, allowedSourceIds — массивы');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."firstAnswerRaw", 0, 100000) AND "sites"."pub_len"(NEW."explanation", 1, 4000),
    'pub_ai_eval_results: длина текстового поля');
  PERFORM "sites"."pub_chk"(NEW."retryOfResultId" IS NULL OR NEW."retryOfResultId" <> NEW."id", 'pub_ai_eval_results.retryOfResultId: не на себя');
  -- Предаудит D2-01: «нет ответа» (not_run:/no_answer:) — только без текста
  -- ответа и без расхода; оплаченный обрезанный/пустой ответ так не пометить.
  PERFORM "sites"."pub_chk"(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."autoHardFail") h
                                         WHERE h ->> 'code' ~ '^(not_run|no_answer):')
      OR (NEW."firstAnswerRaw" IS NULL AND COALESCE(NEW."costMicroUsd", 0) = 0),
    'pub_ai_eval_results: «нет ответа» — только без ответа и без расхода');
  -- Аудит P-B2 S2-3: жёсткий автопровал — critical_pass=false без участия человека.
  PERFORM "sites"."pub_chk"(NEW."criticalPass" IS DISTINCT FROM TRUE OR jsonb_array_length(NEW."autoHardFail") = 0,
    'pub_ai_eval_results: criticalPass=true невозможен при жёстком автопровале');
  -- Аудит P3-13: каждый флаг автопроверки разобран человеком до оценки.
  IF NEW."criticalPass" IS NOT NULL OR NEW."usefulnessPass" IS NOT NULL THEN
    PERFORM "sites"."pub_chk"(jsonb_array_length(NEW."flagResolutions") >= jsonb_array_length(NEW."autoFlags"),
      'pub_ai_eval_results: оценка — после разбора каждого флага (flagResolutions ≥ autoFlags)');
  END IF;
  -- Аудит P3-13: прогон — основание конфигурации passed: его результаты
  -- (оценки, повторы) больше не меняются.
  PERFORM "sites"."pub_chk"(NOT EXISTS (SELECT 1 FROM "sites"."pub_ai_configs" c
                                         WHERE c."evalRunId" = NEW."runId" AND c."evalStatus" = 'passed'),
    'pub_ai_eval_results: прогон — основание passed-конфигурации, результаты неизменны');
  -- Оценка человека — с объяснением и автором (12.6).
  PERFORM "sites"."pub_chk"((NEW."criticalPass" IS NULL AND NEW."usefulnessPass" IS NULL)
      OR (NEW."reviewerMemberId" IS NOT NULL AND char_length(btrim(COALESCE(NEW."explanation", ''))) > 0),
    'pub_ai_eval_results: оценка требует reviewerMemberId и explanation');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_ai_eval_results_guard" BEFORE INSERT OR UPDATE ON "pub_ai_eval_results"
  FOR EACH ROW EXECUTE FUNCTION "pub_ai_eval_results_guard"();
CREATE TRIGGER "pub_ai_eval_results_ao" BEFORE UPDATE OR DELETE ON "pub_ai_eval_results"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('criticalPass', 'usefulnessPass', 'explanation', 'reviewerMemberId',
    'secondReviewerMemberId', 'flagResolutions', 'updatedAt');

-- ══ TRUNCATE журналов (аудит P3-4) ══════════════════════════════════════
-- Append-only таблицы, голова параметров и эксперименты: TRUNCATE (минуя
-- построчные триггеры) — тоже удаление истории.

CREATE TRIGGER "pub_parameter_decisions_no_truncate" BEFORE TRUNCATE ON "pub_parameter_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_role_grants_no_truncate" BEFORE TRUNCATE ON "pub_role_grants"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_audit_events_no_truncate" BEFORE TRUNCATE ON "pub_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_source_revocations_no_truncate" BEFORE TRUNCATE ON "pub_source_revocations"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_qa_checks_no_truncate" BEFORE TRUNCATE ON "pub_qa_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_approvals_no_truncate" BEFORE TRUNCATE ON "pub_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_reserve_moves_no_truncate" BEFORE TRUNCATE ON "pub_reserve_moves"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_expense_entries_no_truncate" BEFORE TRUNCATE ON "pub_expense_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_lead_prospect_links_no_truncate" BEFORE TRUNCATE ON "pub_lead_prospect_links"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_lead_decisions_no_truncate" BEFORE TRUNCATE ON "pub_lead_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_erasures_no_truncate" BEFORE TRUNCATE ON "pub_erasures"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_queue_checks_no_truncate" BEFORE TRUNCATE ON "pub_queue_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_metric_imports_no_truncate" BEFORE TRUNCATE ON "pub_metric_imports"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_reports_no_truncate" BEFORE TRUNCATE ON "pub_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_ai_config_bindings_no_truncate" BEFORE TRUNCATE ON "pub_ai_config_bindings"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_ai_calls_no_truncate" BEFORE TRUNCATE ON "pub_ai_calls"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_ai_eval_results_no_truncate" BEFORE TRUNCATE ON "pub_ai_eval_results"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_parameters_no_truncate" BEFORE TRUNCATE ON "pub_parameters"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_experiments_no_truncate" BEFORE TRUNCATE ON "pub_experiments"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();
CREATE TRIGGER "pub_experiment_contents_no_truncate" BEFORE TRUNCATE ON "pub_experiment_contents"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();

-- ══ Публичные представления (раздел 6.5; решение координатора по Р-PUB-5) ══
--
-- Публичный код (`publisher/public/**`, роль publisher_public) читает продукт
-- и опубликованный контент ТОЛЬКО через эти два представления. Они
-- выполняются с правами владельца (security_invoker выключен), поэтому роли
-- не нужны права на pub_products, pub_parameters, site_hosts и прочее.
--
-- Значения параметров (контракт для P-A1 `contracts/parameters.ts`):
--   form_limit          {"count": 5, "windowSec": 600}
--   alt_contact         любой jsonb (отдаётся как есть)
--   analytics_storage   "none" | "session"
--   consent_map         {"default": "granted|denied|unknown|not_required", …}
--   data_notice_version {"version": "…", "text": "…"}
--   test_hosts          ["https://test.example", …] — список Origin
-- Публичному чтению доступно утверждённое значение, а в режиме `test` — ещё
-- и допущение, ЗАПИСАННОЕ РЕШЕНИЕМ (тестовый стенд работает на своих
-- допущениях, раздел 3.1; посев без решения не читается — аудит P2-1).
--
-- Аудит P3-1: архивный продукт и продукты eval/restored в представлении
-- отсутствуют; у продукта, который ещё ни разу не был live и сейчас
-- closed, оффер, FAQ и уведомление о данных не отдаются (сайт ещё не
-- запущен); альтернативный контакт закрытой формы — отдаётся (§3.2).

CREATE VIEW "pub_public_products" AS
WITH p AS (
  SELECT pr.*,
         -- Действующие значения параметров для публичного чтения.
         (SELECT pa."value" FROM "sites"."pub_parameters" pa
           WHERE pa."productId" = pr."id" AND pa."key" = 'alt_contact' AND (pa."status" = 'approved'
                OR (pr."mode" = 'test' AND pa."status" = 'assumption'
                    AND EXISTS (SELECT 1 FROM "sites"."pub_parameter_decisions" d
                                 WHERE d."productId" = pa."productId" AND d."parameterKey" = pa."key"
                                   AND d."version" = pa."version" AND d."toStatus" = 'assumption')))) AS alt_contact,
         (SELECT pa."value" FROM "sites"."pub_parameters" pa
           WHERE pa."productId" = pr."id" AND pa."key" = 'form_limit' AND (pa."status" = 'approved'
                OR (pr."mode" = 'test' AND pa."status" = 'assumption'
                    AND EXISTS (SELECT 1 FROM "sites"."pub_parameter_decisions" d
                                 WHERE d."productId" = pa."productId" AND d."parameterKey" = pa."key"
                                   AND d."version" = pa."version" AND d."toStatus" = 'assumption')))) AS form_limit,
         (SELECT pa."value" FROM "sites"."pub_parameters" pa
           WHERE pa."productId" = pr."id" AND pa."key" = 'analytics_storage' AND (pa."status" = 'approved'
                OR (pr."mode" = 'test' AND pa."status" = 'assumption'
                    AND EXISTS (SELECT 1 FROM "sites"."pub_parameter_decisions" d
                                 WHERE d."productId" = pa."productId" AND d."parameterKey" = pa."key"
                                   AND d."version" = pa."version" AND d."toStatus" = 'assumption')))) AS analytics_storage,
         (SELECT pa."value" FROM "sites"."pub_parameters" pa
           WHERE pa."productId" = pr."id" AND pa."key" = 'consent_map' AND (pa."status" = 'approved'
                OR (pr."mode" = 'test' AND pa."status" = 'assumption'
                    AND EXISTS (SELECT 1 FROM "sites"."pub_parameter_decisions" d
                                 WHERE d."productId" = pa."productId" AND d."parameterKey" = pa."key"
                                   AND d."version" = pa."version" AND d."toStatus" = 'assumption')))) AS consent_map,
         (SELECT pa."value" FROM "sites"."pub_parameters" pa
           WHERE pa."productId" = pr."id" AND pa."key" = 'test_hosts' AND (pa."status" = 'approved'
                OR (pr."mode" = 'test' AND pa."status" = 'assumption'
                    AND EXISTS (SELECT 1 FROM "sites"."pub_parameter_decisions" d
                                 WHERE d."productId" = pa."productId" AND d."parameterKey" = pa."key"
                                   AND d."version" = pa."version" AND d."toStatus" = 'assumption')))) AS test_hosts,
         -- Р-PUB-Z2-9 (запрос P-F): срок ответа заявителю на сайте.
         (SELECT pa."value" FROM "sites"."pub_parameters" pa
           WHERE pa."productId" = pr."id" AND pa."key" = 'contact_sla' AND (pa."status" = 'approved'
                OR (pr."mode" = 'test' AND pa."status" = 'assumption'
                    AND EXISTS (SELECT 1 FROM "sites"."pub_parameter_decisions" d
                                 WHERE d."productId" = pa."productId" AND d."parameterKey" = pa."key"
                                   AND d."version" = pa."version" AND d."toStatus" = 'assumption')))) AS contact_sla,
         (SELECT jsonb_build_object('version', pa."value" ->> 'version', 'text', pa."value" ->> 'text', 'approved', pa."status" = 'approved')
            FROM "sites"."pub_parameters" pa
           WHERE pa."productId" = pr."id" AND pa."key" = 'data_notice_version' AND (pa."status" = 'approved'
                OR (pr."mode" = 'test' AND pa."status" = 'assumption'
                    AND EXISTS (SELECT 1 FROM "sites"."pub_parameter_decisions" d
                                 WHERE d."productId" = pa."productId" AND d."parameterKey" = pa."key"
                                   AND d."version" = pa."version" AND d."toStatus" = 'assumption')))) AS data_notice,
         -- Подтверждённые хосты сайта: те же условия, что evaluateHostAccess(host,
         -- 'publisher-public'): verified, без блокировки повторного
         -- подтверждения, не истёк. site_hosts."expiresAt" — timestamp(3) в UTC,
         -- поэтому сравнение не зависит от TimeZone сессии (аудит P3-3).
         (SELECT COALESCE(array_agg(hh.h ORDER BY hh.h), ARRAY[]::TEXT[])
            FROM (SELECT DISTINCT h."host" || CASE WHEN h."port" = 443 THEN '' ELSE ':' || h."port" END AS h
                    FROM "sites"."site_hosts" h
                   WHERE h."siteId" = pr."siteId" AND h."accountId" = pr."accountId" AND h."scheme" = 'https'
                     AND h."status" = 'verified' AND h."reverifyBlockedAt" IS NULL
                     AND h."expiresAt" > (now() AT TIME ZONE 'UTC')) hh) AS verified_hosts
    FROM "sites"."pub_products" pr
   WHERE pr."kind" IN ('working', 'test') AND pr."status" = 'active'
)
SELECT p."id",
       p."accountId",
       p."publicKey",
       p."kind",
       p."mode",
       -- Форма открыта: live рабочего продукта с открытыми гейтами
       -- public_publish и real_leads (их параметрная часть) — или режим test.
       (p."status" = 'active'
        AND ((p."kind" = 'working' AND p."mode" = 'live' AND p."paramsPublicPublishOk" AND p."paramsRealLeadsOk")
             OR p."mode" = 'test')) AS "formOpen",
       CASE
         WHEN p."mode" = 'live' THEN ARRAY(SELECT 'https://' || x FROM unnest(p.verified_hosts) x ORDER BY 1)
         WHEN p."mode" = 'test' THEN ARRAY(SELECT o FROM jsonb_array_elements_text(
                                              CASE WHEN jsonb_typeof(p.test_hosts) = 'array' THEN p.test_hosts ELSE '[]'::jsonb END) o
                                            WHERE o ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$' ORDER BY 1)
         ELSE ARRAY[]::TEXT[]
       END AS "allowedOrigins",
       CASE WHEN p."status" = 'active' AND p."kind" = 'working' AND p."mode" = 'live' AND p."paramsPublicPublishOk"
            THEN p.verified_hosts ELSE ARRAY[]::TEXT[] END AS "indexableHosts",
       p.alt_contact AS "altContact",
       CASE WHEN (p.form_limit ->> 'count') ~ '^[0-9]{1,6}$' AND (p.form_limit ->> 'count')::INTEGER > 0
            THEN (p.form_limit ->> 'count')::INTEGER ELSE 5 END AS "formLimitCount",
       CASE WHEN (p.form_limit ->> 'windowSec') ~ '^[0-9]{1,7}$' AND (p.form_limit ->> 'windowSec')::INTEGER > 0
            THEN (p.form_limit ->> 'windowSec')::INTEGER ELSE 600 END AS "formLimitWindowSec",
       CASE WHEN (p.analytics_storage #>> '{}') IN ('none', 'session') THEN p.analytics_storage #>> '{}' ELSE 'none' END AS "analyticsStorage",
       CASE WHEN (p.consent_map ->> 'default') IN ('granted', 'denied', 'unknown', 'not_required')
            THEN p.consent_map ->> 'default' ELSE 'unknown' END AS "consentState",
       CASE WHEN p."mode" = 'closed' AND p."liveSince" IS NULL THEN NULL ELSE p.data_notice END AS "dataNotice",
       CASE WHEN p."mode" = 'closed' AND p."liveSince" IS NULL THEN '[]'::jsonb ELSE
       (SELECT COALESCE(jsonb_agg(f."value" ORDER BY f."factKey"), '[]'::jsonb)
          FROM (SELECT bf."value", bf."factKey" FROM "sites"."pub_brand_facts" bf
                 WHERE bf."productId" = p."id" AND bf."kind" = 'faq' AND bf."status" = 'active'
                 ORDER BY bf."factKey" LIMIT 5) f) END AS "faq",
       CASE WHEN p."mode" = 'closed' AND p."liveSince" IS NULL THEN NULL ELSE
       (SELECT jsonb_build_object('title', o."title", 'text', o."text", 'priceNote', o."priceNote")
          FROM "sites"."pub_offer_versions" o
         WHERE o."productId" = p."id" AND o."status" = 'active') END AS "offer",
       -- Только правило срока (`{rule}`): календарь сайту не нужен.
       CASE WHEN jsonb_typeof(p.contact_sla -> 'rule') = 'string'
            THEN jsonb_build_object('rule', p.contact_sla -> 'rule') ELSE NULL END AS "contactSla"
  FROM p;

-- Опубликованный контент: по каждой статье — последняя публикация канала
-- `site` стадии режима (test → test, иначе live), в статусе pending|published
-- и с АКТИВНЫМ согласованием ИМЕННО этой замороженной версии (аудит P1-1:
-- `objectId` = версия, `frozenAt` задан; отправка новой версии на проверку
-- страницу не снимает; результат автопроверки URL на показ не влияет).
-- Снятый материал — строка withdrawn=true без тела (ответ 410). Отозванные
-- источники в списке не показываются (ТЗ §21, аудит P3-9).
--
-- Аудит P3-3: последняя публикация выбирается подзапросом LATERAL … LIMIT 1
-- на строку материала, поэтому фильтр запроса страницы (`productId`,
-- `slug`) применяется к pub_contents ДО выбора публикаций, без сортировки
-- публикаций всех продуктов (индекс pub_publications(productId, stage, status)).
CREATE VIEW "pub_public_contents" AS
SELECT c."productId",
       c."id" AS "contentId",
       c."slug",
       v."title",
       v."body",
       (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
          FROM jsonb_each(v."meta") e
         WHERE e.key IN ('description', 'shortAnswer', 'example', 'limitations', 'editor', 'cta', 'cards', 'scenes',
                         'substantiallyUpdatedAt')) AS "meta",
       (SELECT COALESCE(jsonb_agg(CASE WHEN s."visibility" = 'public'
                                       THEN jsonb_build_object('title', s."title", 'url', s."url")
                                       ELSE jsonb_build_object('private', true) END
                                  ORDER BY s."createdAt", s."id"), '[]'::jsonb)
          FROM "sites"."pub_version_sources" vs
          JOIN "sites"."pub_sources" s ON s."id" = vs."sourceId"
         WHERE vs."versionId" = v."id" AND s."usage" <> 'revoked') AS "sources",
       v."hash" AS "versionHash",
       CASE WHEN l."stage" = 'live' THEN COALESCE(c."firstPublishedAt", l."publishedAt", l."createdAt")
            ELSE COALESCE(l."publishedAt", l."createdAt") END AS "publishedAt",
       COALESCE(l."publishedAt", l."createdAt") AS "updatedAt",
       l."stage",
       false AS "withdrawn"
  FROM "sites"."pub_contents" c
  JOIN "sites"."pub_products" pr ON pr."id" = c."productId" AND pr."kind" IN ('working', 'test') AND pr."status" = 'active'
  CROSS JOIN LATERAL (
    SELECT pu."versionId", pu."publishedAt", pu."createdAt", pu."stage"
      FROM "sites"."pub_publications" pu
      JOIN "sites"."pub_channels" ch ON ch."id" = pu."channelId" AND ch."kind" = 'site'
      JOIN "sites"."pub_content_versions" v2 ON v2."id" = pu."versionId" AND v2."contentId" = c."id"
                                            AND v2."frozenAt" IS NOT NULL
      JOIN "sites"."pub_approvals" a ON a."id" = pu."approvalId" AND a."status" = 'active'
                                    AND a."type" = 'publish_version' AND a."objectType" = 'content_version'
                                    AND a."objectId" = v2."id" AND a."versionHash" = v2."hash"
     WHERE pu."productId" = c."productId"
       AND pu."stage" = CASE WHEN pr."mode" = 'test' THEN 'test' ELSE 'live' END
       AND pu."status" IN ('pending', 'published')
     ORDER BY pu."publishedAt" DESC NULLS LAST, pu."createdAt" DESC, pu."id" DESC
     LIMIT 1) l
  JOIN "sites"."pub_content_versions" v ON v."id" = l."versionId"
 WHERE c."kind" = 'article' AND c."slug" IS NOT NULL AND c."status" <> 'withdrawn'
UNION ALL
SELECT c."productId",
       c."id",
       c."slug",
       NULL::TEXT,
       NULL::TEXT,
       NULL::JSONB,
       NULL::JSONB,
       NULL::TEXT,
       NULL::TIMESTAMPTZ(3),
       c."updatedAt",
       CASE WHEN pr."mode" = 'test' THEN 'test' ELSE 'live' END,
       true
  FROM "sites"."pub_contents" c
  JOIN "sites"."pub_products" pr ON pr."id" = c."productId" AND pr."kind" IN ('working', 'test') AND pr."status" = 'active'
 WHERE c."kind" = 'article' AND c."slug" IS NOT NULL AND c."status" = 'withdrawn'
   AND EXISTS (SELECT 1 FROM "sites"."pub_publications" pu
                 JOIN "sites"."pub_channels" ch ON ch."id" = pu."channelId" AND ch."kind" = 'site'
                 JOIN "sites"."pub_content_versions" v2 ON v2."id" = pu."versionId" AND v2."contentId" = c."id"
                WHERE pu."productId" = c."productId"
                  AND pu."stage" = CASE WHEN pr."mode" = 'test' THEN 'test' ELSE 'live' END);

-- ══ Роль publisher_public и права (раздел 6.5; Р-PUB-5) ═══════════════════
--
-- Публичные маршруты Publisher (`/public/publisher/v1/*`) ходят в базу под
-- логин-ролью, входящей в NOLOGIN-роль publisher_public (клиент
-- PublisherPublicDb, строка PUBLISHER_PUBLIC_DATABASE_URL). Правило — «ничего
-- по умолчанию, явный список»: забытый GRANT — отказ формы, а не утечка.
-- Логин-роль с паролем владелец создаёт РУКАМИ тем же способом, что для
-- assist_public (`CREATE ROLE … LOGIN PASSWORD … IN ROLE publisher_public`):
-- пароль в репозиторий не попадает. Роли общие на кластер — создание условное.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publisher_public') THEN
    CREATE ROLE publisher_public NOLOGIN;
  END IF;
  -- Аудит P3-7: роль, созданная раньше руками (общий кластер), должна быть
  -- ровно «пустой»: без входа, суперправ, обхода RLS, репликации, создания
  -- ролей/баз и без членства в других ролях — иначе миграция падает, а не
  -- молча расширяет права публичных маршрутов. (ALTER ROLE … NOSUPERUSER на
  -- Supabase не выполнить — там нет суперпользователя, поэтому проверка.)
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = 'publisher_public'
                AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolreplication OR rolcreaterole OR rolcreatedb))
     OR EXISTS (SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.member
                 WHERE r.rolname = 'publisher_public') THEN
    RAISE EXCEPTION 'роль publisher_public уже существует с лишними атрибутами или членством — исправьте её руками (NOLOGIN, без членства) и повторите миграцию';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA "sites" TO publisher_public;

-- Все pub_* закрыты для PUBLIC и обеих публичных ролей; ниже — только явный
-- список. Роль виджета (assist_public) к Publisher прав не имеет вовсе, а
-- publisher_public — к таблицам помощника и ядра (их GRANT ей никто не
-- выдаёт; проверка — publisher-public-role.spec.ts по всей схеме).
REVOKE ALL ON
  "pub_products",
  "pub_parameters",
  "pub_parameter_proposals",
  "pub_parameter_decisions",
  "pub_role_grants",
  "pub_audit_events",
  "pub_idempotency_keys",
  "pub_review_tasks",
  "pub_integrations",
  "pub_campaigns",
  "pub_rate_hits",
  "pub_sources",
  "pub_source_revocations",
  "pub_question_groups",
  "pub_questions",
  "pub_question_sources",
  "pub_brand_facts",
  "pub_offer_versions",
  "pub_offer_facts",
  "pub_briefs",
  "pub_brief_sources",
  "pub_contents",
  "pub_content_versions",
  "pub_version_sources",
  "pub_version_claims",
  "pub_version_facts",
  "pub_claims",
  "pub_claim_sources",
  "pub_qa_checks",
  "pub_approvals",
  "pub_channels",
  "pub_distribution_actions",
  "pub_publications",
  "pub_venues",
  "pub_venue_evidence",
  "pub_placements",
  "pub_budget_limits",
  "pub_reserve_moves",
  "pub_expenses",
  "pub_expense_entries",
  "pub_time_entries",
  "pub_prospects",
  "pub_lead_prospect_links",
  "pub_leads",
  "pub_lead_contacts",
  "pub_lead_decisions",
  "pub_erasures",
  "pub_payments",
  "pub_sessions",
  "pub_events",
  "pub_lead_outbox",
  "pub_notifications",
  "pub_queue_checks",
  "pub_metric_imports",
  "pub_experiments",
  "pub_experiment_contents",
  "pub_reports",
  "pub_backups",
  "pub_restores",
  "pub_ai_configs",
  "pub_ai_config_bindings",
  "pub_ai_tasks",
  "pub_ai_budget_months",
  "pub_ai_calls",
  "pub_ai_eval_runs",
  "pub_ai_eval_results"
  FROM PUBLIC, publisher_public, assist_public;
REVOKE ALL ON "pub_public_products", "pub_public_contents" FROM PUBLIC, publisher_public, assist_public;
-- Аудит P3-14: роли API Supabase (`anon`, `authenticated`) — тоже ничего,
-- даже если схему `sites` когда-нибудь откроют PostgREST (default privileges
-- Supabase выдают им права на новые таблицы). Ролей нет (CI, стенд) — пропуск.
DO $$
DECLARE
  r TEXT;
  t RECORD;
BEGIN
  FOREACH r IN ARRAY '{anon,authenticated}'::text[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'v') AND c.relname LIKE 'pub\_%'
      LOOP
        EXECUTE format('REVOKE ALL ON %I FROM %I', t.relname, r);
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- Чтение продукта по publicKey и опубликованного контента — только через
-- представления (владелец представления читает таблицы за роль).
GRANT SELECT ON "pub_public_products", "pub_public_contents" TO publisher_public;

-- Приём заявки (раздел 11.4) — минимальная запись одной транзакцией:
-- поиск повтора по (productId, submissionKey) колоночным SELECT, затем
-- INSERT заявки, шифротекста контакта, сессии, события успеха и строки
-- исходящей очереди. Обогащение, статусы, проспект и уведомления пишет
-- основная роль (задание lead-enrich), не эта.
GRANT SELECT ("id", "productId", "submissionKey", "requestHash", "publicRef", "receivedAt") ON "pub_leads" TO publisher_public;
-- Аудит P1-2, P3-6: автор (`createdBy`) и время сервера (`receivedAt`,
-- `startedAt`, `occurredAt`) роль не задаёт — их ставят DEFAULT ('public',
-- now()): вставка «restore:…» или задним числом из публичного кода
-- невозможна.
GRANT INSERT ("id", "accountId", "productId", "submissionKey", "requestHash", "publicRef", "testFlag", "testReason",
              "suspectedSpam", "contactMethod", "budgetRange", "selfReportedChannel", "contentSlugRaw", "placementCodeRaw",
              "sessionRef", "consentState", "reviewDueAt") ON "pub_leads" TO publisher_public;
GRANT INSERT ("id", "accountId", "productId", "leadId", "contactEnc", "matchHash", "keyVersion")
  ON "pub_lead_contacts" TO publisher_public;
-- Сессия создаётся первым событием (`INSERT … ON CONFLICT DO NOTHING` без
-- цели конфликта — SELECT роли не нужен), события — так же.
GRANT INSERT ("id", "accountId", "productId", "sessionRef", "landingPath", "contentSlugRaw",
              "placementCodeRaw", "utm", "consentState", "testFlag") ON "pub_sessions" TO publisher_public;
GRANT INSERT ("id", "accountId", "productId", "eventId", "name", "clientAt", "contentSlugRaw",
              "placementCodeRaw", "referrerHost", "sessionRef", "utm", "utmRedacted", "leadId", "testFlag")
  ON "pub_events" TO publisher_public;
GRANT INSERT ("id", "accountId", "productId", "leadId", "kind") ON "pub_lead_outbox" TO publisher_public;
-- Скользящее окно лимита формы (аудит P2-10): подсчёт и вставка удара.
GRANT INSERT ON "pub_rate_hits" TO publisher_public;
GRANT SELECT ("key", "at") ON "pub_rate_hits" TO publisher_public;

-- Функции этой миграции вызывают только триггеры и друг друга (под
-- владельцем, SECURITY DEFINER) — снаружи их не вызвать.
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.proname LIKE 'pub\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END
$$;
