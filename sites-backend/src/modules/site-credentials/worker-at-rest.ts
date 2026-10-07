/**
 * Ш3-хвост (7) (хвост Ш2 (5)): секреты учёток, которые читает ТОЛЬКО
 * браузерный воркер, запечатываются под его открытый ключ уже ПРИ ЗАПИСИ.
 *
 * Кто: учётка, чей список продуктов — ровно `assist-admin` (обход «Админки»
 * за логином; секреты получает только воркер). Для `tutorial`/`qa` — нет:
 * генератор и QA читают секреты сами (без раннера на воркере это невозможно,
 * см. doc/TODO.md Ш3-хвост (7)).
 *
 * Что это даёт: sites-backend (Vercel) не держит открытого текста таких
 * секретов вовсе — ни при записи дольше запроса, ни при выдаче: в базе —
 * конверт `v1.…` (X25519 + AES-GCM, `browser-jobs/worker-seal`), при выдаче
 * воркеру он уходит как есть (внутри обычного конверта задания). KEK Ш2 к
 * таким строкам не применяется; ротация KEK их не трогает.
 *
 * Как устроено без нарушения графа: `site-credentials` не импортирует
 * `browser-jobs/worker-seal` (правило `worker-seal-private`) — запечатывает
 * канал воркера (`internal-worker`), подключая `WorkerAtRestSealer` при
 * старте модуля (`SiteCredentialsService.useWorkerSealer`). Нет канала или
 * не задан `SITES_WORKER_SEAL_PUBLIC_KEY` — запись по-старому, под KEK.
 *
 * Строка в базе: `keyVersion = worker:<kid>` (kid — отпечаток открытого
 * ключа, 16 hex), `ciphertext` — конверт. AAD — зона, кабинет, сайт, учётка и
 * назначение: конверт, переставленный в чужую строку, воркер не откроет.
 *
 * Ротация ключа воркера (решение): закрытого ключа у sites-backend нет —
 * перезапечатать старые конверты нельзя. Воркер держит прежний закрытый
 * ключ (`BROWSER_WORKER_SEAL_PRIVATE_KEY_PREVIOUS`) на окно ротации; отчёт
 * скрипта ротации показывает строки `worker:<kid>` по ключам; строки под
 * ключом, которого воркер уже не знает, дают `credentials_unavailable` —
 * владелец вводит пароль заново (запишется под новый ключ). Старые записи
 * под KEK (до этой правки) работают по-старому: миграции данных нет.
 */
import { createHash } from 'crypto';
import type { CredentialPurpose } from './credential-types';

export const WORKER_KEY_PREFIX = 'worker:';

export interface WorkerAtRestSealer {
  /** Открытый ключ воркера (base64url) или null — не задан. */
  publicKey(): string | null;
  /** Конверт под открытый ключ воркера. */
  seal(publicKey: string, plaintext: Buffer, aad: string): string;
}

/** Секреты учётки читает только воркер: продукт — ровно `assist-admin`. */
export function workerOnlyProducts(products: readonly string[]): boolean {
  return products.length === 1 && products[0] === 'assist-admin';
}

/** Отпечаток открытого ключа воркера (`worker:<kid>` в `keyVersion`). */
export function workerKeyId(publicKey: string): string {
  return createHash('sha256')
    .update(publicKey.trim(), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export function workerKeyVersion(publicKey: string): string {
  return `${WORKER_KEY_PREFIX}${workerKeyId(publicKey)}`;
}

export function isWorkerSealed(row: { keyVersion: string }): boolean {
  return row.keyVersion.startsWith(WORKER_KEY_PREFIX);
}

/** AAD конверта при записи (зона A, кабинет, сайт, учётка, назначение). */
export function atRestAad(
  row: { accountId: string; siteId: string; id: string },
  purpose: CredentialPurpose,
): string {
  return `cred:A:${row.accountId}:${row.siteId}:${row.id}:${purpose}`;
}

/** Секрет, запечатанный при записи, — воркеру как есть. */
export interface StoredWorkerSecret {
  purpose: CredentialPurpose;
  sealed: string;
  aad: string;
  keyVersion: string;
}
