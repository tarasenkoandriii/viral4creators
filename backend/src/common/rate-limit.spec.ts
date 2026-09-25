/**
 * Ограничитель частоты (этап 54, Б-3.7): решение принимает база одним
 * запросом; здесь — форма запроса, вердикт по счётчику, адрес за прокси и
 * поведение при отказе базы. Живой Postgres проверял атомарность вручную
 * (три параллельных INSERT → count 1, 2, 3; новое окно → 1).
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { HttpException, Logger } from '@nestjs/common';
import {
  clientIp,
  pruneRateLimits,
  RATE_LIMIT_KEY,
  RateLimitGuard,
  RateLimitRule,
} from './rate-limit';

function build(count: number | Error, rule?: RateLimitRule) {
  const prisma = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(3),
  };
  if (count instanceof Error) prisma.$queryRaw.mockRejectedValue(count);
  else prisma.$queryRaw.mockResolvedValue([{ count }]);
  const reflector = {
    get: jest.fn((key: string) => (key === RATE_LIMIT_KEY ? rule : undefined)),
  };
  const guard = new RateLimitGuard(reflector as never, prisma as never);
  const setHeader = jest.fn();
  const context = (headers: Record<string, string> = {}) => ({
    getHandler: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip: '10.0.0.1', socket: {} }),
      getResponse: () => ({ setHeader }),
    }),
  });
  return { guard, prisma, context, setHeader };
}

const RULE: RateLimitRule = { name: 'login', limit: 3, windowSec: 60 };

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('RateLimitGuard', () => {
  it('без правила на маршруте — пропускает и базу не трогает', async () => {
    const { guard, prisma, context } = build(1);
    await expect(guard.canActivate(context() as never)).resolves.toBe(true);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('в пределах лимита — пропускает; ключ = имя|адрес, окно — начало минуты', async () => {
    const { guard, prisma, context } = build(3, RULE);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T10:15:42.500Z'));
    try {
      await expect(
        guard.canActivate(
          context({ 'x-forwarded-for': '203.0.113.7, 10.1.1.1' }) as never,
        ),
      ).resolves.toBe(true);
    } finally {
      jest.useRealTimers();
    }
    const [strings, ...params] = prisma.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?');
    expect(sql).toContain('INSERT INTO "rate_limits"');
    expect(sql).toContain('ON CONFLICT ("key") DO UPDATE');
    expect(sql).toContain('RETURNING "count"');
    expect(params[0]).toBe('login|203.0.113.7');
    // Окно выровнено по минуте, а не «сейчас минус 60 секунд».
    expect(params[1]).toEqual(new Date('2026-09-07T10:15:00.000Z'));
  });

  it('лимит превышен — 429 с Retry-After до конца окна', async () => {
    const { guard, context, setHeader } = build(4, RULE);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T10:15:42.500Z'));
    try {
      await expect(guard.canActivate(context() as never)).rejects.toMatchObject(
        {
          status: 429,
        } as Partial<HttpException>,
      );
    } finally {
      jest.useRealTimers();
    }
    // До 10:16:00 осталось 17,5 с → 18.
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '18');
  });

  it('база не отвечает — запрос пропущен, а не отклонён', async () => {
    const { guard, context } = build(new Error('ECONNREFUSED'), RULE);
    await expect(guard.canActivate(context() as never)).resolves.toBe(true);
  });

  it('счётчик из базы приходит bigint-ом — сравнение всё равно числовое', async () => {
    const { guard, prisma, context } = build(1, RULE);
    prisma.$queryRaw.mockResolvedValue([{ count: 5n }]);
    await expect(guard.canActivate(context() as never)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

/**
 * Два правила на одном маршруте (ассистент на лендинге, ТЗ §7.1) —
 * `@RateLimit([ruleA, ruleB])`. Проверяется отдельно от одноправильных
 * тестов выше, чтобы смена формата метаданных (объект → массив) не
 * задела существующие ~10 маршрутов, которые продолжают присылать
 * одно правило (уже покрыто тестами выше — `build(..., RULE)` кладёт
 * ровно объект, не массив, и они по-прежнему проходят).
 */
