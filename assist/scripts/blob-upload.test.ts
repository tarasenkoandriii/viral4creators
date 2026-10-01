import assert from 'node:assert/strict';
import { uploadWithTicket, type PutFn } from '../src/lib/blob-upload';
import { ClientKnowledgeError } from '../src/lib/knowledge-errors';
import type { UploadTicketView } from '../src/lib/knowledge-types';

const ticket: UploadTicketView = {
  pathname: 'assist/acc/site1/site/src1/price.pdf',
  clientToken: 'vercel_blob_client_TOKEN',
  maxBytes: 100,
  contentType: 'application/pdf',
  expiresAt: '2026-10-01T13:00:00Z',
};
const now = new Date('2026-10-01T12:00:00Z');
const file = new Blob(['x'.repeat(50)], { type: 'application/pdf' });

const seen: Array<{ pathname: string; opts: Parameters<PutFn>[2] }> = [];
const okPut: PutFn = async (pathname, _body, opts) => {
  seen.push({ pathname, opts });
  opts.onUploadProgress?.({ percentage: 49.6 });
  return {};
};
const progress: number[] = [];
await uploadWithTicket(ticket, file, {
  now,
  put: okPut,
  onProgress: (p) => progress.push(p),
});
// Ровно путь и токен билета, и ТОЛЬКО private: документы знаний не
// должны оказаться по публичной ссылке Blob.
assert.equal(seen.length, 1);
assert.equal(seen[0].pathname, ticket.pathname);
assert.equal(seen[0].opts.access, 'private');
assert.equal(seen[0].opts.token, ticket.clientToken);
assert.equal(seen[0].opts.contentType, 'application/pdf');
assert.deepEqual(progress, [50]);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ClientKnowledgeError);
    return (e as ClientKnowledgeError).code;
  }
  return 'no-error';
}
// Больше билета — отказ ДО загрузки.
seen.length = 0;
const big = new Blob(['x'.repeat(101)]);
assert.equal(
  await code(uploadWithTicket(ticket, big, { now, put: okPut })),
  'DOCUMENT_TOO_LARGE'
);
assert.equal(seen.length, 0);
// Просроченный билет — отказ до загрузки.
assert.equal(
  await code(
    uploadWithTicket(ticket, file, {
      now: new Date('2026-10-01T13:00:00Z'),
      put: okPut,
    })
  ),
  'UPLOAD_FAILED'
);
assert.equal(seen.length, 0);
// Ошибка Blob (английский технический текст) → свой код.
const badPut: PutFn = async () => {
  throw new Error('Vercel Blob: Access denied, please provide a valid token');
};
assert.equal(
  await code(uploadWithTicket(ticket, file, { now, put: badPut })),
  'UPLOAD_FAILED'
);
// maxBytes 0 (сервер не сообщил) — проверку размера не выдумываем.
await uploadWithTicket({ ...ticket, maxBytes: 0 }, big, { now, put: okPut });
assert.equal(seen.length, 1);

console.log('blob-upload: ok');
