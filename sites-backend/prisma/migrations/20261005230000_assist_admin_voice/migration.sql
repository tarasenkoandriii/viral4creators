-- Э6-бис (б) ИИ-помощника: голосовое управление — режим «Админка» (ТЗ
-- помощника §5-бис.2, §5-бис.3–9, §5-бис.13–15, §5-бис.17 п.10; план,
-- Приложение А «Э6-бис» (б) и «Э6-бис (б) — сделано»).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma, дальше комментарии,
-- триггеры и права); CI сверяет со schema.prisma (`migrate diff
-- --exit-code`; функции и триггеры движок схем не сравнивает). CHECK не
-- берём (движок схем Prisma их не моделирует) — инварианты держат триггеры.
-- Выкатанные миграции (Э7 …_assist_admin_read, Э8 …_assist_admin_actions)
-- не трогаем.
--
-- Что здесь:
--  * assist_admin_settings: переключатель голосового управления «Админки»
--    off|test|on|degraded, правила, кто включил и какую редакцию рисков
--    принял, отчёт мастера под `on`, «тестовые» хосты админки (staging),
--    отметка последней тревоги монитора;
--  * assist_admin_ui_plans — голосовые планы сотрудников (вторая модель,
--    без поля «режим» — §5-бис.9, аудит 1.2); журнал шагов — строки
--    `ui-plan`/`ui-step`/`chain` в append-only assist_admin_action_log;
--  * assist_admin_voice_tests — мастер проверки «Админки» Т-2 (У-22: своя
--    таблица); отчёт — ещё и строкой `ui-test` в журнале действий.
--
-- Роль assist_public: НИ ОДНОГО права на новые таблицы (§4.3-бис слой 3,
-- §5-бис.10 п.12) — явный REVOKE в конце; тест роли берёт список
-- assist_admin_* из схемы.

-- AlterTable
ALTER TABLE "assist_admin_settings" ADD COLUMN     "voiceControlAdminAlertAt" TIMESTAMP(3),
ADD COLUMN     "voiceControlAdminEnabledBy" TEXT,
ADD COLUMN     "voiceControlAdminRisksAt" TIMESTAMP(3),
ADD COLUMN     "voiceControlAdminRisksVersion" TEXT,
ADD COLUMN     "voiceControlAdminRules" JSONB,
ADD COLUMN     "voiceControlAdminState" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "voiceControlAdminStateAt" TIMESTAMP(3),
ADD COLUMN     "voiceControlAdminStateBy" TEXT,
ADD COLUMN     "voiceControlAdminStateReason" TEXT,
ADD COLUMN     "voiceControlAdminTestHostIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "voiceControlAdminTestId" TEXT;

-- CreateTable
CREATE TABLE "assist_admin_ui_plans" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT,
    "actor" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "utteranceMasked" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lang" TEXT,
    "pageUrl" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "liveUtterance" TEXT,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "needsConfirm" BOOLEAN NOT NULL,
    "confirmedBy" TEXT,
    "confirmBefore" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cardFrom" INTEGER NOT NULL DEFAULT 0,
    "pnrConfirmedAt" TIMESTAMP(3),
    "chainStatus" TEXT,
    "planOrigin" TEXT NOT NULL DEFAULT 'model',
    "memoRunId" TEXT,
    "memoFrom" INTEGER,
    "memoTo" INTEGER,
    "voiceTestId" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_ui_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_voice_tests" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "testHost" BOOLEAN NOT NULL DEFAULT false,
    "startedBy" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "sessionId" TEXT,
    "actor" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,
    "result" TEXT,
    "validUntil" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),
    "release" TEXT,
    "partialAckBy" TEXT,
    "partialAckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_voice_tests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_admin_ui_plans_siteId_actor_createdAt_idx" ON "assist_admin_ui_plans"("siteId", "actor", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_ui_plans_siteId_createdAt_idx" ON "assist_admin_ui_plans"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_ui_plans_voiceTestId_idx" ON "assist_admin_ui_plans"("voiceTestId");

-- CreateIndex
CREATE INDEX "assist_admin_ui_plans_accountId_idx" ON "assist_admin_ui_plans"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_ui_plans_id_accountId_key" ON "assist_admin_ui_plans"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_voice_tests_tokenHash_key" ON "assist_admin_voice_tests"("tokenHash");

-- CreateIndex
CREATE INDEX "assist_admin_voice_tests_siteId_createdAt_idx" ON "assist_admin_voice_tests"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_voice_tests_accountId_idx" ON "assist_admin_voice_tests"("accountId");

-- AddForeignKey
ALTER TABLE "assist_admin_ui_plans" ADD CONSTRAINT "assist_admin_ui_plans_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_ui_plans" ADD CONSTRAINT "assist_admin_ui_plans_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_admin_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_voice_tests" ADD CONSTRAINT "assist_admin_voice_tests_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Переключатель «Админки» (§5-бис.2, §5-бис.11): только четыре состояния;
-- из `off` — только с принятой редакцией рисков и тем, кто включил; `on` —
-- только с отчётом мастера (решение владельца 03.10.2026 п.1). Сервис
-- проверяет годность отчёта (срок, выпуск, итог); здесь — последний рубеж
-- от прямого UPDATE в обход сервиса.
CREATE OR REPLACE FUNCTION "assist_admin_settings_voice_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fresh boolean := false;
  usable boolean := false;
BEGIN
  IF NEW."voiceControlAdminState" NOT IN ('off', 'test', 'on', 'degraded') THEN
    RAISE EXCEPTION 'assist_admin_settings: неизвестное состояние голосового управления'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."voiceControlAdminState" <> 'off'
     AND (NEW."voiceControlAdminRisksVersion" IS NULL
          OR NEW."voiceControlAdminEnabledBy" IS NULL) THEN
    RAISE EXCEPTION 'assist_admin_settings: голосовое управление — только после экрана рисков владельцем'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."voiceControlAdminState" = 'on' AND NEW."voiceControlAdminTestId" IS NULL THEN
    RAISE EXCEPTION 'assist_admin_settings: «on» — только с отчётом мастера проверки'
      USING ERRCODE = '23514';
  END IF;
  -- Переход в `on` (или смена отчёта под ним): отчёт — СДАННЫЙ мастер ЭТОГО
  -- сайта, pass или partial с подтверждением, не просроченный (не любая
  -- строка в поле). Правки правил под уже включённым `on` не трогаются.
  -- (OLD при INSERT не читается: вложенные IF, а не OR.)
  IF NEW."voiceControlAdminState" = 'on' THEN
    IF TG_OP = 'INSERT' THEN
      fresh := true;
    ELSIF OLD."voiceControlAdminState" IS DISTINCT FROM 'on'
       OR OLD."voiceControlAdminTestId" IS DISTINCT FROM NEW."voiceControlAdminTestId" THEN
      fresh := true;
    END IF;
    IF fresh THEN
      -- Схема — та же, что у таблицы триггера (адаптер search_path не ставит).
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I."assist_admin_voice_tests" t
          WHERE t."id" = $1 AND t."siteId" = $2 AND t."accountId" = $3
            AND t."reportedAt" IS NOT NULL
            AND t."validUntil" > CURRENT_TIMESTAMP
            AND (t."result" = ''pass''
                 OR (t."result" = ''partial'' AND t."partialAckAt" IS NOT NULL)))',
        TG_TABLE_SCHEMA)
        INTO usable
        USING NEW."voiceControlAdminTestId", NEW."siteId", NEW."accountId";
      IF NOT usable THEN
        RAISE EXCEPTION 'assist_admin_settings: «on» — только со сданным годным отчётом мастера этого сайта'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assist_admin_settings_voice_guard"
  BEFORE INSERT OR UPDATE ON "assist_admin_settings"
  FOR EACH ROW EXECUTE FUNCTION "assist_admin_settings_voice_guard"();

