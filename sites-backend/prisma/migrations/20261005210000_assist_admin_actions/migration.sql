-- Э8 ИИ-помощника «Админка: действия» (ТЗ помощника §5.2–5.7, §4-бис.5,
-- §5-бис.15 п.14, §5-бис.17 п.10; план, Приложение А «Этап 8» и
-- «Э8 — сделано»).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma, дальше комментарии,
-- триггеры и права); CI сверяет со schema.prisma (`migrate diff
-- --exit-code`; функции и триггеры движок схем не сравнивает). Выкатанные
-- миграции (в т.ч. Э7 …_assist_admin_read) не трогаем — правило Э7 «включается
-- только read» снимается здесь заменой тела функции триггера.
--
-- Что здесь:
--  * assist_admin_settings: количественный потолок действий сайта за сутки,
--    уведомления о danger, счётчик номеров мемо АМ-N;
--  * assist_admin_connectors: секрет подписи изменяющих запросов
--    (`X-V4C-Signature`, шифротекст);
--  * assist_admin_operations: идемпотентность (`x-assist-idempotent`),
--    компенсация (`x-assist-compensation`), предпросмотр (`x-assist-preview`),
--    сухой прогон native, денежный потолок (параметр суммы, максимум за
--    действие и за сутки), слово подтверждения danger;
--  * assist_admin_messages.proposalId — карточка при ответе;
--  * assist_admin_action_proposals — предложения write/danger и «Да»
--    (неизменяемые поля и переходы статусов — триггер ниже);
--  * assist_admin_memos / …_memo_versions / assist_admin_phrases /
--    assist_admin_memo_runs — мемо «Админки» АМ-N (журнал изменений —
--    записи `memo` в append-only assist_admin_action_log).
--
-- Роль assist_public: НИ ОДНОГО права на новые таблицы (§4.3-бис слой 3) —
-- явный REVOKE в конце; тест роли берёт список assist_admin_* из схемы.

-- AlterTable
ALTER TABLE "assist_admin_connectors" ADD COLUMN     "signKeyVersion" TEXT,
ADD COLUMN     "signSecretEnc" TEXT,
ADD COLUMN     "signSetAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "assist_admin_messages" ADD COLUMN     "proposalId" TEXT;

-- AlterTable
ALTER TABLE "assist_admin_operations" ADD COLUMN     "amountParam" TEXT,
ADD COLUMN     "autoAmountParam" TEXT,
ADD COLUMN     "compensation" JSONB,
ADD COLUMN     "confirmWord" TEXT,
ADD COLUMN     "dailyAmountCap" DOUBLE PRECISION,
ADD COLUMN     "dryRunParam" TEXT,
ADD COLUMN     "idempotent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxAmount" DOUBLE PRECISION,
ADD COLUMN     "preview" JSONB;

-- AlterTable
ALTER TABLE "assist_admin_settings" ADD COLUMN     "actionsDailyCap" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "memoCounter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notifyDanger" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "assist_admin_action_proposals" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT,
    "channel" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorExternal" TEXT NOT NULL,
    "actorRole" TEXT,
    "assistRole" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "operationRowId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB,
    "paramsHash" TEXT NOT NULL,
    "fields" JSONB,
    "preview" JSONB,
    "dryRun" TEXT NOT NULL DEFAULT 'none',
    "dryRunStatus" TEXT,
    "dryRunNote" TEXT,
    "unrequested" BOOLEAN NOT NULL DEFAULT false,
    "confirmPhrase" TEXT,
    "amount" DOUBLE PRECISION,
    "compensationOf" TEXT,
    "memoRunId" TEXT,
    "memoStep" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT,
    "httpStatus" INTEGER,
    "errorText" TEXT,
    "chainStatus" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_memos" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedVersion" INTEGER,
    "draftRevision" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "reviewReason" JSONB,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_memos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_memo_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "memoId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "gateReport" JSONB,
    "checkReport" JSONB,
    "rollbackOf" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "assist_admin_memo_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_phrases" (
    "siteId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "norm" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_phrases_pkey" PRIMARY KEY ("siteId","lang","norm")
);

-- CreateTable
CREATE TABLE "assist_admin_memo_runs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "memoId" TEXT NOT NULL,
    "memoNumber" INTEGER NOT NULL,
    "memoVersion" INTEGER NOT NULL,
    "conversationId" TEXT,
    "actor" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "step" INTEGER NOT NULL DEFAULT 0,
    "slots" JSONB,
    "progress" JSONB NOT NULL DEFAULT '[]',
    "goalStatus" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_memo_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_admin_action_proposals_siteId_actor_createdAt_idx" ON "assist_admin_action_proposals"("siteId", "actor", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_action_proposals_siteId_status_idx" ON "assist_admin_action_proposals"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_admin_action_proposals_accountId_idx" ON "assist_admin_action_proposals"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_action_proposals_memoRunId_memoStep_key" ON "assist_admin_action_proposals"("memoRunId", "memoStep");

-- CreateIndex
CREATE INDEX "assist_admin_memos_accountId_idx" ON "assist_admin_memos"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_memos_siteId_number_key" ON "assist_admin_memos"("siteId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_memos_siteId_key_key" ON "assist_admin_memos"("siteId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_memos_id_accountId_key" ON "assist_admin_memos"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_memo_versions_siteId_idx" ON "assist_admin_memo_versions"("siteId");

