/**
 * Общая связка ключей `ASSIST_SECRETS_KEY` (заход 9 №60, Р-З10-12) —
 * ЧИСТЫЙ модуль: ни базы, ни Nest.
 *
 * Env — тот же формат, что уже был у секретов «Админки»
 * (`assist-admin-mode/admin-secrets-crypto.ts`) и `liveValues`
 * (`assist-site-voice-control/public/live-crypto.ts`):
 *  - `ASSIST_SECRETS_KEY` — ТЕКУЩИЙ ключ: им пишется всё новое;
 *  - `ASSIST_SECRETS_KEY_VERSION` — его версия (`v1`, `v2`, …; умолчание `v1`);
 *  - `ASSIST_SECRETS_KEYS_OLD=v1:<ключ>,…` — прежние ключи, только чтение.
 *
 * До №60 лиды, `identify` передачи, recToken, visitor-token и ссылка на
 * ролик знали один ключ без версии — смена ключа делала их нечитаемыми.
 * Теперь у каждого потребителя производные ключи всех версий
 * (HMAC-SHA256(ключ версии, метка потребителя) — та же формула, что
 * раньше для единственного ключа, поэтому ключ `v1` побайтно прежний).
 *
 * Шифротекст-строка — ПРЕЖНЕГО формата, без метки версии (Р-З10-25): так
 * откат выката на код до №60 с тем же env читает всё, что записано текущим
 * ключом, при любой `ASSIST_SECRETS_KEY_VERSION`. Версию узнаёт
 * расшифровка: ключи пробуются по порядку связки (текущий первым) — GCM
 * проверяет тег, чужой ключ не «расшифрует» мусор. Префикс `<версия>~`
 * при чтении понимается (тогда — только ключ этой версии), но не пишется.
 * HMAC-токены (visitor-token, ссылка на ролик) формата не меняют:
 * подпись — текущим ключом, проверка — текущим и прежними.
 *
 * Битая конфигурация — поведение до №60, без падения маршрутов: кривая
 * `ASSIST_SECRETS_KEY_VERSION` — только `ASSIST_SECRETS_KEY` как ключ без
 * префикса (`v1`), прежние не берутся; кривой `ASSIST_SECRETS_KEYS_OLD` —
 * только текущий ключ. Обе ошибки видны в `secretsKeyringProblems`
 * (проверка env виджета) — без байтов ключей. Строгие потребители
 * (`liveValues`, «Админка») по-прежнему отказывают сами.
 */
import { createHmac } from 'crypto';

/** Версия ключа: `v1` … `v9999` (как у «Админки» и `liveValues`). */
export const SECRETS_KEY_VERSION_RE = /^v[1-9]\d{0,3}$/;
/** Версия строки без префикса для `splitKeyVersion` (данные до №60). */
export const LEGACY_KEY_VERSION = 'v1';
const PREFIX_RE = /^(v[1-9]\d{0,3})~/;

export type SecretsKeyringProblem = 'invalid_version' | 'invalid_old';

/** Сырые ключи по версиям: текущий первым, затем прежние в порядке env. */
export interface SecretsKeyring {
  readonly current: string;
  readonly versions: readonly string[];
  secret(version: string): string | null;
}

export interface ParsedSecretsKeyring {
  keyring: SecretsKeyring | null;
  problem: SecretsKeyringProblem | null;
}

function keyringOf(entries: Array<[string, string]>): SecretsKeyring {
  const map = new Map(entries);
  return {
    current: entries[0][0],
    versions: entries.map(([v]) => v),
    secret: (v) => map.get(v) ?? null,
  };
}

/**
 * Разбор env. Нет `ASSIST_SECRETS_KEY` — `{ keyring: null, problem: null }`.
 * Строгая проверка списка прежних — как у «Админки»: `версия:ключ`, без
 * повторов и без текущей версии; любая ошибка — список целиком не берётся.
 */
