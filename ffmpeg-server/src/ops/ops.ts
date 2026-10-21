/**
 * Ops-API для backend-прокси админки (бриф Р-FF-5, ТЗ §13.1). Только роль
 * ops. Никаких URL входов, команд, токенов; stderr — очищенный ≤64 KiB.
 *
 *   GET  /api/ops/overview
 *   GET  /api/ops/jobs?cursor=&limit=25&state=&period=&from=&to=&client_operation_id=&job_id=&client_id=
 *   GET  /api/ops/jobs/:id
 *   GET  /api/ops/limits
 *   POST /api/ops/limits                {expected_revision, limits:{…}, reason?}
 *   POST /api/ops/jobs/:id/download-link {file}
 *   POST /api/ops/jobs/:id/cancel
 *   POST /api/ops/jobs/:id/purge        (= DELETE /api/jobs/:id/artifacts)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context';
import { LimitsConflict } from '../control/limits';
import type { ArtifactRow, AttemptRow, JobRow } from '../db/jobs';
import { getJob } from '../db/jobs';
import { HttpError, notFound, readJson, sendData } from '../api/http';
import { fileUrl, issueToken } from '../files/tokens';
import { cancelJob, publicView, purgeJob } from '../queue/service';

const PAGE = 25;
const PERIODS: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};
const STATES = ['queued', 'processing', 'succeeded', 'failed', 'canceled'];

const iso = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString() : null;

export interface OpsDeps {
  dispatcherActive: () => string | null;
}

export async function handleOps(
  ctx: Ctx,
  deps: OpsDeps,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  actor: string,
): Promise<void> {
  const m = req.method ?? 'GET';
  const [a, b, c] = parts;
  if (m === 'GET' && a === 'overview' && !b)
    return sendData(res, 200, await overview(ctx, deps));
  if (m === 'GET' && a === 'jobs' && !b)
    return sendData(res, 200, listJobs(ctx, url));
  if (m === 'GET' && a === 'jobs' && b && !c)
    return sendData(res, 200, jobCard(ctx, b));
  if (m === 'GET' && a === 'limits' && !b)
    return sendData(res, 200, limitsView(ctx));
  if (m === 'POST' && a === 'limits' && !b) {
    const body = (await readJson(req, 64 * 1024)) as Record<string, unknown>;
    const exp = body?.expected_revision;
    if (
      typeof exp !== 'number' ||
      !body.limits ||
      typeof body.limits !== 'object'
    ) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'expected_revision and limits are required',
      );
    }
    try {
      ctx.limits.update(
        exp,
        body.limits as Record<string, unknown>,
        actor,
        typeof body.reason === 'string' ? body.reason : null,
      );
    } catch (e) {
      if (e instanceof LimitsConflict) {
        throw new HttpError(
          e.reason === 'stale_revision' ? 409 : 400,
          e.reason === 'stale_revision' ? 'STALE_REVISION' : 'INVALID_REQUEST',
          e.message,
        );
      }
      throw e;
    }
    return sendData(res, 200, limitsView(ctx));
  }
  if (m === 'POST' && a === 'jobs' && b && c === 'download-link') {
    const body = (await readJson(req, 4096)) as Record<string, unknown>;
    const file = body?.file;
    if (typeof file !== 'string')
      throw new HttpError(400, 'INVALID_REQUEST', 'file is required');
    const job = getJob(ctx.db, b);
    if (!job) throw notFound(ctx, 'job not found');
    const art = ctx.db.get<ArtifactRow>(
      'SELECT * FROM artifacts WHERE job_id = ? AND name = ?',
      [b, file],
    );
    if (!art) throw new HttpError(404, 'NOT_FOUND', 'file not found');
    if (art.purged_at || job.status !== 'succeeded' || job.purge_requested_at) {
      throw new HttpError(410, 'GONE', 'outputs are no longer available');
    }
    const { token, expiresAt } = issueToken(
      ctx.db,
      b,
      file,
      ctx.cfg.retention.downloadTokenTtlSec,
      ctx.now(),
    );
    return sendData(res, 200, {
      url: fileUrl(ctx.cfg.publicBaseUrl, b, file, token),
      expires_at: iso(expiresAt),
      mime: art.mime,
      bytes: art.bytes,
    });
  }
  if (m === 'POST' && a === 'jobs' && b && c === 'cancel') {
    if (!getJob(ctx.db, b)) throw notFound(ctx, 'job not found');
    const job = cancelJob(ctx, b, actor);
    return sendData(res, 200, publicView(ctx, job, { issueLinks: false }));
  }
  if (m === 'POST' && a === 'jobs' && b && c === 'purge') {
    if (!getJob(ctx.db, b)) throw notFound(ctx, 'job not found');
    const r = await purgeJob(ctx, b, actor);
    return sendData(res, r.done ? 200 : 202, {
      id: b,
      status: r.job.status,
      purged: r.done,
    });
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found');
}

async function overview(
  ctx: Ctx,
  deps: OpsDeps,
): Promise<Record<string, unknown>> {
  const now = ctx.now();
  const counts = Object.fromEntries(
    ctx.db
      .all<{ status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status',
      )
      .map((r) => [r.status, r.n]),
  );
  const failed24h = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND finished_at >= ?",
    [now - 86_400_000],
  )!.n;
  // Ошибки за 24 ч по коду (вкл. OOM) — для правил внимания backend.
  const errors24h = Object.fromEntries(
    ctx.db
      .all<{ code: string; n: number }>(
        `SELECT error_code AS code, COUNT(*) AS n FROM jobs
         WHERE error_code IS NOT NULL AND finished_at >= ?
         GROUP BY error_code ORDER BY error_code`,
        [now - 86_400_000],
      )
      .map((r) => [r.code, r.n]),
  ) as Record<string, number>;
  const oldest = ctx.db.get<{ created_at: number }>(
    "SELECT created_at FROM jobs WHERE status = 'queued' ORDER BY seq LIMIT 1",
  );
  const activeId = deps.dispatcherActive();
  const active = activeId ? getJob(ctx.db, activeId) : undefined;
  const ready = await ctx.readiness.check(now);
  const ex = await ctx.ports.executor
    .executorStatus(ctx.cfg.executor.heartbeatStaleSec * 1000)
    .catch(() => null);
  const caps = await ctx.ports.executor.capabilities().catch(() => null);
  const resources = await executorResources(
    ctx,
    ex?.heartbeat.busyAttemptId ?? active?.current_attempt_id ?? null,
  );
  const disk = ctx.disk.snapshot;
  const control = ctx.control.get();
  const limits = ctx.limits.current();
  return {
    generated_at: iso(now),
    control: {
      mode: control.mode,
      revision: control.revision,
      reason: control.reason,
      updated_at: iso(control.updatedAt),
    },
    ready: {
      ready: ready.ready,
      checks: ready.checks,
      reasons: ready.reasons,
      checked_at: iso(ready.checkedAt),
    },
    queue: {
      counts,
      failed_24h: failed24h,
      errors_24h: errors24h,
      oom_24h: errors24h.OOM ?? 0,
      oldest_queued_age_sec: oldest
        ? Math.round((now - oldest.created_at) / 1000)
        : null,
      max_queued: ctx.cfg.queue.maxQueuedTotal,
      max_queued_per_client: ctx.cfg.queue.maxQueuedPerClient,
    },
    active: active
      ? {
          id: active.id,
          client_id: active.client_id,
          client_operation_id: active.client_operation_id,
          stage: active.stage,
          progress: active.progress,
          claimed_at: iso(active.claimed_at),
          attempt: active.attempt_count,
        }
      : null,
    executor: ex
      ? {
          heartbeat_at: iso(ex.heartbeat.heartbeatAt),
          fresh: ex.fresh,
          busy: !!ex.heartbeat.busyAttemptId,
          ffmpeg_version: ex.heartbeat.ffmpegVersion,
          started_at: iso(ex.heartbeat.startedAt),
          resources,
        }
      : null,
    capabilities: caps
      ? {
          ok: caps.ok,
          missing: caps.missing,
          checked_at: iso(caps.checkedAt),
          ffmpeg_version: caps.ffmpegVersion,
        }
      : null,
    disk: {
      measured_at: iso(disk.at),
      free_bytes: disk.freeBytes,
      min_free_bytes: ctx.cfg.disk.minFreeBytes,
      workspaces_bytes: disk.workspacesBytes,
      max_workspaces_bytes: ctx.cfg.disk.maxWorkspacesBytes,
      outputs_bytes: disk.outputsBytes,
      max_outputs_bytes: ctx.cfg.disk.maxOutputsBytes,
    },
    limits_revision: limits.revision,
    image_digest: ctx.cfg.imageDigest,
  };
}

/** Предыдущий замер CPU попытки — для доли CPU между двумя overview. */
const lastCpu = new Map<string, { cpuMs: number; at: number }>();

