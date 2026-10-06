/**
 * Цикл воркера (Э-С Ш3): pull-модель — воркер сам забирает задания из
 * sites-backend (`claim`), входящих портов у него нет.
 *
 *  - конкурентность — не больше `concurrency` заданий одновременно;
 *    пустая очередь — опрос реже (до `idlePollMaxMs`);
 *  - на задание: новый контекст и свой прокси (`browser/context.ts`),
 *    heartbeat каждые 15 с (продление аренды; ответ «отменить» — отмена;
 *    409 «аренда потеряна» — тихий обрыв без `fail`), стена времени
 *    `wallMs` → `job_timeout`;
 *  - итог: `complete` (результат проверен тем же разбором, что на
 *    сервере) | `fail` с кодом из закрытого списка (повтор решает сервер);
 *  - остановка (SIGTERM): новых заданий нет; идущие получают
 *    `shutdownGraceMs` на завершение, потом обрываются с `shutdown`
 *    (повторяемый код — задание уйдёт другому воркеру).
 */
import type { Browser } from 'playwright-core';
import { ApiError, type WorkerApi } from './api-client';
import type { BrowserPool } from './browser/pool';
import { JobBrowser, type EgressOptions } from './browser/context';
import { JobError } from './errors';
import { EXECUTORS } from './jobs';
import type { JobContext, JobCredentials, JobExecutor } from './jobs/types';
import type { Logger } from './logger';
import { SecretBox } from './secret-box';
import {
  WORKER_LIMITS,
  parseJobResult,
  type BrowserJobKind,
  type ClaimedJob,
  type WorkerErrorCode,
} from './shared/browser-job-protocol';
import { openSealed, sealAad } from './shared/worker-seal';

export interface RunnerOptions {
  api: WorkerApi;
  pool: Pick<BrowserPool, 'acquire' | 'release'>;
  logger: Logger;
  kinds: BrowserJobKind[];
  concurrency: number;
  pollMs: number;
  idlePollMaxMs: number;
  shutdownGraceMs: number;
  egress: EgressOptions;
  sealPrivateKey: string | null;
  heartbeatMs?: number;
  executors?: Partial<Record<BrowserJobKind, JobExecutor>>;
  /** Тесты: открыть контекст без настоящего браузера. */
  openJobBrowser?: (b: Browser, job: ClaimedJob) => Promise<JobBrowser>;
}

