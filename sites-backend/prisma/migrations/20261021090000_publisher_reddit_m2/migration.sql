-- AI Publisher, пакет P-R «Reddit Manual MVP», этап M2 AI Content Studio.
-- Основание: doc/ai-publisher/reddit-manual-mvp-adapted.md §3 (M2.1–M2.8),
-- §4 (гейт reddit_publish, ретенция выдержек), §5, §9, §11 (Р-RD-5…10,
-- Р-RD-17, Р-RD-48…); конвенции — IMPLEMENTATION-DESIGN.md §5.2, §6.1.
--
-- Forward-only (Р-RD-12): отката-скрипта нет; откат — флаги
-- PUBLISHER_REDDIT_ENABLED / PUBLISHER_REDDIT_AI_ENABLED = false +
-- компенсирующая миграция + бэкап P-E. Миграции 20261016* и M1
-- (20261020090000_publisher_reddit) уже выкачены и не правятся: функции,
-- которые меняются, пересоздаются здесь (CREATE OR REPLACE).
--
-- Что здесь:
--  1. pub_reddit_briefs (Р-RD-5); pub_contents.redditBriefId (Р-RD-6);
--     pub_qa_checks.warnings (Р-RD-8); pub_publications.reportKind (Р-RD-10).
--  2. Закрытые списки: pub_parameter_keys() (+ reddit_excerpt_retention_days,
--     40 ключей), pub_generators() (+ pub.reddit.draft, 10).
--  3. Пересозданные гварды ядра: pub_contents_guard (виды reddit_post |
--     reddit_comment, redditBriefId), pub_content_versions_guard (meta
--     замороженной Reddit-версии), pub_qa_checks_guard (reddit_policy ↔
--     system:reddit-policy, warnings), pub_parameter_decisions_guard
--     (+ reddit_publish), pub_eval_guard (порог по размеру набора N:
--     все критические, полезных ≥ ⌈0,8·N⌉), pub_ai_eval_results_guard
--     (AI-01…AI-42, схема reddit), pub_reddit_sources_guard (путь ретенции
--     выдержки).
--  4. Новые: pub_eval_set_size(), гварды pub_reddit_briefs_guard и
--     pub_publication_report_guard, общие триггеры брифа, триггер
--     pub_contents_same_product с redditBriefId.
--  5. Посев reddit_excerpt_retention_days (assumption, {"days":180}).
--  6. REVOKE у PUBLIC, publisher_public, assist_public, anon/authenticated.

-- ══ Таблицы, индексы, внешние ключи (из schema.prisma) ══════════════════

-- AlterTable
ALTER TABLE "pub_contents" ADD COLUMN     "redditBriefId" TEXT;

-- AlterTable
ALTER TABLE "pub_publications" ADD COLUMN     "reportKind" TEXT NOT NULL DEFAULT 'standard';

-- AlterTable
ALTER TABLE "pub_qa_checks" ADD COLUMN     "warnings" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "pub_reddit_briefs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "offerVersionId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "audience" TEXT,
    "context" TEXT,
    "keyPoints" JSONB NOT NULL DEFAULT '[]',
    "affiliation" TEXT,
    "brand" TEXT,
    "linksAllowed" BOOLEAN NOT NULL DEFAULT false,
    "tone" TEXT,
    "language" TEXT NOT NULL,
    "constraints" JSONB NOT NULL DEFAULT '[]',
    "forbiddenClaims" JSONB NOT NULL DEFAULT '[]',
    "cta" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_reddit_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pub_reddit_briefs_productId_status_idx" ON "pub_reddit_briefs"("productId", "status");

-- CreateIndex
CREATE INDEX "pub_reddit_briefs_projectId_status_idx" ON "pub_reddit_briefs"("projectId", "status");

-- CreateIndex
CREATE INDEX "pub_reddit_briefs_opportunityId_idx" ON "pub_reddit_briefs"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_briefs_id_accountId_key" ON "pub_reddit_briefs"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_contents_redditBriefId_idx" ON "pub_contents"("redditBriefId");

