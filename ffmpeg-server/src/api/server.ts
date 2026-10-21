/**
 * HTTP API v1 (ТЗ §5, §5.4) на node:http.
 *
 * Клиентские маршруты (Bearer-ключ клиента; ops видит задачи всех клиентов):
 *   POST   /api/ffmpeg                    → 202 {data:{id,status,error_message}}
 *   GET    /api/jobs/:id                  → 200 {data:{…}} | 404
 *   GET    /api/jobs/by-key/:key          → 200 | 404
 *   POST   /api/jobs/:id/cancel           → 200
 *   DELETE /api/jobs/:id/artifacts        → 202 (останавливается) | 200 (удалено)
 *   GET    /api/capabilities
 * Без авторизации:
 *   GET    /api/health, /api/ready
 *   GET|HEAD /api/files/:jobId/:name?token=…  (bearer-ссылка)
 * Только ops:
 *   POST   /api/control/pause|drain|resume, GET /metrics, /api/ops/*
 *
 * Access log пишется своим логгером: путь без query, by-key без ключа.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { ClientConfig } from '../config';
import type { Ctx } from '../context';
import { ControlConflict, type ControlAction } from '../control/control';
import { sha256Hex } from '../crypto/crypto';
import { type JobRow, getClientJob, getJob } from '../db/jobs';
import { serveFile } from '../files/serve';
import { safeLogPath } from '../metrics/logger';
import { handleOps } from '../ops/ops';
import {
  IDEMPOTENCY_KEY_RE,
  OPERATION_ID_RE,
  cancelJob,
  publicView,
  purgeJob,
  submit,
} from '../queue/service';
import {
  HttpError,
  header,
  notFound,
  readJson,
  sendData,
  sendError,
  sendText,
  unavailable,
} from './http';

export interface ApiDeps {
  activeJobId: () => string | null;
}

export function authenticate(
  ctx: Ctx,
  req: IncomingMessage,
): ClientConfig | null {
  const h = header(req, 'authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S{16,512})$/.exec(h);
  if (!m) return null;
  const hash = sha256Hex(m[1]);
  return ctx.cfg.clients.find((c) => c.keySha256.includes(hash)) ?? null;
}

function requireClient(ctx: Ctx, req: IncomingMessage): ClientConfig {
  const c = authenticate(ctx, req);
  if (!c) {
    throw new HttpError(401, 'UNAUTHORIZED', 'invalid or missing API key', {
      'WWW-Authenticate': 'Bearer',
    });
  }
  return c;
}

function requireOps(ctx: Ctx, req: IncomingMessage): ClientConfig {
  const c = requireClient(ctx, req);
  if (c.role !== 'ops')
    throw new HttpError(403, 'FORBIDDEN', 'ops access required');
  return c;
}

/** Задача в области видимости клиента; ops — любая. Чужая = 404. */
function scopedJob(ctx: Ctx, client: ClientConfig, rawId: string): JobRow {
  const id = rawId.replace(/^selfhosted:/, '');
  const job =
    client.role === 'ops'
      ? getJob(ctx.db, id)
      : getClientJob(ctx.db, client.clientId, id);
  if (!job) throw notFound(ctx, 'job not found');
  return job;
}

const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function actorOf(req: IncomingMessage, client: ClientConfig): string {
  const a = header(req, 'x-actor-id');
  return a && /^[\x20-\x7e]{1,128}$/.test(a)
    ? `${client.clientId}:${a}`
    : client.clientId;
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'bad path encoding');
  }
}

