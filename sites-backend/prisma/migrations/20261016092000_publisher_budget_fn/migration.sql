-- AI Publisher, пакет P-C — функции движения денег (проектный документ
-- doc/ai-publisher/IMPLEMENTATION-DESIGN.md §6.4, §8.2, §9.2; ТЗ §17).
-- Слот миграции P-C: только функции, без CREATE/ALTER TABLE, без CHECK и
-- CONSTRAINT TRIGGER (Р-PUB-A0-2). Таблицы — миграция publisher_core.
--
-- Счётчики строки лимита `pub_budget_limits` (netPaid, openCommit,
-- usedPlacements, usedTools, aiMonth) и суммы головы `pub_expenses` (paid,
-- refunded, cancelled, delivered, amountTotal) меняют ТОЛЬКО функции ниже,
-- каждая одним условным UPDATE строки лимита (EvalPlanQual в READ
-- COMMITTED перепроверяет WHERE на последней версии строки после ожидания
-- блокировки — второй претендент на тот же остаток не пройдёт условие).
--
-- Порядок блокировок (§8.1): строка лимита → согласование → закупка →
-- обязательство. Каждая функция первым оператором блокирует строку лимита
-- продукта, поэтому денежные операции одного продукта сериализуются.
--
-- Сверка (решение координатора по Р-PUB-A0-2): в конце каждой функции
-- `pub_budget_verify` сравнивает головы обязательств с Σ confirmed-записей
-- и счётчики строки лимита с Σ по головам; расхождение —
-- `PUB_BUDGET_COUNTERS_MISMATCH` и откат всей операции (оплата, сверка,
-- отмена, возврат и «оказано» при уже существующем расхождении проходят,
-- если его не меняют — `pub_budget_verify_same`; починка —
-- `pub_budget_rebuild_counters` решением владельца). Вторая линия —
-- ежедневное задание `budget-reconcile` (задача владельцу и остановка новых
-- обязательств: открытая задача `budget-reconcile:*` — `PUB_BUDGET_STOPPED`).
--
-- Ошибки предметной логики — `RAISE EXCEPTION '<КОД>' USING ERRCODE =
-- 'P0001'`, где код — из contracts/errors.ts (сервис переводит в PubError)
-- либо служебный `PUB_BUDGET_COUNTERS_MISMATCH` / `PUB_AMOUNT_EXCEEDS_OPEN`.
-- Отказы гвардов таблиц — по-прежнему 23514.
--
-- Все функции читают таблицы → SECURITY DEFINER SET search_path =
-- pg_catalog, pg_temp, имена с явной схемой "sites" (§5.2, migrations.spec).
-- EXECUTE у PUBLIC снимается в конце (контракт слотов).

-- ══ Служебные ═══════════════════════════════════════════════════════════

-- Новый id строки (Prisma cuid() генерирует клиент; функциям нужен свой).
CREATE FUNCTION "pub_budget_new_id"(p_prefix TEXT) RETURNS TEXT
LANGUAGE sql VOLATILE AS $$
  SELECT p_prefix || '_' || replace(gen_random_uuid()::text, '-', '')
$$;

-- Остановка новых обязательств ежедневной сверкой: открытая задача
-- проверки строки лимита от задания `budget-reconcile` (снимает владелец,
-- решив задачу после разбора расхождения).
CREATE FUNCTION "pub_budget_stopped"(p_product TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "sites"."pub_review_tasks" t
     WHERE t."productId" = p_product AND t."objectType" = 'budget_limit'
       AND t."status" = 'open' AND t."triggerRef" LIKE 'budget-reconcile:%')
$$;

