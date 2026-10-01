/**
 * Настоящий стек обхода (robots → sitemap → fetcher → SiteCrawlService)
 * поверх локального https-стенда и тестовой базы. Без пауз вежливости и
 * без отложенных повторов — иначе тест ждал бы секундами.
 */

import type { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { SiteCrawlService } from '../crawl.service';
import { PublicPageFetcher } from '../page-fetcher';
import { RobotsService } from '../robots';
import { SitemapService } from '../sitemap';
import type { CrawlCacheDb } from '../types';
import type { LocalSites } from './local-sites.testing';

export interface CrawlStack {
  robots: RobotsService;
  sitemaps: SitemapService;
  fetcher: PublicPageFetcher;
  crawl: SiteCrawlService;
}

/**
 * `accounts` — массив кабинетов набора (тот же объект, набор дописывает в
 * него): тик берёт только их прогоны.
 */
export function crawlStack(
  prisma: PrismaService,
  net: LocalSites,
  accounts: string[],
): CrawlStack {
  const deps = net.deps();
  const robots = new RobotsService(deps);
  const sitemaps = new SitemapService(deps);
  const fetcher = new PublicPageFetcher(robots, deps);
  const crawl = new SiteCrawlService(
    new SitesDb(prisma),
    robots,
    sitemaps,
    fetcher,
  );
  crawl.minDelayMsPerHost = 0;
  crawl.retryBackoffMs = 0;
  crawl.onlyAccountIds = accounts;
  return { robots, sitemaps, fetcher, crawl };
}

/** Тики до завершения всех прогонов (с предохранителем). */
export async function tickUntilIdle(
  crawl: SiteCrawlService,
  maxTicks = 50,
): Promise<number> {
  for (let i = 0; i < maxTicks; i++) {
    const r = await crawl.tick(60_000);
    if (r.runsTouched === 0) return i;
  }
  throw new Error('обход не завершился за отведённые тики');
}

/** Кэш robots/opt-out в памяти — для тестов без базы (мета-тест SSRF). */
export function memoryCacheDb(optedOut: string[] = []): CrawlCacheDb {
  const robots = new Map<string, Record<string, unknown>>();
  const db = {
    siteCrawlRobots: {
      findUnique: async ({ where }: { where: { origin: string } }) =>
        robots.get(where.origin) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { origin: string };
        create: Record<string, unknown>;
      }) => {
        robots.set(where.origin, create);
        return create;
      },
    },
    siteOptOutDomain: {
      findFirst: async ({ where }: { where: { domain: { in: string[] } } }) => {
        const hit = where.domain.in.find((d) => optedOut.includes(d));
        return hit ? { domain: hit } : null;
      },
    },
  };
  return db as unknown as CrawlCacheDb;
}
