/**
 * Blob в памяти для тестов маршрутов знаний (K3): токен загрузки —
 * настоящий (`generateClientTokenFromReadWriteToken` с фиктивным
 * read-write токеном), сами файлы — в Map. «Клиент загрузил файл» в тесте —
 * `put(pathname, body, contentType)`.
 */
import { KnowledgeBlobStorage } from '../blob-storage';
import { e1Error } from '../errors';

export const FAKE_BLOB_RW = 'vercel_blob_rw_k3teststore_secretsecretsecret';

export class FakeBlobStorage extends KnowledgeBlobStorage {
  readonly files = new Map<string, { body: Buffer; contentType: string }>();
  readonly removed: string[] = [];

  protected override token(): string {
    return FAKE_BLOB_RW;
  }

  put(pathname: string, body: Buffer, contentType: string): void {
    this.files.set(pathname, { body, contentType });
  }

  override async stat(pathname: string) {
    const f = this.files.get(pathname);
    return f ? { size: f.body.length, contentType: f.contentType } : null;
  }

  override async read(pathname: string, maxBytes: number): Promise<Buffer> {
    const f = this.files.get(pathname);
    if (!f) {
      throw e1Error(409, 'DOCUMENT_NOT_UPLOADED', 'Файл не найден в хранилище');
    }
    if (f.body.length > maxBytes) {
      throw e1Error(400, 'DOCUMENT_TOO_LARGE', 'Файл больше 20 МБ');
    }
    return f.body;
  }

  override async remove(pathname: string): Promise<void> {
    this.removed.push(pathname);
    this.files.delete(pathname);
  }
}