interface Running {
  job: ClaimedJob;
  abort: AbortController;
  reason: WorkerErrorCode | 'lease_lost' | null;
  done: Promise<void>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export class Runner {
  private readonly running = new Map<string, Running>();
  private stopping = false;
  private readonly stop = new AbortController();
  private loopDone: Promise<void> | null = null;
  lastClaimAt = 0;
  lastError: string | null = null;
  completed = 0;
  failed = 0;

  constructor(private readonly o: RunnerOptions) {}

  get active(): number {
    return this.running.size;
  }

  start(): void {
    this.loopDone ??= this.loop();
  }

  private async loop(): Promise<void> {
    let idle = this.o.pollMs;
    while (!this.stopping) {
      const free = this.o.concurrency - this.running.size;
      if (free > 0) {
        try {
          const res = await this.o.api.claim(
            this.o.kinds,
            Math.min(free, WORKER_LIMITS.claimMax),
          );
          this.lastClaimAt = Date.now();
          this.lastError = null;
          for (const job of res.jobs) this.launch(job);
          idle = res.jobs.length
            ? this.o.pollMs
            : Math.min(idle * 2, this.o.idlePollMaxMs);
        } catch (e) {
          this.lastError = e instanceof ApiError ? e.code : 'network';
          this.o.logger.warn('claim не удался', { code: this.lastError });
          idle = Math.min(idle * 2, this.o.idlePollMaxMs);
        }
      }
      await sleep(free > 0 ? idle : this.o.pollMs, this.stop.signal);
    }
  }

  private launch(job: ClaimedJob): void {
    const abort = new AbortController();
    const r: Running = { job, abort, reason: null, done: Promise.resolve() };
    this.running.set(job.id, r);
    r.done = this.execute(r).finally(() => this.running.delete(job.id));
  }

  private cancel(r: Running, reason: Running['reason']): void {
    if (r.abort.signal.aborted) return;
    r.reason = reason;
    r.abort.abort();
  }

  private credentialsFor(job: ClaimedJob): () => Promise<JobCredentials> {
    return async () => {
      if (!job.needsCredentials || !this.o.sealPrivateKey) {
        throw new JobError('credentials_unavailable');
      }
      let sealed: { sealed: string; attempt: number };
      try {
        sealed = await this.o.api.credentials(job.id, job.leaseToken);
      } catch {
        throw new JobError('credentials_unavailable');
      }
      let plain: Buffer;
      try {
        plain = openSealed(
          this.o.sealPrivateKey,
          sealed.sealed,
          sealAad(job.id, job.attempt),
        );
      } catch {
        throw new JobError('credentials_unavailable');
      }
      let parsed: {
        username?: unknown;
        password?: unknown;
        sessionCookies?: unknown;
      };
      try {
        parsed = JSON.parse(plain.toString('utf8')) as typeof parsed;
      } catch {
        throw new JobError('credentials_unavailable');
      } finally {
        plain.fill(0);
      }
      const password =
        typeof parsed.password === 'string' && parsed.password
          ? new SecretBox(parsed.password)
          : null;
      const cookies =
        typeof parsed.sessionCookies === 'string' && parsed.sessionCookies
          ? new SecretBox(parsed.sessionCookies)
          : null;
      parsed.password = undefined;
      parsed.sessionCookies = undefined;
      return {
        username: typeof parsed.username === 'string' ? parsed.username : null,
        password,
        cookies,
        wipe() {
          password?.wipe();
          cookies?.wipe();
        },
      };
    };
  }

  private async execute(r: Running): Promise<void> {
    const { job } = r;
    const log = this.o.logger;
    const started = Date.now();
    log.info('задание взято', {
      jobId: job.id,
      kind: job.kind,
      attempt: job.attempt,
    });
    const hbMs = this.o.heartbeatMs ?? WORKER_LIMITS.heartbeatMs;
    const hb = setInterval(() => {
      this.o.api.heartbeat(job.id, job.leaseToken).then(
        (h) => {
          if (h.cancel) this.cancel(r, 'cancelled');
        },
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 409)
            this.cancel(r, 'lease_lost');
        },
      );
    }, hbMs);
    const wall = setTimeout(() => this.cancel(r, 'job_timeout'), job.wallMs);
    let jb: JobBrowser | null = null;
    let acquired = false;
    try {
      const exec = this.o.executors?.[job.kind] ?? EXECUTORS[job.kind];
      const browser = await this.o.pool.acquire();
      acquired = true;
      jb = this.o.openJobBrowser
        ? await this.o.openJobBrowser(browser, job)
        : await JobBrowser.open(
            browser,
            (job.params as { allowedHosts: string[] }).allowedHosts,
            (job.params as { viewport: 'mobile' | 'desktop' }).viewport,
            this.o.egress,
          );
      const opened = jb;
      r.abort.signal.addEventListener('abort', () => void opened.close());
      const ctx: JobContext = {
        job,
        jb: opened,
        signal: r.abort.signal,
        log,
        uploadArtifact: (a) => this.o.api.artifact(job.id, job.leaseToken, a),
        credentials: this.credentialsFor(job),
      };
      const result = await exec(ctx);
      if (r.abort.signal.aborted) throw new JobError('cancelled');
      // Та же проверка, что на сервере: лишнее/чужой хост/лимит — здесь.
      parseJobResult(job.kind, job.params, result);
      await this.o.api.complete(job.id, job.leaseToken, result);
      this.completed += 1;
      log.info('задание выполнено', {
        jobId: job.id,
        kind: job.kind,
        ms: Date.now() - started,
      });
    } catch (e) {
      if (r.reason === 'lease_lost') {
        log.warn('аренда задания потеряна', { jobId: job.id });
        return;
      }
      const code: WorkerErrorCode =
        r.reason ??
        (e instanceof JobError
          ? e.code
          : jb === null && acquired === false
            ? 'browser_crashed'
            : /Target (page, context or browser )?closed|Browser closed|browser has disconnected/i.test(
                  e instanceof Error ? e.message : '',
                )
              ? 'browser_crashed'
              : e instanceof Error && e.name === 'ProtocolError'
                ? 'too_large'
                : 'internal');
      this.failed += 1;
      try {
        const res = await this.o.api.fail(job.id, job.leaseToken, code);
        log.warn('задание не выполнено', {
          jobId: job.id,
          kind: job.kind,
          code,
          retry: res.retry,
        });
      } catch (err) {
        log.warn('fail не доставлен', {
          jobId: job.id,
          code: err instanceof ApiError ? err.code : 'network',
        });
      }
    } finally {
      clearInterval(hb);
      clearTimeout(wall);
      if (jb) await jb.close();
      if (acquired) this.o.pool.release();
    }
  }

  /** Остановка: новых заданий нет, идущим — срок, затем `shutdown`. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stop.abort();
    await this.loopDone?.catch(() => undefined);
    const all = [...this.running.values()];
    const graceStop = new AbortController();
    const grace = sleep(this.o.shutdownGraceMs, graceStop.signal);
    await Promise.race([Promise.all(all.map((r) => r.done)), grace]);
    graceStop.abort();
    for (const r of this.running.values()) this.cancel(r, 'shutdown');
    await Promise.all([...this.running.values()].map((r) => r.done));
  }
}
