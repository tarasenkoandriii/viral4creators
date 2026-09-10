-- Целевая аудитория товара (ТЗ §18, этап 23) — оценка Gemini по фото с
-- правками пользователя, структура AudienceProfile. Написана вручную
-- (нет доступа к binaries.prisma.sh); соответствует schema.prisma.

-- AlterTable
ALTER TABLE "product_items" ADD COLUMN "audience" JSONB;
