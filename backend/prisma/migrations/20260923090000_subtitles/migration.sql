-- Этап 67 (TODO §Уровень 2.7). Жёстко вшитые субтитры с брендовым
-- стилем и автотаймингом: тумблер уровня бренда (subtitlesMode) и
-- пресетная тема оформления (subtitleTheme), тот же паттерн, что у
-- voiceMode/cameraMove — plain String-колонки, не Prisma-enum,
-- нормализуются на чтении (common/subtitles.ts). Умолчания (off /
-- classic) не меняют поведение существующих брендов после миграции.

ALTER TABLE "brand_manifests" ADD COLUMN "subtitlesMode" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "brand_manifests" ADD COLUMN "subtitleTheme" TEXT NOT NULL DEFAULT 'classic';
