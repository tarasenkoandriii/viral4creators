-- AI Publisher, P-R M2 — аудит Reddit-подсистемы 15.10.2026, зона m2,
-- решение Р-RD-AUD-5 (находки m2-1, m2-10; doc/ai-publisher/reddit-manual-
-- mvp-adapted.md §13, «Аудит 15.10.2026»).
--
-- Отчёт «Отметить опубликованным» (`pub_publications.reportKind =
-- 'user_reported'`) — запись факта со слов человека. Раньше триггер
-- требовал ДЕЙСТВУЮЩЕГО согласования версии, и опубликованный в Reddit
-- текст нельзя было отметить, если после копирования согласование сняли
-- каскадом (новый снимок правил, BLOCK перепроверки, смена оффера). Теперь
-- для INSERT строки `user_reported` достаточно согласования ЭТОЙ версии
-- с её hash (любого статуса — как и раньше проверяются тип, hash, objectId
-- и заморозка) и аудита `copy` этой версии у материала. Прочие публикации
-- (P0, `standard`) — без изменений.
--
-- Forward-only (как Р-RD-12): функция пересоздаётся из последней версии
-- (core 20261016090000) с одной правкой.

CREATE OR REPLACE FUNCTION "pub_publication_guard"() RETURNS trigger
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
    -- Р-RD-AUD-5 (аудит m2-1): отчёт человека о ручной публикации Reddit
    -- (`user_reported`) — факт, а не выпуск: принимается и при снятом
    -- согласовании (каскад правил/оффера после копирования), но только для
    -- версии, которую копировали (аудит `copy` этого материала с этой
    -- версией). Согласование — по-прежнему этой версии и этого hash.
    PERFORM "sites"."pub_chk"(NEW."status" NOT IN ('pending', 'published') OR a_status = 'active'
        OR "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId")
        OR (TG_OP = 'INSERT' AND NEW."reportKind" = 'user_reported' AND EXISTS (
              SELECT 1
                FROM "sites"."pub_content_versions" v
                JOIN "sites"."pub_audit_events" e
                  ON e."productId" = v."productId" AND e."objectType" = 'content' AND e."objectId" = v."contentId"
               WHERE v."id" = NEW."versionId" AND v."productId" = NEW."productId"
                 AND e."action" = 'copy' AND e."meta"->>'versionId' = NEW."versionId")),
      'pub_publications: публикация только при активном согласовании (отчёт user_reported — только о скопированной версии)');
    IF NEW."stage" = 'live' AND NOT "sites"."pub_restoring"(TG_OP, NEW."createdBy", NEW."productId") THEN
      SELECT p."kind", p."mode" INTO p_kind, p_mode FROM "sites"."pub_products" p WHERE p."id" = NEW."productId";
      PERFORM "sites"."pub_chk"(p_kind = 'working' AND p_mode = 'live', 'pub_publications.stage: live только в продукте kind=working, mode=live');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Пересозданная функция: EXECUTE у PUBLIC снимаем (её вызывает только триггер).
REVOKE ALL ON FUNCTION "pub_publication_guard"() FROM PUBLIC;
