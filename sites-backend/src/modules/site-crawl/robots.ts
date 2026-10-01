/**
 * robots.txt — K1. Пакет `robots-parser`; группа нашего UA
 * (`CRAWLER_ROBOTS_TOKEN` из src/brand.ts), иначе `*`. Кэш — `site_crawl_robots`
 * по origin на 24 ч (CRAWL_DEFAULTS.robotsTtlMs). 4xx → всё разрешено
 * (как у поисковиков: файла нет — правил нет), 5xx/таймаут/SSRF → всё
 * запрещено до следующей попытки (вежливость к упавшему сайту; повтор —
 * через `ROBOTS_ERROR_TTL_MS`, а не через сутки). Запрос robots — тоже
 * через pinnedFetch: robots.txt, редиректящий на 169.254.169.254, — тот
 * же SSRF.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as robotsParserModule from 'robots-parser';
import { CRAWLER_ROBOTS_TOKEN, CRAWLER_USER_AGENT } from '../../brand';
import { CRAWL_DEFAULTS } from '../../config/assist-defaults';
import {
  PINNED_HTTP_DEPS,
  PinnedHttpDeps,
  pinnedFetch,
} from './net/pinned-fetch';
import type { CrawlCacheDb, RobotsRules } from './types';

interface RobotsTxt {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
/** Пакет — CommonJS `module.exports = function` (без esModuleInterop). */
const robotsParser = robotsParserModule as unknown as (
  url: string,
  contents: string,
) => RobotsTxt;

/** Сбой robots (5xx/сеть) — повторить не раньше, чем через… */
export const ROBOTS_ERROR_TTL_MS = 30 * 60 * 1000;
/** Crawl-delay больше — не ждём между запросами дольше этого. */
const MAX_CRAWL_DELAY_MS = 30_000;

interface RobotsSnapshot {
  origin: string;
  httpStatus: number | null;
  body: string | null;
}

/** Решение по снимку robots — чистая функция (её же читает кэш). */
export function rulesFromSnapshot(s: RobotsSnapshot): RobotsRules {
  const sameOrigin = (url: string): boolean => {
    try {
      return new URL(url).origin === s.origin;
    } catch {
      return false;
    }
  };
  const status = s.httpStatus;
  if (status === null || status >= 500 || status === 429) {
    return { isAllowed: () => false, crawlDelayMs: null, sitemaps: [] };
  }
  if (status >= 300 || s.body === null) {
    // 4xx (и 3xx, который не довёл до файла) — правил нет, всё разрешено.
    return { isAllowed: sameOrigin, crawlDelayMs: null, sitemaps: [] };
  }
  const robots = robotsParser(`${s.origin}/robots.txt`, s.body);
  const delay = robots.getCrawlDelay(CRAWLER_ROBOTS_TOKEN);
  return {
    // undefined у пакета = «URL другого origin» → не наш файл, не разрешаем.
    isAllowed: (url) =>
      sameOrigin(url) && robots.isAllowed(url, CRAWLER_ROBOTS_TOKEN) === true,
    crawlDelayMs:
      typeof delay === 'number' && delay > 0
        ? Math.min(delay * 1000, MAX_CRAWL_DELAY_MS)
        : null,
    sitemaps: robots
      .getSitemaps()
      .filter((u) => /^https:\/\//i.test(u))
      .slice(0, CRAWL_DEFAULTS.maxSitemaps),
  };
}

@Injectable()
export class RobotsService {
  private readonly logger = new Logger(RobotsService.name);

  constructor(
    @Optional()
    @Inject(PINNED_HTTP_DEPS)
    private readonly net: Partial<PinnedHttpDeps> = {},
  ) {}

  async rulesFor(origin: string, db: CrawlCacheDb): Promise<RobotsRules> {
    const key = new URL(origin).origin;
    const now = Date.now();
    const cached = await db.siteCrawlRobots
      .findUnique({ where: { origin: key } })
      .catch(() => null);
    if (cached && cached.expiresAt.getTime() > now) {
      return rulesFromSnapshot({
        origin: key,
        httpStatus: cached.httpStatus,
        body: cached.body,
      });
    }

    const snap = await this.fetchSnapshot(key);
    const rules = rulesFromSnapshot(snap);
    const failed = snap.httpStatus === null || snap.httpStatus >= 500;
    const expiresAt = new Date(
      now + (failed ? ROBOTS_ERROR_TTL_MS : CRAWL_DEFAULTS.robotsTtlMs),
    );
    const data = {
      httpStatus: snap.httpStatus,
      body: snap.body,
      sitemaps: rules.sitemaps,
      crawlDelayMs: rules.crawlDelayMs,
      fetchedAt: new Date(now),
      expiresAt,
    };
    // Кэш — оптимизация: не записали (гонка двух тиков, права роли) —
    // правила всё равно действуют для этого запроса.
    await db.siteCrawlRobots
      .upsert({
        where: { origin: key },
        create: { origin: key, ...data },
        update: data,
      })
      .catch((e: unknown) =>
        this.logger.warn(`robots: кэш ${key} не записан: ${String(e)}`),
      );
    return rules;
  }

  private async fetchSnapshot(origin: string): Promise<RobotsSnapshot> {
    try {
      const res = await pinnedFetch(
        `${origin}/robots.txt`,
        {
          headers: { 'user-agent': CRAWLER_USER_AGENT, accept: 'text/plain' },
          // Google читает первые 500 КиБ — остальное отбрасываем, не падаем.
          maxBytes: CRAWL_DEFAULTS.maxRobotsBytes,
          truncateAtMaxBytes: true,
          timeoutMs: CRAWL_DEFAULTS.requestTimeoutMs,
          maxRedirects: CRAWL_DEFAULTS.maxRedirects,
          sameOrigin: false,
        },
        this.net,
      );
      const ok = res.status >= 200 && res.status < 300;
      return {
        origin,
        httpStatus: res.status,
        body: ok ? res.body.toString('utf8').replace(/^﻿/, '') : null,
      };
    } catch (e) {
      this.logger.debug(`robots: ${origin} недоступен: ${String(e)}`);
      return { origin, httpStatus: null, body: null };
    }
  }
}
