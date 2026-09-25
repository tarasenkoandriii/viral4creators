jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { hashApiKey, issueApiKey } from '../../common/api-key';

/**
 * Этап 144. Гвард внешнего API: ключ, режим, блокировка.
 */
const SECRET = issueApiKey().secret;

const ctx = (authorization?: string) => {
  const request = { headers: { authorization } } as never;
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as never,
  };
};

function build(
  over: {
    key?: Record<string, unknown> | null;
    plan?: string;
    blocked?: boolean;
  } = {},
) {
  const prisma = {
    apiKey: {
      findUnique: jest.fn().mockResolvedValue(
        'key' in over
          ? over.key
          : {
              id: 'k1',
              userId: 'u1',
              revokedAt: null,
              lastUsedAt: null,
            },
      ),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const plans = {
    accessOf: jest.fn().mockResolvedValue({
      plan: over.plan ?? 'PREMIUM',
      spendPlan: over.plan ?? 'PREMIUM',
      isBlocked: over.blocked ?? false,
      blockedReason: over.blocked ? 'подозрение на накрутку' : null,
      isTestUser: false,
      freeScenarios: [],
    }),
    assertNotBlocked: jest.fn((access: { isBlocked: boolean }) => {
      if (access.isBlocked)
        throw new ForbiddenException('Аккаунт заблокирован');
    }),
  };
  return {
    guard: new ApiKeyGuard(prisma as never, plans as never),
    prisma,
    plans,
  };
}

describe('ApiKeyGuard', () => {
  it('верный ключ пускает и кладёт на запрос ТО ЖЕ поле, что вход из мини-аппа', async () => {
    // Иначе каждую проверку прав, написанную для мини-аппа, пришлось бы
    // писать второй раз — и она молча не сработала бы для API.
    const { guard, prisma } = build();
    const { request, context } = ctx(`Bearer ${SECRET}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect((request as { telegramUserId?: string }).telegramUserId).toBe('u1');
    expect((request as { apiKeyId?: string }).apiKeyId).toBe('k1');
    // Ищем по ХЕШУ, а не по секрету: в базе секрета нет вовсе.
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: hashApiKey(SECRET) },
    });
  });

  it('без заголовка — 401 с подсказкой, что именно прислать', async () => {
    const { guard } = build();
    await expect(guard.canActivate(ctx().context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('отозванный ключ отвечает как несуществующий', async () => {
    // Знать, что ключ когда-то был верным, тому, кто его предъявил,
    // незачем.
    const revoked = build({
      key: { id: 'k1', userId: 'u1', revokedAt: new Date(), lastUsedAt: null },
    });
    const missing = build({ key: null });

    const a = await revoked.guard
      .canActivate(ctx(`Bearer ${SECRET}`).context)
      .catch((e: Error) => e.message);
    const b = await missing.guard
      .canActivate(ctx(`Bearer ${SECRET}`).context)
      .catch((e: Error) => e.message);

    expect(a).toBe(b);
  });

  it('режим ниже Premium — 403, и сказано, что дело в режиме, а не в ключе', async () => {
    const { guard } = build({ plan: 'STANDARD' });
    const failure = await guard
      .canActivate(ctx(`Bearer ${SECRET}`).context)
      .catch((e: Error) => e);
    expect(failure).toBeInstanceOf(ForbiddenException);
    expect((failure as Error).message).toMatch(/Premium/);
  });

  it('заблокированный аккаунт не входит, даже с верным ключом', async () => {
    const { guard } = build({ blocked: true });
    await expect(
      guard.canActivate(ctx(`Bearer ${SECRET}`).context),
    ).rejects.toThrow(ForbiddenException);
  });

  it('«последнее использование» не пишется на каждый вызов', async () => {
    // Запись на каждый вызов — плата за наблюдаемость на самом горячем
    // пути внешнего API.
    const { guard, prisma } = build({
      key: {
        id: 'k1',
        userId: 'u1',
        revokedAt: null,
        lastUsedAt: new Date(),
      },
    });
    await guard.canActivate(ctx(`Bearer ${SECRET}`).context);
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('первая отметка всё-таки пишется', async () => {
    const { guard, prisma } = build();
    await guard.canActivate(ctx(`Bearer ${SECRET}`).context);
    expect(prisma.apiKey.update).toHaveBeenCalled();
  });

  it('сбой записи отметки не отменяет вызов', async () => {
    // Отметка «ключом ещё пользуются» не стоит того, чтобы из-за неё
    // отказать в вызове.
    const { guard, prisma } = build();
    prisma.apiKey.update.mockRejectedValue(new Error('база недоступна'));
    await expect(
      guard.canActivate(ctx(`Bearer ${SECRET}`).context),
    ).resolves.toBe(true);
  });
});
