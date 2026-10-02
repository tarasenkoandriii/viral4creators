/**
 * Шифрование секретов тестовых учётных записей (Э-С Ш2; аудит слияния
 * §3.2 «Модель хранения учётных данных входа», О-Г7).
 *
 * AES-256-GCM напрямую ключом с ВЕРСИЕЙ:
 *  - ключи — `SITE_CREDENTIALS_KEYS` вида `v1:<base64 32 байта>,v2:<…>`,
 *    текущая версия (ею шифруется всё новое) — `SITE_CREDENTIALS_KEY_CURRENT`
 *    (при единственном ключе можно не задавать);
 *  - шифротекст — `sc1.<версия>.<iv>.<tag>.<данные>` (base64url), версия
 *    дублируется в колонке `keyVersion` строки: расхождение — отказ;
 *  - AAD = (зона, кабинет, сайт, учётка, назначение секрета, версия ключа):
 *    шифротекст, переставленный в чужую строку (другой кабинет, другая
 *    учётка, пароль вместо кук) или с подменённой версией, не
 *    расшифровывается — GCM проверяет AAD вместе с тегом.
 *
 * Ротация: новый ключ дописывается в `SITE_CREDENTIALS_KEYS`, текущая
 * версия переключается, скрипт `scripts/rotate-credential-keys.ts`
 * перешифровывает строки старых версий; старый ключ удаляется из env после
 * отчёта «0 строк старых версий».
 *
 * Чистый модуль: ни базы, ни Nest. Ключи наружу не отдаются, в тексты
 * ошибок — только код и версия, никогда байты ключа или открытый текст.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import { CredentialPurpose } from './credential-types';

export {
  CREDENTIAL_PURPOSES,
  isCredentialPurpose,
  type CredentialPurpose,
} from './credential-types';

/**
 * Потолки открытого текста по назначению. Превышение — отказ, а НЕ
 * обрезание (обрезанный секрет хуже отсутствующего: выглядит сохранённым).
 * Поля формы входа — тот же потолок, что у генератора
 * (`draft-credentials.ts`, 16 КБ), куки — `cookie-jar.ts` (256 КБ).
 */
export const CREDENTIAL_MAX_BYTES: Record<CredentialPurpose, number> = {
  password: 4 * 1024,
  'login-fields': 16 * 1024,
  'session-cookies': 256 * 1024,
};

export const ENVELOPE_PREFIX = 'sc1';
const VERSION_RE = /^v[1-9]\d{0,3}$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type CredentialCryptoCode =
  | 'not_configured'
  | 'invalid_keys'
  | 'unknown_key'
  | 'version_mismatch'
  | 'malformed'
  | 'tampered'
  | 'too_large';

export class CredentialCryptoError extends Error {
  constructor(
    readonly code: CredentialCryptoCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

export interface CredentialKeyring {
  /** Версия, которой шифруется всё новое. */
  current: string;
  versions: string[];
  key(version: string): Buffer | null;
}

function decodeKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length === KEY_BYTES ? buf : null;
}

/**
 * Связка ключей из env. Нет `SITE_CREDENTIALS_KEYS` — `not_configured`
 * (хранилище выключено, вызывающие отвечают 503 и генератор работает
 * по-старому); есть, но кривые — `invalid_keys` (это ошибка конфигурации,
 * её не прячем под «не настроено»).
 */
export function loadKeyring(
  env: NodeJS.ProcessEnv = process.env,
): CredentialKeyring {
  const raw = env.SITE_CREDENTIALS_KEYS?.trim();
  if (!raw) {
    throw new CredentialCryptoError(
      'not_configured',
      'SITE_CREDENTIALS_KEYS не задан — хранилище учётных данных выключено',
    );
  }
  const keys = new Map<string, Buffer>();
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const at = item.indexOf(':');
    const version = at > 0 ? item.slice(0, at).trim() : '';
    const key = at > 0 ? decodeKey(item.slice(at + 1)) : null;
    if (!VERSION_RE.test(version) || !key || keys.has(version)) {
      throw new CredentialCryptoError(
        'invalid_keys',
        'SITE_CREDENTIALS_KEYS: ожидается «v1:<base64 32 байта>,v2:…» без повторов версий',
      );
    }
    keys.set(version, key);
  }
  if (keys.size === 0) {
    throw new CredentialCryptoError(
      'not_configured',
      'SITE_CREDENTIALS_KEYS пуст — хранилище учётных данных выключено',
    );
  }
  const wanted = env.SITE_CREDENTIALS_KEY_CURRENT?.trim();
  let current: string;
  if (wanted) {
    if (!keys.has(wanted)) {
      throw new CredentialCryptoError(
        'invalid_keys',
        `SITE_CREDENTIALS_KEY_CURRENT=${VERSION_RE.test(wanted) ? wanted : '?'}: такой версии нет в SITE_CREDENTIALS_KEYS`,
      );
    }
    current = wanted;
  } else if (keys.size === 1) {
    current = [...keys.keys()][0];
  } else {
    throw new CredentialCryptoError(
      'invalid_keys',
      'ключей несколько — задайте текущую версию SITE_CREDENTIALS_KEY_CURRENT',
    );
  }
  return {
    current,
    versions: [...keys.keys()],
    key: (v) => keys.get(v) ?? null,
  };
}

