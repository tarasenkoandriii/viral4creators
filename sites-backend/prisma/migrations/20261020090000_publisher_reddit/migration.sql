-- AI Publisher, пакет P-R «Reddit Manual MVP», этап M1 Research.
-- Основание: doc/ai-publisher/reddit-manual-mvp-adapted.md §1, §M1.1, §4, §5,
-- §11 (Р-RD-1…4, Р-RD-12); конвенции — IMPLEMENTATION-DESIGN.md §5.2, §6.1.
--
-- Forward-only (Р-RD-12): отката-скрипта нет; откат — флаг
-- PUBLISHER_REDDIT_ENABLED=false + компенсирующая миграция + бэкап P-E.
-- Выкаченные миграции 20261016* не трогаем: закрытые списки, которые живут
-- в функциях `…_publisher_core`, пересоздаются здесь (CREATE OR REPLACE).
--
-- Что здесь:
--  1. Пять таблиц pub_reddit_* (из schema.prisma; составные FK (xId,
--     accountId), ON DELETE RESTRICT).
--  2. Закрытые списки: `pub_object_types()` (+ reddit_*), `pub_parameter_keys()`
--     (+ reddit_rules_stale_days, 39 ключей), действия аудита (+ copy,
--     report_publication — для M2) в `pub_audit_events_guard`.
--  3. Триггеры: актёр, неизменяемые колонки, ссылки внутри продукта,
--     гварды `pub_reddit_*_guard` (23514, CHECK нет — §5.2), append-only
--     снимков правил (после review меняется только status), version + 1,
--     selfReview = (reviewedBy = createdBy), BLOCK не снимается score
--     (qualified/in_brief только при policy=ok).
--  4. Частичный уникальный индекс «один текущий снимок сообщества».
--  4a. pub_sources.origin (content|reddit) и гвард pub_reddit_sources_guard:
--     доказательства P-R неизменны и скрыты из общих /sources (аудит S1/S2).
--  5. Посев параметра reddit_rules_stale_days (assumption, {"days":30}) для
--     существующих продуктов.
--  6. REVOKE у PUBLIC, publisher_public, assist_public, anon/authenticated;
--     EXECUTE функций у PUBLIC.

-- ══ Таблицы, индексы, внешние ключи (из schema.prisma) ══════════════════

-- CreateTable
CREATE TABLE "pub_reddit_projects" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_reddit_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_reddit_communities" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "descriptionManual" TEXT,
    "language" TEXT,
    "topics" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_reddit_communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_reddit_rule_snapshots" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL,
    "promotionPolicy" TEXT NOT NULL,
    "linksPolicy" TEXT NOT NULL,
    "flairRequired" BOOLEAN,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,
    "reviewState" TEXT NOT NULL DEFAULT 'unreviewed',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "selfReview" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'current',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pub_reddit_rule_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_reddit_keywords" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "phraseNorm" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "locale" TEXT,
    "priority" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_reddit_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pub_reddit_opportunities" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "threadUrl" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "titleManual" TEXT NOT NULL,
    "excerptSourceId" TEXT,
    "intent" TEXT NOT NULL,
    "angle" TEXT,
    "keywordIds" JSONB NOT NULL DEFAULT '[]',
    "factors" JSONB NOT NULL DEFAULT '{}',
    "relevance" INTEGER,
    "risk" INTEGER,
    "priority" INTEGER,
    "scoreVersion" TEXT NOT NULL DEFAULT 'v1',
    "ruleSnapshotId" TEXT,
    "policy" TEXT NOT NULL DEFAULT 'block',
    "policyReasons" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pub_reddit_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pub_reddit_projects_productId_status_idx" ON "pub_reddit_projects"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_projects_id_accountId_key" ON "pub_reddit_projects"("id", "accountId");

