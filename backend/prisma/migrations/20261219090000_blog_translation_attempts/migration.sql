-- Повтор провалившихся переводов блога (аудит блога 24.09.2026).
--
-- До этой колонки статус FAILED был тупиком: строку не подбирал ни
-- `submitPendingBatch` (он брал только PENDING с пустым batchJobId), ни
-- `ensurePendingTranslations` (createMany + skipDuplicates существующую
-- строку не чинит). Деньги за элемент пачки при этом уже списаны.
--
-- Значение по умолчанию 0 корректно и для уже существующих строк: у
-- провалившихся раньше попыток не считали вовсе, и дать им ещё три —
-- ровно то, чего они не получили.
ALTER TABLE "blog_post_translations"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