-- Отчёт мастера «Админки» — доказательство для `on` (§5-бис.13): чья ссылка,
-- какой хост и тестовый ли он — неизменны всегда; после сдачи отчёта —
-- неизменны и сам отчёт, итог, срок, сотрудник; число попыток по
-- запрещённым целям только растёт.
CREATE OR REPLACE FUNCTION "assist_admin_voice_tests_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Новая ссылка — всегда чистая: отчёт, итог и обмен приходят только
  -- UPDATE'ами сервиса (готовый «pass» прямой вставкой — нет).
  IF TG_OP = 'INSERT' THEN
    IF NEW."reportedAt" IS NOT NULL OR NEW."report" IS NOT NULL
       OR NEW."result" IS NOT NULL OR NEW."validUntil" IS NOT NULL
       OR NEW."usedAt" IS NOT NULL OR NEW."partialAckAt" IS NOT NULL
       OR NEW."attempts" <> 0 THEN
      RAISE EXCEPTION 'assist_admin_voice_tests: новая ссылка мастера — без отчёта'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."siteId" IS DISTINCT FROM OLD."siteId"
     OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
     OR NEW."hostId" IS DISTINCT FROM OLD."hostId"
     OR NEW."host" IS DISTINCT FROM OLD."host"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."testHost" IS DISTINCT FROM OLD."testHost"
     OR NEW."startedBy" IS DISTINCT FROM OLD."startedBy"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'assist_admin_voice_tests: ссылка мастера неизменна'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'assist_admin_voice_tests: попытки по запрещённым целям не убывают'
      USING ERRCODE = '42501';
  END IF;
  IF OLD."reportedAt" IS NOT NULL AND (
       NEW."reportedAt" IS DISTINCT FROM OLD."reportedAt"
    OR NEW."report" IS DISTINCT FROM OLD."report"
    OR NEW."result" IS DISTINCT FROM OLD."result"
    OR NEW."validUntil" IS DISTINCT FROM OLD."validUntil"
    OR NEW."release" IS DISTINCT FROM OLD."release"
    OR NEW."actor" IS DISTINCT FROM OLD."actor"
    OR NEW."attempts" IS DISTINCT FROM OLD."attempts") THEN
    RAISE EXCEPTION 'assist_admin_voice_tests: сданный отчёт неизменен'
      USING ERRCODE = '42501';
  END IF;
  IF OLD."partialAckAt" IS NOT NULL
     AND (NEW."partialAckAt" IS DISTINCT FROM OLD."partialAckAt"
          OR NEW."partialAckBy" IS DISTINCT FROM OLD."partialAckBy") THEN
    RAISE EXCEPTION 'assist_admin_voice_tests: подтверждение partial — один раз'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assist_admin_voice_tests_guard"
  BEFORE INSERT OR UPDATE ON "assist_admin_voice_tests"
  FOR EACH ROW EXECUTE FUNCTION "assist_admin_voice_tests_guard"();

-- Роль виджета к «Админке» дороги не имеет (§4.3-бис слой 3, К-9,
-- §5-бис.10 п.12: SELECT под assist_public из assist_admin_ui_plans падает).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
    REVOKE ALL ON "assist_admin_ui_plans", "assist_admin_voice_tests"
      FROM assist_public;
  END IF;
END
$$;
