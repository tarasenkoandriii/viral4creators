/**
 * Правило доступа к крону (этап 54, Б-3.3): без секрета — закрыто,
 * кроме dev-стенда; сравнение не зависит от длины и содержимого.
 */
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { assertCronSecret } from './cron-secret';

describe('assertCronSecret', () => {
  it('нет переменной и нет dev-стенда — 503, а не открытый маршрут', () => {
    expect(() => assertCronSecret('Bearer x', {})).toThrow(
      ServiceUnavailableException,
    );
    // Пустая строка — то же, что отсутствие: `CRON_SECRET=` в .env.
    expect(() => assertCronSecret(undefined, { CRON_SECRET: '  ' })).toThrow(
      ServiceUnavailableException,
    );
  });

  it('dev-стенд открывает крон только двумя предохранителями сразу', () => {
    expect(() =>
      assertCronSecret(undefined, {
        ALLOW_DEV_AUTH: 'true',
        NODE_ENV: 'development',
      }),
    ).not.toThrow();
    // ALLOW_DEV_AUTH утёк в прод — NODE_ENV=production всё равно закрывает.
    expect(() =>
      assertCronSecret(undefined, {
        ALLOW_DEV_AUTH: 'true',
        NODE_ENV: 'production',
      }),
    ).toThrow(ServiceUnavailableException);
  });

  it('заданный секрет требует точного совпадения в Bearer', () => {
    const env = { CRON_SECRET: 'abc123' };
    expect(() => assertCronSecret('Bearer abc123', env)).not.toThrow();
    expect(() => assertCronSecret('bearer abc123', env)).not.toThrow();
    expect(() => assertCronSecret('Bearer abc124', env)).toThrow(
      UnauthorizedException,
    );
    // Другая длина — тот же отказ, без раннего выхода наружу.
    expect(() => assertCronSecret('Bearer abc', env)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertCronSecret(undefined, env)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertCronSecret('Basic abc123', env)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertCronSecret('abc123', env)).toThrow(
      UnauthorizedException,
    );
  });

  it('на dev-стенде заданный секрет всё равно проверяется', () => {
    // Секрет есть — значит, стенд решил им закрыться; ALLOW_DEV_AUTH это
    // решение не отменяет.
    expect(() =>
      assertCronSecret('Bearer wrong', {
        CRON_SECRET: 'right',
        ALLOW_DEV_AUTH: 'true',
        NODE_ENV: 'development',
      }),
    ).toThrow(UnauthorizedException);
  });
});
