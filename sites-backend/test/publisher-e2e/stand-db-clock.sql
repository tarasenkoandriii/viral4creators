-- AI Publisher — часы СЕРВЕРА БД для стенда сквозных маршрутов
-- (Р-PUB-Z2-21). ТОЛЬКО база стенда: ставит `scripts/publisher-e2e.sh`
-- после миграций; в миграциях и прод-базе этого нет.
--
-- Строки публичного приёма (роль publisher_public) не задают время сами —
-- его ставит DEFAULT now() сервера БД (гранты по колонкам, аудит P1-2), и
-- часы процесса стенда (`core/clock.ts`) до него не достают. Здесь — триггер
-- BEFORE INSERT на таблицах приёма: если транзакция несёт настройку
-- `pub.stand_now` (её ставит `applyStandDbClock` только при часах стенда),
-- колонки времени со значением по умолчанию (`= now()` транзакции) получают
-- этот момент. Явно заданное время (основная роль, восстановление) не
-- трогается. `pub_rate_hits` не входит: окна лимита считаются по now()
-- сервера с обеих сторон.

SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION "sites"."pub_stand_db_clock_cols"(p_table text)
RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(c.column_name::text ORDER BY c.column_name), '{}')
    FROM information_schema.columns c
   WHERE c.table_schema = 'sites' AND c.table_name = p_table
     AND c.data_type = 'timestamp with time zone'
     AND c.column_default ILIKE 'CURRENT_TIMESTAMP%'
$$;

DO $do$
DECLARE
  t text;
  col text;
  body text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pub_leads', 'pub_lead_contacts', 'pub_sessions', 'pub_events', 'pub_lead_outbox'] LOOP
    body := '';
    FOREACH col IN ARRAY "sites"."pub_stand_db_clock_cols"(t) LOOP
      body := body || format(
        '  IF NEW.%1$I = now()::timestamptz(3) THEN NEW.%1$I := s; END IF;' || chr(10), col);
    END LOOP;
    IF body = '' THEN CONTINUE; END IF;
    EXECUTE format($f$
CREATE OR REPLACE FUNCTION "sites".%I() RETURNS trigger LANGUAGE plpgsql AS $b$
DECLARE s timestamptz;
BEGIN
  s := nullif(current_setting('pub.stand_now', true), '')::timestamptz;
  IF s IS NULL THEN RETURN NEW; END IF;
%s  RETURN NEW;
END;
$b$;$f$, t || '_stand_clock', body);
    -- Имя на «a»: BEFORE-триггеры идут по алфавиту — время ставится до
    -- проверок таблицы.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON "sites".%I', 'a_' || t || '_stand_clock', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON "sites".%I FOR EACH ROW EXECUTE FUNCTION "sites".%I()',
                   'a_' || t || '_stand_clock', t, t || '_stand_clock');
  END LOOP;
END
$do$;
