/**
 * AdminCatalogBatchService — история партий пакетной генерации по
 * каталогу в админке (ТЗ §44, этап 65, doc/TODO.md §III.5). Read-only,
 * по образцу `AdminMarketingService` (этап 63): своя история со сводкой
 * статусов на каждый запуск, но без единственного действия оператора —
 * партия либо идёт, либо завершилась, вмешиваться в неё оператору
 * нечем (та же логика, что развела `AdminMarketingService` от
 * `AdminBillingService`, у которой действие — refund — есть).
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AdminCatalogBatchRow {
  id: string;
  createdAt: Date;
  projectId: string;
  userId: string;
  pending: number;
  generating: number;
  done: number;
  failed: number;
  total: number;
}

export interface AdminCatalogBatchListResult {
  items: AdminCatalogBatchRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface BatchListRow {
  id: string;
  createdAt: Date;
  projectId: string;
  userId: string;
}

@Injectable()
export class AdminCatalogBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async listBatches(opts: {
    page: number;
    pageSize: number;
  }): Promise<AdminCatalogBatchListResult> {
    const [rows, total] = await Promise.all([
      this.prisma.catalogBatchRun.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
        select: { id: true, createdAt: true, projectId: true, userId: true },
      }) as Promise<BatchListRow[]>,
      this.prisma.catalogBatchRun.count(),
    ]);

    // По группировке на каждую партию отдельно, а не одним общим
    // groupBy — партий на странице не больше pageSize (обычно 20), тот
    // же приём, что в AdminMarketingService.listBroadcasts.
    //
    // Пятый аудит, Д-4.5: N+1 по числу запросов (параллельный, не
    // последовательный) — пересмотрено на этапе 74, решение оставлено
    // осознанно. Составную нагрузку нескольких одновременных операторов
    // никто не измерял, но при `pageSize` (обычно 20) и Premium-only
    // масштабе продукта параллельный веер из 20 быстрых `groupBy` не
    // входит в число реальных проблем сегодня. Денормализовать сводку на
    // строку запуска, как у `ProductFeedImportRun`
    // (`AdminFeedImportService`), можно — но это отдельная правка, а не
    // латание находки на живую без повода.
    const items = await Promise.all(
      rows.map(async (b: BatchListRow) => {
        const grouped = (await this.prisma.catalogBatchItem.groupBy({
          by: ['status'],
          where: { batchId: b.id },
          _count: { _all: true },
        })) as Array<{ status: string; _count: { _all: number } }>;
        const counts: Record<string, number> = {};
        for (const g of grouped) counts[g.status] = g._count._all;
        const pending = counts.PENDING ?? 0;
        const generating = counts.GENERATING ?? 0;
        const done = counts.DONE ?? 0;
        const failed = counts.FAILED ?? 0;
        return {
          id: b.id,
          createdAt: b.createdAt,
          projectId: b.projectId,
          userId: b.userId,
          pending,
          generating,
          done,
          failed,
          total: pending + generating + done + failed,
        };
      }),
    );

    return { items, total, page: opts.page, pageSize: opts.pageSize };
  }
}
