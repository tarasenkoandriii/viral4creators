-- Э6 ИИ-помощника «Видео-ответы и „показать на экране“». ТЗ помощника §4.9,
-- §4.11, §4.12, §4.3-бис (У-7); план, Приложение А «Этап 6»; аудит слияния
-- §3.2 (`site_ui_maps` — общая карта, Ш4 её расширит).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше комментарии
-- и права); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- Что здесь:
--  * assist_site_videos — ролики обучалки генератора, привязанные к сайту
--    помощника; пишет только внутренний API генератора (HMAC), показ
--    включает владелец; `url` Blob наружу не отдаётся — только подписанная
--    ссылка со сроком;
--  * site_ui_maps — карта интерфейса страницы (селекторы и подписи) из
--    обхода и раундов обучалки; сигнал «карта устарела» — счётчик промахов
--    загрузчика;
--  * site_sites.assistVideosAsOf — отметка последнего принятого набора
--    роликов (гонка синхронизаций: старый набор не принимается);
--  * GRANT роли assist_public — в конце, минимальные, с причиной.

-- CreateTable
CREATE TABLE "assist_site_videos" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "ownerTelegramId" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "durationMs" INTEGER,
    "url" TEXT NOT NULL,
    "requiresLogin" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_ui_maps" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "elements" JSONB NOT NULL,
    "elementsHash" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "staleSignals" INTEGER NOT NULL DEFAULT 0,
    "lastStaleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_ui_maps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_site_videos_siteId_enabled_idx" ON "assist_site_videos"("siteId", "enabled");

-- CreateIndex
CREATE INDEX "assist_site_videos_accountId_idx" ON "assist_site_videos"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_videos_siteId_externalId_key" ON "assist_site_videos"("siteId", "externalId");

-- CreateIndex
CREATE INDEX "site_ui_maps_hostId_idx" ON "site_ui_maps"("hostId");

-- CreateIndex
CREATE INDEX "site_ui_maps_accountId_idx" ON "site_ui_maps"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_ui_maps_siteId_host_path_source_key" ON "site_ui_maps"("siteId", "host", "path", "source");

-- Отметка последнего принятого набора роликов от генератора (аудит Э6, гонка
-- синхронизаций): `asOf` в мс часов генератора; набор старше — `stale: true`,
-- ничего не меняется. NULL — синхронизаций не было.
-- AlterTable
ALTER TABLE "site_sites" ADD COLUMN "assistVideosAsOf" BIGINT;

-- AddForeignKey
ALTER TABLE "assist_site_videos" ADD CONSTRAINT "assist_site_videos_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_ui_maps" ADD CONSTRAINT "site_ui_maps_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_ui_maps" ADD CONSTRAINT "site_ui_maps_hostId_accountId_fkey" FOREIGN KEY ("hostId", "accountId") REFERENCES "site_hosts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ══ Роль assist_public (виджет) — минимум для видео и подсветки ══

-- Видео в ответе (assist-site-media/public/site-videos.ts): список включённых
-- роликов сайта для промпта, проверка действия и выдача подписанной ссылки,
-- редирект по ней — всё по (siteId, enabled, requiresLogin). Хозяин,
-- черновик, id генератора и сроки синхронизации — не её.
GRANT SELECT ("id", "siteId", "title", "locale", "durationMs", "url", "requiresLogin", "enabled") ON "assist_site_videos" TO assist_public;
-- Подсветка (assist-site-media/public/ui-map.ts): элементы карты страницы
-- посетителя по (siteId, host, path) и сигнал «карта устарела» — условный
-- UPDATE счётчика промахов (SET "staleSignals" = "staleSignals" + 1 требует
-- SELECT этой колонки; elements — проверка, что такой элемент в карте есть;
-- id — Prisma добавляет первичный ключ в SELECT списка с jsonb-колонкой).
GRANT SELECT ("id", "siteId", "host", "path", "source", "elements", "staleSignals") ON "site_ui_maps" TO assist_public;
GRANT UPDATE ("staleSignals", "lastStaleAt") ON "site_ui_maps" TO assist_public;
