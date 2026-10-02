/**
 * Подписанная ссылка на ролик (Э6, ТЗ §4.11: «ролик отдаётся по
 * подписанной ссылке с TTL, не голый blobUrl») — ЧИСТЫЙ модуль.
 *
 * Токен `v1.<siteId>.<videoId>.<exp>.<sig>`: HMAC-SHA256 (ключ — производный
 * от ASSIST_SECRETS_KEY, config/media-env.ts) над сайтом, роликом и сроком.
 * Сайт — часть подписи: ссылку, выданную на сайте A, нельзя переписать на
 * ролик сайта B (третий барьер ещё и сверяет строку ролика по siteId).
 * Посетителя в токене нет намеренно: ссылку открывает `<video>` iframe без
 * заголовков, а срок — минуты.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE =
  /^v1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

function sig(key: Buffer, siteId: string, videoId: string, exp: number) {
  return createHmac('sha256', key)
    .update(`v1\n${siteId}\n${videoId}\n${exp}`, 'utf8')
    .digest('base64url');
}

export function signVideoLink(
  key: Buffer,
  p: { siteId: string; videoId: string; expUnix: number },
): string {
  if (!ID.test(p.siteId) || !ID.test(p.videoId)) {
    throw new Error('video link: bad id');
  }
  const exp = Math.floor(p.expUnix);
  return `v1.${p.siteId}.${p.videoId}.${exp}.${sig(key, p.siteId, p.videoId, exp)}`;
}

export type VideoLinkCheck =
  | { ok: true; siteId: string; videoId: string; expUnix: number }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export function verifyVideoLink(
  key: Buffer,
  token: unknown,
  nowUnix: number,
): VideoLinkCheck {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, siteId, videoId, expRaw, given] = m;
  const exp = Number(expRaw);
  const want = Buffer.from(sig(key, siteId, videoId, exp));
  const got = Buffer.from(given);
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    return { ok: false, reason: 'signature' };
  }
  if (exp <= nowUnix) return { ok: false, reason: 'expired' };
  return { ok: true, siteId, videoId, expUnix: exp };
}
