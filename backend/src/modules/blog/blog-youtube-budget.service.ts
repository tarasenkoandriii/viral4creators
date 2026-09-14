/**
 * BlogYoutubeBudgetService — суточный потолок YouTube-поисков суточного
 * генератора черновиков блога (doc/TODO.md §II.3: «суточный поиск блога
 * должен иметь свой потолок, отдельный от пользовательского»).
 *
 * Тот же атомарный приём, что `YoutubeSearchUsageService.reserve`/
 * `SerpApiUsageService.reserve` (`INSERT … ON CONFLICT … WHERE count <
 * limit`, ноль задетых строк = «лимит выбран», без отдельного чтения
 * между проверкой и записью) — но без `userId`: генератор не
 * пользователь, и заводить фиктивную строку в `users` ради счётчика было
 * бы обманом схемы. Своя таблица (`BlogYoutubeSearchUsage`, одна строка
 * на UTC-сутки), а не переиспользование `rate_limits` — ту чистит крон
 * раз в час (`pruneRateLimits`, окна рассчитаны на минуты, не на сутки) и
 * молча обнулила бы суточный счётчик среди дня.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import { utcDay, UsageStatus } from '../product-analog/serpapi-usage.service';

@Injectable()
export class BlogYoutubeBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Потолок читается на каждом вызове, а не в конструкторе (тот же приём,
   * что у остальных суточных квот этого проекта): смена переменной
   * вступает в силу сразу, без рестарта.
   */
  private get limit(): number {
    return loadConfiguration().blog.youtubeSearchDailyLimit;
  }

  async status(now: Date = new Date()): Promise<UsageStatus> {
    const row = await this.prisma.blogYoutubeSearchUsage.findUnique({
      where: { day: utcDay(now) },
      select: { count: true },
    });
    const used = row?.count ?? 0;
    return {
      used,
      limit: this.limit,
      remaining: Math.max(0, this.limit - used),
    };
  }

  /** Занять один слот суточного бюджета атомарно. */
  async reserve(now: Date = new Date()): Promise<boolean> {
    const day = utcDay(now);
    // М-3.12 седьмого аудита: `WHERE count < limit` действует только в
    // ветке ON CONFLICT — первый вызов за сутки при `limit = 0` проходил.
    if (this.limit <= 0) return false;
    const affected = await this.prisma.$executeRaw`
      INSERT INTO "blog_youtube_search_usage" ("day", "count", "updatedAt")
      VALUES (${day}, 1, NOW())
      ON CONFLICT ("day") DO UPDATE
        SET "count" = "blog_youtube_search_usage"."count" + 1, "updatedAt" = NOW()
        WHERE "blog_youtube_search_usage"."count" < ${this.limit}
    `;
    return affected > 0;
  }
}
