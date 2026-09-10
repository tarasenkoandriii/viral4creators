-- Голос и тон озвучки бренда — ТЗ §13 («минимум» по озвучке). Одна
-- nullable-колонка, данных не трогает. Написано вручную (см.
-- doc/TELEGRAM-ADMIN.md §5), schema.prisma провалидирована `prisma validate`,
-- SQL применён к локальному Postgres 16 десятым по порядку.

-- AlterTable
ALTER TABLE "brand_manifests" ADD COLUMN "voiceNotes" TEXT;
