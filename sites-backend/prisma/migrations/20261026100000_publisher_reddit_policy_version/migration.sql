-- AI Publisher, P-R M2 — внутренний аудит 19.10.2026, IA-AB-08 (Р-IA-FXC-4;
-- doc/ai-publisher/internal-audit-2026-10-19/AB-defects.csv).
--
-- Версия словарей проверки `reddit_policy` (`REDDIT_MARKERS_VERSION`,
-- `markers@N`, reddit/markers.ts) пишется в строку проверки: по строке
-- `pub_qa_checks` видно, какими правилами получен BLOCK/WARN (разбор спора,
-- аудит; материал, согласованный на markers@3, при копировании проверяется
-- markers@4 — теперь это различимо).
--
-- Колонка NULL-допустима: строки до этой миграции (и их восстановление из
-- копии) версии не знают — она не выдумывается. Новые строки reddit_policy
-- приложение пишет всегда; у прочих видов проверок версии нет (NULL).
-- Формат проверяет триггер `pub_qa_checks_guard` (CHECK в pub_* запрещены,
-- §5.2: wasm migrate diff на них падает) — функция пересоздаётся из последней
-- версии (20261023090000_publisher_admin_actor) с одной добавкой.
-- Таблица append-only (`pub_append_only`): прежние строки не правятся.
-- Номер — после последней миграции sites-backend (20261025093000_qa_plans);
-- миграции backend отдельные.

-- AlterTable
ALTER TABLE "pub_qa_checks" ADD COLUMN     "rulesVersion" TEXT;

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
  -- IA-AB-08: версия словарей — только у reddit_policy и только markers@N;
  -- NULL — строки до этой миграции и их восстановление из копии.
  PERFORM "sites"."pub_chk"(NEW."rulesVersion" IS NULL
      OR (NEW."kind" = 'reddit_policy' AND NEW."rulesVersion" ~ '^markers@[1-9][0-9]{0,5}$'),
    'pub_qa_checks.rulesVersion: markers@N, только у reddit_policy');
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

REVOKE ALL ON FUNCTION "pub_qa_checks_guard"() FROM PUBLIC;
