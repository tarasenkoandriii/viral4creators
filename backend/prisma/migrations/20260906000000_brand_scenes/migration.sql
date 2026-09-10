-- Постоянные сцены бренда (ТЗ §17.1, этап 22) — зеркало brand_characters.
-- Написана вручную (в песочнике нет доступа к binaries.prisma.sh);
-- соответствует model BrandScene в schema.prisma.

-- CreateTable
CREATE TABLE "brand_scenes" (
    "id" TEXT NOT NULL,
    "brandManifestId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "photoUrl" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_scenes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_scenes_brandManifestId_idx" ON "brand_scenes"("brandManifestId");

-- AddForeignKey
ALTER TABLE "brand_scenes" ADD CONSTRAINT "brand_scenes_brandManifestId_fkey" FOREIGN KEY ("brandManifestId") REFERENCES "brand_manifests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
