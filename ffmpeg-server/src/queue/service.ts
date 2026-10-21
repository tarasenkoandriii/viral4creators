/**
 * Доменные операции над задачами, общие для API и ops: приём с
 * идемпотентностью (ТЗ §5.2, §8), публичный вид (§5.3), отмена (CAS) и
 * purge (§5.4).
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ErrorCode, JobRequestBody } from '../contracts';
import type { Ctx } from '../context';
import {
  MissingKeyError,
  fingerprint,
  sealPayload,
  sha256Hex,
} from '../crypto/crypto';
import {
  type ArtifactRow,
  type JobRow,
  TERMINAL,
  addEvent,
  getJob,
  revokeTokens,
} from '../db/jobs';
import { fileUrl, issueToken } from '../files/tokens';
import { safeRemove } from '../files/fsutil';

export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,128}$/;
export const OPERATION_ID_RE = /^[\x20-\x7e]{1,128}$/;

export interface SubmitError {
  kind: 'error';
  http: number;
  /** ErrorCode задачи (400/403/422) или код HTTP-отказа (409/429/503). */
  code: ErrorCode | HttpRefusal;
  message: string;
  retryAfterSec?: number;
}

export type HttpRefusal =
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUEUE_FULL'
  | 'CLIENT_QUOTA_EXCEEDED'
  | 'NOT_ACCEPTING'
  | 'RECOVERY'
  | 'SUBMIT_DEADLINE'
  | 'NOT_READY'
  | 'UNAVAILABLE';
export type SubmitOutcome =
  | { kind: 'replay'; job: JobRow }
  | { kind: 'created'; job: JobRow }
  | SubmitError;

const err = (
  http: number,
  code: ErrorCode | HttpRefusal,
  message: string,
  retryAfterSec?: number,
): SubmitError => ({ kind: 'error', http, code, message, retryAfterSec });

/** Форма тела: ровно три поля нужных типов; лишние поля — отказ (ТЗ §1). */
export function validateShape(
  body: unknown,
): { ok: true; body: JobRequestBody } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'body must be a JSON object' };
  }
  const rec = body as Record<string, unknown>;
  const allowed = ['input_files', 'output_files', 'ffmpeg_commands'];
  const extra = Object.keys(rec).filter((k) => !allowed.includes(k));
  if (extra.length) {
    return {
      ok: false,
      message: `unknown fields: ${extra.slice(0, 5).join(', ')}`,
    };
  }
  const inputs = rec.input_files;
  if (
    !inputs ||
    typeof inputs !== 'object' ||
    Array.isArray(inputs) ||
    !Object.values(inputs).every((v) => typeof v === 'string')
  ) {
    return { ok: false, message: 'input_files must be an object of strings' };
  }
  for (const f of ['output_files', 'ffmpeg_commands'] as const) {
    const v = rec[f];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      return { ok: false, message: `${f} must be an array of strings` };
    }
  }
  if ((rec.output_files as string[]).length === 0) {
    return { ok: false, message: 'output_files must not be empty' };
  }
  if ((rec.ffmpeg_commands as string[]).length === 0) {
    return { ok: false, message: 'ffmpeg_commands must not be empty' };
  }
  return { ok: true, body: rec as unknown as JobRequestBody };
}

interface KeyRow {
  job_id: string;
  fingerprint: string;
  fingerprint_key_id: string;
}

type KeyLookup =
  | { kind: 'none' }
  | { kind: 'match'; job: JobRow }
  | { kind: 'conflict' }
  | { kind: 'error'; error: SubmitError };

/** Поиск ключа и сравнение fingerprint (тем ключом HMAC, которым он снят). */
export function lookupKey(
  ctx: Ctx,
  clientId: string,
  key: string,
  body: unknown,
): KeyLookup {
  const row = ctx.db.get<KeyRow>(
    'SELECT job_id, fingerprint, fingerprint_key_id FROM idempotency_keys WHERE client_id = ? AND key_hash = ?',
    [clientId, sha256Hex(key)],
  );
  if (!row) return { kind: 'none' };
  let fp: string;
  try {
    fp = fingerprint(ctx.cfg.hmacKeys, body, row.fingerprint_key_id).value;
  } catch (e) {
    if (e instanceof MissingKeyError) {
      ctx.log.error('idempotency.hmac_key_missing', { keyId: e.keyId });
      return {
        kind: 'error',
        error: err(503, 'UNAVAILABLE', 'fingerprint key unavailable', 60),
      };
    }
    throw e;
  }
  if (fp !== row.fingerprint) return { kind: 'conflict' };
  const job = getJob(ctx.db, row.job_id);
  if (!job) {
    // Ключ пережил историю задачи (не должно быть: tombstone ≥ history).
    return {
      kind: 'error',
      error: err(410, 'OUTPUT_EXPIRED', 'job history expired'),
    };
  }
  return { kind: 'match', job };
}