-- AddForeignKey
ALTER TABLE "pub_contents" ADD CONSTRAINT "pub_contents_redditBriefId_accountId_fkey" FOREIGN KEY ("redditBriefId", "accountId") REFERENCES "pub_reddit_briefs"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_briefs" ADD CONSTRAINT "pub_reddit_briefs_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_briefs" ADD CONSTRAINT "pub_reddit_briefs_projectId_accountId_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "pub_reddit_projects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_briefs" ADD CONSTRAINT "pub_reddit_briefs_communityId_accountId_fkey" FOREIGN KEY ("communityId", "accountId") REFERENCES "pub_reddit_communities"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_briefs" ADD CONSTRAINT "pub_reddit_briefs_opportunityId_accountId_fkey" FOREIGN KEY ("opportunityId", "accountId") REFERENCES "pub_reddit_opportunities"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_briefs" ADD CONSTRAINT "pub_reddit_briefs_offerVersionId_accountId_fkey" FOREIGN KEY ("offerVersionId", "accountId") REFERENCES "pub_offer_versions"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ══ Закрытые списки (= contracts/parameters.ts, contracts/ai.ts) ═════════

CREATE OR REPLACE FUNCTION "pub_parameter_keys"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['niche', 'language', 'market', 'offer_active_version', 'own_channels', 'domain_host',
               'hosting', 'attribution_tool', 'consent_map', 'analytics_storage', 'event_map', 'perf_targets',
               'data_notice_version', 'retention_policy', 'budget_total', 'budget_split', 'per_purchase_max',
               'ai_budget_usd_month', 'ai_fx_rate', 'ai_unpriced_allowed', 'rates_by_role', 'allowed_cpl_inputs',
               'investment_cpl_limit', 'dev_investment', 'cac_payment_window', 'd42_thresholds', 'd90_thresholds',
               'late_cohort_rules', 'qualification_rules', 'responsibles', 'sales_hours_t42_t72', 'contact_sla',
               'form_limit', 'alt_contact', 'test_hosts', 'pilot_calendar', 'launch_evidence_d0',
               'launch_evidence_purchase', 'reddit_rules_stale_days', 'reddit_excerpt_retention_days']
$$;

CREATE OR REPLACE FUNCTION "pub_generators"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['pub.helper.answer', 'pub.brief.draft', 'pub.qa.review', 'pub.adaptation.make',
               'pub.questions.cluster', 'pub.draft.write', 'pub.claims.extract', 'pub.distribution.plan',
               'pub.venues.compare', 'pub.reddit.draft']
$$;

