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
  navTimeoutMs: number;
  logger: Logger;
  launchBrowser: () => Promise<RelayBrowser>;
}

interface SessionTimers {
  wall: NodeJS.Timeout | null;
  /** Предупреждение за EXPIRY_WARNING_MS до потолка стены (этап 109). */
  wallWarn: NodeJS.Timeout | null;
  idleCheck: NodeJS.Timeout | null;
  eviction: NodeJS.Timeout | null;
}

/** За сколько до автозакрытия предупреждать клиента (§8.2, сообщение
 * `expiring`). 30 секунд — столько, чтобы человек успел дочитать SMS и
 * нажать «Готово, я вошёл», но не столько, чтобы предупреждение висело
 * половину сессии. */
const EXPIRY_WARNING_MS = 30_000;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly timers = new Map<string, SessionTimers>();
  /** Сколько браузеров уже запускается, но ещё не попало в `sessions` —
   * см. доккомментарий createSession(). */
  private pendingLaunches = 0;

  constructor(private readonly opts: SessionManagerOptions) {}

  get maxConcurrentSessions(): number {
    return this.opts.maxConcurrentSessions;
  }

  /** Только реально живые (не закрытые/не в кэше ожидания выселения) —
   * ровно то, что должно считаться в потолок MAX_CONCURRENT_SESSIONS.
   * Плюс уже начатые, но ещё не дошедшие до `Map` запуски (`pending`,
   * см. createSession) — иначе потолок держал бы только тех, кто уже
   * доехал. */
  get activeCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'created' || session.state === 'streaming') n++;
    }
    return n + this.pendingLaunches;
  }

  /**
   * Место под потолком занимается ДО запуска браузера и освобождается,
   * только если запуск не удался (найдено вторым проходом аудита этапа
   * 108). Раньше проверка `activeCount >= max` стояла перед
   * `await launchBrowser()`, который длится секунды: десять запросов,
   * пришедших в одно окно, все видели `activeCount === 0` и все десять
   * проходили проверку — потолок, существующий именно затем, чтобы
   * ограничить число одновременных Chromium в контейнере, на всплеске
   * не срабатывал вовсе (классический TOCTOU). Итог — OOM контейнера,
   * то есть смерть сессий ВСЕХ пользователей разом.
   */
  async createSession(
    startUrl: string,
    allowedOrigin: string,
  ): Promise<Session> {
    if (this.activeCount >= this.opts.maxConcurrentSessions) {
      throw new SessionLimitError('реле перегружено, попробуйте через минуту');
    }
    this.pendingLaunches++;
    try {
      return await this.launchAndRegister(startUrl, allowedOrigin);
    } finally {
      this.pendingLaunches--;
    }
  }

  private async launchAndRegister(
    startUrl: string,
    allowedOrigin: string,
  ): Promise<Session> {
    const browser = await this.opts.launchBrowser();
    // Утечка процесса Chromium (найдено аудитом этапа 108): браузер уже
    // запущен, а `Session.create()` (newPage + goto) падает штатно и
    // часто — чужой сайт недоступен, DNS не резолвится, навигация
    // истекла по таймауту. Без этого catch исключение улетало наверх
    // (502 клиенту), а запущенный процесс Chromium оставался жить
    // навсегда: в `this.sessions` он не попал, таймеров у него нет,
    // ссылок на него никто не держит. Каждая неудачная попытка входа
    // оставляла ~150–250 МБ, и контейнер реле уезжал в OOM после
    // нескольких десятков — притом что активных сессий по /health при
    // этом ноль.
    let session: Session;
    try {
      session = await Session.create({
        startUrl,
        allowedOrigin,
        browser,
        logger: this.opts.logger,
        navTimeoutMs: this.opts.navTimeoutMs,
      });
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw err;
    }
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
   * result-кэш (процесс всё равно завершается).
   *
   * `allSettled`, не `all` (найдено вторым проходом аудита этапа 108):
   * при `Promise.all` первая же упавшая `close()` (например, `ws.send`
   * в уже оборванное соединение) отклоняла общий промис — а вызывающий
   * в `main.ts` ждёт его в `Promise.race`, так что отклонение уводило
   * весь шатдаун в необработанное отклонение и `process.exit(0)` не
   * выполнялся вовсе: процесс висел до `SIGKILL` от Docker. То есть
   * одна неудачно закрытая сессия отменяла грейсфул-шатдаун для всех
   * остальных. */
  async shutdown(): Promise<void> {
    const pending = [...this.sessions.values()]
      .filter((s) => s.state !== 'closed')
      .map((s) => s.close('server-shutdown'));
    await Promise.allSettled(pending);
  }

  private armTimers(session: Session): void {
    // Предупреждение о близком потолке стены (этап 109) — человек
    // должен успеть нажать «Готово, я вошёл» до того, как сессия
    // закроется, а не узнать о закрытии постфактум. Порог не
    // настраивается переменной окружения сознательно: это часть
    // протокола (§8.2), а не параметр развёртывания.
    const wallWarnDelay = this.opts.wallTimeoutMs - EXPIRY_WARNING_MS;
    const wallWarn =
      wallWarnDelay > 0
        ? setTimeout(() => {
            const s = this.sessions.get(session.id);
            if (s && (s.state === 'created' || s.state === 'streaming')) {
              s.warnExpiring('wall-timeout', EXPIRY_WARNING_MS);
            }
          }, wallWarnDelay)
        : null;
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
        const idleFor = Date.now() - session.lastActivityAt;
        if (idleFor >= this.opts.idleTimeoutMs) {
          void this.expire(session.id, 'idle-timeout');
          return;
        }
        // Ожидание SMS-кода — штатная пауза без единого события ввода
        // (§7.4.0 основного ТЗ прямо называет одноразовый код одним из
        // трёх сценариев фичи), и отличить её от «вкладку забыли» реле
        // не может. Значит правильная реакция — не молчать до самого
        // закрытия, а предупредить (этап 109).
        const remaining = this.opts.idleTimeoutMs - idleFor;
        if (remaining <= EXPIRY_WARNING_MS) {
          session.warnExpiring('idle-timeout', remaining);
        }
      },
      Math.min(this.opts.idleTimeoutMs, 5000),
    );
    this.timers.set(session.id, { wall, wallWarn, idleCheck, eviction: null });
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

  /**
   * Заводит таймер выселения из памяти. Идемпотентен по СРОКУ (найдено
   * аудитом этапа 108): если выселение уже запланировано, повторный
   * вызов НЕ переносит его на новые `resultCacheMs` вперёд. Иначе
   * достаточно было дёргать `GET /sessions/:id/result` чаще раза в
   * минуту, чтобы запись (вместе с закэшированными куками реального
   * пользователя) жила в памяти процесса неограниченно долго — а окно
   * кэша §7.2 спеки задумано как «страховка от повторного запроса при
   * сетевом сбое», с фиксированным сроком от момента закрытия сессии,
   * не как продлеваемая аренда.
   */
  private scheduleEviction(id: string): void {
    this.clearActiveTimers(id);
    const existing = this.timers.get(id);
    // Уже запланировано — оставляем ИСХОДНЫЙ срок, см. доккомментарий.
    if (existing?.eviction) return;
    const eviction = setTimeout(() => {
      this.sessions.delete(id);
      this.timers.delete(id);
    }, this.opts.resultCacheMs);
    this.timers.set(id, {
      wall: null,
      wallWarn: null,
      idleCheck: null,
      eviction,
    });
  }

  /**
   * Снимает таймеры ЖИВОЙ сессии (wall/idle) — и только их.
   *
   * Выселяющий таймер тут намеренно НЕ трогается (поправлено вместе с
   * идемпотентностью `scheduleEviction` на этапе 108): он относится к
   * уже закрытой сессии и живёт по собственному сроку от момента
   * закрытия. Раньше этот метод гасил и его тоже — в паре с новым
   * «не переносить срок» это означало бы, что повторный
   * `GET /sessions/:id/result` СНИМАЕТ выселение и больше никогда его
   * не заводит, то есть запись зависает в памяти навсегда: ровно та
   * утечка, которую этап 102 уже закрывал в другом месте.
   */
  private clearActiveTimers(id: string): void {
    const t = this.timers.get(id);
    if (!t) return;
    if (t.wall) clearTimeout(t.wall);
    if (t.wallWarn) clearTimeout(t.wallWarn);
    if (t.idleCheck) clearInterval(t.idleCheck);
    this.timers.set(id, {
      wall: null,
      wallWarn: null,
      idleCheck: null,
      eviction: t.eviction,
    });
  }
}
