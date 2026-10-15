-- AI Publisher, P-R-ADM — аудит Reddit-подсистемы 15.10.2026, находка adm-2
-- (doc/ai-publisher/reddit-manual-mvp-adapted.md §13, «Аудит 15.10.2026»).
--
-- Журнал доступа Админки pub_reddit_admin_access_log: проверка столбца
-- route отвергала часть настоящих шаблонов маршрутов — `cx/ai/calls/:callId`
-- (заглавная I) — и прежнее значение для неизвестного пути `?` (первый знак не
-- буква/цифра); строки молча терялись (23514 ловился предупреждением).
-- Теперь: шаблон — латиница в любом регистре, цифры и `/:._*?-`, первый знак —
-- буква или цифра; неизвестный путь код пишет как `unknown` (`rx/unknown`,
-- `cx/unknown`). Остальные проверки строки — без изменений.
--
-- Forward-only (как Р-RD-12): функция пересоздаётся из её последней версии
-- (20261023090000_publisher_admin_actor) с одной правкой — регулярным
-- выражением route. Таблица и триггеры не меняются.

CREATE OR REPLACE FUNCTION "pub_reddit_admin_access_log_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM "sites"."pub_chk"(char_length(NEW."id") BETWEEN 1 AND 64, 'pub_reddit_admin_access_log.id: длина 1..64');
  PERFORM "sites"."pub_chk"("sites"."pub_is_admin"(NEW."actor"), 'pub_reddit_admin_access_log.actor: только admin:<userId>');
  PERFORM "sites"."pub_chk"(NEW."method" = ANY (ARRAY['GET', 'POST', 'PATCH']), 'pub_reddit_admin_access_log.method: вне списка');
  PERFORM "sites"."pub_chk"(char_length(NEW."route") BETWEEN 1 AND 200 AND NEW."route" ~ '^[A-Za-z0-9][A-Za-z0-9/:._*?-]*$',
    'pub_reddit_admin_access_log.route: шаблон маршрута без значений (≤ 200)');
  PERFORM "sites"."pub_chk"(NEW."status" BETWEEN 100 AND 599, 'pub_reddit_admin_access_log.status: 100..599');
  RETURN NEW;
END;
$$;

-- Пересозданная функция: EXECUTE у PUBLIC снимаем (её вызывает только триггер).
REVOKE ALL ON FUNCTION "pub_reddit_admin_access_log_guard"() FROM PUBLIC;
