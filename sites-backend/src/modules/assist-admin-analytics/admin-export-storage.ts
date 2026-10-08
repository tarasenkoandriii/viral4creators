/**
 * Приватный Blob выгрузок «Админки» (заход 10, №57): путь
 * `assist/<accountId>/<siteId>/admin-exports/<id>.csv` (отдельно от выгрузок
 * «Сайта» — У-25), доступ `private`, ссылка — подписанный GET на срок жизни
 * файла (24 ч). Токен — BLOB_READ_WRITE_TOKEN, новых env нет. Своя копия
 * хранилища «Сайта» (правило графа «Админка» ↛ assist-analytics). В тестах
 * подменяется.
 */
import { Injectable } from '@nestjs/common';
import { del, issueSignedToken, presignUrl, put } from '@vercel/blob';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function adminExportBlobPathname(p: {
  accountId: string;
  siteId: string;
  exportId: string;
}): string {
  for (const v of [p.accountId, p.siteId, p.exportId]) {
    if (!ID.test(v)) throw new Error(`Недопустимый id в пути Blob: ${v}`);
  }
  return `assist/${p.accountId}/${p.siteId}/admin-exports/${p.exportId}.csv`;
}

@Injectable()
export class AdminExportStorage {
  protected token(): string {
    const t = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!t) throw new Error('BLOB_READ_WRITE_TOKEN не задан');
    return t;
  }

  async put(pathname: string, body: string): Promise<void> {
    await put(pathname, body, {
      access: 'private',
      token: this.token(),
      contentType: 'text/csv; charset=utf-8',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }

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
