/**
 * Режим приёма/worker (ТЗ §5.4, §13 «восстановление SQLite»):
 *  - active   — приём и выдача задач worker;
 *  - paused   — приём есть, worker новые задачи не берёт;
 *  - drained  — нет ни приёма, ни выдачи; активная задача завершается;
 *  - recovery — БД потеряна/восстановлена из backup: приёма и выдачи нет
 *               до ручной сверки (resume с reconciled=true).
 *
 * Состояние атомарно хранится в SQLite и дублируется файлом-маркером рядом
 * с БД (tmp + fsync + rename). Маркер переживает потерю/замену файла БД,
 * поэтому при старте можно доказать «БД не та»:
 *  - БД создана с нуля, а маркер есть;
 *  - instance_id БД ≠ маркера (подложен другой файл);
 *  - в БД меньше задач/ревизий, чем видел маркер (restore из backup).
 * Во всех случаях режим — recovery.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import type { Db } from '../db/database';
import { addEvent } from '../db/jobs';
import type { Logger } from '../metrics/logger';

export type ControlMode = 'active' | 'paused' | 'drained' | 'recovery';

export interface ControlState {
  mode: ControlMode;
  revision: number;
  reason: string | null;
  updatedAt: number;
}

interface Marker {
  version: 1;
  instanceId: string;
  controlRevision: number;
  mode: ControlMode;
  jobSeq: number;
  updatedAt: number;
}

export type ControlAction = 'pause' | 'drain' | 'resume';

export class ControlConflict extends Error {
  constructor(
    readonly reason: 'stale_revision' | 'invalid_transition' | 'not_reconciled',
    readonly state: ControlState,
  ) {
    super(reason);
  }
}

export class ControlService {
  private instanceId = '';
  private jobSeqSeen = 0;

  constructor(
    private readonly db: Db,
    private readonly markerPath: string,
    private readonly log: Logger,
  ) {}

  /** Вызывается один раз при старте; возвращает итоговое состояние. */
  init(now = Date.now()): ControlState {
    const marker = this.readMarker();
    const meta = this.db.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'instance_id'",
    );
    const maxSeq = this.maxSeq();
    const row = this.db.get<{ revision: number }>(
      'SELECT revision FROM control_state WHERE id = 1',
    );
    let recoveryReason: string | null = null;
    if (marker) {
      if (!meta || this.db.wasFresh) recoveryReason = 'db_recreated';
      else if (meta.value !== marker.instanceId) recoveryReason = 'db_replaced';
      else if (maxSeq < marker.jobSeq) recoveryReason = 'db_behind_jobs';
      else if ((row?.revision ?? 0) < marker.controlRevision) {
        recoveryReason = 'db_behind_control';
      }
    }
    this.db.tx(() => {
      if (!meta) {
        this.instanceId = randomUUID();
        this.db.run("INSERT INTO meta (key, value) VALUES ('instance_id', ?)", [
          this.instanceId,
        ]);
      } else {
        // Подложенную БД принимаем как текущую, но только в recovery.
        this.instanceId = meta.value;
      }
      if (!row) {
        const rev = (marker?.controlRevision ?? 0) + 1;
        this.db.run(
          'INSERT INTO control_state (id, mode, revision, reason, updated_at) VALUES (1, ?, ?, ?, ?)',
          [recoveryReason ? 'recovery' : 'active', rev, recoveryReason, now],
        );
      } else if (recoveryReason) {
        const rev = Math.max(row.revision, marker?.controlRevision ?? 0) + 1;
        this.db.run(
          "UPDATE control_state SET mode = 'recovery', revision = ?, reason = ?, updated_at = ? WHERE id = 1",
          [rev, recoveryReason, now],
        );
      }
      if (recoveryReason) {
        addEvent(
          this.db,
          null,
          'control.recovery',
          { reason: recoveryReason },
          now,
        );
      }
    });
    this.jobSeqSeen = Math.max(maxSeq, marker?.jobSeq ?? 0);
    if (recoveryReason) {
      this.log.warn('control.recovery', { reason: recoveryReason });
    }
    this.writeMarker();
    return this.get();
  }

  get(): ControlState {
    const r = this.db.get<{
      mode: ControlMode;
      revision: number;
      reason: string | null;
      updated_at: number;
    }>(
      'SELECT mode, revision, reason, updated_at FROM control_state WHERE id = 1',
    );
    if (!r) throw new Error('control_state не инициализирован');
    return {
      mode: r.mode,
      revision: r.revision,
      reason: r.reason,
      updatedAt: r.updated_at,
    };
  }

  /** Приём новых задач разрешён режимом. */
  acceptsSubmits(): boolean {
    const m = this.get().mode;
    return m === 'active' || m === 'paused';
  }

  /** Worker может брать новые задачи. */
  dispatchAllowed(): boolean {
    return this.get().mode === 'active';
  }

  /**
   * Переход режима с CAS по ревизии (если передана). resume из recovery —
   * только с явным `reconciled` (оператор сверил executor и продуктовую БД).
   */
  apply(
    action: ControlAction,
    opts: {
      expectedRevision?: number;
      reason?: string;
      actor?: string;
      reconciled?: boolean;
    } = {},
    now = Date.now(),
  ): { state: ControlState; changed: boolean } {
    const result = this.db.tx(() => {
      const cur = this.get();
      if (
        opts.expectedRevision !== undefined &&
        opts.expectedRevision !== cur.revision
      ) {
        throw new ControlConflict('stale_revision', cur);
      }
      let next: ControlMode;
      if (action === 'pause') next = 'paused';
      else if (action === 'drain') next = 'drained';
      else next = 'active';
      if (cur.mode === 'recovery') {
        if (action !== 'resume')
          throw new ControlConflict('invalid_transition', cur);
        if (!opts.reconciled) throw new ControlConflict('not_reconciled', cur);
      }
      if (cur.mode === next) return { state: cur, changed: false };
      const reason = (opts.reason ?? action).slice(0, 200);
      this.db.run(
        'UPDATE control_state SET mode = ?, revision = revision + 1, reason = ?, updated_at = ? WHERE id = 1',
        [next, reason, now],
      );
      addEvent(
        this.db,
        null,
        `control.${action}`,
        {
          from: cur.mode,
          to: next,
          revision: cur.revision + 1,
          actor: opts.actor ?? null,
        },
        now,
      );
      return { state: this.get(), changed: true };
    });
    if (result.changed) {
      this.writeMarker();
      this.log.info('control.changed', {
        action,
        mode: result.state.mode,
        revision: result.state.revision,
        actor: opts.actor ?? null,
      });
    }
    return result;
  }

  /** После фиксации новой задачи: маркер помнит максимальный seq. */
  noteJobSeq(seq: number): void {
    if (seq > this.jobSeqSeen) {
      this.jobSeqSeen = seq;
      this.writeMarker();
    }
  }

  private maxSeq(): number {
    const r = this.db.get<{ s: number | null }>(
      'SELECT MAX(seq) AS s FROM jobs',
    );
    // sqlite_sequence помнит и удалённые (история 90 дней) задачи.
    const q = this.db.get<{ seq: number }>(
      "SELECT seq FROM sqlite_sequence WHERE name = 'jobs'",
    );
    return Math.max(Number(r?.s ?? 0), Number(q?.seq ?? 0));
  }

  private readMarker(): Marker | null {
    let raw: string;
    try {
      raw = readFileSync(this.markerPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      const m = JSON.parse(raw) as Marker;
      if (m.version === 1 && typeof m.instanceId === 'string') return m;
    } catch {
      /* битый маркер — ниже */
    }
    // Нечитаемый маркер — тоже повод не доверять БД без сверки.
    return {
      version: 1,
      instanceId: 'corrupt',
      controlRevision: 0,
      mode: 'recovery',
      jobSeq: 0,
      updatedAt: 0,
    };
  }

  private writeMarker(): void {
    const st = this.get();
    const m: Marker = {
      version: 1,
      instanceId: this.instanceId,
      controlRevision: st.revision,
      mode: st.mode,
      jobSeq: this.jobSeqSeen,
      updatedAt: Date.now(),
    };
    const tmp = `${this.markerPath}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(m));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.markerPath);
  }
}