-- CreateIndex
CREATE INDEX "pub_reddit_communities_projectId_status_idx" ON "pub_reddit_communities"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_communities_id_accountId_key" ON "pub_reddit_communities"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_communities_productId_name_key" ON "pub_reddit_communities"("productId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_communities_channelId_key" ON "pub_reddit_communities"("channelId");

-- CreateIndex
CREATE INDEX "pub_reddit_rule_snapshots_productId_status_idx" ON "pub_reddit_rule_snapshots"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_rule_snapshots_id_accountId_key" ON "pub_reddit_rule_snapshots"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_rule_snapshots_communityId_version_key" ON "pub_reddit_rule_snapshots"("communityId", "version");

-- CreateIndex
CREATE INDEX "pub_reddit_keywords_productId_status_idx" ON "pub_reddit_keywords"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_keywords_id_accountId_key" ON "pub_reddit_keywords"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_keywords_projectId_phraseNorm_key" ON "pub_reddit_keywords"("projectId", "phraseNorm");

-- CreateIndex
CREATE INDEX "pub_reddit_opportunities_productId_status_idx" ON "pub_reddit_opportunities"("productId", "status");

-- CreateIndex
CREATE INDEX "pub_reddit_opportunities_projectId_status_idx" ON "pub_reddit_opportunities"("projectId", "status");

-- CreateIndex
CREATE INDEX "pub_reddit_opportunities_communityId_idx" ON "pub_reddit_opportunities"("communityId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_opportunities_id_accountId_key" ON "pub_reddit_opportunities"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "pub_reddit_opportunities_projectId_threadKey_key" ON "pub_reddit_opportunities"("projectId", "threadKey");

-- AddForeignKey
ALTER TABLE "pub_reddit_projects" ADD CONSTRAINT "pub_reddit_projects_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_communities" ADD CONSTRAINT "pub_reddit_communities_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_communities" ADD CONSTRAINT "pub_reddit_communities_projectId_accountId_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "pub_reddit_projects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_communities" ADD CONSTRAINT "pub_reddit_communities_channelId_accountId_fkey" FOREIGN KEY ("channelId", "accountId") REFERENCES "pub_channels"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_rule_snapshots" ADD CONSTRAINT "pub_reddit_rule_snapshots_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_rule_snapshots" ADD CONSTRAINT "pub_reddit_rule_snapshots_communityId_accountId_fkey" FOREIGN KEY ("communityId", "accountId") REFERENCES "pub_reddit_communities"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_rule_snapshots" ADD CONSTRAINT "pub_reddit_rule_snapshots_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_keywords" ADD CONSTRAINT "pub_reddit_keywords_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_keywords" ADD CONSTRAINT "pub_reddit_keywords_projectId_accountId_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "pub_reddit_projects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_opportunities" ADD CONSTRAINT "pub_reddit_opportunities_productId_accountId_fkey" FOREIGN KEY ("productId", "accountId") REFERENCES "pub_products"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_opportunities" ADD CONSTRAINT "pub_reddit_opportunities_projectId_accountId_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "pub_reddit_projects"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_opportunities" ADD CONSTRAINT "pub_reddit_opportunities_communityId_accountId_fkey" FOREIGN KEY ("communityId", "accountId") REFERENCES "pub_reddit_communities"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_opportunities" ADD CONSTRAINT "pub_reddit_opportunities_excerptSourceId_accountId_fkey" FOREIGN KEY ("excerptSourceId", "accountId") REFERENCES "pub_sources"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pub_reddit_opportunities" ADD CONSTRAINT "pub_reddit_opportunities_ruleSnapshotId_accountId_fkey" FOREIGN KEY ("ruleSnapshotId", "accountId") REFERENCES "pub_reddit_rule_snapshots"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Происхождение источника (аудит P-R S1-1/S1-2/S2-1): доказательства Reddit
-- (первоисточник правил, выдержка треда) — строки pub_sources с
-- origin='reddit': скрыты из общих /sources, неизменны (триггер
-- pub_reddit_sources_guard ниже), правка — новой редакцией через P-R.
-- Prisma-колонка с DEFAULT; NULL из старых копий бэкапа гвард заменяет на
-- 'content' (BEFORE-триггер срабатывает раньше проверки NOT NULL).
ALTER TABLE "pub_sources" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'content';

-- Не больше одного текущего снимка правил у сообщества (Р-PUB-4: частичный
-- уникальный индекс, migrate diff его не видит). Вторая линия к блокировке
-- строки сообщества в операции создания снимка.
CREATE UNIQUE INDEX "pub_reddit_rule_snapshots_current_uq"
    ON "pub_reddit_rule_snapshots" ("communityId")
    WHERE "status" = 'current';

-- ══ Закрытые списки (= contracts/states.ts, contracts/parameters.ts) ═════

CREATE OR REPLACE FUNCTION "pub_parameter_keys"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['niche', 'language', 'market', 'offer_active_version', 'own_channels', 'domain_host',
               'hosting', 'attribution_tool', 'consent_map', 'analytics_storage', 'event_map', 'perf_targets',
               'data_notice_version', 'retention_policy', 'budget_total', 'budget_split', 'per_purchase_max',
               'ai_budget_usd_month', 'ai_fx_rate', 'ai_unpriced_allowed', 'rates_by_role', 'allowed_cpl_inputs',
               'investment_cpl_limit', 'dev_investment', 'cac_payment_window', 'd42_thresholds', 'd90_thresholds',
               'late_cohort_rules', 'qualification_rules', 'responsibles', 'sales_hours_t42_t72', 'contact_sla',
               'form_limit', 'alt_contact', 'test_hosts', 'pilot_calendar', 'launch_evidence_d0',
               'launch_evidence_purchase', 'reddit_rules_stale_days']
$$;

CREATE OR REPLACE FUNCTION "pub_object_types"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['product', 'parameter', 'parameter_proposal', 'parameter_decision', 'role_grant', 'member',
               'review_task', 'integration', 'campaign', 'source', 'question_group', 'question', 'brand_fact',
               'offer_version', 'brief', 'content', 'content_version', 'claim', 'qa_check', 'approval',
               'channel', 'distribution_action', 'publication', 'venue', 'placement', 'budget_limit',
               'reserve_move', 'expense', 'expense_entry', 'time_entry', 'prospect', 'lead', 'lead_contact',
               'lead_decision', 'payment', 'notification', 'queue_check', 'session', 'event', 'metric_import',
               'experiment', 'report', 'backup', 'restore', 'ai_config', 'ai_config_binding', 'ai_task',
               'ai_call', 'ai_budget_month', 'ai_eval_run', 'ai_eval_result', 'reddit_project',
               'reddit_community', 'reddit_rule_snapshot', 'reddit_keyword', 'reddit_opportunity', 'reddit_brief']
$$;

-- Действия журнала: + copy (копирование утверждённого текста, M2.6) и
-- report_publication (отчёт о ручной публикации, M2.6). Review правил пишется
-- `approve`, пересчёт score — `update`.
CREATE OR REPLACE FUNCTION "pub_audit_events_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."objectType" = ANY ("sites"."pub_object_types"()), 'pub_audit_events.objectType: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."objectId") BETWEEN 1 AND 100, 'pub_audit_events.objectId: длина 1..100');
  PERFORM "sites"."pub_chk"(NEW."action" = ANY (ARRAY['create', 'update', 'transition', 'approve', 'reject', 'revoke', 'grant',
      'reveal_contact', 'export', 'erase', 'restore', 'backup', 'import', 'merge', 'split', 'assign', 'bind', 'unbind',
      'resolve', 'dismiss', 'retry', 'reset', 'copy', 'report_publication']), 'pub_audit_events.action: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."fromStatus", 1, 64) AND "sites"."pub_len"(NEW."toStatus", 1, 64),
    'pub_audit_events.fromStatus/toStatus: длина ≤ 64');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."reason", 1, 2000), 'pub_audit_events.reason: длина 1..2000');
  RETURN NEW;
