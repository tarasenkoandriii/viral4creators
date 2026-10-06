/**
 * Фейковый sites-backend для e2e воркера: очередь в памяти и тот же
 * внутренний API (`/internal/worker/v1/jobs/*`), подпись проверяется ТЕМ
 * ЖЕ кодом, что на сервере (`shared/sites-internal-signature.ts`), с окном
 * времени и журналом id. Результат разбирается тем же `parseJobResult`.
 * Учётку отдаёт конвертом под открытый ключ воркера — один раз на попытку.
 * Настоящий sites-backend с Postgres — sites-backend/src/acceptance/sh3/.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import {
  WORKER_CALLER,
  WORKER_ROUTES,
  parseJobParams,
  parseJobResult,
  type BrowserJobKind,
  type ClaimedJob,
} from '../../src/shared/browser-job-protocol';
import { verifySitesRequest } from '../../src/shared/sites-internal-signature';
import { sealAad, sealForWorker } from '../../src/shared/worker-seal';

export interface FakeJob {
  id: string;
  kind: BrowserJobKind;
  params: unknown;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempt: number;
  leaseToken: string | null;
  result: unknown;
  error: string | null;
  artifacts: Map<number, Buffer>;
  credentialsIssued: number;
  cancel: boolean;
  needsCredentials: boolean;
  wallMs: number;
}

export class FakeSites {
  private server: Server | null = null;
  port = 0;
  readonly jobs: FakeJob[] = [];
  readonly calls: string[] = [];
  readonly seen = new Set<string>();
  /** Запросы не-POST (страница пытается достучаться по loopback). */
  gets = 0;
  credentials: {
    username: string;
    password: string;
    sessionCookies: string | null;
  } | null = null;
  sealPublicKey: string | null = null;

  constructor(readonly secret: string) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  add(
    kind: BrowserJobKind,
    params: unknown,
    extra: Partial<FakeJob> = {},
  ): FakeJob {
    parseJobParams(kind, params);
    const j: FakeJob = {
      id: `job${this.jobs.length + 1}${randomBytes(4).toString('hex')}`,
      kind,
      params,
      status: 'queued',
      attempt: 0,
      leaseToken: null,
      result: null,
      error: null,
      artifacts: new Map(),
      credentialsIssued: 0,
      cancel: false,
      needsCredentials: kind === 'admin-crawl',
      wallMs: 90_000,
      ...extra,
    };
    this.jobs.push(j);
    return j;
  }

  async waitDone(j: FakeJob, ms = 90_000): Promise<FakeJob> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (j.status === 'done' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`задание ${j.id} не завершилось: ${j.status}`);
  }

  private leased(b: { jobId?: string; leaseToken?: string }): FakeJob | null {
    const j = this.jobs.find((x) => x.id === b.jobId);
    return j && j.status === 'running' && j.leaseToken === b.leaseToken
      ? j
      : null;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        if (req.method !== 'POST') {
          this.gets += 1;
          res.writeHead(404);
          res.end();
          return;
        }
        const path = (req.url ?? '').split('?')[0];
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify(
              status === 200
                ? { success: true, data }
                : {
                    success: false,
                    error: { code: data, message: String(data) },
                  },
            ),
          );
        };
        const check = verifySitesRequest(this.secret, {
          method: req.method ?? 'POST',
          path,
          body: raw,
          headers: req.headers,
          nowSeconds: Math.floor(Date.now() / 1000),
          expectedCaller: WORKER_CALLER,
        });
        if (!check.ok)
          return send(401, `INTERNAL_SIGNATURE_${check.reason.toUpperCase()}`);
        if (this.seen.has(check.requestId)) return send(401, 'INTERNAL_REPLAY');
        this.seen.add(check.requestId);
        this.calls.push(path);
        const b = JSON.parse(raw || '{}') as Record<string, unknown>;
        if (path === WORKER_ROUTES.claim) {
          const max = Number(b.max);
          const kinds = b.kinds as string[];
          const out: ClaimedJob[] = [];
          for (const j of this.jobs) {
            if (out.length >= max) break;
            if (j.status !== 'queued' || !kinds.includes(j.kind)) continue;
            j.status = 'running';
            j.attempt += 1;
            j.leaseToken = randomBytes(32).toString('base64url');
            out.push({
              id: j.id,
              kind: j.kind,
              attempt: j.attempt,
              leaseToken: j.leaseToken,
              leaseUntil: new Date(Date.now() + 60_000).toISOString(),
              wallMs: j.wallMs,
              params: parseJobParams(j.kind, j.params),
              needsCredentials: j.needsCredentials,
            });
          }
          return send(200, { enabled: true, jobs: out });
        }
        const j = this.leased(b as { jobId?: string; leaseToken?: string });
        if (!j) return send(409, 'WORKER_LEASE_LOST');
        if (path === WORKER_ROUTES.heartbeat)
          return send(200, { ok: true, cancel: j.cancel });
        if (path === WORKER_ROUTES.artifact) {
          j.artifacts.set(Number(b.idx), Buffer.from(String(b.data), 'base64'));
          return send(200, { ok: true });
        }
        if (path === WORKER_ROUTES.credentials) {
          if (!this.credentials || !this.sealPublicKey)
            return send(403, 'WORKER_CREDENTIALS_DENIED');
          if (j.credentialsIssued >= j.attempt)
            return send(409, 'WORKER_CREDENTIALS_USED');
          j.credentialsIssued = j.attempt;
          const plain = Buffer.from(
            JSON.stringify({ ...this.credentials, loginFields: null }),
          );
          return send(200, {
            sealed: sealForWorker(
              this.sealPublicKey,
              plain,
              sealAad(j.id, j.attempt),
            ),
            attempt: j.attempt,
          });
        }
        if (path === WORKER_ROUTES.complete) {
          try {
            j.result = parseJobResult(
              j.kind,
              parseJobParams(j.kind, j.params),
              b.result,
            );
          } catch (e) {
            return send(400, `WORKER_BAD_RESULT ${(e as Error).message}`);
          }
          j.status = 'done';
          j.leaseToken = null;
          return send(200, { ok: true });
        }
        if (path === WORKER_ROUTES.fail) {
          j.status = 'failed';
          j.error = String(b.code);
          j.leaseToken = null;
          return send(200, { ok: true, retry: false });
        }
        return send(404, 'NOT_FOUND');
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }
}
