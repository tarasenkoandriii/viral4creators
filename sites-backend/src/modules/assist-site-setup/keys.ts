/**
 * Публичные ключи сайта (ТЗ §4.17, §4.13): `pk_live_…` / `pk_test_…` —
 * не секрет (виден в HTML), но неугадываемый: 24 символа base62 из
 * randomBytes. Префиксы — только из src/brand.ts. Владелец — W4.
 */
import { randomBytes } from 'crypto';
import { WIDGET_PK_LIVE_PREFIX, WIDGET_PK_TEST_PREFIX } from '../../brand';

export type PublicKeyKind = 'live' | 'test';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 24 символа base62 ≈ 142 бита — не перебрать и не угадать. */
export const PUBLIC_KEY_BODY_LENGTH = 24;
const BODY = new RegExp(`^[0-9A-Za-z]{${PUBLIC_KEY_BODY_LENGTH}}$`);

function prefixOf(kind: PublicKeyKind): string {
  return kind === 'live' ? WIDGET_PK_LIVE_PREFIX : WIDGET_PK_TEST_PREFIX;
}

export function generatePublicKey(kind: PublicKeyKind): string {
  let body = '';
  while (body.length < PUBLIC_KEY_BODY_LENGTH) {
    for (const b of randomBytes(32)) {
      // Отбрасываем 248–255: остаток от 62 без перекоса распределения.
      if (b >= 248) continue;
      body += ALPHABET[b % 62];
      if (body.length === PUBLIC_KEY_BODY_LENGTH) break;
    }
  }
  return prefixOf(kind) + body;
}

/** Разбор ключа из запроса: формат и тип; всё прочее — null (не «угадываем»). */
export function parsePublicKey(
  raw: unknown,
): { kind: PublicKeyKind; key: string } | null {
  if (typeof raw !== 'string') return null;
  for (const kind of ['live', 'test'] as const) {
    const prefix = prefixOf(kind);
    if (raw.startsWith(prefix) && BODY.test(raw.slice(prefix.length))) {
      return { kind, key: raw };
    }
  }
  return null;
}
