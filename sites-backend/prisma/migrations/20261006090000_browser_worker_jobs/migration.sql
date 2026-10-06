-- Э-С, шаг Ш3 (docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md §3.2
-- вариант C, «Браузерный воркер»; QA-ТЗ §4.2–§4.3): очередь заданий
-- изолированного браузерного воркера и артефакты (кадры/скриншоты).
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
--  * site_browser_jobs — задание: вид, источник, параметры БЕЗ секретов,
--    аренда воркера (lease + heartbeat, хеш токена), попытки, результат или
--    код ошибки из закрытого списка, срок хранения строки;
--  * site_browser_artifacts — скриншоты и кадры: приватный Blob со сроком
--    жизни, наружу — подписанной ссылкой с коротким TTL.
--
-- Проверки значений — триггером, а не CHECK (CHECK ломает сверку
-- migrate diff в песочнице): вид, источник, статус из закрытых списков и
-- запрет «секретных» ключей в параметрах (password, secret, cookies…) —
-- учётка Ш2 приходит воркеру только отдельным запросом `credentials`.
--
-- Роли assist_public прав НЕ выдаётся (REVOKE ниже — страховка от будущих
-- DEFAULT PRIVILEGES; спек роли проверяет отказ по всей схеме).

-- CreateTable
CREATE TABLE "site_browser_jobs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "refId" TEXT,
    "params" JSONB NOT NULL,
    "testAccountId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseTokenHash" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "credentialsAttempt" INTEGER,
    "cancelRequestedAt" TIMESTAMP(3),
    "result" JSONB,
    "resultBytes" INTEGER,
    "errorCode" TEXT,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_browser_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_browser_artifacts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "pathname" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_browser_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_browser_jobs_idempotencyKey_key" ON "site_browser_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "site_browser_jobs_status_availableAt_idx" ON "site_browser_jobs"("status", "availableAt");

-- CreateIndex
CREATE INDEX "site_browser_jobs_accountId_idx" ON "site_browser_jobs"("accountId");

-- CreateIndex
CREATE INDEX "site_browser_jobs_siteId_origin_createdAt_idx" ON "site_browser_jobs"("siteId", "origin", "createdAt");

-- CreateIndex
CREATE INDEX "site_browser_jobs_expiresAt_idx" ON "site_browser_jobs"("expiresAt");

-- CreateIndex
CREATE INDEX "site_browser_artifacts_accountId_idx" ON "site_browser_artifacts"("accountId");

-- CreateIndex
CREATE INDEX "site_browser_artifacts_expiresAt_idx" ON "site_browser_artifacts"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_browser_artifacts_jobId_idx_key" ON "site_browser_artifacts"("jobId", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "site_browser_jobs_id_accountId_key" ON "site_browser_jobs"("id", "accountId");

-- AddForeignKey
ALTER TABLE "site_browser_jobs" ADD CONSTRAINT "site_browser_jobs_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (аудит Ш3: хост и артефакт — того же кабинета, что задание;
-- составные FK, как у site_pages, а не голый id)
ALTER TABLE "site_browser_jobs" ADD CONSTRAINT "site_browser_jobs_hostId_accountId_fkey" FOREIGN KEY ("hostId", "accountId") REFERENCES "site_hosts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_browser_artifacts" ADD CONSTRAINT "site_browser_artifacts_jobId_accountId_fkey" FOREIGN KEY ("jobId", "accountId") REFERENCES "site_browser_jobs"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Закрытые списки и «параметры без секретов» — триггером (см. шапку).
CREATE OR REPLACE FUNCTION "site_browser_jobs_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" NOT IN ('ui-snapshot', 'admin-crawl', 'descriptor-resolve', 'frames-capture') THEN
    RAISE EXCEPTION 'site_browser_jobs: неизвестный вид задания %', NEW."kind" USING ERRCODE = '23514';
  END IF;
  IF NEW."origin" NOT IN ('voice-map-snapshot', 'voice-map-check', 'assist-admin-crawl', 'tutorial-frames') THEN
    RAISE EXCEPTION 'site_browser_jobs: неизвестный источник %', NEW."origin" USING ERRCODE = '23514';
  END IF;
  IF NEW."status" NOT IN ('queued', 'running', 'done', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'site_browser_jobs: неизвестный статус %', NEW."status" USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW."params") <> 'object'
     OR NEW."params" ?| ARRAY['password', 'secret', 'secrets', 'cookies', 'token', 'username', 'credentials'] THEN
    RAISE EXCEPTION 'site_browser_jobs: секреты в параметрах задания запрещены' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "site_browser_jobs_guard"
  BEFORE INSERT OR UPDATE ON "site_browser_jobs"
  FOR EACH ROW EXECUTE FUNCTION "site_browser_jobs_guard"();

-- Роль виджета к очереди воркера дороги не имеет (§4.3-бис слой 3).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
    REVOKE ALL ON "site_browser_jobs", "site_browser_artifacts" FROM assist_public;
  END IF;
END
$$;