export function createRequestHandler(ctx: Ctx, deps: ApiDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = process.hrtime.bigint();
    const receivedAt = ctx.now();
    // Отличать ответ самого сервера от 404/502 прокси (FF-INT-01).
    res.setHeader('X-FFmpeg-Server', '1');
    let clientId: string | null = null;
    const corrRaw = header(req, 'x-correlation-id');
    const correlation =
      corrRaw && CORRELATION_RE.test(corrRaw) ? corrRaw : null;
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      ctx.log.info('http', {
        method: req.method,
        path: safeLogPath(req.url ?? '/'),
        status: res.statusCode,
        ms: Math.round(ms),
        client_id: clientId,
        correlation_id: correlation,
      });
      ctx.metrics.inc('ffmpeg_http_requests_total', 'HTTP requests', {
        method: req.method ?? '',
        status: String(res.statusCode),
      });
    });
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (url.pathname === '/api/health' && method === 'GET') {
        return sendData(res, 200, { status: 'ok' });
      }
      if (url.pathname === '/api/ready' && method === 'GET') {
        const r = await ctx.readiness.check(ctx.now());
        return sendData(res, r.ready ? 200 : 503, {
          ready: r.ready,
          checks: r.checks,
          reasons: r.reasons,
          mode: ctx.control.get().mode,
        });
      }
      if (parts[0] === 'api' && parts[1] === 'files') {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed', {
            Allow: 'GET, HEAD',
          });
        }
        if (parts.length !== 4)
          throw new HttpError(404, 'NOT_FOUND', 'not found');
        return await serveFile(
          ctx,
          req,
          res,
          decodeSeg(parts[2]),
          decodeSeg(parts[3]),
          url.searchParams.get('token'),
        );
      }
      if (url.pathname === '/metrics' && method === 'GET') {
        const c = requireOps(ctx, req);
        clientId = c.clientId;
        return sendText(
          res,
          200,
          ctx.metrics.render(),
          'text/plain; version=0.0.4; charset=utf-8',
        );
      }
      if (parts[0] !== 'api')
        throw new HttpError(404, 'NOT_FOUND', 'not found');

      const client = requireClient(ctx, req);
      clientId = client.clientId;

      // POST /api/ffmpeg
      if (parts[1] === 'ffmpeg' && parts.length === 2) {
        if (method !== 'POST')
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed', {
            Allow: 'POST',
          });
        return await handleSubmit(ctx, req, res, client, receivedAt);
      }
      if (
        parts[1] === 'capabilities' &&
        parts.length === 2 &&
        method === 'GET'
      ) {
        return sendData(res, 200, await capabilities(ctx));
      }
      if (parts[1] === 'jobs') {
        if (parts[2] === 'by-key' && parts.length === 4 && method === 'GET') {
          const key = decodeSeg(parts[3]);
          if (!IDEMPOTENCY_KEY_RE.test(key))
            throw new HttpError(400, 'INVALID_REQUEST', 'bad key');
          const row = ctx.db.get<{ job_id: string }>(
            'SELECT job_id FROM idempotency_keys WHERE client_id = ? AND key_hash = ?',
            [client.clientId, sha256Hex(key)],
          );
          const job = row ? getJob(ctx.db, row.job_id) : undefined;
          if (!job) throw notFound(ctx, 'no job for this key');
          return sendData(res, 200, publicView(ctx, job));
        }
        if (parts.length === 3 && method === 'GET') {
          const job = scopedJob(ctx, client, decodeSeg(parts[2]));
          return sendData(res, 200, publicView(ctx, job));
        }
        if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') {
          const job = scopedJob(ctx, client, decodeSeg(parts[2]));
          const after = cancelJob(ctx, job.id, actorOf(req, client));
          return sendData(
            res,
            200,
            publicView(ctx, after, { issueLinks: false }),
          );
        }
        if (
          parts.length === 4 &&
          parts[3] === 'artifacts' &&
          method === 'DELETE'
        ) {
          const job = scopedJob(ctx, client, decodeSeg(parts[2]));
          const r = await purgeJob(ctx, job.id, actorOf(req, client));
          return sendData(res, r.done ? 200 : 202, {
            id: job.id,
            status: r.job.status,
            error_code: r.job.error_code,
            execution_status: r.job.execution_status,
            purged: r.done,
          });
        }
        throw new HttpError(404, 'NOT_FOUND', 'not found');
      }
      if (parts[1] === 'control' && parts.length === 3) {
        if (client.role !== 'ops')
          throw new HttpError(403, 'FORBIDDEN', 'ops access required');
        if (method !== 'POST')
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed', {
            Allow: 'POST',
          });
        const action = parts[2] as ControlAction;
        if (!['pause', 'drain', 'resume'].includes(action))
          throw new HttpError(404, 'NOT_FOUND', 'not found');
        return await handleControl(ctx, req, res, action, actorOf(req, client));
      }
      if (parts[1] === 'ops') {
        if (client.role !== 'ops')
          throw new HttpError(403, 'FORBIDDEN', 'ops access required');
        return await handleOps(
          ctx,
          { dispatcherActive: deps.activeJobId },
          req,
          res,
          parts.slice(2).map(decodeSeg),
          url,
          actorOf(req, client),
        );
      }
      throw new HttpError(404, 'NOT_FOUND', 'not found');
    } catch (e) {
      if (e instanceof HttpError) {
        return sendError(res, e.status, e.code, e.message, e.headers);
      }
      ctx.log.error('http.unhandled', { error: (e as Error)?.name ?? 'Error' });
      // Сбой хранилища — временная недоступность (503), а не «не найдено».
      const code = String((e as { code?: unknown })?.code ?? '');
      if (code.startsWith('ERR_SQLITE') || !ctx.db.ping()) {
        const u = unavailable();
        return sendError(res, u.status, u.code, u.message, u.headers);
      }
      return sendError(res, 500, 'INTERNAL', 'internal error');
    }
  };
}

