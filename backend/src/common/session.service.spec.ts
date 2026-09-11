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
    expect(sql).toContain('@> \'[{"tier":"B","status":"pending"}]\'::jsonb');
    expect(sql).toContain('LIMIT');
    expect(prisma.$queryRaw.mock.calls[0][1]).toBe(25);
  });
});

/**
 * Подмена базы, которая ведёт себя как Postgres на `"data" || $patch`:
 * сливает верхние ключи, а не переписывает колонку. Модульная область
 * видимости — переиспользуется и ниже, в describe про событие воронки
 * (этап 78), не только в «круговороте полей».
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
    // Этап 78: `updateSession` пишет событие воронки best-effort через
    // `logWorkflowStage` — она сама глотает ошибки, так что этот мок
    // нужен только тем тестам, которые хотят убедиться, что запись
    // РЕАЛЬНО произошла (см. describe ниже), а не молча проглочена.
    workflowStageEvent: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest
      .fn()
      .mockImplementation(async (_sql: string[], ...params: unknown[]) => {
        // Параметры тегированного шаблона по порядку появления `${...}`
        // в SQL: sessionId (CTE `old`), правка (дважды — для data и для
        // generationStatus), статус (или null), sessionId (WHERE).
        const previousStatus = row.status;
        const patch = JSON.parse(params[1] as string) as Record<
          string,
          unknown
        >;
        row.data = { ...row.data, ...patch };
        if (params[3]) row.status = params[3] as string;
        return [{ ...row, previousStatus }];
      }),
  };
  return { svc: new SessionService(prisma as any), prisma, row };
}

/**
 * Что переживает запись сессии (Б-2.2).
 *
 * `toData` собирает JSON строго по списку `DATA_KEYS`: ключ, которого в
 * нём нет, стирается при каждой записи молча. Именно это и случилось с
 * `librarySourceKey` на этапе 39 — поле писали, читали, и оно всегда
 * было `undefined`, из-за чего обложек в библиотеке не бывало вовсе.
 */
describe('SessionService — круговорот полей сессии (Б-2.2, этап 47)', () => {
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
    const patch = JSON.parse(prisma.$queryRaw.mock.calls[0][2] as string);
    expect(Object.keys(patch)).toEqual(['librarySourceKey']);
  });

  it('undefined в правке стирает ключ, а не пропускается', async () => {
    // `JSON.stringify` выбрасывает undefined-ключи; без явного null
    // «стереть разбор» превращалось бы в «ничего не менять».
    const { svc, prisma } = buildRoundTrip();
    await svc.updateSession('s1', { videoAnalysis: undefined });
    const patch = JSON.parse(prisma.$queryRaw.mock.calls[0][2] as string);
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
    // Параметры: sessionId (CTE), правка (дважды — data/generationStatus), статус.
    await svc.updateSession('s1', { relevance: undefined });
    expect(prisma.$queryRaw.mock.calls[0][4]).toBeNull();
    await svc.updateSession('s1', { status: 'error' as any });
    expect(prisma.$queryRaw.mock.calls[1][4]).toBe('error');
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

/**
 * Событие воронки (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md §3.2). `createSession`
 * пишет самое первое событие сущности напрямую; `updateSession` — только
 * при РЕАЛЬНОЙ смене статуса, беря `fromStage` из `previousStatus`,
 * который вернула CTE `old` тем же UPDATE-запросом.
 */
describe('SessionService — событие воронки (этап 78)', () => {
  function buildCreate() {
    const created = {
      id: 's-new',
      status: 'created',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      data: {},
      userId: null,
      projectId: null,
      productItemId: null,
    };
    const prisma = {
      session: { create: jest.fn().mockResolvedValue(created) },
      workflowStageEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    return { svc: new SessionService(prisma as any), prisma };
  }

  it('createSession пишет первое событие с fromStage: null', async () => {
    const { svc, prisma } = buildCreate();
    await svc.createSession();
    expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
      data: {
        workflow: 'SESSION',
        entityId: 's-new',
        fromStage: null,
        stage: 'created',
      },
    });
  });

  it('updateSession пишет событие при реальной смене статуса, fromStage = previousStatus', async () => {
    const { svc, prisma } = buildRoundTrip();
    // buildRoundTrip стартует со статусом 'analysis_complete' (см. row выше).
    await svc.updateSession('s1', { status: 'error' as any });
    expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
      data: {
        workflow: 'SESSION',
        entityId: 's1',
        fromStage: 'analysis_complete',
        stage: 'error',
      },
    });
  });

  it('updateSession НЕ пишет событие, когда патч не трогает статус', async () => {
    const { svc, prisma } = buildRoundTrip();
    await svc.updateSession('s1', { relevance: undefined });
    expect(prisma.workflowStageEvent.create).not.toHaveBeenCalled();
  });

  it('updateSession НЕ пишет событие при повторной записи того же статуса', async () => {
    const { svc, prisma, row } = buildRoundTrip();
    await svc.updateSession('s1', { status: row.status as any });
    expect(prisma.workflowStageEvent.create).not.toHaveBeenCalled();
  });

  it('updateSession честно отражает возврат назад по пайплайну (§3.3)', async () => {
    // Например: generatePrompt() перегенерирует промпт после неудачного
    // рендера — статус уходит из 'error'/'generating_video' обратно в
    // 'prompt_generated'. fromStage должен показать источник возврата.
    const { svc, prisma, row } = buildRoundTrip();
    row.status = 'error';
    await svc.updateSession('s1', { status: 'prompt_generated' as any });
    expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
      data: {
        workflow: 'SESSION',
        entityId: 's1',
        fromStage: 'error',
        stage: 'prompt_generated',
      },
    });
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
