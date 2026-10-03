-- Э7 ИИ-помощника «Админка: чтение» (ТЗ помощника §3.8, §5, §4-бис.8,
-- §4-тер.6, §4.12, §5-тер.13; план, Приложение А «Этап 7» и «Э7 — сделано»).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше комментарии,
-- триггер и права); CI сверяет со schema.prisma (`migrate diff --exit-code`;
-- функции и триггеры движок схем не сравнивает). Предыдущие миграции не
-- трогаем.
--
-- Что здесь:
--  * assist_admin_settings: режим, способ доступа (tma|script|both), хосты
--    самой админки, секрет подписи employee-JWT (шифротекст, §5.6), персона,
--    карта ролей, роль сотрудников TMA, разрез статистики, обход за логином;
--  * assist_admin_connectors / assist_admin_operations — коннекторы OpenAPI и
--    операции с классом read|write|danger (в Э7 исполняется только read);
--  * assist_admin_action_log — журнал вызовов: только дописывается (триггер
--    ниже), цепочка хешей, без FK (переживает удаление коннектора/сайта);
--  * assist_admin_conversations / assist_admin_messages — диалоги сотрудников
--    (отдельно от диалогов посетителей, У-4);
--  * assist_admin_sessions — сессии сотрудника после обмена JWT (хеш токена);
--  * assist_admin_learning_items — очередь обучения «Админки» (контур (г));
--  * assist_admin_crawl_jobs / assist_admin_pages — обход за логином: задание
--    ждёт браузерного воркера Ш3, страницы закрытой зоны — не в site_pages (У-9).
--
-- Роль assist_public: НИ ОДНОГО права на новые таблицы (§4.3-бис слой 3) —
-- явный REVOKE в конце (страховка от будущих DEFAULT PRIVILEGES); тест роли
-- (src/prisma/assist-public-role.spec.ts) берёт список assist_admin_* из схемы.

-- AlterTable
ALTER TABLE "assist_admin_settings" ADD COLUMN     "adminAccess" TEXT NOT NULL DEFAULT 'tma',
ADD COLUMN     "adminHostIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "adminModeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "identityKeyVersion" TEXT,
ADD COLUMN     "identitySecretEnc" TEXT,
ADD COLUMN     "identitySecretSetAt" TIMESTAMP(3),
ADD COLUMN     "identitySecretSetByTelegramId" BIGINT,
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "privateCrawlEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "privateCrawlHostId" TEXT,
ADD COLUMN     "privateCrawlStartPath" TEXT,
ADD COLUMN     "privateCrawlTestAccountId" TEXT,
ADD COLUMN     "roleMap" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "statsPerEmployee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tmaEmployeeRole" TEXT;

-- CreateTable
CREATE TABLE "assist_admin_connectors" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "allowedHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hostId" TEXT,
    "saasAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "specUrl" TEXT,
    "specHash" TEXT NOT NULL,
    "specTitle" TEXT,
    "specVersion" TEXT,
    "authKind" TEXT NOT NULL DEFAULT 'none',
    "authHeaderName" TEXT,
    "secretEnc" TEXT,
    "secretKeyVersion" TEXT,
    "secretLast4" TEXT,
    "secretSetAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastCallAt" TIMESTAMP(3),
    "createdByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_operations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "summary" TEXT,
    "autoKind" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "kindReason" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dailyLimit" INTEGER,
    "params" JSONB NOT NULL DEFAULT '[]',
    "unsupported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_action_log" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "actorRole" TEXT,
    "channel" TEXT NOT NULL,
    "conversationId" TEXT,
    "connectorId" TEXT,
    "operationRowId" TEXT,
    "operation" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'read',
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "requestMasked" JSONB NOT NULL,
    "responseBytes" INTEGER,
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "assist_admin_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_conversations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "employeeRef" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "employeeRole" TEXT,
    "employeeName" TEXT,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_messages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sources" JSONB,
    "tools" JSONB,
    "flags" TEXT[],
    "clientRequestId" TEXT,
    "answerPath" TEXT,
    "rating" INTEGER,
    "model" TEXT,
    "inTokens" INTEGER NOT NULL DEFAULT 0,
    "outTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "role" TEXT,
    "name" TEXT,
    "jwtIat" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_learning_items" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "employeeRef" TEXT,
    "questionMasked" TEXT NOT NULL,
    "answerMasked" TEXT,
    "proposedAnswer" TEXT,
    "clusterKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "faqId" TEXT,
    "resolvedByTelegramId" BIGINT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_learning_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_crawl_jobs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "testAccountId" TEXT NOT NULL,
    "startPath" TEXT NOT NULL DEFAULT '/',
    "status" TEXT NOT NULL DEFAULT 'waiting_worker',
    "requestedByTelegramId" BIGINT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_crawl_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_pages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "crawlJobId" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_admin_connectors_siteId_idx" ON "assist_admin_connectors"("siteId");

