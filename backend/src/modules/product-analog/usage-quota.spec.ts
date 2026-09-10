/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Суточные квоты SerpApi и YouTube (Б-1.9, этап 44; тесты — этап 49, В-6.2).
 *
 * Комментарий на обеих функциях гласит «перерасход невозможен», и это
 * правда ровно до тех пор, пока в запросе стоит `WHERE count < limit`.
 * До этого этапа условие не исполнялось ни одним тестом: его можно было
 * снять — и 978 тестов оставались зелёными, а суточный потолок платного
 * SerpApi и общей на весь деплой квоты YouTube исчезал молча. Моки в
 * спеках вызывающих сервисов подменяли весь сервис целиком и проверяли
 * только порядок вызовов.
 *
 * Здесь проверяется сам SQL-путь: условие, атомарность (один запрос),
 * трактовка `affected`, возврат слота не ниже нуля.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { SerpApiUsageService, utcDay } from './serpapi-usage.service';
import { YoutubeSearchUsageService } from '../youtube-search/youtube-search-usage.service';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

type Built = {
  reserve: (userId: string, now?: Date) => Promise<boolean>;
  release: (userId: string, now?: Date) => Promise<void>;
  status: (
    userId: string,
    now?: Date,
  ) => Promise<{ used: number; limit: number; remaining: number }>;
};

const CASES: Array<{
  name: string;
  table: string;
  model: string;
  envKey: string;
  fallback: number;
  make: (prisma: unknown) => Built;
}> = [
  {
    name: 'SerpApi',
    table: 'serp_api_usage',
    model: 'serpApiUsage',
    envKey: 'SERPAPI_DAILY_LIMIT_PER_USER',
    fallback: 50,
    make: (prisma) => new SerpApiUsageService(prisma as any),
  },
  {
    name: 'YouTube',
    table: 'youtube_search_usage',
    model: 'youtubeSearchUsage',
    envKey: 'YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER',
    fallback: 20,
    make: (prisma) => new YoutubeSearchUsageService(prisma as any),
  },
];

describe.each(CASES)(
  '$name — квота занимается одним условным запросом',
  (c) => {
    function build(affected: number) {
      const prisma = { $executeRaw: jest.fn().mockResolvedValue(affected) };
      return { svc: c.make(prisma), prisma };
    }

    it('слот занят → true, лимит выбран → false, без исключений', async () => {
      expect(await build(1).svc.reserve('u1')).toBe(true);
      expect(await build(0).svc.reserve('u1')).toBe(false);
    });

    it('условие по лимиту стоит В САМОМ запросе, а не читается отдельно', async () => {
      // Иначе два одновременных запроса прочитали бы 49 и оба записали 50.
      process.env[c.envKey] = '7';
      const { svc, prisma } = build(1);
      const now = new Date('2026-09-09T12:00:00Z');
      await svc.reserve('u1', now);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [parts, ...params] = prisma.$executeRaw.mock.calls[0] as [
        string[],
        ...unknown[],
      ];
      const sql = parts.join('?');
      expect(sql).toContain(`INSERT INTO "${c.table}"`);
      expect(sql).toContain('ON CONFLICT ("userId", "day") DO UPDATE');
      expect(sql).toContain(`WHERE "${c.table}"."count" < ?`);
      // Лимит — из конфигурации, а не зашитый: последним параметром.
      expect(params[params.length - 1]).toBe(7);
      // Строка — на пользователя и UTC-день.
      expect(params).toContain('u1');
      expect(params).toContain(utcDay(now));
    });

    it('без переменной берётся умолчание, а не ноль и не бесконечность', async () => {
      delete process.env[c.envKey];
      const { svc, prisma } = build(1);
      await svc.reserve('u1');
      const params = prisma.$executeRaw.mock.calls[0].slice(1) as unknown[];
      expect(params[params.length - 1]).toBe(c.fallback);
    });

    it('мусор в переменной не вырождает условие', async () => {
      // `WHERE count < 0` закрыл бы поиск всем, `WHERE count < NaN` — не
      // закрыл бы никому. Обе ошибки в конфигурации обязаны падать на
      // умолчание.
      for (const bad of ['0', '-5', 'abc', '']) {
        process.env[c.envKey] = bad;
        const { svc, prisma } = build(1);
        await svc.reserve('u1');
        const params = prisma.$executeRaw.mock.calls[0].slice(1) as unknown[];
        expect(params[params.length - 1]).toBe(c.fallback);
      }
    });

    it('возврат слота не опускает счётчик ниже нуля', async () => {
      // Лишний release (провайдер отказал дважды на один слот) не должен
      // дарить пользователю квоту.
      const { svc, prisma } = build(1);
      await svc.release('u1');
      const sql = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
      expect(sql).toContain(`UPDATE "${c.table}"`);
      expect(sql).toContain('GREATEST("count" - 1, 0)');
    });
  },
);

describe.each(CASES)(
  '$name — остаток на экране считается от той же строки',
  (c) => {
    function withRow(row: { count: number } | null) {
      process.env[c.envKey] = '10';
      const prisma = {
        [c.model]: { findUnique: jest.fn().mockResolvedValue(row) },
      };
      return { svc: c.make(prisma), prisma };
    }

    it('строка есть — used и remaining сходятся с лимитом', async () => {
      const { svc } = withRow({ count: 7 });
      expect(await svc.status('u1')).toEqual({
        used: 7,
        limit: 10,
        remaining: 3,
      });
    });

    it('строки нет — ноль использовано, весь лимит в остатке', async () => {
      const { svc } = withRow(null);
      expect(await svc.status('u1')).toEqual({
        used: 0,
        limit: 10,
        remaining: 10,
      });
    });

    it('перебор (лимит понизили задним числом) не даёт отрицательный остаток', async () => {
      const { svc } = withRow({ count: 12 });
      expect((await svc.status('u1')).remaining).toBe(0);
    });
  },
);
