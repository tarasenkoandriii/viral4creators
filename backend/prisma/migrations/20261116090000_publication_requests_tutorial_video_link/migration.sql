-- Этап 101 (ТЗ §4.7, Фаза 3) — публикация обучающих видео в YouTube/TikTok
-- переиспользует существующую очередь `publication_requests` вместо новой
-- модели/воркера (см. doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.7
-- и "## Сделано (этап 101 — ...)" в doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md
-- за полное обоснование выбора).
--
-- "sessionId"/"generatedVideoId" были обязательными, потому что каждая
-- заявка раньше заводилась ровно от сессии с рекламным роликом. Заявка от
-- обучающего видео такой сессии не имеет вовсе — не "забыли заполнить", а
-- поле неприменимо, поэтому оба становятся необязательными, а не получают
-- фиктивное значение-заглушку.
ALTER TABLE "publication_requests" ALTER COLUMN "sessionId" DROP NOT NULL;
ALTER TABLE "publication_requests" ALTER COLUMN "generatedVideoId" DROP NOT NULL;

-- Мягкая ссылка на TutorialVideoAsset, из которого заведена заявка —
-- не FK (тот же журнальный приём, что у TutorialVideoAsset.scenarioId).
ALTER TABLE "publication_requests" ADD COLUMN "tutorialVideoAssetId" TEXT;

CREATE INDEX "publication_requests_tutorialVideoAssetId_idx"
  ON "publication_requests" ("tutorialVideoAssetId");
