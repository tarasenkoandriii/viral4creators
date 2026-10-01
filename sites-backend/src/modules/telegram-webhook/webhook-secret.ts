/**
 * Проверка входящего вебхука бота — по образцу backend
 * `billing/telegram-webhook-secret.ts` (там история), но с секретом
 * своего приложения: у каждого бота свой маршрут и свой секрет (ТЗ
 * помощника §4.1), и секрет одного бота не открывает вебхук другого.
 *
 * Секрет — в заголовке `X-Telegram-Bot-Api-Secret-Token` (Telegram эхом
 * присылает `secret_token` из `setWebhook`), не в пути URL: путь
 * просачивается в логи прокси. Сравнение — постоянным временем;
 * fail-closed: нет секрета в env — 503, а не молчаливый пропуск.
 */

import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { TelegramApp } from '../../brand';

export const WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

export const WEBHOOK_SECRET_ENV: Readonly<Record<TelegramApp, string>> = {
  assist: 'ASSIST_WEBHOOK_SECRET',
  qa: 'QA_WEBHOOK_SECRET',
};

export interface WebhookSecretEnv {
  [key: string]: string | undefined;
}

/** Бросает, если запрос не доказал, что он от Telegram для бота `app`. */
export function assertBotWebhookSecret(
  app: TelegramApp,
  presentedHeader: string | string[] | undefined,
  env: WebhookSecretEnv = process.env,
): void {
  const secret = env[WEBHOOK_SECRET_ENV[app]]?.trim();
  if (!secret) {
    throw new ServiceUnavailableException(
      `${WEBHOOK_SECRET_ENV[app]} не задан — вебхук бота недоступен, пока переменная не появится`,
    );
  }
  if (
    typeof presentedHeader !== 'string' ||
    !safeEqual(presentedHeader.trim(), secret)
  ) {
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
