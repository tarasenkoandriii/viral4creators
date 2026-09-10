/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { SessionService } from './session.service';

/**
 * Захват постобработки (ТЗ §15.4, этап 37).
 *
 * Сам SQL проверяется на живом Postgres в CI (`migrate deploy` + этот
 * запрос там же); здесь — контракт метода: что он делает ОДИН запрос и
 * честно отвечает, кто выиграл. Именно «один запрос» и есть суть
 * находки: прочитать-и-записать через `updateSession` от гонки не
 * защищает принципиально.
 */
function build(affected: number) {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(affected) };
  return { svc: new SessionService(prisma as any), prisma };
}

describe('SessionService.claimPostProduction (этап 37)', () => {
  it('выигравший получает true', async () => {
    const { svc } = build(1);
    expect(await svc.claimPostProduction('s1')).toBe(true);
  });

  it('проигравший получает false, а не исключение', async () => {
    // Проигрыш — штатный исход: два опроса статуса пришли одновременно.
    const { svc } = build(0);
    expect(await svc.claimPostProduction('s1')).toBe(false);
  });

  it('захват — ровно один запрос в базу', async () => {
    // Два запроса (сначала прочитать, потом записать) — это ровно та
    // конструкция, между половинами которой и вклинивается гонка.
    const { svc, prisma } = build(1);
    await svc.claimPostProduction('s1');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('условие занимает только незанятое', async () => {
    // Запрос уходит тегированным шаблоном: первый аргумент — куски SQL.
    const { svc, prisma } = build(1);
    await svc.claimPostProduction('s1');
    const sql = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('UPDATE "sessions"');
    expect(sql).toContain("'{generatedVideo,postStatus}'");
    // Без этого условия захват перезаписывал бы уже идущую задачу.
    expect(sql).toContain("'postStatus' IS NULL");
    // Параметр подставляется драйвером, а не склейкой строк.
    expect(prisma.$executeRaw.mock.calls[0][1]).toBe('s1');
  });
});

describe('SessionService.findSessionsWithPendingTierBExport (Е-2.3 шестого аудита, этап 76)', () => {
  function buildQuery(rows: { id: string }[]) {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    return { svc: new SessionService(prisma as any), prisma };
  }

  it('возвращает id найденных сессий', async () => {
    const { svc } = buildQuery([{ id: 's1' }, { id: 's2' }]);
    expect(await svc.findSessionsWithPendingTierBExport(50)).toEqual([
      's1',
      's2',
    ]);
  });

  it('ничего не найдено — пустой массив, не исключение', async () => {
    const { svc } = buildQuery([]);
    expect(await svc.findSessionsWithPendingTierBExport(50)).toEqual([]);
  });

  it('запрос фильтрует по tier B + status pending через JSONB-containment, с лимитом', async () => {
    const { svc, prisma } = buildQuery([]);
    await svc.findSessionsWithPendingTierBExport(25);
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain("@> '[{\"tier\":\"B\",\"status\":\"pending\"}]'::jsonb");
    expect(sql).toContain('LIMIT');
    expect(prisma.$queryRaw.mock.calls[0][1]).toBe(25);
  });
});

/**
 * Что переживает запись сессии (Б-2.2).
 *
 * `toData` собирает JSON строго по списку `DATA_KEYS`: ключ, которого в
 * нём нет, стирается при каждой записи молча. Именно это и случилось с
 * `librarySourceKey` на этапе 39 — поле писали, читали, и оно всегда
 * было `undefined`, из-за чего обложек в библиотеке не бывало вовсе.
 */
describe('SessionService — круговорот полей сессии (Б-2.2, этап 47)', () => {
  /**
   * Подмена базы, которая ведёт себя как Postgres на `"data" || $patch`:
   * сливает верхние ключи, а не переписывает колонку. Именно это
   * свойство и проверяется — что запись одного ключа не трогает другой.
   */
  function buildRoundTrip() {
    const row = {
      id: 's1',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: 'analysis_complete',
      data: {} as Record<string, unknown>,
      userId: null,
      projectId: null,
      productItemId: null,
    };
    const prisma = {
      session: { findUnique: jest.fn().mockResolvedValue(row) },
      $queryRaw: jest
        .fn()
        .mockImplementation(async (_sql: string[], ...params: unknown[]) => {
          // Первый параметр — JSON правки, второй — статус (или null).
          const patch = JSON.parse(params[0] as string) as Record<
            string,
            unknown
          >;
          row.data = { ...row.data, ...patch };
          if (params[2]) row.status = params[2] as string;
          return [row];
        }),
    };
    return { svc: new SessionService(prisma as any), prisma, row };
  }

  it('librarySourceKey переживает запись и читается обратно', async () => {
    const { svc } = buildRoundTrip();
    await svc.updateSession('s1', { librarySourceKey: 'yt:abc123' });
    const back = await svc.getSession('s1');
    expect(back?.librarySourceKey).toBe('yt:abc123');
  });

  it('запись другого ключа его не стирает', async () => {
    const { svc } = buildRoundTrip();
    await svc.updateSession('s1', { librarySourceKey: 'yt:abc123' });
    await svc.updateSession('s1', { productInformation: undefined });
    const back = await svc.getSession('s1');
    expect(back?.librarySourceKey).toBe('yt:abc123');
  });

  it('в правку попадают только затронутые ключи', async () => {
    // Смысл этапа 47: колонка не переписывается целиком, значит и
    // ключей, которых вызывающий не трогал, в запросе быть не должно —
    // иначе параллельная правка соседнего ключа снова терялась бы.
    const { svc, prisma } = buildRoundTrip();
    await svc.updateSession('s1', { librarySourceKey: 'yt:abc123' });
    const patch = JSON.parse(prisma.$queryRaw.mock.calls[0][1] as string);
    expect(Object.keys(patch)).toEqual(['librarySourceKey']);
  });

  it('undefined в правке стирает ключ, а не пропускается', async () => {
    // `JSON.stringify` выбрасывает undefined-ключи; без явного null
    // «стереть разбор» превращалось бы в «ничего не менять».
    const { svc, prisma } = buildRoundTrip();
    await svc.updateSession('s1', { videoAnalysis: undefined });
    const patch = JSON.parse(prisma.$queryRaw.mock.calls[0][1] as string);
    expect(patch).toEqual({ videoAnalysis: null });
  });

  it('запись сливает ключи в самой базе, а не в памяти', async () => {
    const { svc, prisma } = buildRoundTrip();
    await svc.updateSession('s1', { relevance: undefined });
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('"data" || ?::jsonb');
    // Чтения перед записью нет: читать-и-писать — это и есть гонка.
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('статус пишется только когда передан', async () => {
    const { svc, prisma } = buildRoundTrip();
    // Параметры: правка (дважды — для data и для generationStatus), статус.
    await svc.updateSession('s1', { relevance: undefined });
    expect(prisma.$queryRaw.mock.calls[0][3]).toBeNull();
    await svc.updateSession('s1', { status: 'error' as any });
    expect(prisma.$queryRaw.mock.calls[1][3]).toBe('error');
  });

  it('статус рендера ведётся тем же UPDATE (этап 51, В-4.1)', async () => {
    // Телеметрия считает провалы по колонке, а не по JSON-пути; колонка
    // не может разойтись с `data`, потому что пишется тем же запросом из
    // того же выражения.
    const { svc, prisma } = buildRoundTrip();
    await svc.updateSession('s1', {
      generatedVideo: { status: 'failed' } as any,
    });
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain(
      `"generationStatus" = ("data" || ?::jsonb) -> 'generatedVideo' ->> 'status'`,
    );
  });

  it('несуществующая сессия — undefined, а не исключение', async () => {
    const prisma = {
      session: { findUnique: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const svc = new SessionService(prisma as any);
    expect(await svc.updateSession('нет', { relevance: undefined })).toBe(
      undefined,
    );
  });
});

describe('SessionService.claimWork / releaseWork (этап 47)', () => {
  function build(affected: number) {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(affected) };
    return { svc: new SessionService(prisma as any), prisma };
  }

  it('выигравший получает true, проигравший — false без исключения', async () => {
    expect(await build(1).svc.claimWork('s1', 'generate', 60_000)).toBe(true);
    expect(await build(0).svc.claimWork('s1', 'generate', 60_000)).toBe(false);
  });

  it('захват — один условный запрос, свободный или протухший замок', async () => {
    // Условие в самом UPDATE — иначе два экземпляра функции прочитали бы
    // «свободно» одновременно и оба стартовали бы платный вызов.
    const { svc, prisma } = build(1);
    const before = Date.now();
    await svc.claimWork('s1', 'analyze', 300_000);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [sqlParts, ...params] = prisma.$executeRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const sql = sqlParts.join('?');
    expect(sql).toContain('->> ? IS NULL');
    expect(sql).toContain('::bigint < ?::bigint');
    // Протухание считается от переданного TTL, а не от константы.
    const stale = Number(params[params.length - 1]);
    expect(stale).toBeGreaterThanOrEqual(before - 300_000);
    expect(stale).toBeLessThanOrEqual(Date.now() - 300_000);
  });

  it('промежуточный объект workLocks создаётся, если его нет', async () => {
    // `jsonb_set` с путём в два звена промежуточный объект не создаёт и
    // молча возвращает строку как есть — замок бы «занимался» вникуда.
    const { svc, prisma } = build(1);
    await svc.claimWork('s1', 'prompt', 1000);
    const sql = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain(`COALESCE("data" -> 'workLocks', '{}'::jsonb)`);
  });

  it('освобождение снимает ключ, а не пишет в него null', async () => {
    // null-значение условие захвата тоже считает свободным, но ключ,
    // висящий в каждой сессии навсегда, — мусор в колонке.
    const { svc, prisma } = build(1);
    await svc.releaseWork('s1', 'generate');
    const sql = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('#- ARRAY');
  });
});