END;
$$;

-- ══ Общие помощники P-R (чистые: без таблиц, без DEFINER) ═════════════════

-- jsonb-массив строк: не больше p_max элементов, каждая — 1..p_len символов.
CREATE FUNCTION "pub_reddit_str_array"(p_j JSONB, p_max INTEGER, p_len INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_j IS NOT NULL AND jsonb_typeof(p_j) = 'array' AND jsonb_array_length(p_j) <= p_max
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_j) e
        WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') NOT BETWEEN 1 AND p_len)
$$;

-- BCP-47 (как pub_sources.language), не длиннее 16.
CREATE FUNCTION "pub_reddit_locale"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR (char_length(p_v) <= 16 AND p_v ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$')
$$;

-- Нормальная форма ключевого запроса: нижний регистр, сжатые пробелы.
CREATE FUNCTION "pub_reddit_phrase_norm"(p_v TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(p_v), '[[:space:]]+', ' ', 'g'))
$$;

-- ══ Общие триггеры: актёр, неизменяемые колонки, один продукт ════════════

CREATE TRIGGER "pub_reddit_projects_actor" BEFORE INSERT OR UPDATE ON "pub_reddit_projects"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_reddit_projects_identity" BEFORE UPDATE ON "pub_reddit_projects"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');

CREATE TRIGGER "pub_reddit_communities_actor" BEFORE INSERT OR UPDATE ON "pub_reddit_communities"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_reddit_communities_identity" BEFORE UPDATE ON "pub_reddit_communities"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy',
    'projectId', 'channelId', 'name', 'canonicalUrl');
