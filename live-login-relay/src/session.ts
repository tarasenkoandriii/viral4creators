/**
 * Одна live-сессия входа — один выделенный браузер, один Page, одна CDP-
 * сессия. Модель ресурса и протокол — doc/LIVE-LOGIN-RELAY-SPEC.md §5,
 * §8.
 *
 * Узкие интерфейсы `Relay*` ниже — НЕ полный `puppeteer-core`, а только
 * те методы, которые `Session` реально вызывает. Настоящий
 * `puppeteer-core` `Browser`/`Page` структурно им удовлетворяет (это
 * подмножество их публичного API), а в тестах (§14 спеки) подставляются
 * лёгкие моки без реального Chromium.
 */

import { randomUUID } from 'node:crypto';
import { generateStreamToken, verifyStreamToken } from './stream-token';
import type {
  CdpCookie,
  CloseReason,
  FrameMetadata,
  ServerMessage,
  SessionResult,
} from './types';
import type { Logger } from './logger';

export interface RelayFrame {
  url(): string;
}

export interface RelayCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: any) => void): void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface RelayPage {
  goto(url: string): Promise<unknown>;
  url(): string;
  target(): { createCDPSession(): Promise<RelayCdpSession> };
  on(event: 'framenavigated', handler: (frame: RelayFrame) => void): void;
  mainFrame(): RelayFrame;
  close(): Promise<void>;
}

export interface RelayBrowser {
  newPage(): Promise<RelayPage>;
  close(): Promise<void>;
}

/** Не просто «отправить кадр» — у WS-соединения, которое сессия
 * вытесняет (§8.1 п.3 спеки), нужно ещё и реально ЗАКРЫТЬ транспорт, не
 * только уведомить: иначе старая вкладка технически остаётся живым
 * WS-соединением и её ввод продолжал бы долетать до dispatchMouse/
 * dispatchKey наравне с новой (найдено этим аудитом). */
export interface WsChannel {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export class SessionAlreadyClosedError extends Error {}

export interface SessionCreateOptions {
  startUrl: string;
  allowedOrigin: string;
  browser: RelayBrowser;
  logger: Logger;
}

export class Session {
  readonly id = randomUUID();
  readonly allowedOrigin: string;
  readonly streamToken: string;
  readonly streamTokenHash: string;
  readonly createdAt = Date.now();

  state: 'created' | 'streaming' | 'finalizing' | 'closed' = 'created';
  lastActivityAt = Date.now();

  private readonly browser: RelayBrowser;
  private readonly logger: Logger;
  private page: RelayPage | null = null;
  private cdp: RelayCdpSession | null = null;
  private wsChannel: WsChannel | null = null;
  private cachedResult: SessionResult | null = null;
  private closedAt: number | null = null;
  private finalizingPromise: Promise<SessionResult> | null = null;

  private constructor(opts: {
    allowedOrigin: string;
    browser: RelayBrowser;
    logger: Logger;
  }) {
    this.allowedOrigin = opts.allowedOrigin;
    this.browser = opts.browser;
    this.logger = opts.logger;
    const pair = generateStreamToken();
    this.streamToken = pair.token;
    this.streamTokenHash = pair.hash;
  }

  /** Открывает страницу и переходит на startUrl — не запускает скринкаст
   * (это делает attachWs, §8.1: нет смысла слать кадры, пока никто не
   * подключился). */
  static async create(opts: SessionCreateOptions): Promise<Session> {
    const session = new Session({
      allowedOrigin: opts.allowedOrigin,
      browser: opts.browser,
      logger: opts.logger,
    });
    session.page = await opts.browser.newPage();
    await session.page.goto(opts.startUrl);
    return session;
  }

  verifyToken(presented: string): boolean {
    return verifyStreamToken(presented, this.streamTokenHash);
  }

  /** Только mouse/key считаются активностью для идл-таймаута (§8.3) —
   * вызывается ws-handler'ом отдельно, не на каждое WS-сообщение. */
  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** WS подключился и прошёл auth. Если уже было активное соединение —
   * вытесняет его: уведомляет (`closed:'superseded'`) И реально закрывает
   * транспорт (§8.1 п.3, найдено аудитом — иначе старое соединение
   * оставалось бы живым и продолжало бы слать mouse/key). Скринкаст
   * стартует только один раз — при первом подключении. */
  async attachWs(channel: WsChannel): Promise<void> {
    if (this.wsChannel && this.wsChannel !== channel) {
      const old = this.wsChannel;
      old.send({ type: 'closed', reason: 'superseded' });
      old.close(4009, 'superseded by new connection');
    }
    this.wsChannel = channel;
    if (this.state === 'created') {
      await this.startScreencast();
      this.state = 'streaming';
    }
  }

  detachWs(channel: WsChannel): void {
    if (this.wsChannel === channel) this.wsChannel = null;
  }

