-- Кешированные входные токены (ТЗ §26.1), этап 32. Провайдеры считают
-- повторно использованный вход дешевле, и без отдельного счётчика расход
-- завышался. Написана вручную; соответствует schema.prisma.

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0;
