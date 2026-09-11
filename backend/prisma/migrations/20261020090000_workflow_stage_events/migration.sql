-- Этап 78 (doc/WORKFLOW-FUNNEL-SPEC.md, doc/WORKFLOW-FUNNEL-COHORT-
-- CONVERSION-SPEC.md). Append-only журнал переходов по трём воркфлоу
-- (сессия, пакетная генерация, A/B-варианты) — существующие статусные
-- колонки (Session.status/CatalogBatchItem.status/AbTestVariant.status)
-- остаются источником ТЕКУЩЕГО состояния, эта таблица — единственный
-- источник ИСТОРИИ переходов, нужный и событийной воронке, и когортной
-- конверсии (вторая переиспользует эту же таблицу без изменений схемы,
-- см. WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md §2.1).

CREATE TYPE "WorkflowKind" AS ENUM ('SESSION', 'CATALOG_BATCH_ITEM', 'AB_TEST_VARIANT');

CREATE TABLE "workflow_stage_events" (
    "id" TEXT NOT NULL,
    "workflow" "WorkflowKind" NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromStage" TEXT,
    "stage" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_stage_events_pkey" PRIMARY KEY ("id")
);

-- Обслуживает основной запрос воронки: сколько разных entityId получили
-- событие (workflow, stage) внутри окна [from, to) — и когортный CTE
-- (workflow, fromStage IS NULL, occurredAt), частично покрываемый тем же
-- индексом (см. §5 когортного ТЗ, минорное примечание о производительности).
CREATE INDEX "workflow_stage_events_workflow_stage_occurredAt_idx" ON "workflow_stage_events"("workflow", "stage", "occurredAt");

-- Обслуживает разбивку терминальных ошибок по источнику (fromStage).
CREATE INDEX "workflow_stage_events_workflow_stage_fromStage_idx" ON "workflow_stage_events"("workflow", "stage", "fromStage");

-- Без внешних ключей на entityId (сознательно, см. schema.prisma): одна
-- таблица обслуживает три разные модели-владельца (Session/
-- CatalogBatchItem/AbTestVariant), единого FK-таргета нет.
