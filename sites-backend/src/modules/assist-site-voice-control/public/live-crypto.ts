/**
 * Шифрование `liveValues` голосового плана «Сайта» (заход 9, Р-З9-13;
 * аудит Э6-бис (2), ТЗ §5-бис.15 п.12 «ПД»): сырые значения шагов и текст
 * команды живут ≤ 10 минут плана (+ до визита/крона ретенции), но в базе —
 * только шифротекстом. Без миграции: тот же `Json`-столбец, форма
 * `{ v: 1, kv: '<версия ключа>', ct: '<iv>.<tag>.<шифр>' }` (base64url).
 *
 *  - AES-256-GCM; ключ — ПРОИЗВОДНЫЙ HMAC-SHA256(`ASSIST_SECRETS_KEY`,
 *    метка плана) — общих байтов с visitor-token, лидами и секретами
 *    «Админки» нет;
 *  - версия ключа — `ASSIST_SECRETS_KEY_VERSION` (умолчание `v1`), прежние —
 *    `ASSIST_SECRETS_KEYS_OLD=v1:<ключ>,…` (только расшифровка): ротация
 *    без простоя, тот же формат env, что у «Админки»;
 *  - AAD = (метка, id плана, сайт, версия): шифротекст, переставленный в
 *    чужой план или сайт, не расшифровывается;
 *  - старый открытый формат `{ u, v }` читается (планы, начатые до
 *    выката, живут ≤ 10 мин), пишется — никогда.
 * Нет ключа — записи нет (ошибка, не открытый текст). Чистый модуль: ни
 * базы, ни Nest; в ошибках — только код.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

const LABEL = 'assist-site-plan-live-v1';
const VERSION_RE = /^v[1-9]\d{0,3}$/;
const SEP = '\u001f';

export interface LiveKeys {
  current: string;
  key(version: string): Buffer | null;
}

export class LiveCryptError extends Error {
  constructor(readonly code: 'not_configured' | 'invalid_keys') {
    super(`liveValues: ${code}`);
    this.name = 'LiveCryptError';
  }
}

const derive = (raw: string) =>
  createHmac('sha256', raw.trim()).update(LABEL).digest();

/** Связка ключей из env; нет `ASSIST_SECRETS_KEY` — null (записи не будет). */
export function liveKeysFrom(env: NodeJS.ProcessEnv): LiveKeys | null {
  const raw = env.ASSIST_SECRETS_KEY?.trim();
  if (!raw) return null;
  const current = env.ASSIST_SECRETS_KEY_VERSION?.trim() || 'v1';
  if (!VERSION_RE.test(current)) throw new LiveCryptError('invalid_keys');
  const keys = new Map<string, Buffer>([[current, derive(raw)]]);
  for (const part of (env.ASSIST_SECRETS_KEYS_OLD ?? '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const at = item.indexOf(':');
    const version = at > 0 ? item.slice(0, at).trim() : '';
    const value = at > 0 ? item.slice(at + 1).trim() : '';
    if (!VERSION_RE.test(version) || !value || keys.has(version))
      throw new LiveCryptError('invalid_keys');
    keys.set(version, derive(value));
  }
  return { current, key: (v) => keys.get(v) ?? null };
}

export interface LiveAad {
  planId: string;
  siteId: string;
}

const aad = (a: LiveAad, version: string) =>
  Buffer.from([LABEL, a.planId, a.siteId, version].join(SEP), 'utf8');

export interface SealedLive {
  v: 1;
  kv: string;
  ct: string;
}

/** Зашифровать JSON-строку живых значений (результат — для `::jsonb`). */
export function sealLive(
  keys: LiveKeys | null,
  plain: string,
  a: LiveAad,
): string {
  if (!keys) throw new LiveCryptError('not_configured');
  const key = keys.key(keys.current);
  if (!key) throw new LiveCryptError('invalid_keys');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(a, keys.current));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const out: SealedLive = {
    v: 1,
    kv: keys.current,
    ct: [
      iv.toString('base64url'),
      c.getAuthTag().toString('base64url'),
      enc.toString('base64url'),
    ].join('.'),
  };
  return JSON.stringify(out);
}

/**
 * Значение столбца → открытый объект: шифротекст — расшифровать (чужой
 * план/сайт, порча, неизвестный ключ — null); старый открытый `{ u, v }` —
 * как есть (переход); прочее — null.
 */
export function openLive(
  keys: LiveKeys | null,
  raw: unknown,
  a: LiveAad,
): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.ct !== 'string' || typeof o.kv !== 'string')
    return 'u' in o ? o : null;
  const key = keys?.key(o.kv) ?? null;
  const parts = o.ct.split('.');
  if (!key || parts.length !== 3) return null;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[0], 'base64url'),
    );
    d.setAAD(aad(a, o.kv));
    d.setAuthTag(Buffer.from(parts[1], 'base64url'));
    const txt = Buffer.concat([
      d.update(Buffer.from(parts[2], 'base64url')),
      d.final(),
    ]).toString('utf8');
    return JSON.parse(txt) as unknown;
  } catch {
    return null;
  }
}