export function parseSecretsKeyring(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSecretsKeyring {
  const raw = env.ASSIST_SECRETS_KEY?.trim();
  if (!raw) return { keyring: null, problem: null };
  const current = env.ASSIST_SECRETS_KEY_VERSION?.trim() || LEGACY_KEY_VERSION;
  if (!SECRETS_KEY_VERSION_RE.test(current)) {
    return {
      keyring: keyringOf([[LEGACY_KEY_VERSION, raw]]),
      problem: 'invalid_version',
    };
  }
  const entries: Array<[string, string]> = [[current, raw]];
  const seen = new Set([current]);
  for (const part of (env.ASSIST_SECRETS_KEYS_OLD ?? '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const at = item.indexOf(':');
    const version = at > 0 ? item.slice(0, at).trim() : '';
    const value = at > 0 ? item.slice(at + 1).trim() : '';
    if (!SECRETS_KEY_VERSION_RE.test(version) || !value || seen.has(version)) {
      return { keyring: keyringOf([[current, raw]]), problem: 'invalid_old' };
    }
    seen.add(version);
    entries.push([version, value]);
  }
  return { keyring: keyringOf(entries), problem: null };
}

/** Тексты для проверки env (без значений ключей). */
export function secretsKeyringProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const { problem } = parseSecretsKeyring(env);
  if (problem === 'invalid_version') {
    return [
      'ASSIST_SECRETS_KEY_VERSION: ожидается v1, v2, … — ASSIST_SECRETS_KEY считается v1, прежние ключи не используются',
    ];
  }
  if (problem === 'invalid_old') {
    return [
      'ASSIST_SECRETS_KEYS_OLD: ожидается «v1:<ключ>,…» без повторов и без текущей версии — прежние ключи не используются',
    ];
  }
  return [];
}

/** Производные ключи одного потребителя по всем версиям. */
export interface DerivedKeys {
  /** Версия, которой пишется новое. */
  readonly current: string;
  readonly currentKey: Buffer;
  /** Все версии: текущая первой, затем прежние в порядке env. */
  readonly versions: readonly string[];
  /** Все ключи в том же порядке. */
  readonly all: readonly Buffer[];
  key(version: string): Buffer | null;
}

/** Производный ключ версии: HMAC-SHA256(ключ, метка) — формула до №60. */
export function deriveSecretKey(secret: string, label: string): Buffer {
  return createHmac('sha256', secret.trim()).update(label).digest();
}

/** Связка производных ключей; null — нет `ASSIST_SECRETS_KEY`. */
export function derivedKeys(
  env: NodeJS.ProcessEnv,
  label: string,
  derive: (secret: string, label: string) => Buffer = deriveSecretKey,
): DerivedKeys | null {
  const { keyring } = parseSecretsKeyring(env);
  if (!keyring) return null;
  const map = new Map<string, Buffer>();
  for (const v of keyring.versions) {
    map.set(v, derive(keyring.secret(v) as string, label));
  }
  return {
    current: keyring.current,
    currentKey: map.get(keyring.current) as Buffer,
    versions: keyring.versions,
    all: keyring.versions.map((v) => map.get(v) as Buffer),
    key: (v) => map.get(v) ?? null,
  };
}

/** Версия из префикса; без префикса — `v1` (`prefixed: false`). */
export function splitKeyVersion(stored: string): {
  version: string;
  body: string;
  prefixed: boolean;
} {
  const m = PREFIX_RE.exec(stored);
  return m
    ? { version: m[1], body: stored.slice(m[0].length), prefixed: true }
    : { version: LEGACY_KEY_VERSION, body: stored, prefixed: false };
}

/**
 * Открыть строку шифра: `open(body, key)` → значение или null (чужой ключ,
 * порча). С префиксом — только ключ своей версии (нет его — null). Без
 * префикса — ключи по порядку связки: текущий, затем прежние (см. шапку).
 */
export function openWithKeys<T>(
  keys: DerivedKeys,
  stored: string,
  open: (body: string, key: Buffer) => T | null,
): { value: T; version: string } | null {
  const { version, body, prefixed } = splitKeyVersion(stored);
  if (prefixed) {
    const key = keys.key(version);
    const value = key ? open(body, key) : null;
    return value === null ? null : { value, version };
  }
  for (const v of keys.versions) {
    const key = keys.key(v);
    if (!key) continue;
    const value = open(body, key);
    if (value !== null) return { value, version: v };
  }
  return null;
}

/** Ключи проверки HMAC: один ключ или список (текущий первым). */
export type HmacKeys = Buffer | readonly Buffer[];

export function hmacKeyList(keys: HmacKeys): readonly Buffer[] {
  return Buffer.isBuffer(keys) ? [keys] : keys;
}