interface StateResources {
  cpuMs?: number | null;
  rssKb?: number | null;
  peakRssKb?: number | null;
  sampledAt?: number | null;
}

/**
 * Текущие CPU/RAM executor — из state.json активной попытки (executor
 * пишет cpuMs/rssKb/peakRssKb/sampledAt сверх контракта). В простое —
 * null с явным `idle`. Значение со временем замера: устаревшее видно.
 */
async function executorResources(
  ctx: Ctx,
  attemptId: string | null,
): Promise<Record<string, unknown>> {
  if (!attemptId) return { idle: true, sampled_at: null };
  const p = await ctx.ports.executor.poll(attemptId).catch(() => null);
  if (!p || p.kind !== 'running') return { idle: true, sampled_at: null };
  const st = p.state as typeof p.state & StateResources;
  const at = st.sampledAt ?? null;
  const cpuMs = st.cpuMs ?? null;
  let cpuPercent: number | null = null;
  const prev = lastCpu.get(attemptId);
  if (cpuMs !== null && at !== null) {
    if (prev && at > prev.at) {
      cpuPercent =
        Math.round(((cpuMs - prev.cpuMs) / (at - prev.at)) * 1000) / 10;
    }
    lastCpu.set(attemptId, { cpuMs, at });
    if (lastCpu.size > 16)
      lastCpu.delete(lastCpu.keys().next().value as string);
  }
  const staleMs = ctx.cfg.executor.heartbeatStaleSec * 1000;
  return {
    idle: false,
    cpu_ms: cpuMs,
    /** % одного ядра между двумя последними замерами (лимит — 2 CPU = 200%). */
    cpu_percent: cpuPercent,
    rss_kb: st.rssKb ?? null,
    peak_rss_kb: st.peakRssKb ?? null,
    step_index: st.stepIndex,
    sampled_at: iso(at),
    stale: at === null || ctx.now() - at > staleMs,
  };
}

