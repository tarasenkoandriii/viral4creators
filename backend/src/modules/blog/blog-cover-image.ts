/**
 * blog-cover-image.ts — загрузка обложки блога в собственный Blob вместо
 * хотлинка на YouTube CDN (i.ytimg.com), портировано из Solar Shop
 * (`downloadAndUploadCoverImage`/`backfillMissingCoverImages`,
 * `apps/api/src/articles/articles.service.ts`), адаптировано под уже
 * существующий `BlobService.uploadBuffer()` (DI-injectable) вместо
 * сырого `fetch()`-PUT оригинала.
 *
 * Отличие от Solar Shop: там два поля заводились впервые (coverImage +
 * sourceImageUrl). Здесь `thumbnailUrl` уже был единственным полем
 * показа обложки (используется в лендинге/админке) — его расстановка
 * не меняется. Добавлено только `sourceImageUrl` (этап 95, миграция
 * `20261030090000_blog_source_image_url`) — исходный URL-кандидат,
 * нужен исключительно для бэкофилла (`runCoverImageBackfill` в
 * `blog-generation.service.ts`): "своя копия не удалась — `thumbnailUrl`
 * остался равен `sourceImageUrl`, есть что повторить".
 *
 * Тот же принцип, что в оригинале: "текст важнее картинки" — любая
 * неудача (сеть, Blob, отсутствующий токен, аномальный размер) мягко
 * откатывается на исходный хотлинк, черновик блога никогда не
 * блокируется из-за обложки.
 */

import { Logger } from '@nestjs/common';
import { BlobService } from '../storage/blob.service';
import { fetchWithRetry } from '../../common/fetch-with-retry';

const logger = new Logger('BlogCoverImage');

/**
 * Щедрый потолок для картинки-обложки. YouTube-превью и типичные
 * og:image весят десятки-сотни КБ; это не расчёт под них, а страховка
 * от аномалии (чужой сервер отдал что-то совсем не то по этому URL).
 */
const MAX_COVER_IMAGE_BYTES = 15 * 1024 * 1024;

export interface BlogCoverImageResult {
  /** Публичный URL для показа — свой Blob при успехе, иначе исходный `imageUrl`. */
  thumbnailUrl: string;
  /** Исходный URL-кандидат — всегда сохраняется, независимо от исхода. */
  sourceImageUrl: string;
}

/**
 * Скачивает картинку по `imageUrl` и перезаливает её в собственный Blob
 * (`blog/{slug}.{ext}`). При любой неудаче на любом шаге — мягкий откат:
 * `thumbnailUrl` в результате остаётся равен `imageUrl` (обложка не
 * теряется, просто не своя) — тот же признак, по которому бэкофилл
 * позже найдёт эту запись и повторит попытку.
 */
export async function downloadAndUploadBlogCoverImage(
  imageUrl: string,
  slug: string,
  blob: BlobService,
): Promise<BlogCoverImageResult> {
  const fallback: BlogCoverImageResult = {
    thumbnailUrl: imageUrl,
    sourceImageUrl: imageUrl,
  };

  let res: Response;
  try {
    res = await fetchWithRetry(imageUrl, { retries: 2, timeoutMs: 15_000 });
  } catch (err) {
    logger.warn(
      `скачивание обложки ${imageUrl} (${slug}) провалилось: ${err instanceof Error ? err.message : String(err)} — оставляю хотлинк`,
    );
    return fallback;
  }
  if (!res.ok) {
    logger.warn(
      `скачивание обложки ${imageUrl} (${slug}): HTTP ${res.status} — оставляю хотлинк`,
    );
    return fallback;
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn(
      `чтение тела ответа для обложки ${imageUrl} (${slug}) провалилось: ${err instanceof Error ? err.message : String(err)} — оставляю хотлинк`,
    );
    return fallback;
  }
  if (buffer.length === 0 || buffer.length > MAX_COVER_IMAGE_BYTES) {
    logger.warn(
      `обложка ${imageUrl} (${slug}): подозрительный размер ${buffer.length}б — оставляю хотлинк`,
    );
    return fallback;
  }

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = extensionFor(contentType, imageUrl);

  try {
    const { url } = await blob.uploadBuffer(
      `blog/${slug}.${ext}`,
      buffer,
      contentType,
    );
    return { thumbnailUrl: url, sourceImageUrl: imageUrl };
  } catch (err) {
    logger.warn(
      `загрузка обложки ${slug} в Blob провалилась: ${err instanceof Error ? err.message : String(err)} — оставляю хотлинк`,
    );
    return fallback;
  }
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function extensionFor(contentType: string, imageUrl: string): string {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  if (EXTENSION_BY_CONTENT_TYPE[normalized])
    return EXTENSION_BY_CONTENT_TYPE[normalized];

  // content-type не подсказал (сервер отдал application/octet-stream и
  // т.п.) — пробуем по расширению в самом URL, без query-строки.
  const match = imageUrl.split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
  if (match)
    return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();

  return 'jpg';
}
