-- Э6-бис (г) ИИ-помощника «Голосовое управление»: мастер проверки Т-2,
-- монитор Т-4, авто-деградация, рубильник платформы, канарейка загрузчика;
-- решения владельца 03.10.2026 п.1–5. ТЗ помощника §5-бис.10–14, §4-тер.14;
-- план, Приложение А «Этап 6-бис» (г) и «Э6-бис (г) — сделано».
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше комментарии,
-- бэкфилл, функция-предохранитель и права); CI сверяет со schema.prisma
-- (`migrate diff --exit-code`; функции движок схем не сравнивает).
-- Предыдущие миграции не трогаем. Т-3 (автотест на общем QA-воркере) —
-- отложен до воркера: таблица контрольных команд уже есть (её наполняет
-- отчёт мастера и бой), прогонов Т-3 нет. «Обучение → Голос» — Э6-тер.
--
-- Что здесь:
--  * assist_sites: отчёт, держащий `on` (`voiceControlSiteTestId`), кто/
--    когда/почему сменил состояние, переходный период 14 дней для сайтов,
--    включённых до мастера (`voiceControlCheckDeadline`, бэкфилл ниже),
--    ручной суточный потолок планов от оператора (`voiceControlPlansPerDay`);
--  * assist_site_ui_plans: план тестовой сессии мастера (`voiceTestId`,
--    `dryRun`) и выпуск чанков виджета (`release`) — монитор и канарейка;
--  * assist_site_voice_tests — отчёты мастера (токены — только хешами);
--  * assist_site_voice_control_commands — контрольные команды (дескрипторы);
--  * assist_site_voice_incidents — журнал монитора (тревоги, деградация,
--    выключение, откат канарейки, рубильник платформы);
--  * assist_site_ui_recrawls — журнал точечного переобхода устаревших
--    страниц карты (решение п.4);
--  * функция `assist_vc_trip` — единственное, чем роль виджета может
--    изменить состояние: ТОЛЬКО выключить (`off`) при нарушении запрета;
--  * GRANT роли assist_public — в конце, минимальные, по колонкам.

-- AlterTable
ALTER TABLE "assist_site_ui_plans" ADD COLUMN     "dryRun" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "release" TEXT,
ADD COLUMN     "voiceTestId" TEXT;

-- AlterTable
ALTER TABLE "assist_sites" ADD COLUMN     "voiceControlCheckDeadline" TIMESTAMP(3),
ADD COLUMN     "voiceControlPlansPerDay" INTEGER,
ADD COLUMN     "voiceControlSiteStateAt" TIMESTAMP(3),
ADD COLUMN     "voiceControlSiteStateBy" TEXT,
ADD COLUMN     "voiceControlSiteStateReason" TEXT,
ADD COLUMN     "voiceControlSiteTestId" TEXT;

-- CreateTable
CREATE TABLE "assist_site_voice_tests" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'wizard',
    "host" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "testHost" BOOLEAN NOT NULL DEFAULT false,
    "startedBy" TEXT,
    "tokenHash" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "sessionHash" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "visitorId" TEXT,
    "release" TEXT,
    "pages" JSONB,
    "report" JSONB,
    "result" TEXT,
    "validUntil" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),
    "partialAckBy" TEXT,
    "partialAckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_voice_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_voice_control_commands" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "testId" TEXT,
    "pagePath" TEXT NOT NULL,
    "utteranceMasked" TEXT NOT NULL,
    "lang" TEXT,
    "expected" JSONB NOT NULL,
    "origin" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_voice_control_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_voice_incidents" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "siteId" TEXT,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "metrics" JSONB,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_voice_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_ui_recrawls" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "staleElements" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_ui_recrawls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_tests_tokenHash_key" ON "assist_site_voice_tests"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_tests_sessionHash_key" ON "assist_site_voice_tests"("sessionHash");

-- CreateIndex
CREATE INDEX "assist_site_voice_tests_siteId_createdAt_idx" ON "assist_site_voice_tests"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_voice_tests_accountId_idx" ON "assist_site_voice_tests"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_voice_control_commands_accountId_idx" ON "assist_site_voice_control_commands"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_control_commands_siteId_origin_pagePath_u_key" ON "assist_site_voice_control_commands"("siteId", "origin", "pagePath", "utteranceMasked");

-- CreateIndex
CREATE INDEX "assist_site_voice_incidents_siteId_createdAt_idx" ON "assist_site_voice_incidents"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_voice_incidents_createdAt_idx" ON "assist_site_voice_incidents"("createdAt");

