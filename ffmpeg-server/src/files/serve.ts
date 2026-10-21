/**
 * Выдача файла результата: GET/HEAD /api/files/:jobId/:name?token=…
 * (ТЗ §7). Проверки на каждом запросе: хеш токена, привязка к job/file,
 * срок и отзыв, живой артефакт и статус задачи. 410 — ссылка истекла,
 * отозвана или файлы удалены. Ограниченный Range (одиночный диапазон),
 * TTL не продлевается. Content-Type задаёт сервер, безопасный
 * Content-Disposition, nosniff, private no-store.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Ctx } from '../context';
import { hashToken } from '../crypto/crypto';
import { type ArtifactRow, getJob } from '../db/jobs';
import { HttpError } from '../api/http';
import { isInside } from './fsutil';

const SAFE_MIME =
  /^(video\/(mp4|webm|quicktime|x-matroska|mpeg)|audio\/(mpeg|mp4|aac|wav|x-wav|ogg|webm|flac)|image\/(jpeg|png|webp|gif)|text\/plain|application\/x-subrip|text\/x-ssa|text\/vtt|application\/json)$/;

export function safeMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0].trim();
  return SAFE_MIME.test(m) ? m : 'application/octet-stream';
}

export function contentDisposition(name: string): string {
  const base = path.basename(name);
  const ascii = base.replace(/[^\x20-\x7e]|["\\%;]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

interface TokenRow {
  hash: string;
  job_id: string;
  file: string;
  expires_at: number;
  revoked: number;
}

/** Ограниченный Range: один диапазон bytes=a-b | a- | -n. */
export function parseRange(
  h: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start > end || start >= size)
    return 'invalid';
  return { start, end };
}

export async function serveFile(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  name: string,
  token: string | null,
): Promise<void> {
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'token required');
  const row = ctx.db.get<TokenRow>(
    'SELECT * FROM download_tokens WHERE hash = ?',
    [hashToken(token)],
  );
  if (!row || row.job_id !== jobId || row.file !== name) {
    throw new HttpError(404, 'NOT_FOUND', 'not found');
  }
  const now = ctx.now();
  if (row.revoked) throw new HttpError(410, 'GONE', 'link revoked');
  if (row.expires_at <= now) throw new HttpError(410, 'GONE', 'link expired');
  const job = getJob(ctx.db, jobId);
  const art = ctx.db.get<ArtifactRow>(
    'SELECT * FROM artifacts WHERE job_id = ? AND name = ?',
    [jobId, name],
  );
  if (
    !job ||
    !art ||
    art.purged_at ||
    job.status !== 'succeeded' ||
    job.purge_requested_at ||
    (job.expires_at !== null && job.expires_at <= now)
  ) {
    throw new HttpError(410, 'GONE', 'outputs are no longer available');
  }
  const file = path.join(ctx.cfg.outputsRoot, art.local_path);
  if (!isInside(ctx.cfg.outputsRoot, file)) {
    throw new HttpError(410, 'GONE', 'outputs are no longer available');
  }
  let fh: import('node:fs/promises').FileHandle;
  try {
    fh = await fsp.open(file, 'r');
  } catch {
    throw new HttpError(410, 'GONE', 'outputs are no longer available');
  }
  let size: number;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== art.bytes) {
      throw new HttpError(410, 'GONE', 'outputs are no longer available');
    }
    size = st.size;
  } catch (e) {
    await fh.close();
    throw e;
  }
  const headers: Record<string, string> = {
    'Content-Type': safeMime(art.mime),
    'Content-Disposition': contentDisposition(name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
    'Accept-Ranges': 'bytes',
    ETag: `"${art.sha256}"`,
  };
  const range = parseRange(
    typeof req.headers.range === 'string' ? req.headers.range : undefined,
    size,
  );
  if (range === 'invalid') {
    await fh.close();
    res.writeHead(416, {
      ...headers,
      'Content-Range': `bytes */${size}`,
      'Content-Length': '0',
    });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const status = range ? 206 : 200;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) {
    await fh.close();
    res.end();
    return;
  }
  const stream = createReadStream('', { fd: fh, start, end, autoClose: true });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  ctx.metrics.inc('ffmpeg_file_downloads_total', 'File download requests', {
    status: String(status),
  });
}
