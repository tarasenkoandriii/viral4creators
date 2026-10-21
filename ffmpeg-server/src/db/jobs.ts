/**
 * Типы строк и общие запросы к jobs/events. Публичный вид задачи (ответ
 * GET /api/jobs/:id) строится в api/, здесь — только хранение.
 */
import type { ErrorCode } from '../contracts';
import type { Db } from './database';

export type JobStatus =
  'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export type JobStage =
  | 'queued'
  | 'downloading'
  | 'probing'
  | 'running'
  | 'validating'
  | 'publishing'
  | 'done';

export const TERMINAL: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'canceled',
];

export interface JobRow {
  seq: number;
  id: string;
  client_id: string;
  client_operation_id: string | null;
  status: JobStatus;
  stage: JobStage;
  error_code: ErrorCode | null;
  error_message: string;
  execution_status: 'succeeded' | 'failed' | 'canceled' | null;
  created_at: number;
  updated_at: number;
  queue_deadline_at: number;
  claimed_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  expires_at: number | null;
  pipeline_deadline_at: number | null;
  attempt_count: number;
  current_attempt_id: string | null;
  retry_inputs_from: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  cancel_requested_at: number | null;
  purge_requested_at: number | null;
  purged_at: number | null;
  payload_enc: string | null;
  payload_key_id: string | null;
  payload_redacted: number;
  fingerprint: string;
  fingerprint_key_id: string;
  limits_revision: number;
  progress: number | null;
  input_names: string;
  output_names: string;
  inputs_metadata: string | null;
  outputs_metadata: string | null;
  ffmpeg_version: string | null;
  image_digest: string | null;
  exit_code: number | null;
  stderr_tail: string | null;
  wall_ms: number | null;
  cpu_ms: number | null;
  peak_rss_kb: number | null;
  input_bytes: number | null;
  output_bytes: number | null;
}

export interface AttemptRow {
  id: string;
  job_id: string;
  n: number;
  status: 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  outcome: string | null;
  error_code: string | null;
  started_at: number;
  executor_started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  signal: string | null;
  wall_ms: number | null;
  cpu_ms: number | null;
  peak_rss_kb: number | null;
}

export interface ArtifactRow {
  job_id: string;
  name: string;
  local_path: string;
  bytes: number;
  sha256: string;
  mime: string;
  created_at: number;
  purged_at: number | null;
}

export function getJob(db: Db, id: string): JobRow | undefined {
  return db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
}

/** Задача клиента; чужая/неизвестная → undefined (404 без утечки). */
export function getClientJob(
  db: Db,
  clientId: string,
  id: string,
): JobRow | undefined {
  return db.get<JobRow>('SELECT * FROM jobs WHERE id = ? AND client_id = ?', [
    id,
    clientId,
  ]);
}

/**
 * Журнал событий: только безопасные поля (коды, этапы, числа). Никаких
 * URL, команд, stderr, токенов и ключей.
 */
export function addEvent(
  db: Db,
  jobId: string | null,
  type: string,
  data: Record<string, string | number | boolean | null> = {},
  now = Date.now(),
): void {
  db.run('INSERT INTO events (job_id, at, type, data) VALUES (?, ?, ?, ?)', [
    jobId,
    now,
    type,
    Object.keys(data).length ? JSON.stringify(data) : null,
  ]);
}

/** Отзыв всех ссылок задачи (purge/expiry/отмена). */
export function revokeTokens(db: Db, jobId: string): number {
  return db.run(
    'UPDATE download_tokens SET revoked = 1 WHERE job_id = ? AND revoked = 0',
    [jobId],
  ).changes;
}
