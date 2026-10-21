/**
 * SQLite (node:sqlite): WAL, busy_timeout, миграции по PRAGMA user_version.
 * Один управляющий процесс (ТЗ §4); BEGIN IMMEDIATE — защита и от второго
 * процесса, случайно открывшего тот же файл.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, unknown>;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export class Db {
  readonly raw: DatabaseSync;
  /** БД создана с нуля при этом открытии (до миграций user_version = 0). */
  readonly wasFresh: boolean;
  private readonly cache = new Map<
    string,
    ReturnType<DatabaseSync['prepare']>
  >();
  private inTx = false;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = FULL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    const before = this.userVersion();
    this.wasFresh = before === 0;
    this.migrate();
  }

  userVersion(): number {
    const row = this.raw.prepare('PRAGMA user_version').get() as Row;
    return Number(row.user_version ?? 0);
  }

  get schemaVersion(): number {
    return MIGRATIONS.length;
  }

  migrationsApplied(): boolean {
    return this.userVersion() === MIGRATIONS.length;
  }

  private migrate(): void {
    const current = this.userVersion();
    if (current > MIGRATIONS.length) {
      throw new Error(
        `схема БД новее кода (${current} > ${MIGRATIONS.length}) — откат образа без отката БД`,
      );
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    const s = this.stmt(sql);
    return (Array.isArray(params) ? s.get(...params) : s.get(params)) as
      T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    const s = this.stmt(sql);
    return (Array.isArray(params) ? s.all(...params) : s.all(params)) as T[];
  }

  run(sql: string, params: Params = []): { changes: number } {
    const s = this.stmt(sql);
    const r = Array.isArray(params) ? s.run(...params) : s.run(params);
    return { changes: Number(r.changes) };
  }

  /** Транзакция BEGIN IMMEDIATE (запись блокируется сразу, без upgrade). */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  /** Проверка доступности для /api/ready. */
  ping(): boolean {
    try {
      this.raw.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.cache.clear();
    try {
      this.raw.close();
    } catch {
      /* уже закрыта */
    }
  }
}
