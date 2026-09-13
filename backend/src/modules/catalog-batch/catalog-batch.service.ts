/**
 * CatalogBatchService — пакетная генерация по каталогу (ТЗ §44, этап 65,
 * doc/TODO.md §III.5). Один уже одобренный ролик (разбор + промпт)
 * переносится на все остальные выбранные товары линейки за один заход.
 *
 * Только создание партии и чтение её статуса живут здесь — синхронно
 * и быстро (запись нескольких строк, без внешних вызовов). Сама
 * обработка (создание дочерних сессий, перенос разбора, генерация и
 * одобрение промпта, старт рендера) идёт в `CatalogBatchWorkerService`
 * по крону: цепочка на один товар не укладывается в бюджет одного
 * serverless-запроса (§30 SPEC) — см. комментарий там.
 *
 * Доступ — только Premium, тем же признаком пакета 'library', что и
 * обычная библиотека разборов (§21): партия технически целиком
 * построена на переносе одного разбора на много сессий, то есть на той
 * же функции, и решение владельца продукта — не заводить для неё
 * отдельный признак.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import {
  GenerationStatus,
  VideoQuality,
} from '../../common/types/generation.types';
import { SessionStatus } from '../../common/types/session.types';
import { isItemComplete } from '../project/project.service';
import { PlanService } from '../plan/plan.service';
import { CatalogBatchItemStatus, WorkflowKind } from '@prisma/client';
import { logWorkflowStage } from '../../common/workflow-stage-events';

export interface StartCatalogBatchResult {
  batchId: string;
  itemCount: number;
  /** Товары, пропущенные партией — уже в очереди/обработке другого
   * запуска (см. `create`), не ошибка. */
  skipped: string[];
}

export interface CatalogBatchItemView {
  productItemId: string;
  title: string | null;
  photoUrl: string | null;
  sessionId: string | null;
  status: CatalogBatchItemStatus;
  error: string | null;
}

export interface CatalogBatchStatusView {
  batchId: string;
  projectId: string;
  items: CatalogBatchItemView[];
  summary: {
    pending: number;
    generating: number;
    done: number;
    failed: number;
  };
}

