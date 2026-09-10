/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { AiUsageService } from './ai-usage.service';

function build(over: { rawResult?: unknown } = {}) {
  const prisma = {
    aiUsage: {
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(7),
      aggregate: jest.fn().mockResolvedValue({ _sum: { costMicroUsd: 1200 } }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ pricingVersion: '2026-09-06' }),
    },
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
    expect(sql).toContain('count(DISTINCT "sessionId")');
    // Без этого условия анонимные вызовы без сессии считались бы одной
    // «сессией» и завышали бы знаменатель среднего.
    expect(sql).toContain('"sessionId" IS NOT NULL');
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
