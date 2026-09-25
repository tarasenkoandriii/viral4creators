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
    expect(sql).toContain(
      `COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'downloadUrl'`,
    );
    expect(sql).toContain(
      `COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'quality'`,
    );
    // Этап 86: колонка «Качество» в админке раньше читала только
    // `quality` (только у Veo) — у Grok-роликов (своя ось, `resolution`,
    // никогда не `quality`) это всегда было прочерком. Оба поля должны
    // идти в выборку, иначе фронт не сможет отличить «нет данных» от
    // «не тот провайдер».
    expect(sql).toContain(
      `COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'provider'`,
    );
    expect(sql).toContain(
      `COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'resolution'`,
    );
    expect(sql).toContain(`"data" -> 'brandManifestSnapshot' ->> 'voiceMode'`);
    expect(sql).toContain('LEFT JOIN "users" u');
    expect(sql).toContain(`'generatedVideo') -> 'error' ->> 'message'`);
    expect(sql).toContain(`'generatedVideo') -> 'error' ->> 'code'`);
    expect(sql).not.toMatch(/SELECT \*|,\s*s\."data"\s*,|s\."data"\s+FROM/);
  });

  it('без фильтров — WHERE несёт только deletedAt IS NULL (этап 89), параметры только take/skip', async () => {
    // До этапа 89 без фильтров WHERE не писался вовсе; софт-delete
    // сессий добавил условие БЕЗ параметра (литерал `IS NULL`, не
    // связывание) — оно есть всегда, остальные фильтры по-прежнему
    // опциональны.
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
    expect(sql).toContain('WHERE s."deletedAt" IS NULL');
    expect(sql).not.toContain('AND');
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
      `COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'quality' = $2`,
    );
    expect(sql).toContain(
      `s."data" -> 'brandManifestSnapshot' ->> 'voiceMode' = $3`,
    );
    expect(sql).toContain(`u."plan"::text = $4`);
    expect(sql).toContain('ILIKE $5');
    // Шестой параметр — тот же поиск без процентов: точное совпадение
    // по id сессии (аудит этапа 158). Подстрокой по первичному ключу
    // искать нельзя — это последовательный просмотр ради того, чего не
    // бывает.
    expect(sql).toContain('s."id" = $6');
    expect(params).toEqual([
      'error',
      'standard',
      'dub',
      'PREMIUM',
      '%anna%',
      'anna',
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
