/**
 * Эффективный профиль лимитов (ТЗ §9, §13.1 «Лимиты и обслуживание»).
 * Хранится в SQLite с ревизией и историей; изменение — CAS по expected
 * revision и не выше верхних границ из env (FFMPEG_SERVER_LIMIT_*).
 * Профиль фиксируется в задаче при приёме (limits_revision) — изменения
 * касаются только новых задач.
 */
import type { LimitsProfile } from '../contracts';
import type { LimitsCeiling } from '../config';
import type { Db } from '../db/database';
import { addEvent } from '../db/jobs';

export class LimitsConflict extends Error {
  constructor(
    readonly reason: 'stale_revision' | 'invalid',
    message: string,
    readonly current: LimitsProfile,
  ) {
    super(message);
  }
}

export class LimitsService {
  constructor(
    private readonly db: Db,
    readonly ceiling: LimitsCeiling,
  ) {}

  init(now = Date.now()): LimitsProfile {
    const row = this.db.get<{ revision: number; profile: string }>(
      'SELECT revision, profile FROM limits WHERE id = 1',
    );
    if (!row) {
      const profile = JSON.stringify(this.ceiling);
      this.db.tx(() => {
        this.db.run(
          'INSERT INTO limits (id, revision, profile, updated_at) VALUES (1, 1, ?, ?)',
          [profile, now],
        );
        this.db.run(
          'INSERT INTO limits_history (revision, profile, changed_at, actor, reason) VALUES (1, ?, ?, ?, ?)',
          [profile, now, 'system', 'initial'],
        );
      });
    } else {
      // Верхние границы деплоя могли уменьшиться — эффективный профиль
      // не может их превышать: зажимаем и пишем новую ревизию как
      // системное изменение.
      const cur = JSON.parse(row.profile) as Partial<LimitsCeiling>;
      const clamped = this.clamp(cur);
      if (JSON.stringify(clamped) !== JSON.stringify(this.normalize(cur))) {
        this.write(clamped, row.revision, 'system', 'clamped_to_ceiling', now);
      }
    }
    return this.current();
  }

  current(): LimitsProfile {
    const row = this.db.get<{ revision: number; profile: string }>(
      'SELECT revision, profile FROM limits WHERE id = 1',
    );
    if (!row) throw new Error('limits не инициализированы');
    const p = this.clamp(JSON.parse(row.profile) as Partial<LimitsCeiling>);
    return { ...p, revision: row.revision };
  }

  /** Профиль, с которым принята задача (история хранит все ревизии). */
  atRevision(revision: number): LimitsProfile {
    const row = this.db.get<{ profile: string }>(
      'SELECT profile FROM limits_history WHERE revision = ?',
      [revision],
    );
    if (!row) return this.current();
    return {
      ...this.clamp(JSON.parse(row.profile) as Partial<LimitsCeiling>),
      revision,
    };
  }

  history(limit = 50): Array<{
    revision: number;
    profile: LimitsCeiling;
    changedAt: number;
    actor: string | null;
    reason: string | null;
  }> {
    return this.db
      .all<{
        revision: number;
        profile: string;
        changed_at: number;
        actor: string | null;
        reason: string | null;
      }>(
        'SELECT revision, profile, changed_at, actor, reason FROM limits_history ORDER BY revision DESC LIMIT ?',
        [limit],
      )
      .map((r) => ({
        revision: r.revision,
        profile: JSON.parse(r.profile) as LimitsCeiling,
        changedAt: r.changed_at,
        actor: r.actor,
        reason: r.reason,
      }));
  }

  update(
    expectedRevision: number,
    patch: Record<string, unknown>,
    actor: string,
    reason: string | null,
    now = Date.now(),
  ): LimitsProfile {
    return this.db.tx(() => {
      const cur = this.current();
      if (cur.revision !== expectedRevision) {
        throw new LimitsConflict('stale_revision', 'stale revision', cur);
      }
      const next: LimitsCeiling = { ...this.normalize(cur) };
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in this.ceiling)) {
          throw new LimitsConflict('invalid', `unknown limit ${k}`, cur);
        }
        const key = k as keyof LimitsCeiling;
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
          throw new LimitsConflict('invalid', `${k}: positive integer`, cur);
        }
        if (v > this.ceiling[key]) {
          throw new LimitsConflict(
            'invalid',
            `${k}: above deployment ceiling ${this.ceiling[key]}`,
            cur,
          );
        }
        next[key] = v;
      }
      this.write(next, cur.revision, actor, reason, now);
      return this.current();
    });
  }

  private write(
    profile: LimitsCeiling,
    prevRevision: number,
    actor: string,
    reason: string | null,
    now: number,
  ): void {
    const rev = prevRevision + 1;
    const json = JSON.stringify(profile);
    this.db.tx(() => {
      this.db.run(
        'UPDATE limits SET revision = ?, profile = ?, updated_at = ? WHERE id = 1',
        [rev, json, now],
      );
      this.db.run(
        'INSERT INTO limits_history (revision, profile, changed_at, actor, reason) VALUES (?, ?, ?, ?, ?)',
        [rev, json, now, actor, reason?.slice(0, 200) ?? null],
      );
      addEvent(this.db, null, 'limits.changed', { revision: rev, actor }, now);
    });
  }

  private normalize(p: Partial<LimitsCeiling>): LimitsCeiling {
    const out = { ...this.ceiling };
    for (const k of Object.keys(this.ceiling) as (keyof LimitsCeiling)[]) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  }

  private clamp(p: Partial<LimitsCeiling>): LimitsCeiling {
    const out = this.normalize(p);
    for (const k of Object.keys(this.ceiling) as (keyof LimitsCeiling)[]) {
      out[k] = Math.min(out[k], this.ceiling[k]);
    }
    return out;
  }
}
