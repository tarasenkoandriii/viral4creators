/**
 * Цикл воркера (Э-С Ш3): pull-модель — воркер сам забирает задания из
 * sites-backend (`claim`), входящих портов у него нет.
 *
 *  - конкурентность — не больше `concurrency` заданий одновременно;
 *    пустая очередь — опрос реже (до `idlePollMaxMs`);
 *  - дренаж перед ротацией Chromium (Ш3-хвост (16)): пул говорит
 *    `holdClaims()` — новые задания не берутся, пока идущие не кончатся
 *    (потолок — `drainMaxMs` пула); иначе при непрерывной нагрузке
 *    ротация не наступала бы никогда;
 *  - на задание: новый контекст и свой прокси (`browser/context.ts`),
 *    heartbeat каждые 15 с (продление аренды; ответ «отменить» — отмена;
 *    409 «аренда потеряна» — тихий обрыв без `fail`; ни одного удачного
 *    heartbeat дольше `leaseMs` — любая ошибка, сеть, зависший запрос —
 *    тот же тихий обрыв `lease_lost`: аренда на сервере уже истекла, и
 *    задание, возможно, отдано другому воркеру), стена времени
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
import {
  JobBrowser,
  WRITE_BLOCK_REASONS,
  type EgressOptions,
} from './browser/context';
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
  pool: Pick<BrowserPool, 'acquire' | 'release'> &
    Partial<Pick<BrowserPool, 'holdClaims'>>;
  logger: Logger;
  kinds: BrowserJobKind[];
  concurrency: number;
  pollMs: number;
  idlePollMaxMs: number;
  shutdownGraceMs: number;
  egress: EgressOptions;
  sealPrivateKey: string | null;
  /** Прежний закрытый ключ (ротация, Ш3-хвост (7)) — только для открытия. */
  sealPreviousPrivateKey?: string | null;
  heartbeatMs?: number;
  /** Срок аренды без удачного heartbeat (тесты); по умолчанию `WORKER_LIMITS.leaseMs`. */
  leaseMs?: number;
  /** Часы (тесты). */
  now?: () => number;
  executors?: Partial<Record<BrowserJobKind, JobExecutor>>;
  /** Тесты: открыть контекст без настоящего браузера. */
  openJobBrowser?: (
    b: Browser,
    job: ClaimedJob,
    onTrafficLimit: () => void,
  ) => Promise<JobBrowser>;
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
      // Дренаж: пора ротировать браузер — свободные места не заполняются.
      const hold = this.o.pool.holdClaims?.() === true;
      const free = hold ? 0 : this.o.concurrency - this.running.size;
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

  /**
   * Открыть конверт под ключ воркера: текущим ключом, затем прежним (ротация).
   * Чужой ключ, AAD или порча — `credentials_unavailable` (без подробностей).
   */
  private openWithKeys(sealed: string, aad: string): Buffer {
    const keys = [this.o.sealPrivateKey, this.o.sealPreviousPrivateKey].filter(
      (k): k is string => !!k,
    );
    for (const k of keys) {
      try {
        return openSealed(k, sealed, aad);
      } catch {
        // следующий ключ
      }
    }
    throw new JobError('credentials_unavailable');
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
      // Текущим ключом, затем прежним: при ротации sites-backend мог ещё не
      // переключить открытый ключ (порядок §6.25: сначала воркер).
      const plain = this.openWithKeys(
        sealed.sealed,
        sealAad(job.id, job.attempt),
      );
      let parsed: {
        username?: unknown;
        password?: unknown;
        sessionCookies?: unknown;
        stored?: unknown;
      };
      try {
        parsed = JSON.parse(plain.toString('utf8')) as typeof parsed;
      } catch {
        throw new JobError('credentials_unavailable');
      } finally {
        plain.fill(0);
      }
      // Ш3-хвост (7): секреты, запечатанные под ключ воркера ПРИ ЗАПИСИ
      // (учётки только для «Админки»), — внутренние конверты со своим AAD
      // (кабинет, сайт, учётка, назначение). sites-backend их не открывал.
      if (Array.isArray(parsed.stored)) {
        for (const item of parsed.stored as unknown[]) {
          const it = item as {
            purpose?: unknown;
            sealed?: unknown;
            aad?: unknown;
          };
          if (typeof it.sealed !== 'string' || typeof it.aad !== 'string')
            throw new JobError('credentials_unavailable');
          const field =
            it.purpose === 'password'
              ? 'password'
              : it.purpose === 'session-cookies'
                ? 'sessionCookies'
                : null;
          if (!field) continue;
          const inner = this.openWithKeys(it.sealed, it.aad);
          try {
            parsed[field] = inner.toString('utf8');
          } finally {
            inner.fill(0);
          }
        }
      }
      parsed.stored = undefined;
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
    const leaseMs = this.o.leaseMs ?? WORKER_LIMITS.leaseMs;
    const now = this.o.now ?? Date.now;
    // Аудит P3: раньше задание обрывалось только по 409. Сеть до
    // sites-backend легла (или 5xx/таймауты) — воркер продолжал работу
    // вслепую, хотя аренда на сервере истекла через `leaseMs` и задание
    // ушло другому воркеру: два браузера на одном сайте, второй `complete`.
    // Отсчёт — от взятия задания (claim выдаёт аренду на `leaseMs`) и от
    // каждого удачного heartbeat; проверка — и на ошибке, и на каждом
    // тике (зависший запрос ошибкой не кончается).
    let leaseOkAt = now();
    const leaseExpired = () => now() - leaseOkAt >= leaseMs;
    const hb = setInterval(() => {
      if (leaseExpired()) {
        log.warn('heartbeat не проходит дольше срока аренды', {
          jobId: job.id,
          ms: leaseMs,
        });
        this.cancel(r, 'lease_lost');
        return;
      }
      this.o.api.heartbeat(job.id, job.leaseToken).then(
        (h) => {
          leaseOkAt = now();
          if (h.cancel) this.cancel(r, 'cancelled');
        },
        (e: unknown) => {
          if ((e instanceof ApiError && e.status === 409) || leaseExpired())
            this.cancel(r, 'lease_lost');
        },
      );
    }, hbMs);
    const wall = setTimeout(() => this.cancel(r, 'job_timeout'), job.wallMs);
    let jb: JobBrowser | null = null;
    let browser: Browser | null = null;
    // Потолок трафика задания (Ш3-хвост (9)): прокси уже оборвал все
    // соединения — задание обрывается с причиной `traffic_limit`.
    const onTrafficLimit = () => this.cancel(r, 'traffic_limit');
    try {
      const exec = this.o.executors?.[job.kind] ?? EXECUTORS[job.kind];
      browser = await this.o.pool.acquire();
      jb = this.o.openJobBrowser
        ? await this.o.openJobBrowser(browser, job, onTrafficLimit)
        : await JobBrowser.open(
            browser,
            (job.params as { allowedHosts: string[] }).allowedHosts,
            (job.params as { viewport: 'mobile' | 'desktop' }).viewport,
            this.o.egress,
            onTrafficLimit,
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
        unseal: (sealed, aad) => this.openWithKeys(sealed, aad),
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
        bytes: opened.traffic().bytesIn,
        writes: opened.writesBlocked().total,
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
          : // Сервер не принял результат (400 WORKER_BAD_RESULT: формат,
            // потолок байтов) — повтор дал бы тот же результат: без повтора.
            e instanceof ApiError &&
              e.status === 400 &&
              e.code === 'WORKER_BAD_RESULT'
            ? 'too_large'
            : jb === null && browser === null
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
      if (jb) {
        const t = jb.traffic();
        if (t.cutResponses || t.cutJob)
          log.warn('потолок трафика', {
            jobId: job.id,
            bytes: t.bytesIn,
            cut: t.cutJob ? 'job' : 'response',
            count: t.cutResponses,
          });
        // Р-З11-Г3: «только чтение» оборвало запись — журнал задания (по
        // причинам: метод, GraphQL, выход, разрушительный адрес, WebSocket).
        const w = jb.writesBlocked();
        if (w.total)
          log.info('запись оборвана (только чтение)', {
            jobId: job.id,
            kind: job.kind,
            writes: w.total,
            reason: WRITE_BLOCK_REASONS.filter((k) => w[k])
              .map((k) => `${k}:${w[k]}`)
              .join(','),
          });
        await jb.close();
      }
      if (browser) this.o.pool.release(browser);
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
