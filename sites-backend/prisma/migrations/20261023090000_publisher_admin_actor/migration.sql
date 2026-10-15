-- AI Publisher, P-R-ADM — вкладка «Reddit» Админки платформы: актор
-- оператора Админки `admin:<userId>` (doc/ai-publisher/reddit-manual-mvp-
-- adapted.md §«Админка», Р-RD-ADM-2).
--
-- Forward-only (как Р-RD-12): отката-скрипта нет; откат — флаг
-- PUBLISHER_REDDIT_ENABLED=false (внутренний путь закрыт целиком) +
-- компенсирующая миграция. Предыдущие миграции не правятся: функции,
-- которые меняются, пересоздаются здесь (CREATE OR REPLACE) из их
-- последних версий (core / M1 / M2) с одной правкой каждая.
--
-- Что здесь (закрытый список мест, где проверяется формат актора):
--  1. pub_is_actor — общий формат актора (триггер pub_actor_format у всех
--     таблиц Publisher: createdBy, approvedBy, decidedBy, …) + admin:<id>
--     (id пользователя backend ≤ 58 знаков: актор ≤ 64, как столбцы
--     …MemberId, куда попадает синтетический memberId Админки).
--  2. Новые pub_is_admin (только admin:) и pub_is_person (member: | admin:).
--  3. «Решает/проверяет человек» — admin: допускается ТОЛЬКО там, где это
--     нужно вкладке «Reddit»:
--       pub_parameters.approvedBy, pub_parameter_decisions.decidedBy
--         (параметры гейта reddit_publish и P-R; список ключей держит код),
--       pub_reddit_rule_snapshots.reviewedBy (проверка правил),
--       pub_qa_checks.checkedBy (editorial/technical — только версия
--         Reddit-материала; adaptation_meaning — по-прежнему member:),
--       pub_ai_calls.requestedBy (только генератор pub.reddit.draft).
--       pub_offer_versions.approvedBy, pub_brand_facts.approvedBy (v1.2,
--         Р-RD-ADM-11: оффер и факты бренда платформенного продукта — гейт
--         reddit_publish закрывается из Админки; база не знает, какой
--         продукт платформенный, — актор admin: возникает только на
--         внутреннем пути платформенного продукта, это держит код).
--     Без изменений (admin: туда не пишется — действия вне allowlist):
--     pub_claims.verifiedBy, pub_claim_sources.checkedBy, pub_lead_decisions,
--     pub_queue_checks, pub_eval_* (pub_is_member и прежние проверки member:).
--  6. Журнал доступа Админки pub_reddit_admin_access_log (Р-RD-ADM-7, v1.2): вне
--     тенанта (как pub_rate_hits), append-only — UPDATE и TRUNCATE
--     запрещены, DELETE — только строк старше 365 дней (ретенция);
--     актор — только admin:.
--  4. pub_actor_format — только текст сообщения.
--  5. REVOKE EXECUTE у PUBLIC на новые и пересозданные функции; REVOKE на
--     таблицу журнала доступа.

-- ══ Формат актора ═══════════════════════════════════════════════════════

-- Формат актёра (раздел 4.1 + P-R-ADM): AI актёром не бывает.
CREATE OR REPLACE FUNCTION "pub_is_actor"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL
      OR p_v ~ '^(member:[A-Za-z0-9_-]{1,64}|admin:[A-Za-z0-9_-]{1,58}|system:[a-z0-9][a-z0-9-]{0,63}|public|restore:[A-Za-z0-9_-]{1,64})$'
$$;

-- Оператор Админки платформы (P-R-ADM).
CREATE FUNCTION "pub_is_admin"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NOT NULL AND p_v ~ '^admin:[A-Za-z0-9_-]{1,58}$'
$$;

