-- Аудит watermark-пайплайна (защита от пиратства, ТЗ на маркетплейс
-- §9/§22): FAILED был терминальным состоянием без единого пути назад,
-- поэтому временный сбой ffmpeg-api оставлял ролик без знака на витрине
-- навсегда. Аддитивная миграция, ни одна существующая колонка не теряется.

-- AlterTable
ALTER TABLE "portfolio_items" ADD COLUMN "watermarkAttempts" INTEGER NOT NULL DEFAULT 0;
