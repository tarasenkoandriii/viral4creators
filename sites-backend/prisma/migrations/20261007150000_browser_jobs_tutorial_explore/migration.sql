-- Э-С, Ш3-хвост (3): раунд исследователя обучалки на браузерном воркере
-- (вид `tutorial-explore`) и задания БЕЗ хоста кабинета для режима B
-- (решение владельца «B ничего не блокирует»: источник
-- `tutorial-explore-open`, замок — точные хосты черновика, лимиты — на
-- человека и на хост).
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
--  * `siteId`/`hostId` — NULL допустим ТОЛЬКО у `tutorial-explore-open`
--    (триггер); у него `accountId` — ключ человека генератора `gen-<subject>`
--    (составные FK при NULL не проверяются — кабинета нет);
--  * индекс (refId, origin, createdAt) — лимит заданий без кабинета на хост
--    (`refId` = регистрируемый домен первого хоста замка);
--  * триггер: новые вид и источники (источник раунда — только с видом
--    раунда); секреты раунда — только конвертами `v1.…` под ключ воркера:
--    сессия (строка или null), значения ввода `fills[].value` и шагов
--    переигровки `replay[].value` (открытого текста кук и паролей в очереди
--    нет; ключи `cookies|password|…` по-прежнему запрещены).

-- AlterTable
ALTER TABLE "site_browser_jobs" ALTER COLUMN "siteId" DROP NOT NULL,
ALTER COLUMN "hostId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "site_browser_jobs_refId_origin_createdAt_idx" ON "site_browser_jobs"("refId", "origin", "createdAt");

CREATE OR REPLACE FUNCTION "site_browser_jobs_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sealed_re CONSTANT text := '^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$';
BEGIN
  IF NEW."kind" NOT IN ('ui-snapshot', 'admin-crawl', 'descriptor-resolve', 'frames-capture', 'tutorial-explore') THEN
    RAISE EXCEPTION 'site_browser_jobs: неизвестный вид задания %', NEW."kind" USING ERRCODE = '23514';
  END IF;
  IF NEW."origin" NOT IN ('voice-map-snapshot', 'voice-map-check', 'assist-admin-crawl', 'tutorial-frames', 'tutorial-explore', 'tutorial-explore-open') THEN
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