-- Размер набора задач по версии (M2.3.1): 2.2 — 30 задач P0, 2.3 — 30 + 12
-- задач Reddit (AI-31…AI-42). Неизвестная версия — NULL: passed невозможен.
CREATE FUNCTION "pub_eval_set_size"(p_version TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_version WHEN '2.2' THEN 30 WHEN '2.3' THEN 42 END
$$;

-- ══ Материалы и версии: виды Reddit (Р-RD-6) ═════════════════════════════

-- Reddit-материал (`reddit_post`, `reddit_comment`) ссылается на Reddit-бриф
-- (`redditBriefId`) вместо брифа статьи и родителя: не статья и не
-- адаптация, slug нет; вид совпадает с `contentType` брифа.
CREATE OR REPLACE FUNCTION "pub_contents_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reddit BOOLEAN := NEW."kind" IN ('reddit_post', 'reddit_comment');
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['article', 'post', 'cards', 'checklist', 'video_script', 'reddit_post',
      'reddit_comment']), 'pub_contents.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['brief', 'drafting', 'editorial_review', 'changes_requested', 'approved',
      'scheduled', 'published', 'correction_required', 'revised', 'withdrawn']), 'pub_contents.status: вне списка');
  PERFORM "sites"."pub_chk"((NEW."kind" = 'article' OR reddit) = (NEW."parentContentId" IS NULL),
    'pub_contents.parentContentId: обязателен для адаптаций, запрещён для article и Reddit-материала');
  PERFORM "sites"."pub_chk"(NEW."kind" <> 'article' OR NEW."briefId" IS NOT NULL, 'pub_contents.briefId: обязателен для article');
  PERFORM "sites"."pub_chk"(reddit = (NEW."redditBriefId" IS NOT NULL) AND (NOT reddit OR NEW."briefId" IS NULL),
    'pub_contents.redditBriefId: обязателен для Reddit-материала (без briefId), запрещён для прочих');
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
  IF TG_OP = 'INSERT' AND reddit THEN
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_reddit_briefs" b
                                       WHERE b."id" = NEW."redditBriefId" AND 'reddit_' || b."contentType" = NEW."kind"),
      'pub_contents.kind: вид Reddit-материала = contentType брифа');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."kind" = OLD."kind" AND NEW."parentContentId" IS NOT DISTINCT FROM OLD."parentContentId"
        AND NEW."redditBriefId" IS NOT DISTINCT FROM OLD."redditBriefId",
      'pub_contents: kind, parentContentId и redditBriefId неизменны');
    -- firstPublishedAt ставится один раз (ДТ-1).
    PERFORM "sites"."pub_chk"(OLD."firstPublishedAt" IS NULL OR NEW."firstPublishedAt" = OLD."firstPublishedAt",
      'pub_contents.firstPublishedAt: ставится один раз');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "pub_contents_same_product" ON "pub_contents";
CREATE TRIGGER "pub_contents_same_product" BEFORE INSERT OR UPDATE ON "pub_contents"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('parentContentId', 'pub_contents', 'briefId', 'pub_briefs', 'currentVersionId',
    'pub_content_versions', 'approvedVersionId', 'pub_content_versions', 'publishedVersionId', 'pub_content_versions',
    'redditBriefId', 'pub_reddit_briefs');

-- Замороженная Reddit-версия несёт в meta то, что ставит сервер и что входит
-- в hash (Р-RD-7): affiliation (из брифа) и ruleSnapshotId — снимок правил
-- сообщества этого продукта (или null — правил нет, QA блокирует).
CREATE OR REPLACE FUNCTION "pub_content_versions_guard"() RETURNS trigger
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
  -- P-R M2 (Р-RD-7): заморозка Reddit-версии — с серверной частью meta.
  IF c_kind IN ('reddit_post', 'reddit_comment') AND NEW."frozenAt" IS NOT NULL
     AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"((NEW."meta" ->> 'affiliation') IN ('founder', 'employee', 'agency', 'customer', 'none')
        AND NEW."meta" ? 'ruleSnapshotId'
        AND jsonb_typeof(NEW."meta" -> 'ruleSnapshotId') IN ('string', 'null')
        AND (jsonb_typeof(NEW."meta" -> 'ruleSnapshotId') = 'null' OR EXISTS (
              SELECT 1 FROM "sites"."pub_reddit_rule_snapshots" r
               WHERE r."id" = NEW."meta" ->> 'ruleSnapshotId' AND r."productId" = NEW."productId")),
      'pub_content_versions.meta: замороженная Reddit-версия — affiliation и ruleSnapshotId (снимок этого продукта или null)');
  END IF;
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

-- ══ QA: reddit_policy и WARN (Р-RD-8) ════════════════════════════════════