-- Человек: участник кабинета или оператор Админки (NULL — как pub_is_member).
CREATE FUNCTION "pub_is_person"(p_v TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_v IS NULL OR p_v ~ '^(member:[A-Za-z0-9_-]{1,64}|admin:[A-Za-z0-9_-]{1,58})$'
$$;

CREATE OR REPLACE FUNCTION "pub_actor_format"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r JSONB := to_jsonb(NEW);
  c TEXT;
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    PERFORM "sites"."pub_chk"("sites"."pub_is_actor"(r ->> c),
      format('%s.%s: актёр не member:/admin:/system:/public/restore:', TG_TABLE_NAME, c));
  END LOOP;
  RETURN NEW;
END;
$$;

-- ══ «Решает/проверяет человек» ══════════════════════════════════════════

CREATE OR REPLACE FUNCTION "pub_parameters_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."key" = ANY ("sites"."pub_parameter_keys"()), 'pub_parameters.key: вне PARAMETER_KEYS');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['assumption', 'approved', 'rejected', 'revoked']), 'pub_parameters.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_parameters.version: ≥ 1');
  PERFORM "sites"."pub_chk"("sites"."pub_jsize"(NEW."value", 65536), 'pub_parameters.value: больше 64 КБ');
  PERFORM "sites"."pub_chk"((NEW."status" = 'approved') = (NEW."approvedAt" IS NOT NULL AND NEW."approvedBy" IS NOT NULL),
    'pub_parameters.approvedAt/approvedBy: заполнены ⇔ status=approved');
  PERFORM "sites"."pub_chk"("sites"."pub_is_person"(NEW."approvedBy"), 'pub_parameters.approvedBy: утверждает человек (member:/admin:)');
  IF TG_OP = 'UPDATE' THEN
    PERFORM "sites"."pub_chk"(NEW."key" = OLD."key", 'pub_parameters.key: неизменяем');
    PERFORM "sites"."pub_chk"(NEW."version" >= OLD."version", 'pub_parameters.version: не уменьшается');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "pub_parameter_decisions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."parameterKey" = ANY ("sites"."pub_parameter_keys"()), 'pub_parameter_decisions.parameterKey: вне PARAMETER_KEYS');
  PERFORM "sites"."pub_chk"(NEW."fromStatus" = ANY (ARRAY['assumption', 'approved', 'rejected', 'revoked'])
                       AND NEW."toStatus" = ANY (ARRAY['assumption', 'approved', 'rejected', 'revoked']), 'pub_parameter_decisions.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_parameter_decisions.version: ≥ 1');
  PERFORM "sites"."pub_chk"(NEW."decidedBy" IS NOT NULL AND "sites"."pub_is_person"(NEW."decidedBy"), 'pub_parameter_decisions.decidedBy: решает человек (member:/admin:)');
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

CREATE OR REPLACE FUNCTION "pub_reddit_rule_snapshots_guard"() RETURNS trigger
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
  PERFORM "sites"."pub_chk"("sites"."pub_is_person"(NEW."reviewedBy"), 'pub_reddit_rule_snapshots.reviewedBy: проверяет человек (member:/admin:)');
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
                                 WHEN 'adaptation_meaning' THEN NEW."checkedBy" ~ '^member:'
                                 ELSE NEW."checkedBy" ~ '^member:'
                                   OR ("sites"."pub_is_admin"(NEW."checkedBy") AND EXISTS (
                                        SELECT 1 FROM "sites"."pub_content_versions" v
                                          JOIN "sites"."pub_contents" c ON c."id" = v."contentId"
                                         WHERE v."id" = NEW."versionId" AND c."kind" IN ('reddit_post', 'reddit_comment'))) END,
    'pub_qa_checks.checkedBy: ai_review — system:ai-review с aiCallId, reddit_policy — system:reddit-policy, иначе member: (admin: — только Reddit-материал)');
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

CREATE OR REPLACE FUNCTION "pub_ai_calls_guard"() RETURNS trigger
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
  PERFORM "sites"."pub_chk"(NEW."requestedBy" ~ '^member:' OR NEW."requestedBy" = 'system:eval'
      OR ("sites"."pub_is_admin"(NEW."requestedBy") AND NEW."generator" = 'pub.reddit.draft')
      OR "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId"),
    'pub_ai_calls.requestedBy: member:, system:eval или admin: (только pub.reddit.draft)');
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

