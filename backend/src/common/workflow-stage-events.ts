import { Logger } from '@nestjs/common';
import { Prisma, WorkflowKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const logger = new Logger('WorkflowStageEvents');

/**
 * Общий тип клиента для записи событий воронки (doc/WORKFLOW-FUNNEL-SPEC.md
 * §3.2) — вызывающие места пишут событие то напрямую через сервис
 * (`this.prisma`), то изнутри `$transaction` (`catalog-batch.service.ts`
 * `create()`/`retry()`), а `Prisma.TransactionClient` и `PrismaService`
 * структурно НЕ совпадают («Внеплановый фикс №1» —
 * doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md — тот же класс несовпадения
 * типов, что уже однажды ронял сборку) — сигнатура принимает оба явно,
 * а не только `PrismaService`.
 */
export type WorkflowEventClient = PrismaService | Prisma.TransactionClient;

/**
 * Записывает одно событие «сущность воркфлоу перешла в статус X» в
 * append-only таблицу `WorkflowStageEvent` (doc/WORKFLOW-FUNNEL-SPEC.md
 * §3.1). Единая точка вызова для всех трёх воркфлоу (сессия, партия,
 * A/B) — один и тот же код что для обычного перехода, что для ухода в
 * ошибку, что для самого первого события сущности (`fromStage: null`).
 *
 * Никогда не бросает: запись — вспомогательная аналитика для вкладки
 * «Воронка» в админке, а не часть бизнес-транзакции — сбой записи не
 * должен ронять генерацию ролика/партии/A-B-варианта (doc/
 * WORKFLOW-FUNNEL-SPEC.md §3.2). Ошибка проглатывается через `Logger`,
 * тем же приёмом, что уже применён у `CronRunLog`/orphan-sweep для
 * «best-effort», не критичной для согласованности бизнес-данных, записи.
 */
export async function logWorkflowStage(
  prisma: WorkflowEventClient,
  workflow: WorkflowKind,
  entityId: string,
  fromStage: string | null,
  stage: string,
): Promise<void> {
  try {
    await prisma.workflowStageEvent.create({
      data: { workflow, entityId, fromStage, stage },
    });
  } catch (error) {
    logger.warn(
      `Не удалось записать событие воронки (${workflow} ${entityId}: ` +
        `${fromStage ?? 'null'} → ${stage}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
