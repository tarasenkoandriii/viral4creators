-- Этап 152, аудит: A/B-варианты поверх приёма сцены (TODO §III п.11).
--
-- `libraryEntryId` требовался всегда: A/B заводился, когда источником
-- сцены мог быть только разобранный референс, а он всегда попадает в
-- библиотеку. У сессии на приёме записи в библиотеке нет и не будет, и
-- обязательная колонка делала всю ветку недостижимой — `AbTestService`
-- отказывал раньше, чем доходило до сборки вариантов.
--
-- Колонка становится необязательной, и рядом появляется вторая: чем
-- именно задана сцена у прогона. Ровно одна из двух заполнена — это
-- проверяет CHECK ниже, потому что «ни одной» означало бы прогон, у
-- которого дочерним сессиям нечего унаследовать, а «обе» — спор двух
-- источников, который пришлось бы разрешать в воркере.
ALTER TABLE "ab_test_runs" ALTER COLUMN "libraryEntryId" DROP NOT NULL;
ALTER TABLE "ab_test_runs" ADD COLUMN "sceneTemplateId" TEXT;

ALTER TABLE "ab_test_runs"
  ADD CONSTRAINT "ab_test_runs_scene_source"
  CHECK (
    ("libraryEntryId" IS NOT NULL AND "sceneTemplateId" IS NULL)
    OR ("libraryEntryId" IS NULL AND "sceneTemplateId" IS NOT NULL)
  );
