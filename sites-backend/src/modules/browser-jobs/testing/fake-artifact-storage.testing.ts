/**
 * Подмена приватного Blob артефактов воркера в тестах: содержимое — в
 * памяти, «подписанная ссылка» — `fake-blob://<путь>?until=<мс>`.
 */
import { BrowserArtifactStorage } from '../artifact-storage';

export class FakeArtifactStorage extends BrowserArtifactStorage {
  readonly files = new Map<string, { body: Buffer; contentType: string }>();
  readonly removed: string[] = [];

  override async put(pathname: string, body: Buffer, contentType: string) {
    if (this.files.has(pathname)) throw new Error('blob exists');
    this.files.set(pathname, { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }

  override async signedUrl(pathname: string, validUntil: Date) {
    return Promise.resolve(
      `fake-blob://${pathname}?until=${validUntil.getTime()}`,
    );
  }

  override async remove(pathname: string) {
    this.removed.push(pathname);
    this.files.delete(pathname);
    return Promise.resolve();
  }
}
