/**
 * Сухой прогон мемо по страницам (Э6-бис (е), §5-бис.17 п.7) — подписанный
 * итог страницы. Сервер не хранит промежуточного состояния: каждую
 * страницу образца владелец проверяет в своём браузере (тестовая сессия
 * мастера), итог страницы считает КОД и отдаёт подписанным (HMAC от ключа
 * секретов, метка `memo-check`); отчёт собирает подписанные итоги — iframe
 * их не подделает и чужой сессии не подсунет (в подписи — id теста).
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { hmacKeyList, type HmacKeys } from '../../../common/secrets-keyring';
import type { MemoCheckPage } from '../../assist-ui-core/memo';

const TOKEN_RE = /^([A-Za-z0-9_-]{10,4000})\.([A-Za-z0-9_-]{43})$/;

function keyOf(base: Buffer): Buffer {
  return createHmac('sha256', base).update('memo-check').digest();
}

export function signMemoPage(
  base: Buffer,
  testId: string,
  page: MemoCheckPage,
): string {
  const body = Buffer.from(
    JSON.stringify({ t: testId, p: page }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', keyOf(base))
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

/** Итог страницы, если подпись наша и тест тот же; иначе null. */
export function verifyMemoPage(
  base: HmacKeys | null,
  testId: string,
  token: unknown,
): MemoCheckPage | null {
  if (!base || typeof token !== 'string') return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const got = Buffer.from(m[2]);
  // №60: текущим и прежними ключами связки (`voiceTicketKeys`).
  const signed = hmacKeyList(base).some((b) => {
    const want = Buffer.from(
      createHmac('sha256', keyOf(b)).update(m[1]).digest('base64url'),
    );
    return want.length === got.length && timingSafeEqual(want, got);
  });
  if (!signed) return null;
  try {
    const o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as {
      t?: unknown;
      p?: MemoCheckPage;
    };
    return o.t === testId && o.p && typeof o.p.path === 'string' ? o.p : null;
  } catch {
    return null;
  }
}
