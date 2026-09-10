/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Сводка сессии без колонки `data` (этап 51, В-4.4).
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { selectSessionSummaries } from './session-summary';

function build() {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
  return { prisma };
}

describe('selectSessionSummaries', () => {
  it('выбирает два JSON-пути, а не колонку целиком', async () => {
    // 231 КБ на страницу в 20 строк — вся цена в сети и JSON.parse, а
    // читались из этого два поля.
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      orderBy: 'createdAt',
      take: 20,
      skip: 40,
    });
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain(`"data" -> 'productInformation' ->> 'productName'`);
    expect(sql).toContain(`"data" -> 'generatedVideo' ->> 'downloadUrl'`);
    expect(sql).not.toMatch(/SELECT \*|,\s*"data"\s*,|"data"\s+FROM/);
    expect(sql).toContain('ORDER BY "createdAt" DESC');
  });

  it('фильтры необязательные — nullable-параметры, не склейка', async () => {
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      status: 'error',
      userId: 'u1',
      orderBy: 'lastActivityAt',
      take: 10,
    });
    const [parts, ...params] = prisma.$queryRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const sql = parts.join('?');
    expect(sql).toContain('ORDER BY "lastActivityAt" DESC');
    expect(sql).toContain('(?::text IS NULL OR "status" = ?)');
    expect(params).toEqual(['error', 'error', 'u1', 'u1', 10, 0]);
  });

  it('без фильтров параметры — null, и запрос тот же', async () => {
    const { prisma } = build();
    await selectSessionSummaries(prisma as any, {
      orderBy: 'createdAt',
      take: 5,
    });
    const params = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(params).toEqual([null, null, null, null, 5, 0]);
  });
});
