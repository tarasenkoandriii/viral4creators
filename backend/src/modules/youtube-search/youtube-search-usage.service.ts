/**
 * YoutubeSearchUsageService — per-user daily cap on YouTube Data API
 * `search.list` calls (spec §6.4). The Google quota is per Cloud project
 * — 10 000 units/day ≈ 100 searches for EVERY user of this deployment
 * together — so one user must not be able to spend it for all.
 * `YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER`, default 20.
 *
 * Same shape and the same "soft limit, not a security boundary" caveat as
 * SerpApiUsageService (product-analog); deliberately its own table/service
 * rather than a shared one with a `kind` column — see schema.prisma.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import { UsageStatus, utcDay } from '../product-analog/serpapi-usage.service';

@Injectable()
export class YoutubeSearchUsageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Потолок читается на каждом вызове, а не в конструкторе (этап 54,
   * В-2.13): на Vercel экземпляров много и живут они разное время, и
   * правка переменной иначе вступала бы в силу для разных запросов в
   * разное время — часами. Тот же принцип, что у `TelegramNotifyService`.
   * `loadConfiguration()` — чистое чтение `process.env`, без сети.
   */
  private get limit(): number {
    return loadConfiguration().youtube.searchDailyLimitPerUser;
  }

  async status(userId: string, now: Date = new Date()): Promise<UsageStatus> {
    const row = await this.prisma.youtubeSearchUsage.findUnique({
      where: { userId_day: { userId, day: utcDay(now) } },
      select: { count: true },
    });
    const used = row?.count ?? 0;
    return {
      used,
      limit: this.limit,
      remaining: Math.max(0, this.limit - used),
    };
  }

  /**
   * Занять один слот суточной квоты АТОМАРНО (Б-1.9).
   *
   * Было: `canSearch()` читал счётчик → платный вызов (секунды) →
   * `recordSearch()` увеличивал. Между чтением и записью помещается
   * второй запрос: пользователь на 99/100 мог загрузить двадцать фото
   * одновременно и сделать двадцать оплаченных поисков. У YouTube хуже —
   * квота Google общая на весь деплой, то есть перебор одного человека
   * выключает поиск всем.
   *
   * Один запрос `INSERT … ON CONFLICT DO UPDATE … WHERE count < limit`:
   * Postgres берёт блокировку строки на время апдейта, и параллельный
   * запрос ждёт, а не читает устаревшее число. Ноль затронутых строк
   * означает «лимит выбран» — без отдельного чтения.
   *
   * Слот занимается ДО платного вызова и возвращается `release()`, если
   * провайдер в итоге не выставил счёт (кеш, отказ, транспортная
   * ошибка). Перерасход невозможен; в худшем случае пользователь на
   * секунду видит на единицу меньше остатка, чем есть.
   */
  async reserve(userId: string, now: Date = new Date()): Promise<boolean> {
    const day = utcDay(now);
    // М-3.12 седьмого аудита: `WHERE count < limit` действует только в
    // ветке ON CONFLICT — первый вызов за сутки при `limit = 0` проходил.
    if (this.limit <= 0) return false;
    const affected = await this.prisma.$executeRaw`
      INSERT INTO "youtube_search_usage" ("id", "userId", "day", "count", "updatedAt")
      VALUES (gen_random_uuid()::text, ${userId}, ${day}, 1, NOW())
      ON CONFLICT ("userId", "day") DO UPDATE
        SET "count" = "youtube_search_usage"."count" + 1, "updatedAt" = NOW()
        WHERE "youtube_search_usage"."count" < ${this.limit}
    `;
    return affected > 0;
  }

  /**
   * Вернуть занятый слот: провайдер не выставил счёт. Ниже нуля не
   * опускаемся — лишний возврат не должен дарить пользователю квоту.
   */
  async release(userId: string, now: Date = new Date()): Promise<void> {
    const day = utcDay(now);
    await this.prisma.$executeRaw`
      UPDATE "youtube_search_usage"
      SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "day" = ${day}
    `;
  }
}