describe('RateLimitGuard — два правила (§7.1)', () => {
  const NARROW: RateLimitRule = {
    name: 'assistant-chat',
    limit: 10,
    windowSec: 60,
  };
  const WIDE: RateLimitRule = {
    name: 'assistant-chat-hour',
    limit: 60,
    windowSec: 3600,
  };

  function buildMulti(
    rules: RateLimitRule[],
    responses: Array<number | Error>,
  ) {
    const prisma = { $queryRaw: jest.fn(), $executeRaw: jest.fn() };
    for (const r of responses) {
      if (r instanceof Error) prisma.$queryRaw.mockRejectedValueOnce(r);
      else prisma.$queryRaw.mockResolvedValueOnce([{ count: r }]);
    }
    const reflector = { get: jest.fn(() => rules) };
    const guard = new RateLimitGuard(reflector as never, prisma as never);
    const context = {
      getHandler: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, ip: '10.0.0.1', socket: {} }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    };
    return { guard, prisma, context };
  }

  it('обе проверки в пределах лимита — пропускает, обе учтены в базе', async () => {
    const { guard, prisma, context } = buildMulti([NARROW, WIDE], [3, 20]);
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('первое (узкое) правило превышено — 429, второе не проверяется', async () => {
    const { guard, prisma, context } = buildMulti([NARROW, WIDE], [11]);
    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('узкое ок, широкое превышено — 429 после обеих проверок', async () => {
    const { guard, prisma, context } = buildMulti([NARROW, WIDE], [5, 61]);
    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('clientIp', () => {
  it('первый адрес из x-forwarded-for; без заголовка — адрес сокета', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '198.51.100.2, 10.0.0.9' },
        ip: '10.0.0.9',
      } as never),
    ).toBe('198.51.100.2');
    expect(clientIp({ headers: {}, ip: '127.0.0.1' } as never)).toBe(
      '127.0.0.1',
    );
    expect(
      clientIp({ headers: {}, socket: { remoteAddress: '::1' } } as never),
    ).toBe('::1');
    expect(clientIp({ headers: {} } as never)).toBe('unknown');
  });
});

describe('pruneRateLimits', () => {
  it('удаляет окна старше часа', async () => {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(7) };
    const now = new Date('2026-09-07T12:00:00Z');
    await expect(pruneRateLimits(prisma as never, now)).resolves.toBe(7);
    const [strings, cutoff] = prisma.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('DELETE FROM "rate_limits"');
    expect(cutoff).toEqual(new Date('2026-09-07T11:00:00Z'));
  });
});

/**
 * Аудит этапа 148: платное действие в мини-аппе нельзя считать по
 * адресу — за ним сидит сотовый оператор.
 */
describe('RateLimitGuard — счёт по человеку (by: user)', () => {
  function withUser(telegramUserId?: string) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const rule: RateLimitRule = {
      name: 'paid',
      limit: 10,
      windowSec: 600,
      by: 'user',
    };
    const reflector = {
      get: jest.fn((key: string) =>
        key === RATE_LIMIT_KEY ? rule : undefined,
      ),
    };
    const guard = new RateLimitGuard(reflector as never, prisma as never);
    const context = {
      getHandler: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-forwarded-for': '203.0.113.7' },
          ip: '10.0.0.1',
          socket: {},
          telegramUserId,
        }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    };
    return { guard, prisma, context };
  }

  it('окно принадлежит человеку, а не адресу', async () => {
    // Иначе соседи по NAT выбирают чужое окно, ничего дурного не
    // сделав, а тот, от кого лимит защищает, меняет адрес.
    const { guard, prisma, context } = withUser('u1');
    await guard.canActivate(context as never);
    const key = String(prisma.$queryRaw.mock.calls[0][1]);
    expect(key).toBe('paid|u:u1');
    expect(key).not.toContain('203.0.113.7');
  });

  it('у двух человек за одним адресом окна разные', async () => {
    const a = withUser('u1');
    const b = withUser('u2');
    await a.guard.canActivate(a.context as never);
    await b.guard.canActivate(b.context as never);
    expect(String(a.prisma.$queryRaw.mock.calls[0][1])).not.toBe(
      String(b.prisma.$queryRaw.mock.calls[0][1]),
    );
  });

  it('безымянный запрос откатывается к адресу, а не сливается с чужими', async () => {
    // Общее окно для всех анонимных означало бы, что первый же гость
    // закрывает вход остальным.
    const { guard, prisma, context } = withUser(undefined);
    await guard.canActivate(context as never);
    expect(String(prisma.$queryRaw.mock.calls[0][1])).toBe('paid|203.0.113.7');
  });
});
