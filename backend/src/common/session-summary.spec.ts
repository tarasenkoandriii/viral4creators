/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Сводка сессии без колонки `data` целиком (этап 51, В-4.4) — расширена
 * доп. запросом владельца продукта (владелец/качество/озвучка,
 * сортировка, фильтры). Запрос теперь идёт через `$queryRawUnsafe`
 * (плоская строка + позиционные `$1, $2, …`), а не тегированный шаблон
 * — так параметризация значений остаётся честной, а колонка сортировки
 * (которая параметром быть не может) берётся из фиксированной карты в
 * коде, а не из строки запроса.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  countSessionSummaries,
  isSessionSortKey,
  isSortDirection,
  selectSessionSummaries,
} from './session-summary';

function build() {
  const prisma = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  return { prisma };
}

describe('selectSessionSummaries', () => {
  it('выбирает JSON-пути и владельца, а не колонку data целиком', async () => {
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      sortBy: 'createdAt',
      sortDir: 'desc',
      take: 20,
      skip: 40,
    });
    const [sql] = prisma.$queryRawUnsafe.mock.calls[0] as [string];
    expect(sql).toContain(`"data" -> 'productInformation' ->> 'productName'`);
    expect(sql).toContain(`"data" -> 'generatedVideo' ->> 'downloadUrl'`);
    expect(sql).toContain(`"data" -> 'generatedVideo' ->> 'quality'`);
    expect(sql).toContain(
      `"data" -> 'brandManifestSnapshot' ->> 'voiceMode'`,
    );
    expect(sql).toContain('LEFT JOIN "users" u');
    expect(sql).not.toMatch(/SELECT \*|,\s*s\."data"\s*,|s\."data"\s+FROM/);
  });

  it('без фильтров — WHERE не пишется вовсе, параметры только take/skip', async () => {
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      sortBy: 'createdAt',
      sortDir: 'desc',
      take: 5,
    });
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([5, 0]);
  });

  it('каждый заданный фильтр — свой параметр, не склейка строк', async () => {
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      status: 'error',
      quality: 'standard',
      voiceMode: 'dub',
      plan: 'PREMIUM',
      search: 'anna',
      sortBy: 'lastActivityAt',
      sortDir: 'asc',
      take: 10,
    });
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain('s."status" = $1');
    expect(sql).toContain(
      `s."data" -> 'generatedVideo' ->> 'quality' = $2`,
    );
    expect(sql).toContain(
      `s."data" -> 'brandManifestSnapshot' ->> 'voiceMode' = $3`,
    );
    expect(sql).toContain(`u."plan"::text = $4`);
    expect(sql).toContain('ILIKE $5');
    expect(params).toEqual([
      'error',
      'standard',
      'dub',
      'PREMIUM',
      '%anna%',
      10,
      0,
    ]);
  });

  it('сортировка — колонка литералом из карты, направление и id-тайбрейкер', async () => {
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      sortBy: 'plan',
      sortDir: 'asc',
      take: 10,
    });
    const [sql] = prisma.$queryRawUnsafe.mock.calls[0] as [string];
    expect(sql).toContain('ORDER BY u."plan" ASC NULLS LAST, s."id" ASC');
  });

  it('неизвестное направление никогда не попадает сюда — но DESC остаётся дефолтом при мусоре', async () => {
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      sortBy: 'status',
      // @ts-expect-error — контроллер такое не пропустит, но функция не должна падать
      sortDir: 'sideways',
      take: 1,
    });
    const [sql] = prisma.$queryRawUnsafe.mock.calls[0] as [string];
    expect(sql).toContain('ORDER BY s."status" DESC');
  });
});

describe('countSessionSummaries', () => {
  it('тот же фильтр, без ORDER BY/LIMIT', async () => {
    const { prisma } = build();
    prisma.$queryRawUnsafe.mockResolvedValue([{ count: BigInt(7) }]);
    const total = await countSessionSummaries(prisma as any, {
      status: 'error',
    });
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain('COUNT(*)');
    expect(sql).not.toContain('ORDER BY');
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual(['error']);
    expect(total).toBe(7);
  });

  it('пустой результат — 0, не падение', async () => {
    const { prisma } = build();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    await expect(countSessionSummaries(prisma as any, {})).resolves.toBe(0);
  });
});

describe('isSessionSortKey / isSortDirection', () => {
  it('признают только четыре ключа сортировки и два направления', () => {
    for (const k of ['createdAt', 'lastActivityAt', 'status', 'plan']) {
      expect(isSessionSortKey(k)).toBe(true);
    }
    expect(isSessionSortKey('quality')).toBe(false);
    expect(isSessionSortKey(undefined)).toBe(false);
    expect(isSortDirection('asc')).toBe(true);
    expect(isSortDirection('desc')).toBe(true);
    expect(isSortDirection('ASC')).toBe(false);
    expect(isSortDirection('')).toBe(false);
  });
});
