/**
 * AdminMarketingService — история выпусков рекламной рассылки в админке
 * (ТЗ §42, этап 63, doc/TODO.md §III.4). Read-only, по образцу
 * `AdminBillingService`: свой список, но без единственного действия
 * оператора (refund) — здесь оператору нечего нажимать, отбор контента
 * для выпуска полностью автоматический (см. открытый вопрос 42.2 в
 * PRODUCT-PROJECT-SPEC.md §42).
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AdminBroadcastRow {
  id: string;
  createdAt: Date;
  featuredCount: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  total: number;
}

export interface AdminBroadcastListResult {
  items: AdminBroadcastRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Сколько пользователей сейчас подписаны (marketingConsentAt IS NOT
   * NULL AND marketingConsentRevokedAt IS NULL) — не свойство ни одного
   * конкретного выпуска, но то самое число, ради которого открывают эту
   * страницу. */
  activeSubscribers: number;
}

interface BroadcastListRow {
  id: string;
  createdAt: Date;
  sharedVideoPageIds: string[];
}

@Injectable()
export class AdminMarketingService {
  constructor(private readonly prisma: PrismaService) {}

  async listBroadcasts(opts: {
    page: number;
    pageSize: number;
  }): Promise<AdminBroadcastListResult> {
    const [rows, total, activeSubscribers] = await Promise.all([
      this.prisma.marketingBroadcast.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
        select: { id: true, createdAt: true, sharedVideoPageIds: true },
      }) as Promise<BroadcastListRow[]>,
      this.prisma.marketingBroadcast.count(),
      this.prisma.user.count({
        where: {
          marketingConsentAt: { not: null },
          marketingConsentRevokedAt: null,
        },
      }),
    ]);

    // По группировке на каждый выпуск отдельно, а не одним общим
    // groupBy: выпусков на странице — не больше pageSize (обычно 20),
    // а сама сводка sent/failed/skipped/pending — то немногое, ради
    // чего вообще открывают эту страницу.
    const items = await Promise.all(
      rows.map(async (b: BroadcastListRow) => {
        const grouped = (await this.prisma.marketingDelivery.groupBy({
          by: ['status'] as const,
          where: { broadcastId: b.id },
          _count: { _all: true },
        })) as Array<{ status: string; _count: { _all: number } }>;
        const counts: Record<string, number> = {};
        for (const g of grouped) counts[g.status] = g._count._all;
        const sent = counts.SENT ?? 0;
        const failed = counts.FAILED ?? 0;
        const skipped = counts.SKIPPED ?? 0;
        const pending = counts.PENDING ?? 0;
        return {
          id: b.id,
          createdAt: b.createdAt,
          featuredCount: b.sharedVideoPageIds.length,
          sent,
          failed,
          skipped,
          pending,
          total: sent + failed + skipped + pending,
        };
      }),
    );

    return {
      items,
      total,
      page: opts.page,
      pageSize: opts.pageSize,
      activeSubscribers,
    };
  }
}
