/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `SessionService` тянет за собой сгенерированный клиент Prisma, которого в
// песочнице нет (doc/CI.md). Нужен ровно один символ — тот же приём, что в
// `brand-manifest.service.spec.ts`.
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

import { AiUsageService } from './ai-usage.service';
import { VoiceBudgetService } from '../voice-budget/voice-budget.service';

function build(over: { rawResult?: unknown } = {}) {
  const prisma = {
    aiUsage: {
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(7),
      aggregate: jest.fn().mockResolvedValue({ _sum: { costMicroUsd: 1200 } }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ pricingVersion: '2026-09-06' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // Свёртка журнала (этап 118): вторая половина всех отчётов «за всё
    // время». По умолчанию пустая — как на стенде, где крон ещё не
    // отработал ни разу.
    aiUsageMonthly: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { costMicroUsd: null, calls: null } }),
      groupBy: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn().mockResolvedValue([]),
    user: { findMany: jest.fn().mockResolvedValue([]) },
    // Два сырых запроса-счётчика (этап 44): сначала уникальные
    // пользователи с расходом, затем уникальные сессии.
    $queryRaw: jest.fn().mockResolvedValue(over.rawResult ?? [{ count: 42 }]),
  };
  const sessions = { getSession: jest.fn().mockResolvedValue(null) };
  return { svc: new AiUsageService(prisma as any, sessions as any), prisma };
}

describe('AiUsageService.report (ТЗ §26)', () => {
  it('число сессий с расходом считает база, а не Node', async () => {
    // `distinct` у Prisma 7 дедуплицирует В ПАМЯТИ: выбирает все строки
    // журнала и схлопывает их в JS. На 800 тыс. строк это ~25 МБ в куче
    // функции ради ОДНОГО числа, и дальше — падение по памяти
    // (этап 37, А-1.1).
    const { svc, prisma } = build();
    const report = await svc.report();

    expect(report.sessionsWithCost).toBe(42);
    // Два счётчика: пользователи и сессии. Оба — одним числом из базы.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    // Главное утверждение: журнал целиком из базы больше не выезжает.
    expect(prisma.aiUsage.findMany).not.toHaveBeenCalled();
  });

  it('запрос считает именно уникальные непустые сессии', async () => {
    const { svc, prisma } = build();
    await svc.report();
    const sql = (prisma.$queryRaw.mock.calls[1][0] as string[]).join(' ');
    expect(sql).toContain('count(DISTINCT a."sessionId")');
    // Без этого условия анонимные вызовы без сессии считались бы одной
    // «сессией» и завышали бы знаменатель среднего.
    expect(sql).toContain('a."sessionId" IS NOT NULL');
    // TODO §III п.37: сессии тестовых аккаунтов в знаменатель среднего
    // не идут — иначе средний чек считается вместе с его проверкой.
    // COALESCE, а не просто `= false`: у анонимной строки связи с
    // пользователем нет, и без него она выпала бы из счёта.
    expect(sql).toContain('COALESCE(u."isTestUser", false) = false');
  });

  it('пустой ответ базы не роняет отчёт', async () => {
    // Невозможно у count-запроса, но `?? 0` дешевле предположения.
    const { svc } = build({ rawResult: [] });
    const report = await svc.report();
    expect(report.sessionsWithCost).toBe(0);
    expect(report.avgPerSessionMicroUsd).toBe(0);
  });

  it('топ-10 сортирует и режет база, а не Node (Б-1.7)', async () => {
    // Без `orderBy`+`take` сюда ехали ВСЕ пользователи с расходом
    // (измерено: 3 750 строк, 243 мс) ради десяти строк на экране.
    const { svc, prisma } = build();
    await svc.report(10);
    const args = (
      prisma.aiUsage.groupBy.mock.calls as Array<[Record<string, unknown>]>
    )
      .map((c) => c[0])
      .find((a) => Array.isArray(a.by) && a.by[0] === 'userId')!;
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ _sum: { costMicroUsd: 'desc' } });
  });

  it('повторный отчёт в ту же минуту берётся из кеша (Б-1.7)', async () => {
    // Отчёт — тринадцать агрегатов по журналу, который не чистится
    // никогда: 1,19 с полных сканов на 800 тыс. строк. Оператор жмёт
    // «обновить» подряд, цифры за минуту не меняются.
    const { svc, prisma } = build();
    const first = await svc.report();
    const second = await svc.report();
    expect(second).toBe(first);
    // Два сырых счётчика на отчёт: после второго вызова их всё ещё два.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('другой размер топа кеш не переиспользует', async () => {
    const { svc, prisma } = build();
    await svc.report(10);
    await svc.report(25);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('нет тестовых аккаунтов — нет и лишних условий с запросами', async () => {
    // На проекте без тестовых блок стоит трёх нулей, а не трёх запросов
    // на каждое открытие вкладки.
    const { svc, prisma } = build();
    const report = await svc.report();
    expect(report.testUsers).toEqual({
      accounts: 0,
      costMicroUsd: 0,
      calls: 0,
      spentTodayMicroUsd: 0,
      byOperation: [],
    });
    const wheres = prisma.aiUsage.aggregate.mock.calls.map(
      (c: any) => c[0].where,
    );
    expect(wheres.some((w: any) => w?.OR)).toBe(false);
  });

  it('среднее на сессию считается от числа из базы', async () => {
    const { svc } = build({ rawResult: [{ count: 4 }] });
    const report = await svc.report();
    // totalMicroUsd приходит из aggregate-мока: 1200 / 4 = 300.
    expect(report.avgPerSessionMicroUsd).toBe(300);
  });
});