function listJobs(ctx: Ctx, url: URL): Record<string, unknown> {
  const q = url.searchParams;
  const where: string[] = [];
  const params: Array<string | number> = [];
  const limit = Math.min(
    PAGE,
    Math.max(1, Number(q.get('limit') ?? PAGE) || PAGE),
  );
  const cursor = q.get('cursor');
  if (cursor) {
    if (!/^\d{1,15}$/.test(cursor))
      throw new HttpError(400, 'INVALID_REQUEST', 'bad cursor');
    where.push('seq < ?');
    params.push(Number(cursor));
  }
  const state = q.get('state');
  if (state) {
    const states = state.split(',').filter((s) => STATES.includes(s));
    if (!states.length)
      throw new HttpError(400, 'INVALID_REQUEST', 'bad state');
    where.push(`status IN (${states.map(() => '?').join(',')})`);
    params.push(...states);
  }
  const jobId = q.get('job_id');
  if (jobId) {
    where.push('id = ?');
    params.push(jobId.replace(/^selfhosted:/, ''));
  }
  const op = q.get('client_operation_id');
  if (op) {
    where.push('client_operation_id = ?');
    params.push(op);
  }
  const client = q.get('client_id');
  if (client) {
    where.push('client_id = ?');
    params.push(client);
  }
  const errorCode = q.get('error_code');
  if (errorCode) {
    where.push('error_code = ?');
    params.push(errorCode);
  }
  // Период: по умолчанию последние 24 часа (ТЗ §13.1), кроме поиска по id.
  const from = q.get('from');
  const to = q.get('to');
  const period = q.get('period') ?? (jobId || op ? null : '24h');
  if (from || to) {
    const f = from ? Date.parse(from) : 0;
    const t = to ? Date.parse(to) : Number.MAX_SAFE_INTEGER;
    if (Number.isNaN(f) || Number.isNaN(t))
      throw new HttpError(400, 'INVALID_REQUEST', 'bad from/to');
    where.push('created_at >= ? AND created_at < ?');
    params.push(f, t);
  } else if (period && period !== 'all') {
    const ms = PERIODS[period];
    if (!ms) throw new HttpError(400, 'INVALID_REQUEST', 'bad period');
    where.push('created_at >= ?');
    params.push(ctx.now() - ms);
  }
  const rows = ctx.db.all<JobRow>(
    `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY seq DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((j) => ({
      id: j.id,
      client_id: j.client_id,
      client_operation_id: j.client_operation_id,
      status: j.status,
      stage: j.stage,
      error_code: j.error_code,
      execution_status: j.execution_status,
      attempts: j.attempt_count,
      input_bytes: j.input_bytes,
      output_bytes: j.output_bytes,
      queue_delay_sec: j.claimed_at
        ? Math.round((j.claimed_at - j.created_at) / 1000)
        : null,
      run_sec:
        j.claimed_at && j.finished_at
          ? Math.round((j.finished_at - j.claimed_at) / 1000)
          : null,
      created_at: iso(j.created_at),
      finished_at: iso(j.finished_at),
      expires_at: iso(j.expires_at),
      purged_at: iso(j.purged_at),
    })),
    next_cursor: rows.length > limit ? String(page[page.length - 1].seq) : null,
    page_size: limit,
    generated_at: iso(ctx.now()),
  };
}

function jobCard(ctx: Ctx, rawId: string): Record<string, unknown> {
  const id = rawId.replace(/^selfhosted:/, '');
  const j = getJob(ctx.db, id);
  if (!j) throw notFound(ctx, 'job not found');
  const attempts = ctx.db.all<AttemptRow>(
    'SELECT * FROM attempts WHERE job_id = ? ORDER BY n',
    [id],
  );
  const events = ctx.db.all<{ at: number; type: string; data: string | null }>(
    'SELECT at, type, data FROM events WHERE job_id = ? ORDER BY id LIMIT 500',
    [id],
  );
  const artifacts = ctx.db.all<ArtifactRow>(
    'SELECT * FROM artifacts WHERE job_id = ? ORDER BY rowid',
    [id],
  );
  const view = publicView(ctx, j, { issueLinks: false });
  delete view.output_files;
  return {
    ...view,
    client_id: j.client_id,
    input_names: JSON.parse(j.input_names) as string[],
    output_names: JSON.parse(j.output_names) as string[],
    inputs_metadata: j.inputs_metadata ? JSON.parse(j.inputs_metadata) : null,
    outputs_metadata: j.outputs_metadata
      ? JSON.parse(j.outputs_metadata)
      : null,
    executed_but_files_gone:
      j.execution_status === 'succeeded' &&
      (j.error_code === 'OUTPUT_EXPIRED' || j.error_code === 'OUTPUT_PURGED'),
    resources: {
      wall_ms: j.wall_ms,
      cpu_ms: j.cpu_ms,
      peak_rss_kb: j.peak_rss_kb,
      input_bytes: j.input_bytes,
      output_bytes: j.output_bytes,
      exit_code: j.exit_code,
    },
    limits_revision: j.limits_revision,
    attempts: attempts.map((a) => ({
      n: a.n,
      status: a.status,
      outcome: a.outcome,
      error_code: a.error_code,
      started_at: iso(a.started_at),
      finished_at: iso(a.finished_at),
      exit_code: a.exit_code,
      signal: a.signal,
      wall_ms: a.wall_ms,
      cpu_ms: a.cpu_ms,
      peak_rss_kb: a.peak_rss_kb,
    })),
    artifacts: artifacts.map((a) => ({
      name: a.name,
      bytes: a.bytes,
      sha256: a.sha256,
      mime: a.mime,
      purged_at: iso(a.purged_at),
    })),
    timeline: events.map((e) => ({
      at: iso(e.at),
      type: e.type,
      data: e.data ? (JSON.parse(e.data) as unknown) : null,
    })),
    stderr_tail: j.stderr_tail ?? '',
    cancel_requested_at: iso(j.cancel_requested_at),
    purge_requested_at: iso(j.purge_requested_at),
    purged_at: iso(j.purged_at),
  };
}

function limitsView(ctx: Ctx): Record<string, unknown> {
  const cur = ctx.limits.current();
  const { revision, ...effective } = cur;
  return {
    revision,
    effective,
    ceiling: ctx.limits.ceiling,
    queue: ctx.cfg.queue,
    disk: ctx.cfg.disk,
    concurrency: 1,
    history: ctx.limits.history(50).map((h) => ({
      revision: h.revision,
      changed_at: iso(h.changedAt),
      actor: h.actor,
      reason: h.reason,
      profile: h.profile,
    })),
    control_history: ctx.db
      .all<{ at: number; type: string; data: string | null }>(
        "SELECT at, type, data FROM events WHERE job_id IS NULL AND type LIKE 'control.%' ORDER BY id DESC LIMIT 50",
      )
      .map((e) => ({
        at: iso(e.at),
        type: e.type,
        data: e.data ? JSON.parse(e.data) : null,
      })),
  };
}
