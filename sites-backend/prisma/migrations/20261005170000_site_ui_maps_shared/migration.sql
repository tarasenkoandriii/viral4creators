-- Э-С Ш4: общие карты интерфейса сайтов — подсветка Э6, голос Э6-бис,
-- редактор Э6-тер, Flow-QA (план «Э-С: слияние», Ш4; аудит слияния §3.2).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше комментарии,
-- данные и права); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Миграцию Э6 `20261005140000_assist_video_highlight` не трогаем.
--
-- Что здесь:
--  * site_ui_maps — вид вёрстки снимка (`viewport`: any | desktop | mobile)
--    и номер набора (`version`); ключ снимка — (сайт, хост, путь, источник,
--    вид). Снимки обучалки, принятые до Ш4, — `mobile`: исследователь
--    генератора снимает в окне 390×844 (CAPTURE_VIEWPORT);
--  * site_ui_map_versions — история наборов (новый набор не перезаписывает
--    прежний); ретенция — крон site-ui-map-maintenance (10 версий, 90 дней,
--    текущая — всегда);
--  * site_ui_elements — элементы страницы и вида, слитые из снимков всех
--    источников по стабильному ключу: кандидаты селектора, устойчивость,
--    уверенность, источники, lastSeenAt и промахи ПО ЭЛЕМЕНТУ и виду
--    (порог и окно вместо «страница устарела после первого промаха»);
--    голоса «найден» от снимков загрузчика (seenCount*/seenSince*) — тот же
--    порог и окно: снимок загрузчика — данные посетителя, сам по себе
--    «устарел» не снимает (аудит Ш4, 03.10.2026);
--  * site_ui_element_misses — журнал принятых промахов и голосов «найден»
--    (`kind`): один голос рода на элемент и вид от посетителя и от хеша IP
--    (хеш — с солью на окно, неделя; защита от накрутки);
--  * GRANT роли assist_public — в конце, минимальные, с причиной.

-- DropIndex
DROP INDEX "site_ui_maps_siteId_host_path_source_key";

-- AlterTable
ALTER TABLE "site_ui_maps" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "viewport" TEXT NOT NULL DEFAULT 'any';

-- Данные: снимки обучалки сняты в мобильном окне исследователя (390×844) —
-- компьютеру их элементы не предлагаются, промахи с компьютера по ним не
-- копятся. Уникальность не нарушается: до Ш4 на (сайт, хост, путь,
-- источник) была одна строка.
UPDATE "site_ui_maps" SET "viewport" = 'mobile' WHERE "source" = 'tutorial';

-- CreateTable
CREATE TABLE "site_ui_map_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "elements" JSONB NOT NULL,
    "elementsHash" TEXT NOT NULL,
    "elementCount" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_ui_map_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_ui_elements" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "elementKey" TEXT NOT NULL,
    "elementId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" TEXT,
    "selector" TEXT,
    "candidates" JSONB NOT NULL,
    "stability" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "sources" TEXT[],
    "sourceRank" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "missCountDesktop" INTEGER NOT NULL DEFAULT 0,
    "missSinceDesktop" TIMESTAMP(3),
    "staleDesktopAt" TIMESTAMP(3),
    "missCountMobile" INTEGER NOT NULL DEFAULT 0,
    "missSinceMobile" TIMESTAMP(3),
    "staleMobileAt" TIMESTAMP(3),
    "lastMissAt" TIMESTAMP(3),
    "seenCountDesktop" INTEGER NOT NULL DEFAULT 0,
    "seenSinceDesktop" TIMESTAMP(3),
    "seenCountMobile" INTEGER NOT NULL DEFAULT 0,
    "seenSinceMobile" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_ui_elements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_ui_element_misses" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "elementRowId" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'miss',
    "ipHash" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_ui_element_misses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_ui_map_versions_hostId_idx" ON "site_ui_map_versions"("hostId");

-- CreateIndex
CREATE INDEX "site_ui_map_versions_accountId_idx" ON "site_ui_map_versions"("accountId");

-- CreateIndex
CREATE INDEX "site_ui_map_versions_createdAt_idx" ON "site_ui_map_versions"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_ui_map_versions_siteId_host_path_source_viewport_versi_key" ON "site_ui_map_versions"("siteId", "host", "path", "source", "viewport", "version");

-- CreateIndex
CREATE INDEX "site_ui_elements_siteId_host_path_idx" ON "site_ui_elements"("siteId", "host", "path");

