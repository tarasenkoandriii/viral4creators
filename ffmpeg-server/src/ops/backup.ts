/**
 * Консистентный online backup SQLite (ТЗ §13 «Нагрузка и эксплуатация»):
 * SQLite online backup API (`node:sqlite` backup), а не копия .db-файла в
 * WAL-режиме. Каждые 15 минут, хранение 7 дней; копия проверяется
 * `PRAGMA integrity_check`. Медиа и ключи в backup не входят (ключи —
 * отдельно, в secret store).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import type { Db } from '../db/database';
import type { Logger } from '../metrics/logger';
import { errorKind } from '../metrics/logger';
import type { Metrics } from '../metrics/metrics';

const NAME_RE = /^ffmpeg-server-(\d{8}T\d{6}Z)\.db$/;

export function backupName(now: number): string {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `ffmpeg-server-${iso}Z.db`;
}

/** Снять копию; вернуть путь. Битая копия удаляется и считается ошибкой. */
export async function runBackup(
  db: Db,
  dir: string,
  now = Date.now(),
): Promise<string> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const final = path.join(dir, backupName(now));
  const tmp = `${final}.partial`;
  for (const suf of ['', '-wal', '-shm', '-journal']) {
    await fsp.rm(tmp + suf, { force: true });
  }
  await backup(db.raw, tmp);
  // Копия — самодостаточный файл: без -wal/-shm рядом (journal DELETE).
  const check = new DatabaseSync(tmp);
  try {
    check.exec('PRAGMA journal_mode = DELETE');
    const r = check.prepare('PRAGMA integrity_check').get() as {
      integrity_check?: string;
    };
    if (r.integrity_check !== 'ok')
      throw new Error('backup integrity_check failed');
  } finally {
    check.close();
  }
  await fsp.rename(tmp, final);
  return final;
}

/** Удалить копии старше retention (только файлы нашего формата имени). */
export async function pruneBackups(
  dir: string,
  retentionDays: number,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    const m = NAME_RE.exec(n);
    if (!m) continue;
    const s = m[1];
    const at = Date.parse(
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
    );
    if (Number.isFinite(at) && now - at > retentionDays * 86_400_000) {
      await fsp.rm(path.join(dir, n), { force: true });
      removed++;
    }
  }
  return removed;
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  lastOkAt: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: {
      dir: string;
      intervalSec: number;
      retentionDays: number;
      log: Logger;
      metrics: Metrics;
      now: () => number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.run(),
      this.opts.intervalSec * 1000,
    );
    this.timer.unref?.();
    void this.run();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = this.opts.now();
      try {
        const file = await runBackup(this.db, this.opts.dir, now);
        const pruned = await pruneBackups(
          this.opts.dir,
          this.opts.retentionDays,
          now,
        );
        this.lastOkAt = now;
        this.opts.metrics.inc('ffmpeg_backup_total', 'SQLite backups', {
          result: 'ok',
        });
        this.opts.log.info('backup.done', {
          file: path.basename(file),
          pruned,
        });
      } catch (e) {
        this.opts.metrics.inc('ffmpeg_backup_total', 'SQLite backups', {
          result: 'error',
        });
        this.opts.log.error('backup.failed', { error: errorKind(e) });
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