-- reddit_policy пишет только детерминированная проверка P-R
-- (`system:reddit-policy`, без вызова AI) и только для Reddit-материала;
-- `fail` ⇔ есть блокеры. WARN (`warnings`) — только у reddit_policy.
CREATE OR REPLACE FUNCTION "pub_qa_checks_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."kind" = ANY (ARRAY['editorial', 'technical', 'ai_review', 'adaptation_meaning', 'reddit_policy']),
    'pub_qa_checks.kind: вне списка');
  PERFORM "sites"."pub_chk"(NEW."result" = ANY (ARRAY['pass', 'fail', 'unknown']), 'pub_qa_checks.result: вне списка');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."blockers") = 'array' AND "sites"."pub_jsize"(NEW."blockers", 65536), 'pub_qa_checks.blockers: массив ≤ 64 КБ');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."warnings") = 'array' AND "sites"."pub_jsize"(NEW."warnings", 65536)
      AND (NEW."kind" = 'reddit_policy' OR jsonb_array_length(NEW."warnings") = 0),
    'pub_qa_checks.warnings: массив ≤ 64 КБ, только у reddit_policy');
  -- ai_review — системный актёр и ссылка на вызов; reddit_policy —
  -- системный актёр без вызова (детерминированные правила); остальные — человек.
  PERFORM "sites"."pub_chk"(CASE NEW."kind"
                                 WHEN 'ai_review' THEN NEW."checkedBy" = 'system:ai-review' AND NEW."aiCallId" IS NOT NULL
                                 WHEN 'reddit_policy' THEN NEW."checkedBy" = 'system:reddit-policy' AND NEW."aiCallId" IS NULL
                                 ELSE NEW."checkedBy" ~ '^member:' END,
    'pub_qa_checks.checkedBy: ai_review — system:ai-review с aiCallId, reddit_policy — system:reddit-policy, иначе member:');
  IF NEW."kind" = 'reddit_policy' THEN
    PERFORM "sites"."pub_chk"(NEW."result" IN ('pass', 'fail') AND (NEW."result" = 'fail') = (jsonb_array_length(NEW."blockers") > 0)
        AND NOT NEW."selfReview",
      'pub_qa_checks: reddit_policy — pass без блокеров или fail с блокерами');
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_content_versions" v
                                        JOIN "sites"."pub_contents" c ON c."id" = v."contentId"
                                       WHERE v."id" = NEW."versionId" AND c."kind" IN ('reddit_post', 'reddit_comment')),
      'pub_qa_checks: reddit_policy — только версия Reddit-материала');
  END IF;
  RETURN NEW;
END;
$$;

-- ══ Гейт reddit_publish: этап в решениях по параметрам (Р-RD-9) ══════════

CREATE OR REPLACE FUNCTION "pub_parameter_decisions_guard"() RETURNS trigger
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
          OR (e #>> '{}') <> ALL (ARRAY['public_publish', 'real_leads', 'spend', 'purchases', 'ai_use', 'reports', 'reddit_publish'])),
    'pub_parameter_decisions.dependentStages: массив из public_publish|real_leads|spend|purchases|ai_use|reports|reddit_publish');
  RETURN NEW;
END;
$$;

-- ══ Допуск AI: порог по размеру набора (M2.3.1) ══════════════════════════