-- CreateIndex
CREATE INDEX "assist_site_ui_recrawls_siteId_createdAt_idx" ON "assist_site_ui_recrawls"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_ui_recrawls_accountId_idx" ON "assist_site_ui_recrawls"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_ui_plans_siteId_createdAt_idx" ON "assist_site_ui_plans"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_ui_plans_voiceTestId_idx" ON "assist_site_ui_plans"("voiceTestId");

-- AddForeignKey
ALTER TABLE "assist_site_voice_tests" ADD CONSTRAINT "assist_site_voice_tests_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_voice_control_commands" ADD CONSTRAINT "assist_site_voice_control_commands_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_ui_recrawls" ADD CONSTRAINT "assist_site_ui_recrawls_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ══ Бэкфилл: переходный период (решение владельца 03.10.2026 п.1) ══
-- Сайты, включённые в `on` до мастера, молча не выключаются: 14 дней с
-- баннером в TMA «пройдите проверку», затем монитор переводит их в `test`.
UPDATE "assist_sites"
   SET "voiceControlCheckDeadline" = CURRENT_TIMESTAMP + INTERVAL '14 days',
       "voiceControlSiteStateAt" = CURRENT_TIMESTAMP,
       "voiceControlSiteStateBy" = 'transition'
 WHERE "voiceControlSiteState" = 'on' AND "voiceControlSiteTestId" IS NULL;

-- ══ Предохранитель: нарушение запрета → `off` сразу (§5-бис.14) ══
-- Публичный код видит нарушение в момент отчёта шага (цель шага оказалась
-- классом «никогда»): ждать крона монитора нельзя. Права UPDATE на
-- состояние роль не получает (иначе могла бы и ВКЛЮЧИТЬ) — только эту
-- функцию, которая умеет одно: перевести сайт в `off`. Истина — в
-- `assist_sites`; журнал и уведомления — монитор (основная роль).
CREATE FUNCTION "assist_vc_trip"(p_site TEXT, p_reason TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH u AS (
    UPDATE "sites"."assist_sites"
       SET "voiceControlSiteState" = 'off',
           "voiceControlSiteTestId" = NULL,
           "voiceControlSiteStateAt" = now(),
           "voiceControlSiteStateBy" = 'violation',
           "voiceControlSiteStateReason" = left(coalesce(p_reason, 'violation'), 40),
           "updatedAt" = now()
     WHERE "siteId" = p_site AND "voiceControlSiteState" <> 'off'
    RETURNING 1)
  SELECT count(*) > 0 FROM u
$$;
REVOKE ALL ON FUNCTION "assist_vc_trip"(TEXT, TEXT) FROM PUBLIC;


-- ══ Роль assist_public (виджет) — минимум для (г) ══

-- Потолок планов сайта: ручной оверрайд оператора (решение п.2). Остальные
-- новые колонки состояния — кабинету и монитору, роли не нужны.
GRANT SELECT ("voiceControlPlansPerDay") ON "assist_sites" TO assist_public;

-- Предохранитель (см. выше): только выключить.
GRANT EXECUTE ON FUNCTION "assist_vc_trip"(TEXT, TEXT) TO assist_public;

-- Мастер Т-2 идёт через виджет (ТЗ §4-тер.14: INSERT/UPDATE на
-- assist_site_voice_tests; строку создаёт кабинет — INSERT роли не нужен):
--  * обмен одноразовой ссылки на тестовую сессию — один условный UPDATE
--    по хешу токена, сайту, origin и сроку (`usedAt IS NULL`);
--  * сессия — чтение по хешу сессии, сайту, посетителю, сроку;
--  * отчёт — один условный UPDATE своей непринятой строки.
-- Отчёт, итог и срок годности роль пишет, но не читает (`partialAck*`,
-- `startedBy`, `kind`, `createdAt` — ни читать, ни писать).
GRANT SELECT ("id", "siteId", "host", "origin", "testHost", "tokenHash", "tokenExpiresAt", "usedAt", "sessionHash", "sessionExpiresAt", "visitorId", "reportedAt") ON "assist_site_voice_tests" TO assist_public;
GRANT UPDATE ("usedAt", "sessionHash", "sessionExpiresAt", "visitorId", "release", "pages", "report", "result", "validUntil", "reportedAt") ON "assist_site_voice_tests" TO assist_public;

-- assist_site_ui_plans: новые колонки покрыты прежним табличным
-- SELECT/INSERT (миграция _assist_voice_control); UPDATE их роль не получает
-- (тестовая сессия, сухой прогон и выпуск задаются только при создании).
-- Контрольные команды, журнал монитора, журнал переобхода — роли ничего.