-- CreateIndex
CREATE INDEX "site_ui_elements_hostId_idx" ON "site_ui_elements"("hostId");

-- CreateIndex
CREATE INDEX "site_ui_elements_accountId_idx" ON "site_ui_elements"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_ui_elements_siteId_host_path_viewport_elementKey_key" ON "site_ui_elements"("siteId", "host", "path", "viewport", "elementKey");

-- CreateIndex
CREATE UNIQUE INDEX "site_ui_elements_id_accountId_key" ON "site_ui_elements"("id", "accountId");

-- CreateIndex
CREATE INDEX "site_ui_element_misses_createdAt_idx" ON "site_ui_element_misses"("createdAt");

-- CreateIndex
CREATE INDEX "site_ui_element_misses_accountId_idx" ON "site_ui_element_misses"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_ui_element_misses_elementRowId_viewport_kind_ipHash_key" ON "site_ui_element_misses"("elementRowId", "viewport", "kind", "ipHash");

-- CreateIndex
CREATE UNIQUE INDEX "site_ui_element_misses_elementRowId_viewport_kind_visitorId_key" ON "site_ui_element_misses"("elementRowId", "viewport", "kind", "visitorId");

-- CreateIndex
CREATE UNIQUE INDEX "site_ui_maps_siteId_host_path_source_viewport_key" ON "site_ui_maps"("siteId", "host", "path", "source", "viewport");

-- AddForeignKey
ALTER TABLE "site_ui_map_versions" ADD CONSTRAINT "site_ui_map_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_ui_map_versions" ADD CONSTRAINT "site_ui_map_versions_hostId_accountId_fkey" FOREIGN KEY ("hostId", "accountId") REFERENCES "site_hosts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_ui_elements" ADD CONSTRAINT "site_ui_elements_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_ui_elements" ADD CONSTRAINT "site_ui_elements_hostId_accountId_fkey" FOREIGN KEY ("hostId", "accountId") REFERENCES "site_hosts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_ui_element_misses" ADD CONSTRAINT "site_ui_element_misses_elementRowId_accountId_fkey" FOREIGN KEY ("elementRowId", "accountId") REFERENCES "site_ui_elements"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ══ Роль assist_public (виджет) — минимум для подсветки по общей карте ══

-- Элементы страницы посетителя (assist-site-media/public/ui-map.ts,
-- pageUiElements): лучший селектор, подпись, тег, вид и отметки «устарел»
-- по (siteId, host, path); порядок — ранг источника и место. Сигнал «не
-- найден» (recordUiMiss): строка по elementId и виду, счётчики промахов
-- вида в окне — условный UPDATE с RETURNING отметки (SELECT этих колонок
-- нужен выражениям SET и RETURNING). Подтверждение снимком загрузчика
-- (confirmSeenUiElements, Э6-бис) — по elementKey: lastSeenAt; у элементов
-- с промахами вида — голос «найден» (журнал) и счётчик голосов в окне;
-- порог набран — сброс промахов вида. Кандидаты, источники, уверенность,
-- хост и кабинет — не её: карту пишут обход и внутренний API основной ролью.
GRANT SELECT ("id", "siteId", "host", "path", "viewport", "elementKey", "elementId", "tag", "label", "selector", "sourceRank", "position", "missCountDesktop", "missSinceDesktop", "staleDesktopAt", "missCountMobile", "missSinceMobile", "staleMobileAt", "seenCountDesktop", "seenSinceDesktop", "seenCountMobile", "seenSinceMobile") ON "site_ui_elements" TO assist_public;
GRANT UPDATE ("missCountDesktop", "missSinceDesktop", "staleDesktopAt", "missCountMobile", "missSinceMobile", "staleMobileAt", "lastMissAt", "lastSeenAt", "seenCountDesktop", "seenSinceDesktop", "seenCountMobile", "seenSinceMobile") ON "site_ui_elements" TO assist_public;
-- Журнал промахов: только вставка (ON CONFLICT DO NOTHING без цели —
-- повтор от того же посетителя или IP молча не считается). Читать и
-- удалять журнал виджету незачем (ретенция — крон основной ролью).
GRANT INSERT ("id", "accountId", "siteId", "elementRowId", "viewport", "kind", "ipHash", "visitorId", "createdAt") ON "site_ui_element_misses" TO assist_public;
-- site_ui_maps: права Э6 не меняются (вид и версия роли не нужны — они в
-- ASSIST_PUBLIC_OMIT); site_ui_map_versions — роли ничего.
