import { UnauthorizedException } from '@nestjs/common';
import { TelegramIdentityGuard } from './telegram-identity.guard';

const ctx = (req: object) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;

describe('TelegramIdentityGuard', () => {
  const guard = new TelegramIdentityGuard();
  it('passes when the middleware set telegramUserId', () => {
    expect(guard.canActivate(ctx({ telegramUserId: 'u1' }))).toBe(true);
  });
  it('401s an anonymous request (middleware set nothing)', () => {
    expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx({ telegramUserId: '' }))).toThrow(
      UnauthorizedException,
    );
  });
});
