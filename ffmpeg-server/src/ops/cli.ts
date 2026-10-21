/**
 * Операторская CLI для backup/restore drill (docs/OPERATIONS.md §3–4).
 * Запуск в контейнере api: `node dist/ops/cli.js <команда>`.
 *
 *   backup [dir]        — online backup сейчас (по умолчанию FFMPEG_SERVER_BACKUP_DIR)
 *   verify <file>       — integrity_check + счётчики (jobs, ключи идемпотентности)
 *   restore <file>      — ТОЛЬКО при остановленном api: подменить БД копией;
 *                         режим принудительно recovery — приём и выдача
 *                         задач заблокированы до сверки (resume reconciled)
 *
 * Секретов не печатает; ключи шифрования/HMAC в backup не входят.
 */
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config';
import { Db } from '../db/database';
import { runBackup } from './backup';

function out(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export async function cli(argv: string[], env = process.env): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === 'verify') {
    if (!arg) return usage();
    const db = new DatabaseSync(arg, { readOnly: true });
    try {
      const ic = db.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      const uv = db.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      const jobs = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as {
        n: number;
      };
      const keys = db
        .prepare('SELECT COUNT(*) AS n FROM idempotency_keys')
        .get() as { n: number };
      const last = db
        .prepare('SELECT MAX(created_at) AS t FROM jobs')
        .get() as { t: number | null };
      out({
        integrity: ic.integrity_check,
        schema_version: uv.user_version,
        jobs: jobs.n,
        idempotency_keys: keys.n,
        last_job_at: last.t ? new Date(last.t).toISOString() : null,
      });
      return ic.integrity_check === 'ok' ? 0 : 1;
    } finally {
      db.close();
    }
  }
  const cfg = loadConfig(env);
  if (cmd === 'backup') {
    const dir = arg ?? cfg.backup.dir;
    if (!dir) return usage();
    const db = new Db(cfg.dbPath);
    try {
      out({ backup: await runBackup(db, dir) });
      return 0;
    } finally {
      db.close();
    }
  }
  if (cmd === 'restore') {
    if (!arg || !existsSync(arg)) return usage();
    const tmp = `${cfg.dbPath}.restore`;
    copyFileSync(arg, tmp);
    const db = new DatabaseSync(tmp);
    try {
      const ic = db.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      if (ic.integrity_check !== 'ok') throw new Error('backup is corrupt');
      db.exec(
        `UPDATE control_state SET mode = 'recovery', reason = 'restored_from_backup',
           revision = revision + 1, updated_at = ${Date.now()} WHERE id = 1`,
      );
      db.exec(
        'INSERT INTO events (job_id, at, type, data) VALUES (NULL, ' +
          Date.now() +
          ", 'control.restored', NULL)",
      );
    } finally {
      db.close();
    }
    for (const suf of ['-wal', '-shm'])
      rmSync(cfg.dbPath + suf, { force: true });
    renameSync(tmp, cfg.dbPath);
    out({ restored: true, mode: 'recovery' });
    return 0;
  }
  return usage();
}

function usage(): number {
  process.stderr.write(
    'usage: cli.js backup [dir] | verify <file> | restore <file>\n',
  );
  return 2;
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`error: ${(e as Error)?.message ?? 'failed'}\n`);
      process.exit(1);
    });
}