export async function submit(
  ctx: Ctx,
  args: {
    clientId: string;
    key: string;
    body: unknown;
    operationId: string | null;
    /** Когда сервер получил запрос (ctx.now()) — для дедлайна фиксации. */
    receivedAt?: number;
  },
): Promise<SubmitOutcome> {
  const { clientId, key, body } = args;
  // 1. Существующий ключ — прежняя задача без квот/readiness (ТЗ §5.2).
  const first = lookupKey(ctx, clientId, key, body);
  if (first.kind === 'match') return { kind: 'replay', job: first.job };
  if (first.kind === 'conflict') {
    return err(
      409,
      'IDEMPOTENCY_CONFLICT',
      'Idempotency-Key reused with a different body',
    );
  }
  if (first.kind === 'error') return first.error;

  // 2. Синтаксис, команды, источники.
  const shape = validateShape(body);
  if (!shape.ok) return err(400, 'INVALID_REQUEST', shape.message);
  const limits = ctx.limits.current();
  const parsed = ctx.ports.parseJob(shape.body, limits);
  if (!parsed.ok) {
    return err(
      parsed.code === 'UNSUPPORTED_COMMAND' ? 422 : 400,
      parsed.code,
      parsed.message,
    );
  }
  for (const inp of parsed.plan.inputs) {
    const chk = ctx.ports.checkSourceUrl(inp.url, ctx.cfg.inputAllowedHosts, {
      allowedPorts: ctx.downloadExtra.allowedPorts,
    });
    if (!chk.ok) {
      return err(
        403,
        'FORBIDDEN_SOURCE',
        `input ${inp.key}: source not allowed`,
      );
    }
  }

  // 3. Режим, readiness, диск — только для новой задачи.
  if (!ctx.control.acceptsSubmits()) {
    // recovery — отдельный код: БД не доверенная, это НЕ доказанный отказ
    // до приёма, и backend не должен уводить операцию к hosted (FF-INT-03).
    return ctx.control.get().mode === 'recovery'
      ? err(
          503,
          'RECOVERY',
          'server is in recovery: submit outcome is not provable',
          60,
        )
      : err(503, 'NOT_ACCEPTING', 'not accepting new jobs', 60);
  }
  const ready = await ctx.readiness.check(ctx.now());
  if (!ready.ready) {
    return err(503, 'NOT_READY', 'service not ready', 30);
  }

  // 4. Транзакция: повторная проверка ключа, квоты, запись job + key.
  const now = ctx.now();
  const fp = fingerprint(ctx.cfg.hmacKeys, body);
  const outcome = ctx.db.tx((): SubmitOutcome => {
    const again = lookupKey(ctx, clientId, key, body);
    if (again.kind === 'match') return { kind: 'replay', job: again.job };
    if (again.kind === 'conflict') {
      return err(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Idempotency-Key reused with a different body',
      );
    }
    if (again.kind === 'error') return again.error;
    const total = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'",
    )!.n;
    if (total >= ctx.cfg.queue.maxQueuedTotal) {
      return err(429, 'QUEUE_FULL', 'server queue is full', retryAfter(ctx));
    }
    const mine = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE client_id = ? AND status = 'queued'",
      [clientId],
    )!.n;
    if (mine >= ctx.cfg.queue.maxQueuedPerClient) {
      return err(
        429,
        'CLIENT_QUOTA_EXCEEDED',
        'client queue quota exceeded',
        retryAfter(ctx),
      );
    }
    // Дедлайн фиксации (FF-INT-09): позже него задача не создаётся. Клиент,
    // ждавший дольше дедлайна, по by-key 404 знает наверняка: не принято.
    const receivedAt = args.receivedAt ?? now;
    if (ctx.now() - receivedAt > ctx.cfg.submitCommitDeadlineMs) {
      return err(
        503,
        'SUBMIT_DEADLINE',
        'submit commit deadline exceeded; nothing was created',
        5,
      );
    }
    const id = randomUUID();
    const sealed = sealPayload(
      ctx.cfg.payloadKeys,
      JSON.stringify(shape.body),
      id,
    );
    ctx.db.run(
      `INSERT INTO jobs (id, client_id, client_operation_id, status, stage, created_at, updated_at,
         queue_deadline_at, payload_enc, payload_key_id, fingerprint, fingerprint_key_id,
         limits_revision, progress, input_names, output_names, image_digest)
       VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id,
        clientId,
        args.operationId,
        now,
        now,
        now + limits.queueDeadlineSec * 1000,
        sealed.sealed,
        sealed.keyId,
        fp.value,
        fp.keyId,
        limits.revision,
        JSON.stringify(Object.keys(shape.body.input_files)),
        JSON.stringify(shape.body.output_files),
        ctx.cfg.imageDigest,
      ],
    );
    ctx.db.run(
      `INSERT INTO idempotency_keys (client_id, key_hash, job_id, fingerprint, fingerprint_key_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [clientId, sha256Hex(key), id, fp.value, fp.keyId, now],
    );
    addEvent(
      ctx.db,
      id,
      'job.accepted',
      { limits_revision: limits.revision },
      now,
    );
    return { kind: 'created', job: getJob(ctx.db, id)! };
  });
  if (outcome.kind === 'created') {
    ctx.control.noteJobSeq(outcome.job.seq);
    ctx.metrics.inc('ffmpeg_jobs_accepted_total', 'Accepted jobs', {
      client: clientId,
    });
    ctx.log.info('job.accepted', {
      job_id: outcome.job.id,
      client_id: clientId,
      operation_id: outcome.job.client_operation_id,
      inputs: parsed.plan.inputs.length,
      steps: parsed.plan.steps.length,
      outputs: parsed.plan.outputs.length,
    });
    ctx.kick();
  }
  return outcome;
}