CREATE TRIGGER "pub_reddit_communities_same_product" BEFORE INSERT OR UPDATE ON "pub_reddit_communities"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('projectId', 'pub_reddit_projects', 'channelId', 'pub_channels');

CREATE TRIGGER "pub_reddit_rule_snapshots_actor" BEFORE INSERT OR UPDATE ON "pub_reddit_rule_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy', 'reviewedBy');
CREATE TRIGGER "pub_reddit_rule_snapshots_identity" BEFORE UPDATE ON "pub_reddit_rule_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy');
CREATE TRIGGER "pub_reddit_rule_snapshots_same_product" BEFORE INSERT OR UPDATE ON "pub_reddit_rule_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('communityId', 'pub_reddit_communities', 'sourceId', 'pub_sources');
-- Append-only (Р-RD-3): меняются только поля review и статус; удаление и
-- TRUNCATE запрещены.
CREATE TRIGGER "pub_reddit_rule_snapshots_ao" BEFORE UPDATE OR DELETE ON "pub_reddit_rule_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "pub_append_only"('reviewState', 'reviewedBy', 'reviewedAt', 'selfReview', 'status');
CREATE TRIGGER "pub_reddit_rule_snapshots_no_truncate" BEFORE TRUNCATE ON "pub_reddit_rule_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_append_only"();

CREATE TRIGGER "pub_reddit_keywords_actor" BEFORE INSERT OR UPDATE ON "pub_reddit_keywords"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_reddit_keywords_identity" BEFORE UPDATE ON "pub_reddit_keywords"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy', 'projectId');
CREATE TRIGGER "pub_reddit_keywords_same_product" BEFORE INSERT OR UPDATE ON "pub_reddit_keywords"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('projectId', 'pub_reddit_projects');

CREATE TRIGGER "pub_reddit_opportunities_actor" BEFORE INSERT OR UPDATE ON "pub_reddit_opportunities"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('createdBy');
CREATE TRIGGER "pub_reddit_opportunities_identity" BEFORE UPDATE ON "pub_reddit_opportunities"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'accountId', 'productId', 'createdAt', 'createdBy',
    'projectId', 'communityId', 'threadUrl', 'threadKey');
CREATE TRIGGER "pub_reddit_opportunities_same_product" BEFORE INSERT OR UPDATE ON "pub_reddit_opportunities"
  FOR EACH ROW EXECUTE FUNCTION "pub_same_product"('projectId', 'pub_reddit_projects', 'communityId', 'pub_reddit_communities',
    'excerptSourceId', 'pub_sources', 'ruleSnapshotId', 'pub_reddit_rule_snapshots');

-- ══ Гварды таблиц P-R (23514) ═════════════════════════════════════════════

CREATE FUNCTION "pub_reddit_projects_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(NEW."name") BETWEEN 1 AND 120 AND btrim(NEW."name") <> '',
    'pub_reddit_projects.name: длина 1..120');
  PERFORM "sites"."pub_chk"(NEW."locale" IS NOT NULL AND "sites"."pub_reddit_locale"(NEW."locale"),
    'pub_reddit_projects.locale: BCP-47, ≤ 16');
  PERFORM "sites"."pub_chk"(char_length(NEW."market") BETWEEN 1 AND 64 AND btrim(NEW."market") <> '',
    'pub_reddit_projects.market: длина 1..64');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['active', 'archived']), 'pub_reddit_projects.status: вне списка');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_looks_contact"(NEW."name") AND NOT "sites"."pub_looks_contact"(NEW."market"),
    'pub_reddit_projects: похоже на контакт');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reddit_projects_guard" BEFORE INSERT OR UPDATE ON "pub_reddit_projects"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_projects_guard"();

-- Сообщество: нормализованное имя, канонический URL без завершающего `/`,
-- канал kind=community (Р-RD-2).
CREATE FUNCTION "pub_reddit_communities_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."name" ~ '^[a-z0-9_]{2,21}$', 'pub_reddit_communities.name: ^[a-z0-9_]{2,21}$');
  PERFORM "sites"."pub_chk"(NEW."canonicalUrl" = 'https://www.reddit.com/r/' || NEW."name",
    'pub_reddit_communities.canonicalUrl: https://www.reddit.com/r/<name>');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."descriptionManual", 1, 2000), 'pub_reddit_communities.descriptionManual: длина 1..2000');
  PERFORM "sites"."pub_chk"("sites"."pub_reddit_locale"(NEW."language"), 'pub_reddit_communities.language: BCP-47, ≤ 16');
  PERFORM "sites"."pub_chk"("sites"."pub_reddit_str_array"(NEW."topics", 20, 64), 'pub_reddit_communities.topics: ≤ 20 строк ≤ 64');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['active', 'archived']), 'pub_reddit_communities.status: вне списка');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_looks_contact"(NEW."descriptionManual"), 'pub_reddit_communities.descriptionManual: похоже на контакт');
  PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_channels" c WHERE c."id" = NEW."channelId" AND c."kind" = 'community'),
    'pub_reddit_communities.channelId: канал kind=community');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reddit_communities_guard" BEFORE INSERT OR UPDATE ON "pub_reddit_communities"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_communities_guard"();

