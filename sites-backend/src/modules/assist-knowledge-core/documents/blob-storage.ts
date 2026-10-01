/**
 * Приватный Blob для документов знаний — K3 (§4.4, §4.16): путь
 * `assist/<accountId>/<siteId>/<site|admin>/<sourceId>/<имя>`; клиентский
 * токен (`generateClientTokenFromReadWriteToken` из @vercel/blob/client):
 * один pathname, access 'private', короткий TTL, maximumSizeInBytes ≤ 20 МБ,
 * allowedContentTypes — KNOWLEDGE_DEFAULTS.documentMimeTypes. Файл идёт
 * мимо функции (лимит тела Vercel 4,5 МБ). Чтение для разбора — серверным
 * токеном BLOB_READ_WRITE_TOKEN, потоком с лимитом.
 * Режим — параметр, выбирается МАРШРУТОМ (слой 5), не телом запроса.
 *
 * Токен загрузки ограничивает: ровно этот pathname (другой путь — отказ
 * Blob), размер — заявленный владельцем (не больше 20 МБ), тип — ровно
 * заявленный MIME; перезапись запрещена. Содержимое (сигнатуру байтов)
 * токен не проверяет — это делает разбор (parse.ts → DOCUMENT_TYPE).
 */
import { Injectable } from '@nestjs/common';
import { del, get, head } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { KNOWLEDGE_DEFAULTS } from '../../../config/assist-defaults';
import type { KnowledgeMode } from '../tables';
import { e1Error } from './errors';
import { safeFileName } from './parse';

export interface UploadTicket {
  pathname: string;
  clientToken: string;
  maxBytes: number;
  contentType: string;
  expiresAt: string;
}

/** Сколько живёт токен загрузки: хватит на 20 МБ по мобильной сети. */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Путь документа в Blob; id — только безопасные символы (строим путь сами). */
export function knowledgeBlobPathname(p: {
  mode: KnowledgeMode;
  accountId: string;
  siteId: string;
  sourceId: string;
  fileName: string;
}): string {
  for (const v of [p.accountId, p.siteId, p.sourceId]) {
    if (!ID.test(v)) throw new Error(`Недопустимый id в пути Blob: ${v}`);
  }
  if (p.mode !== 'site' && p.mode !== 'admin') {
    throw new Error(`Недопустимый режим в пути Blob: ${String(p.mode)}`);
  }
  return `assist/${p.accountId}/${p.siteId}/${p.mode}/${p.sourceId}/${safeFileName(p.fileName)}`;
}

/** Поток → Buffer с обрывом на лимите (память функции ограничена). */
export async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw e1Error(
        400,
        'DOCUMENT_TOO_LARGE',
        'Файл больше 20 МБ — разделите его на части',
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

@Injectable()
export class KnowledgeBlobStorage {
  /** Подменяется в тестах; в проде — переменная окружения Vercel. */
  protected token(): string {
    const t = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!t) {
      throw e1Error(
        503,
        'DOCUMENT_NOT_UPLOADED',
        'Хранилище документов не настроено — загрузка временно недоступна',
      );
    }
    return t;
  }

  async issueUpload(p: {
    mode: KnowledgeMode;
    accountId: string;
    siteId: string;
    sourceId: string;
    fileName: string;
    contentType: string;
    bytes: number;
  }): Promise<UploadTicket> {
    const max = KNOWLEDGE_DEFAULTS.maxDocumentBytes;
    if (!Number.isInteger(p.bytes) || p.bytes <= 0 || p.bytes > max) {
      throw e1Error(
        400,
        'DOCUMENT_TOO_LARGE',
        'Файл больше 20 МБ — разделите его на части',
      );
    }
    if (
      !(KNOWLEDGE_DEFAULTS.documentMimeTypes as readonly string[]).includes(
        p.contentType,
      )
    ) {
      throw e1Error(
        400,
        'DOCUMENT_TYPE',
        'Поддерживаются PDF, DOCX, TXT, MD и CSV',
      );
    }
    const pathname = knowledgeBlobPathname(p);
    const validUntil = Date.now() + UPLOAD_TOKEN_TTL_MS;
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: this.token(),
      pathname,
      // Заявленный размер, а не общий потолок: подменить файл на больший
      // после подтверждения «этот файл увидят все» нельзя.
      maximumSizeInBytes: p.bytes,
      allowedContentTypes: [p.contentType],
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return {
      pathname,
      clientToken,
      maxBytes: p.bytes,
      contentType: p.contentType,
      expiresAt: new Date(validUntil).toISOString(),
    };
  }

  /** Метаданные загруженного файла; null — файла нет (ещё не загружен). */
  async stat(
    pathname: string,
  ): Promise<{ size: number; contentType: string } | null> {
    try {
      const h = await head(pathname, { token: this.token() });
      return { size: h.size, contentType: h.contentType };
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'BlobNotFoundError') {
        return null;
      }
      throw e;
    }
  }

  async read(pathname: string, maxBytes: number): Promise<Buffer> {
    const r = await get(pathname, {
      access: 'private',
      token: this.token(),
      useCache: false,
    });
    if (!r || r.statusCode !== 200) {
      throw e1Error(
        409,
        'DOCUMENT_NOT_UPLOADED',
        'Файл не найден в хранилище — загрузите его заново',
      );
    }
    if (r.blob.size > maxBytes) {
      await r.stream.cancel().catch(() => undefined);
      throw e1Error(
        400,
        'DOCUMENT_TOO_LARGE',
        'Файл больше 20 МБ — разделите его на части',
      );
    }
    return readLimited(r.stream, maxBytes);
  }

  async remove(pathname: string): Promise<void> {
    await del(pathname, { token: this.token() });
  }
}
