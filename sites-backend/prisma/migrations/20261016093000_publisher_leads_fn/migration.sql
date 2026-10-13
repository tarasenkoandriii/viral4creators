-- AI Publisher, пакет P-D — функции заявок (проектный документ
-- doc/ai-publisher/IMPLEMENTATION-DESIGN.md §6.5, §15.3; ТЗ §21; AT-CORE-09).
-- Слот миграции P-D: только функции, без CREATE/ALTER TABLE, без CHECK и
-- CONSTRAINT TRIGGER (Р-PUB-A0-2). Таблицы и триггеры — publisher_core.
--
-- `pub_leads_guard` (аудит P-D S3-9): после удаления контакта в заявке не
-- должно оставаться производного от ПД. `requestHash` — ключевой HMAC
-- канонического тела (имя, контакт, задача) для идемпотентности приёма;
-- при `erase` сервис в ТОМ ЖЕ UPDATE, что ставит `erasedAt`, заменяет его
-- обезличенным sha256('erased' || id). Во всём остальном функция та же,
-- что в publisher_core (тело перенесено без изменений; триггер прежний).
-- Перенос правки в миграцию ядра — запрос координатору (17.4, отчёт P-D).
--
-- DEFINER + search_path = pg_catalog, pg_temp (§5.2, migrations.spec);
-- EXECUTE у PUBLIC снимается в конце (контракт слотов).

CREATE OR REPLACE FUNCTION "pub_leads_guard"() RETURNS trigger
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
    -- P-D (аудит S3-9): requestHash — HMAC канонического тела заявки (имя,
    -- контакт, задача); при удалении контакта (тот же UPDATE ставит
    -- erasedAt) его заменяют обезличенным значением, иначе он неизменен.
    PERFORM "sites"."pub_chk"((NEW."submissionKey", NEW."publicRef", NEW."receivedAt")
                               IS NOT DISTINCT FROM (OLD."submissionKey", OLD."publicRef", OLD."receivedAt")
                             AND (NEW."requestHash" IS NOT DISTINCT FROM OLD."requestHash"
                                  OR (OLD."erasedAt" IS NULL AND NEW."erasedAt" IS NOT NULL)),
      'pub_leads: submissionKey, requestHash, publicRef, receivedAt неизменны (requestHash — кроме удаления контакта)');
  END IF;
  RETURN NEW;
END;
$$;

-- Функции этой миграции у PUBLIC не исполняются (триггер вызывает их от
-- владельца; publisher_public/assist_public EXECUTE не нужен).
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.proname = 'pub_leads_guard'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END
$$;
