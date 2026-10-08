-- Заход 10, пакет Д (схема S2): новые виды и источники заданий браузерного
-- воркера.
--
--  * вид и источник `knowledge-render` (Ш3 (20), Р-З10-20): страницы, которые
--    обход нашёл пустой оболочкой SPA, рендерит воркер — публичная страница
--    в чистом контексте (без cookie, кликов и форм), замок — один хост, без
--    учётки; источник и вид — только парой;
--  * источник `voice-autotest` (№29, Р-З10-19): Т-3 по расписанию монитора
--    Т-4 — вид `descriptor-resolve` (та же сверка дескрипторов, без кликов),
--    без учётки.
--
-- Таблица не меняется: правила значений — функцией триггера (CHECK ломает
-- сверку `migrate diff`, см. …_browser_worker_jobs). Пишется РУКАМИ, тело —
-- прежняя функция `…_browser_jobs_tutorial_explore` плюс ветки выше.
-- Предыдущие миграции не трогаем.

CREATE OR REPLACE FUNCTION "site_browser_jobs_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sealed_re CONSTANT text := '^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$';
BEGIN
  IF NEW."kind" NOT IN ('ui-snapshot', 'admin-crawl', 'descriptor-resolve', 'frames-capture', 'tutorial-explore', 'knowledge-render') THEN
    RAISE EXCEPTION 'site_browser_jobs: неизвестный вид задания %', NEW."kind" USING ERRCODE = '23514';
  END IF;
  IF NEW."origin" NOT IN ('voice-map-snapshot', 'voice-map-check', 'assist-admin-crawl', 'tutorial-frames', 'tutorial-explore', 'tutorial-explore-open', 'knowledge-render', 'voice-autotest') THEN
    RAISE EXCEPTION 'site_browser_jobs: неизвестный источник %', NEW."origin" USING ERRCODE = '23514';
  END IF;
  IF NEW."status" NOT IN ('queued', 'running', 'done', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'site_browser_jobs: неизвестный статус %', NEW."status" USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW."params") <> 'object'
     OR NEW."params" ?| ARRAY['password', 'secret', 'secrets', 'cookies', 'token', 'username', 'credentials'] THEN
    RAISE EXCEPTION 'site_browser_jobs: секреты в параметрах задания запрещены' USING ERRCODE = '23514';
  END IF;
  -- Без кабинета — только раунд режима B, и он — только без кабинета.
  IF NEW."origin" = 'tutorial-explore-open' THEN
    IF NEW."siteId" IS NOT NULL OR NEW."hostId" IS NOT NULL OR NEW."accountId" NOT LIKE 'gen-%' THEN
      RAISE EXCEPTION 'site_browser_jobs: задание без кабинета — без сайта и хоста, ключ gen-' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."siteId" IS NULL OR NEW."hostId" IS NULL OR NEW."accountId" LIKE 'gen-%' THEN
    RAISE EXCEPTION 'site_browser_jobs: задание кабинета — с сайтом и хостом' USING ERRCODE = '23514';
  END IF;
  -- Источники раунда обучалки — только с видом раунда, и наоборот.
  IF (NEW."origin" IN ('tutorial-explore', 'tutorial-explore-open')) <> (NEW."kind" = 'tutorial-explore') THEN
    RAISE EXCEPTION 'site_browser_jobs: источник % не для вида %', NEW."origin", NEW."kind" USING ERRCODE = '23514';
  END IF;
  -- Ш3 (20): рендер SPA для знаний — только свой источник, и наоборот;
  -- замок — один хост; учётки нет (публичные страницы, чистый контекст).
  IF (NEW."origin" = 'knowledge-render') <> (NEW."kind" = 'knowledge-render') THEN
    RAISE EXCEPTION 'site_browser_jobs: источник % не для вида %', NEW."origin", NEW."kind" USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" = 'knowledge-render' AND (
       NEW."testAccountId" IS NOT NULL
       OR jsonb_typeof(NEW."params"->'allowedHosts') IS DISTINCT FROM 'array'
       OR jsonb_array_length(NEW."params"->'allowedHosts') <> 1) THEN
    RAISE EXCEPTION 'site_browser_jobs: рендер — публичные страницы одного хоста, без учётки' USING ERRCODE = '23514';
  END IF;
  -- №29: Т-3 по расписанию — только сверка дескрипторов, без учётки.
  IF NEW."origin" = 'voice-autotest' AND (NEW."kind" <> 'descriptor-resolve' OR NEW."testAccountId" IS NOT NULL) THEN
    RAISE EXCEPTION 'site_browser_jobs: источник % не для вида %', NEW."origin", NEW."kind" USING ERRCODE = '23514';
  END IF;
  -- Секреты раунда обучалки — только конвертами под ключ воркера: сессия
  -- (строка `v1.…` или null — объект/массив нет), значения ввода и шагов
  -- переигровки (аудит захода 7).
  IF NEW."kind" = 'tutorial-explore' THEN
    IF COALESCE(jsonb_typeof(NEW."params"->'session'), 'null') NOT IN ('string', 'null')
       OR (jsonb_typeof(NEW."params"->'session') = 'string'
           AND (NEW."params"->>'session') !~ sealed_re) THEN
      RAISE EXCEPTION 'site_browser_jobs: сессия раунда — только конвертом воркера' USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(NEW."params"->'fills') IS DISTINCT FROM 'array'
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(NEW."params"->'fills') AS f(v)
          WHERE jsonb_typeof(f.v) IS DISTINCT FROM 'object'
             OR jsonb_typeof(f.v->'value') IS DISTINCT FROM 'string'
             OR (f.v->>'value') !~ sealed_re) THEN
      RAISE EXCEPTION 'site_browser_jobs: значения ввода — только конвертами воркера' USING ERRCODE = '23514';
    END IF;
    IF COALESCE(jsonb_typeof(NEW."params"->'replay'), 'null') NOT IN ('array', 'null')
       OR (jsonb_typeof(NEW."params"->'replay') = 'array' AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(NEW."params"->'replay') AS r(v)
          WHERE jsonb_typeof(r.v) IS DISTINCT FROM 'object'
             OR (r.v->>'kind' = 'fill'
                 AND (jsonb_typeof(r.v->'value') IS DISTINCT FROM 'string'
                      OR (r.v->>'value') !~ sealed_re))
             OR (r.v ?| ARRAY['password', 'secret', 'secrets', 'cookies', 'token', 'username', 'credentials']))) THEN
      RAISE EXCEPTION 'site_browser_jobs: значения переигровки — только конвертами воркера' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
