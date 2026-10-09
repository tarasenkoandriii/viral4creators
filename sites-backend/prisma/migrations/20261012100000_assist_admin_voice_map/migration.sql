-- Заход 11, пакет А (№117): голосовая карта «Админки» — второй экземпляр
-- карты Э6-тер (ТЗ помощника §5-кватер.9 «Изоляция», §5-кватер.13; К-9;
-- В-55 — тариф Pro). Решения — Р-З11-А1….
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma, дальше права); CI
-- сверяет со schema.prisma (`migrate diff --exit-code`). Только аддитивно:
-- три новые таблицы, прежние не меняются.
--
--  * assist_admin_voice_maps — черновик карты «Админки» (JSON: цели, шаблоны
--    страниц, термины — как у «Сайта», Р-З11-А1) с ревизией, номер
--    опубликованной версии (`voiceMapVersion` «Админки»), суточные
--    счётчики «Сказать сейчас» и запросов публикации из редактора;
--  * assist_admin_voice_map_versions — неизменяемые версии (ворота кода,
--    публикация только владельцем «Админки» в TMA, откат — новой версией);
--  * assist_admin_voice_map_editor_sessions — одноразовая ссылка редактора
--    на хосте САМОЙ админки (10 мин) и сессия (30 мин скользящих, ≤ 4 ч),
--    привязанная к сессии сотрудника `wa.` (employee-JWT); токены — SHA-256.
-- Журнал изменений карты — строки `voice-map` в append-only
-- `assist_admin_action_log` (своей таблицы журнала нет).
--
-- Роль assist_public (виджет «Сайта») к карте «Админки» не имеет НИКАКОГО
-- доступа — ни таблиц, ни представления (§5-кватер.9, У-28/У-31); тест роли
-- берёт список `assist_admin_*` из схемы (src/prisma/assist-public-role.spec.ts).

-- CreateTable
CREATE TABLE "assist_admin_voice_maps" (
    "siteId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "versionSeq" INTEGER NOT NULL DEFAULT 0,
    "draftRevision" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB NOT NULL,
    "tryDay" TEXT,
    "tryCount" INTEGER NOT NULL DEFAULT 0,
    "publishReqDay" TEXT,
    "publishReqCount" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_voice_maps_pkey" PRIMARY KEY ("siteId")
);

-- CreateTable
CREATE TABLE "assist_admin_voice_map_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "gateReport" JSONB,
    "rollbackOf" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "requestedVia" TEXT NOT NULL,
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "assist_admin_voice_map_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_voice_map_editor_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "parentOrigin" TEXT NOT NULL,
    "pagePath" TEXT NOT NULL DEFAULT '/',
    "focusKey" TEXT,
    "linkTokenHash" TEXT NOT NULL,
    "sessionTokenHash" TEXT,
    "adminSessionId" TEXT,
    "employeeRef" TEXT,
    "linkExpiresAt" TIMESTAMP(3) NOT NULL,
    "exchangedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "absoluteExpiresAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "lastPublishRequestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_voice_map_editor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_admin_voice_maps_accountId_idx" ON "assist_admin_voice_maps"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_voice_maps_siteId_accountId_key" ON "assist_admin_voice_maps"("siteId", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_voice_map_versions_accountId_idx" ON "assist_admin_voice_map_versions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_voice_map_versions_siteId_number_key" ON "assist_admin_voice_map_versions"("siteId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_voice_map_editor_sessions_linkTokenHash_key" ON "assist_admin_voice_map_editor_sessions"("linkTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_voice_map_editor_sessions_sessionTokenHash_key" ON "assist_admin_voice_map_editor_sessions"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "assist_admin_voice_map_editor_sessions_siteId_idx" ON "assist_admin_voice_map_editor_sessions"("siteId");

-- CreateIndex
CREATE INDEX "assist_admin_voice_map_editor_sessions_accountId_idx" ON "assist_admin_voice_map_editor_sessions"("accountId");

-- AddForeignKey
ALTER TABLE "assist_admin_voice_maps" ADD CONSTRAINT "assist_admin_voice_maps_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_voice_map_versions" ADD CONSTRAINT "assist_admin_voice_map_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_voice_map_editor_sessions" ADD CONSTRAINT "assist_admin_voice_map_editor_sessions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ══ Роль assist_public (виджет «Сайта») — ничего (§5-кватер.9, У-31) ══
-- Явно, независимо от прав схемы по умолчанию: ни черновика, ни версий, ни
-- сессий редактора карты «Админки» роль виджета не видит.
REVOKE ALL ON TABLE "assist_admin_voice_maps" FROM assist_public;
REVOKE ALL ON TABLE "assist_admin_voice_map_versions" FROM assist_public;
REVOKE ALL ON TABLE "assist_admin_voice_map_editor_sessions" FROM assist_public;
