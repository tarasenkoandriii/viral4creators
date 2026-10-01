/**
 * Загрузка документа знаний напрямую в Vercel Blob по клиентскому токену
 * (контракт Э1 §1 п.11): файл идёт мимо функции sites-backend (лимит тела
 * функции 4,5 МБ, а документ — до 20 МБ). Порядок:
 *   1. POST …/sources {kind:'file', …} → источник + билет загрузки;
 *   2. put(pathname, file, { access: 'private', token }) — этот модуль;
 *   3. POST …/sources/:sid/uploaded → разбор кроном.
 *
 * `put` подменяется в тестах; настоящий грузится лениво — пакет нужен
 * только тем, кто загружает файл, и не утяжеляет первый экран.
 */

import { ClientKnowledgeError } from './knowledge-errors';
import type { UploadTicketView } from './knowledge-types';

export type PutFn = (
  pathname: string,
  body: Blob,
  opts: {
    access: 'private';
    token: string;
    contentType: string;
    onUploadProgress?: (e: { percentage: number }) => void;
  }
) => Promise<unknown>;

async function defaultPut(): Promise<PutFn> {
  const m = await import('@vercel/blob/client');
  return m.put as unknown as PutFn;
}

export async function uploadWithTicket(
  ticket: UploadTicketView,
  file: Blob,
  opts: {
    now?: Date;
    put?: PutFn;
    onProgress?: (percent: number) => void;
  } = {}
): Promise<void> {
  // Билет сервер выдал под конкретный размер — больший файл Blob всё
  // равно отвергнет, но уже после загрузки мегабайтов.
  if (ticket.maxBytes > 0 && file.size > ticket.maxBytes) {
    throw new ClientKnowledgeError('DOCUMENT_TOO_LARGE');
  }
  const exp = Date.parse(ticket.expiresAt);
  if (Number.isFinite(exp) && exp <= (opts.now ?? new Date()).getTime()) {
    throw new ClientKnowledgeError('UPLOAD_FAILED');
  }
  const put = opts.put ?? (await defaultPut());
  try {
    await put(ticket.pathname, file, {
      access: 'private',
      token: ticket.clientToken,
      contentType: ticket.contentType,
      onUploadProgress: opts.onProgress
        ? (e) => opts.onProgress?.(Math.round(e.percentage))
        : undefined,
    });
  } catch {
    // Текст ошибки Blob — английский и технический; человеку — свой.
    throw new ClientKnowledgeError('UPLOAD_FAILED');
  }
}
