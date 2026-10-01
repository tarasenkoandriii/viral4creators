/**
 * Токен загрузки документа в приватный Blob (K3, §4.4): ровно один путь
 * режима, заявленный размер ≤ 20 МБ, ровно заявленный тип, без
 * перезаписи; без BLOB_READ_WRITE_TOKEN — понятный 503, а не падение SDK.
 */
import { getPayloadFromClientToken } from '@vercel/blob/client';
import { e1CodeOf } from './errors';
import {
  KnowledgeBlobStorage,
  knowledgeBlobPathname,
  readLimited,
} from './blob-storage';

// Формат токена Vercel: vercel_blob_rw_<storeId>_<secret>. Секрет — фикция.
const FAKE_RW = 'vercel_blob_rw_teststore123_secretsecretsecret';

function storage(token: string | null): KnowledgeBlobStorage {
  const s = new KnowledgeBlobStorage();
  if (token === null) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = token;
  return s;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'resolved',
    (e) => e1CodeOf(e) ?? String(e),
  );
}

describe('KnowledgeBlobStorage', () => {
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  afterAll(() => {
    if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = saved;
  });

  const base = {
    accountId: 'acc1',
    siteId: 'site1',
    sourceId: 'src1',
    fileName: '../Прайс 2026.pdf',
    contentType: 'application/pdf',
    bytes: 12345,
  };

  it('путь режима и ограничения токена', async () => {
    const t = await storage(FAKE_RW).issueUpload({ ...base, mode: 'admin' });
    expect(t.pathname).toBe('assist/acc1/site1/admin/src1/Прайс 2026.pdf');
    expect(t.maxBytes).toBe(12345);
    expect(t.contentType).toBe('application/pdf');
    const payload = getPayloadFromClientToken(t.clientToken);
    expect(payload).toMatchObject({
      pathname: t.pathname,
      maximumSizeInBytes: 12345,
      allowedContentTypes: ['application/pdf'],
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(payload.validUntil).toBe(Date.parse(t.expiresAt));
    // Серверный секрет в ответ не уходит.
    expect(t.clientToken).not.toContain('secretsecret');
  });

  it('больше 20 МБ, ноль и чужой тип — отказ до токена', async () => {
    const s = storage(FAKE_RW);
    expect(
      await codeOf(
        s.issueUpload({ ...base, mode: 'site', bytes: 20 * 1024 * 1024 + 1 }),
      ),
    ).toBe('DOCUMENT_TOO_LARGE');
    expect(
      await codeOf(s.issueUpload({ ...base, mode: 'site', bytes: 0 })),
    ).toBe('DOCUMENT_TOO_LARGE');
    expect(
      await codeOf(
        s.issueUpload({ ...base, mode: 'site', contentType: 'text/html' }),
      ),
    ).toBe('DOCUMENT_TYPE');
  });

  it('без BLOB_READ_WRITE_TOKEN — 503 с кодом', async () => {
    expect(
      await codeOf(storage(null).issueUpload({ ...base, mode: 'site' })),
    ).toBe('DOCUMENT_NOT_UPLOADED');
  });

  it('id с «/» или «..» в путь не попадает', () => {
    expect(() =>
      knowledgeBlobPathname({ ...base, mode: 'site', siteId: '../x' }),
    ).toThrow(/Недопустимый id/);
    expect(() =>
      knowledgeBlobPathname({
        ...base,
        mode: 'public' as unknown as 'site',
      }),
    ).toThrow(/режим/);
  });

  it('readLimited обрывает поток на лимите', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(600));
        c.enqueue(new Uint8Array(600));
        c.close();
      },
    });
    expect(await codeOf(readLimited(stream, 1000))).toBe('DOCUMENT_TOO_LARGE');
    const ok = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.close();
      },
    });
    expect([...(await readLimited(ok, 10))]).toEqual([1, 2]);
  });
});
