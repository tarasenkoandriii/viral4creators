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