-- Конфигурация — в eval-продукте; passed — только по live-прогону, где все
-- N задач набора её версии (`pub_eval_set_size`) оценены человеком:
-- criticalPass у всех, usefulnessPass ≥ ⌈0,8·N⌉ (30 → 24, 42 → 34).
CREATE OR REPLACE FUNCTION "pub_eval_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r_mode TEXT;
  graded INTEGER;
  critical_ok INTEGER;
  useful INTEGER;
  blocking INTEGER;
  n INTEGER;
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
    n := "sites"."pub_eval_set_size"(NEW."evalSetVersion");
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
               AND substring(er."taskCode" FROM 4)::int <= COALESCE(n, 0)
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(er."autoHardFail") h WHERE h ->> 'code' ~ '^(not_run|no_answer):')
             ORDER BY er."taskCode", er."createdAt" ASC, er."id" ASC) x
     WHERE x."criticalPass" IS NOT NULL AND x."usefulnessPass" IS NOT NULL;
    SELECT count(*) INTO blocking
      FROM "sites"."pub_ai_eval_results" er
     WHERE er."runId" = NEW."evalRunId"
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(er."autoHardFail") h WHERE h ->> 'code' ~ '^(not_run|no_answer):')
       AND (er."criticalPass" IS DISTINCT FROM TRUE OR jsonb_array_length(er."autoHardFail") > 0);
    PERFORM "sites"."pub_chk"(n IS NOT NULL AND graded = n AND critical_ok = n AND useful >= (4 * n + 4) / 5 AND blocking = 0,
      'pub_ai_configs: passed требует N оценённых задач набора по первому ответу, criticalPass у всех строк (и повторов), usefulnessPass ≥ ⌈0,8·N⌉');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "pub_ai_eval_results_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."taskCode" ~ '^AI-(0[1-9]|[1-3][0-9]|4[0-2])$', 'pub_ai_eval_results.taskCode: AI-01…AI-42');
  -- Р-RD-64 (аудит M2 S3-8): задача — из набора версии конфигурации прогона
  -- (2.2 — AI-01…AI-30, 2.3 — AI-01…AI-42).
  PERFORM "sites"."pub_chk"(substring(NEW."taskCode" FROM 4)::int <= COALESCE((
      SELECT "sites"."pub_eval_set_size"(c."evalSetVersion")
        FROM "sites"."pub_ai_eval_runs" r JOIN "sites"."pub_ai_configs" c ON c."id" = r."configId"
       WHERE r."id" = NEW."runId"), 0),
    'pub_ai_eval_results.taskCode: задача вне набора версии конфигурации прогона');
  PERFORM "sites"."pub_chk"(NEW."schema" = ANY (ARRAY['answer', 'brief', 'qa', 'adaptation', 'reddit']), 'pub_ai_eval_results.schema: вне списка');
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

-- ══ Доказательства P-R: путь ретенции выдержки (§4, хвост M2 (2)) ════════

-- Как в M1 (Р-RD-31, Р-RD-43), плюс ОДИН путь замены фрагмента: выдержка
-- треда (`kind=discussion`) получает плейсхолдер ретенции и новый
-- contentHash (задание P-R `reddit-retention` через порт источников P-B1);
-- остальное неизменно, вернуть текст нельзя.
CREATE OR REPLACE FUNCTION "pub_reddit_sources_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  retention BOOLEAN;
BEGIN
  IF NEW."origin" IS NULL THEN
    NEW."origin" := CASE WHEN TG_OP = 'UPDATE' THEN OLD."origin" ELSE 'content' END;
  END IF;
  PERFORM "sites"."pub_chk"(NEW."origin" = ANY (ARRAY['content', 'reddit']), 'pub_sources.origin: вне списка');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."origin" = OLD."origin", 'pub_sources.origin: неизменно');
    IF OLD."origin" = 'reddit' THEN
      retention := OLD."kind" = 'discussion' AND NEW."fragment" = '[видалено за терміном зберігання]'
                   AND NEW."fragment" IS DISTINCT FROM OLD."fragment";
      PERFORM "sites"."pub_chk"(
        (NEW."kind", NEW."url", CASE WHEN retention THEN OLD."fragment" ELSE NEW."fragment" END,
         CASE WHEN retention THEN OLD."contentHash" ELSE NEW."contentHash" END, NEW."title", NEW."author", NEW."visibility",
         NEW."importedVia", NEW."supersedesId", NEW."injectionFlag", NEW."language", NEW."externalRef",
         NEW."publishedOn", NEW."isSynthetic", NEW."createdAt", NEW."createdBy")
        IS NOT DISTINCT FROM
        (OLD."kind", OLD."url", OLD."fragment", OLD."contentHash", OLD."title", OLD."author", OLD."visibility",
         OLD."importedVia", OLD."supersedesId", OLD."injectionFlag", OLD."language", OLD."externalRef",
         OLD."publishedOn", OLD."isSynthetic", OLD."createdAt", OLD."createdBy"),
        'pub_sources: доказательство P-R неизменно — правка только новой редакцией через маршруты Reddit');
      PERFORM "sites"."pub_chk"(NOT retention OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash",
        'pub_sources: ретенция выдержки P-R — новый contentHash');
      PERFORM "sites"."pub_chk"(NEW."usage" = OLD."usage" OR NEW."usage" = 'revoked',
        'pub_sources.usage: у доказательства P-R — только отзыв');
    END IF;
  ELSIF NEW."origin" = 'reddit' THEN
    PERFORM "sites"."pub_chk"(NEW."kind" IN ('url', 'discussion') AND NEW."visibility" = 'private'
        AND NEW."importedVia" = 'manual' AND NEW."author" IS NULL AND NEW."usage" IN ('restricted', 'revoked')
        AND NOT "sites"."pub_looks_contact"(NEW."fragment")
        AND char_length(NEW."fragment") <= CASE WHEN NEW."kind" = 'discussion' THEN 2000 ELSE 5000 END,
      'pub_sources: доказательство P-R — url/discussion, private, manual, без автора и контактов, restricted, ≤ 2000/5000');
  END IF;
  RETURN NEW;