-- Снимок правил (Р-RD-3): version = предыдущая + 1; новый — unreviewed и
-- current; review требует первоисточник с URL (не отозванный) и делает
-- строку неизменной (кроме status: current → superseded); selfReview —
-- ровно «проверил автор». Восстановление P-E (`pub_restoring`) переносит
-- историю как есть.
CREATE FUNCTION "pub_reddit_rule_snapshots_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  restoring BOOLEAN := "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId");
  prev INTEGER;
BEGIN
  PERFORM "sites"."pub_chk"(NEW."promotionPolicy" = ANY (ARRAY['allowed_with_conditions', 'prohibited', 'unknown']),
    'pub_reddit_rule_snapshots.promotionPolicy: вне списка');
  PERFORM "sites"."pub_chk"(NEW."linksPolicy" = ANY (ARRAY['allowed', 'restricted', 'prohibited', 'unknown']),
    'pub_reddit_rule_snapshots.linksPolicy: вне списка');
  PERFORM "sites"."pub_chk"(NEW."reviewState" = ANY (ARRAY['unreviewed', 'reviewed']), 'pub_reddit_rule_snapshots.reviewState: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['current', 'superseded']), 'pub_reddit_rule_snapshots.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_reddit_rule_snapshots.version: ≥ 1');
  PERFORM "sites"."pub_chk"("sites"."pub_reddit_str_array"(NEW."conditions", 20, 300),
    'pub_reddit_rule_snapshots.conditions: ≤ 20 строк ≤ 300');
  PERFORM "sites"."pub_chk"((NEW."reviewState" = 'reviewed') = (NEW."reviewedBy" IS NOT NULL AND NEW."reviewedAt" IS NOT NULL),
    'pub_reddit_rule_snapshots.reviewed*: заполнены ⇔ reviewState=reviewed');
  PERFORM "sites"."pub_chk"("sites"."pub_is_member"(NEW."reviewedBy"), 'pub_reddit_rule_snapshots.reviewedBy: проверяет человек (member:)');
  PERFORM "sites"."pub_chk"(NEW."reviewState" = 'reviewed' OR NOT NEW."selfReview",
    'pub_reddit_rule_snapshots.selfReview: только у проверенного снимка');
  IF TG_OP = 'INSERT' THEN
    PERFORM "sites"."pub_chk"(EXISTS (
        SELECT 1 FROM "sites"."pub_sources" s
         WHERE s."id" = NEW."sourceId" AND s."kind" = 'url' AND s."url" IS NOT NULL
           AND s."visibility" = 'private' AND s."importedVia" = 'manual' AND s."origin" = 'reddit'),
      'pub_reddit_rule_snapshots.sourceId: первоисточник kind=url с URL, manual, private, origin=reddit');
    IF NOT restoring THEN
      SELECT max(x."version") INTO prev FROM "sites"."pub_reddit_rule_snapshots" x WHERE x."communityId" = NEW."communityId";
      PERFORM "sites"."pub_chk"(NEW."version" = COALESCE(prev, 0) + 1, 'pub_reddit_rule_snapshots.version: предыдущая + 1');
      PERFORM "sites"."pub_chk"(NEW."reviewState" = 'unreviewed' AND NEW."status" = 'current',
        'pub_reddit_rule_snapshots: новый снимок — unreviewed и current');
      PERFORM "sites"."pub_chk"(NEW."checkedAt" <= now() + interval '5 minutes', 'pub_reddit_rule_snapshots.checkedAt: не в будущем');
    END IF;
  ELSE
    PERFORM "sites"."pub_chk"(OLD."status" = 'current' OR NEW."status" = OLD."status",
      'pub_reddit_rule_snapshots.status: superseded необратим');
    PERFORM "sites"."pub_chk"(OLD."reviewState" = 'unreviewed'
        OR (NEW."reviewState", NEW."reviewedBy", NEW."reviewedAt", NEW."selfReview")
           IS NOT DISTINCT FROM (OLD."reviewState", OLD."reviewedBy", OLD."reviewedAt", OLD."selfReview"),
      'pub_reddit_rule_snapshots: после review неизменно всё, кроме status');
    IF OLD."reviewState" = 'unreviewed' AND NEW."reviewState" = 'reviewed' THEN
      PERFORM "sites"."pub_chk"(OLD."status" = 'current', 'pub_reddit_rule_snapshots: review только текущего снимка');
      PERFORM "sites"."pub_chk"(NEW."selfReview" = (NEW."reviewedBy" = NEW."createdBy"),
        'pub_reddit_rule_snapshots.selfReview: = (reviewedBy = createdBy)');
      PERFORM "sites"."pub_chk"(EXISTS (
          SELECT 1 FROM "sites"."pub_sources" s
           WHERE s."id" = NEW."sourceId" AND s."url" IS NOT NULL AND btrim(s."url") <> '' AND s."usage" <> 'revoked'),
        'pub_reddit_rule_snapshots: review требует первоисточник с URL (не отозванный) и checkedAt');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reddit_rule_snapshots_guard" BEFORE INSERT OR UPDATE ON "pub_reddit_rule_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_rule_snapshots_guard"();

-- Ключевой запрос: нормальную форму ставит база (индекс по выражению Prisma
-- не видит — migrate diff перестал бы быть пустым), контакта во фразе нет.
CREATE FUNCTION "pub_reddit_keywords_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW."phraseNorm" := "sites"."pub_reddit_phrase_norm"(NEW."phrase");
  PERFORM "sites"."pub_chk"(char_length(NEW."phrase") BETWEEN 1 AND 200 AND NEW."phraseNorm" <> '',
    'pub_reddit_keywords.phrase: длина 1..200');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_looks_contact"(NEW."phrase"), 'pub_reddit_keywords.phrase: похоже на контакт');
  PERFORM "sites"."pub_chk"(NEW."intent" = ANY (ARRAY['how_to', 'comparison', 'alternative', 'troubleshooting', 'recommendation',
      'discussion', 'other']), 'pub_reddit_keywords.intent: вне списка');
  PERFORM "sites"."pub_chk"("sites"."pub_reddit_locale"(NEW."locale"), 'pub_reddit_keywords.locale: BCP-47, ≤ 16');
  PERFORM "sites"."pub_chk"(NEW."priority" BETWEEN 1 AND 5, 'pub_reddit_keywords.priority: 1..5');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['active', 'archived']), 'pub_reddit_keywords.status: вне списка');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reddit_keywords_guard" BEFORE INSERT OR UPDATE ON "pub_reddit_keywords"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_keywords_guard"();

