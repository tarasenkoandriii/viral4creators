/**
 * Проверка входящего вебхука Resemble (этап 73, TODO п.32) — тот же
 * принцип, что у `modules/billing/telegram-webhook-secret.ts`
 * (constant-time сравнение, fail-closed: нет секрета на стенде — 503,
 * а не молчаливый пропуск), но секрет — в QUERY-параметре URL, не в
 * заголовке.
 *
 * ## Почему секрет в URL, а не в заголовке (в отличие от Telegram)
 *
 * У Telegram `setWebhook` явно поддерживает `secret_token`, который
 * Telegram сам эхом шлёт в заголовке на каждый вызов — стабильный,
 * задокументированный контракт. У Resemble `POST /api/v2/voices`
 * принимает произвольный `callback_uri`, но нет отдельного поля под
 * секрет заголовка — единственный канал, которым МЫ управляем на
 * стороне регистрации, это сам URL. Секрет в пути/query теоретически
 * может просочиться в логи прокси — тот же компромисс, что уже
 * принят в проекте для `/sessions/:id/...` (сессия — bearer в пути,
 * см. доккомментарий scenes-контроллера); риск тот же класс, не хуже.
 */

import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

export interface ResembleWebhookSecretEnv {
  RESEMBLE_WEBHOOK_SECRET?: string;
  [key: string]: string | undefined;
}

/** Бросает, если запрос не доказал, что он от Resemble. */
export function assertResembleWebhookSecret(
  presentedQueryParam: string | undefined,
  env: ResembleWebhookSecretEnv = process.env,
): void {
  const secret = env.RESEMBLE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new ServiceUnavailableException(
      'RESEMBLE_WEBHOOK_SECRET не задан — приём вебхука клонирования недоступен, пока переменная не появится (poll-фоллбек всё равно работает)',
    );
  }
  if (!presentedQueryParam || !safeEqual(presentedQueryParam, secret)) {
    throw new UnauthorizedException(
      'Неверный или отсутствующий секрет вебхука',
    );
  }
}

/** Тот же приём, что в telegram-webhook-secret.ts — длины сначала выравниваются. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Строит `callback_uri` для регистрации у Resemble — секрет из окружения.
 *
 * Публичный адрес — `API_PUBLIC_URL`, ТА ЖЕ переменная, что уже собирает
 * callback OAuth-каналов (`tiktok-oauth.service.ts`/
 * `google-oauth.service.ts`) и вебхук WayForPay (`billing.service.ts`) —
 * не отдельная `PUBLIC_BASE_URL`: два имени под один и тот же смысл
 * («публичный адрес ЭТОГО backend») разъехались бы на проде при
 * обновлении только одного из двух.
 */
export function resembleWebhookUrl(
  env: ResembleWebhookSecretEnv & { API_PUBLIC_URL?: string } = process.env,
): string | undefined {
  const base = env.API_PUBLIC_URL?.trim().replace(/\/+$/, '');
  const secret = env.RESEMBLE_WEBHOOK_SECRET?.trim();
  if (!base || !secret) return undefined;
  return `${base}/voices/webhook/resemble?secret=${encodeURIComponent(secret)}`;
}
