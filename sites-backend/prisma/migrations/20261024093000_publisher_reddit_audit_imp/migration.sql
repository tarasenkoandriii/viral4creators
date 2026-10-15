-- AI Publisher, P-R — аудит Reddit-подсистемы 15.10.2026, решение Р-RD-AUD-3
-- (находка imp-8; doc/ai-publisher/reddit-manual-mvp-adapted.md §13,
-- «Аудит 15.10.2026»).
--
-- Импорт исследования из вторичных источников: если страница правил помечена
-- «not readable», у снимка нет первоисточника — `sourceUrl = null`. Такой
-- снимок хранит выдержку как доказательство P-R вида `manual_text` без URL
-- (origin=reddit, private, manual, restricted, ≤ 5000, без контактов).
-- Подтверждение (review) по-прежнему требует источник с URL (проверка уже
-- была в 20261023090000) — снимок без первоисточника подтвердить нельзя.
--
-- Forward-only (как Р-RD-12): обе функции пересоздаются из их последних
-- версий (pub_reddit_sources_guard — 20261021090000_publisher_reddit_m2,
-- pub_reddit_rule_snapshots_guard — 20261023090000_publisher_admin_actor) с
-- одной правкой: вставка доказательства `manual_text` без URL / снимок на
-- нём. Таблицы и триггеры не меняются.

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
    PERFORM "sites"."pub_chk"((NEW."kind" IN ('url', 'discussion') OR (NEW."kind" = 'manual_text' AND NEW."url" IS NULL))
        AND NEW."visibility" = 'private'
        AND NEW."importedVia" = 'manual' AND NEW."author" IS NULL AND NEW."usage" IN ('restricted', 'revoked')
        AND NOT "sites"."pub_looks_contact"(NEW."fragment")
        AND char_length(NEW."fragment") <= CASE WHEN NEW."kind" = 'discussion' THEN 2000 ELSE 5000 END,
      'pub_sources: доказательство P-R — url/discussion/manual_text без URL, private, manual, без автора и контактов, restricted, ≤ 2000/5000');
  END IF;
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
         WHERE s."id" = NEW."sourceId"
           AND ((s."kind" = 'url' AND s."url" IS NOT NULL) OR (s."kind" = 'manual_text' AND s."url" IS NULL))
           AND s."visibility" = 'private' AND s."importedVia" = 'manual' AND s."origin" = 'reddit'),
      'pub_reddit_rule_snapshots.sourceId: первоисточник kind=url с URL (или manual_text без URL — вторичные источники), manual, private, origin=reddit');
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

-- Пересозданные функции: EXECUTE у PUBLIC снимаем (их вызывают только триггеры).
REVOKE ALL ON FUNCTION "pub_reddit_sources_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "pub_reddit_rule_snapshots_guard"() FROM PUBLIC;
