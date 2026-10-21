/**
 * Короткоживущие ссылки на файлы результата (ТЗ §7): токен — 32 случайных
 * байта, в БД только sha256, привязка к job/file/expiry, отзыв проверяется
 * на каждом запросе. Повторный авторизованный status выпускает новую
 * ссылку, пока результат существует; TTL ссылки не продлевается.
 */
import { newDownloadToken } from '../crypto/crypto';
import type { Db } from '../db/database';

export function fileUrl(
  publicBaseUrl: string,
  jobId: string,
  name: string,
  token: string,
): string {
  return `${publicBaseUrl}/api/files/${encodeURIComponent(jobId)}/${encodeURIComponent(name)}?token=${token}`;
}

export function issueToken(
  db: Db,
  jobId: string,
  file: string,
  ttlSec: number,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const { token, hash } = newDownloadToken();
  const expiresAt = now + ttlSec * 1000;
  db.run(
    'INSERT INTO download_tokens (hash, job_id, file, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    [hash, jobId, file, now, expiresAt],
  );
  return { token, expiresAt };
}