-- Эталон счётчиков из записей (§9.2): головы обязательств = Σ confirmed
-- записей по видам; счётчики лимита = Σ по головам.
--   amountTotal = Σ commit + Σ adjust; paid = Σ pay; refunded = Σ refund;
--   cancelled = Σ cancel; delivered = Σ deliver (только confirmed);
--   netPaid = Σ (paid − refunded); openCommit = Σ (total − paid − cancelled);
--   used<кат.> = Σ (total − cancelled − refunded) = net_paid + open категории
--   (`other` — в лимите tools, ТЗ §17); aiMonth — открытое обязательство
--   месяцев AI (`pub_ai_budget_months.expenseId`, Р-PUB-9);
--   headsBad — число голов, расходящихся со своими записями.
-- Головы обязательств продукта рядом с суммами их confirmed-записей.
CREATE FUNCTION "pub_budget_heads"(p_product TEXT)
RETURNS TABLE ("expenseId" TEXT, "category" TEXT,
               "hTotal" BIGINT, "hPaid" BIGINT, "hRefunded" BIGINT, "hCancelled" BIGINT, "hDelivered" BIGINT,
               "total" BIGINT, "paid" BIGINT, "refunded" BIGINT, "cancelled" BIGINT, "delivered" BIGINT,
               "ai" BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e."id", e."category",
         e."amountTotalMinor", e."paidMinor", e."refundedMinor", e."cancelledMinor", e."deliveredMinor",
         COALESCE(sum(en."amountMinor") FILTER (WHERE en."status" = 'confirmed' AND en."kind" IN ('commit', 'adjust')), 0)::BIGINT,
         COALESCE(sum(en."amountMinor") FILTER (WHERE en."status" = 'confirmed' AND en."kind" = 'pay'), 0)::BIGINT,
         COALESCE(sum(en."amountMinor") FILTER (WHERE en."status" = 'confirmed' AND en."kind" = 'refund'), 0)::BIGINT,
         COALESCE(sum(en."amountMinor") FILTER (WHERE en."status" = 'confirmed' AND en."kind" = 'cancel'), 0)::BIGINT,
         COALESCE(sum(en."amountMinor") FILTER (WHERE en."status" = 'confirmed' AND en."kind" = 'deliver'), 0)::BIGINT,
         EXISTS (SELECT 1 FROM "sites"."pub_ai_budget_months" m WHERE m."expenseId" = e."id")
    FROM "sites"."pub_expenses" e
    LEFT JOIN "sites"."pub_expense_entries" en ON en."expenseId" = e."id"
   WHERE e."productId" = p_product
   GROUP BY e."id"
$$;

-- Таблиц сама не читает (только `pub_budget_heads`) — чистая по правилу
-- §5.2: без DEFINER и SET; EXECUTE у PUBLIC снят, как у всех `pub_budget_*`.
CREATE FUNCTION "pub_budget_expected"(p_product TEXT)
RETURNS TABLE ("netPaid" BIGINT, "openCommit" BIGINT, "usedPlacements" BIGINT,
               "usedTools" BIGINT, "aiMonth" BIGINT, "headsBad" INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(h."paid" - h."refunded"), 0)::BIGINT,
         COALESCE(sum(h."total" - h."paid" - h."cancelled"), 0)::BIGINT,
         COALESCE(sum(h."total" - h."cancelled" - h."refunded") FILTER (WHERE h."category" = 'placements'), 0)::BIGINT,
         COALESCE(sum(h."total" - h."cancelled" - h."refunded") FILTER (WHERE h."category" <> 'placements'), 0)::BIGINT,
         COALESCE(sum(h."total" - h."paid" - h."cancelled") FILTER (WHERE h."ai"), 0)::BIGINT,
         (count(*) FILTER (WHERE (h."hTotal", h."hPaid", h."hRefunded", h."hCancelled", h."hDelivered")
                                 IS DISTINCT FROM (h."total", h."paid", h."refunded", h."cancelled", h."delivered")))::INTEGER
    FROM "sites"."pub_budget_heads"(p_product) h
$$;

-- Расхождение счётчиков (Р-PUB-C-4): '' — согласованы; иначе разницы
-- «строка лимита − эталон» и «голова − записи» каждой расходящейся головы.
-- Оплата, сверка, отмена, возврат и «оказано» при уже существующем
-- расхождении разрешены, если не меняют его (`pub_budget_verify_same`):
-- деньги, которые уже ушли или вернулись, записать нужно, а расхождение
-- чинит владелец пересборкой (`pub_budget_rebuild_counters`). Новые
-- обязательства (резерв, расход, положительная корректировка) — только при
-- полном совпадении (`pub_budget_verify`).
CREATE FUNCTION "pub_budget_drift"(p_product TEXT, p_account TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
           WHEN d."heads" IS NULL
                AND (bl."netPaidMinor", bl."openCommitMinor", bl."usedPlacementsMinor", bl."usedToolsMinor")
                    = (x."netPaid", x."openCommit", x."usedPlacements", x."usedTools") THEN ''
           ELSE format('limit=%s/%s/%s/%s heads=%s',
                       bl."netPaidMinor" - x."netPaid", bl."openCommitMinor" - x."openCommit",
                       bl."usedPlacementsMinor" - x."usedPlacements", bl."usedToolsMinor" - x."usedTools",
                       COALESCE(d."heads", ''))
         END
    FROM "sites"."pub_budget_limits" bl
   CROSS JOIN "sites"."pub_budget_expected"(p_product) x
   CROSS JOIN (SELECT string_agg(format('%s:%s/%s/%s/%s/%s', h."expenseId", h."hTotal" - h."total", h."hPaid" - h."paid",
                                        h."hRefunded" - h."refunded", h."hCancelled" - h."cancelled",
                                        h."hDelivered" - h."delivered"), ';' ORDER BY h."expenseId") AS "heads"
                 FROM "sites"."pub_budget_heads"(p_product) h
                WHERE (h."hTotal", h."hPaid", h."hRefunded", h."hCancelled", h."hDelivered")
                      IS DISTINCT FROM (h."total", h."paid", h."refunded", h."cancelled", h."delivered")) d
   WHERE bl."productId" = p_product AND bl."accountId" = p_account
$$;

-- Сверка внутри каждой денежной функции (первая линия, Р-PUB-A0-2).
-- Строка лимита к этому моменту уже заблокирована вызывающей функцией.
-- aiMonth — справочный счётчик (в условиях резерва не участвует, его часть
-- уже внутри openCommit/usedTools): обновляется, а не сравнивается — связь
-- месяца AI с обязательством пишет P-B2 после создания обязательства.
CREATE FUNCTION "pub_budget_verify"(p_product TEXT, p_account TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  x RECORD;
  l RECORD;
BEGIN
  SELECT * INTO x FROM "sites"."pub_budget_expected"(p_product);
  SELECT bl."netPaidMinor", bl."openCommitMinor", bl."usedPlacementsMinor", bl."usedToolsMinor", bl."aiMonthMinor"
    INTO l FROM "sites"."pub_budget_limits" bl
   WHERE bl."productId" = p_product AND bl."accountId" = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUB_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'pub_budget_limits';
  END IF;
  IF x."headsBad" > 0
     OR (l."netPaidMinor", l."openCommitMinor", l."usedPlacementsMinor", l."usedToolsMinor")
        IS DISTINCT FROM (x."netPaid", x."openCommit", x."usedPlacements", x."usedTools") THEN
    RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH' USING ERRCODE = 'P0001',
      DETAIL = format('heads=%s limit=(%s,%s,%s,%s) expected=(%s,%s,%s,%s)', x."headsBad",
                      l."netPaidMinor", l."openCommitMinor", l."usedPlacementsMinor", l."usedToolsMinor",
                      x."netPaid", x."openCommit", x."usedPlacements", x."usedTools");
  END IF;
  IF l."aiMonthMinor" IS DISTINCT FROM x."aiMonth" THEN
    UPDATE "sites"."pub_budget_limits" SET "aiMonthMinor" = x."aiMonth", "updatedAt" = now()
     WHERE "productId" = p_product AND "accountId" = p_account;
  END IF;
END;
$$;

-- Нестрогая сверка (оплата, сверка, отмена, возврат, «оказано»): операция
-- не меняет уже существующее расхождение `p_before` (при '' — то же, что
-- строгая `pub_budget_verify`).
CREATE FUNCTION "pub_budget_verify_same"(p_product TEXT, p_account TEXT, p_before TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_after TEXT;
  v_ai BIGINT;
BEGIN
  IF p_before = '' THEN
    PERFORM "sites"."pub_budget_verify"(p_product, p_account);
    RETURN;
  END IF;
  v_after := "sites"."pub_budget_drift"(p_product, p_account);
  IF v_after IS DISTINCT FROM p_before THEN
    RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH' USING ERRCODE = 'P0001',
      DETAIL = format('drift before=%s after=%s', p_before, v_after);
  END IF;
  SELECT x."aiMonth" INTO v_ai FROM "sites"."pub_budget_expected"(p_product) x;
  UPDATE "sites"."pub_budget_limits" SET "aiMonthMinor" = v_ai, "updatedAt" = now()
   WHERE "productId" = p_product AND "accountId" = p_account AND "aiMonthMinor" IS DISTINCT FROM v_ai;
END;
$$;

-- Блокировка строки лимита (первый шаг функций, которые не меняют счётчики
-- условным UPDATE первым оператором): порядок «лимит → …» сохраняется.
CREATE FUNCTION "pub_budget_lock"(p_product TEXT, p_account TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cur TEXT;
BEGIN
  SELECT bl."currency" INTO v_cur FROM "sites"."pub_budget_limits" bl
   WHERE bl."productId" = p_product AND bl."accountId" = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUB_GATE_CLOSED' USING ERRCODE = 'P0001', DETAIL = 'budget_not_built';
  END IF;
  RETURN v_cur;
END;
$$;

-- Голова обязательства продукта под блокировкой (после строки лимита).
CREATE FUNCTION "pub_budget_expense"(p_product TEXT, p_account TEXT, p_expense TEXT)
RETURNS "sites"."pub_expenses"
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e "sites"."pub_expenses";
BEGIN
  SELECT * INTO e FROM "sites"."pub_expenses" x
   WHERE x."id" = p_expense AND x."productId" = p_product AND x."accountId" = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUB_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'pub_expenses';
  END IF;
  RETURN e;
END;
$$;

-- Оплата в статусе pending|unknown по обязательству (§7.3, AT-CORE-15).
CREATE FUNCTION "pub_budget_has_unsettled_pay"(p_expense TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "sites"."pub_expense_entries" en
                  WHERE en."expenseId" = p_expense AND en."kind" = 'pay'
                    AND en."status" IN ('pending', 'unknown'))
$$;

-- Статус головы и признак сверки после движения.
CREATE FUNCTION "pub_budget_touch_expense"(p_expense TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "sites"."pub_expenses" e
     SET "reconcileRequired" = "sites"."pub_budget_has_unsettled_pay"(e."id"),
         "status" = CASE WHEN e."amountTotalMinor" - e."paidMinor" - e."cancelledMinor" = 0 THEN 'closed' ELSE 'open' END,
         "updatedAt" = now(),
         "revision" = e."revision" + 1
   WHERE e."id" = p_expense;
END;
$$;

-- Запись журнала движения (AO). confirmed — с автором и временем.
CREATE FUNCTION "pub_budget_entry"(p_product TEXT, p_account TEXT, p_expense TEXT, p_kind TEXT,
                                   p_amount BIGINT, p_status TEXT, p_external_ref TEXT, p_source_doc TEXT,
                                   p_note TEXT, p_occurred_at TIMESTAMPTZ, p_opkey TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id TEXT := "sites"."pub_budget_new_id"('exe');
BEGIN
  -- Алиас `AS en`: имя таблицы не должно выглядеть вызовом функции для
  -- статической проверки DEFINER (migrations.spec ищет `"sites"."pub_…"` без `(`).
  INSERT INTO "sites"."pub_expense_entries" AS en
    ("id", "accountId", "productId", "expenseId", "kind", "amountMinor", "status", "externalRef",
     "sourceDocument", "note", "occurredAt", "confirmedAt", "confirmedBy", "opKey", "createdBy", "updatedAt")
  VALUES (v_id, p_account, p_product, p_expense, p_kind, p_amount, p_status, p_external_ref,
          p_source_doc, p_note, COALESCE(p_occurred_at, now()),
          CASE WHEN p_status = 'confirmed' THEN now() END,
          CASE WHEN p_status = 'confirmed' THEN p_actor END,
          p_opkey, p_actor, now());
  RETURN v_id;
END;
$$;

-- ══ Резерв обязательства закупки (§8.2, AT-CORE-14) ═══════════════════

CREATE FUNCTION "pub_budget_reserve"(p_product TEXT, p_account TEXT, p_amount BIGINT, p_cat TEXT,
                                     p_approval TEXT, p_snap TEXT, p_placement TEXT, p_rev INTEGER,
                                     p_opkey TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n INTEGER;
  a RECORD;
  pl RECORD;
  v_exp TEXT := "sites"."pub_budget_new_id"('exp');
BEGIN
  IF p_cat IS DISTINCT FROM 'placements' OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'reserve: placements, amount > 0';
  END IF;
  IF "sites"."pub_budget_stopped"(p_product) THEN
    RAISE EXCEPTION 'PUB_BUDGET_STOPPED' USING ERRCODE = 'P0001', DETAIL = 'reconcile';
  END IF;
  -- Атомарный резерв: условие перепроверяется на последней версии строки.
  UPDATE "sites"."pub_budget_limits"
     SET "openCommitMinor"     = "openCommitMinor" + p_amount,
         "usedPlacementsMinor" = "usedPlacementsMinor" + p_amount,
         "revision" = "revision" + 1, "updatedAt" = now()
   WHERE "productId" = p_product AND "accountId" = p_account
     AND "totalLimitMinor" - "netPaidMinor" - "openCommitMinor" - "protectedReserveMinor" >= p_amount
     AND p_amount <= "perPurchaseMaxMinor"
     AND "placementsLimitMinor" - "usedPlacementsMinor" >= p_amount;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'PUB_BUDGET_INSUFFICIENT' USING ERRCODE = 'P0001';
  END IF;
  -- Согласование: действующее, не истёкшее, этой закупки, снимок цены совпадает.
  UPDATE "sites"."pub_approvals"
     SET "status" = 'consumed', "updatedAt" = now()
   WHERE "id" = p_approval AND "accountId" = p_account AND "productId" = p_product
     AND "type" = 'purchase' AND "objectType" = 'placement' AND "objectId" = p_placement
     AND "status" = 'active' AND "expiresAt" > now() AND "priceSnapshotHash" = p_snap;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    SELECT x."status", x."expiresAt", x."objectId" INTO a FROM "sites"."pub_approvals" x
     WHERE x."id" = p_approval AND x."accountId" = p_account AND x."productId" = p_product AND x."type" = 'purchase';
    IF NOT FOUND OR a."objectId" <> p_placement OR a."status" NOT IN ('active', 'expired') THEN
      RAISE EXCEPTION 'PUB_APPROVAL_REQUIRED' USING ERRCODE = 'P0001';
    ELSIF a."status" = 'expired' OR a."expiresAt" <= now() THEN
      RAISE EXCEPTION 'PUB_APPROVAL_EXPIRED' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'PUB_APPROVAL_STALE' USING ERRCODE = 'P0001';
  END IF;
  SELECT x."placementCode", x."totalPriceMinor", x."currency", x."origCurrency", x."origAmountMinor",
         x."fxRate", x."fxSource", x."fxAt", x."approvalId", x."status", x."revision"
    INTO pl FROM "sites"."pub_placements" x
   WHERE x."id" = p_placement AND x."accountId" = p_account AND x."productId" = p_product FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUB_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'pub_placements';
  END IF;
  IF pl."status" <> 'approved' OR pl."revision" <> p_rev THEN
    RAISE EXCEPTION 'PUB_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF pl."approvalId" IS DISTINCT FROM p_approval OR pl."totalPriceMinor" <> p_amount THEN
    RAISE EXCEPTION 'PUB_APPROVAL_STALE' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "sites"."pub_expenses"
    ("id", "accountId", "productId", "category", "description", "placementId", "amountTotalMinor",
     "currency", "origCurrency", "origAmountMinor", "fxRate", "fxSource", "fxAt", "createdBy", "updatedAt")
  VALUES (v_exp, p_account, p_product, 'placements', 'Закупка ' || pl."placementCode", p_placement, p_amount,
          pl."currency", pl."origCurrency", pl."origAmountMinor", pl."fxRate", pl."fxSource", pl."fxAt", p_actor, now());
  PERFORM "sites"."pub_budget_entry"(p_product, p_account, v_exp, 'commit', p_amount, 'confirmed', NULL, NULL,
                                     NULL, now(), p_opkey, p_actor);
  UPDATE "sites"."pub_placements"
     SET "status" = 'budget_reserved', "expenseId" = v_exp, "revision" = "revision" + 1, "updatedAt" = now()
   WHERE "id" = p_placement AND "status" = 'approved' AND "revision" = p_rev;
  PERFORM "sites"."pub_budget_verify"(p_product, p_account);
  RETURN v_exp;
END;
$$;

-- ══ Расход tools|other (гейт `spend`, в т. ч. обязательство месяца AI) ═

CREATE FUNCTION "pub_budget_commit_tools"(p_product TEXT, p_account TEXT, p_amount BIGINT, p_cat TEXT,
                                          p_description TEXT, p_orig_currency TEXT, p_orig_amount BIGINT,
                                          p_fx_rate NUMERIC, p_fx_source TEXT, p_fx_at TIMESTAMPTZ,
                                          p_source_doc TEXT, p_opkey TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n INTEGER;
  v_cur TEXT;
  v_exp TEXT := "sites"."pub_budget_new_id"('exp');
BEGIN
  IF p_cat NOT IN ('tools', 'other') OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'commit_tools: tools|other, amount > 0';
  END IF;
  IF "sites"."pub_budget_stopped"(p_product) THEN
    RAISE EXCEPTION 'PUB_BUDGET_STOPPED' USING ERRCODE = 'P0001', DETAIL = 'reconcile';
  END IF;
  UPDATE "sites"."pub_budget_limits"
     SET "openCommitMinor" = "openCommitMinor" + p_amount,
         "usedToolsMinor"  = "usedToolsMinor" + p_amount,
         "revision" = "revision" + 1, "updatedAt" = now()
   WHERE "productId" = p_product AND "accountId" = p_account
     AND "totalLimitMinor" - "netPaidMinor" - "openCommitMinor" - "protectedReserveMinor" >= p_amount
     AND "toolsLimitMinor" - "usedToolsMinor" >= p_amount
  RETURNING "currency" INTO v_cur;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'PUB_BUDGET_INSUFFICIENT' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "sites"."pub_expenses"
    ("id", "accountId", "productId", "category", "description", "amountTotalMinor", "currency",
     "origCurrency", "origAmountMinor", "fxRate", "fxSource", "fxAt", "sourceDocument", "createdBy", "updatedAt")
  VALUES (v_exp, p_account, p_product, p_cat, p_description, p_amount, v_cur,
          p_orig_currency, p_orig_amount, p_fx_rate, p_fx_source, p_fx_at, p_source_doc, p_actor, now());
  PERFORM "sites"."pub_budget_entry"(p_product, p_account, v_exp, 'commit', p_amount, 'confirmed', NULL,
                                     p_source_doc, NULL, now(), p_opkey, p_actor);
  PERFORM "sites"."pub_budget_verify"(p_product, p_account);
  RETURN v_exp;
END;
$$;

-- ══ Оплата (§7.3): confirmed переносит обязательство в факт ════════════

CREATE FUNCTION "pub_budget_pay"(p_product TEXT, p_account TEXT, p_expense TEXT, p_amount BIGINT, p_status TEXT,
                                 p_external_ref TEXT, p_source_doc TEXT, p_note TEXT, p_occurred_at TIMESTAMPTZ,
                                 p_opkey TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_drift TEXT;
  e "sites"."pub_expenses";
  n INTEGER;
  v_id TEXT;
BEGIN
  IF p_status NOT IN ('confirmed', 'pending', 'unknown') OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'pay: status confirmed|pending|unknown, amount > 0';
  END IF;
  PERFORM "sites"."pub_budget_lock"(p_product, p_account);
  v_drift := "sites"."pub_budget_drift"(p_product, p_account);
  e := "sites"."pub_budget_expense"(p_product, p_account, p_expense);
  -- Неизвестная/ожидающая оплата удерживает обязательство: новая оплата —
  -- только после сверки (AT-CORE-15, «повтор не создаёт вторую оплату»).
  IF "sites"."pub_budget_has_unsettled_pay"(p_expense) THEN
    RAISE EXCEPTION 'PUB_RECONCILE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount > e."amountTotalMinor" - e."paidMinor" - e."cancelledMinor" THEN
    RAISE EXCEPTION 'PUB_AMOUNT_EXCEEDS_OPEN' USING ERRCODE = 'P0001';
  END IF;
  v_id := "sites"."pub_budget_entry"(p_product, p_account, p_expense, 'pay', p_amount, p_status, p_external_ref,
                                     p_source_doc, p_note, p_occurred_at, p_opkey, p_actor);
  IF p_status = 'confirmed' THEN
    UPDATE "sites"."pub_budget_limits"
       SET "netPaidMinor" = "netPaidMinor" + p_amount, "openCommitMinor" = "openCommitMinor" - p_amount,
           "revision" = "revision" + 1, "updatedAt" = now()
     WHERE "productId" = p_product AND "accountId" = p_account AND "openCommitMinor" >= p_amount;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH' USING ERRCODE = 'P0001', DETAIL = 'open < pay';
    END IF;
    UPDATE "sites"."pub_expenses" SET "paidMinor" = "paidMinor" + p_amount WHERE "id" = p_expense;
  END IF;
  PERFORM "sites"."pub_budget_touch_expense"(p_expense);
  PERFORM "sites"."pub_budget_verify_same"(p_product, p_account, v_drift);
  RETURN v_id;
END;
$$;

-- ══ Сверка записи pending|unknown → confirmed|void (§7.3, AT-CORE-15) ══

CREATE FUNCTION "pub_budget_reconcile"(p_product TEXT, p_account TEXT, p_entry TEXT, p_status TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_drift TEXT;
  en "sites"."pub_expense_entries";
  e "sites"."pub_expenses";
  n INTEGER;
BEGIN
  IF p_status NOT IN ('confirmed', 'void') THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'reconcile: confirmed|void';
  END IF;
  PERFORM "sites"."pub_budget_lock"(p_product, p_account);
  v_drift := "sites"."pub_budget_drift"(p_product, p_account);
  SELECT * INTO en FROM "sites"."pub_expense_entries" x
   WHERE x."id" = p_entry AND x."productId" = p_product AND x."accountId" = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUB_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'pub_expense_entries';
  END IF;
  e := "sites"."pub_budget_expense"(p_product, p_account, en."expenseId");
  SELECT * INTO en FROM "sites"."pub_expense_entries" x WHERE x."id" = p_entry FOR UPDATE;
  IF en."status" NOT IN ('pending', 'unknown') OR en."kind" NOT IN ('pay', 'refund') THEN
    RAISE EXCEPTION 'PUB_TRANSITION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'confirmed' AND en."kind" = 'pay' THEN
    IF en."amountMinor" > e."amountTotalMinor" - e."paidMinor" - e."cancelledMinor" THEN
      RAISE EXCEPTION 'PUB_AMOUNT_EXCEEDS_OPEN' USING ERRCODE = 'P0001';
    END IF;
    UPDATE "sites"."pub_budget_limits"
       SET "netPaidMinor" = "netPaidMinor" + en."amountMinor", "openCommitMinor" = "openCommitMinor" - en."amountMinor",
           "revision" = "revision" + 1, "updatedAt" = now()
     WHERE "productId" = p_product AND "accountId" = p_account AND "openCommitMinor" >= en."amountMinor";
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH' USING ERRCODE = 'P0001', DETAIL = 'open < pay';
    END IF;
    UPDATE "sites"."pub_expenses" SET "paidMinor" = "paidMinor" + en."amountMinor" WHERE "id" = e."id";
  ELSIF p_status = 'confirmed' AND en."kind" = 'refund' THEN
    IF en."amountMinor" > e."paidMinor" - e."refundedMinor" THEN
      RAISE EXCEPTION 'PUB_AMOUNT_EXCEEDS_OPEN' USING ERRCODE = 'P0001';
    END IF;
    PERFORM "sites"."pub_budget_apply_refund"(p_product, p_account, e, en."amountMinor");
  END IF;
  UPDATE "sites"."pub_expense_entries"
     SET "status" = p_status,
         "confirmedAt" = CASE WHEN p_status = 'confirmed' THEN now() END,
         "confirmedBy" = CASE WHEN p_status = 'confirmed' THEN p_actor END,
         "updatedAt" = now()
   WHERE "id" = p_entry;
  PERFORM "sites"."pub_budget_touch_expense"(e."id");
  PERFORM "sites"."pub_budget_verify_same"(p_product, p_account, v_drift);
  RETURN p_entry;
END;
$$;

-- ══ Отмена: освобождается только подтверждённая часть (AT-CORE-17) ═════

CREATE FUNCTION "pub_budget_cancel"(p_product TEXT, p_account TEXT, p_expense TEXT, p_amount BIGINT,
                                    p_source_doc TEXT, p_note TEXT, p_occurred_at TIMESTAMPTZ, p_opkey TEXT,
                                    p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e "sites"."pub_expenses";
  n INTEGER;
  v_id TEXT;
  v_drift TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'cancel: amount >= 0';
  END IF;
  PERFORM "sites"."pub_budget_lock"(p_product, p_account);
  e := "sites"."pub_budget_expense"(p_product, p_account, p_expense);
  -- Пока оплата не сверена, неизвестно, что отменять.
  IF "sites"."pub_budget_has_unsettled_pay"(p_expense) THEN
    RAISE EXCEPTION 'PUB_RECONCILE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- Подтверждённо отменено 0 (заказ оплачен и снят — деньги вернёт
  -- возврат; или поставщик не подтвердил ни одной суммы): движения нет,
  -- обязательство остаётся как есть; переход закупки пишет сервис.
  IF p_amount = 0 THEN
    RETURN NULL;
  END IF;
  v_drift := "sites"."pub_budget_drift"(p_product, p_account);
  IF p_amount > e."amountTotalMinor" - e."paidMinor" - e."cancelledMinor" THEN
    RAISE EXCEPTION 'PUB_AMOUNT_EXCEEDS_OPEN' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "sites"."pub_budget_limits"
     SET "openCommitMinor" = "openCommitMinor" - p_amount,
         "usedPlacementsMinor" = "usedPlacementsMinor" - CASE WHEN e."category" = 'placements' THEN p_amount ELSE 0 END,
         "usedToolsMinor" = "usedToolsMinor" - CASE WHEN e."category" <> 'placements' THEN p_amount ELSE 0 END,
         "revision" = "revision" + 1, "updatedAt" = now()
   WHERE "productId" = p_product AND "accountId" = p_account AND "openCommitMinor" >= p_amount;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH' USING ERRCODE = 'P0001', DETAIL = 'open < cancel';
  END IF;
  UPDATE "sites"."pub_expenses" SET "cancelledMinor" = "cancelledMinor" + p_amount WHERE "id" = p_expense;
  v_id := "sites"."pub_budget_entry"(p_product, p_account, p_expense, 'cancel', p_amount, 'confirmed', NULL,
                                     p_source_doc, p_note, p_occurred_at, p_opkey, p_actor);
  PERFORM "sites"."pub_budget_touch_expense"(p_expense);
  PERFORM "sites"."pub_budget_verify_same"(p_product, p_account, v_drift);
  RETURN v_id;
END;
$$;

-- ══ Возврат: net_paid уменьшается только подтверждённым (AT-CORE-17) ══

-- Применение подтверждённого возврата (голова и счётчики; лимит уже заблокирован).
CREATE FUNCTION "pub_budget_apply_refund"(p_product TEXT, p_account TEXT, e "sites"."pub_expenses", p_amount BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE "sites"."pub_budget_limits"
     SET "netPaidMinor" = "netPaidMinor" - p_amount,
         "usedPlacementsMinor" = "usedPlacementsMinor" - CASE WHEN e."category" = 'placements' THEN p_amount ELSE 0 END,
         "usedToolsMinor" = "usedToolsMinor" - CASE WHEN e."category" <> 'placements' THEN p_amount ELSE 0 END,
         "revision" = "revision" + 1, "updatedAt" = now()
   WHERE "productId" = p_product AND "accountId" = p_account AND "netPaidMinor" >= p_amount;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH' USING ERRCODE = 'P0001', DETAIL = 'netPaid < refund';
  END IF;
  UPDATE "sites"."pub_expenses" SET "refundedMinor" = "refundedMinor" + p_amount WHERE "id" = e."id";
END;
$$;

-- p_status: confirmed — деньги вернулись (двигает net_paid); pending —
-- обещанный возврат (только запись, деньги не двигает, сверку не требует).
CREATE FUNCTION "pub_budget_refund"(p_product TEXT, p_account TEXT, p_expense TEXT, p_amount BIGINT, p_status TEXT,
                                    p_external_ref TEXT, p_source_doc TEXT, p_note TEXT, p_occurred_at TIMESTAMPTZ,
                                    p_opkey TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_drift TEXT;
  e "sites"."pub_expenses";
  v_id TEXT;
BEGIN
  IF p_status NOT IN ('confirmed', 'pending') OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'refund: status confirmed|pending, amount > 0';
  END IF;
  PERFORM "sites"."pub_budget_lock"(p_product, p_account);
  v_drift := "sites"."pub_budget_drift"(p_product, p_account);
  e := "sites"."pub_budget_expense"(p_product, p_account, p_expense);
  IF p_amount > e."paidMinor" - e."refundedMinor" THEN
    RAISE EXCEPTION 'PUB_AMOUNT_EXCEEDS_OPEN' USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'confirmed' THEN
    PERFORM "sites"."pub_budget_apply_refund"(p_product, p_account, e, p_amount);
  END IF;
  v_id := "sites"."pub_budget_entry"(p_product, p_account, p_expense, 'refund', p_amount, p_status, p_external_ref,
                                     p_source_doc, p_note, p_occurred_at, p_opkey, p_actor);
  PERFORM "sites"."pub_budget_touch_expense"(p_expense);
  PERFORM "sites"."pub_budget_verify_same"(p_product, p_account, v_drift);
  RETURN v_id;
END;
$$;

-- ══ Оказано (экономическая стоимость; delivered_unpaid ⊆ open) ═════════

CREATE FUNCTION "pub_budget_deliver"(p_product TEXT, p_account TEXT, p_expense TEXT, p_amount BIGINT,
                                     p_source_doc TEXT, p_note TEXT, p_occurred_at TIMESTAMPTZ, p_opkey TEXT,
                                     p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_drift TEXT;
  e "sites"."pub_expenses";
  v_id TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'deliver: amount > 0';
  END IF;
  PERFORM "sites"."pub_budget_lock"(p_product, p_account);
  v_drift := "sites"."pub_budget_drift"(p_product, p_account);
  e := "sites"."pub_budget_expense"(p_product, p_account, p_expense);
  IF p_amount > e."amountTotalMinor" - e."cancelledMinor" - e."deliveredMinor" THEN
    RAISE EXCEPTION 'PUB_AMOUNT_EXCEEDS_OPEN' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "sites"."pub_expenses" SET "deliveredMinor" = "deliveredMinor" + p_amount WHERE "id" = p_expense;
  v_id := "sites"."pub_budget_entry"(p_product, p_account, p_expense, 'deliver', p_amount, 'confirmed', NULL,
                                     p_source_doc, p_note, p_occurred_at, p_opkey, p_actor);
  PERFORM "sites"."pub_budget_touch_expense"(p_expense);
  PERFORM "sites"."pub_budget_verify_same"(p_product, p_account, v_drift);
  RETURN v_id;
END;
$$;

-- ══ Корректировка обязательства (§6.4, аудит P2-2) ═════════════════════
-- Отрицательная — освобождает часть обязательства (не ниже оплаченного,
-- отменённого и оказанного). Положительная — новое обязательство: тот же
-- условный UPDATE, что у резерва; для закупки — только с НОВЫМ действующим
-- согласованием purchase этой закупки (оно расходуется), иначе
-- PUB_APPROVAL_REQUIRED.

CREATE FUNCTION "pub_budget_adjust"(p_product TEXT, p_account TEXT, p_expense TEXT, p_amount BIGINT, p_note TEXT,
                                    p_approval TEXT, p_snap TEXT, p_source_doc TEXT, p_occurred_at TIMESTAMPTZ,
                                    p_opkey TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e "sites"."pub_expenses";
  a RECORD;
  n INTEGER;
  v_new BIGINT;
  v_id TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 OR char_length(btrim(COALESCE(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'adjust: amount <> 0, note';
  END IF;
  IF p_amount < 0 THEN
    PERFORM "sites"."pub_budget_lock"(p_product, p_account);
    e := "sites"."pub_budget_expense"(p_product, p_account, p_expense);
    -- Оплата pending|unknown удерживает обязательство до сверки
    -- (AT-CORE-15): освобождать его корректировкой нельзя, как и отменой.
    IF "sites"."pub_budget_has_unsettled_pay"(p_expense) THEN
      RAISE EXCEPTION 'PUB_RECONCILE_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    v_new := e."amountTotalMinor" + p_amount;
    IF v_new < e."paidMinor" + e."cancelledMinor" OR v_new < e."deliveredMinor" + e."cancelledMinor" OR v_new <= 0 THEN
      RAISE EXCEPTION 'PUB_AMOUNT_EXCEEDS_OPEN' USING ERRCODE = 'P0001';
    END IF;
    UPDATE "sites"."pub_budget_limits"
       SET "openCommitMinor" = "openCommitMinor" + p_amount,
           "usedPlacementsMinor" = "usedPlacementsMinor" + CASE WHEN e."category" = 'placements' THEN p_amount ELSE 0 END,
           "usedToolsMinor" = "usedToolsMinor" + CASE WHEN e."category" <> 'placements' THEN p_amount ELSE 0 END,
           "revision" = "revision" + 1, "updatedAt" = now()
     WHERE "productId" = p_product AND "accountId" = p_account AND "openCommitMinor" >= -p_amount;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH' USING ERRCODE = 'P0001', DETAIL = 'open < adjust';
    END IF;
  ELSE
    IF "sites"."pub_budget_stopped"(p_product) THEN
      RAISE EXCEPTION 'PUB_BUDGET_STOPPED' USING ERRCODE = 'P0001', DETAIL = 'reconcile';
    END IF;
    -- Категорию и итог читаем без блокировки: строка лимита — первой.
    SELECT * INTO e FROM "sites"."pub_expenses" x
     WHERE x."id" = p_expense AND x."productId" = p_product AND x."accountId" = p_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PUB_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'pub_expenses';
    END IF;
    UPDATE "sites"."pub_budget_limits"
       SET "openCommitMinor" = "openCommitMinor" + p_amount,
           "usedPlacementsMinor" = "usedPlacementsMinor" + CASE WHEN e."category" = 'placements' THEN p_amount ELSE 0 END,
           "usedToolsMinor" = "usedToolsMinor" + CASE WHEN e."category" <> 'placements' THEN p_amount ELSE 0 END,
           "revision" = "revision" + 1, "updatedAt" = now()
     WHERE "productId" = p_product AND "accountId" = p_account
       AND "totalLimitMinor" - "netPaidMinor" - "openCommitMinor" - "protectedReserveMinor" >= p_amount
       AND (e."category" <> 'placements' OR "placementsLimitMinor" - "usedPlacementsMinor" >= p_amount)
       AND (e."category" = 'placements' OR "toolsLimitMinor" - "usedToolsMinor" >= p_amount);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RAISE EXCEPTION 'PUB_BUDGET_INSUFFICIENT' USING ERRCODE = 'P0001';
    END IF;
    e := "sites"."pub_budget_expense"(p_product, p_account, p_expense);
    IF "sites"."pub_budget_has_unsettled_pay"(p_expense) THEN
      RAISE EXCEPTION 'PUB_RECONCILE_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    v_new := e."amountTotalMinor" + p_amount;
    IF e."category" = 'placements' THEN
      IF p_approval IS NULL THEN
        RAISE EXCEPTION 'PUB_APPROVAL_REQUIRED' USING ERRCODE = 'P0001';
      END IF;
      UPDATE "sites"."pub_approvals"
         SET "status" = 'consumed', "updatedAt" = now()
       WHERE "id" = p_approval AND "accountId" = p_account AND "productId" = p_product
         AND "type" = 'purchase' AND "objectType" = 'placement' AND "objectId" = e."placementId"
         AND "status" = 'active' AND "expiresAt" > now() AND "priceSnapshotHash" = p_snap
         AND "maxAmountMinor" >= v_new;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n = 0 THEN
        SELECT x."status", x."expiresAt", x."objectId" INTO a FROM "sites"."pub_approvals" x
         WHERE x."id" = p_approval AND x."accountId" = p_account AND x."productId" = p_product AND x."type" = 'purchase';
        IF NOT FOUND OR a."objectId" <> e."placementId" OR a."status" NOT IN ('active', 'expired') THEN
          RAISE EXCEPTION 'PUB_APPROVAL_REQUIRED' USING ERRCODE = 'P0001';
        ELSIF a."status" = 'expired' OR a."expiresAt" <= now() THEN
          RAISE EXCEPTION 'PUB_APPROVAL_EXPIRED' USING ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION 'PUB_APPROVAL_STALE' USING ERRCODE = 'P0001';
      END IF;
      IF v_new > (SELECT bl."perPurchaseMaxMinor" FROM "sites"."pub_budget_limits" bl
                   WHERE bl."productId" = p_product AND bl."accountId" = p_account) THEN
        RAISE EXCEPTION 'PUB_BUDGET_INSUFFICIENT' USING ERRCODE = 'P0001', DETAIL = 'per_purchase_cap';
      END IF;
      UPDATE "sites"."pub_placements"
         SET "approvalId" = p_approval, "revision" = "revision" + 1, "updatedAt" = now()
       WHERE "id" = e."placementId" AND "accountId" = p_account;
    END IF;
  END IF;
  UPDATE "sites"."pub_expenses" SET "amountTotalMinor" = v_new WHERE "id" = p_expense;
  v_id := "sites"."pub_budget_entry"(p_product, p_account, p_expense, 'adjust', p_amount, 'confirmed', NULL,
                                     p_source_doc, p_note, p_occurred_at, p_opkey, p_actor);
  PERFORM "sites"."pub_budget_touch_expense"(p_expense);
  PERFORM "sites"."pub_budget_verify"(p_product, p_account);
  RETURN v_id;
END;
$$;

-- ══ Перевод защищённого резерва (решение владельца; лимит не растёт) ═══

CREATE FUNCTION "pub_budget_release"(p_product TEXT, p_account TEXT, p_to_cat TEXT, p_amount BIGINT,
                                     p_approval TEXT, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n INTEGER;
  v_id TEXT := "sites"."pub_budget_new_id"('rmv');
BEGIN
  IF p_to_cat NOT IN ('placements', 'tools') OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'PUB_VALIDATION' USING ERRCODE = 'P0001', DETAIL = 'release: placements|tools, amount > 0';
  END IF;
  UPDATE "sites"."pub_budget_limits"
     SET "protectedReserveMinor" = "protectedReserveMinor" - p_amount,
         "placementsLimitMinor" = "placementsLimitMinor" + CASE WHEN p_to_cat = 'placements' THEN p_amount ELSE 0 END,
         "toolsLimitMinor" = "toolsLimitMinor" + CASE WHEN p_to_cat = 'tools' THEN p_amount ELSE 0 END,
         "revision" = "revision" + 1, "updatedAt" = now()
   WHERE "productId" = p_product AND "accountId" = p_account AND "protectedReserveMinor" >= p_amount;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'PUB_BUDGET_INSUFFICIENT' USING ERRCODE = 'P0001', DETAIL = 'protected_reserve';
  END IF;
  INSERT INTO "sites"."pub_reserve_moves" ("id", "accountId", "productId", "toCategory", "amountMinor", "approvalId", "createdBy")
  VALUES (v_id, p_account, p_product, p_to_cat, p_amount, p_approval, p_actor);
  PERFORM "sites"."pub_budget_verify"(p_product, p_account);
  RETURN v_id;
END;
$$;

-- ══ Сборка строки лимита из параметров (BudgetLimitPort.applyParameters) ═
-- Лимиты категорий и резерв = параметры ± Σ переводов резерва: повторное
-- утверждение `budget_*` переводы не затирает (§6.4). Не собирает (NULL,
-- без исключения — решение по параметру должно пройти, контракт P-A1):
-- переводы больше нового резерва; смена валюты при уже записанных
-- обязательствах. Тогда строка остаётся прежней, гейт видит `budget/stale`.

CREATE FUNCTION "pub_budget_apply_limits"(p_product TEXT, p_account TEXT, p_currency TEXT, p_total BIGINT,
                                          p_placements BIGINT, p_tools BIGINT, p_reserve BIGINT,
                                          p_per_purchase BIGINT, p_param_version INTEGER, p_actor TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m_pl BIGINT;
  m_tl BIGINT;
  v_cur TEXT;
  v_id TEXT;
BEGIN
  IF p_total < 0 OR p_placements < 0 OR p_tools < 0 OR p_reserve < 0 OR p_per_purchase < 0
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RETURN NULL;
  END IF;
  SELECT bl."currency", bl."id" INTO v_cur, v_id FROM "sites"."pub_budget_limits" bl
   WHERE bl."productId" = p_product AND bl."accountId" = p_account FOR UPDATE;
  IF FOUND AND v_cur <> p_currency
     AND EXISTS (SELECT 1 FROM "sites"."pub_expenses" e WHERE e."productId" = p_product) THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(m."amountMinor") FILTER (WHERE m."toCategory" = 'placements'), 0),
         COALESCE(sum(m."amountMinor") FILTER (WHERE m."toCategory" = 'tools'), 0)
    INTO m_pl, m_tl FROM "sites"."pub_reserve_moves" m WHERE m."productId" = p_product;
  IF p_reserve - m_pl - m_tl < 0 THEN
    RETURN NULL;
  END IF;
  IF v_id IS NULL THEN
    v_id := "sites"."pub_budget_new_id"('bl');
    INSERT INTO "sites"."pub_budget_limits"
      ("id", "accountId", "productId", "currency", "totalLimitMinor", "placementsLimitMinor", "toolsLimitMinor",
       "protectedReserveMinor", "perPurchaseMaxMinor", "paramVersion", "createdBy", "updatedAt")
    VALUES (v_id, p_account, p_product, p_currency, p_total, p_placements + m_pl, p_tools + m_tl,
            p_reserve - m_pl - m_tl, p_per_purchase, p_param_version, p_actor, now());
  ELSE
    UPDATE "sites"."pub_budget_limits"
       SET "currency" = p_currency, "totalLimitMinor" = p_total,
           "placementsLimitMinor" = p_placements + m_pl, "toolsLimitMinor" = p_tools + m_tl,
           "protectedReserveMinor" = p_reserve - m_pl - m_tl, "perPurchaseMaxMinor" = p_per_purchase,
           "paramVersion" = p_param_version, "revision" = "revision" + 1, "updatedAt" = now()
     WHERE "id" = v_id;
  END IF;
  PERFORM "sites"."pub_budget_verify"(p_product, p_account);
  RETURN v_id;
END;
$$;

-- ══ Пересборка счётчиков из записей (решение владельца, Р-PUB-C-4) ══════
-- Путь починки после записи мимо функций: суммы голов = Σ confirmed их
-- записей, счётчики строки лимита = эталон `pub_budget_expected`; затем
-- строгая сверка. Записи (факты движения денег) не меняются. Возвращает
-- JSON: число исправленных голов и поправки счётчиков (для аудита).
-- Задачу ежедневной сверки (остановку) закрывает владелец отдельно.

CREATE FUNCTION "pub_budget_rebuild_counters"(p_product TEXT, p_account TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  l RECORD;
  x RECORD;
  h RECORD;
  n_heads INTEGER := 0;
BEGIN
  PERFORM "sites"."pub_budget_lock"(p_product, p_account);
  SELECT bl."netPaidMinor", bl."openCommitMinor", bl."usedPlacementsMinor", bl."usedToolsMinor"
    INTO l FROM "sites"."pub_budget_limits" bl
   WHERE bl."productId" = p_product AND bl."accountId" = p_account;
  FOR h IN SELECT * FROM "sites"."pub_budget_heads"(p_product) hh
            WHERE (hh."hTotal", hh."hPaid", hh."hRefunded", hh."hCancelled", hh."hDelivered")
                  IS DISTINCT FROM (hh."total", hh."paid", hh."refunded", hh."cancelled", hh."delivered")
            ORDER BY hh."expenseId"
  LOOP
    PERFORM "sites"."pub_budget_expense"(p_product, p_account, h."expenseId");
    UPDATE "sites"."pub_expenses"
       SET "amountTotalMinor" = h."total", "paidMinor" = h."paid", "refundedMinor" = h."refunded",
           "cancelledMinor" = h."cancelled", "deliveredMinor" = h."delivered"
     WHERE "id" = h."expenseId";
    PERFORM "sites"."pub_budget_touch_expense"(h."expenseId");
    n_heads := n_heads + 1;
  END LOOP;
  SELECT * INTO x FROM "sites"."pub_budget_expected"(p_product);
  UPDATE "sites"."pub_budget_limits"
     SET "netPaidMinor" = x."netPaid", "openCommitMinor" = x."openCommit",
         "usedPlacementsMinor" = x."usedPlacements", "usedToolsMinor" = x."usedTools",
         "aiMonthMinor" = x."aiMonth", "revision" = "revision" + 1, "updatedAt" = now()
   WHERE "productId" = p_product AND "accountId" = p_account;
  PERFORM "sites"."pub_budget_verify"(p_product, p_account);
  RETURN json_build_object('heads', n_heads,
                           'netPaid', x."netPaid" - l."netPaidMinor",
                           'openCommit', x."openCommit" - l."openCommitMinor",
                           'usedPlacements', x."usedPlacements" - l."usedPlacementsMinor",
                           'usedTools', x."usedTools" - l."usedToolsMinor")::text;
END;
$$;

-- Функции этой миграции вызывает только основная роль (владелец схемы):
-- у PUBLIC (и, значит, у publisher_public/assist_public) EXECUTE нет.
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.proname LIKE 'pub\_budget\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END
$$;
