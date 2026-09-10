/**
 * Проверка входящего вебхука Telegram (этап 62, ТЗ §41.3) — первая
 * входящая точка ОТ Telegram в проекте (все прежние интеграции с ботом —
 * исходящие: `TelegramNotifyService` шлёт алерты/статистику, `TmaInitData`
 * проверяет то, что прислал КЛИЕНТ, не сам Telegram напрямую).
 *
 * ## Почему секрет в заголовке, а не в пути URL
 *
 * Путь URL просачивается в логи прокси/CDN и в реферер-заголовки —
 * секрет там не место. `setWebhook` умеет зарегистрировать
 * `secret_token`, который Telegram эхом присылает в заголовке
 * `X-Telegram-Bot-Api-Secret-Token` на КАЖДЫЙ вызов вебхука — сверяется
 * здесь, тем же constant-time приёмом, что `cron-secret.ts`
 * (fail-closed: нет секрета — нет доступа, 503, а не молчаливый пропуск).
 * Регистрация самого `setWebhook` — одноразовый ручной шаг при деплое
 * (`doc/DEPLOYMENT.md`), не код приложения.
 */

import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

export interface TelegramWebhookSecretEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
  [key: string]: string | undefined;
}

/** Бросает, если запрос не доказал, что он от Telegram. */
export function assertTelegramWebhookSecret(
  presentedHeader: string | undefined,
  env: TelegramWebhookSecretEnv = process.env,
): void {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new ServiceUnavailableException(
      'TELEGRAM_WEBHOOK_SECRET не задан — приём платежей Stars недоступен, пока переменная не появится',
    );
  }
  if (!presentedHeader || !safeEqual(presentedHeader.trim(), secret)) {
    throw new UnauthorizedException(
      'Неверный или отсутствующий секрет вебхука',
    );
  }
}

/** Длины разные — сравнение всё равно делается, над буферами равной
 * длины, чтобы ранний выход по длине не выдавал длину секрета. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
