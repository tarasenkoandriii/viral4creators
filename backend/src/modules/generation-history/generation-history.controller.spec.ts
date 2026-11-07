import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RATE_LIMIT_KEY, RateLimitGuard } from '../../common/rate-limit';
import { GenerationHistoryController } from './generation-history.controller';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('generation history read API contract', () => {
  it('requires verified identity via existing guard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, GenerationHistoryController),
    ).toContain(TelegramIdentityGuard);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, GenerationHistoryController),
    ).toContain(RateLimitGuard);
    expect(
      Reflect.getMetadata(
        RATE_LIMIT_KEY,
        GenerationHistoryController.prototype.list,
      ),
    ).toEqual({
      name: 'generation-history-read',
      limit: 60,
      windowSec: 60,
      by: 'user',
    });
    const guard = new TelegramIdentityGuard();
    expect(() =>
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ body: { userId: 'A' } }) }),
      } as never),
    ).toThrow();
  });
  it('takes ownership only from the verified request, not pagination or body', () => {
    const history = { list: jest.fn() };
    const controller = new GenerationHistoryController(history as never);
    controller.list(
      { telegramUserId: 'A', body: { userId: 'B' } } as never,
      '10',
      'cursor',
    );
    expect(history.list).toHaveBeenCalledWith('A', 10, 'cursor');
  });
});