-- Возможность: канонический URL треда того же сообщества (A15), выдержка —
-- закрытый ограниченный источник ≤ 2000 без контактов (Р-RD-4), снимок —
-- того же сообщества, BLOCK не снимается score (M1.4).
CREATE FUNCTION "pub_reddit_opportunities_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_name TEXT;
  c_project TEXT;
  prefix TEXT;
BEGIN
  PERFORM "sites"."pub_chk"(NEW."threadKey" ~ '^[a-z0-9]{1,13}$', 'pub_reddit_opportunities.threadKey: id36');
  PERFORM "sites"."pub_chk"(char_length(NEW."threadUrl") <= 2048
      AND NEW."threadUrl" ~ '^https://www[.]reddit[.]com/r/[a-z0-9_]{2,21}/comments/[a-z0-9]{1,13}(/[^/?#[:space:]]+)?$',
    'pub_reddit_opportunities.threadUrl: https://www.reddit.com/r/<name>/comments/<id36>[/<slug>]');
  SELECT c."name", c."projectId" INTO c_name, c_project FROM "sites"."pub_reddit_communities" c WHERE c."id" = NEW."communityId";
  PERFORM "sites"."pub_chk"(c_project = NEW."projectId", 'pub_reddit_opportunities.communityId: сообщество другого проекта');
  prefix := 'https://www.reddit.com/r/' || c_name || '/comments/' || NEW."threadKey";
  PERFORM "sites"."pub_chk"(NEW."threadUrl" = prefix OR left(NEW."threadUrl", char_length(prefix) + 1) = prefix || '/',
    'pub_reddit_opportunities.threadUrl: сообщество и ключ треда — из URL');
  PERFORM "sites"."pub_chk"(char_length(NEW."titleManual") BETWEEN 1 AND 300 AND btrim(NEW."titleManual") <> '',
    'pub_reddit_opportunities.titleManual: длина 1..300');
  PERFORM "sites"."pub_chk"("sites"."pub_len"(NEW."angle", 1, 1000), 'pub_reddit_opportunities.angle: длина 1..1000');
  PERFORM "sites"."pub_chk"(NOT "sites"."pub_looks_contact"(NEW."titleManual") AND NOT "sites"."pub_looks_contact"(NEW."angle"),
    'pub_reddit_opportunities: похоже на контакт');
  PERFORM "sites"."pub_chk"(NEW."intent" = ANY (ARRAY['how_to', 'comparison', 'alternative', 'troubleshooting', 'recommendation',
      'discussion', 'other']), 'pub_reddit_opportunities.intent: вне списка');
  PERFORM "sites"."pub_chk"(NEW."policy" = ANY (ARRAY['ok', 'block', 'recheck_required']), 'pub_reddit_opportunities.policy: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['new', 'qualified', 'recheck_required', 'blocked', 'skipped', 'in_brief',
      'archived']), 'pub_reddit_opportunities.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."scoreVersion" = 'v1', 'pub_reddit_opportunities.scoreVersion: v1');
  PERFORM "sites"."pub_chk"((NEW."relevance" IS NULL OR NEW."relevance" BETWEEN 0 AND 100)
      AND (NEW."risk" IS NULL OR NEW."risk" BETWEEN 0 AND 100)
      AND (NEW."priority" IS NULL OR NEW."priority" BETWEEN 0 AND 100),
    'pub_reddit_opportunities.relevance/risk/priority: 0..100');
  PERFORM "sites"."pub_chk"("sites"."pub_reddit_str_array"(NEW."keywordIds", 10, 100), 'pub_reddit_opportunities.keywordIds: ≤ 10 id');
  PERFORM "sites"."pub_chk"("sites"."pub_reddit_str_array"(NEW."policyReasons", 16, 64), 'pub_reddit_opportunities.policyReasons: ≤ 16 кодов');
  PERFORM "sites"."pub_chk"(jsonb_typeof(NEW."factors") = 'object' AND "sites"."pub_jsize"(NEW."factors", 8192)
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(NEW."factors") f
         WHERE f.key <> ALL (ARRAY['topic_fit', 'intent_fit', 'audience_fit', 'answerability', 'policy_risk', 'promotionality',
             'evidence_gap', 'context_uncertainty'])),
    'pub_reddit_opportunities.factors: вне списка');
  PERFORM "sites"."pub_chk"(NOT EXISTS (
        SELECT 1 FROM jsonb_each(NEW."factors") f
         WHERE jsonb_typeof(f.value) <> 'object'
            OR jsonb_typeof(f.value -> 'value') NOT IN ('number', 'null')
            OR (jsonb_typeof(f.value -> 'value') = 'number' AND (f.value ->> 'value')::numeric NOT BETWEEN 0 AND 100)
            OR jsonb_typeof(COALESCE(f.value -> 'why', 'null'::jsonb)) NOT IN ('string', 'null')
            OR char_length(COALESCE(f.value ->> 'why', '')) > 300),
    'pub_reddit_opportunities.factors: {value 0..100|null, why ≤ 300}');
  -- BLOCK не снимается высоким score: дальше «отобрана» и «в брифе» — только ok.
  PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('qualified', 'in_brief') OR NEW."policy" = 'ok',
    'pub_reddit_opportunities.status: qualified/in_brief только при policy=ok');
  PERFORM "sites"."pub_chk"(NEW."policy" <> 'ok' OR NEW."ruleSnapshotId" IS NOT NULL,
    'pub_reddit_opportunities.policy: ok только по снимку правил');
  IF NEW."ruleSnapshotId" IS NOT NULL THEN
    PERFORM "sites"."pub_chk"(EXISTS (SELECT 1 FROM "sites"."pub_reddit_rule_snapshots" r
                                       WHERE r."id" = NEW."ruleSnapshotId" AND r."communityId" = NEW."communityId"),
      'pub_reddit_opportunities.ruleSnapshotId: снимок другого сообщества');
  END IF;
  IF NEW."excerptSourceId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."excerptSourceId" IS DISTINCT FROM OLD."excerptSourceId") THEN
    PERFORM "sites"."pub_chk"(EXISTS (
        SELECT 1 FROM "sites"."pub_sources" s
         WHERE s."id" = NEW."excerptSourceId" AND s."kind" = 'discussion' AND s."visibility" = 'private'
           AND s."usage" IN ('restricted', 'revoked') AND char_length(s."fragment") <= 2000
           AND NOT "sites"."pub_looks_contact"(s."fragment") AND s."origin" = 'reddit' AND s."author" IS NULL),
      'pub_reddit_opportunities.excerptSourceId: выдержка — discussion, private, restricted, ≤ 2000, без контактов, origin=reddit');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pub_reddit_opportunities_guard" BEFORE INSERT OR UPDATE ON "pub_reddit_opportunities"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_opportunities_guard"();

