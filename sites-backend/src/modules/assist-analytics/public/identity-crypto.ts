/**
 * `V4CAssist('identify')` (§3-бис.2, К-3) — форма и шифр — A. ЧИСТЫЙ модуль.
 * iframe держит данные в памяти и отдаёт серверу ТОЛЬКО вместе с лидом или
 * передачей; в базу — шифром AES-256-GCM (ключ — производный HMAC от
 * ASSIST_SECRETS_KEY с меткой, без нового секрета, как lead-crypto),
 * связка с id строки (AAD): шифр одного лида не подложить в другой.
 * `userHash` сверяет СИСТЕМНЫЙ код (IntegrationsService.verifyUserHash) —
 * публичный код его не проверяет и не хранит открытым.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  derivedKeys,
  openWithKeys,
  type DerivedKeys,
} from '../../../common/secrets-keyring';
import type { WidgetIdentity } from '../../assist-site-chat/chat-types';

/** Метка производного ключа (не бренд: в HTML/DNS её никто не видит). */
const IDENTITY_KEY_LABEL = 'assist-site-identity-v1';

const EXTERNAL_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const USER_HASH = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** №60: ключи всех версий связки ASSIST_SECRETS_KEY; null — ключа нет. */
export function identityKey(
  env: NodeJS.ProcessEnv = process.env,
): DerivedKeys | null {
  return derivedKeys(env, IDENTITY_KEY_LABEL);
}

/**
 * Строгая форма identify: лишнее — отбрасывается, кривое поле — null.
 * Всё пустое — null (нечего хранить). Сырой ввод скрипта страницы.
 */
export function normalizeIdentity(raw: unknown): WidgetIdentity | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string' || CONTROL.test(v)) return null;
    const t = v.normalize('NFKC').trim();
    return t && t.length <= max ? t : null;
  };
  const name = str(o.name, 100);
  const emailRaw = str(o.email, 254);
  const email = emailRaw && EMAIL.test(emailRaw) ? emailRaw : null;
  const ext = str(o.externalId, 128);
  const externalId = ext && EXTERNAL_ID.test(ext) ? ext : null;
  const hash = str(o.userHash, 64)?.toLowerCase() ?? null;
  // userHash без externalId смысла не имеет (подписывается именно он).
  const userHash = externalId && hash && USER_HASH.test(hash) ? hash : null;
  if (!name && !email && !externalId) return null;
  return { name, email, externalId, userHash };
}

export function encryptIdentity(
  identity: WidgetIdentity,
  rowId: string,
  keys: DerivedKeys,
): string {
  return sealIdentity(identity, rowId, keys.currentKey);
}

function sealIdentity(
  identity: WidgetIdentity,
  rowId: string,
  key: Buffer,
): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(rowId, 'utf8'));
  const enc = Buffer.concat([
    c.update(JSON.stringify(identity), 'utf8'),
    c.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

/** null — чужой ключ, порча или чужая строка (без исключения и без текста в лог). */
export function decryptIdentity(
  blob: string,
  rowId: string,
  keys: DerivedKeys,
): WidgetIdentity | null {
  return openLeadIdentity(blob, rowId, keys)?.value ?? null;
}

/** Как decrypt, но с версией ключа, которым открылось (ротация, №60). */
export function openLeadIdentity(
  blob: string,
  rowId: string,
  keys: DerivedKeys,
): { value: WidgetIdentity; version: string } | null {
  if (typeof blob !== 'string') return null;
  return openWithKeys(keys, blob, (body, key) =>
    openIdentity(body, rowId, key),
  );
}

function openIdentity(
  blob: string,
  rowId: string,
  key: Buffer,
): WidgetIdentity | null {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1], 'base64url'),
    );
    d.setAAD(Buffer.from(rowId, 'utf8'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const out = Buffer.concat([
      d.update(Buffer.from(parts[3], 'base64url')),
      d.final(),
    ]).toString('utf8');
    return normalizeIdentity(JSON.parse(out));
  } catch {
    return null;
  }
}
