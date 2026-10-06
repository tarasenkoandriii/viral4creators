/**
 * Артефакты заданий воркера (скриншоты «Снимка», кадры) — приватный Blob
 * (Э-С Ш3; «кадры — приватно или со сроком жизни»; О-Т18): путь
 * `browser/<accountId>/<jobId>/<idx>-<случайный суффикс>.<ext>`, доступ
 * `private`, наружу — только подписанный GET с коротким сроком (≤ 15 мин и не
 * дольше срока жизни артефакта). Токен — BLOB_READ_WRITE_TOKEN (тот же, что
 * у документов знаний Э1), новых секретов нет. В тестах подменяется
 * (testing/fake-artifact-storage.testing.ts).
 */
import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { del, issueSignedToken, presignUrl, put } from '@vercel/blob';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function artifactPathname(p: {
  accountId: string;
  jobId: string;
  idx: number;
  contentType: string;
}): string {
  for (const v of [p.accountId, p.jobId]) {
    if (!ID.test(v)) throw new Error(`Недопустимый id в пути Blob: ${v}`);
  }
  if (!Number.isInteger(p.idx) || p.idx < 0 || p.idx > 99) {
    throw new Error('Недопустимый номер артефакта');
  }
  const ext = p.contentType === 'image/png' ? 'png' : 'jpg';
  // Случайный суффикс: путь не угадывается и по id задания (Ш0.6).
  const rnd = randomBytes(9).toString('base64url');
  return `browser/${p.accountId}/${p.jobId}/${p.idx}-${rnd}.${ext}`;
}

@Injectable()
export class BrowserArtifactStorage {
  protected token(): string {
    const t = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!t) throw new Error('BLOB_READ_WRITE_TOKEN не задан');
    return t;
  }

  async put(
    pathname: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await put(pathname, body, {
      access: 'private',
      token: this.token(),
      contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
  }

  /** Подписанная ссылка на чтение до `validUntil`. */
  async signedUrl(pathname: string, validUntil: Date): Promise<string> {
    const signed = await issueSignedToken({
      token: this.token(),
      pathname,
      operations: ['get'],
      validUntil: validUntil.getTime(),
    });
    const { presignedUrl } = await presignUrl(signed, {
      operation: 'get',
      pathname,
      access: 'private',
      validUntil: validUntil.getTime(),
    });
    return presignedUrl;
  }

  async remove(pathname: string): Promise<void> {
    await del(pathname, { token: this.token() });
  }
}