END;
$$;

-- ══ Публикации: ручной отчёт о публикации (Р-RD-10) ══════════════════════

-- `user_reported` — отчёт человека о публикации Reddit-материала: канал
-- `community`, только опубликованная/снятая/заменённая, проверки нет и не
-- будет (verifyStatus=not_checked навсегда — VERIFIED не бывает, A12).
-- Reddit-материал другим видом отчёта не публикуется.
CREATE FUNCTION "pub_publication_report_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_kind TEXT;
BEGIN
  PERFORM "sites"."pub_chk"(NEW."reportKind" = ANY (ARRAY['standard', 'user_reported']), 'pub_publications.reportKind: вне списка');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."reportKind" = OLD."reportKind", 'pub_publications.reportKind: неизменен');
  END IF;
  IF NEW."reportKind" = 'user_reported' THEN
    PERFORM "sites"."pub_chk"(NEW."verifyStatus" = 'not_checked' AND NEW."lastVerifiedAt" IS NULL AND NEW."verifiedBy" IS NULL
        AND NEW."evidenceUrl" IS NULL,
      'pub_publications: user_reported — без проверки (verifyStatus=not_checked навсегда)');
    PERFORM "sites"."pub_chk"(NEW."status" IN ('published', 'replaced', 'withdrawn'),
      'pub_publications: user_reported — только опубликованная (отчёт о факте), снятая или заменённая');
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_channels" ch WHERE ch."id" = NEW."channelId" AND ch."kind" = 'community'),
      'pub_publications: user_reported — канал kind=community');
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT c."kind" INTO c_kind FROM "sites"."pub_content_versions" v JOIN "sites"."pub_contents" c ON c."id" = v."contentId"
     WHERE v."id" = NEW."versionId";
    PERFORM "sites"."pub_chk"((c_kind IN ('reddit_post', 'reddit_comment')) = (NEW."reportKind" = 'user_reported'),
      'pub_publications: Reddit-материал — только отчётом user_reported, прочие — standard');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_publication_report_guard" BEFORE INSERT OR UPDATE ON "pub_publications"
  FOR EACH ROW EXECUTE FUNCTION "pub_publication_report_guard"();

-- ══ Reddit-бриф (Р-RD-5, §M2.1) ══════════════════════════════════════════

CREATE TRIGGER "pub_reddit_briefs_actor" BEFORE INSERT OR UPDATE ON "pub_reddit_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_reddit_briefs_identity" BEFORE UPDATE ON "pub_reddit_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy',
    'projectId', 'communityId', 'opportunityId', 'contentType');
