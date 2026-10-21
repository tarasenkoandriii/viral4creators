/**
 * Диспетчер (ТЗ §8, §9): один pipeline за раз (download → probe/limits →
 * executor → проверка outputs → атомарная публикация), atomic claim с
 * lease/heartbeat, round-robin между клиентами и FIFO внутри клиента,
 * queue deadline (QUEUE_TIMEOUT) и общий pipeline deadline (TIMEOUT).
 *
 * Слот освобождается только после доказанного завершения executor
 * (done.json или abandoned.json): отмена/тайм-аут сначала убивают группу
 * процессов, затем очищается workspace.
 *
 * Восстановление при старте (recover): running сверяются с executor по
 * attempt id; второй процесс не запускается, пока прежний не доказанно
 * мёртв; не более одной повторной локальной попытки; OOM, invalid-command
 * и too-large не повторяются.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  ErrorCode,
  ExecPlan,
  ExecutorDone,
  JobRequestBody,
  LimitsProfile,
  ProbeResult,
} from '../contracts';
import type { Ctx } from '../context';
import { openPayload, sealPayload } from '../crypto/crypto';
import { type JobRow, addEvent, getJob, revokeTokens } from '../db/jobs';
import { fsyncDir, moveFile, safeRemove } from '../files/fsutil';
import { errorKind } from '../metrics/logger';
import { errorCodeOf } from './ports';
import { deleteJobFiles, jobOutputsDir, jobWorkspaceDir } from './service';

class PipelineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Остановка процесса API: задача остаётся processing, её подхватит recover. */
class Detached extends Error {}

type ExecResult =
  | { kind: 'done'; done: ExecutorDone }
  | { kind: 'abandoned' }
  | { kind: 'lost' };

/** Не повторяются автоматически (ТЗ §8): OOM, too-large; invalid-command
 * (COMMAND_FAILED) до повтора не доходит вовсе. */
const NO_RETRY_OUTCOMES = new Set(['oom', 'too_large', 'failed']);
export const MAX_ATTEMPTS = 2;

