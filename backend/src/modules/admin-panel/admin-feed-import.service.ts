/**
 * AdminFeedImportService — история запусков импорта товарного фида по
 * ссылке в админке (TODO §Уровень 2 п.8, этап 68, doc/PRODUCT-PROJECT-
 * SPEC.md §47). Read-only, по образцу `AdminCatalogBatchService`/
 * `AdminAbTestService`: запуск либо идёт, либо завершился, вмешиваться в
 * него оператору нечем.
 *
 * В отличие от `AdminCatalogBatchService.listBatches`, здесь не нужен
 * отдельный `groupBy` по строкам на каждый запуск — сводка
 * (`totalRows`/`importedCount`/`skippedCount`/`failedCount`) уже
 * накоплена самим воркером прямо на строке `ProductFeedImportRun` (см.
 * `product-feed-import.service.ts`), поэтому достаточно одного простого
 * `findMany`.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductFeedImportRunStatus } from '@prisma/client';

export interface AdminFeedImportRow {
  id: string;
  createdAt: Date;
  projectId: string;
  userId: string;
  sourceUrl: string;
  status: ProductFeedImportRunStatus;
  error: string | null;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface AdminFeedImportListResult {
  items: AdminFeedImportRow[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class AdminFeedImportService {
  constructor(private readonly prisma: PrismaService) {}

  async listRuns(opts: {
    page: number;
    pageSize: number;
  }): Promise<AdminFeedImportListResult> {
    const [rows, total] = await Promise.all([
      this.prisma.productFeedImportRun.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
        select: {
          id: true,
          createdAt: true,
          projectId: true,
          userId: true,
          sourceUrl: true,
          status: true,
          error: true,
          totalRows: true,
          importedCount: true,
          skippedCount: true,
          failedCount: true,
        },
      }) as Promise<AdminFeedImportRow[]>,
      this.prisma.productFeedImportRun.count(),
    ]);

    return { items: rows, total, page: opts.page, pageSize: opts.pageSize };
  }
}
