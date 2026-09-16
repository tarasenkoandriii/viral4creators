/**
 * Оркестрация сессий: создание в пределах MAX_CONCURRENT_SESSIONS,
 * таймауты (wall/idle), кэш результата после закрытия, выселение из
 * памяти — doc/LIVE-LOGIN-RELAY-SPEC.md §5, §7.
 *
 * `launchBrowser` внедряется параметром конструктора именно затем,
 * чтобы этот класс был тестируем без реального Chromium (§14 спеки) —
 * тесты подставляют фейковый браузер, вся оркестрация состояний
 * проверяется без единого настоящего CDP-вызова.
 */

import { Session, type RelayBrowser } from './session';
import type { CloseReason, SessionResult } from './types';
import type { Logger } from './logger';

export class SessionLimitError extends Error {}
export class SessionNotFoundError extends Error {}
export class SessionNotReadyError extends Error {}

export interface SessionManagerOptions {
  maxConcurrentSessions: number;
  wallTimeoutMs: number;
  idleTimeoutMs: number;
  resultCacheMs: number;
  logger: Logger;
  launchBrowser: () => Promise<RelayBrowser>;
}

interface SessionTimers {
  wall: NodeJS.Timeout | null;
  idleCheck: NodeJS.Timeout | null;
  eviction: NodeJS.Timeout | null;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly timers = new Map<string, SessionTimers>();

  constructor(private readonly opts: SessionManagerOptions) {}

  get maxConcurrentSessions(): number {
    return this.opts.maxConcurrentSessions;
  }

  /** Только реально живые (не закрытые/не в кэше ожидания выселения) —
   * ровно то, что должно считаться в потолок MAX_CONCURRENT_SESSIONS. */
  get activeCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'created' || session.state === 'streaming') n++;
    }
    return n;
  }

  async createSession(
    startUrl: string,
    allowedOrigin: string,
  ): Promise<Session> {
    if (this.activeCount >= this.opts.maxConcurrentSessions) {
      throw new SessionLimitError('реле перегружено, попробуйте через минуту');
    }
    const browser = await this.opts.launchBrowser();
    const session = await Session.create({
      startUrl,
      allowedOrigin,
      browser,
      logger: this.opts.logger,
    });
    this.sessions.set(session.id, session);
    this.armTimers(session);
    this.opts.logger.info('session created', {
      sessionId: session.id,
      allowedOrigin,
    });
    return session;
  }

  getSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new SessionNotFoundError('unknown or expired session');
    }
    return session;
  }

  /** `GET /sessions/:id/result` (§7 спеки). 409, если сессия ещё
   * `created` (WS даже не успел подключиться) — вызывающий (backend) не
   * должен звать это раньше, чем пользователь реально нажал «Готово, я
   * вошёл». */
  async finalizeSession(id: string): Promise<SessionResult> {
    const session = this.getSession(id);
    if (session.state === 'created') {
      throw new SessionNotReadyError(
        'сессия ещё не готова (браузер запускается, WS не подключён)',
      );
    }
    this.clearActiveTimers(id);
    // try/finally, не голый await (найдено аудитом): если session.finalize()
    // бросит исключение (например SessionAlreadyClosedError из-за гонки с
    // close()), scheduleEviction() всё равно обязан отработать — иначе
    // сессия навсегда зависает в this.sessions, никогда не выселяется и
    // счётчик activeCount её тоже больше не учитывает как активную
    // (state==='closed'), то есть она просто течёт из памяти молча.
    try {
      return await session.finalize();
    } finally {
      this.scheduleEviction(id);
    }
  }

  /** `DELETE /sessions/:id` — best-effort, идемпотентно (§7.3 спеки):
   * несуществующая сессия — не ошибка. */
  async cancelSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.clearActiveTimers(id);
    try {
      await session.close('cancelled');
    } finally {
      this.scheduleEviction(id);
    }
  }

  /** SIGTERM — doc §13: закрывает все ещё не закрытые сессии, не ждёт
   * result-кэш (процесс всё равно завершается). */
  async shutdown(): Promise<void> {
    const pending = [...this.sessions.values()]
      .filter((s) => s.state !== 'closed')
      .map((s) => s.close('server-shutdown'));
    await Promise.all(pending);
  }

  private armTimers(session: Session): void {
    const wall = setTimeout(() => {
      void this.expire(session.id, 'wall-timeout');
    }, this.opts.wallTimeoutMs);
    // Полинг вместо «таймера, который сбрасывается на каждую
    // активность» — простой, достаточный для пилота приём: проверяем
    // раз в min(idleTimeoutMs, 5с), не истекла ли идл-пауза для СЕЙЧАС
    // стримящей сессии (state==='streaming' — сессия, ещё не дошедшая
    // до WS вообще, истекает только по wall-таймеру, не по этому).
    const idleCheck = setInterval(
      () => {
        if (session.state !== 'streaming') return;
        if (Date.now() - session.lastActivityAt >= this.opts.idleTimeoutMs) {
          void this.expire(session.id, 'idle-timeout');
        }
      },
      Math.min(this.opts.idleTimeoutMs, 5000),
    );
    this.timers.set(session.id, { wall, idleCheck, eviction: null });
  }

  private async expire(id: string, reason: CloseReason): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state === 'closed') return;
    this.opts.logger.info('session expiring', { sessionId: id, reason });
    this.clearActiveTimers(id);
    try {
      await session.close(reason);
    } finally {
      this.scheduleEviction(id);
    }
  }

  private scheduleEviction(id: string): void {
    this.clearActiveTimers(id);
    const eviction = setTimeout(() => {
      this.sessions.delete(id);
      this.timers.delete(id);
    }, this.opts.resultCacheMs);
    this.timers.set(id, { wall: null, idleCheck: null, eviction });
  }

  private clearActiveTimers(id: string): void {
    const t = this.timers.get(id);
    if (!t) return;
    if (t.wall) clearTimeout(t.wall);
    if (t.idleCheck) clearInterval(t.idleCheck);
    if (t.eviction) clearTimeout(t.eviction);
  }
}
