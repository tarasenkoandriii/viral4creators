/**
 * Секреты «Админки» (ТЗ §5.6): секрет коннектора API заказчика и секрет
 * подписи employee-JWT. Тот же приём, что у хранилища тестовых учёток Ш2
 * (`site-credentials/credential-crypto.ts`), но СВОЙ ключ — «каждому
 * потребителю свой ключ» (§5.6): `ASSIST_SECRETS_KEY`.
 *
 * AES-256-GCM, ключ с ВЕРСИЕЙ:
 *  - текущий ключ — `ASSIST_SECRETS_KEY` (его версия — `ASSIST_SECRETS_KEY_VERSION`,
 *    по умолчанию `v1`); прежние — `ASSIST_SECRETS_KEYS_OLD=v1:<ключ>,…`
 *    (только расшифровка, ротация без простоя);
 *  - ключ шифра — ПРОИЗВОДНЫЙ: HMAC-SHA256(ключ, метка «Админки»), а не сам
 *    `ASSIST_SECRETS_KEY` (из него же выводятся HMAC visitor-token, ключ
 *    лидов и др. — общих байтов ключа между назначениями нет);
 *  - шифротекст — `as1.<версия>.<iv>.<tag>.<данные>` (base64url), версия
 *    дублируется в колонке строки: расхождение — отказ;
 *  - AAD = (зона «Админки», кабинет, сайт, владелец секрета, назначение,
 *    версия): шифротекст, переставленный в чужую строку (другой коннектор,
 *    другой сайт, секрет JWT вместо секрета API), не расшифровывается.
 *
 * Чистый модуль: ни базы, ни Nest. В тексты ошибок — только код и версия,
 * никогда байты ключа или открытый текст.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

export const ADMIN_SECRET_PREFIX = 'as1';
const VERSION_RE = /^v[1-9]\d{0,3}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Метка производного ключа (не бренд: её никто не видит). */
const KEY_LABEL = 'assist-admin-secrets-v1';
/** Потолок открытого текста: токен API / пара логин:пароль / секрет JWT. */
export const ADMIN_SECRET_MAX_BYTES = 8 * 1024;

export type AdminSecretPurpose = 'connector-secret' | 'identity-secret';

export type AdminSecretsCode =
  | 'not_configured'
  | 'invalid_keys'
  | 'unknown_key'
  | 'version_mismatch'
  | 'malformed'
  | 'tampered'
  | 'too_large';

export class AdminSecretsError extends Error {
  constructor(
    readonly code: AdminSecretsCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminSecretsError';
  }
}

export interface AdminKeyring {
  current: string;
  key(version: string): Buffer | null;
}

function derive(raw: string): Buffer {
  return createHmac('sha256', raw.trim()).update(KEY_LABEL).digest();
}

/**
 * Связка ключей из env. Нет `ASSIST_SECRETS_KEY` — `not_configured`
 * (маршруты секретов отвечают 503, а не пишут открытым текстом).
 */
export function loadAdminKeyring(
  env: NodeJS.ProcessEnv = process.env,
): AdminKeyring {
  const raw = env.ASSIST_SECRETS_KEY?.trim();
  if (!raw) {
    throw new AdminSecretsError(
      'not_configured',
      'ASSIST_SECRETS_KEY не задан — секреты «Админки» недоступны',
    );
  }
  const current = env.ASSIST_SECRETS_KEY_VERSION?.trim() || 'v1';
  if (!VERSION_RE.test(current)) {
    throw new AdminSecretsError(
      'invalid_keys',
      'ASSIST_SECRETS_KEY_VERSION: ожидается v1, v2, …',
    );
  }
  const keys = new Map<string, Buffer>([[current, derive(raw)]]);
  const old = env.ASSIST_SECRETS_KEYS_OLD?.trim();
  if (old) {
    for (const part of old.split(',')) {
      const item = part.trim();
      if (!item) continue;
      const at = item.indexOf(':');
      const version = at > 0 ? item.slice(0, at).trim() : '';
      const value = at > 0 ? item.slice(at + 1).trim() : '';
      if (!VERSION_RE.test(version) || !value || keys.has(version)) {
        throw new AdminSecretsError(
          'invalid_keys',
          'ASSIST_SECRETS_KEYS_OLD: ожидается «v1:<ключ>,…» без повторов и без текущей версии',
        );
      }
      keys.set(version, derive(value));
    }
  }
  return { current, key: (v) => keys.get(v) ?? null };
}

export interface AdminSecretAad {
  accountId: string;
  siteId: string;
  /** id коннектора или `identity` (секрет подписи JWT сайта). */
  ownerId: string;
  purpose: AdminSecretPurpose;
}

const SEP = '\u001f';

export function adminAad(ctx: AdminSecretAad, version: string): string {
  const parts = [
    ADMIN_SECRET_PREFIX,
    'assist-admin',
    ctx.accountId,
    ctx.siteId,
    ctx.ownerId,
    ctx.purpose,
    version,
  ];
  for (const p of parts) {
    if (typeof p !== 'string' || p === '' || p.includes(SEP)) {
      throw new AdminSecretsError('malformed', 'AAD: пустое поле');
    }
  }
  return parts.join(SEP);
}

export interface SealedAdminSecret {
  ciphertext: string;
  keyVersion: string;
}

export function sealAdminSecret(
  plaintext: string,
  ctx: AdminSecretAad,
  keyring: AdminKeyring,
): SealedAdminSecret {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new AdminSecretsError('malformed', 'секрет — непустая строка');
  }
  if (Buffer.byteLength(plaintext, 'utf8') > ADMIN_SECRET_MAX_BYTES) {
    throw new AdminSecretsError('too_large', 'секрет слишком длинный');
  }
  const version = keyring.current;
  const key = keyring.key(version);
  if (!key) throw new AdminSecretsError('unknown_key', `нет ключа ${version}`);
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(adminAad(ctx, version), 'utf8'));
  const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return {
    ciphertext: [
      ADMIN_SECRET_PREFIX,
      version,
      iv.toString('base64url'),
      c.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join('.'),
    keyVersion: version,
  };
}

export function openAdminSecret(
  row: { ciphertext: string; keyVersion: string | null },
  ctx: AdminSecretAad,
  keyring: AdminKeyring,
): string {
  const parts =
    typeof row.ciphertext === 'string' ? row.ciphertext.split('.') : [];
  if (
    parts.length !== 5 ||
    parts[0] !== ADMIN_SECRET_PREFIX ||
    !VERSION_RE.test(parts[1])
  ) {
    throw new AdminSecretsError('malformed', 'шифротекст не в формате as1');
  }
  const version = parts[1];
  if (version !== row.keyVersion) {
    throw new AdminSecretsError(
      'version_mismatch',
      'версия ключа в шифротексте не совпадает с колонкой строки',
    );
  }
  const key = keyring.key(version);
  if (!key) {
    throw new AdminSecretsError('unknown_key', `ключа версии ${version} нет`);
  }
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new AdminSecretsError('malformed', 'iv/tag неверной длины');
  }
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(adminAad(ctx, version), 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([
      d.update(Buffer.from(parts[4], 'base64url')),
      d.final(),
    ]).toString('utf8');
  } catch {
    throw new AdminSecretsError(
      'tampered',
      'секрет не расшифровывается: подмена шифротекста, AAD или ключа',
    );
  }
}

/** «••••1a2b» — то, что видно в TMA после ввода (§5.6). */
export function secretTail(plaintext: string): string {
  const t = plaintext.replace(/\s+/g, '');
  return t.length >= 8 ? t.slice(-4) : '';
}
