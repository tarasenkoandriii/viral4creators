/**
 * Находка из мини-аппа (этап 160, §3.8 ТЗ на работу с тестировщиком).
 *
 * Два запроса, а не три: ссылку на загрузку выдаёт первый, а
 * подтверждением, что файл доехал, работает само создание находки —
 * сервер проверяет хранилище сам. Отдельный «confirm», как у фото
 * товара, здесь лишний: там подтверждать нужно было в сессию, которая
 * живёт дальше, а тут следующий же запрос и есть конец истории.
 */

import { api } from './api';
import { readEnvironment } from '../lib/environment';

export interface TicketAttachmentRef {
  pathname: string;
  mimeType?: string;
  fileName?: string;
}

function unwrap<T>(data: T | { data: T } | undefined): T | undefined {
  if (!data) return undefined;
  if (typeof data === 'object' && data !== null && 'data' in data) {
    return (data as { data: T }).data;
  }
  return data as T;
}

/**
 * Положить файл в хранилище и вернуть путь, на который потом сошлётся
 * находка. Тип и размер проверяет сервер — до выдачи ссылки, а не
 * после загрузки: сказать о потолке после ожидания дороже всего.
 */
export async function uploadTicketFile(
  file: File
): Promise<TicketAttachmentRef> {
  const res = await api.post<{ pathname: string; uploadUrl: string }>(
    '/me/test-tickets/upload-url',
    { mimeType: file.type || 'application/octet-stream', sizeBytes: file.size }
  );
  const issued = unwrap(res.data);
  if (!issued?.uploadUrl) throw new Error('upload url missing');

  const put = await fetch(issued.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);

  return {
    pathname: issued.pathname,
    mimeType: file.type || undefined,
    fileName: file.name,
  };
}

export async function createTicket(input: {
  text: string;
  uiLocale: string;
  sessionId?: string | null;
  stepId?: string | null;
  attachments?: TicketAttachmentRef[];
}): Promise<{ number: number }> {
  const res = await api.post<{ id: string; number: number }>(
    '/me/test-tickets',
    {
      text: input.text,
      sessionId: input.sessionId ?? undefined,
      stepId: input.stepId ?? undefined,
      attachments: input.attachments?.length ? input.attachments : undefined,
      // Окружение снимается ЗДЕСЬ, в момент отправки: в этом и весь
      // смысл второго входа. Из бота приезжает последнее известное, и
      // разница между ними — половина ответа на «чем воспроизводить».
      environment: readEnvironment(input.uiLocale),
    }
  );
  const created = unwrap(res.data);
  if (!created) throw new Error('ticket not created');
  return created;
}
