import { HttpException } from '@nestjs/common';
import { assertCronSecret } from './cron-secret';

const status = (fn: () => void): number | 'ok' => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof HttpException ? e.getStatus() : -1;
  }
};

describe('assertCronSecret', () => {
  const env = { CRON_SECRET: 's3cret', NODE_ENV: 'production' };

  it('верный Bearer — пропуск, неверный/без — 401', () => {
    expect(status(() => assertCronSecret('Bearer s3cret', env))).toBe('ok');
    expect(status(() => assertCronSecret('bearer  s3cret ', env))).toBe('ok');
    expect(status(() => assertCronSecret('Bearer s3cre', env))).toBe(401);
    expect(status(() => assertCronSecret('s3cret', env))).toBe(401);
    expect(status(() => assertCronSecret(undefined, env))).toBe(401);
  });

  it('нет секрета — закрыто (503), кроме dev-стенда', () => {
    expect(
      status(() => assertCronSecret(undefined, { NODE_ENV: 'production' })),
    ).toBe(503);
    expect(
      status(() =>
        assertCronSecret(undefined, {
          ALLOW_DEV_AUTH: 'true',
          NODE_ENV: 'production',
        }),
      ),
    ).toBe(503);
    expect(
      status(() =>
        assertCronSecret(undefined, {
          ALLOW_DEV_AUTH: 'true',
          NODE_ENV: 'development',
        }),
      ),
    ).toBe('ok');
  });
});
