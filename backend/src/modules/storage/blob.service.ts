/**
 * BlobService
 *
 * All object storage for the app goes through Vercel Blob — one provider
 * for three quite different uses:
 *
 *  - Reference video (transit only): a short-lived copy that lets a large
 *    upload get past the 4.5MB request body limit of Vercel Functions.
 *    AnalysisService downloads it exactly once (to hand the bytes to
 *    Gemini's Files API) and deletes it immediately after — see
 *    AnalysisService.performAnalysis. Uses createUploadUrl + downloadBuffer
 *    + deleteBlob.
 *  - Product image (durable): uploaded the same presigned-PUT way, but
 *    kept — GenerationService downloads it later as Veo's first frame.
 *    Uses createUploadUrl + downloadBuffer.
 *  - Generated video (durable): written server-side once Veo finishes
 *    rendering, then served back to the browser directly from its public
 *    Blob URL — no presigned-GET re-issuing needed like S3, since a fixed
 *    pathname's public URL is stable for as long as the blob exists. Uses
 *    uploadBuffer.
 *
 * All blobs are created with `access: 'public'` — same security model as
 * the rest of this app, which has no real auth and already treats a
 * session's UUID as its bearer secret (see specs/: "no authentication
 * required for MVP"). A public blob's URL isn't listed anywhere unless
 * you already know the session-scoped pathname, so this doesn't lower the
 * bar the app already accepts elsewhere. This used to be split with AWS
 * S3 (durable storage) alongside Blob (transit only) — see
 * doc/VERCEL-READINESS-AUDIT.md's answer on why that was two providers
 * instead of one; consolidated here onto Blob alone.
 *
 * Requires either:
 *  - BLOB_READ_WRITE_TOKEN (static token; needed for local dev — pull it
 *    with `vercel env pull`), or
 *  - Vercel's own OIDC token + BLOB_STORE_ID, automatically present when
 *    deployed on Vercel with a connected Blob store.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  issueSignedToken,
  presignUrl,
  put,
  head,
  del,
  list,
} from '@vercel/blob';

/** How long the browser has to complete the PUT after we issue the URL. */
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name);

  /**
   * Issue a one-off presigned PUT URL so the browser can upload the
   * reference video directly to Vercel Blob storage.
   *
   * @param pathname - target path, e.g. "sessions/{sessionId}/original.mp4"
   * @param mimeType - must match the Content-Type header the browser sends
   * @param maxSizeInBytes - enforced by the Blob CDN itself, not just client-side
   */
  async createUploadUrl(
    pathname: string,
    mimeType: string,
    maxSizeInBytes: number,
  ): Promise<{ uploadUrl: string }> {
    const token = await issueSignedToken({
      pathname,
      operations: ['put'],
      allowedContentTypes: [mimeType],
      maximumSizeInBytes: maxSizeInBytes,
      validUntil: Date.now() + UPLOAD_URL_TTL_MS,
    });

    const { presignedUrl } = await presignUrl(token, {
      operation: 'put',
      pathname,
      access: 'public',
      allowedContentTypes: [mimeType],
      maximumSizeInBytes: maxSizeInBytes,
      addRandomSuffix: false,
      allowOverwrite: true,
      validUntil: Date.now() + UPLOAD_URL_TTL_MS,
    });

    return { uploadUrl: presignedUrl };
  }

  /**
   * Download a blob's current bytes into memory — used both for the
   * reference-video transit copy (AnalysisService) and for reading back
   * the durable product image (GenerationService, as Veo's first frame).
   * Throws if nothing has actually been PUT at this pathname yet
   * (head() fails).
   */
  async downloadBuffer(pathname: string): Promise<Buffer> {
    const { url } = await head(pathname);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to download blob "${pathname}" (HTTP ${res.status})`,
      );
    }

    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Публичный URL для уже существующего pathname — без скачивания
   * байтов. Доп. запрос владельца продукта: Grok reference-to-video
   * (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §10.1/§15) принимает картинки
   * ссылкой, а не байтами в теле запроса (в отличие от Veo) — тот же
   * `head()`, что уже использует `downloadBuffer` выше, просто без
   * второго шага (сам `fetch`). Тот же принцип: throws, если по этому
   * pathname ничего не лежит.
   */
  async getPublicUrl(pathname: string): Promise<string> {
    const { url } = await head(pathname);
    return url;
  }

  /**
   * Лежит ли уже что-то по этому пути, и что именно (этап 160).
   *
   * От `getPublicUrl` отличается одним: ОТСУТСТВИЕ файла здесь —
   * обычный ответ, а не исключение. Нужен там, где мы проверяем, дошёл
   * ли браузер до конца загрузки: сорвавшийся PUT — рядовое событие, и
   * ловить его try/catch'ем вокруг чужого throw значило бы путать «файла
   * нет» с «хранилище недоступно».
   */
  async head(pathname: string): Promise<{ url: string; size: number } | null> {
    try {
      const blob = await head(pathname);
      return { url: blob.url, size: blob.size };
    } catch {
      return null;
    }
  }

  /**
   * Write server-generated bytes directly to Blob — used for the
   * completed Veo output (GenerationService downloads it from Google,
   * then hands the buffer here rather than the browser uploading it).
   *
   * `allowOverwrite: true` because the pathname is deterministic
   * (`sessions/{id}/generated.mp4`) — a retried generation for the same
   * session legitimately replaces the previous attempt at the same key.
   *
   * @returns The blob's public URL — stable for this pathname as long as
   * it exists, so callers can store it once and don't need to re-derive
   * or re-sign it on every later status poll (unlike S3 presigned GET
   * URLs, which expire and had to be reissued each time).
   */
  async uploadBuffer(
    pathname: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ url: string }> {
    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return { url: blob.url };
  }

  /**
   * Удалить один файл (транзитная копия референса, запись голоса, фото
   * сцены или персонажа). Не бросает — удаление никогда не должно ломать
   * основную операцию, — но и не молчит (этап 52, В-2.11): протухший
   * `BLOB_READ_WRITE_TOKEN` превращал каждое удаление в ничто без единой
   * строки в логах, транзитные видео копились, и заметить это могла бы
   * только метла. `deleteMany` рядом в такой же ситуации пишет warn —
   * теперь одиночное удаление ведёт себя так же.
   */
  async deleteBlob(pathname: string): Promise<void> {
    try {
      await del(pathname);
    } catch (error) {
      this.logger.warn(
        `не удалось удалить ${pathname}: ${
          error instanceof Error ? error.message : String(error)
        } — файл подберёт метла (sweep-orphans), если он под её префиксом`,
      );
    }
  }

  /**
   * Удалить пачку блобов (TTL-уборка сессий, doc/STORAGE-AUDIT.md).
   * `del()` принимает массив, но неограниченный список — это один
   * гигантский запрос и всё-или-ничего при ошибке, поэтому режем на
   * куски и глотаем ошибку каждого: уборка не должна падать целиком
   * из-за одного отсутствующего файла.
   *
   * @returns сколько путей удалось отправить на удаление
   */
  async deleteMany(pathnames: string[], chunkSize = 50): Promise<number> {
    let done = 0;
    for (let i = 0; i < pathnames.length; i += chunkSize) {
      const chunk = pathnames.slice(i, i + chunkSize);
      try {
        await del(chunk);
        done += chunk.length;
      } catch (e) {
        this.logger.warn(
          `blob cleanup chunk failed (${chunk.length} paths): ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return done;
  }

  /**
   * Одна страница листинга хранилища по префиксу — для подметателя
   * осиротевших файлов (doc/STORAGE-AUDIT.md, этап 27). Курсор отдаём
   * наружу: крон обрабатывает хранилище по страницам, а не целиком.
   */
  async listByPrefix(
    prefix: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{
    blobs: Array<{ pathname: string; uploadedAt: Date }>;
    cursor: string | null;
  }> {
    const page = await list({
      prefix,
      cursor: options.cursor,
      limit: options.limit ?? 500,
    });
    return {
      blobs: page.blobs.map((b) => ({
        pathname: b.pathname,
        uploadedAt: new Date(b.uploadedAt),
      })),
      cursor: page.hasMore ? (page.cursor ?? null) : null,
    };
  }

  /**
   * Скопировать блоб в другой путь — библиотеке нужны собственные копии
   * кадров-превью, чтобы они пережили удаление сессии-источника (§21).
   * Возвращает публичный URL копии или null, если исходника уже нет.
   */
  async copyBlob(
    fromPathname: string,
    toPathname: string,
    contentType = 'image/jpeg',
  ): Promise<string | null> {
    try {
      const buffer = await this.downloadBuffer(fromPathname);
      const { url } = await this.uploadBuffer(toPathname, buffer, contentType);
      return url;
    } catch (e) {
      this.logger.warn(
        `blob copy ${fromPathname} → ${toPathname} failed: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }
}
