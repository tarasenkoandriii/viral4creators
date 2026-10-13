/**
 * AI Publisher — формат резервной копии продукта (P-E, проектный документ
 * §15.4; Р-PUB-11). Чистый модуль.
 *
 * Документ копии — JSON `{format:'publisher-backup', formatVersion:1,
 * exportedAt, source, tables}`: строки всех `pub_*` продукта (кроме
 * `pub_rate_hits`, `pub_idempotency_keys`, `pub_notifications`,
 * `pub_lead_outbox`) в порядке FK; контакты и заметки — как шифротекст;
 * `bigint`/`Decimal` — строками (без потери точности в JS).
 *
 * Байты копии: gzip → AES-256-GCM (ключ связки `ASSIST_SECRETS_KEY`, метка
 * `publisher-backup-v1`, AAD = id копии) — `<версия ключа>.` ASCII +
 * iv(12) + tag(16) + шифр. sha256 считается от этих байтов (целостность
 * хранения проверяется до расшифровки).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import type { DerivedKeys } from '../../../common/secrets-keyring';

export const BACKUP_FORMAT = 'publisher-backup';
export const BACKUP_FORMAT_VERSION = 1;

export type BackupRow = Record<string, unknown>;

export interface BackupDocument {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  exportedAt: string;
  source: {
    productId: string;
    accountId: string;
    siteId: string;
    kind: string;
  };
  /** Таблица → строки в порядке FK (родитель раньше ребёнка). */
  tables: Record<string, BackupRow[]>;
}

const VERSION_RE = /^v[1-9]\d{0,3}$/;

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Документ → зашифрованные байты копии (AAD = id копии). */
export function sealBackup(
  doc: BackupDocument,
  backupId: string,
  keys: DerivedKeys,
): { bytes: Buffer; keyVersion: string } {
  const plain = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys.currentKey, iv);
  c.setAAD(Buffer.from(backupId, 'utf8'));
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return {
    bytes: Buffer.concat([
      Buffer.from(`${keys.current}.`, 'ascii'),
      iv,
      c.getAuthTag(),
      enc,
    ]),
    keyVersion: keys.current,
  };
}

/** Байты копии → документ; null — чужой ключ, порча, чужой id (AAD). */
export function openBackup(
  bytes: Buffer,
  backupId: string,
  keys: DerivedKeys,
): BackupDocument | null {
  const dot = bytes.indexOf(0x2e);
  if (dot < 2 || dot > 6) return null;
  const version = bytes.subarray(0, dot).toString('ascii');
  if (!VERSION_RE.test(version)) return null;
  const key = keys.key(version);
  if (!key) return null;
  const iv = bytes.subarray(dot + 1, dot + 13);
  const tag = bytes.subarray(dot + 13, dot + 29);
  const body = bytes.subarray(dot + 29);
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(backupId, 'utf8'));
    d.setAuthTag(tag);
    const plain = gunzipSync(Buffer.concat([d.update(body), d.final()]));
    const doc = JSON.parse(plain.toString('utf8')) as BackupDocument;
    if (
      doc?.format !== BACKUP_FORMAT ||
      doc.formatVersion !== BACKUP_FORMAT_VERSION ||
      typeof doc.tables !== 'object'
    ) {
      return null;
    }
    return doc;
  } catch {
    return null;
  }
}

export function tableCountsOf(doc: BackupDocument): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, rows] of Object.entries(doc.tables)) out[t] = rows.length;
  return out;
}
