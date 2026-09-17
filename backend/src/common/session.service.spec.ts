/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
// PrismaService и @prisma/client тянут сгенерированный клиент, которого в
// песочнице нет (`prisma generate` недоступен — сеть до binaries.prisma.sh
// закрыта, doc/CI.md). `WorkflowKind` — единственное отсюда, что
// `session.service.ts` реально использует как значение (`.SESSION`), не
// только как тип — тот же приём, что в `project.service.spec.ts` для
// `Prisma.DbNull`.
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
  WorkflowKind: {
    SESSION: 'SESSION',
    CATALOG_BATCH_ITEM: 'CATALOG_BATCH_ITEM',
    AB_TEST_VARIANT: 'AB_TEST_VARIANT',
  },
}));

import { DATA_KEYS, SessionService } from './session.service';

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
 * Восьмой аудит (лендинг + скриншот пользователя, этап 84): готовый
 * ролик показывает «Скачать», но `VideoAuditService.run` бессрочно
 * отвечает «Ролик ещё обрабатывается», потому что `postStatus` двигал
 * только клиентский поллинг — закрыл вкладку между «Veo закончил» и
 * «ffmpeg-задача готова», и `postStatus` остаётся `pending` навсегда.
 */
describe('SessionService.findSessionsWithPendingPostProduction (этап 84)', () => {
  function buildQuery(rows: { id: string }[]) {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    return { svc: new SessionService(prisma as any), prisma };
  }

  it('возвращает id найденных сессий', async () => {
    const { svc } = buildQuery([{ id: 's1' }, { id: 's2' }]);
    expect(await svc.findSessionsWithPendingPostProduction(50)).toEqual([
      's1',
      's2',
    ]);
  });

  it('ничего не найдено — пустой массив, не исключение', async () => {
    const { svc } = buildQuery([]);
    expect(await svc.findSessionsWithPendingPostProduction(50)).toEqual([]);
  });

  it('запрос фильтрует по видео complete + postStatus pending, с лимитом', async () => {
    const { svc, prisma } = buildQuery([]);
    await svc.findSessionsWithPendingPostProduction(25);
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain(`"generationStatus" = 'complete'`);
    expect(sql).toContain(`'postStatus' = 'pending'`);
    expect(sql).toContain('LIMIT');
    expect(prisma.$queryRaw.mock.calls[0][1]).toBe(25);
  });
});

/**
 * Подмена базы, которая ведёт себя как Postgres на `колонка || $patch`:
 * сливает верхние ключи, а не переписывает колонку. С этапа 122 колонок
 * ДВЕ (`data` и `liveData`, В-4.2), и мок ведёт обе — иначе тесты
 * круговорота не заметили бы, что горячий ключ уехал не туда.
 * Модульная область видимости — переиспользуется и ниже, в describe про
 * событие воронки (этап 78), не только в «круговороте полей».
 */
