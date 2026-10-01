/**
 * Подпись initData для тестов — тем же алгоритмом Telegram, что проверяет
 * shared/telegram-init-data.util.ts, а не готовой константой: константа
 * доказала бы лишь, что код не менялся, а не что он верен.
 */

import { createHmac } from 'crypto';

/** Фиктивные токены двух ботов — разные, как в жизни. */
export const TEST_ASSIST_TOKEN = '111111:AA-тестовый-токен-помощника';
export const TEST_QA_TOKEN = '222222:BB-тестовый-токен-qa';

export interface SignOptions {
  botToken: string;
  userId?: number;
  /** Секунды эпохи; по умолчанию — «сейчас». */
  authDate?: number;
  username?: string;
}

export function signInitData(opts: SignOptions): string {
  const fields: Record<string, string> = {
    auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: 'AAE-test',
    user: JSON.stringify({
      id: opts.userId ?? 777,
      first_name: 'Андрій',
      username: opts.username ?? 'tester',
      language_code: 'uk',
    }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(opts.botToken)
    .digest();
  const hash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
