/**
 * Криптография сервера (ТЗ §5.1, §7, §8; бриф Р-FF-3/4):
 *  - каноникализация JSON для fingerprint (ключи объектов сортируются,
 *    порядок массивов сохраняется, типы не смешиваются);
 *  - AEAD (AES-256-GCM) payload с key_id и AAD = id задачи;
 *  - HMAC-SHA-256 fingerprint канонического тела;
 *  - хеши ключей клиентов и токенов выдачи.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { KeyRing } from '../config';

/**
 * Канонический JSON: объекты — ключи по возрастанию (кодовые единицы
 * UTF-16, как Array.prototype.sort), массивы — как есть. Числа и строки
 * сериализуются JSON.stringify: `1` и `"1"` различаются.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson: нечисловое значение');
    }
    if (value === undefined) throw new TypeError('canonicalJson: undefined');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export interface Fingerprint {
  keyId: string;
  value: string;
}

/** HMAC-SHA-256 канонического тела активным (или указанным) ключом. */
export function fingerprint(
  ring: KeyRing,
  body: unknown,
  keyId: string = ring.active,
): Fingerprint {
  const key = ring.keys.get(keyId);
  if (!key) throw new MissingKeyError(keyId);
  const value = createHmac('sha256', key)
    .update(canonicalJson(body), 'utf8')
    .digest('hex');
  return { keyId, value };
}

export class MissingKeyError extends Error {
  constructor(public readonly keyId: string) {
    super(`ключ ${keyId} не настроен`);
    this.name = 'MissingKeyError';
  }
}

const VERSION = 1;

/** AES-256-GCM: формат `v1.<base64(iv|tag|ciphertext)>`. */
export function sealPayload(
  ring: KeyRing,
  plaintext: string,
  aad: string,
): { keyId: string; sealed: string } {
  const keyId = ring.active;
  const key = ring.keys.get(keyId);
  if (!key) throw new MissingKeyError(keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${keyId}\n${aad}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyId,
    sealed: `v${VERSION}.` + Buffer.concat([iv, tag, ct]).toString('base64'),
  };
}

export function openPayload(
  ring: KeyRing,
  keyId: string,
  sealed: string,
  aad: string,
): string {
  const key = ring.keys.get(keyId);
  if (!key) throw new MissingKeyError(keyId);
  if (!sealed.startsWith(`v${VERSION}.`)) {
    throw new Error('payload: неизвестная версия формата');
  }
  const buf = Buffer.from(sealed.slice(3), 'base64');
  if (buf.length < 28) throw new Error('payload: повреждён');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${keyId}\n${aad}`, 'utf8'));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([
    decipher.update(buf.subarray(28)),
    decipher.final(),
  ]).toString('utf8');
}

/** Токен выдачи файла: 32 случайных байта base64url; хранится sha256. */
export function newDownloadToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}
