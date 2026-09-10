-- Товар / Проект / Манифест бренда — doc/PRODUCT-PROJECT-SPEC.md, этап 2
-- плана реализации (doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md).
--
-- Написано вручную по тем же причинам, что и предыдущие миграции этого
-- проекта (см. doc/TELEGRAM-ADMIN.md, §5 — песочница не может достучаться
-- до binaries.prisma.sh, `prisma migrate dev` здесь не запустить). Но НЕ
-- непроверено: schema.prisma провалидирована настоящим `prisma validate`
-- (через bundled WASM, без скачивания engine), а этот SQL применён
-- по-настоящему к локальному Postgres 16 вслед за всеми пятью
-- предыдущими миграциями, с последующими insert/cascade-проверками — см.
-- doc/DATABASE-AUDIT.md, раздел про эту миграцию. Перед накаткой на
-- реальную Supabase-базу всё равно стоит прогнать `prisma migrate diff`
-- там, где сеть есть — как и для всех остальных ручных миграций.
--
-- Одной миграцией (а не по таблице на этап), потому что ничего из этого
-- ещё не в проде — дробить нечего.

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('SINGLE', 'LINE');

-- CreateEnum
CREATE TYPE "ProductPriceSource" AS ENUM ('MANUAL', 'ANALOG');

-- CreateTable: манифест бренда — раньше projects, т.к. projects на него
-- ссылается (FK brandManifestId).
CREATE TABLE "brand_manifests" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "filters" JSONB,
    "effects" JSONB,
    "styleNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_characters" (
    "id" TEXT NOT NULL,
    "brandManifestId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "photoUrl" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" "ProjectType" NOT NULL,
    "title" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "brandManifestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_items" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT,
    "photoUrl" TEXT,
    "photoHash" TEXT,
    "description" TEXT,
    "category" TEXT,
    "price" DECIMAL(12,2),
    "priceSource" "ProductPriceSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_analogs" (
    "id" TEXT NOT NULL,
    "productItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "price" DECIMAL(12,2),
    "currency" TEXT,
    "thumbnailUrl" TEXT,
    "relevanceRank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_analogs_pkey" PRIMARY KEY ("id")
);

-- AlterTable: связь Session → Project/ProductItem (ТЗ §7.8). Опционально,
-- NULL по умолчанию — все существующие анонимные сессии остаются как есть.
ALTER TABLE "sessions" ADD COLUMN     "projectId" TEXT;
ALTER TABLE "sessions" ADD COLUMN     "productItemId" TEXT;

-- CreateIndex
CREATE INDEX "brand_manifests_userId_idx" ON "brand_manifests"("userId");

-- CreateIndex
CREATE INDEX "brand_characters_brandManifestId_idx" ON "brand_characters"("brandManifestId");

-- CreateIndex
CREATE INDEX "projects_userId_idx" ON "projects"("userId");

-- CreateIndex
CREATE INDEX "projects_brandManifestId_idx" ON "projects"("brandManifestId");

-- CreateIndex
CREATE INDEX "product_items_projectId_idx" ON "product_items"("projectId");

-- CreateIndex: кеш поиска аналогов по хешу фото (ТЗ §7.5) — первый
-- запрос при каждой обработке фото, поэтому индексирован.
CREATE INDEX "product_items_photoHash_idx" ON "product_items"("photoHash");

-- CreateIndex
CREATE INDEX "product_analogs_productItemId_idx" ON "product_analogs"("productItemId");

-- CreateIndex
CREATE INDEX "sessions_projectId_idx" ON "sessions"("projectId");

-- CreateIndex
CREATE INDEX "sessions_productItemId_idx" ON "sessions"("productItemId");

-- AddForeignKey: удаление пользователя не уносит его каталог (SetNull) —
-- симметрично уже существующему sessions.userId.
ALTER TABLE "brand_manifests" ADD CONSTRAINT "brand_manifests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: персонажи без манифеста бессмысленны — Cascade.
ALTER TABLE "brand_characters" ADD CONSTRAINT "brand_characters_brandManifestId_fkey" FOREIGN KEY ("brandManifestId") REFERENCES "brand_manifests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: удалить манифест ≠ удалить проекты, которые его
-- использовали — SetNull.
ALTER TABLE "projects" ADD CONSTRAINT "projects_brandManifestId_fkey" FOREIGN KEY ("brandManifestId") REFERENCES "brand_manifests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: товары живут внутри проекта — Cascade.
ALTER TABLE "product_items" ADD CONSTRAINT "product_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: аналоги живут внутри товара — Cascade.
ALTER TABLE "product_analogs" ADD CONSTRAINT "product_analogs_productItemId_fkey" FOREIGN KEY ("productItemId") REFERENCES "product_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: удаление проекта/товара НЕ уничтожает уже сгенерированные
-- ролики — Session самодостаточна (данные скопированы снимком в data),
-- связь только для истории → SetNull.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_productItemId_fkey" FOREIGN KEY ("productItemId") REFERENCES "product_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