async function handleSubmit(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  client: ClientConfig,
  receivedAt: number,
): Promise<void> {
  // Порядок (ТЗ §5.2): auth (выше) → размер → ключ → fingerprint → прежний
  // job; квоты/readiness — только для новой задачи (внутри submit).
  const body = await readJson(req, ctx.cfg.maxBodyBytes);
  const key = header(req, 'idempotency-key');
  if (!key || !IDEMPOTENCY_KEY_RE.test(key)) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'Idempotency-Key header (1–128 printable ASCII) is required',
    );
  }
  const op = header(req, 'x-client-operation-id');
  if (op !== null && !OPERATION_ID_RE.test(op)) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'X-Client-Operation-Id must be ≤128 ASCII',
    );
  }
  const out = await submit(ctx, {
    clientId: client.clientId,
    key,
    body,
    operationId: op,
    receivedAt,
  });
  if (out.kind === 'error') {
    ctx.metrics.inc('ffmpeg_submit_rejected_total', 'Rejected submits', {
      code: out.code,
    });
    return sendError(
      res,
      out.http,
      out.code,
      out.message,
      out.retryAfterSec ? { 'Retry-After': String(out.retryAfterSec) } : {},
    );
  }
  const j = out.job;
  return sendData(
    res,
    202,
    {
      id: j.id,
      status: j.status,
      error_message: j.error_message ?? '',
      error_code: j.error_code,
      created_at: new Date(j.created_at).toISOString(),
    },
    out.kind === 'replay' ? { 'Idempotent-Replayed': 'true' } : {},
  );
}

async function handleControl(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  action: ControlAction,
  actor: string,
): Promise<void> {
  const body = (await readJson(req, 4096, { allowEmpty: true })) as Record<
    string,
    unknown
  >;
  const expected = body?.expected_revision;
  if (expected !== undefined && typeof expected !== 'number') {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'expected_revision must be a number',
    );
  }
  if (action === 'resume') {
    // Resume невозможен при непройденной readiness (ТЗ §13.1).
    ctx.readiness.invalidate();
    const r = await ctx.readiness.check(ctx.now());
    if (!r.ready) {
      return sendJson409(res, 'NOT_READY', 'readiness checks failed', {
        reasons: r.reasons,
      });
    }
  }
  try {
    const { state } = ctx.control.apply(action, {
      expectedRevision: expected as number | undefined,
      reason: typeof body?.reason === 'string' ? body.reason : undefined,
      reconciled: body?.reconciled === true,
      actor,
    });
    ctx.kick();
    return sendData(res, 200, {
      mode: state.mode,
      revision: state.revision,
      reason: state.reason,
      updated_at: new Date(state.updatedAt).toISOString(),
    });
  } catch (e) {
    if (e instanceof ControlConflict) {
      return sendJson409(res, e.reason.toUpperCase(), e.reason, {
        mode: e.state.mode,
        revision: e.state.revision,
      });
    }
    throw e;
  }
}

function sendJson409(
  res: ServerResponse,
  code: string,
  message: string,
  data: Record<string, unknown>,
): void {
  const text = JSON.stringify({ error: { code, message }, data });
  res.writeHead(409, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

async function capabilities(ctx: Ctx): Promise<Record<string, unknown>> {
  const caps = await ctx.ports.executor.capabilities().catch(() => null);
  const limits = ctx.limits.current();
  return {
    api_version: 1,
    ffmpeg_version: caps?.ffmpegVersion ?? null,
    ffprobe_version: caps?.ffprobeVersion ?? null,
    build_configuration: caps?.buildConfiguration ?? null,
    encoders: caps?.encoders ?? [],
    filters: caps?.filters ?? [],
    muxers: caps?.muxers ?? [],
    capabilities_ok: caps?.ok ?? false,
    checked_at: caps ? new Date(caps.checkedAt).toISOString() : null,
    image_digest: ctx.cfg.imageDigest,
    limits,
    queue: ctx.cfg.queue,
    output_ttl_sec: ctx.cfg.retention.outputTtlSec,
    download_link_ttl_sec: ctx.cfg.retention.downloadTokenTtlSec,
  };
}

export function createHttpServer(ctx: Ctx, deps: ApiDeps): Server {
  const handler = createRequestHandler(ctx, deps);
  const server = createServer(
    { requestTimeout: 60_000, headersTimeout: 15_000 },
    (req, res) => {
      void handler(req, res);
    },
  );
  server.keepAliveTimeout = 5_000;
  return server;
}