describe('AiUsageService.record (ТЗ §26)', () => {
  it('символы синтеза попадают в строку расхода', async () => {
    // У TTS счёт идёт за символы, а не за токены (§15.7); ветка
    // `perMChars` в прайсе до этапа 37 не исполнялась ни разу.
    const { svc, prisma } = build();
    await svc.record({
      operation: 'voiceover',
      model: 'elevenlabs-tts',
      userId: 'u1',
      characters: 1000,
    });
    const data = prisma.aiUsage.create.mock.calls[0][0].data;
    expect(data.characters).toBe(1000);
    expect(data.provider).toBe('ELEVENLABS');
    // 1000 символов при ставке $220 за миллион — 220 000 микродолларов.
    expect(data.costMicroUsd).toBe(220000);
    expect(data.unpriced).toBe(false);
  });

  it('неизвестная модель пишется с флагом, а не молчаливым нулём', async () => {
    const { svc, prisma } = build();
    await svc.record({ operation: 'prompt', model: 'модель-из-будущего' });
    const data = prisma.aiUsage.create.mock.calls[0][0].data;
    expect(data.costMicroUsd).toBe(0);
    expect(data.unpriced).toBe(true);
  });

  it('анонимность фиксируется при записи, а не выводится из userId', async () => {
    // `userId IS NULL` имеет два смысла: «был анонимным» и «аккаунт
    // удалили» (onDelete: SetNull). Из-за второго расход удалённого
    // пользователя перетекал в ОБЩИЙ потолок анонимных и выбивал его для
    // всех остальных (этап 40, А-1.10).
    const { svc, prisma } = build();
    await svc.record({ operation: 'prompt', model: 'gpt-5', userId: 'u1' });
    expect(prisma.aiUsage.create.mock.calls[0][0].data.anonymous).toBe(false);

    prisma.aiUsage.create.mockClear();
    await svc.record({ operation: 'prompt', model: 'gpt-5' });
    expect(prisma.aiUsage.create.mock.calls[0][0].data.anonymous).toBe(true);
  });

  it('без userId владелец берётся у сессии, и запись не анонимная (Б-5.17, В-6.3)', async () => {
    // Открытые маршруты (генерация, разбор, промпт) знают только сессию
    // (§7.8). Если эти две строки убрать, каждая генерация вошедшего
    // ложится в журнал как анонимная: его личный потолок не наполняется
    // никогда, а общий котёл анонимов выедают все. Пункт числился
    // закрытым на этапе 43, а ветка не исполнялась ни одним тестом.
    const { svc, prisma } = build();
    const sessions = (svc as any).sessions as {
      getSession: jest.Mock;
    };
    sessions.getSession.mockResolvedValue({ sessionId: 's1', userId: 'u7' });

    await svc.record({
      operation: 'generation',
      model: 'gpt-5',
      sessionId: 's1',
    });

    expect(sessions.getSession).toHaveBeenCalledWith('s1');
    const data = prisma.aiUsage.create.mock.calls[0][0].data;
    expect(data.userId).toBe('u7');
    expect(data.anonymous).toBe(false);
    expect(data.sessionId).toBe('s1');
  });

  it('сессия без владельца или несуществующая — честно анонимная', async () => {
    const { svc, prisma } = build();
    const sessions = (svc as any).sessions as { getSession: jest.Mock };
    sessions.getSession.mockResolvedValue({ sessionId: 's1', userId: null });
    await svc.record({
      operation: 'generation',
      model: 'gpt-5',
      sessionId: 's1',
    });
    expect(prisma.aiUsage.create.mock.calls[0][0].data.anonymous).toBe(true);

    prisma.aiUsage.create.mockClear();
    sessions.getSession.mockResolvedValue(undefined);
    await svc.record({
      operation: 'generation',
      model: 'gpt-5',
      sessionId: 'нет',
    });
    expect(prisma.aiUsage.create.mock.calls[0][0].data.anonymous).toBe(true);
  });

  it('явный userId не перебивается владельцем сессии', async () => {
    // Сессию читаем только когда владельца не дали: лишний запрос на
    // каждый платный вызов — шум, а переданный владелец достовернее.
    const { svc, prisma } = build();
    const sessions = (svc as any).sessions as { getSession: jest.Mock };
    await svc.record({
      operation: 'generation',
      model: 'gpt-5',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(sessions.getSession).not.toHaveBeenCalled();
    expect(prisma.aiUsage.create.mock.calls[0][0].data.userId).toBe('u1');
  });

  it('потолок анонимных считается по флагу, а не по пустому владельцу', async () => {
    const { svc, prisma } = build();
    await svc.spentToday(null);
    expect(prisma.aiUsage.aggregate.mock.calls[0][0].where).toMatchObject({
      anonymous: true,
    });
    expect('userId' in prisma.aiUsage.aggregate.mock.calls[0][0].where).toBe(
      false,
    );

    prisma.aiUsage.aggregate.mockClear();
    await svc.spentToday('u1');
    expect(prisma.aiUsage.aggregate.mock.calls[0][0].where).toMatchObject({
      userId: 'u1',
    });
  });

  it('сбой записи не бросает наружу — деньги уже потрачены', async () => {
    const { svc, prisma } = build();
    prisma.aiUsage.create.mockRejectedValue(new Error('база недоступна'));
    await expect(
      svc.record({ operation: 'prompt', model: 'gpt-5' }),
    ).resolves.toBeUndefined();
  });
});

describe('AiUsageService — свёртка журнала (doc/TODO.md §I-Б.5)', () => {
  it('сворачивает только месяцы, отданные чистым правилом', async () => {
    // Свежие месяцы держат окна 1/7/30 дней отчёта: тронуть их — значит
    // молча урезать «за вчера».
    const { svc, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([
      { month: '2026-09' },
      { month: '2026-08' },
      { month: '2026-01' },
    ]);
    const result = await svc.rollupOldMonths({
      now: new Date('2026-09-16T12:00:00Z'),
    });
    expect(result.months).toEqual(['2026-01']);
  });

  it('за прогон берёт не больше указанного числа месяцев', async () => {
    // Первый запуск на накопленном журнале иначе пытался бы съесть годы
    // за один тик serverless-функции.
    const { svc, prisma } = build();
    prisma.$queryRaw.mockResolvedValue(
      ['2025-01', '2025-02', '2025-03', '2025-04'].map((month) => ({ month })),
    );
    const result = await svc.rollupOldMonths({
      maxMonths: 2,
      now: new Date('2026-09-16T12:00:00Z'),
    });
    // Старое первым: прерванный прогон продолжает, а не начинает заново.
    expect(result.months).toEqual(['2025-01', '2025-02']);
  });

  it('месяц сворачивается одной транзакцией: снести → записать → удалить', async () => {
    // Порядок и атомарность — единственное, что отделяет свёртку от
    // потери денег: половинный месяц уже не пересчитать, сырых строк нет.
    const { svc, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([{ month: '2026-01' }]);
    // Группирует база: в Node приезжают уже сложенные строки.
    prisma.aiUsage.groupBy.mockResolvedValue([
      {
        userId: 'u1',
        anonymous: false,
        provider: 'GEMINI',
        operation: 'analysis',
        model: 'gemini-2.5-flash',
        unpriced: false,
        _sum: { costMicroUsd: 150 },
        _count: { _all: 2 },
      },
    ]);
    prisma.$transaction.mockResolvedValue([
      { count: 0 },
      { count: 1 },
      { count: 2 },
    ]);
    const result = await svc.rollupOldMonths({
      now: new Date('2026-09-16T12:00:00Z'),
    });

    expect(result).toEqual({
      months: ['2026-01'],
      foldedRows: 1,
      // Удалено — число из базы, а не длина выборки.
      deletedRows: 2,
    });
    // Журнал целиком в Node не выезжает: сложение делает база.
    expect(prisma.aiUsage.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = prisma.$transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(3);
    // Прежняя свёртка этого месяца сносится до записи новой — иначе
    // повторный прогон удвоил бы деньги.
    expect(prisma.aiUsageMonthly.deleteMany.mock.calls[0][0]).toEqual({
      where: { month: '2026-01' },
    });
    expect(prisma.aiUsageMonthly.createMany.mock.calls[0][0].data).toEqual([
      {
        month: '2026-01',
        userId: 'u1',
        anonymous: false,
        provider: 'GEMINI',
        operation: 'analysis',
        model: 'gemini-2.5-flash',
        unpriced: false,
        calls: 2,
        costMicroUsd: 150n,
        // Символов у разбора нет — но поле есть всегда: колонка
        // `NOT NULL`, и строка свёртки без неё не записалась бы.
        characters: 0,
      },
    ]);
    // Символы группирует база вместе с деньгами (этап F): не
    // попроси их здесь — после удаления сырых строк их не вернуть.
    expect(prisma.aiUsage.groupBy.mock.calls[0][0]._sum).toEqual({
      costMicroUsd: true,
      characters: true,
    });
    // Сырые строки удаляются ровно по границам месяца и строго `lt`.
    expect(prisma.aiUsage.deleteMany.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lt: new Date('2026-02-01T00:00:00.000Z'),
    });
  });

  it('месяц без сырых строк не трогается вовсе — иначе повтор внахлёст стёр бы уже записанную свёртку', async () => {
    // Два прогона внахлёст (реестр админки и настоящий крон) снимают
    // список месяцев каждый до чужой транзакции. Если второй дойдёт до
    // уже свёрнутого месяца, сырых строк там нет — и безусловное
    // «снести и записать» записало бы вместо свёртки пустоту, а
    // пересобрать её было бы не из чего.
    const { svc, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([{ month: '2026-01' }]);
    prisma.aiUsage.groupBy.mockResolvedValue([]);
    const result = await svc.rollupOldMonths({
      now: new Date('2026-09-16T12:00:00Z'),
    });
    expect(result).toEqual({
      months: ['2026-01'],
      foldedRows: 0,
      deletedRows: 0,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.aiUsageMonthly.deleteMany).not.toHaveBeenCalled();
  });

  it('ключ месяца берётся у базы без смены зоны — иначе он разъедется с границами выборки', async () => {
    // `createdAt` — timestamp без зоны и уже в UTC. `AT TIME ZONE 'UTC'`
    // сделал бы из него timestamptz, и `to_char` отрисовал бы месяц в
    // зоне СЕССИИ базы: на сервере не в UTC свёртка бралась бы за
    // месяц, которого по её же границам нет.
    const { svc, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([]);
    await svc.rollupOldMonths({ now: new Date('2026-09-16T12:00:00Z') });
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join(' ');
    expect(sql).toContain(`to_char("createdAt", 'YYYY-MM')`);
    expect(sql).not.toContain('AT TIME ZONE');
  });

  it('повторный прогон по уже свёрнутому месяцу ничего не удваивает', async () => {
    // После первого прогона сырых строк месяца нет: второй складывает
    // пустую свёртку поверх пустой.
    const { svc, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([]);
    const result = await svc.rollupOldMonths({
      now: new Date('2026-09-16T12:00:00Z'),
    });
    expect(result.months).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('свёртка сбрасывает кеш отчёта', async () => {
    // Иначе админка до конца TTL показывала бы числа, посчитанные по
    // источнику, которого уже нет.
    const { svc, prisma } = build();
    await svc.report();
    prisma.$queryRaw.mockResolvedValue([{ month: '2026-01' }]);
    await svc.rollupOldMonths({ now: new Date('2026-09-16T12:00:00Z') });
    prisma.$queryRaw.mockResolvedValue([{ count: 42 }]);
    prisma.$queryRaw.mockClear();
    await svc.report();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('AiUsageService — отчёт «за всё время» читает оба источника', () => {
  it('общие деньги и вызовы складываются из сырых строк и свёртки', async () => {
    // Забыть свёртку — значит показать заниженные деньги, причём тихо:
    // числа останутся правдоподобными.
    const { svc, prisma } = build();
    prisma.aiUsageMonthly.aggregate.mockResolvedValue({
      _sum: { costMicroUsd: 800n, calls: 5 },
    });
    const report = await svc.report();
    // Сырые: 1200 микродолларов и 7 вызовов (моки `build`).
    expect(report.totalMicroUsd).toBe(2000);
    expect(report.totalCalls).toBe(12);
  });

  it('разрез по провайдерам складывается по ключу', async () => {
    const { svc, prisma } = build();
    prisma.aiUsage.groupBy.mockImplementation(
      async (args: { by: readonly string[] }) =>
        args.by[0] === 'provider'
          ? [
              {
                provider: 'GEMINI',
                _sum: { costMicroUsd: 10 },
                _count: { _all: 1 },
              },
            ]
          : [],
    );
    prisma.aiUsageMonthly.groupBy.mockImplementation(
      async (args: { by: readonly string[] }) =>
        args.by[0] === 'provider'
          ? [
              {
                provider: 'GEMINI',
                _sum: { costMicroUsd: 90n, calls: 9 },
              },
              {
                provider: 'OPENAI',
                _sum: { costMicroUsd: 3n, calls: 1 },
              },
            ]
          : [],
    );
    const report = await svc.report();
    expect(report.byProvider).toEqual([
      { key: 'GEMINI', costMicroUsd: 100, calls: 10, characters: 0 },
      { key: 'OPENAI', costMicroUsd: 3, calls: 1, characters: 0 },
    ]);
  });

  it('символы синтеза в разрезе по операциям — из обоих источников (этап F)', async () => {
    // Приёмка §11 п.22 ТЗ на озвученную обучалку: «расход виден
    // отдельной операцией, с числом символов». Символы обязаны
    // складываться так же, как деньги: сырая половина без свёрнутой
    // — заниженное число без единой ошибки.
    const { svc, prisma } = build();
    prisma.aiUsage.groupBy.mockImplementation(
      async (args: { by: readonly string[]; _sum: Record<string, true> }) =>
        args.by[0] === 'operation'
          ? [
              {
                operation: 'voiceover',
                // Символы в группировке появляются, только если их
                // попросили: не попросишь — база вернёт одни деньги.
                _sum: {
                  costMicroUsd: 10,
                  characters: args._sum.characters ? 500 : undefined,
                },
                _count: { _all: 1 },
              },
            ]
          : [],
    );
    prisma.aiUsageMonthly.groupBy.mockImplementation(
      async (args: { by: readonly string[]; _sum: Record<string, true> }) =>
        args.by[0] === 'operation'
          ? [
              {
                operation: 'voiceover',
                _sum: {
                  costMicroUsd: 90n,
                  calls: 9,
                  characters: args._sum.characters ? 4500n : undefined,
                },
              },
            ]
          : [],
    );

    const report = await svc.report();

    expect(report.byOperation).toEqual([
      { key: 'voiceover', costMicroUsd: 100, calls: 10, characters: 5000 },
    ]);
  });

  it('в топ попадает человек, чей расход уже весь свёрнут', async () => {
    // База отсортировала только сырую часть — без пересортировки такой
    // пользователь не попал бы в топ вовсе.
    const { svc, prisma } = build();
    prisma.aiUsage.groupBy.mockImplementation(
      async (args: { by: readonly string[] }) =>
        args.by[0] === 'userId'
          ? [
              {
                userId: 'свежий',
                _sum: { costMicroUsd: 10 },
                _count: { _all: 1 },
              },
            ]
          : [],
    );
    prisma.aiUsageMonthly.groupBy.mockImplementation(
      async (args: { by: readonly string[] }) =>
        args.by[0] === 'userId'
          ? [
              {
                userId: 'старожил',
                _sum: { costMicroUsd: 500n, calls: 50 },
              },
            ]
          : [],
    );
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'старожил',
        telegramId: '1',
        username: null,
        isBlocked: false,
        plan: 'FREE',
      },
      {
        id: 'свежий',
        telegramId: '2',
        username: null,
        isBlocked: false,
        plan: 'FREE',
      },
    ]);
    const report = await svc.report(10);
    expect(report.top.map((u) => u.userId)).toEqual(['старожил', 'свежий']);
    expect(report.top[0].costMicroUsd).toBe(500);
  });

  it('вызовы без ставки считаются вместе со свёрнутыми', async () => {
    // Ради этого числа `unpriced` и попал в ключ свёртки: иначе оно
    // сползало бы к нулю по мере сворачивания месяцев — и «в прайсе нет
    // ставки» перестало бы быть видно.
    const { svc, prisma } = build();
    prisma.aiUsage.count.mockResolvedValue(7);
    prisma.aiUsageMonthly.aggregate.mockImplementation(
      async (args: { where?: { unpriced?: boolean } }) =>
        args.where?.unpriced
          ? { _sum: { costMicroUsd: 0n, calls: 4 } }
          : { _sum: { costMicroUsd: null, calls: null } },
    );
    const report = await svc.report();
    expect(report.unpricedCalls).toBe(11);
  });

  it('«плативших» считает база по объединению обеих таблиц, а не максимумом', async () => {
    // Множества пересекаются частично: максимум схлопнул бы
    // непересекающиеся половины, а делится на это число ПОЛНАЯ сумма,
    // включая свёрнутую, — среднее на человека завышалось бы.
    const { svc, prisma } = build();
    await svc.report();
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join(' ');
    expect(sql).toContain('"ai_usage_monthly"');
    expect(sql).toContain('UNION');
    expect(sql).not.toContain('UNION ALL');
  });

  it('среднее на сессию не смешивает источники', async () => {
    // `sessionId` в свёртку не входит, поэтому знаменатель — только
    // сырые сессии. Со свёрнутым числителем дробь росла бы без предела.
    const { svc, prisma } = build({ rawResult: [{ count: 4 }] });
    prisma.aiUsageMonthly.aggregate.mockResolvedValue({
      _sum: { costMicroUsd: 800n, calls: 5 },
    });
    const report = await svc.report();
    // Сырых 1200 на 4 сессии — 300; со свёрнутыми 2000 было бы 500.
    expect(report.avgPerSessionMicroUsd).toBe(300);
  });

  it('сырая половина кандидата из свёртки не теряется в топе', async () => {
    // Сырой топ обрезан базой десятью строками и про этого человека не
    // знает. Если не досчитать его сырые деньги отдельно, они пропадут
    // и из суммы в таблице, и из порядка строк.
    const { svc, prisma } = build();
    prisma.aiUsage.groupBy.mockImplementation(
      async (args: {
        by: readonly string[];
        take?: number;
        where?: { userId?: { in?: string[] } };
      }) => {
        if (args.by[0] !== 'userId') return [];
        // Топ-N из базы: этого человека там нет.
        if (args.take) return [];
        // Досчёт по списку кандидатов.
        return args.where?.userId?.in?.includes('старожил')
          ? [
              {
                userId: 'старожил',
                _sum: { costMicroUsd: 40 },
                _count: { _all: 2 },
              },
            ]
          : [];
      },
    );
    prisma.aiUsageMonthly.groupBy.mockImplementation(
      async (args: { by: readonly string[] }) =>
        args.by[0] === 'userId'
          ? [{ userId: 'старожил', _sum: { costMicroUsd: 500n, calls: 50 } }]
          : [],
    );
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'старожил',
        telegramId: '1',
        username: null,
        isBlocked: false,
        plan: 'FREE',
      },
    ]);
    const report = await svc.report(10);
    expect(report.top).toHaveLength(1);
    expect(report.top[0].costMicroUsd).toBe(540);
    expect(report.top[0].calls).toBe(52);
  });

  it('разбивка по операциям в карточке пользователя тоже из двух источников', async () => {
    const { svc, prisma } = build();
    prisma.aiUsage.groupBy.mockResolvedValue([
      { operation: 'prompt', _sum: { costMicroUsd: 4 }, _count: { _all: 2 } },
    ]);
    prisma.aiUsageMonthly.groupBy.mockResolvedValue([
      { operation: 'prompt', _sum: { costMicroUsd: 6n, calls: 3 } },
    ]);
    const rows = await svc.breakdownForUser('u1');
    expect(rows).toEqual([
      { key: 'prompt', costMicroUsd: 10, calls: 5, characters: 0 },
    ]);
  });

  it('в карточке пользователя символы тоже складываются из двух источников (этап F)', async () => {
    // Карточка фикстурного пользователя — второе место, где видна
    // озвучка обучалки: весь её расход записан на него.
    const { svc, prisma } = build();
    prisma.aiUsage.groupBy.mockResolvedValue([
      {
        operation: 'tutorial-voiceover',
        _sum: { costMicroUsd: 4, characters: 120 },
        _count: { _all: 1 },
      },
    ]);
    prisma.aiUsageMonthly.groupBy.mockResolvedValue([
      {
        operation: 'tutorial-voiceover',
        _sum: { costMicroUsd: 6n, calls: 2, characters: 360 },
      },
    ]);
    const rows = await svc.breakdownForUser('u1');
    expect(rows).toEqual([
      {
        key: 'tutorial-voiceover',
        costMicroUsd: 10,
        calls: 3,
        characters: 480,
      },
    ]);
  });
});

describe('AiUsageService.report — тестовые аккаунты (TODO §III п.37)', () => {
  const withTestUsers = () => {
    const { svc, prisma } = build();
    prisma.user.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    return { svc, prisma };
  };

  const aggregateWheres = (prisma: any) =>
    prisma.aiUsage.aggregate.mock.calls.map((c: any) => c[0].where);

  it('расход тестовых вынесен в свой блок, а не растворён в общем', async () => {
    const { svc } = withTestUsers();
    const report = await svc.report();
    expect(report.testUsers.accounts).toBe(2);
    // aggregate-двойник отдаёт 1200 на любой запрос; важно, что блок
    // считается и не остаётся нулевым при наличии таких аккаунтов.
    expect(report.testUsers.costMicroUsd).toBe(1200);
  });

  it('тестовые исключены из всех денежных срезов', async () => {
    const { svc, prisma } = withTestUsers();
    await svc.report();
    const excluded = aggregateWheres(prisma).filter((w: any) =>
      w?.OR?.some((b: any) => b.userId?.notIn),
    );
    // Всего время, три окна и сумма по вошедшим — пять срезов.
    expect(excluded.length).toBeGreaterThanOrEqual(5);
    for (const w of excluded) {
      expect(w.OR).toEqual([
        { userId: null },
        { userId: { notIn: ['t1', 't2'] } },
      ]);
    }
  });

  it('исключение НЕ выбрасывает анонимный расход', async () => {
    // `userId NOT IN (...)` для NULL даёт NULL, то есть анонимные
    // выпали бы из отчёта целиком — а к тестовым аккаунтам они
    // отношения не имеют. Ветка `userId: null` в OR и есть страховка.
    const { svc, prisma } = withTestUsers();
    await svc.report();
    for (const w of aggregateWheres(prisma)) {
      if (!w?.OR) continue;
      expect(w.OR).toContainEqual({ userId: null });
    }
  });

  it('срез анонимных не трогается исключением вовсе', async () => {
    // У анонимной строки владельца нет, фильтровать её по тестовым
    // нечем и незачем.
    const { svc, prisma } = withTestUsers();
    await svc.report();
    const anon = aggregateWheres(prisma).find((w: any) => w?.anonymous);
    expect(anon).toEqual({ anonymous: true });
  });

  it('топ пользователей тоже без тестовых', async () => {
    // Иначе тестировщик стабильно занимает первую строку таблицы «кто
    // больше всех тратит», и смотреть её становится незачем.
    const { svc, prisma } = withTestUsers();
    await svc.report(10);
    const top = prisma.aiUsage.groupBy.mock.calls
      .map((c: any) => c[0])
      .find((a: any) => Array.isArray(a.by) && a.by[0] === 'userId');
    expect(top.where.OR).toEqual([
      { userId: null },
      { userId: { notIn: ['t1', 't2'] } },
    ]);
  });

  it('разрезы по провайдеру и операции считаются по тому же условию', async () => {
    const { svc, prisma } = withTestUsers();
    await svc.report();
    const buckets = prisma.aiUsage.groupBy.mock.calls
      .map((c: any) => c[0])
      .filter((a: any) => Array.isArray(a.by) && a.by[0] !== 'userId')
      // Разрез ВНУТРИ блока тестовых считается по обратному условию
      // (`userId: { in: [...] }`) — он и должен видеть только их.
      .filter((a: any) => a.where?.userId?.in === undefined);
    expect(buckets.length).toBeGreaterThan(0);
    for (const b of buckets) {
      expect(b.where.OR).toContainEqual({ userId: { notIn: ['t1', 't2'] } });
    }
  });

  it('расход обучалки виден в блоке тестовых поимённо, а не одной суммой', async () => {
    // Он весь пишется на фикстурного исполнителя, а тот помечен
    // тестовым: в общей таблице операций его нет по построению. Без
    // этого разреза строка «Сборка обучающего видео» не
    // отрисовалась бы ни разу, и вопрос «сколько стоит обучалка за
    // ночь» — тот самый, ради которого заводилась отдельная
    // операция, — остался бы без ответа (находка повторного
    // сквозного аудита A+B+C).
    const { svc, prisma } = withTestUsers();
    prisma.aiUsage.groupBy.mockImplementation(async (args: any) =>
      args.where?.userId?.in
        ? [
            {
              operation: 'tutorial-video-assembly',
              _sum: { costMicroUsd: 300 },
              _count: { _all: 30 },
            },
          ]
        : [],
    );

    const report = await svc.report();

    expect(report.testUsers.byOperation).toEqual([
      {
        key: 'tutorial-video-assembly',
        costMicroUsd: 300,
        calls: 30,
        characters: 0,
      },
    ]);
    // И в общих числах её по-прежнему нет — блоки не складывают.
    expect(report.byOperation).toEqual([]);
  });

  it('подписи операций приезжают с отчётом — второй копии в админке нет', async () => {
    // Копия там была и уже разошлась: из сорока операций в ней жило
    // тринадцать, остальные рисовались сырым ключом.
    const { svc } = withTestUsers();

    const report = await svc.report();

    expect(report.operationLabels['tutorial-video-assembly']).toBe(
      'Сборка обучающего видео (ffmpeg)',
    );
    // Этап F: своя строка у озвучки обучалки, а не общая «Озвучка».
    expect(report.operationLabels['tutorial-voiceover']).toBe(
      'Озвучка обучающего видео',
    );
    expect(Object.keys(report.operationLabels).length).toBeGreaterThan(30);
  });

  it('у блока тестовых — свой разрез по операциям, по обратному условию', async () => {
    // Без него расход ночной обучалки не показывается НИГДЕ: он
    // пишется на фикстурного исполнителя, тот помечен тестовым, а
    // тестовые исключены из всех остальных чисел отчёта. Строка
    // «Сборка обучающего видео» не отрисовалась бы ни разу (находка
    // повторного сквозного аудита A+B+C).
    const { svc, prisma } = withTestUsers();

    await svc.report();

    const own = prisma.aiUsage.groupBy.mock.calls
      .map((c: any) => c[0])
      .filter((a: any) => a.where?.userId?.in !== undefined);
    expect(own).toHaveLength(1);
    expect(own[0].by).toEqual(['operation']);
    expect(own[0].where.userId.in).toEqual(['t1', 't2']);
  });

  it('число плативших считает база связью с users, без массива в параметре', async () => {
    // Статический SQL: массив идентификаторов в плейсхолдере — лишний
    // способ ошибиться там, где ошибка ломает вкладку расходов целиком.
    const { svc, prisma } = withTestUsers();
    await svc.report();
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join(' ');
    expect(sql).toContain('JOIN "users"');
    expect(sql).toContain('u."isTestUser" = false');
  });
});

describe('AiUsageService.forUsers — форма строк (повторный аудит этапа F)', () => {
  it('строки одинаковы по форме, откуда бы ни пришли', async () => {
    // `rolledBuckets` отдаёт `UnitTotals` — с символами. Спред
    // протащил бы их СЮДА только тем, у кого расход целиком свёрнут:
    // у одного пользователя в карте два поля, у другого три. Типом
    // это не ловится — проверка лишних свойств на спред-выражения в
    // TS не распространяется, — а следующий вызывающий, который
    // отдаст карту наружу, получит неоднородный список.
    const { svc, prisma } = build();
    // `u-raw` пришёл из сырого журнала, `u-rolled` — только из свёртки.
    prisma.aiUsage.groupBy.mockResolvedValue([
      { userId: 'u-raw', _sum: { costMicroUsd: 12 }, _count: { _all: 3 } },
    ]);
    prisma.aiUsageMonthly.groupBy.mockResolvedValue([
      {
        userId: 'u-rolled',
        _sum: { costMicroUsd: 9, calls: 3, characters: 300 },
      },
    ]);

    const out = await svc.forUsers(['u-raw', 'u-rolled']);

    expect(Object.keys(out).sort()).toEqual(['u-raw', 'u-rolled']);
    for (const row of Object.values(out)) {
      expect(Object.keys(row).sort()).toEqual(['calls', 'costMicroUsd']);
    }
  });
});

// C1 захода 8 (ТЗ поздравлений 2.0 стр. 1940): звук на входе Gemini —
// по своей ставке, и потолок голоса В-14 видит эту сумму.
describe('AiUsageService.recordGemini — вход по модальностям', () => {
  const audioResponse = {
    usageMetadata: {
      promptTokenCount: 10_000,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 0,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 2_000 },
        { modality: 'AUDIO', tokenCount: 8_000 },
      ],
    },
  };

  it('звук 2.5 Flash считается по звуковой ставке', async () => {
    const { svc, prisma } = build();
    await svc.recordGemini(audioResponse, {
      operation: 'voice-assistant-stt',
      model: 'gemini-2.5-flash',
      userId: 'u1',
    });
    const data = prisma.aiUsage.create.mock.calls[0][0].data;
    // 8000 × $1.00/M + 2000 × $0.30/M + 100 × $2.50/M = 8000 + 600 + 250.
    expect(data.costMicroUsd).toBe(8_850);
    // В строку пишется то, что пришло от провайдера, — весь вход.
    expect(data.inputTokens).toBe(10_000);
    expect(data.outputTokens).toBe(100);
  });

  it('без promptTokensDetails — как раньше, весь вход по текстовой', async () => {
    const { svc, prisma } = build();
    await svc.recordGemini(
      {
        usageMetadata: {
          promptTokenCount: 10_000,
          cachedContentTokenCount: 1_000,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 40,
        },
      },
      { operation: 'voice-assistant-stt', model: 'gemini-2.5-flash' },
    );
    const data = prisma.aiUsage.create.mock.calls[0][0].data;
    // 9000 × $0.30 + 1000 × $0.03 + 140 × $2.50 (за 1M) = 2700 + 30 + 350.
    expect(data.costMicroUsd).toBe(3_080);
    expect(data.cachedInputTokens).toBe(1_000);
    expect(data.outputTokens).toBe(140);
  });

  it('пустой ответ не роняет запись', async () => {
    const { svc, prisma } = build();
    await svc.recordGemini(undefined, {
      operation: 'prompt',
      model: 'gemini-2.5-flash',
    });
    const data = prisma.aiUsage.create.mock.calls[0][0].data;
    expect(data.inputTokens).toBe(0);
    expect(data.costMicroUsd).toBe(0);
  });

  it('потолок голоса В-14 видит звуковую сумму, а не текстовую', async () => {
    // Журнал в памяти: `create` пишет строку, `aggregate` складывает её
    // так же, как `VoiceBudgetService.stateOf` просит у базы.
    const rows: Array<Record<string, any>> = [];
    const { svc, prisma } = build();
    prisma.aiUsage.create.mockImplementation(async ({ data }: any) => {
      rows.push({ ...data, createdAt: new Date() });
      return data;
    });
    prisma.aiUsage.aggregate.mockImplementation(async ({ where }: any) => {
      const ops: string[] = where.operation?.in ?? [];
      const sum = rows
        .filter(
          (r) =>
            (where.userId === undefined || r.userId === where.userId) &&
            (ops.length === 0 || ops.includes(r.operation)) &&
            r.createdAt >= where.createdAt.gte,
        )
        .reduce((s, r) => s + r.costMicroUsd, 0);
      return { _sum: { costMicroUsd: rows.length ? sum : null } };
    });
    const plans = {
      accessOf: jest.fn().mockResolvedValue({ spendPlan: 'LITE' }),
    };
    // Потолок $0.01 (10 000 микродолларов).
    const settings = { get: jest.fn().mockResolvedValue('0.01') };
    const budget = new VoiceBudgetService(
      prisma as any,
      plans as any,
      settings as any,
    );

    // Одна реплика: 8850 микродолларов по звуковой ставке (по текстовой
    // было бы 3250) — после второй потолок обязан быть выбран.
    for (let i = 0; i < 2; i++) {
      await svc.recordGemini(audioResponse, {
        operation: 'voice-assistant-stt',
        model: 'gemini-2.5-flash',
        userId: 'u1',
      });
    }
    const state = await budget.stateOf('u1');
    expect(state.spentUsd).toBeCloseTo(0.0177, 6);
    expect(state.exhausted).toBe(true);
  });
});