CREATE TRIGGER "pub_reddit_briefs_same_product" BEFORE INSERT OR UPDATE ON "pub_reddit_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('projectId', 'pub_reddit_projects', 'communityId', 'pub_reddit_communities',
    'opportunityId', 'pub_reddit_opportunities', 'offerVersionId', 'pub_offer_versions');

-- Тезис брифа: {text 1..300, sourceIds: 1..10 id | "needs_verification"}.
CREATE FUNCTION "pub_reddit_key_point_ok"(p_e JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(p_e) <> 'object' THEN false ELSE
           NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_e) k WHERE k NOT IN ('text', 'sourceIds'))
           AND jsonb_typeof(p_e -> 'text') = 'string' AND char_length(p_e ->> 'text') BETWEEN 1 AND 300
           AND btrim(p_e ->> 'text') <> ''
           AND CASE jsonb_typeof(p_e -> 'sourceIds')
                 WHEN 'string' THEN p_e ->> 'sourceIds' = 'needs_verification'
                 WHEN 'array' THEN jsonb_array_length(p_e -> 'sourceIds') BETWEEN 1 AND 10
                   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_e -> 'sourceIds') s
                                    WHERE jsonb_typeof(s) <> 'string' OR char_length(s #>> '{}') NOT BETWEEN 1 AND 100)
                 ELSE false END
         END
$$;

CREATE FUNCTION "pub_reddit_briefs_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."contentType" = ANY (ARRAY['post', 'comment']), 'pub_reddit_briefs.contentType: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['draft', 'ready', 'archived']), 'pub_reddit_briefs.status: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_in"(NEW."affiliation", ARRAY['founder', 'employee', 'agency', 'customer', 'none']),
    'pub_reddit_briefs.affiliation: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."objective") BETWEEN 1 AND 500 AND btrim(NEW."objective") <> ''
      AND "sites"."pub_len"(NEW."audience", 1, 500) AND "sites"."pub_len"(NEW."context", 1, 2000)
      AND "sites"."pub_len"(NEW."tone", 1, 64) AND "sites"."pub_len"(NEW."cta", 1, 300)
      AND "sites"."pub_len"(NEW."brand", 2, 64),
    'pub_reddit_briefs: длина текстового поля');
  PERFORM "sites"."pub_chk"(NEW."language" IS NOT NULL AND "sites"."pub_reddit_locale"(NEW."language"),
    'pub_reddit_briefs.language: BCP-47, ≤ 16');
  PERFORM "sites"."pub_chk"("sites"."pub_reddit_str_array"(NEW."constraints", 10, 300)
      AND "sites"."pub_reddit_str_array"(NEW."forbiddenClaims", 20, 300),
    'pub_reddit_briefs.constraints/forbiddenClaims: ≤ 10/20 строк ≤ 300');
  PERFORM "sites"."pub_chk"(CASE WHEN jsonb_typeof(NEW."keyPoints") <> 'array' THEN false
      ELSE jsonb_array_length(NEW."keyPoints") <= 5
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."keyPoints") e WHERE NOT "sites"."pub_reddit_key_point_ok"(e)) END,
    'pub_reddit_briefs.keyPoints: ≤ 5 × {text ≤ 300, sourceIds[1..10] | "needs_verification"}');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_looks_contact"(NEW."objective") AND NOT "sites"."pub_looks_contact"(NEW."audience")
      AND NOT "sites"."pub_looks_contact"(NEW."context") AND NOT "sites"."pub_looks_contact"(NEW."tone")
      AND NOT "sites"."pub_looks_contact"(NEW."cta") AND NOT "sites"."pub_looks_contact"(NEW."brand")
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."keyPoints") e WHERE "sites"."pub_looks_contact"(e ->> 'text'))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."constraints") t WHERE "sites"."pub_looks_contact"(t))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."forbiddenClaims") t WHERE "sites"."pub_looks_contact"(t)),
    'pub_reddit_briefs: похоже на контакт');
  -- Сообщество — того же проекта; возможность — того же проекта и сообщества.
  PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_reddit_communities" c
                                     WHERE c."id" = NEW."communityId" AND c."projectId" = NEW."projectId"),
    'pub_reddit_briefs.communityId: сообщество другого проекта');
  PERFORM "sites"."pub_chk"(NEW."opportunityId" IS NULL OR EXISTS (
      SELECT 1 FROM "sites"."pub_reddit_opportunities" o
       WHERE o."id" = NEW."opportunityId" AND o."projectId" = NEW."projectId" AND o."communityId" = NEW."communityId"),
    'pub_reddit_briefs.opportunityId: возможность другого проекта или сообщества');
  -- A13: комментарий — только к треду возможности и с контекстом.
  PERFORM "sites"."pub_chk"(NEW."contentType" <> 'comment'
      OR (NEW."opportunityId" IS NOT NULL AND char_length(btrim(COALESCE(NEW."context", ''))) > 0),
    'pub_reddit_briefs: comment требует opportunityId и непустой context');
  IF NEW."status" = 'ready' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
    PERFORM "sites"."pub_chk"(NEW."affiliation" IS NOT NULL, 'pub_reddit_briefs: ready требует affiliation');
    -- Р-RD-65: раскрытие называет продукт/бренд — у аффилированного автора он задан.
    PERFORM "sites"."pub_chk"(NEW."affiliation" = 'none' OR char_length(btrim(COALESCE(NEW."brand", ''))) >= 3,
      'pub_reddit_briefs: ready требует brand (имя продукта для раскрытия)');
    PERFORM "sites"."pub_chk"(jsonb_array_length(NEW."keyPoints") BETWEEN 2 AND 5, 'pub_reddit_briefs: ready требует 2..5 тезисов');
    -- Тезис — с разрешённым источником продукта (не доказательством P-R:
    -- restricted не подтверждает, Р-RD-4) или с пометкой needs_verification.
    PERFORM "sites"."pub_chk"(NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW."keyPoints") e
         WHERE CASE WHEN jsonb_typeof(e -> 'sourceIds') = 'array'
                    THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(e -> 'sourceIds') sid
                                       JOIN "sites"."pub_sources" s ON s."id" = sid
                                      WHERE s."productId" = NEW."productId" AND s."usage" = 'allowed' AND s."origin" = 'content')
                    ELSE false END),
      'pub_reddit_briefs: ready — у каждого тезиса разрешённый источник или needs_verification');
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_offer_versions" o WHERE o."id" = NEW."offerVersionId" AND o."status" = 'active'),
      'pub_reddit_briefs: ready требует активную версию оффера');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reddit_briefs_guard" BEFORE INSERT OR UPDATE ON "pub_reddit_briefs"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_briefs_guard"();

-- ══ Параметр reddit_excerpt_retention_days для существующих продуктов ════
-- Посев допущения (как при создании продукта, §6.2): версия 1 без решения.
INSERT INTO "pub_parameters" ("id", "accountId", "productId", "key", "value", "status", "version", "createdBy")
SELECT 'prm_rd_' || md5(p."id" || ':reddit_excerpt_retention_days'), p."accountId", p."id", 'reddit_excerpt_retention_days',
       '{"days": 180}'::jsonb, 'assumption', 1, 'system:migration-reddit'
  FROM "pub_products" p
 WHERE NOT EXISTS (SELECT 1 FROM "pub_parameters" x WHERE x."productId" = p."id" AND x."key" = 'reddit_excerpt_retention_days');

-- ══ Права ═══════════════════════════════════════════════════════════════

REVOKE ALL ON "pub_reddit_briefs" FROM PUBLIC, publisher_public, assist_public;

DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY '{anon,authenticated}'::text[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON %I FROM %I', 'pub_reddit_briefs', r);
    END IF;
  END LOOP;
END
$$;

-- Пересозданные и новые функции получили EXECUTE у PUBLIC по умолчанию —
-- снимаем (их вызывают только триггеры под владельцем).
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
