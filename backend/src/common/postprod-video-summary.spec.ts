/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Список «моих готовых роликов» для вкладки «Постпрод» (этап 88). Тот
 * же приём проверки, что у session-summary.spec.ts: SQL строка читается
 * из мок-вызова `$queryRawUnsafe`, не выполняется по-настоящему —
 * `prisma generate` в песочнице недоступен (см. doc/TELEGRAM-ADMIN.md
 * §5), поэтому только эти файлы проверяют форму запроса.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  countPostprodVideoSummaries,
  selectPostprodVideoSummaries,
} from './postprod-video-summary';

function build() {
  const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
  return { prisma };
}

describe('selectPostprodVideoSummaries', () => {
  it('выбирает JSON-пути готового ролика, не колонку data целиком', async () => {
    const { prisma } = build();
    await selectPostprodVideoSummaries(prisma as any, 'user-1', 0, 20);
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain(`"data" -> 'productInformation' ->> 'productName'`);
    expect(sql).toContain(`"data" -> 'generatedVideo' ->> 'downloadUrl'`);
    expect(sql).toContain(`"data" -> 'generatedVideo' ->> 'renderedUrl'`);
    expect(sql).toContain(`"data" -> 'generatedVideo' ->> 'postStatus'`);
    expect(sql).toContain(`"data" -> 'generatedVideo' ->> 'voiceMode'`);
    expect(sql).not.toMatch(/SELECT \*|,\s*s\."data"\s*,|s\."data"\s+FROM/);
    // userId — настоящий фильтр (не JSON-путь): только owner видит свой
    // список, никакого LEFT JOIN на users (это не админский экран).
    expect(sql).toContain(`s."userId" = $1`);
    expect(sql).toContain(`s."generationStatus" = 'complete'`);
    expect(sql).not.toContain('LEFT JOIN');
    expect(params).toEqual(['user-1', 20, 0]);
  });

  it('сортировка — самый недавний ролик первым, id тай-брейкером', async () => {
    const { prisma } = build();
    await selectPostprodVideoSummaries(prisma as any, 'user-1', 40, 10);
    const [sql] = prisma.$queryRawUnsafe.mock.calls[0] as [string];
    expect(sql).toContain('ORDER BY s."createdAt" DESC, s."id" DESC');
    expect(sql).toContain('LIMIT $2 OFFSET $3');
  });
});

describe('countPostprodVideoSummaries', () => {
  it('тот же фильтр (userId + завершённые), без ORDER BY/LIMIT', async () => {
    const { prisma } = build();
    prisma.$queryRawUnsafe.mockResolvedValue([{ count: BigInt(3) }]);
    const total = await countPostprodVideoSummaries(prisma as any, 'user-1');
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain(`s."userId" = $1`);
    expect(sql).not.toContain('ORDER BY');
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual(['user-1']);
    expect(total).toBe(3);
  });

  it('пустой результат — 0, не падение', async () => {
    const { prisma } = build();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    await expect(
      countPostprodVideoSummaries(prisma as any, 'user-1'),
    ).resolves.toBe(0);
  });
});
