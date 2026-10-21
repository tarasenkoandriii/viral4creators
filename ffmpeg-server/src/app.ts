/**
 * Сборка процесса API: БД → режим/лимиты → диспетчер (recover) → HTTP →
 * очистка. Используется main.ts и интеграционными тестами (с фейковыми
 * или настоящими портами EXEC).
 */
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from './api/server';
import { Cleanup } from './cleanup/cleanup';
import { DiskMonitor } from './cleanup/disk';
import type { ServerConfig } from './config';
import type { Ctx } from './context';
import { ControlService } from './control/control';
import { LimitsService } from './control/limits';
import { Readiness } from './control/readiness';
import { Db } from './db/database';
import { type Logger, createLogger } from './metrics/logger';
import { Metrics } from './metrics/metrics';
import { BackupScheduler } from './ops/backup';
import { Dispatcher } from './queue/dispatcher';
import type { DownloadOpts, Ports } from './queue/ports';

export interface AppOptions {
  cfg: ServerConfig;
  ports: Ports;
  log?: Logger;
  now?: () => number;
  downloadExtra?: Partial<DownloadOpts> & Record<string, unknown>;
  /** Не запускать таймеры диспетчера/очистки (тесты дергают вручную). */
  manual?: boolean;
  readinessCacheMs?: number;
  orphanAgeMs?: number;
}

export interface App {
  ctx: Ctx;
  dispatcher: Dispatcher;
  cleanup: Cleanup;
  backups: BackupScheduler | null;
  server: Server;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const { cfg } = opts;
  for (const d of [cfg.dataDir, cfg.workspaceRoot, cfg.outputsRoot]) {
    mkdirSync(d, { recursive: true });
  }
  const log = opts.log ?? createLogger();
  const db = new Db(cfg.dbPath);
  const metrics = new Metrics();
  const control = new ControlService(db, cfg.controlMarkerPath, log);
  const limits = new LimitsService(db, cfg.limitsCeiling);
  const disk = new DiskMonitor(cfg);
  const readiness = new Readiness(
    cfg,
    db,
    opts.ports.executor,
    disk,
    opts.readinessCacheMs ?? 2000,
  );
  let dispatcher: Dispatcher | null = null;
  const ctx: Ctx = {
    cfg,
    db,
    log,
    metrics,
    control,
    limits,
    ports: opts.ports,
    disk,
    readiness,
    now: opts.now ?? Date.now,
    downloadExtra: opts.downloadExtra ?? {},
    kick: () => dispatcher?.kick(),
    activeJobId: () => dispatcher?.activeJobId() ?? null,
  };
  control.init(ctx.now());
  limits.init(ctx.now());
  dispatcher = new Dispatcher(ctx);
  const d = dispatcher;
  registerGauges(ctx, d);
  await disk.refresh();
  // recover в manual-режиме — синхронно; иначе — в фоне из start().
  if (opts.manual) await d.recover();
  const backups = cfg.backup.dir
    ? new BackupScheduler(db, {
        dir: cfg.backup.dir,
        intervalSec: cfg.backup.intervalSec,
        retentionDays: cfg.backup.retentionDays,
        log,
        metrics,
        now: ctx.now,
      })
    : null;
  if (backups) {
    metrics.gauge(
      'ffmpeg_backup_age_seconds',
      'Seconds since last good backup (-1: none)',
      () => [
        [{}, backups.lastOkAt ? (ctx.now() - backups.lastOkAt) / 1000 : -1],
      ],
    );
  }
  const cleanup = new Cleanup(ctx, {
    orphanAgeMs: opts.orphanAgeMs,
    cancelOrphans: () => d.cancelOrphans(),
  });
  if (!opts.manual) {
    d.start();
    cleanup.start();
    backups?.start();
  }
  const server = createHttpServer(ctx, { activeJobId: () => d.activeJobId() });
  log.info('app.started', {
    mode: control.get().mode,
    limits_revision: limits.current().revision,
    schema_version: db.userVersion(),
  });
  return {
    ctx,
    dispatcher: d,
    cleanup,
    backups,
    server,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () =>
          resolve((server.address() as AddressInfo).port),
        );
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await d.stop();
      await cleanup.stop();
      await backups?.stop();
      db.close();
    },
  };
}

function registerGauges(ctx: Ctx, d: Dispatcher): void {
  const m = ctx.metrics;
  m.gauge('ffmpeg_queue_length', 'Jobs by status', () =>
    ctx.db
      .all<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','processing') GROUP BY status",
      )
      .map((r) => [{ status: r.status }, r.n]),
  );
  m.gauge(
    'ffmpeg_queue_oldest_age_seconds',
    'Age of the oldest queued job',
    () => {
      const r = ctx.db.get<{ c: number | null }>(
        "SELECT MIN(created_at) AS c FROM jobs WHERE status = 'queued'",
      );
      return [[{}, r?.c ? (ctx.now() - r.c) / 1000 : 0]];
    },
  );
  m.gauge('ffmpeg_slots_busy', 'Busy pipeline slots (max 1)', () => [
    [{}, d.activeJobId() ? 1 : 0],
  ]);
  m.gauge('ffmpeg_control_mode', 'Control mode (1 = current)', () => {
    const mode = ctx.control.get().mode;
    return (['active', 'paused', 'drained', 'recovery'] as const).map((x) => [
      { mode: x },
      x === mode ? 1 : 0,
    ]);
  });
  m.gauge('ffmpeg_disk_bytes', 'Disk usage snapshot', () => {
    const s = ctx.disk.snapshot;
    return [
      [{ kind: 'free' }, s.freeBytes ?? -1],
      [{ kind: 'workspaces' }, s.workspacesBytes],
      [{ kind: 'outputs' }, s.outputsBytes],
    ];
  });
  m.gauge('ffmpeg_limits_revision', 'Effective limits revision', () => [
    [{}, ctx.limits.current().revision],
  ]);
}
