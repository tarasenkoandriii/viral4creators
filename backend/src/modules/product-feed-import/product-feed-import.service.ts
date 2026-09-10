/**
 * ProductFeedImportService — импорт товарного фида по ссылке (TODO
 * §Уровень 2 п.8, этап 68, doc/PRODUCT-PROJECT-SPEC.md §47). Продавец с
 * сотнями SKU физически не может завести их вручную — вставляет ссылку
 * на свой YML/CSV-фид (Rozetka/Prom/Shopify-плагин/WooCommerce-
 * экспортёр/«Мой склад»/ручная выгрузка), и каталог наполняется сам.
 * Разовый снимок, не периодическая синхронизация (решено с владельцем
 * продукта) — один запуск = одна попытка импорта одной ссылки.
 *
 * Как и CatalogBatchService (этап 65), здесь только создание запуска и
 * чтение его статуса — синхронно и быстро (без внешних вызовов).
 * Скачивание чужого URL неизвестного размера и разбор до сотен строк —
 * та работа, которая не должна блокировать HTTP-ответ пользователю; она
 * идёт в ProductFeedImportWorkerService по крону.
 *
 * Доступ — Premium, тот же признак 'library', что у пакетной генерации
 * по каталогу: та же аудитория (продавец с каталогом, а не разовый
 * одиночный проект), то же решение владельца продукта — не заводить для
 * соседней фичи отдельный признак плана.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import {
  assertPubliclyRoutableUrl,
  UnsafeExternalUrlError,
  UNSAFE_EXTERNAL_URL_MESSAGE,
} from '../../common/external-url-guard';
import { StartFeedImportRequestDto } from './dto/start-feed-import.dto';
import {
  ProductFeedImportItemStatus,
  ProductFeedImportRunStatus,
} from '@prisma/client';

export interface StartFeedImportResult {
  runId: string;
}

export interface FeedImportItemView {
  rowIndex: number;
  title: string | null;
  status: ProductFeedImportItemStatus;
  reason: string | null;
  productItemId: string | null;
}

export interface FeedImportRunSummary {
  runId: string;
  projectId: string;
  sourceUrl: string;
  status: ProductFeedImportRunStatus;
  error: string | null;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: Date;
}

export interface FeedImportStatusView extends FeedImportRunSummary {
  items: FeedImportItemView[];
}

@Injectable()
export class ProductFeedImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  async create(
    userId: string,
    projectId: string,
    dto: StartFeedImportRequestDto,
  ): Promise<StartFeedImportResult> {
    // Решение владельца продукта: та же граница плана, что и у пакетной
    // генерации по каталогу — обе фичи существуют только для продавца с
    // каталогом из многих товаров.
    await this.plans.assertUser(userId, 'library');

    const project: { id: string; type: string } | null =
      await this.prisma.project.findFirst({
        where: { id: projectId, userId },
        select: { id: true, type: true },
      });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    if (project.type !== 'LINE') {
      throw new BadRequestException(
        'Импорт фида доступен только для проекта-линейки (несколько товаров) — сначала переключите тип проекта.',
      );
    }

    // Быстрый отказ на явно опасный/недоступный адрес ДО создания
    // запуска — воркер повторит ту же проверку перед самим скачиванием
    // (см. product-feed-import-worker.service.ts и обоснование двойной
    // проверки в external-url-guard.ts).
    try {
      await assertPubliclyRoutableUrl(dto.sourceUrl);
    } catch (e) {
      if (e instanceof UnsafeExternalUrlError) {
        throw new BadRequestException(UNSAFE_EXTERNAL_URL_MESSAGE);
      }
      throw e;
    }

    const run = await this.prisma.productFeedImportRun.create({
      data: { projectId, userId, sourceUrl: dto.sourceUrl },
    });
    return { runId: run.id };
  }

  /**
   * Полный статус одного запуска — со всеми строками (экран прогресса).
   * Счётчики (`totalRows`/`importedCount`/…) — не живой пересчёт, а то,
   * что воркер уже накопил в самой строке запуска: в отличие от
   * CatalogBatchService.getStatus, здесь нет отдельного асинхронного
   * состояния вроде Session, за которым нужно было бы «доглядывать»
   * при каждом опросе — воркер обновляет счётчики сам по ходу тика.
   */
  async getStatus(
    userId: string,
    projectId: string,
    runId: string,
  ): Promise<FeedImportStatusView> {
    const run = await this.findOwnRun(userId, projectId, runId, true);
    return this.toStatusView(run);
  }

  async list(
    userId: string,
    projectId: string,
  ): Promise<FeedImportRunSummary[]> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const runs = await this.prisma.productFeedImportRun.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'desc' },
    });
    return runs.map((run: RunRow) => this.toSummary(run));
  }

  private async findOwnRun(
    userId: string,
    projectId: string,
    runId: string,
    withItems: boolean,
  ): Promise<RunRowWithItems> {
    const run: RunRowWithItems | null =
      await this.prisma.productFeedImportRun.findUnique({
        where: { id: runId },
        include: withItems
          ? { items: { orderBy: { rowIndex: 'asc' } } }
          : undefined,
      });
    if (!run || run.userId !== userId || run.projectId !== projectId) {
      throw new NotFoundException(`Feed import ${runId} not found`);
    }
    return run;
  }

  private toSummary(run: RunRow): FeedImportRunSummary {
    return {
      runId: run.id,
      projectId: run.projectId,
      sourceUrl: run.sourceUrl,
      status: run.status,
      error: run.error,
      totalRows: run.totalRows,
      importedCount: run.importedCount,
      skippedCount: run.skippedCount,
      failedCount: run.failedCount,
      createdAt: run.createdAt,
    };
  }

  private toStatusView(run: RunRowWithItems): FeedImportStatusView {
    return {
      ...this.toSummary(run),
      items: (run.items ?? []).map((i: ItemRow) => ({
        rowIndex: i.rowIndex,
        title: i.title,
        status: i.status,
        reason: i.reason,
        productItemId: i.productItemId,
      })),
    };
  }
}

// Явные структурные типы вместо сгенерированного Prisma-клиента —
// ограничение песочницы (см. doc/PRODUCT-PROJECT-SPEC.md), тот же
// приём, что в catalog-batch.service.ts.
interface RunRow {
  id: string;
  projectId: string;
  userId: string;
  sourceUrl: string;
  status: ProductFeedImportRunStatus;
  error: string | null;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: Date;
}

interface ItemRow {
  rowIndex: number;
  title: string | null;
  status: ProductFeedImportItemStatus;
  reason: string | null;
  productItemId: string | null;
}

interface RunRowWithItems extends RunRow {
  items?: ItemRow[];
}