/** Чей секрет: всё, что не даёт переставить шифротекст в чужую строку. */
export interface CredentialAad {
  /** A — реестр сайта (кабинет), B — личная запись пользователя генератора. */
  scope: 'A' | 'B';
  /** A — id кабинета; B — `ownerRef` (`gen:<userId>`). */
  accountId: string;
  /** A — id сайта; B — origin записи. */
  siteId: string;
  /** A — id тестовой учётки; B — id личной записи. */
  testAccountId: string;
  purpose: CredentialPurpose;
}

const SEP = '\u001f';

export function aadString(ctx: CredentialAad, keyVersion: string): string {
  const parts = [
    ENVELOPE_PREFIX,
    ctx.scope,
    ctx.accountId,
    ctx.siteId,
    ctx.testAccountId,
    ctx.purpose,
    keyVersion,
  ];
  for (const p of parts) {
    if (typeof p !== 'string' || p === '' || p.includes(SEP)) {
      throw new CredentialCryptoError('malformed', 'AAD: пустое поле');
    }
  }
  return parts.join(SEP);
}

const b64u = (b: Buffer) => b.toString('base64url');

export interface SealedCredential {
  ciphertext: string;
  keyVersion: string;
}

export function sealCredential(
  plaintext: string,
  ctx: CredentialAad,
  keyring: CredentialKeyring,
): SealedCredential {
  if (typeof plaintext !== 'string') {
    throw new CredentialCryptoError('malformed', 'секрет — строка');
  }
  const size = Buffer.byteLength(plaintext, 'utf8');
  if (size > CREDENTIAL_MAX_BYTES[ctx.purpose]) {
    throw new CredentialCryptoError(
      'too_large',
      `секрет «${ctx.purpose}» больше ${CREDENTIAL_MAX_BYTES[ctx.purpose]} байт`,
    );
  }
  const version = keyring.current;
  const key = keyring.key(version);
  if (!key) {
    throw new CredentialCryptoError('unknown_key', `нет ключа ${version}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aadString(ctx, version), 'utf8'));
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: [
      ENVELOPE_PREFIX,
      version,
      b64u(iv),
      b64u(tag),
      b64u(data),
    ].join('.'),
    keyVersion: version,
  };
}

/** Версия ключа из шифротекста (для ротации и проверок) или `null`. */
export function envelopeVersion(ciphertext: string): string | null {
  const parts = typeof ciphertext === 'string' ? ciphertext.split('.') : [];
  return parts.length === 5 &&
    parts[0] === ENVELOPE_PREFIX &&
    VERSION_RE.test(parts[1])
    ? parts[1]
    : null;
}

export function openCredential(
  row: { ciphertext: string; keyVersion: string },
  ctx: CredentialAad,
  keyring: CredentialKeyring,
): string {
  const parts = row.ciphertext.split('.');
  const version = envelopeVersion(row.ciphertext);
  if (!version) {
    throw new CredentialCryptoError('malformed', 'шифротекст не в формате sc1');
  }
  if (version !== row.keyVersion) {
    throw new CredentialCryptoError(
      'version_mismatch',
      'версия ключа в шифротексте не совпадает с колонкой keyVersion',
    );
  }
  const key = keyring.key(version);
  if (!key) {
    throw new CredentialCryptoError(
      'unknown_key',
      `ключа версии ${version} нет в SITE_CREDENTIALS_KEYS`,
    );
  }
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const data = Buffer.from(parts[4], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialCryptoError('malformed', 'iv/tag неверной длины');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aadString(ctx, version), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new CredentialCryptoError(
      'tampered',
      'секрет не расшифровывается: подмена шифротекста, AAD или ключа',
    );
  }
}

/** Перешифровать текущим ключом (ротация). Ничего не делает, если уже текущий. */
export function resealCredential(
  row: { ciphertext: string; keyVersion: string },
  ctx: CredentialAad,
  keyring: CredentialKeyring,
): SealedCredential | null {
  if (row.keyVersion === keyring.current) return null;
  return sealCredential(openCredential(row, ctx, keyring), ctx, keyring);
}
