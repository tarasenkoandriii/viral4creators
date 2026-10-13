/**
 * AI Publisher — хранилище зашифрованных копий (P-E, §15.4, Р-PUB-11):
 * приватный Vercel Blob (`BLOB_READ_WRITE_TOKEN`, как выгрузки помощника),
 * случайный суффикс пути (`addRandomSuffix`). Путь в базе хранится только
 * шифротекстом (`pub_backups.blobPathEnc`). В тестах — фейк в памяти
 * (`reports/testing/memory-backup-storage.testing.ts`).
 *
 * Стенд сквозных маршрутов (Р-PUB-Z2-22): `LocalFileBackupStorage` — файлы
 * в каталоге `PUBLISHER_STAND_BACKUP_DIR` за тем же портом. Выбор —
 * `backupStorageFromEnv()`: каталог действует только при
 * `publisherStandBackupDir(env).enabled` (`NODE_ENV=development|test`, не
 * Vercel); в любом другом окружении — Vercel Blob и предупреждение в журнале.
 */
import { Injectable, Logger } from '@nestjs/common';
import { del, get, put } from '@vercel/blob';
import { randomBytes } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { publisherStandBackupDir } from '../../../config/publisher-env';

export const PUB_BACKUP_STORAGE = 'PUB_BACKUP_STORAGE';

export interface BackupStorage {
  /** Записать байты; возвращает фактический путь (со случайным суффиксом). */
  put(pathname: string, body: Buffer): Promise<string>;
  get(pathname: string): Promise<Buffer>;
  remove(pathname: string): Promise<void>;
}

@Injectable()
export class VercelBlobBackupStorage implements BackupStorage {
  private token(): string {
    const t = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!t) throw new Error('BLOB_READ_WRITE_TOKEN не задан');
    return t;
  }

  async put(pathname: string, body: Buffer): Promise<string> {
    const r = await put(pathname, body, {
      access: 'private',
      token: this.token(),
      contentType: 'application/octet-stream',
      addRandomSuffix: true,
    });
    return r.pathname;
  }

  async get(pathname: string): Promise<Buffer> {
    const r = await get(pathname, {
      access: 'private',
      token: this.token(),
      useCache: false,
    });
    if (!r || r.statusCode !== 200 || !r.stream)
      throw new Error('backup blob: не найден');
    const chunks: Uint8Array[] = [];
    const reader = r.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async remove(pathname: string): Promise<void> {
    await del(pathname, { token: this.token() });
  }
}

/**
 * Хранилище копий стенда: файлы под корнем `dir`. Путь — тот же вид, что у
 * Blob (`publisher/<кабинет>/<продукт>/backups/<id>.bin`), со случайным
 * суффиксом (как `addRandomSuffix`); выход за корень — ошибка.
 */
export class LocalFileBackupStorage implements BackupStorage {
  constructor(private readonly dir: string) {}

  private file(pathname: string): string {
    if (!/^[A-Za-z0-9_./-]{1,300}$/.test(pathname) || pathname.includes('..'))
      throw new Error('backup file: недопустимый путь');
    const root = path.resolve(this.dir);
    const f = path.resolve(root, pathname);
    if (!f.startsWith(root + path.sep))
      throw new Error('backup file: путь вне каталога');
    return f;
  }

  async put(pathname: string, body: Buffer): Promise<string> {
    const p = pathname.replace(
      /(\.[a-z]+)?$/,
      (ext) => `-${randomBytes(6).toString('hex')}${ext}`,
    );
    const f = this.file(p);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body, { flag: 'wx' });
    return p;
  }

  async get(pathname: string): Promise<Buffer> {
    return readFile(this.file(pathname));
  }

  async remove(pathname: string): Promise<void> {
    await rm(this.file(pathname), { force: true });
  }
}

/** Хранилище копий процесса: каталог стенда или Vercel Blob. */
export function backupStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BackupStorage {
  const stand = publisherStandBackupDir(env);
  const log = new Logger('PublisherBackup');
  if (stand.enabled && stand.dir) {
    log.warn(
      `копии — локальный каталог стенда ${stand.dir} (только стенд E2E)`,
    );
    return new LocalFileBackupStorage(stand.dir);
  }
  if (stand.problem) log.warn(stand.problem);
  return new VercelBlobBackupStorage();
}
