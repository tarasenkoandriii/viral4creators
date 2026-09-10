/**
 * OriginGuard (этап 49, В-3.2): маршруты входа и выхода проверяют
 * `Origin` сами — иначе форма с чужого сайта сажает нового посетителя в
 * аккаунт злоумышленника или выкидывает оператора.
 */
import { ForbiddenException } from '@nestjs/common';
import { OriginGuard } from './origin.guard';

function ctx(method: string, origin?: string) {
  const req = {
    method,
    originalUrl: '/api/telegram-login/callback',
    headers: origin === undefined ? {} : { origin },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('OriginGuard', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('форма с чужого сайта — 403 ещё до разбора payload', () => {
    // Именно login CSRF: подпись Telegram у payload злоумышленника
    // валидная, так что остановить запрос может только Origin.
    process.env.CORS_ORIGIN = 'https://app.example';
    const guard = new OriginGuard();
    expect(() =>
      guard.canActivate(ctx('POST', 'https://evil.example')),
    ).toThrow(ForbiddenException);
  });

  it('свой фронтенд проходит; хвостовой слэш не мешает', () => {
    process.env.CORS_ORIGIN = 'https://app.example,https://admin.example/';
    const guard = new OriginGuard();
    expect(guard.canActivate(ctx('POST', 'https://app.example'))).toBe(true);
    expect(guard.canActivate(ctx('POST', 'https://admin.example'))).toBe(true);
  });

  it('без Origin (curl, скрипт) — пропуск: браузер на POST его ставит всегда', () => {
    process.env.CORS_ORIGIN = 'https://app.example';
    expect(new OriginGuard().canActivate(ctx('POST'))).toBe(true);
  });

  it('GET /me не трогается', () => {
    process.env.CORS_ORIGIN = 'https://app.example';
    expect(
      new OriginGuard().canActivate(ctx('GET', 'https://evil.example')),
    ).toBe(true);
  });

  it('прод без списка — отказ, а не пропуск (наследует Б-3.2)', () => {
    delete process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'production';
    expect(() =>
      new OriginGuard().canActivate(ctx('POST', 'https://app.example')),
    ).toThrow(ForbiddenException);
  });
});
