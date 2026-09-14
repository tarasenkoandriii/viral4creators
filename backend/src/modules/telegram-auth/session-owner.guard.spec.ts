/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Б-3.4: чужой `sessionId` больше не ключ к чужому бюджету.
 *
 * Модель «UUID сессии — предъявитель» законна для анонимного сценария и
 * остаётся; но у сессии с владельцем по этому же идентификатору
 * доставались платные вызовы за чужой счёт, приватные разборы владельца
 * и сброс его выбора сцен.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { SessionOwnerGuard, sessionIdFromRequest } from './session-owner.guard';

function ctx(req: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

function build(userId: string | null | undefined, affected = 1) {
  const prisma = {
    session: {
      findUnique: jest
        .fn()
        .mockResolvedValue(userId === undefined ? null : { userId }),
    },
    $executeRaw: jest.fn().mockResolvedValue(affected),
  };
  return { guard: new SessionOwnerGuard(prisma as any), prisma };
}

describe('sessionIdFromRequest', () => {
  it('берёт из пути, затем из строки запроса', () => {
    expect(sessionIdFromRequest({ params: { sessionId: 's1' } })).toBe('s1');
    expect(sessionIdFromRequest({ query: { sessionId: 's2' } })).toBe('s2');
    expect(
      sessionIdFromRequest({
        params: { sessionId: 's1' },
        query: { sessionId: 's2' },
      }),
    ).toBe('s1');
  });

  it('нет параметра — нет и проверки', () => {
    expect(sessionIdFromRequest({})).toBeNull();
    expect(sessionIdFromRequest({ params: { id: 'pr1' } })).toBeNull();
    // `?sessionId=a&sessionId=b` приходит массивом: такому запросу
    // доверять нельзя, и разбирать его незачем.
    expect(
      sessionIdFromRequest({ query: { sessionId: ['a', 'b'] } }),
    ).toBeNull();
  });
});

describe('SessionOwnerGuard — admin-периметр (М-4.1 седьмого аудита)', () => {
  it('/api/admin/actors/:sessionId/* пропускается без чтения сессии — там свой AdminSessionGuard', async () => {
    const { guard, prisma } = build('owner-1');
    const ok = await guard.canActivate(
      ctx({
        originalUrl: '/api/admin/actors/s1/status',
        params: { sessionId: 's1' },
        telegramUserId: undefined,
      }),
    );
    expect(ok).toBe(true);
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('обычный маршрут с тем же параметром по-прежнему проверяет владельца', async () => {
    const { guard } = build('owner-1');
    await expect(
      guard.canActivate(
        ctx({
          originalUrl: '/api/sessions/s1/video',
          params: { sessionId: 's1' },
          telegramUserId: 'someone-else',
        }),
      ),
    ).rejects.toBeDefined();
  });
});

describe('SessionOwnerGuard (Б-3.4)', () => {
  it('чужая сессия с владельцем — отказ', async () => {
    const { guard } = build('u1');
    await expect(
      guard.canActivate(
        ctx({ params: { sessionId: 's1' }, telegramUserId: 'u2' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('без личности к сессии с владельцем не пускают', async () => {
    // Ровно этот случай и был дырой: знать UUID достаточно, чтобы
    // тратить чужой дневной бюджет.
    const { guard } = build('u1');
    await expect(
      guard.canActivate(ctx({ params: { sessionId: 's1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('владелец проходит', async () => {
    const { guard } = build('u1');
    await expect(
      guard.canActivate(
        ctx({ params: { sessionId: 's1' }, telegramUserId: 'u1' }),
      ),
    ).resolves.toBe(true);
  });

  it('анонимная сессия работает как раньше', async () => {
    // Половина продукта живёт без аккаунта — сломать её значило бы
    // «закрыть» дыру ценой самой функции.
    const { guard, prisma } = build(null);
    await expect(
      guard.canActivate(ctx({ params: { sessionId: 's1' } })),
    ).resolves.toBe(true);
    // Анонимный запрос ничью сессию не привязывает — некому.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('опознанный запрос к ничьей сессии делает её своей (В-3.4)', async () => {
    // Сессия заводится до входа, кнопка входа её не пересоздаёт: без
    // привязки вошедший до конца сессии оставался анонимом — без защиты
    // гварда, с гостевым бюджетом и правами LITE.
    const { guard, prisma } = build(null);
    await expect(
      guard.canActivate(
        ctx({ params: { sessionId: 's1' }, telegramUserId: 'u1' }),
      ),
    ).resolves.toBe(true);
    const [parts, ...params] = prisma.$executeRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const sql = parts.join('?');
    // Условный UPDATE: только если владелец всё ещё не записан.
    expect(sql).toContain('SET "userId" = ?');
    expect(sql).toContain('AND "userId" IS NULL');
    expect(params).toEqual(['u1', 's1']);
  });

  it('проиграл гонку за привязку другому — отказ по факту, не по намерению', async () => {
    const { guard, prisma } = build(null, 0);
    prisma.session.findUnique
      .mockResolvedValueOnce({ userId: null })
      .mockResolvedValueOnce({ userId: 'u2' });
    await expect(
      guard.canActivate(
        ctx({ params: { sessionId: 's1' }, telegramUserId: 'u1' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('проиграл гонку самому себе (два своих запроса) — проходит', async () => {
    const { guard, prisma } = build(null, 0);
    prisma.session.findUnique
      .mockResolvedValueOnce({ userId: null })
      .mockResolvedValueOnce({ userId: 'u1' });
    await expect(
      guard.canActivate(
        ctx({ params: { sessionId: 's1' }, telegramUserId: 'u1' }),
      ),
    ).resolves.toBe(true);
  });

  it('несуществующая сессия — не наше дело: 404 отдаст обработчик', async () => {
    const { guard } = build(undefined);
    await expect(
      guard.canActivate(ctx({ params: { sessionId: 'нет' } })),
    ).resolves.toBe(true);
  });

  it('маршрут без sessionId не стоит ни одного запроса в базу', async () => {
    // Гвард глобальный: он висит на КАЖДОМ запросе, включая админские и
    // `POST /sessions`. Лишний запрос там был бы налогом на всё.
    const { guard, prisma } = build('u1');
    await expect(
      guard.canActivate(ctx({ params: { id: 'pr1' } })),
    ).resolves.toBe(true);
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('sessionId в строке запроса проверяется так же', async () => {
    // `GET /library/recommend?sessionId=…` отдавал приватные разборы
    // владельца сессии кому угодно.
    const { guard } = build('u1');
    await expect(
      guard.canActivate(
        ctx({ query: { sessionId: 's1' }, telegramUserId: 'u2' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('в базу уходит выборка только владельца, по первичному ключу', async () => {
    const { guard, prisma } = build('u1');
    await guard.canActivate(
      ctx({ params: { sessionId: 's1' }, telegramUserId: 'u1' }),
    );
    expect(prisma.session.findUnique).toHaveBeenCalledWith({
      where: { id: 's1' },
      select: { userId: true },
    });
  });
});