-- Доказательства P-R в pub_sources (аудит P-R S1-1/S1-2). Вставка
-- origin=reddit — только закрытый ограниченный источник без автора и
-- контактов (url — первоисточник правил ≤ 5000, discussion — выдержка
-- ≤ 2000). После вставки неизменны содержимое, заголовок, автор, вид,
-- видимость, редакция, пометка injectionFlag и метаданные (language,
-- externalRef, publishedOn, isSynthetic, createdAt/By; реаудит N-3) —
-- меняются только checkedAt, freshness, отзыв (usage → revoked, revoked*),
-- revision и updatedAt. Общий PATCH /sources (P-B1) отвечает 409
-- reddit_evidence_locked раньше базы.
CREATE FUNCTION "pub_reddit_sources_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."origin" IS NULL THEN
    NEW."origin" := CASE WHEN TG_OP = 'UPDATE' THEN OLD."origin" ELSE 'content' END;
  END IF;
  PERFORM "sites"."pub_chk"(NEW."origin" = ANY (ARRAY['content', 'reddit']), 'pub_sources.origin: вне списка');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."origin" = OLD."origin", 'pub_sources.origin: неизменно');
    IF OLD."origin" = 'reddit' THEN
      PERFORM "sites"."pub_chk"(
        (NEW."kind", NEW."url", NEW."fragment", NEW."contentHash", NEW."title", NEW."author", NEW."visibility",
         NEW."importedVia", NEW."supersedesId", NEW."injectionFlag", NEW."language", NEW."externalRef",
         NEW."publishedOn", NEW."isSynthetic", NEW."createdAt", NEW."createdBy")
        IS NOT DISTINCT FROM
        (OLD."kind", OLD."url", OLD."fragment", OLD."contentHash", OLD."title", OLD."author", OLD."visibility",
         OLD."importedVia", OLD."supersedesId", OLD."injectionFlag", OLD."language", OLD."externalRef",
         OLD."publishedOn", OLD."isSynthetic", OLD."createdAt", OLD."createdBy"),
        'pub_sources: доказательство P-R неизменно — правка только новой редакцией через маршруты Reddit');
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
CREATE TRIGGER "pub_sources_reddit_guard" BEFORE INSERT OR UPDATE ON "pub_sources"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_sources_guard"();