@Injectable()
export class CatalogBatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
  ) {}

  async create(
    userId: string,
    projectId: string,
    dto: { sourceSessionId: string; productItemIds: string[] },
  ): Promise<StartCatalogBatchResult> {
    // Решение владельца продукта: партия доступна только Premium, тем
    // же признаком, что и обычная библиотека разборов.
    await this.plans.assertUser(userId, 'library');

    const source = await this.sessions.getSession(dto.sourceSessionId);
    if (!source || source.userId !== userId || source.projectId !== projectId) {
      throw new NotFoundException(
        `Session ${dto.sourceSessionId} not found in project ${projectId}`,
      );
    }
    if (
      source.status !== SessionStatus.VIDEO_COMPLETE ||
      !source.generatedVideo
    ) {
      throw new BadRequestException(
        'Партия собирается только из уже готового ролика — сначала завершите генерацию для исходного товара.',
      );
    }
    if (!source.librarySourceKey) {
      // Не должно случаться в обычном потоке (каждый завершённый разбор
      // сохраняется в библиотеку один раз на источник, см.
      // library.service.ts) — но кнопка на фронте не должна была это
      // предложить, если всё же произошло, лучше явная ошибка, чем
      // партия без стиля.
      throw new BadRequestException(
        'У исходной сессии нет сохранённого разбора в библиотеке — партия невозможна.',
      );
    }
    const entry = await this.prisma.analysisLibraryEntry.findUnique({
      where: { sourceKey: source.librarySourceKey },
      select: { id: true },
    });
    if (!entry) {
      throw new NotFoundException(
        `Library entry for source ${source.librarySourceKey} not found`,
      );
    }

    const requestedIds = dto.productItemIds.filter(
      (id) => id !== source.productItemId,
    );
    if (requestedIds.length === 0) {
      throw new BadRequestException(
        'Список товаров партии пуст (после исключения самого исходного товара).',
      );
    }

    // Явная аннотация — без сгенерированного под новые модели
    // Prisma-клиента (ограничение песочницы, см. doc/PRODUCT-PROJECT-
    // SPEC.md) весь делегат `productItem` в этом файле выводится как
    // `any` и каскадом даёт implicit-any на параметры колбэков ниже.
    interface ProductItemSlim {
      id: string;
      price: { toString(): string } | number | string | null;
      description: string | null;
      photoUrl: string | null;
    }
    const items: ProductItemSlim[] = await this.prisma.productItem.findMany({
      where: { id: { in: requestedIds }, projectId },
      select: {
        id: true,
        price: true,
        description: true,
        photoUrl: true,
      },
    });
    const foundIds = new Set(items.map((i: ProductItemSlim) => i.id));
    const missing = requestedIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        `Товары не найдены в проекте ${projectId}: ${missing.join(', ')}`,
      );
    }
    // Защитная проверка сверх обычного §7.4 isItemComplete: партия не
    // останавливается на подтверждение по каждому товару (решение
    // владельца продукта), значит она не должна ставить в очередь
    // заведомо провальный товар — у которого нет и фото, isComplete
    // (только цена+описание) этого не проверяет.
    const incomplete = items.filter(
      (i: ProductItemSlim) => !isItemComplete(i) || !i.photoUrl,
    );
    if (incomplete.length > 0) {
      throw new BadRequestException(
        `Не заполнены до конца (нужны фото, цена и описание): ${incomplete
          .map((i: ProductItemSlim) => i.id)
          .join(', ')}`,
      );
    }

    // Товар уже в очереди/обработке какой-то другой партии этого же
    // проекта — не заводим вторую генерацию поверх, просто пропускаем
    // (не ошибка, отражается в skipped). Пятый аудит, Д-1.2: DONE тоже
    // исключаем — иначе перезапуск (повторный вызов create с тем же
    // набором товаров после частичного провала предыдущей партии,
    // штатный способ "повторить" при отсутствии до этапа 74 отдельной
    // ручки) заново заводил бы генерацию для уже готовых товаров и
    // повторно списывал бы Veo за то, что уже отрендерено.
    const busy: { productItemId: string }[] =
      await this.prisma.catalogBatchItem.findMany({
        where: {
          productItemId: { in: requestedIds },
          // Найдено при аудите (ТЗ §13, этап 2 плана §14): без 'BATCH_QUEUED'
          // товар, уже стоящий в очереди на подачу как Grok-пачка, считался
          // бы свободным — вторая параллельная партия могла бы завести для
          // него ещё одну оплаченную генерацию, тот же риск задвоения,
          // которого этот же busy-чек уже избегает для PENDING/GENERATING/DONE.
          status: { in: ['PENDING', 'BATCH_QUEUED', 'GENERATING', 'DONE'] },
        },
        select: { productItemId: true },
      });
    const busyIds = new Set(
      busy.map((b: { productItemId: string }) => b.productItemId),
    );
    const toCreate = requestedIds.filter((id) => !busyIds.has(id));
    if (toCreate.length === 0) {
      throw new BadRequestException(
        'Все выбранные товары уже собираются другой партией или уже готовы — повторять нечего.',
      );
    }

    // Пятый аудит, Д-2.2: проверка "не занят" выше — вне транзакции, и
    // сама по себе не защищает от гонки между ДВУМЯ конкурентными
    // create() с пересекающимся списком товаров (оба читают "свободно"
    // до того, как любой из них вставит свою строку). Serializable —
    // единственный уровень изоляции Postgres, который ловит именно этот
    // паттерн ("прочитать пусто → вставить") через предикатные блокировки
    // (write skew); проигравшая транзакция получает ошибку сериализации
    // (Prisma P2034) и перезапускается ЦЕЛИКОМ ещё раз — при повторном
    // проходе toCreate внутри транзакции пересчитывается заново по уже
    // изменившимся данным, так что после ретрая конфликтующий товар
    // корректно уйдёт либо в новый список занятых, либо (если победила
    // эта транзакция) будет создан как обычно. Без изменений в
    // schema.prisma — обычный, полностью выразимый в Prisma механизм, в
    // отличие от частичного индекса (см. прецедент в миграции
    // 20260908160000_drop_unused_indexes: там от частичного индекса
    // отказались именно потому, что он не выражается в схеме и ломает
    // `migrate diff --exit-code` в CI).
    const MAX_SERIALIZATION_RETRIES = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        const run = await this.prisma.$transaction(
          async (tx) => {
            const stillBusy: { productItemId: string }[] =
              await tx.catalogBatchItem.findMany({
                where: {
                  productItemId: { in: requestedIds },
                  // Найдено при аудите (ТЗ §13, этап 2 плана §14): без 'BATCH_QUEUED'
          // товар, уже стоящий в очереди на подачу как Grok-пачка, считался
          // бы свободным — вторая параллельная партия могла бы завести для
          // него ещё одну оплаченную генерацию, тот же риск задвоения,
          // которого этот же busy-чек уже избегает для PENDING/GENERATING/DONE.
          status: { in: ['PENDING', 'BATCH_QUEUED', 'GENERATING', 'DONE'] },
                },
                select: { productItemId: true },
              });
            const stillBusyIds = new Set(
              stillBusy.map((b: { productItemId: string }) => b.productItemId),
            );
            const finalToCreate = requestedIds.filter(
              (id) => !stillBusyIds.has(id),
            );
            if (finalToCreate.length === 0) {
              throw new BadRequestException(
                'Все выбранные товары уже собираются другой партией или уже готовы — повторять нечего.',
              );
            }
            const created = await tx.catalogBatchRun.create({
              data: {
                projectId,
                userId,
                libraryEntryId: entry.id,
                sourceSessionId: dto.sourceSessionId,
                quality: (source.generatedVideo?.quality ??
                  'fast') as VideoQuality,
                aspectRatio: source.generatedVideo?.aspectRatio ?? null,
                locale: source.locale ?? null,
                // Найдено при аудите (ТЗ §13, этап 2 плана §14): без
                // этих двух полей партия физически не могла стать
                // Grok-партией — схема даёт дефолт 'veo' сама по себе,
                // но ничто в API до этого исправления его не
                // переопределяло, то есть весь Grok-путь воркера был
                // недостижим через реальный вызов.
                provider: dto.provider ?? 'veo',
                resolution: dto.resolution ?? null,
              },
            });
            await tx.catalogBatchItem.createMany({
              data: finalToCreate.map((productItemId) => ({
                batchId: created.id,
                productItemId,
              })),
            });
            // Событие воронки (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md §3.2) —
            // первое событие каждой созданной строки, fromStage: null.
            // `createMany` не возвращает вставленные id (обычный Prisma,
            // без `createManyAndReturn`) — id читаем отдельным запросом по
            // только что созданному `created.id`, коллизий с другими
            // партиями быть не может (только что сгенерированный cuid).
            const createdRows: { id: string; productItemId: string }[] =
              await tx.catalogBatchItem.findMany({
                where: { batchId: created.id },
                select: { id: true, productItemId: true },
              });
            await Promise.all(
              createdRows.map((r) =>
                logWorkflowStage(
                  tx,
                  WorkflowKind.CATALOG_BATCH_ITEM,
                  r.id,
                  null,
                  'PENDING',
                ),
              ),
            );
            return {
              batchId: created.id,
              itemCount: finalToCreate.length,
              skipped: requestedIds.filter((id) => stillBusyIds.has(id)),
            };
          },
          { isolationLevel: 'Serializable' },
        );
        return run;
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        // P2034 — Prisma-код ошибки сериализации/дедлока; только он
        // достоин повтора, остальное (реальный сбой БД и т.п.) должно
        // упасть как обычно.
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== 'P2034') throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async getStatus(
    userId: string,
    projectId: string,
    batchId: string,
  ): Promise<CatalogBatchStatusView> {
    const run = await this.prisma.catalogBatchRun.findUnique({
      where: { id: batchId },
      include: {
        items: {
          include: { productItem: { select: { title: true, photoUrl: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!run || run.userId !== userId || run.projectId !== projectId) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }

    const views: CatalogBatchItemView[] = [];
    for (const item of run.items) {
      let status: CatalogBatchItemStatus = item.status;
      let error = item.error;
      // Живое чтение — сам рендер отслеживается штатно через
      // session.data.generatedVideo, воркер сюда за этим не возвращается
      // (см. комментарий у CatalogBatchItem в schema.prisma). Синхронизация
      // здесь — оппортунистическая: если кто-то открыл экран прогресса,
      // заодно поправим и сводку для админки, но она не обязана быть
      // актуальной, если экран никто не открывал (тот же уровень
      // строгости, что у кеша отчёта расходов, §30.2 SPEC).
      if (status === 'GENERATING' && item.sessionId) {
        const session = await this.sessions.getSession(item.sessionId);
        const video = session?.generatedVideo;
        if (video?.status === GenerationStatus.COMPLETE) {
          status = 'DONE';
          await this.prisma.catalogBatchItem
            .update({ where: { id: item.id }, data: { status: 'DONE' } })
            .catch(() => undefined);
          await logWorkflowStage(
            this.prisma,
            WorkflowKind.CATALOG_BATCH_ITEM,
            item.id,
            'GENERATING',
            'DONE',
          );
        } else if (video?.status === GenerationStatus.FAILED) {
          status = 'FAILED';
          error = video.error?.message ?? 'Рендер не удался';
          await this.prisma.catalogBatchItem
            .update({
              where: { id: item.id },
              data: { status: 'FAILED', error },
            })
            .catch(() => undefined);
          await logWorkflowStage(
            this.prisma,
            WorkflowKind.CATALOG_BATCH_ITEM,
            item.id,
            'GENERATING',
            'FAILED',
          );
        }
      }
      views.push({
        productItemId: item.productItemId,
        title: item.productItem.title,
        photoUrl: item.productItem.photoUrl,
        sessionId: item.sessionId,
        status,
        error,
      });
    }

    // Найдено при аудите (ТЗ §13, этап 2 плана §14): `BATCH_QUEUED`
    // (Grok-строки, ждущие подачи как одна пачка) не входил ни в одну
    // из четырёх категорий — такие строки были невидимы в сводке,
    // summary не досчитывался бы до `views.length`. С точки зрения
    // пользователя «ждёт подачи в пачку» — та же категория, что
    // «ждёт своей очереди» (PENDING), поэтому считаем вместе.
    const summary = {
      pending: views.filter(
        (v) => v.status === 'PENDING' || v.status === 'BATCH_QUEUED',
      ).length,
      generating: views.filter((v) => v.status === 'GENERATING').length,
      done: views.filter((v) => v.status === 'DONE').length,
      failed: views.filter((v) => v.status === 'FAILED').length,
    };

    return { batchId: run.id, projectId: run.projectId, items: views, summary };
  }

  /**
   * Точечный повтор (пятый аудит, Д-1.3): до этого метода единственный
   * способ "повторить" провалившиеся строки партии — вызвать `create()`
   * заново со всем исходным списком товаров вручную, что пересоздавало
   * partition целиком. `productItemId` не передан — повторяем ВСЕ
   * провалившиеся строки ЭТОЙ партии; передан — только одну.
   *
   * Только строки в статусе FAILED — PENDING/GENERATING трогать нельзя
   * (сбросить их в PENDING означало бы потерять claim/попытку, которую
   * воркер уже мог держать), а DONE трогать не нужно и опасно (см.
   * Д-1.2 в `create()` — те же деньги, тот же риск задвоить оплату).
   * `sessionId` НЕ сбрасываем: если строка успела завести дочернюю
   * сессию до отказа, воркер (`processOne`) сам резюмирует обработку с
   * той точки, до которой сессия реально дошла (см. Д-2.5) — заводить
   * вторую сессию на тот же товар незачем.
   */
  async retry(
    userId: string,
    projectId: string,
    batchId: string,
    productItemId?: string,
  ): Promise<{ retried: number; skippedBusy: string[] }> {
    const run = await this.prisma.catalogBatchRun.findUnique({
      where: { id: batchId },
      select: { id: true, userId: true, projectId: true },
    });
    if (!run || run.userId !== userId || run.projectId !== projectId) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }

    // Е-2.4 шестого аудита (рецидив класса Д-2.2 в новом коде этапа 74):
    // между провалом строки ЗДЕСЬ и вызовом `retry()` `productItemId` мог
    // успеть попасть в ДРУГУЮ активную партию — `create()` пропускает
    // FAILED-товары как свободные именно затем, чтобы можно было завести
    // новую партию для провалившегося товара. Повторный запуск именно
    // этой строки создал бы вторую параллельную оплаченную генерацию
    // одного и того же товара. Serializable + ретрай на P2034 — тот же
    // приём, что уже защищает `create()` от точно такой же гонки «прочитать
    // свободно → записать», см. доккомментарий там.
    const MAX_SERIALIZATION_RETRIES = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const candidates: { id: string; productItemId: string }[] =
              await tx.catalogBatchItem.findMany({
                where: {
                  batchId,
                  status: 'FAILED',
                  ...(productItemId ? { productItemId } : {}),
                },
                select: { id: true, productItemId: true },
              });
            if (candidates.length === 0) {
              throw new BadRequestException(
                productItemId
                  ? 'Эта строка партии не в статусе FAILED — повтор не нужен.'
                  : 'В партии нет строк со статусом FAILED — повторять нечего.',
              );
            }

            const busy: { productItemId: string }[] =
              await tx.catalogBatchItem.findMany({
                where: {
                  batchId: { not: batchId },
                  productItemId: {
                    in: candidates.map((c) => c.productItemId),
                  },
                  // Найдено при аудите (ТЗ §13, этап 2 плана §14): без 'BATCH_QUEUED'
          // товар, уже стоящий в очереди на подачу как Grok-пачка, считался
          // бы свободным — вторая параллельная партия могла бы завести для
          // него ещё одну оплаченную генерацию, тот же риск задвоения,
          // которого этот же busy-чек уже избегает для PENDING/GENERATING/DONE.
          status: { in: ['PENDING', 'BATCH_QUEUED', 'GENERATING', 'DONE'] },
                },
                select: { productItemId: true },
              });
            const busyIds = new Set(busy.map((b) => b.productItemId));
            const toRetry = candidates.filter(
              (c) => !busyIds.has(c.productItemId),
            );
            const skippedBusy = candidates
              .filter((c) => busyIds.has(c.productItemId))
              .map((c) => c.productItemId);

            if (toRetry.length === 0) {
              throw new BadRequestException(
                productItemId
                  ? 'Этот товар уже собирается другой активной партией — повторять здесь нечего.'
                  : 'Все провалившиеся товары уже собираются другими активными партиями — повторять здесь нечего.',
              );
            }

            await tx.catalogBatchItem.updateMany({
              where: { id: { in: toRetry.map((c) => c.id) } },
              data: {
                status: 'PENDING',
                error: null,
                attempts: 0,
                nextAttemptAt: null,
                lockedUntil: null,
              },
            });
            // Событие воронки — `toRetry` уже отфильтрован по status:
            // 'FAILED' (см. candidates выше), fromStage всегда 'FAILED'.
            await Promise.all(
              toRetry.map((c) =>
                logWorkflowStage(
                  tx,
                  WorkflowKind.CATALOG_BATCH_ITEM,
                  c.id,
                  'FAILED',
                  'PENDING',
                ),
              ),
            );
            return { retried: toRetry.length, skippedBusy };
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        // P2034 — сериализационный конфликт, тот же повод для повтора
        // ЦЕЛИКОМ, что и в `create()`.
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== 'P2034') throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}