-- CreateIndex
CREATE INDEX "assist_admin_memo_versions_accountId_idx" ON "assist_admin_memo_versions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_memo_versions_memoId_number_key" ON "assist_admin_memo_versions"("memoId", "number");

-- CreateIndex
CREATE INDEX "assist_admin_phrases_accountId_idx" ON "assist_admin_phrases"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_phrases_siteId_owner_idx" ON "assist_admin_phrases"("siteId", "owner");

-- CreateIndex
CREATE INDEX "assist_admin_memo_runs_siteId_actor_idx" ON "assist_admin_memo_runs"("siteId", "actor");

-- CreateIndex
CREATE INDEX "assist_admin_memo_runs_accountId_idx" ON "assist_admin_memo_runs"("accountId");

-- AddForeignKey
ALTER TABLE "assist_admin_action_proposals" ADD CONSTRAINT "assist_admin_action_proposals_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_action_proposals" ADD CONSTRAINT "assist_admin_action_proposals_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_admin_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_memos" ADD CONSTRAINT "assist_admin_memos_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_memo_versions" ADD CONSTRAINT "assist_admin_memo_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_memo_versions" ADD CONSTRAINT "assist_admin_memo_versions_memoId_accountId_fkey" FOREIGN KEY ("memoId", "accountId") REFERENCES "assist_admin_memos"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_phrases" ADD CONSTRAINT "assist_admin_phrases_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_memo_runs" ADD CONSTRAINT "assist_admin_memo_runs_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Э8: write/danger включаются (с подтверждением «Да» — сервис), инвариант
-- классов остаётся в базе: класс — read|write|danger, автоклассификация не
-- меняется, класс не ниже автоклассификации (аудит Э7, п.9). Правило Э7
-- «включённой может быть только read» снято (план, «Э7 — сделано» → аудит).
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
  -- Найденный при импорте параметр суммы не снимается (денежный потолок).
  IF NEW."autoAmountParam" IS NOT NULL AND NEW."amountParam" IS NULL THEN
    RAISE EXCEPTION 'assist_admin_operations: параметр суммы снять нельзя'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Предложение действия (§5.4 п.6, §4-бис.5): то, что сотрудник подтвердил,
-- не меняется — ни прямым UPDATE в обход сервиса. Неизменны: кто, какая
-- операция, класс, хеш параметров, слово подтверждения, сумма, срок,
-- компенсация/шаг мемо. Параметры, строки карточки и снимок «было» можно
-- только стереть (ретенция), но не подменить. Статусы — только вперёд:
--   pending → executing | rejected | expired
--   executing → done | failed | unknown
--   unknown → executing (новое «Да» с тем же Idempotency-Key) | expired
-- done/failed/rejected/expired — конечные (витрина chainStatus у done — можно).
CREATE OR REPLACE FUNCTION "assist_admin_action_proposals_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."actor" IS DISTINCT FROM OLD."actor"
     OR NEW."siteId" IS DISTINCT FROM OLD."siteId"
     OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
     OR NEW."operationRowId" IS DISTINCT FROM OLD."operationRowId"
     OR NEW."operation" IS DISTINCT FROM OLD."operation"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."paramsHash" IS DISTINCT FROM OLD."paramsHash"
     OR NEW."confirmPhrase" IS DISTINCT FROM OLD."confirmPhrase"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."compensationOf" IS DISTINCT FROM OLD."compensationOf"
     OR NEW."memoRunId" IS DISTINCT FROM OLD."memoRunId"
     OR NEW."memoStep" IS DISTINCT FROM OLD."memoStep"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'assist_admin_action_proposals: подтверждаемые поля неизменны'
      USING ERRCODE = '42501';
  END IF;
  IF (NEW."params" IS NOT NULL AND NEW."params" IS DISTINCT FROM OLD."params")
     OR (NEW."fields" IS NOT NULL AND NEW."fields" IS DISTINCT FROM OLD."fields")
     OR (NEW."preview" IS NOT NULL AND NEW."preview" IS DISTINCT FROM OLD."preview") THEN
    RAISE EXCEPTION 'assist_admin_action_proposals: параметры можно только стереть'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'pending' AND NEW."status" IN ('executing', 'rejected', 'expired'))
    OR (OLD."status" = 'executing' AND NEW."status" IN ('done', 'failed', 'unknown'))
    OR (OLD."status" = 'unknown' AND NEW."status" IN ('executing', 'expired'))
  ) THEN
    RAISE EXCEPTION 'assist_admin_action_proposals: переход % → % запрещён',
      OLD."status", NEW."status"
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assist_admin_action_proposals_guard"
  BEFORE UPDATE ON "assist_admin_action_proposals"
  FOR EACH ROW EXECUTE FUNCTION "assist_admin_action_proposals_guard"();

-- Роль виджета к «Админке» дороги не имеет (§4.3-бис слой 3, К-9).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
    REVOKE ALL ON "assist_admin_action_proposals", "assist_admin_memos",
      "assist_admin_memo_versions", "assist_admin_phrases",
      "assist_admin_memo_runs"
      FROM assist_public;
  END IF;
END
$$;
