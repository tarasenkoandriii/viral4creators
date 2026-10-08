-- Э6-тер (9), заход 9: «отчёт для разработчика» голосовой карты «Сайта» —
-- ссылка только на чтение (ТЗ помощника §5-кватер.4 «Пакетом — отчёт для
-- разработчика», §5-кватер.13 `GET …/voice-map/site/dev-report/:token`).
--
-- Строка — снятое при выдаче содержимое отчёта (цели, где искать, строка
-- `data-assist-id`, подсказки платформ; без ПД и без живого черновика),
-- SHA-256 токена, срок (7 дней), отзыв, счётчик просмотров. Новая ссылка
-- гасит прежние ссылки сайта; истёкшие строки удаляет выдача следующей.
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.

-- CreateTable
CREATE TABLE "assist_site_voice_map_dev_reports" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_voice_map_dev_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_map_dev_reports_tokenHash_key" ON "assist_site_voice_map_dev_reports"("tokenHash");

-- CreateIndex
CREATE INDEX "assist_site_voice_map_dev_reports_siteId_idx" ON "assist_site_voice_map_dev_reports"("siteId");

-- CreateIndex
CREATE INDEX "assist_site_voice_map_dev_reports_accountId_idx" ON "assist_site_voice_map_dev_reports"("accountId");

-- AddForeignKey
ALTER TABLE "assist_site_voice_map_dev_reports" ADD CONSTRAINT "assist_site_voice_map_dev_reports_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Роль виджета к отчётам дороги не имеет (§4.3-бис слой 3): публичный
-- маршрут отчёта читает строку основной ролью по хешу токена.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
    REVOKE ALL ON "assist_site_voice_map_dev_reports" FROM assist_public;
  END IF;
END
$$;