-- ══ Параметр reddit_rules_stale_days для существующих продуктов ══════════
-- Посев допущения (как при создании продукта, §6.2): версия 1 без решения.
INSERT INTO "pub_parameters" ("id", "accountId", "productId", "key", "value", "status", "version", "createdBy")
SELECT 'prm_rd_' || md5(p."id" || ':reddit_rules_stale_days'), p."accountId", p."id", 'reddit_rules_stale_days',
       '{"days": 30}'::jsonb, 'assumption', 1, 'system:migration-reddit'
  FROM "pub_products" p
 WHERE NOT EXISTS (SELECT 1 FROM "pub_parameters" x WHERE x."productId" = p."id" AND x."key" = 'reddit_rules_stale_days');

-- ══ Права ═══════════════════════════════════════════════════════════════

REVOKE ALL ON
  "pub_reddit_projects",
  "pub_reddit_communities",
  "pub_reddit_rule_snapshots",
  "pub_reddit_keywords",
  "pub_reddit_opportunities"
FROM PUBLIC, publisher_public, assist_public;

-- Supabase: роли anon/authenticated (если есть) к новым таблицам доступа не
-- имеют (аудит P3-14).
DO $$
DECLARE
  r TEXT;
  t RECORD;
BEGIN
  FOREACH r IN ARRAY '{anon,authenticated}'::text[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'v') AND c.relname LIKE 'pub\_reddit\_%'
      LOOP
        EXECUTE format('REVOKE ALL ON %I FROM %I', t.relname, r);
      END LOOP;
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
