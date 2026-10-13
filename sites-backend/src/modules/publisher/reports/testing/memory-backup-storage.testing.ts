/**
 * Фейк хранилища копий в памяти (тесты P-E): тот же контракт, что у
 * `VercelBlobBackupStorage`, случайный суффикс пути — как `addRandomSuffix`.
 */
import { randomBytes } from 'crypto';
import type { BackupStorage } from '../backup-storage';

export class MemoryBackupStorage implements BackupStorage {
  readonly blobs = new Map<string, Buffer>();
  failPut = false;

  put(pathname: string, body: Buffer): Promise<string> {
    if (this.failPut) return Promise.reject(new Error('fake blob: put failed'));
    const p = pathname.replace(
      /(\.[a-z]+)$/,
      `-${randomBytes(6).toString('hex')}$1`,
    );
    this.blobs.set(p, Buffer.from(body));
    return Promise.resolve(p);
  }

  get(pathname: string): Promise<Buffer> {
    const b = this.blobs.get(pathname);
    return b
      ? Promise.resolve(Buffer.from(b))
      : Promise.reject(new Error('fake blob: not found'));
  }

  remove(pathname: string): Promise<void> {
    this.blobs.delete(pathname);
    return Promise.resolve();
  }
}