-- CreateIndex
CREATE INDEX "assist_admin_connectors_accountId_idx" ON "assist_admin_connectors"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_connectors_id_accountId_key" ON "assist_admin_connectors"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_operations_siteId_idx" ON "assist_admin_operations"("siteId");

-- CreateIndex
CREATE INDEX "assist_admin_operations_accountId_idx" ON "assist_admin_operations"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_operations_connectorId_operationId_key" ON "assist_admin_operations"("connectorId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_action_log_idempotencyKey_key" ON "assist_admin_action_log"("idempotencyKey");

-- CreateIndex
CREATE INDEX "assist_admin_action_log_siteId_at_idx" ON "assist_admin_action_log"("siteId", "at");

-- CreateIndex
CREATE INDEX "assist_admin_action_log_accountId_idx" ON "assist_admin_action_log"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_conversations_siteId_employeeRef_lastActivityA_idx" ON "assist_admin_conversations"("siteId", "employeeRef", "lastActivityAt");

-- CreateIndex
CREATE INDEX "assist_admin_conversations_accountId_idx" ON "assist_admin_conversations"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_conversations_id_accountId_key" ON "assist_admin_conversations"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_messages_conversationId_createdAt_idx" ON "assist_admin_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_messages_siteId_createdAt_idx" ON "assist_admin_messages"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_messages_accountId_idx" ON "assist_admin_messages"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_messages_conversationId_clientRequestId_key" ON "assist_admin_messages"("conversationId", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_sessions_tokenHash_key" ON "assist_admin_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "assist_admin_sessions_siteId_sub_idx" ON "assist_admin_sessions"("siteId", "sub");

-- CreateIndex
CREATE INDEX "assist_admin_sessions_expiresAt_idx" ON "assist_admin_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "assist_admin_sessions_accountId_idx" ON "assist_admin_sessions"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_learning_items_siteId_status_idx" ON "assist_admin_learning_items"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_admin_learning_items_siteId_clusterKey_idx" ON "assist_admin_learning_items"("siteId", "clusterKey");

-- CreateIndex
CREATE INDEX "assist_admin_learning_items_accountId_idx" ON "assist_admin_learning_items"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_learning_items_messageId_kind_key" ON "assist_admin_learning_items"("messageId", "kind");

-- CreateIndex
CREATE INDEX "assist_admin_crawl_jobs_siteId_status_idx" ON "assist_admin_crawl_jobs"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_admin_crawl_jobs_accountId_idx" ON "assist_admin_crawl_jobs"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_pages_accountId_idx" ON "assist_admin_pages"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_pages_siteId_url_key" ON "assist_admin_pages"("siteId", "url");

-- AddForeignKey
ALTER TABLE "assist_admin_connectors" ADD CONSTRAINT "assist_admin_connectors_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_operations" ADD CONSTRAINT "assist_admin_operations_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_operations" ADD CONSTRAINT "assist_admin_operations_connectorId_accountId_fkey" FOREIGN KEY ("connectorId", "accountId") REFERENCES "assist_admin_connectors"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_conversations" ADD CONSTRAINT "assist_admin_conversations_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_messages" ADD CONSTRAINT "assist_admin_messages_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_messages" ADD CONSTRAINT "assist_admin_messages_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_admin_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_sessions" ADD CONSTRAINT "assist_admin_sessions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_learning_items" ADD CONSTRAINT "assist_admin_learning_items_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_learning_items" ADD CONSTRAINT "assist_admin_learning_items_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_admin_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_crawl_jobs" ADD CONSTRAINT "assist_admin_crawl_jobs_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_pages" ADD CONSTRAINT "assist_admin_pages_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Журнал вызовов только дописывается: UPDATE запрещён всегда, DELETE — кроме
-- чистки по сроку (1 год, В-5) в транзакции с
-- `set_config('sites.admin_action_log_purge', 'on', true)`.
CREATE OR REPLACE FUNCTION "assist_admin_action_log_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE')
     AND coalesce(current_setting('sites.admin_action_log_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'assist_admin_action_log: журнал только дописывается (%)', TG_OP
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "assist_admin_action_log_append_only"
  BEFORE UPDATE OR DELETE ON "assist_admin_action_log"
  FOR EACH ROW EXECUTE FUNCTION "assist_admin_action_log_append_only"();

-- Аудит Э7: строчный триггер TRUNCATE не видит — без этого одна команда
-- стирала бы журнал целиком мимо цепочки хешей. Тот же флаг чистки, что у
-- DELETE (осознанная ручная операция владельца схемы — в транзакции с ним).
CREATE TRIGGER "assist_admin_action_log_no_truncate"
  BEFORE TRUNCATE ON "assist_admin_action_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "assist_admin_action_log_append_only"();

-- Аудит Э7: инварианты классов операций — и в базе, не только в сервисе
-- (триггер, а не CHECK: движок схем Prisma CHECK не моделирует, триггеры
-- в сверке схемы не участвуют):
--  * класс — read|write|danger и не ниже автоклассификации (§5.2: поднять
--    можно, опустить нельзя — любым путём, включая прямой UPDATE);
--  * в Э7 включённой может быть только read (Э8 с подтверждением «Да»
--    снимает это ограничение своей миграцией).
CREATE OR REPLACE FUNCTION "assist_admin_operations_kind_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ranks CONSTANT TEXT[] := ARRAY['read', 'write', 'danger'];
BEGIN
  IF array_position(ranks, NEW."kind") IS NULL
     OR array_position(ranks, NEW."autoKind") IS NULL THEN
    RAISE EXCEPTION 'assist_admin_operations: неизвестный класс операции'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."autoKind" IS DISTINCT FROM OLD."autoKind" THEN
    RAISE EXCEPTION 'assist_admin_operations: автоклассификация не меняется'
      USING ERRCODE = '23514';
  END IF;
  IF array_position(ranks, NEW."kind") < array_position(ranks, NEW."autoKind") THEN
    RAISE EXCEPTION 'assist_admin_operations: класс нельзя опустить ниже автоклассификации'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."enabled" AND NEW."kind" <> 'read' THEN
    RAISE EXCEPTION 'assist_admin_operations: в Э7 включается только read'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assist_admin_operations_kind_guard"
  BEFORE INSERT OR UPDATE ON "assist_admin_operations"
  FOR EACH ROW EXECUTE FUNCTION "assist_admin_operations_kind_guard"();

-- Роль виджета к «Админке» дороги не имеет (§4.3-бис слой 3, К-9).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
    REVOKE ALL ON "assist_admin_connectors", "assist_admin_operations",
      "assist_admin_action_log", "assist_admin_conversations",
      "assist_admin_messages", "assist_admin_sessions",
      "assist_admin_learning_items", "assist_admin_crawl_jobs",
      "assist_admin_pages", "assist_admin_settings"
      FROM assist_public;
  END IF;
END
$$;
