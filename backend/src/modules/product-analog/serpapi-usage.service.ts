/**
 * SerpApiUsageService — суточный потолок платных поисков SerpApi на
 * пользователя (ТЗ §7.5): `SERPAPI_DAILY_LIMIT_PER_USER`, по умолчанию
 * 50; таблица `serp_api_usage`, строка на пользователя и UTC-день.
 *
 * С этапа 44 (Б-1.9) потолок жёсткий: слот занимается одним условным
 * запросом ДО платного вызова (`reserve`), а не читается и увеличивается
 * двумя. Оговорка «мягкий лимит, два оператора» из первой версии больше
 * не про этот код. Проверено тестами `usage-quota.spec.ts` (этап 49) и
 * живым Postgres: при лимите 2 третий `reserve` затрагивает ноль строк.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';

/** YYYY-MM-DD in UTC — the row key. Exported for tests. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface UsageStatus {
  used: number;
  limit: number;
  remaining: number;
}

@Injectable()
export class SerpApiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Потолок читается на каждом вызове, а не в конструкторе (этап 54,
   * В-2.13): на Vercel экземпляров много и живут они разное время, и
   * правка переменной иначе вступала бы в силу для разных запросов в
   * разное время — часами. Тот же принцип, что у `TelegramNotifyService`.
   * `loadConfiguration()` — чистое чтение `process.env`, без сети.
   */
  private get limit(): number {
    return loadConfiguration().serpApi.dailyLimitPerUser;
  }

  async status(userId: string, now: Date = new Date()): Promise<UsageStatus> {
    const row = await this.prisma.serpApiUsage.findUnique({
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
    const affected = await this.prisma.$executeRaw`
      INSERT INTO "serp_api_usage" ("id", "userId", "day", "count", "updatedAt")
      VALUES (gen_random_uuid()::text, ${userId}, ${day}, 1, NOW())
      ON CONFLICT ("userId", "day") DO UPDATE
        SET "count" = "serp_api_usage"."count" + 1, "updatedAt" = NOW()
        WHERE "serp_api_usage"."count" < ${this.limit}
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
      UPDATE "serp_api_usage"
      SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "day" = ${day}
    `;
  }
}