  private async startScreencast(): Promise<void> {
    if (!this.page) throw new Error('сессия не инициализирована');
    const cdp = await this.page.target().createCDPSession();
    this.cdp = cdp;

    cdp.on(
      'Page.screencastFrame',
      (params: {
        data: string;
        metadata: FrameMetadata;
        sessionId: number;
      }) => {
        this.wsChannel?.send({
          type: 'frame',
          data: params.data,
          metadata: params.metadata,
          frameAckId: params.sessionId,
        });
        cdp
          .send('Page.screencastFrameAck', { sessionId: params.sessionId })
          .catch((err) => {
            this.logger.warn('screencastFrameAck failed', {
              sessionId: this.id,
              error: String(err),
            });
          });
      },
    );

    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60 });

    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page!.mainFrame()) return;
      this.wsChannel?.send({ type: 'navigated', url: frame.url() });
    });
  }

  /** §9 основного ТЗ — реле НЕ блокирует/откатывает навигацию, только
   * ретранслирует ввод и информирует фронтенд через 'navigated'. */
  async dispatchMouse(params: {
    event: string;
    x: number;
    y: number;
    button?: string;
    deltaX?: number;
    deltaY?: number;
  }): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: params.event,
      x: params.x,
      y: params.y,
      button: params.button ?? 'left',
      clickCount: params.event === 'mousePressed' ? 1 : undefined,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
    });
  }

  async dispatchKey(params: {
    event: string;
    key: string;
    code: string;
    text?: string;
  }): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: params.event,
      key: params.key,
      code: params.code,
      text: params.text,
    });
  }

  async resize(width: number, height: number): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /**
   * `GET /sessions/:id/result` — снимает куки со всего контекста,
   * закрывает браузер, переводит в finalizing→closed. Идемпотентно
   * (§7.2 спеки): повторный вызов после завершения первого просто
   * возвращает cachedResult; ДВА ОДНОВРЕМЕННЫХ вызова (до того, как
   * первый успел закэшировать результат) дедуплицируются через
   * finalizingPromise — без этого второй параллельный вызов запустил бы
   * второй снимок кук/второе закрытие браузера поверх первого.
   *
   * Гонка с close() (найдено аудитом, §5 спеки): если сессию уже
   * ПРИНУДИТЕЛЬНО закрыли (таймаут/DELETE/shutdown) — close() успел
   * выставить state='closed' синхронно, ДО отдачи управления — то
   * finalize() не должен молча вернуть "успешный" результат с пустыми
   * куками поверх уже закрытого браузера: это ввело бы вызывающего в
   * заблуждение. Вместо этого — явная ошибка.
   */
  async finalize(): Promise<SessionResult> {
    if (this.cachedResult) return this.cachedResult;
    if (this.state === 'closed') {
      throw new SessionAlreadyClosedError(
        'сессия уже принудительно закрыта, финализация невозможна',
      );
    }
    if (this.finalizingPromise) return this.finalizingPromise;
    this.finalizingPromise = this.doFinalize();
    try {
      return await this.finalizingPromise;
    } finally {
      this.finalizingPromise = null;
    }
  }

  private async doFinalize(): Promise<SessionResult> {
    this.state = 'finalizing';
    let cookies: CdpCookie[] = [];
    if (this.cdp) {
      try {
        const res = (await this.cdp.send('Network.getAllCookies')) as {
          cookies: CdpCookie[];
        };
        cookies = res.cookies;
      } catch (err) {
        this.logger.warn('collecting cookies failed', {
          sessionId: this.id,
          error: String(err),
        });
      }
    }
    const finalUrl = this.page?.url() ?? '';
    this.wsChannel?.send({ type: 'closed', reason: 'finalized' });
    await this.closeBrowser();
    const result: SessionResult = { cookies, finalUrl };
    this.cachedResult = result;
    this.state = 'closed';
    this.closedAt = Date.now();
    return result;
  }

  /** Принудительное закрытие — таймауты/DELETE/shutdown, НЕ штатное
   * завершение (то делает finalize()). Идемпотентно.
   *
   * Гонка с finalize() (найдено аудитом): если finalize() уже в процессе
   * (finalizingPromise выставлен), close() не должен параллельно тоже
   * гасить браузер/страницу — closeBrowser() не рассчитан на конкурентный
   * вызов из двух мест и лучший случай тут — просто дождаться finalize()
   * и вернуться (сессия и так закрывается). А `state`/`closedAt`
   * выставляются СИНХРОННО, до первого await — иначе окно между входом в
   * close() и первым await оставляло бы state==='created'/'streaming' на
   * протяжении первого тика, и второй одновременный вызов close() (или
   * finalize(), см. его собственную проверку) мог бы проскочить эту
   * проверку и тоже начать закрывать браузер. */
  async close(reason: CloseReason): Promise<void> {
    if (this.state === 'closed') return;
    if (this.finalizingPromise) {
      await this.finalizingPromise.catch(() => undefined);
      return;
    }
    this.state = 'closed';
    this.closedAt = Date.now();
    this.wsChannel?.send({ type: 'closed', reason });
    await this.closeBrowser();
  }

  private async closeBrowser(): Promise<void> {
    try {
      await this.page?.close();
    } catch {
      /* best effort — страница могла уже упасть сама */
    }
    try {
      await this.browser.close();
    } catch {
      /* best effort — тот же довод */
    }
  }

  get closedAtMs(): number | null {
    return this.closedAt;
  }
}
