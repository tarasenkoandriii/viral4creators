/**
 * Правило доступа к вебхуку Telegram (этап 62, ТЗ §41.3): без секрета —
 * закрыто, сравнение не зависит от длины и содержимого. Тот же дух, что
 * cron-secret.spec.ts, но проверка идёт по заголовку, а не Authorization.
 */
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { assertTelegramWebhookSecret } from './telegram-webhook-secret';

describe('assertTelegramWebhookSecret', () => {
  it('нет переменной — 503, а не открытый маршрут', () => {
    expect(() => assertTelegramWebhookSecret('x', {})).toThrow(
      ServiceUnavailableException,
    );
    expect(() =>
      assertTelegramWebhookSecret(undefined, { TELEGRAM_WEBHOOK_SECRET: '  ' }),
    ).toThrow(ServiceUnavailableException);
  });

  it('заданный секрет требует точного совпадения заголовка', () => {
    const env = { TELEGRAM_WEBHOOK_SECRET: 'abc123' };
    expect(() => assertTelegramWebhookSecret('abc123', env)).not.toThrow();
    expect(() => assertTelegramWebhookSecret('abc124', env)).toThrow(
      UnauthorizedException,
    );
    // Другая длина — тот же отказ, без раннего выхода наружу.
    expect(() => assertTelegramWebhookSecret('abc', env)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertTelegramWebhookSecret(undefined, env)).toThrow(
      UnauthorizedException,
    );
  });
});
