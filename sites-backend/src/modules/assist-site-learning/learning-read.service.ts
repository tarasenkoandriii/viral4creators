/**
 * Чтение очереди для других модулей — L. Экран «Темы и пробелы» (A,
 * stats/topics) и утренняя сводка/отчёт недели (A, assist-digest) берут
 * факты отсюда, а не из таблиц очереди напрямую. Основная роль, только
 * агрегаты и подписи кластеров (маскированные), без посетителей.
 *
 * Уточнения (L): тема — кластер, у которого в периоде [from, to) были
 * элементы; `size` — элементов в периоде, `distinctVisitors` — кластера
 * целиком (как в очереди), порядок — по числу элементов в периоде.
 * `evalDeferred` — с `since` был отложенный (бюджет) плановый прогон.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { isDeferred } from './quality.service';

export interface TopicFact {
  clusterId: string;
  label: string;
  kind: string;
  distinctVisitors: number;
  size: number;
  status: 'open' | 'resolved' | 'ignored';
  /** Диалоги кластера в периоде (для конверсии — считает A по своим событиям). */
  conversationIds: string[];
}

export interface LearningDigestFacts {
  newClusters: number;
  openClusters: number;
  goldenNeedsReview: number;
  goldenConflicts: number;
  candidates: number;
  evalDeferred: boolean;
}

@Injectable()
export class LearningReadApi {
  constructor(private readonly sitesDb: SitesDb) {}

  async topics(p: {
    accountId: string;
    siteId: string;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<TopicFact[]> {
    const t = this.sitesDb.forAccount(p.accountId);
    const limit = Math.max(1, Math.min(200, Math.floor(p.limit || 20)));
    const items = await t.assistSiteLearningItem.findMany({
      where: {
        siteId: p.siteId,
        clusterId: { not: null },
        createdAt: { gte: p.from, lt: p.to },
      },
      select: { clusterId: true, conversationId: true },
      take: 20_000,
    });
    const byCluster = new Map<string, { size: number; convs: Set<string> }>();
    for (const i of items) {
      const k = i.clusterId as string;
      const e = byCluster.get(k) ?? { size: 0, convs: new Set<string>() };
      e.size++;
      if (i.conversationId) e.convs.add(i.conversationId);
      byCluster.set(k, e);
    }
    if (!byCluster.size) return [];
    const clusters = await t.assistSiteLearningCluster.findMany({
      where: { siteId: p.siteId, id: { in: [...byCluster.keys()] } },
      select: {
        id: true,
        label: true,
        kind: true,
        distinctVisitors: true,
        status: true,
      },
    });
    return clusters
      .map((c) => {
        const e = byCluster.get(c.id)!;
        return {
          clusterId: c.id,
          label: c.label,
          kind: c.kind,
          distinctVisitors: c.distinctVisitors,
          size: e.size,
          status: (c.status === 'resolved' || c.status === 'ignored'
            ? c.status
            : 'open') as TopicFact['status'],
          conversationIds: [...e.convs].sort(),
        };
      })
      .sort(
        (a, b) =>
          b.size - a.size ||
          b.distinctVisitors - a.distinctVisitors ||
          (a.clusterId < b.clusterId ? -1 : 1),
      )
      .slice(0, limit);
  }

  async digestFacts(p: {
    accountId: string;
    siteId: string;
    since: Date;
  }): Promise<LearningDigestFacts> {
    const t = this.sitesDb.forAccount(p.accountId);
    const where = { siteId: p.siteId };
    const [
      newClusters,
      openClusters,
      goldenNeedsReview,
      goldenConflicts,
      candidates,
      runs,
    ] = await Promise.all([
      t.assistSiteLearningCluster.count({
        where: { ...where, createdAt: { gte: p.since } },
      }),
      t.assistSiteLearningCluster.count({
        where: { ...where, status: 'open' },
      }),
      t.assistSiteFaq.count({ where: { ...where, status: 'needs_review' } }),
      t.assistSiteFaq.count({
        where: {
          ...where,
          status: 'needs_review',
          conflictNote: { not: null },
        },
      }),
      t.assistSiteLearningItem.count({
        where: {
          ...where,
          kind: 'operator_fix',
          status: { in: ['new', 'proposed'] },
        },
      }),
      t.assistSiteEvalRun.findMany({
        where: { ...where, kind: 'scheduled', createdAt: { gte: p.since } },
        select: { report: true },
        take: 50,
      }),
    ]);
    return {
      newClusters,
      openClusters,
      goldenNeedsReview,
      goldenConflicts,
      candidates,
      evalDeferred: runs.some((r) => isDeferred(r.report)),
    };
  }
}
