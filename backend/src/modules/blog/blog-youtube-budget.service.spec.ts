/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * BlogYoutubeBudgetService (TODO §II.3, этап 57) — тот же класс проверок,
 * что уже есть для SerpApi/YouTube-пользовательских квот
 * (product-analog/usage-quota.spec.ts): условие лимита должно стоять В
 * САМОМ SQL-запросе, а не читаться отдельно (иначе два параллельных
 * прогона крона оба увидят "49 из 50" и оба спишут — перерасход).
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BlogYoutubeBudgetService } from './blog-youtube-budget.service';
import { utcDay } from '../product-analog/serpapi-usage.service';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('BlogYoutubeBudgetService.reserve', () => {
  function build(affected: number) {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(affected) };
    return { svc: new BlogYoutubeBudgetService(prisma as any), prisma };
  }

  it('слот занят → true, лимит выбран → false, без исключений', async () => {
    expect(await build(1).svc.reserve()).toBe(true);
    expect(await build(0).svc.reserve()).toBe(false);
  });

  async function reserve(built: ReturnType<typeof build>, now?: Date) {
    return built.svc.reserve(now);
  }

  it('условие по лимиту стоит в самом запросе, ключ — сутки, без userId', async () => {
    process.env.BLOG_YOUTUBE_SEARCH_DAILY_LIMIT = '3';
    const built = build(1);
    const now = new Date('2026-09-12T08:00:00Z');
    await reserve(built, now);

    expect(built.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [parts, ...params] = built.prisma.$executeRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const sql = parts.join('?');
    expect(sql).toContain('INSERT INTO "blog_youtube_search_usage"');
    expect(sql).toContain('ON CONFLICT ("day") DO UPDATE');
    expect(sql).toContain('WHERE "blog_youtube_search_usage"."count" < ?');
    expect(params[params.length - 1]).toBe(3);
    expect(params).toContain(utcDay(now));
  });

  it('без переменной — умолчание 10, не ноль и не бесконечность', async () => {
    delete process.env.BLOG_YOUTUBE_SEARCH_DAILY_LIMIT;
    const built = build(1);
    await reserve(built);
    const params = built.prisma.$executeRaw.mock.calls[0].slice(1) as unknown[];
    expect(params[params.length - 1]).toBe(10);
  });

  it('мусор в переменной не вырождает условие в 0 или бесконечность', async () => {
    for (const bad of ['0', '-5', 'abc', '']) {
      process.env.BLOG_YOUTUBE_SEARCH_DAILY_LIMIT = bad;
      const built = build(1);
      await reserve(built);
      const params = built.prisma.$executeRaw.mock.calls[0].slice(
        1,
      ) as unknown[];
      expect(params[params.length - 1]).toBe(10);
    }
  });
});

describe('BlogYoutubeBudgetService.status', () => {
  function withRow(row: { count: number } | null) {
    process.env.BLOG_YOUTUBE_SEARCH_DAILY_LIMIT = '10';
    const prisma = {
      blogYoutubeSearchUsage: { findUnique: jest.fn().mockResolvedValue(row) },
    };
    return new BlogYoutubeBudgetService(prisma as any);
  }

  it('строка есть — used и remaining сходятся с лимитом', async () => {
    expect(await withRow({ count: 4 }).status()).toEqual({
      used: 4,
      limit: 10,
      remaining: 6,
    });
  });

  it('строки нет — ноль использовано, весь лимит в остатке', async () => {
    expect(await withRow(null).status()).toEqual({
      used: 0,
      limit: 10,
      remaining: 10,
    });
  });

  it('перебор (лимит понизили задним числом) не даёт отрицательный остаток', async () => {
    expect((await withRow({ count: 99 }).status()).remaining).toBe(0);
  });
});
