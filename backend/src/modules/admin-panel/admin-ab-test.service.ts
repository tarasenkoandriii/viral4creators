/**
 * AdminAbTestService — история запусков A/B-вариантов одного ролика в
 * админке (TODO §III.6, этап 66). Read-only, по образцу
 * `AdminCatalogBatchService` (этап 65): своя история со сводкой
 * статусов на каждый запуск, без единственного действия оператора —
 * запуск либо идёт, либо завершился, вмешиваться в него оператору
 * нечем (та же логика, что развела `AdminMarketingService` от
 * `AdminBillingService`, у которой действие — refund — есть).
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AdminAbTestRow {
  id: string;
  createdAt: Date;
  projectId: string;
  userId: string;
  sourceSessionId: string;
  pending: number;
  generating: number;
  done: number;
  failed: number;
  total: number;
}

export interface AdminAbTestListResult {
  items: AdminAbTestRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface RunListRow {
  id: string;
  createdAt: Date;
  projectId: string;
  userId: string;
  sourceSessionId: string;
}

@Injectable()
export class AdminAbTestService {
  constructor(private readonly prisma: PrismaService) {}

  async listRuns(opts: {
    page: number;
    pageSize: number;
  }): Promise<AdminAbTestListResult> {
    const [rows, total] = await Promise.all([
      this.prisma.abTestRun.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
        select: {
          id: true,
          createdAt: true,
          projectId: true,
          userId: true,
          sourceSessionId: true,
        },
      }) as Promise<RunListRow[]>,
      this.prisma.abTestRun.count(),
    ]);

    // По группировке на каждый запуск отдельно, а не одним общим
    // groupBy — запусков на странице не больше pageSize (обычно 20), а
    // строк внутри каждого — всего 3 (фиксировано, решение владельца
    // продукта) — тот же приём, что в AdminCatalogBatchService.listBatches.
    //
    // Пятый аудит, Д-4.5 — тот же пересмотр и тот же вывод, что у
    // AdminCatalogBatchService.listBatches (см. её комментарий): осознанно
    // оставлено как есть на этапе 74, здесь даже дешевле (строк внутри
    // запуска фиксировано 3, не переменное число товаров партии).
    const items = await Promise.all(
      rows.map(async (r: RunListRow) => {
        // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297,
        // #6494): `by` вместе с `where` не резолвится компилятором даже
        // с `as const` — внутренний тип части перегрузок требует, чтобы
        // объект аргумента ОДНОВРЕМЕННО был массивом (отсюда "missing
        // length, pop, push..." в реальной ошибке tsc на Vercel). `as
        // any` на аргументе — задокументированный обходной путь; форма
        // РЕЗУЛЬТАТА по-прежнему проверяется явным касом ниже.
        const grouped = (await this.prisma.abTestVariant.groupBy({
          by: ['status'] as const,
          where: { runId: r.id },
          _count: { _all: true },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)) as Array<{ status: string; _count: { _all: number } }>;
        const counts: Record<string, number> = {};
        for (const g of grouped) counts[g.status] = g._count._all;
        const pending = counts.PENDING ?? 0;
        const generating = counts.GENERATING ?? 0;
        const done = counts.DONE ?? 0;
        const failed = counts.FAILED ?? 0;
        return {
          id: r.id,
          createdAt: r.createdAt,
          projectId: r.projectId,
          userId: r.userId,
          sourceSessionId: r.sourceSessionId,
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