/** Оценка Retry-After: средняя длительность × длина очереди, 30..600 с. */
function retryAfter(ctx: Ctx): number {
  const r = ctx.db.get<{ avg: number | null }>(
    `SELECT AVG(finished_at - claimed_at) AS avg FROM (
       SELECT finished_at, claimed_at FROM jobs
       WHERE claimed_at IS NOT NULL AND finished_at IS NOT NULL
       ORDER BY seq DESC LIMIT 20)`,
  );
  const avgSec = (r?.avg ?? 60_000) / 1000;
  return Math.max(30, Math.min(600, Math.round(avgSec)));
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

/**
 * Публичный вид задачи (совместим с FfmpegApiService: data.status,
 * data.output_files, data.error_message). Ссылки выпускаются только для
 * succeeded с живыми артефактами.
 */
export function publicView(
  ctx: Ctx,
  job: JobRow,
  opts: { issueLinks: boolean } = { issueLinks: true },
): Record<string, unknown> {
  const outputs: Record<string, string> = {};
  if (
    opts.issueLinks &&
    job.status === 'succeeded' &&
    !job.purge_requested_at
  ) {
    const arts = ctx.db.all<ArtifactRow>(
      'SELECT * FROM artifacts WHERE job_id = ? AND purged_at IS NULL ORDER BY rowid',
      [job.id],
    );
    const now = ctx.now();
    for (const a of arts) {
      const { token } = issueToken(
        ctx.db,
        job.id,
        a.name,
        ctx.cfg.retention.downloadTokenTtlSec,
        now,
      );
      outputs[a.name] = fileUrl(ctx.cfg.publicBaseUrl, job.id, a.name, token);
    }
  }
  let progress: number | null;
  if (job.status === 'succeeded') progress = 100;
  else if (job.status === 'queued') progress = 0;
  else progress = job.progress === null ? null : Math.round(job.progress);
  return {
    id: job.id,
    status: job.status,
    stage:
      job.status === 'processing'
        ? job.stage
        : job.status === 'queued'
          ? 'queued'
          : 'done',
    progress,
    error_code: job.error_code,
    error_message: job.error_message ?? '',
    output_files: outputs,
    execution_status: job.execution_status,
    client_operation_id: job.client_operation_id,
    created_at: iso(job.created_at),
    started_at: iso(job.started_at),
    finished_at: iso(job.finished_at),
    expires_at: iso(job.expires_at),
    outputs_metadata:
      job.status === 'succeeded' && job.outputs_metadata
        ? JSON.parse(job.outputs_metadata)
        : null,
    ffmpeg_version: job.ffmpeg_version,
    image_digest: job.image_digest,
  };
}

/**
 * Отмена (ТЗ §5.4): идемпотентна; гонка с завершением — CAS по статусу.
 * Готовая задача не становится canceled. Активная помечается canceled
 * сразу, а диспетчер останавливает executor и освобождает слот только
 * после подтверждения завершения группы процессов.
 */
export function cancelJob(
  ctx: Ctx,
  jobId: string,
  actor: string | null,
): JobRow {
  const now = ctx.now();
  ctx.db.tx(() => {
    const job = getJob(ctx.db, jobId);
    if (!job || TERMINAL.includes(job.status)) return;
    const r = ctx.db.run(
      `UPDATE jobs SET status = 'canceled', error_code = 'CANCELED', error_message = 'canceled',
         execution_status = 'canceled', finished_at = ?, updated_at = ?,
         cancel_requested_at = COALESCE(cancel_requested_at, ?),
         payload_enc = CASE WHEN status = 'queued' THEN NULL ELSE payload_enc END
       WHERE id = ? AND status = ?`,
      [now, now, now, jobId, job.status],
    );
    if (r.changes) {
      addEvent(ctx.db, jobId, 'job.canceled', { from: job.status, actor }, now);
      ctx.metrics.inc(
        'ffmpeg_jobs_finished_total',
        'Finished jobs by status/code',
        {
          status: 'canceled',
          code: 'CANCELED',
        },
      );
    }
  });
  ctx.kick();
  return getJob(ctx.db, jobId)!;
}

/**
 * Purge (ТЗ §5.4, §7): отзыв ссылок сразу, остановка активной задачи,
 * удаление файлов. done=false — активная задача ещё останавливается
 * (ответ 202), done=true — удаление подтверждено (200).
 */
export async function purgeJob(
  ctx: Ctx,
  jobId: string,
  actor: string | null,
): Promise<{ job: JobRow; done: boolean }> {
  const now = ctx.now();
  // Задача в работе (в т.ч. ещё не подхваченная recover) — файлы удалит
  // диспетчер после подтверждённой остановки executor.
  const wasProcessing = getJob(ctx.db, jobId)?.status === 'processing';
  ctx.db.tx(() => {
    const job = getJob(ctx.db, jobId);
    if (!job) return;
    if (!job.purge_requested_at) {
      ctx.db.run(
        'UPDATE jobs SET purge_requested_at = ?, updated_at = ? WHERE id = ?',
        [now, now, jobId],
      );
      addEvent(
        ctx.db,
        jobId,
        'job.purge_requested',
        { status: job.status, actor },
        now,
      );
    }
    revokeTokens(ctx.db, jobId);
    if (job.status === 'queued' || job.status === 'processing') {
      ctx.db.run(
        `UPDATE jobs SET status = 'canceled', error_code = 'CANCELED', error_message = 'canceled: artifacts purged',
           execution_status = 'canceled', finished_at = ?, updated_at = ?,
           cancel_requested_at = COALESCE(cancel_requested_at, ?)
         WHERE id = ? AND status = ?`,
        [now, now, now, jobId, job.status],
      );
    } else if (job.status === 'succeeded') {
      ctx.db.run(
        `UPDATE jobs SET status = 'failed', error_code = 'OUTPUT_PURGED',
           error_message = 'outputs were purged on request', updated_at = ?
         WHERE id = ? AND status = 'succeeded'`,
        [now, jobId],
      );
    }
    ctx.db.run(
      'UPDATE jobs SET payload_enc = NULL WHERE id = ? AND status != ?',
      [jobId, 'processing'],
    );
  });
  ctx.kick();
  if (wasProcessing || ctx.activeJobId() === jobId) {
    return { job: getJob(ctx.db, jobId)!, done: false };
  }
  await deleteJobFiles(ctx, jobId);
  return { job: getJob(ctx.db, jobId)!, done: true };
}

export function jobOutputsDir(ctx: Ctx, jobId: string): string {
  return path.join(ctx.cfg.outputsRoot, jobId);
}

export function jobWorkspaceDir(ctx: Ctx, jobId: string): string {
  return path.join(ctx.cfg.workspaceRoot, jobId);
}

/** Удаление файлов задачи (outputs + workspace) и отметка purged_at. */
export async function deleteJobFiles(ctx: Ctx, jobId: string): Promise<void> {
  await safeRemove(ctx.cfg.outputsRoot, jobOutputsDir(ctx, jobId));
  await safeRemove(ctx.cfg.workspaceRoot, jobWorkspaceDir(ctx, jobId));
  const now = ctx.now();
  ctx.db.tx(() => {
    ctx.db.run(
      'UPDATE artifacts SET purged_at = COALESCE(purged_at, ?) WHERE job_id = ?',
      [now, jobId],
    );
    const r = ctx.db.run(
      'UPDATE jobs SET purged_at = ?, payload_enc = NULL, updated_at = ? WHERE id = ? AND purged_at IS NULL AND purge_requested_at IS NOT NULL',
      [now, now, jobId],
    );
    if (r.changes) addEvent(ctx.db, jobId, 'job.purged', {}, now);
  });
}