export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private active: { jobId: string; attemptId: string } | null = null;
  private stopping = false;
  private ticking = false;
  private kickPending = false;
  private rrLast: string | null = null;
  private readonly sleepers = new Set<() => void>();
  /** Попытки, найденные recover, которые надо досопровождать до конца. */
  private readonly attachQueue: JobRow[] = [];
  private recovered = false;
  private recovering: Promise<void> | null = null;
  readonly instanceId = randomUUID();

  constructor(private readonly ctx: Ctx) {}

  /** Задача, которую диспетчер ведёт или подхватит первой после recover. */
  activeJobId(): string | null {
    return this.active?.jobId ?? this.attachQueue[0]?.id ?? null;
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * Запуск: сначала recover (в фоне — HTTP уже отвечает), и только после
   * него — выдача новых задач (tick ждёт `recovered`).
   */
  start(): void {
    this.stopping = false;
    if (!this.recovered && !this.recovering) {
      this.recovering = this.recover()
        .catch((e) =>
          this.ctx.log.error('dispatcher.recover_failed', {
            error: errorKind(e),
          }),
        )
        .finally(() => {
          this.recovering = null;
          this.kick();
        });
    }
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.ctx.cfg.dispatcherTickMs,
    );
    this.timer.unref?.();
    this.kick();
  }

  kick(): void {
    if (this.stopping || this.kickPending) return;
    this.kickPending = true;
    setImmediate(() => {
      this.kickPending = false;
      void this.tick();
    });
    for (const w of this.sleepers) w();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.sleepers) w();
    await this.recovering;
    await this.running?.catch(() => undefined);
  }

  private get leaseMs(): number {
    return this.ctx.cfg.executor.heartbeatStaleSec * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.sleepers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  // ── Тик: queue deadline, затем claim ─────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking || this.stopping || !this.recovered) return;
    this.ticking = true;
    try {
      this.expireQueued();
      if (this.active) return;
      const attach = this.attachQueue.shift();
      if (attach) {
        this.launch(attach, attach.current_attempt_id!, 'attach');
        return;
      }
      if (!this.ctx.control.dispatchAllowed()) return;
      if (!this.hasQueued()) return;
      const limits = this.ctx.limits.current();
      const room = await this.ctx.disk.canClaim(
        limits.maxWorkspaceBytes,
        limits.maxTotalOutputBytes,
      );
      if (!room.ok) {
        this.ctx.metrics.inc(
          'ffmpeg_dispatch_blocked_total',
          'Claims blocked by disk quotas',
          { reason: room.reason ?? 'disk' },
        );
        return;
      }
      if (this.active || this.stopping) return;
      const claimed = this.claimNext();
      if (claimed) this.launch(claimed.job, claimed.attemptId, 'fresh');
    } catch (e) {
      this.ctx.log.error('dispatcher.tick_failed', { error: errorKind(e) });
    } finally {
      this.ticking = false;
    }
  }

  private hasQueued(): boolean {
    return !!this.ctx.db.get(
      "SELECT 1 FROM jobs WHERE status = 'queued' LIMIT 1",
    );
  }

  private launch(
    job: JobRow,
    attemptId: string,
    mode: 'fresh' | 'attach',
  ): void {
    this.active = { jobId: job.id, attemptId };
    this.running = this.runPipeline(job.id, attemptId, mode)
      .catch((e) => {
        this.ctx.log.error('dispatcher.pipeline_crashed', {
          job_id: job.id,
          error: errorKind(e),
        });
      })
      .finally(() => {
        this.active = null;
        this.running = null;
        this.kick();
      });
  }

  /** queued дольше queue deadline → failed QUEUE_TIMEOUT (ТЗ §9). */
  expireQueued(): void {
    const now = this.ctx.now();
    const rows = this.ctx.db.all<{
      id: string;
      client_id: string;
      created_at: number;
    }>(
      "SELECT id, client_id, created_at FROM jobs WHERE status = 'queued' AND queue_deadline_at <= ?",
      [now],
    );
    for (const r of rows) {
      const changed = this.ctx.db.tx(() => {
        const res = this.ctx.db.run(
          `UPDATE jobs SET status = 'failed', stage = 'done', error_code = 'QUEUE_TIMEOUT',
             error_message = 'job was not started within the queue deadline',
             execution_status = 'failed', finished_at = ?, updated_at = ?, payload_enc = NULL
           WHERE id = ? AND status = 'queued'`,
          [now, now, r.id],
        );
        if (res.changes)
          addEvent(this.ctx.db, r.id, 'job.queue_timeout', {}, now);
        return res.changes > 0;
      });
      if (changed) {
        this.countFinished('failed', 'QUEUE_TIMEOUT');
        this.ctx.log.warn('job.queue_timeout', {
          job_id: r.id,
          client_id: r.client_id,
          queue_delay_sec: Math.round((now - r.created_at) / 1000),
        });
        void safeRemove(
          this.ctx.cfg.workspaceRoot,
          jobWorkspaceDir(this.ctx, r.id),
        ).catch(() => undefined);
      }
    }
  }

  /** Round-robin по клиентам, FIFO (seq) внутри клиента; claim — CAS. */
  claimNext(): { job: JobRow; attemptId: string } | null {
    const db = this.ctx.db;
    const clients = db
      .all<{ client_id: string }>(
        "SELECT DISTINCT client_id FROM jobs WHERE status = 'queued' ORDER BY client_id",
      )
      .map((r) => r.client_id);
    if (!clients.length) return null;
    const order =
      this.rrLast === null
        ? clients
        : [
            ...clients.filter((c) => c > this.rrLast!),
            ...clients.filter((c) => c <= this.rrLast!),
          ];
    for (const clientId of order) {
      const now = this.ctx.now();
      const attemptId = randomUUID();
      const job = db.tx(() => {
        const cand = db.get<JobRow>(
          "SELECT * FROM jobs WHERE status = 'queued' AND client_id = ? ORDER BY seq LIMIT 1",
          [clientId],
        );
        if (!cand) return null;
        const limits = this.ctx.limits.atRevision(cand.limits_revision);
        const r = db.run(
          `UPDATE jobs SET status = 'processing', stage = 'downloading', claimed_at = ?,
             started_at = COALESCE(started_at, ?), pipeline_deadline_at = ?,
             attempt_count = attempt_count + 1, current_attempt_id = ?,
             lease_owner = ?, lease_expires_at = ?, progress = NULL, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
          [
            now,
            now,
            now + limits.pipelineDeadlineSec * 1000,
            attemptId,
            this.instanceId,
            now + this.leaseMs,
            now,
            cand.id,
          ],
        );
        if (!r.changes) return null;
        db.run(
          "INSERT INTO attempts (id, job_id, n, status, started_at) VALUES (?, ?, ?, 'running', ?)",
          [attemptId, cand.id, cand.attempt_count + 1, now],
        );
        addEvent(
          db,
          cand.id,
          'job.claimed',
          { attempt: cand.attempt_count + 1 },
          now,
        );
        return getJob(db, cand.id)!;
      });
      if (job) {
        this.rrLast = clientId;
        this.ctx.metrics.observe(
          'ffmpeg_queue_delay_seconds',
          'Time from acceptance to claim',
          (now - job.created_at) / 1000,
        );
        this.ctx.log.info('job.claimed', {
          job_id: job.id,
          client_id: job.client_id,
          attempt: job.attempt_count,
          queue_delay_sec: Math.round((now - job.created_at) / 1000),
        });
        return { job, attemptId };
      }
    }
    return null;
  }

  // ── Pipeline ─────────────────────────────────────────────────────────

  private async runPipeline(
    jobId: string,
    attemptId: string,
    mode: 'fresh' | 'attach',
  ): Promise<void> {
    const job = getJob(this.ctx.db, jobId);
    if (!job) return;
    const limits = this.ctx.limits.atRevision(job.limits_revision);
    const deadlineAt = job.pipeline_deadline_at ?? this.ctx.now();
    const abort = new AbortController();
    const watch = setInterval(
      () => {
        const j = getJob(this.ctx.db, jobId);
        this.renewLease(jobId);
        if (
          !j ||
          j.status !== 'processing' ||
          j.cancel_requested_at ||
          j.purge_requested_at
        ) {
          abort.abort(new PipelineError('CANCELED', 'canceled'));
        } else if (this.ctx.now() > deadlineAt) {
          abort.abort(
            new PipelineError('TIMEOUT', 'pipeline deadline exceeded'),
          );
        }
        if (this.stopping) abort.abort(new Detached());
      },
      Math.min(1000, this.ctx.cfg.executor.pollIntervalMs),
    );
    watch.unref?.();
    let executorInvolved = mode === 'attach';
    let plan: ExecPlan | null = null;
    let result: ExecResult | null = null;
    try {
      plan = this.loadPlan(job, limits);
      if (mode === 'fresh') {
        await this.prepareInputs(
          job,
          attemptId,
          plan,
          limits,
          deadlineAt,
          abort.signal,
        );
        // До записи request.json: после неё слот держится до доказательства.
        executorInvolved = true;
        await this.startExecutor(job, attemptId, plan, limits, deadlineAt);
      }
      result = await this.awaitExecutor(jobId, attemptId, plan, deadlineAt);
      await this.finishAttempt(
        jobId,
        attemptId,
        plan,
        limits,
        deadlineAt,
        result,
      );
    } catch (e) {
      if (e instanceof Detached || this.stopping) {
        // Процесс API останавливается: задачу доведёт recover после рестарта.
        return;
      }
      const reason = abort.signal.aborted ? abort.signal.reason : null;
      const code =
        e instanceof PipelineError
          ? e.code
          : reason instanceof PipelineError
            ? reason.code
            : errorCodeOf(e);
      const message =
        e instanceof PipelineError ? e.message : safeMessage(code);
      if (!(e instanceof PipelineError) && code === 'INTERNAL') {
        this.ctx.log.error('job.pipeline_error', {
          job_id: jobId,
          error: errorKind(e),
        });
      }
      if (executorInvolved && !result) {
        // Executor уже получил попытку — слот не освобождаем без доказательства.
        try {
          await this.ctx.ports.executor.cancel(attemptId);
          result = await this.awaitExecutor(jobId, attemptId, plan, deadlineAt);
        } catch (e2) {
          if (e2 instanceof Detached || this.stopping) return;
        }
      }
      this.failJob(
        jobId,
        attemptId,
        code === 'CANCELED' ? 'CANCELED' : code,
        message,
      );
    } finally {
      clearInterval(watch);
    }
    if (this.stopping) return;
    await this.cleanupAfter(jobId);
  }

  private renewLease(jobId: string): void {
    const now = this.ctx.now();
    this.ctx.db.run(
      "UPDATE jobs SET lease_expires_at = ?, lease_owner = ? WHERE id = ? AND status = 'processing'",
      [now + this.leaseMs, this.instanceId, jobId],
    );
  }

  private loadPlan(job: JobRow, limits: LimitsProfile): ExecPlan {
    if (!job.payload_enc || !job.payload_key_id) {
      throw new PipelineError('INTERNAL', 'job payload is not available');
    }
    const body = JSON.parse(
      openPayload(
        this.ctx.cfg.payloadKeys,
        job.payload_key_id,
        job.payload_enc,
        job.id,
      ),
    ) as JobRequestBody;
    const parsed = this.ctx.ports.parseJob(body, limits);
    if (!parsed.ok) throw new PipelineError(parsed.code, parsed.message);
    return parsed.plan;
  }

  private setStage(jobId: string, stage: JobRow['stage']): void {
    const now = this.ctx.now();
    this.ctx.db.run(
      "UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ? AND status = 'processing'",
      [stage, now, jobId],
    );
    addEvent(this.ctx.db, jobId, `stage.${stage}`, {}, now);
  }

  private async prepareInputs(
    job: JobRow,
    attemptId: string,
    plan: ExecPlan,
    limits: LimitsProfile,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const ex = this.ctx.ports.executor;
    const paths = await ex.prepareAttempt(job.id, attemptId);
    let total = 0;
    if (job.retry_inputs_from) {
      // Повторная попытка: входы прежней попытки сохранены — без скачивания.
      const from = path.join(
        ex.attemptDir(job.id, job.retry_inputs_from),
        'inputs',
      );
      for (const inp of plan.inputs) {
        try {
          await fsp.rename(
            path.join(path.dirname(from), relIn('inputs', inp.localName)),
            path.join(paths.dir, relIn('inputs', inp.localName)),
          );
        } catch {
          throw new PipelineError(
            'INTERRUPTED',
            'inputs of the interrupted attempt are not available',
          );
        }
      }
      addEvent(this.ctx.db, job.id, 'inputs.reused', {
        from_attempt: job.retry_inputs_from,
      });
    } else {
      this.setStage(job.id, 'downloading');
      for (const inp of plan.inputs) {
        if (signal.aborted) throw signal.reason;
        const remaining = limits.maxTotalInputBytes - total;
        if (remaining <= 0) {
          throw new PipelineError(
            'INPUT_TOO_LARGE',
            'total input size limit exceeded',
          );
        }
        const started = this.ctx.now();
        try {
          const out = await this.ctx.ports.downloadInput(
            inp.url,
            path.join(paths.dir, relIn('inputs', inp.localName)),
            {
              allowedHosts: this.ctx.cfg.inputAllowedHosts,
              maxBytes: Math.min(limits.maxInputBytes, remaining),
              deadlineAt: Math.min(
                deadlineAt,
                started + limits.downloadFileDeadlineSec * 1000,
              ),
              connectTimeoutMs: limits.downloadConnectTimeoutSec * 1000,
              stallTimeoutMs: limits.downloadStallTimeoutSec * 1000,
              fileTimeoutMs: limits.downloadFileDeadlineSec * 1000,
              signal,
              ...this.ctx.downloadExtra,
            },
          );
          total += out.bytes;
        } catch (e) {
          if (signal.aborted) throw signal.reason;
          const code = errorCodeOf(e, 'INPUT_DOWNLOAD_FAILED');
          // Причина — для карточки ops (без URL: санитайзер вырезает их).
          addEvent(this.ctx.db, job.id, 'download.failed', {
            input: inp.key,
            code,
            http_status: (e as { httpStatus?: number }).httpStatus ?? null,
            reason: sanitizeStderr((e as Error)?.message ?? '').slice(0, 200),
          });
          // Срок конкретного файла (не общий) — это сбой скачивания.
          const finalCode =
            code === 'TIMEOUT' && this.ctx.now() < deadlineAt
              ? 'INPUT_DOWNLOAD_FAILED'
              : code;
          throw new PipelineError(
            finalCode,
            `input ${inp.key}: ${safeMessage(finalCode)}`,
          );
        }
      }
      this.redactPayload(job.id);
    }

    // ffprobe недоверенных входов — внутри executor без сети.
    this.setStage(job.id, 'probing');
    if (signal.aborted) throw signal.reason;
    const probes = await this.withSignal(
      ex.probe(
        job.id,
        attemptId,
        plan.inputs.map((i) => relIn('inputs', i.localName)),
        {
          timeoutMs: Math.max(
            1000,
            Math.min(60_000, deadlineAt - this.ctx.now()),
          ),
          signal,
        },
      ),
      signal,
    );
    const inputsMeta: Array<Record<string, unknown>> = [];
    for (const [i, inp] of plan.inputs.entries()) {
      const p = probes[i];
      if (!p) {
        throw new PipelineError(
          'INPUT_INVALID_MEDIA',
          `input ${inp.key}: not a readable media file`,
        );
      }
      const chk = this.ctx.ports.checkInputLimits(p, limits);
      if (!chk.ok)
        throw new PipelineError(chk.code, `input ${inp.key}: ${chk.message}`);
      inputsMeta.push({ key: inp.key, ...summarizeProbe(p) });
    }
    const bytes = inputsMeta.reduce((s, m) => s + Number(m.bytes ?? 0), 0);
    this.ctx.db.run(
      'UPDATE jobs SET inputs_metadata = ?, input_bytes = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(inputsMeta), bytes, this.ctx.now(), job.id],
    );
  }

  private async withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() =>
        signal.removeEventListener('abort', onAbort),
      );
    });
  }

  /** После скачивания исходные URL больше не нужны — payload без них. */
  private redactPayload(jobId: string): void {
    const job = getJob(this.ctx.db, jobId);
    if (!job?.payload_enc || !job.payload_key_id || job.payload_redacted)
      return;
    const body = JSON.parse(
      openPayload(
        this.ctx.cfg.payloadKeys,
        job.payload_key_id,
        job.payload_enc,
        job.id,
      ),
    ) as JobRequestBody;
    const redacted: JobRequestBody = {
      ...body,
      input_files: Object.fromEntries(
        Object.keys(body.input_files).map((k, i) => [
          k,
          `https://redacted.invalid/${i}`,
        ]),
      ),
    };
    const sealed = sealPayload(
      this.ctx.cfg.payloadKeys,
      JSON.stringify(redacted),
      job.id,
    );
    this.ctx.db.run(
      'UPDATE jobs SET payload_enc = ?, payload_key_id = ?, payload_redacted = 1 WHERE id = ?',
      [sealed.sealed, sealed.keyId, jobId],
    );
  }

  private async startExecutor(
    job: JobRow,
    attemptId: string,
    plan: ExecPlan,
    limits: LimitsProfile,
    deadlineAt: number,
  ): Promise<void> {
    this.setStage(job.id, 'running');
    const inputBytes = getJob(this.ctx.db, job.id)?.input_bytes ?? 0;
    // Запас на проверку и публикацию — до 60 с из общего срока.
    const reserve = Math.min(
      60_000,
      Math.floor((deadlineAt - this.ctx.now()) / 10),
    );
    await this.ctx.ports.executor.start({
      version: 1,
      jobId: job.id,
      attemptId,
      steps: plan.steps,
      deadlineAt: deadlineAt - Math.max(0, reserve),
      maxThreads: limits.maxThreads,
      stderrTailBytes: limits.stderrTailBytes,
      maxWriteBytes: Math.max(0, limits.maxWorkspaceBytes - inputBytes),
    });
    const now = this.ctx.now();
    this.ctx.db.run(
      'UPDATE attempts SET executor_started_at = ? WHERE id = ?',
      [now, attemptId],
    );
    addEvent(
      this.ctx.db,
      job.id,
      'executor.started',
      { steps: plan.steps.length },
      now,
    );
  }

  /**
   * Сопровождение попытки до done/abandoned. Отмена и общий срок
   * передаются executor файлом cancel; после срока + запаса задача
   * публично помечается TIMEOUT, но слот держится до доказательства.
   */
  private async awaitExecutor(
    jobId: string,
    attemptId: string,
    plan: ExecPlan | null,
    deadlineAt: number,
  ): Promise<ExecResult> {
    const ex = this.ctx.ports.executor;
    let cancelSent = false;
    let timeoutMarked = false;
    let lastProgress = -1;
    let lastProgressAt = 0;
    const graceMs = 30_000;
    const durationHint = this.durationHint(jobId);
    for (;;) {
      if (this.stopping) throw new Detached();
      const job = getJob(this.ctx.db, jobId);
      const now = this.ctx.now();
      const wantCancel =
        !job ||
        job.status !== 'processing' ||
        !!job.cancel_requested_at ||
        !!job.purge_requested_at;
      if (!cancelSent && (wantCancel || now > deadlineAt)) {
        await ex.cancel(attemptId);
        cancelSent = true;
        addEvent(this.ctx.db, jobId, 'executor.cancel_sent', {
          deadline: now > deadlineAt,
        });
      }
      if (
        !timeoutMarked &&
        now > deadlineAt + graceMs &&
        job?.status === 'processing'
      ) {
        this.failJob(
          jobId,
          attemptId,
          'TIMEOUT',
          'pipeline deadline exceeded',
          false,
        );
        timeoutMarked = true;
        this.ctx.log.warn('executor.not_confirmed', { job_id: jobId });
      }
      const p = await ex.poll(attemptId);
      if (p.kind === 'done') return { kind: 'done', done: p.done };
      if (p.kind === 'abandoned') return { kind: 'abandoned' };
      if (p.kind === 'unknown') return { kind: 'lost' };
      if (p.kind === 'running' && plan && job?.status === 'processing') {
        const steps = Math.max(1, plan.steps.length);
        let progress: number | null = null;
        if (durationHint && p.state.outTimeSec !== null) {
          const frac = Math.min(
            1,
            Math.max(0, p.state.outTimeSec / durationHint),
          );
          progress = Math.min(99, ((p.state.stepIndex + frac) / steps) * 100);
        }
        if (
          progress !== null &&
          (Math.abs(progress - lastProgress) >= 1 ||
            now - lastProgressAt > 5000)
        ) {
          lastProgress = progress;
          lastProgressAt = now;
          this.ctx.db.run(
            "UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = 'processing'",
            [Math.round(progress * 10) / 10, now, jobId],
          );
        }
      }
      this.renewLease(jobId);
      await this.sleep(this.ctx.cfg.executor.pollIntervalMs);
    }
  }

  private durationHint(jobId: string): number | null {
    const raw = getJob(this.ctx.db, jobId)?.inputs_metadata;
    if (!raw) return null;
    try {
      const metas = JSON.parse(raw) as Array<{ durationSec?: number | null }>;
      const ds = metas.map((m) => m.durationSec ?? 0).filter((d) => d > 0);
      return ds.length ? Math.max(...ds) : null;
    } catch {
      return null;
    }
  }

  private async finishAttempt(
    jobId: string,
    attemptId: string,
    plan: ExecPlan,
    limits: LimitsProfile,
    deadlineAt: number,
    result: ExecResult,
  ): Promise<void> {
    if (result.kind === 'lost') {
      throw new PipelineError(
        'INTERNAL',
        'executor attempt state is not available',
      );
    }
    if (result.kind === 'abandoned') {
      this.interruptOrRetry(jobId, attemptId, 'abandoned');
      return;
    }
    const d = result.done;
    this.recordDone(jobId, attemptId, d);
    const job = getJob(this.ctx.db, jobId);
    if (!job || job.status !== 'processing') return; // отменена/истекла — итог уже записан
    switch (d.outcome) {
      case 'succeeded':
        await this.validateAndPublish(
          job,
          attemptId,
          plan,
          limits,
          deadlineAt,
          d,
        );
        return;
      case 'failed':
        throw new PipelineError(
          'COMMAND_FAILED',
          `ffmpeg command #${(d.failedStep ?? 0) + 1} failed` +
            (d.exitCode !== null
              ? ` (exit ${d.exitCode})`
              : d.signal
                ? ` (${d.signal})`
                : ''),
        );
      case 'timeout':
        throw new PipelineError('TIMEOUT', 'processing deadline exceeded');
      case 'oom':
        throw new PipelineError('OOM', 'ffmpeg exceeded the memory limit');
      case 'too_large':
        throw new PipelineError(
          'OUTPUT_TOO_LARGE',
          'written data exceeded the workspace limit',
        );
      case 'canceled':
        if (this.ctx.now() > deadlineAt) {
          throw new PipelineError('TIMEOUT', 'pipeline deadline exceeded');
        }
        throw new PipelineError('CANCELED', 'canceled');
    }
  }

  private recordDone(jobId: string, attemptId: string, d: ExecutorDone): void {
    const now = this.ctx.now();
    const status =
      d.outcome === 'succeeded'
        ? 'succeeded'
        : d.outcome === 'canceled'
          ? 'canceled'
          : 'failed';
    this.ctx.db.tx(() => {
      this.ctx.db.run(
        `UPDATE attempts SET status = ?, outcome = ?, finished_at = ?, exit_code = ?, signal = ?,
           wall_ms = ?, cpu_ms = ?, peak_rss_kb = ? WHERE id = ?`,
        [
          status,
          d.outcome,
          now,
          d.exitCode,
          d.signal,
          d.wallMs,
          d.cpuMs,
          d.peakRssKb,
          attemptId,
        ],
      );
      this.ctx.db.run(
        `UPDATE jobs SET exit_code = ?, ffmpeg_version = COALESCE(?, ffmpeg_version),
           stderr_tail = ?, wall_ms = MAX(COALESCE(wall_ms, 0), ?),
           cpu_ms = MAX(COALESCE(cpu_ms, 0), COALESCE(?, 0)),
           peak_rss_kb = MAX(COALESCE(peak_rss_kb, 0), COALESCE(?, 0)), updated_at = ?
         WHERE id = ?`,
        [
          d.exitCode,
          d.ffmpegVersion,
          sanitizeStderr(d.stderrTail),
          d.wallMs,
          d.cpuMs,
          d.peakRssKb,
          now,
          jobId,
        ],
      );
      addEvent(
        this.ctx.db,
        jobId,
        'executor.done',
        {
          outcome: d.outcome,
          exit_code: d.exitCode,
          wall_ms: d.wallMs,
        },
        now,
      );
    });
    this.ctx.metrics.inc(
      'ffmpeg_executor_outcomes_total',
      'Executor attempt outcomes',
      {
        outcome: d.outcome,
      },
    );
    this.ctx.metrics.observe(
      'ffmpeg_executor_wall_seconds',
      'Executor wall time',
      d.wallMs / 1000,
    );
    this.ctx.log.info('executor.done', {
      job_id: jobId,
      attempt_id: attemptId,
      outcome: d.outcome,
      exit_code: d.exitCode,
      wall_ms: d.wallMs,
      cpu_ms: d.cpuMs,
      peak_rss_kb: d.peakRssKb,
    });
  }

  private async validateAndPublish(
    job: JobRow,
    attemptId: string,
    plan: ExecPlan,
    limits: LimitsProfile,
    deadlineAt: number,
    done: ExecutorDone,
  ): Promise<void> {
    const ex = this.ctx.ports.executor;
    this.setStage(job.id, 'validating');
    const attemptDir = ex.attemptDir(job.id, attemptId);
    const check = await this.ctx.ports.verifyOutputs(
      attemptDir,
      plan.outputs,
      limits,
      {
        probe: (files) =>
          ex.probe(job.id, attemptId, files, {
            timeoutMs: Math.max(
              1000,
              Math.min(60_000, deadlineAt - this.ctx.now()),
            ),
          }),
      },
    );
    if (!check.ok) {
      throw new PipelineError(
        check.code,
        `output ${check.name}: ${safeMessage(check.code)}`,
      );
    }
    if (this.ctx.now() > deadlineAt) {
      throw new PipelineError('TIMEOUT', 'pipeline deadline exceeded');
    }
    const total = check.files.reduce((s, f) => s + f.bytes, 0);
    if (total > limits.maxTotalOutputBytes) {
      throw new PipelineError(
        'OUTPUT_TOO_LARGE',
        'total output size limit exceeded',
      );
    }
    const snap = this.ctx.disk.snapshot;
    if (snap.outputsBytes + total > this.ctx.cfg.disk.maxOutputsBytes) {
      throw new PipelineError('INTERNAL', 'output storage quota exceeded');
    }

    // Публикация: временный каталог → rename → фиксация manifest в БД (CAS).
    this.setStage(job.id, 'publishing');
    const root = this.ctx.cfg.outputsRoot;
    await fsp.mkdir(root, { recursive: true });
    const tmp = path.join(
      root,
      `.tmp-${job.id}-${randomBytes(4).toString('hex')}`,
    );
    const finalDir = jobOutputsDir(this.ctx, job.id);
    await fsp.mkdir(tmp, { mode: 0o750 });
    const arts: Array<{
      name: string;
      file: string;
      bytes: number;
      sha256: string;
      mime: string;
    }> = [];
    const metadata: Record<string, unknown> = {};
    try {
      for (const [i, f] of check.files.entries()) {
        const src = path.join(attemptDir, relIn('outputs', f.localName));
        const file = `${i}${safeExt(f.name)}`;
        await moveFile(src, path.join(tmp, file));
        arts.push({
          name: f.name,
          file,
          bytes: f.bytes,
          sha256: f.sha256,
          mime: f.mime,
        });
        metadata[f.name] = {
          bytes: f.bytes,
          sha256: f.sha256,
          mime: f.mime,
          ...(f.probe ? summarizeProbe(f.probe, false) : {}),
        };
      }
      await fsyncDir(tmp);
      await safeRemove(root, finalDir);
      await fsp.rename(tmp, finalDir);
      await fsyncDir(root);
    } catch (e) {
      await safeRemove(root, tmp).catch(() => undefined);
      throw e;
    }
    const now = this.ctx.now();
    const published = this.ctx.db.tx(() => {
      const r = this.ctx.db.run(
        `UPDATE jobs SET status = 'succeeded', stage = 'done', execution_status = 'succeeded',
           error_code = NULL, error_message = '', progress = 100, finished_at = ?, expires_at = ?,
           outputs_metadata = ?, output_bytes = ?, ffmpeg_version = COALESCE(?, ffmpeg_version),
           payload_enc = NULL, updated_at = ?
         WHERE id = ? AND status = 'processing' AND cancel_requested_at IS NULL
           AND purge_requested_at IS NULL`,
        [
          now,
          now + this.ctx.cfg.retention.outputTtlSec * 1000,
          JSON.stringify(metadata),
          total,
          done.ffmpegVersion,
          now,
          job.id,
        ],
      );
      if (!r.changes) return false;
      for (const a of arts) {
        this.ctx.db.run(
          `INSERT OR REPLACE INTO artifacts (job_id, name, local_path, bytes, sha256, mime, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            job.id,
            a.name,
            `${job.id}/${a.file}`,
            a.bytes,
            a.sha256,
            a.mime,
            now,
          ],
        );
      }
      addEvent(
        this.ctx.db,
        job.id,
        'job.succeeded',
        { outputs: arts.length, bytes: total },
        now,
      );
      return true;
    });
    if (!published) {
      // Отмена/purge выиграли CAS — готовые файлы не публикуются.
      await safeRemove(root, finalDir);
      addEvent(this.ctx.db, job.id, 'publish.discarded', {});
      return;
    }
    this.countFinished('succeeded', 'NONE');
    const j = getJob(this.ctx.db, job.id)!;
    this.ctx.metrics.observe(
      'ffmpeg_pipeline_seconds',
      'Claim-to-finish pipeline time',
      (now - (j.claimed_at ?? now)) / 1000,
    );
    this.ctx.log.info('job.succeeded', {
      job_id: job.id,
      client_id: job.client_id,
      operation_id: job.client_operation_id,
      outputs: arts.length,
      output_bytes: total,
      input_bytes: j.input_bytes,
      attempts: j.attempt_count,
      wall_ms: j.wall_ms,
      cpu_ms: j.cpu_ms,
      peak_rss_kb: j.peak_rss_kb,
      exit_code: j.exit_code,
      image_digest: j.image_digest,
      queue_delay_ms: (j.claimed_at ?? now) - j.created_at,
    });
  }

  /**
   * Терминальная ошибка (CAS: только из processing). `finalize=false` —
   * публичный статус меняется, но слот ещё держится (executor не
   * подтвердил завершение).
   */
  private failJob(
    jobId: string,
    attemptId: string,
    code: ErrorCode,
    message: string,
    finalizeAttempt = true,
  ): void {
    const now = this.ctx.now();
    const changed = this.ctx.db.tx(() => {
      if (finalizeAttempt) {
        this.ctx.db.run(
          `UPDATE attempts SET status = CASE WHEN status = 'running' THEN ? ELSE status END,
             error_code = COALESCE(error_code, ?), finished_at = COALESCE(finished_at, ?)
           WHERE id = ?`,
          [code === 'CANCELED' ? 'canceled' : 'failed', code, now, attemptId],
        );
      }
      const status = code === 'CANCELED' ? 'canceled' : 'failed';
      const r = this.ctx.db.run(
        `UPDATE jobs SET status = ?, stage = 'done', error_code = ?, error_message = ?,
           execution_status = ?, finished_at = ?, updated_at = ?, payload_enc = NULL
         WHERE id = ? AND status = 'processing'`,
        [status, code, message, status, now, now, jobId],
      );
      if (r.changes) {
        revokeTokens(this.ctx.db, jobId);
        addEvent(this.ctx.db, jobId, `job.${status}`, { code }, now);
      }
      return r.changes > 0;
    });
    if (changed) {
      this.countFinished(code === 'CANCELED' ? 'canceled' : 'failed', code);
      const j = getJob(this.ctx.db, jobId);
      this.ctx.log.warn('job.failed', {
        job_id: jobId,
        client_id: j?.client_id,
        operation_id: j?.client_operation_id,
        code,
        attempts: j?.attempt_count,
        exit_code: j?.exit_code,
        wall_ms: j?.wall_ms,
        peak_rss_kb: j?.peak_rss_kb,
      });
    }
  }

  /**
   * Попытка прервана (executor доказал смерть группы процессов). Одна
   * повторная локальная попытка — если ещё не было повтора и входы
   * сохранены; иначе INTERRUPTED.
   */
  private interruptOrRetry(
    jobId: string,
    attemptId: string,
    why: string,
  ): void {
    const now = this.ctx.now();
    const job = getJob(this.ctx.db, jobId);
    if (!job) return;
    this.ctx.db.run(
      "UPDATE attempts SET status = 'interrupted', outcome = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?",
      [why, now, attemptId],
    );
    const lastOutcome = this.ctx.db.get<{ outcome: string | null }>(
      'SELECT outcome FROM attempts WHERE id = ?',
      [attemptId],
    )?.outcome;
    const canRetry =
      job.status === 'processing' &&
      job.attempt_count < MAX_ATTEMPTS &&
      !NO_RETRY_OUTCOMES.has(lastOutcome ?? '') &&
      !!job.payload_enc;
    if (!canRetry) {
      this.failJob(
        jobId,
        attemptId,
        'INTERRUPTED',
        'processing was interrupted',
      );
      return;
    }
    const limits = this.ctx.limits.atRevision(job.limits_revision);
    const reuseInputs = job.payload_redacted === 1 ? attemptId : null;
    this.ctx.db.tx(() => {
      this.ctx.db.run(
        `UPDATE jobs SET status = 'queued', stage = 'queued', current_attempt_id = NULL,
           retry_inputs_from = ?, lease_owner = NULL, lease_expires_at = NULL, progress = 0,
           queue_deadline_at = ?, updated_at = ?
         WHERE id = ? AND status = 'processing'`,
        [reuseInputs, now + limits.queueDeadlineSec * 1000, now, jobId],
      );
      addEvent(this.ctx.db, jobId, 'job.retry_scheduled', { after: why }, now);
    });
    this.ctx.metrics.inc(
      'ffmpeg_recovery_retries_total',
      'Local retries after interruption',
    );
    this.ctx.log.warn('job.retry_scheduled', { job_id: jobId, after: why });
  }

  private async cleanupAfter(jobId: string): Promise<void> {
    const job = getJob(this.ctx.db, jobId);
    if (!job) return;
    if (job.status === 'queued') {
      // Повтор: каталог прежней попытки нужен (входы); остальное — позже.
      return;
    }
    if (job.purge_requested_at) {
      await deleteJobFiles(this.ctx, jobId).catch((e) =>
        this.ctx.log.error('cleanup.purge_failed', {
          job_id: jobId,
          error: errorKind(e),
        }),
      );
      return;
    }
    await safeRemove(
      this.ctx.cfg.workspaceRoot,
      jobWorkspaceDir(this.ctx, jobId),
    ).catch((e) =>
      this.ctx.log.error('cleanup.workspace_failed', {
        job_id: jobId,
        error: errorKind(e),
      }),
    );
  }

  private countFinished(status: string, code: string): void {
    this.ctx.metrics.inc(
      'ffmpeg_jobs_finished_total',
      'Finished jobs by status/code',
      {
        status,
        code,
      },
    );
    if (code === 'OOM')
      this.ctx.metrics.inc('ffmpeg_oom_total', 'OOM failures');
    if (code === 'TIMEOUT' || code === 'QUEUE_TIMEOUT') {
      this.ctx.metrics.inc('ffmpeg_timeouts_total', 'Timeouts', { code });
    }
  }

  // ── Восстановление после рестарта (ТЗ §8) ────────────────────────────

  async recover(): Promise<void> {
    const ex = this.ctx.ports.executor;
    const rows = this.ctx.db.all<JobRow>(
      "SELECT * FROM jobs WHERE status = 'processing' ORDER BY seq",
    );
    for (const job of rows) {
      // Lease другого живого экземпляра — ждём его истечения.
      while (
        job.lease_owner &&
        job.lease_owner !== this.instanceId &&
        (getJob(this.ctx.db, job.id)?.lease_expires_at ?? 0) > this.ctx.now() &&
        !this.stopping
      ) {
        await this.sleep(Math.min(1000, this.leaseMs));
      }
      const attemptId = job.current_attempt_id;
      this.ctx.metrics.inc(
        'ffmpeg_recovered_jobs_total',
        'Jobs found processing at startup',
      );
      if (!attemptId) {
        this.interruptOrRetry(job.id, 'none', 'no_attempt');
        continue;
      }
      const p = await ex.poll(attemptId);
      addEvent(this.ctx.db, job.id, 'recovery.found', {
        executor: p.kind,
        stage: job.stage,
      });
      this.ctx.log.warn('recovery.job', {
        job_id: job.id,
        executor: p.kind,
        stage: job.stage,
      });
      if (p.kind === 'unknown') {
        // Executor попытку не получал: прежний pipeline был в процессе API,
        // который мёртв (lease истёк) — завершение доказано.
        this.interruptOrRetry(job.id, attemptId, 'api_restart');
        if (getJob(this.ctx.db, job.id)?.status !== 'queued')
          await this.cleanupAfter(job.id);
        continue;
      }
      if (p.kind === 'abandoned') {
        this.interruptOrRetry(job.id, attemptId, 'abandoned');
        if (getJob(this.ctx.db, job.id)?.status !== 'queued')
          await this.cleanupAfter(job.id);
        continue;
      }
      // queued/running/done — второй процесс не запускаем, сопровождаем этот.
      this.ctx.db.run(
        'UPDATE jobs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?',
        [this.instanceId, this.ctx.now() + this.leaseMs, job.id],
      );
      this.attachQueue.push(getJob(this.ctx.db, job.id)!);
    }
    await this.cancelOrphans();
    this.recovered = true;
  }

  /** Executor занят попыткой, которую мы не ведём, — отменить (orphan). */
  async cancelOrphans(): Promise<number> {
    const ex = this.ctx.ports.executor;
    const st = await ex
      .executorStatus(this.ctx.cfg.executor.heartbeatStaleSec * 1000)
      .catch(() => null);
    const busy = st?.heartbeat.busyAttemptId;
    if (!busy) return 0;
    const known = this.ctx.db.get<{ job_id: string; status: string }>(
      'SELECT a.job_id, j.status FROM attempts a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?',
      [busy],
    );
    const attached =
      this.active?.attemptId === busy ||
      this.attachQueue.some((j) => j.current_attempt_id === busy);
    if (attached) return 0;
    if (!known || known.status !== 'processing') {
      await ex.cancel(busy);
      this.ctx.metrics.inc(
        'ffmpeg_orphan_executor_total',
        'Orphan executor attempts canceled',
      );
      this.ctx.log.warn('executor.orphan_canceled', {
        job_id: known?.job_id ?? null,
      });
      return 1;
    }
    return 0;
  }
}

/**
 * Путь файла плана относительно каталога попытки. Парсер EXEC отдаёт
 * `inputs/x` / `outputs/x`; голое имя трактуется как файл внутри `sub/`.
 * Выход за пределы `sub/` — ошибка (план уже проверен парсером).
 */
export function relIn(sub: 'inputs' | 'outputs', localName: string): string {
  const rel = localName.startsWith(`${sub}/`)
    ? localName
    : `${sub}/${localName}`;
  const norm = path.posix.normalize(rel);
  if (
    !norm.startsWith(`${sub}/`) ||
    norm.includes('\0') ||
    norm.split('/').length !== 2
  ) {
    throw new PipelineError('INTERNAL', 'invalid file name in plan');
  }
  return norm;
}

function safeExt(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/** Безопасные тексты ошибок по коду (без URL, путей и stderr). */
export function safeMessage(code: ErrorCode): string {
  const m: Partial<Record<ErrorCode, string>> = {
    FORBIDDEN_SOURCE: 'source is not allowed',
    INPUT_DOWNLOAD_FAILED: 'download failed',
    INPUT_EXPIRED: 'input link has expired or is not authorized',
    INPUT_TOO_LARGE: 'input exceeds the size limit',
    INPUT_INVALID_MEDIA: 'input is not a valid media file',
    INPUT_LIMIT_EXCEEDED: 'input exceeds the media limits',
    OUTPUT_MISSING: 'declared output was not produced',
    OUTPUT_TOO_LARGE: 'output exceeds the size limit',
    OUTPUT_INVALID_MEDIA: 'output is not a valid media file',
    TIMEOUT: 'processing deadline exceeded',
    CANCELED: 'canceled',
    INTERRUPTED: 'processing was interrupted',
    OOM: 'ffmpeg exceeded the memory limit',
  };
  return m[code] ?? 'internal error';
}

export function summarizeProbe(
  p: ProbeResult,
  withHash = true,
): Record<string, unknown> {
  return {
    bytes: p.bytes,
    ...(withHash ? { sha256: p.sha256, mime: p.mime } : {}),
    format: p.formatName,
    durationSec: p.durationSec,
    streams: p.streams.map((s) => ({
      type: s.type,
      codec: s.codec,
      width: s.width,
      height: s.height,
      fps: s.fps,
      sampleRate: s.sampleRate,
      channels: s.channels,
      durationSec: s.durationSec,
      rotation: s.rotation,
    })),
  };
}

/** stderr для карточки ops: без URL, ≤64 KiB. Executor уже убрал пути. */
export function sanitizeStderr(s: string | null | undefined): string {
  if (!s) return '';
  const clean = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, '[url]');
  const buf = Buffer.from(clean, 'utf8');
  return buf.length <= 65536
    ? clean
    : buf.subarray(buf.length - 65536).toString('utf8');
}