-- ══ Оффер и факты бренда (v1.2) ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION "pub_offer_versions_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(NEW."version" >= 1, 'pub_offer_versions.version: ≥ 1');
  PERFORM "sites"."pub_chk"(char_length(NEW."title") BETWEEN 1 AND 300 AND char_length(NEW."text") BETWEEN 1 AND 20000
      AND "sites"."pub_len"(NEW."priceNote", 1, 2000), 'pub_offer_versions: длина title/text/priceNote');
  PERFORM "sites"."pub_chk"(NEW."status" = ANY (ARRAY['draft', 'active', 'superseded', 'historical']), 'pub_offer_versions.status: вне списка');
  PERFORM "sites"."pub_chk"(NEW."status" <> 'active' OR (NEW."approvedBy" IS NOT NULL AND NEW."approvedAt" IS NOT NULL),
    'pub_offer_versions: active требует approvedBy и approvedAt');
  PERFORM "sites"."pub_chk"("sites"."pub_is_person"(NEW."approvedBy"), 'pub_offer_versions.approvedBy: утверждает человек (member:/admin:)');
  PERFORM "sites"."pub_chk"("sites"."pub_hex64"(NEW."hash"), 'pub_offer_versions.hash: sha256 hex');
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'draft' THEN
    PERFORM "sites"."pub_chk"((NEW."title", NEW."text", NEW."priceNote", NEW."hash", NEW."version")
                               IS NOT DISTINCT FROM (OLD."title", OLD."text", OLD."priceNote", OLD."hash", OLD."version"),
      'pub_offer_versions: содержимое неизменно после выхода из draft');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "pub_brand_facts_guard"() RETURNS trigger
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
  PERFORM "sites"."pub_chk"("sites"."pub_is_person"(NEW."approvedBy"), 'pub_brand_facts.approvedBy: утверждает человек (member:/admin:)');
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

-- ══ Журнал доступа Админки (v1.2) ═══════════════════════════════════════

-- CreateTable
CREATE TABLE "pub_reddit_admin_access_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pub_reddit_admin_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pub_reddit_admin_access_log_at_idx" ON "pub_reddit_admin_access_log"("at");

CREATE FUNCTION "pub_reddit_admin_access_log_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(NEW."id") BETWEEN 1 AND 64, 'pub_reddit_admin_access_log.id: длина 1..64');
  PERFORM "sites"."pub_chk"("sites"."pub_is_admin"(NEW."actor"), 'pub_reddit_admin_access_log.actor: только admin:<userId>');
  PERFORM "sites"."pub_chk"(NEW."method" = ANY (ARRAY['GET', 'POST', 'PATCH']), 'pub_reddit_admin_access_log.method: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."route") BETWEEN 1 AND 200 AND NEW."route" ~ '^[a-z0-9][a-z0-9/:._*?-]*$',
    'pub_reddit_admin_access_log.route: шаблон маршрута без значений (≤ 200)');
  PERFORM "sites"."pub_chk"(NEW."status" BETWEEN 100 AND 599, 'pub_reddit_admin_access_log.status: 100..599');
  RETURN NEW;
END;
$$;

-- Append-only с ретенцией: правка — никогда; удаление — только старше 365 дней.
CREATE FUNCTION "pub_reddit_admin_access_log_ao"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM "sites"."pub_chk"(false, 'pub_reddit_admin_access_log: append-only, TRUNCATE запрещён');
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM "sites"."pub_chk"(OLD."at" < now() - interval '365 days',
      'pub_reddit_admin_access_log: удаление — только строк старше 365 дней (ретенция)');
    RETURN OLD;
  END IF;
  PERFORM "sites"."pub_chk"(false, 'pub_reddit_admin_access_log: append-only, правка запрещена');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pub_reddit_admin_access_log_actor" BEFORE INSERT OR UPDATE ON "pub_reddit_admin_access_log"
  FOR EACH ROW EXECUTE FUNCTION "pub_actor_format"('actor');
CREATE TRIGGER "pub_reddit_admin_access_log_identity" BEFORE UPDATE ON "pub_reddit_admin_access_log"
  FOR EACH ROW EXECUTE FUNCTION "pub_immutable_cols"('id', 'actor', 'method', 'route', 'status', 'at');
CREATE TRIGGER "pub_reddit_admin_access_log_guard" BEFORE INSERT OR UPDATE ON "pub_reddit_admin_access_log"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_admin_access_log_guard"();
CREATE TRIGGER "pub_reddit_admin_access_log_ao" BEFORE UPDATE OR DELETE ON "pub_reddit_admin_access_log"
  FOR EACH ROW EXECUTE FUNCTION "pub_reddit_admin_access_log_ao"();
CREATE TRIGGER "pub_reddit_admin_access_log_no_truncate" BEFORE TRUNCATE ON "pub_reddit_admin_access_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "pub_reddit_admin_access_log_ao"();

-- ══ Права ═══════════════════════════════════════════════════════════════

REVOKE ALL ON "pub_reddit_admin_access_log" FROM PUBLIC, publisher_public, assist_public;

DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY '{anon,authenticated}'::text[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON %I FROM %I', 'pub_reddit_admin_access_log', r);
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