function buildRoundTrip() {
  const row = {
    id: 's1',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    status: 'analysis_complete',
    data: {} as Record<string, unknown>,
    liveData: {} as Record<string, unknown>,
    userId: null,
    projectId: null,
    productItemId: null,
  };
  const prisma = {
    session: { findFirst: jest.fn().mockResolvedValue(row) },
    // Этап 78: `updateSession` пишет событие воронки best-effort через
    // `logWorkflowStage` — она сама глотает ошибки, так что этот мок
    // нужен только тем тестам, которые хотят убедиться, что запись
    // РЕАЛЬНО произошла (см. describe ниже), а не молча проглочена.
    workflowStageEvent: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest
      .fn()
      .mockImplementation(async (_sql: string[], ...params: unknown[]) => {
        // Параметры по порядку появления в запросе (этап 122): sessionId
        // (CTE), холодная половина правки, горячая половина, список
        // горячих ключей, статус, sessionId. Каждый ровно один раз —
        // ради этого патчи и вынесены в CTE `p`.
        const previousStatus = row.status;
        const cold = JSON.parse(params[1] as string) as Record<string, unknown>;
        const live = JSON.parse(params[2] as string) as Record<string, unknown>;
        const hot = params[3] as string[];
        const legacy = hot.filter((k) => k in row.data);
        if (legacy.length > 0) {
          // Та же логика, что в SQL: копия из общей колонки сильнее
          // (её писал старый код) и переезжает в горячую, а из общей
          // исчезает.
          for (const k of legacy) {
            row.liveData[k] = row.data[k];
            delete row.data[k];
          }
        }
        row.data = { ...row.data, ...cold };
        row.liveData = { ...row.liveData, ...live };
        const status = params[4];
        if (status) row.status = status as string;
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

  it('КАЖДЫЙ ключ DATA_KEYS читается обратно (М-2.1/М-5.1 седьмого аудита — третий случай класса)', async () => {
    // `locale` (этап 60) и `videoHistory` (седьмой аудит) — оба писались
    // по списку, но отсутствовали в `toSession`. Проверка по списку, а
    // не по одному полю, чтобы четвёртого случая не было.
    const { svc } = buildRoundTrip();
    for (const key of DATA_KEYS) {
      const marker = { probe: key } as never;
      await svc.updateSession('s1', { [key]: marker } as never);
      const back = (await svc.getSession('s1')) as unknown as Record<
        string,
        unknown
      >;
      expect({ key, value: back[key] }).toEqual({ key, value: marker });
    }
  });

  it('videoHistory накапливается, а не усекается до одной записи', async () => {
    const { svc } = buildRoundTrip();
    const v = (id: string) => ({ generatedVideoId: id }) as never;
    await svc.updateSession('s1', { videoHistory: [v('a')] });
    const first = await svc.getSession('s1');
    await svc.updateSession('s1', {
      videoHistory: [v('b'), ...(first?.videoHistory ?? [])],
    });
    const back = await svc.getSession('s1');
    expect(back?.videoHistory?.map((x) => x.generatedVideoId)).toEqual([
      'b',
      'a',
    ]);
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
    expect(sql).toContain('"data" || p.cold');
    expect(sql).toContain('"liveData" || p.live');
    // Чтения перед записью нет: читать-и-писать — это и есть гонка.
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });

  it('статус пишется только когда передан', async () => {
    const { svc, prisma } = buildRoundTrip();
    // Аргументы вызова: [0] — куски SQL, дальше значения по порядку
    // появления (этап 122): sessionId (CTE), холодная половина правки,
    // горячая половина, список горячих ключей, статус, sessionId.
    await svc.updateSession('s1', { relevance: undefined });
    expect(prisma.$queryRaw.mock.calls[0][5]).toBeNull();
    await svc.updateSession('s1', { status: 'error' as any });
    expect(prisma.$queryRaw.mock.calls[1][5]).toBe('error');
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
    // Статус берётся из той колонки, где ролик лежит СЕЙЧАС: у сессии
    // со старой раскладкой это ещё общая колонка (этап 122).
    expect(sql).toContain(
      `("data" || p.cold) -> 'generatedVideo' ->> 'status'`,
    );
    expect(sql).toContain(
      `("liveData" || p.live) -> 'generatedVideo' ->> 'status'`,
    );
  });

  it('горячий ключ пишется в liveData, а холодный — в data (этап 122, В-4.2)', async () => {
    // Смысл разделения: правка статуса рендера не должна переписывать
    // восьмикилобайтную колонку с разбором и промптом. Замерено на
    // PG 16: 1000 таких записей — 8,4 МБ WAL по-старому против 0,16 МБ.
    const { svc, row } = buildRoundTrip();
    await svc.updateSession('s1', {
      generatedVideo: { status: 'processing' } as any,
      videoAnalysis: { status: 'complete' } as any,
    });
    expect(row.liveData).toEqual({ generatedVideo: { status: 'processing' } });
    expect(row.data).toEqual({ videoAnalysis: { status: 'complete' } });
    // И читается это обратно как одна сессия — снаружи разделения нет.
    const back = await svc.getSession('s1');
    expect(back?.generatedVideo).toEqual({ status: 'processing' });
    expect(back?.videoAnalysis).toEqual({ status: 'complete' });
  });

  it('колонка не переписывается, когда в ней нечего менять (этап 122)', async () => {
    // Условие `CASE WHEN (колонка || правка) = колонка` — единственное,
    // что отделяет запись статуса от переписывания всей `data` вместе с
    // TOAST. Без него вызовы, меняющие только `status`, стоили бы
    // столько же, сколько запись разбора.
    const { svc, prisma } = buildRoundTrip();
    await svc.updateSession('s1', { status: 'error' as any });
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain(`WHEN ("data" || p.cold) = "data" THEN "data"`);
    expect(sql).toContain(
      `WHEN ("liveData" || p.live) = "liveData" THEN "liveData"`,
    );
    // Обе половины правки пустые — колонкам в этом вызове менять нечего.
    expect(prisma.$queryRaw.mock.calls[0][2]).toBe('{}');
    expect(prisma.$queryRaw.mock.calls[0][3]).toBe('{}');
  });

  it('несуществующая сессия — undefined, а не исключение', async () => {
    const prisma = {
      session: { findFirst: jest.fn() },
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

/**
 * Этап 89: `DELETE /sessions/:id` (пользователь, «Постпрод») и
 * `AdminPanelService.deleteSession` (оператор) — «тот же механизм»:
 * оба зовут `softDeleteSession`, который лишь ставит `deletedAt`. Раньше
 * (этап 88.2) этот метод назывался `deleteSessionAndCollectBlobPaths` и
 * удалял строку с файлами синхронно — та часть контракта (собрать пути
 * ДО физического удаления строки) переехала в `purgeSoftDeletedSessions`
 * ниже, единственное место, которое теперь удаляет строку по-настоящему.
 */
describe('SessionService.softDeleteSession (этап 89)', () => {
  function buildSoftDelete(count: number) {
    const prisma = {
      session: { updateMany: jest.fn().mockResolvedValue({ count }) },
    };
    return { svc: new SessionService(prisma as any), prisma };
  }

  it('ставит deletedAt, а не удаляет строку', async () => {
    const { svc, prisma } = buildSoftDelete(1);
    expect(await svc.softDeleteSession('s1')).toEqual({ deleted: true });
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('сессии не было (или уже мягко удалена) — deleted=false, не исключение', async () => {
    const { svc } = buildSoftDelete(0);
    expect(await svc.softDeleteSession('nope')).toEqual({ deleted: false });
  });
});

/**
 * Крон-проход (этап 89): физически убирает строки, мягко удалённые
 * больше `SOFT_DELETE_GRACE_MS` назад — тот же контракт «собрать пути
 * файлов ДО удаления строки», что был у прежнего
 * `deleteSessionAndCollectBlobPaths` (этап 88.2) и остаётся у
 * `cleanupExpiredSessions` ниже.
 */
describe('SessionService.purgeSoftDeletedSessions (этап 89)', () => {
  const row = (id: string, data: Record<string, unknown> = {}) => ({
    id,
    status: 'complete',
    createdAt: new Date('2026-09-06T12:00:00Z'),
    lastActivityAt: new Date('2026-09-06T12:00:00Z'),
    data,
    userId: 'u1',
    projectId: null,
    productItemId: null,
  });

  function buildPurge(rows: Record<string, unknown>[]) {
    const prisma = {
      session: {
        findMany: jest.fn().mockResolvedValue(rows),
        deleteMany: jest.fn().mockResolvedValue({ count: rows.length }),
      },
    };
    return { svc: new SessionService(prisma as any), prisma };
  }

  it('пустая партия — ничего не удаляет', async () => {
    const { svc, prisma } = buildPurge([]);
    expect(await svc.purgeSoftDeletedSessions()).toEqual({
      count: 0,
      blobPathnames: [],
      hasMore: false,
    });
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });

  it('собирает пути файлов ДО удаления строк', async () => {
    const { svc, prisma } = buildPurge([
      row('s1', { generatedVideo: { pathname: 'sessions/s1/generated.mp4' } }),
    ]);
    const result = await svc.purgeSoftDeletedSessions();
    expect(result.count).toBe(1);
    expect(result.blobPathnames).toContain('sessions/s1/generated.mp4');
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] }, deletedAt: { lt: expect.any(Date) } },
    });
    const findOrder = prisma.session.findMany.mock.invocationCallOrder[0];
    const deleteOrder = prisma.session.deleteMany.mock.invocationCallOrder[0];
    expect(findOrder).toBeLessThan(deleteOrder);
  });

  it('партия ровно maxSessions — hasMore=true', async () => {
    const { svc } = buildPurge([row('s1')]);
    const result = await svc.purgeSoftDeletedSessions(1);
    expect(result.hasMore).toBe(true);
  });
});

/**
 * `deletedAt: null` (этап 89) — обе читающие/убирающие точки не должны
 * трогать мягко удалённую сессию: `getSession` (пользователь/остальной
 * бэкенд) её не видит, `cleanupExpiredSessions` (TTL-уборка брошенных
 * сессий) её не трогает — она уже ждёт `purgeSoftDeletedSessions`.
 */
describe('SessionService — deletedAt: null фильтрация (этап 89)', () => {
  it('getSession запрашивает { id, deletedAt: null }', async () => {
    const prisma = {
      session: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const svc = new SessionService(prisma as any);
    await svc.getSession('s1');
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { id: 's1', deletedAt: null },
    });
  });

  it('cleanupExpiredSessions исключает мягко удалённые из выборки и удаления', async () => {
    const prisma = {
      session: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const svc = new SessionService(prisma as any);
    await svc.cleanupExpiredSessions();
    expect(prisma.session.findMany.mock.calls[0][0].where).toMatchObject({
      deletedAt: null,
    });
  });
});
