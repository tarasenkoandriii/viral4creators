/**
 * GET /api/ready (ТЗ §5.4): SQLite доступна, миграции применены, executor
 * жив (свежий heartbeat), capability self-test пройден, диска достаточно.
 * Результат кешируется на короткое время — ready дергают часто.
 */
import type { ServerConfig } from '../config';
import type { DiskMonitor } from '../cleanup/disk';
import type { Db } from '../db/database';
import type { ExecutorPort } from '../queue/ports';

export interface ReadyChecks {
  sqlite: boolean;
  migrations: boolean;
  executor: boolean;
  capabilities: boolean;
  disk: boolean;
}

export interface ReadyResult {
  ready: boolean;
  checks: ReadyChecks;
  /** Конкретные причины отказа — коды, без внутренних путей. */
  reasons: string[];
  ffmpegVersion: string | null;
  checkedAt: number;
}

export class Readiness {
  private cached: ReadyResult | null = null;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly db: Db,
    private readonly executor: ExecutorPort,
    private readonly disk: DiskMonitor,
    private readonly cacheMs = 2000,
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async check(now = Date.now()): Promise<ReadyResult> {
    if (this.cached && now - this.cached.checkedAt < this.cacheMs) {
      return this.cached;
    }
    const reasons: string[] = [];
    const sqlite = this.db.ping();
    if (!sqlite) reasons.push('sqlite_unavailable');
    const migrations = sqlite && this.db.migrationsApplied();
    if (sqlite && !migrations) reasons.push('migrations_pending');

    let executor = false;
    let ffmpegVersion: string | null = null;
    try {
      const st = await this.executor.executorStatus(
        this.cfg.executor.heartbeatStaleSec * 1000,
      );
      executor = !!st?.fresh;
      ffmpegVersion = st?.heartbeat.ffmpegVersion ?? null;
      if (!st) reasons.push('executor_no_heartbeat');
      else if (!st.fresh) reasons.push('executor_heartbeat_stale');
    } catch {
      reasons.push('executor_status_error');
    }

    let capabilities = false;
    try {
      const caps = await this.executor.capabilities();
      if (!caps) reasons.push('capabilities_not_checked');
      else {
        const missing = [
          ...this.cfg.requiredFilters.filter((f) => !caps.filters.includes(f)),
          ...this.cfg.requiredEncoders.filter(
            (e) => !caps.encoders.includes(e),
          ),
        ];
        capabilities = caps.ok && missing.length === 0;
        if (!caps.ok) reasons.push('capabilities_failed');
        if (missing.length) reasons.push('capabilities_missing');
        ffmpegVersion = ffmpegVersion ?? caps.ffmpegVersion;
      }
    } catch {
      reasons.push('capabilities_error');
    }

    const d = this.disk.acceptsNew();
    if (!d.ok) reasons.push(d.reason ?? 'disk');

    const checks: ReadyChecks = {
      sqlite,
      migrations,
      executor,
      capabilities,
      disk: d.ok,
    };
    this.cached = {
      ready: Object.values(checks).every(Boolean),
      checks,
      reasons,
      ffmpegVersion,
      checkedAt: now,
    };
    return this.cached;
  }
}
