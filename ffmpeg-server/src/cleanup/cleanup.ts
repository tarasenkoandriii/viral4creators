/**
 * Плановая очистка (ТЗ §7, §8, §9):
 *  - файлы результата живут 24 ч от завершения (не от последнего GET);
 *    после TTL задача остаётся в истории как failed/OUTPUT_EXPIRED с
 *    execution_status = succeeded, ссылки отзываются;
 *  - payload (URL и команды) не хранится у терминальных задач;
 *  - история задач — 90 дней, tombstone идемпотентности — 90 дней;
 *  - orphan-workspaces удаляются только внутри WORKSPACE_ROOT и только
 *    каталоги известной формы (uuid задачи): задачи уже нет/она
 *    терминальна, либо каталог старше порога; чужие имена не трогаются.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context';
import { addEvent, revokeTokens } from '../db/jobs';
import { safeRemove } from '../files/fsutil';
import { errorKind } from '../metrics/logger';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 86_400_000;

export interface CleanupReport {
  expiredOutputs: number;
  deletedJobs: number;
  deletedKeys: number;
  deletedTokens: number;
  removedWorkspaces: number;
  removedOutputDirs: number;
  errors: number;
}

export class Cleanup {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<CleanupReport> | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: {
      /** Неизвестный/брошенный каталог старше этого — orphan. */
      orphanAgeMs?: number;
      cancelOrphans?: () => Promise<number>;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.run(),
      this.ctx.cfg.cleanupIntervalSec * 1000,
    );
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  run(): Promise<CleanupReport> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<CleanupReport> {
    const r: CleanupReport = {
      expiredOutputs: 0,
      deletedJobs: 0,
      deletedKeys: 0,
      deletedTokens: 0,
      removedWorkspaces: 0,
      removedOutputDirs: 0,
      errors: 0,
    };
    const step = async (name: string, fn: () => Promise<void> | void) => {
      try {
        await fn();
      } catch (e) {
        r.errors++;
        this.ctx.metrics.inc(
          'ffmpeg_cleanup_errors_total',
          'Cleanup step errors',
          {
            step: name,
          },
        );
        this.ctx.log.error('cleanup.step_failed', {
          step: name,
          error: errorKind(e),
        });
      }
    };
    await step('expire_outputs', () => this.expireOutputs(r));
    await step('payloads', () => this.dropTerminalPayloads());
    await step('tokens', () => this.dropTokens(r));
    await step('history', () => this.dropHistory(r));
    await step('workspaces', () => this.orphanWorkspaces(r));
    await step('outputs', () => this.orphanOutputs(r));
    await step('executor_orphans', async () => {
      if (this.opts.cancelOrphans) await this.opts.cancelOrphans();
    });
    await step('disk', async () => {
      await this.ctx.disk.refresh();
    });
    this.ctx.metrics.inc('ffmpeg_cleanup_runs_total', 'Cleanup runs');
    if (
      r.expiredOutputs ||
      r.deletedJobs ||
      r.removedWorkspaces ||
      r.removedOutputDirs
    ) {
      this.ctx.log.info('cleanup.done', { ...r });
    }
    return r;
  }

  private async expireOutputs(r: CleanupReport): Promise<void> {
    const now = this.ctx.now();
    const rows = this.ctx.db.all<{ id: string }>(
      `SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= ?
         AND purged_at IS NULL AND status IN ('succeeded','failed')`,
      [now],
    );
    for (const { id } of rows) {
      // Сначала отзыв и статус (ссылки умирают сразу), затем файлы.
      this.ctx.db.tx(() => {
        revokeTokens(this.ctx.db, id);
        this.ctx.db.run(
          `UPDATE jobs SET status = 'failed', error_code = 'OUTPUT_EXPIRED',
             error_message = 'outputs have expired', updated_at = ?
           WHERE id = ? AND status = 'succeeded'`,
          [now, id],
        );
      });
      await safeRemove(
        this.ctx.cfg.outputsRoot,
        path.join(this.ctx.cfg.outputsRoot, id),
      );
      this.ctx.db.tx(() => {
        this.ctx.db.run(
          'UPDATE artifacts SET purged_at = COALESCE(purged_at, ?) WHERE job_id = ?',
          [now, id],
        );
        this.ctx.db.run(
          'UPDATE jobs SET purged_at = ?, payload_enc = NULL, updated_at = ? WHERE id = ?',
          [now, now, id],
        );
        this.ctx.db.run(
          'UPDATE idempotency_keys SET tombstone = 1 WHERE job_id = ?',
          [id],
        );
        addEvent(this.ctx.db, id, 'job.outputs_expired', {}, now);
      });
      r.expiredOutputs++;
      this.ctx.metrics.inc(
        'ffmpeg_outputs_expired_total',
        'Outputs removed by TTL',
      );
    }
  }

  private dropTerminalPayloads(): void {
    this.ctx.db.run(
      `UPDATE jobs SET payload_enc = NULL
       WHERE payload_enc IS NOT NULL AND status IN ('succeeded','failed','canceled')`,
    );
  }

  private dropTokens(r: CleanupReport): void {
    // Истёкшие ссылки: строка нужна только чтобы ответить 410, а не 404.
    r.deletedTokens = this.ctx.db.run(
      'DELETE FROM download_tokens WHERE expires_at < ?',
      [this.ctx.now() - DAY],
    ).changes;
  }

  private dropHistory(r: CleanupReport): void {
    const now = this.ctx.now();
    const histCut = now - this.ctx.cfg.retention.historyDays * DAY;
    const keyCut = now - this.ctx.cfg.retention.tombstoneDays * DAY;
    this.ctx.db.tx(() => {
      const ids = this.ctx.db
        .all<{ id: string }>(
          `SELECT id FROM jobs WHERE status IN ('succeeded','failed','canceled')
             AND finished_at IS NOT NULL AND finished_at < ? LIMIT 1000`,
          [histCut],
        )
        .map((x) => x.id);
      for (const id of ids) {
        // Ключ, переживший историю, не должен вести в пустоту: удаляем
        // ключи задачи вместе с ней, но не раньше срока tombstone.
        const keyAlive = this.ctx.db.get(
          'SELECT 1 FROM idempotency_keys WHERE job_id = ? AND created_at >= ?',
          [id, keyCut],
        );
        if (keyAlive) continue;
        this.ctx.db.run('DELETE FROM idempotency_keys WHERE job_id = ?', [id]);
        this.ctx.db.run('DELETE FROM download_tokens WHERE job_id = ?', [id]);
        this.ctx.db.run('DELETE FROM artifacts WHERE job_id = ?', [id]);
        this.ctx.db.run('DELETE FROM attempts WHERE job_id = ?', [id]);
        this.ctx.db.run('DELETE FROM events WHERE job_id = ?', [id]);
        this.ctx.db.run('DELETE FROM jobs WHERE id = ?', [id]);
        r.deletedJobs++;
      }
      r.deletedKeys += this.ctx.db.run(
        `DELETE FROM idempotency_keys WHERE created_at < ?
           AND job_id NOT IN (SELECT id FROM jobs)`,
        [keyCut],
      ).changes;
      this.ctx.db.run('DELETE FROM events WHERE job_id IS NULL AND at < ?', [
        histCut,
      ]);
    });
  }

  private async orphanWorkspaces(r: CleanupReport): Promise<void> {
    const root = this.ctx.cfg.workspaceRoot;
    const ageMs = this.opts.orphanAgeMs ?? 3_600_000;
    let names: string[];
    try {
      names = await fsp.readdir(root);
    } catch {
      return;
    }
    const active = this.ctx.activeJobId();
    for (const name of names) {
      if (!UUID_RE.test(name) || name === active) continue;
      const dir = path.join(root, name);
      const st = await fsp.lstat(dir).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      const job = this.ctx.db.get<{
        status: string;
        retry_inputs_from: string | null;
      }>('SELECT status, retry_inputs_from FROM jobs WHERE id = ?', [name]);
      const old = this.ctx.now() - st.mtimeMs > ageMs;
      let remove = false;
      if (!job) remove = old;
      else if (job.status === 'processing') remove = false;
      else if (job.status === 'queued') remove = !job.retry_inputs_from && old;
      else remove = true; // терминальная задача — workspace больше не нужен
      if (remove) {
        await safeRemove(root, dir);
        r.removedWorkspaces++;
        this.ctx.metrics.inc(
          'ffmpeg_orphan_workspaces_removed_total',
          'Orphan workspaces removed',
        );
      }
    }
  }

  private async orphanOutputs(r: CleanupReport): Promise<void> {
    const root = this.ctx.cfg.outputsRoot;
    const ageMs = this.opts.orphanAgeMs ?? 3_600_000;
    let names: string[];
    try {
      names = await fsp.readdir(root);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = path.join(root, name);
      const st = await fsp.lstat(dir).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      const old = this.ctx.now() - st.mtimeMs > ageMs;
      if (name.startsWith('.tmp-')) {
        const jobId = name.slice(5, 41);
        if (old && UUID_RE.test(jobId) && jobId !== this.ctx.activeJobId()) {
          await safeRemove(root, dir);
          r.removedOutputDirs++;
        }
        continue;
      }
      if (!UUID_RE.test(name)) continue;
      const job = this.ctx.db.get<{ status: string; purged_at: number | null }>(
        'SELECT status, purged_at FROM jobs WHERE id = ?',
        [name],
      );
      const remove = job
        ? job.purged_at !== null || (job.status !== 'succeeded' && old)
        : old;
      if (remove && name !== this.ctx.activeJobId()) {
        await safeRemove(root, dir);
        r.removedOutputDirs++;
      }
    }
  }
}
