/**
 * Контекст задания (Э-С Ш3): чистый профиль на задание (без общих cookie,
 * хранилищ и кэша), свой фильтрующий прокси, замок хостов, потолки.
 *
 *  - egress — ТОЛЬКО через фильтрующий прокси Ш0 (`shared/egress-filter-proxy`,
 *    копия backend): резолв один раз и подключение на проверенный IP
 *    (DNS-rebinding), служебные/частные адреса, метаданные облака,
 *    адреса самого сервера (`BROWSER_WORKER_EGRESS_DENY`), порты кроме
 *    разрешённых — отказ; подресурсы, XHR, iframe, WebSocket — тоже через
 *    него; прокси свой у каждого задания — его счётчики честно говорят,
 *    что заблокировано в ЭТОМ задании;
 *  - замок: переход главного фрейма на хост вне замка задания — обрыв
 *    (`offhost_redirect`), попапы закрываются, диалоги отклоняются,
 *    скачивания запрещены, сервис-воркеры заблокированы;
 *  - потолок подресурсов на страницу — дальше запросы обрываются;
 *  - потолок байтов (Ш3-хвост (9), `traffic-meter.ts`): весь трафик
 *    задания идёт через счётчик перед прокси — сверх `jobBytes` все
 *    соединения рвутся и задание обрывается (`traffic_limit`); тело ОДНОГО
 *    ответа сверх `responseBytes` (по событиям CDP — и сетевые, и
 *    распакованные байты, то есть и «gzip-бомба») — рвутся соединения
 *    этого хоста, ответ не дочитывается; если это был сам документ
 *    перехода — `traffic_limit`. Потолок ответа — по событиям браузера
 *    (тело внутри TLS-тоннеля прослойке не видно): на быстром канале
 *    документ успевает прийти дальше потолка, пока рендерер его разбирает;
 *    жёсткая граница байтов по сети — потолок задания. Счётчики —
 *    `traffic()`, в журнал задания;
 *  - «только чтение» (заход 11, `safety/write-guard.ts`): под сессией
 *    учётки (`sessionReadOnly`) — на всё задание, кроме окна шага входа
 *    (`loginStep`: запись — только хостам замка); у «Снимка» — на время
 *    раскрытий (`setReadOnly`). Запись — обрыв запроса, WebSocket под
 *    сессией — не соединяется, сообщения страницы вне окна входа не
 *    уходят; `Worker`/`SharedWorker` под сессией запрещены скриптом
 *    инициализации (SharedWorker сетью контекста не маршрутизируется, а
 *    WebSocket из воркера идёт мимо шлюза); редирект GET fetch/XHR/ping,
 *    картинки или документа, начатого страницей, воркер проходит сам по
 *    `Location` (`route.fetch`, `maxRedirects: 0`, ≤ 5 шагов; под сессией
 *    — на любом хосте, вся цепочка) — «выход» или действие через 302
 *    обрываются; cookie шага — из банки по адресу шага, `authorization` и
 *    `x-*` после смены origin снимаются; скрипты, стили и EventSource так
 *    не проверяются; счётчик по причинам — `writesBlocked()`, в журнал
 *    задания;
 *  - решение маршрута — «закрыто при сбое»: попап (запрос без доступного
 *    фрейма или из чужой страницы) и любая ошибка решения — обрыв
 *    (раньше ошибка глоталась, а закрытие попапа отпускало запрос);
 *  - отмена (heartbeat «отменить», стена времени, остановка воркера)
 *    закрывает контекст — висящие операции Playwright обрываются.
 */
import type {
  Browser,
  BrowserContext,
  Frame,
  Page,
  Request,
  Route,
  WebSocketRoute,
} from 'playwright-core';
import {
  VIEWPORT_SIZE,
  WORKER_LIMITS,
  WRITE_BLOCK_REASONS,
  lockHostOf,
  type BlockedWrites,
  type BrowserViewport,
  type WriteBlockReason,
} from '../shared/browser-job-protocol';
import {
  startEgressFilterProxy,
  type EgressFilterProxy,
  type EgressUpstream,
} from '../shared/egress-filter-proxy';
import { JobError } from '../errors';
import { WRITE_REFUSALS, writeRefusal } from '../safety/write-guard';
import {
  DEFAULT_TRAFFIC_LIMITS,
  authorityOfUrl,
  startTrafficMeter,
  type TrafficLimits,
  type TrafficMeter,
  type TrafficStats,
} from './traffic-meter';

export interface EgressOptions {
  denyCidrs: string[];
  allowedPorts: number[];
  upstream: EgressUpstream | null;
  /** Только тесты: подмена DNS прокси. */
  lookup?: (host: string) => Promise<string[]>;
  /** Только тесты: самоподписанный TLS стенда. */
  ignoreHttpsErrors?: boolean;
  /** Потолки байтов (по умолчанию `DEFAULT_TRAFFIC_LIMITS`). */
  traffic?: TrafficLimits;
}

/** Ответ в работе — для потолка тела (события CDP `Network.*`). */
interface InFlight {
  url: string;
  doc: boolean;
  decoded: number;
  encoded: number;
}

/**
 * Причины оборванной записи — журнал задания и `blockedWrites` результата
 * обхода (заход 13): список общий с sites-backend (протокол очереди), чтобы
 * сервер и TMA знали каждую причину. Причины стража — его подмножество
 * (проверка типов ниже; равенство списков — юнит-тест).
 */
export { WRITE_BLOCK_REASONS, type WriteBlockReason };
const REFUSALS_ARE_REASONS: readonly WriteBlockReason[] = WRITE_REFUSALS;
void REFUSALS_ARE_REASONS;

/** Потолок счётчика в результате — тот же, что у разбора протокола. */
export const BLOCKED_WRITES_MAX = 1_000_000;

/**
 * Счётчик стража → поле результата `blockedWrites` (только ненулевые).
 * Итог не больше `BLOCKED_WRITES_MAX` (аудит P3-6: иначе самопроверка
 * протокола уронила бы весь обход): причины усекаются по порядку, сумма
 * причин по-прежнему равна итогу.
 */
export function blockedWritesOf(
  w: Record<WriteBlockReason, number>,
): BlockedWrites {
  const reasons: BlockedWrites['reasons'] = {};
  let total = 0;
  for (const k of WRITE_BLOCK_REASONS) {
    const n = Math.min(
      Math.max(0, Math.floor(w[k] || 0)),
      BLOCKED_WRITES_MAX - total,
    );
    if (n > 0) {
      reasons[k] = n;
      total += n;
    }
  }
  return { total, reasons };
}

/** Виды GET, у которых редирект на хост замка проверяется по `Location`. */
const REDIRECT_CHECK_TYPES = new Set([
  'fetch',
  'xhr',
  'ping',
  'image',
  'document',
]);
/** Шагов редиректа, которые воркер проходит сам; дальше — обрыв. */
export const REDIRECT_MAX_HOPS = 5;

/**
 * Заголовки шага редиректа (заход 13, аудит P1-1): без `cookie` (её
 * добавит банка контекста по адресу шага) и сжатия; после смены origin —
 * и без `authorization`, `proxy-authorization`, пользовательских `x-*`.
 */
export function hopHeaders(
  h: Record<string, string>,
  crossOrigin: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const n = k.toLowerCase();
    if (n === 'cookie' || n === 'accept-encoding') continue;
    if (
      crossOrigin &&
      (n === 'authorization' ||
        n === 'proxy-authorization' ||
        n.startsWith('x-'))
    )
      continue;
    out[n] = v;
  }
  out['accept-encoding'] = 'identity';
  return out;
}
const REDIRECT_FETCH_MS = 20_000;

/**
 * Под сессией учётки — без `Worker`/`SharedWorker` (аудит P1-2): запросы
 * SharedWorker маршрут контекста не видит, WebSocket выделенного воркера
 * идёт мимо шлюза. Обходу интерфейса воркеры страницы не нужны;
 * свойство не перезаписать (`configurable: false`), в каждом фрейме.
 */
const DENY_WORKERS_SCRIPT = `(() => {
  for (const name of ['Worker', 'SharedWorker']) {
    const deny = function () {
      throw new DOMException(name + ' запрещён (только чтение)', 'SecurityError');
    };
    try {
      Object.defineProperty(globalThis, name, {
        value: deny,
        writable: false,
        configurable: false,
      });
    } catch (e) {}
  }
})();`;

interface CdpLike {
  on(event: string, fn: (e: never) => void): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export class JobBrowser {
  offhost = false;
  /** Документы главного фрейма (адреса без #), оборванные потолком ответа. */
  private readonly docCut = new Set<string>();
  /** Идущий `goto` узнаёт об обрыве своего документа сразу, а не по таймауту. */
  private onDocCut: (() => void) | null = null;
  private requests = 0;
  /** «Только чтение» (`write-guard.ts`). */
  private readOnly = false;
  /** Окно шага входа: запись разрешена хостам замка. */
  private loginWindow = false;
  /**
   * Адрес идущего перехода самого воркера (`goto`, без #) — его адрес уже
   * проверен; переход, начатый страницей во время `goto`, — нет (метка по
   * адресу, одноразовая — аудит P2-3).
   */
  private ownNavUrl: string | null = null;
  /** Страницы задания (`newPage`); запрос из любой другой — попап. */
  private readonly ownPages = new WeakSet<Page>();
  /**
   * Под сессией учётки (`sessionReadOnly`): шлюз WebSocket стоит, и страж
   * записи проверяет адрес и у пассивных видов (картинка — заход 13).
   */
  private wsGuarded = false;
  private readonly writeBlocks: Record<WriteBlockReason, number> = {
    method: 0,
    graphql: 0,
    logout: 0,
    danger: 0,
    passive: 0,
    websocket: 0,
    popup: 0,
  };

  private constructor(
    readonly context: BrowserContext,
    readonly proxy: EgressFilterProxy,
    readonly allowedHosts: readonly string[],
    readonly meter: TrafficMeter,
    private readonly limits: TrafficLimits,
  ) {}

  static async open(
    browser: Browser,
    allowedHosts: readonly string[],
    viewport: BrowserViewport,
    egress: EgressOptions,
    onTrafficLimit?: () => void,
  ): Promise<JobBrowser> {
    const limits = egress.traffic ?? DEFAULT_TRAFFIC_LIMITS;
    const proxy = await startEgressFilterProxy({
      denyCidrs: egress.denyCidrs,
      allowedPorts: egress.allowedPorts,
      upstream: egress.upstream,
      lookup: egress.lookup,
      maxConnections: 128,
    });
    let meter: TrafficMeter;
    try {
      meter = await startTrafficMeter({
        targetPort: proxy.port,
        jobBytes: limits.jobBytes,
        onJobLimit: onTrafficLimit,
      });
    } catch (e) {
      await proxy.close();
      throw e;
    }
    let context: BrowserContext;
    try {
      context = await browser.newContext({
        proxy: { server: meter.url, bypass: '<-loopback>' },
        viewport: VIEWPORT_SIZE[viewport],
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: viewport === 'mobile',
        acceptDownloads: false,
        serviceWorkers: 'block',
        bypassCSP: false,
        javaScriptEnabled: true,
        ignoreHTTPSErrors: egress.ignoreHttpsErrors === true,
        locale: 'uk-UA',
        permissions: [],
      });
    } catch (e) {
      await meter.close();
      await proxy.close();
      throw e;
    }
    const jb = new JobBrowser(context, proxy, allowedHosts, meter, limits);
    await jb.install();
    return jb;
  }

  private async install(): Promise<void> {
    this.context.on('page', (p) => {
      // Попап/новая вкладка — закрыть: задание работает в одной странице.
      if (this.context.pages().length > 1)
        void p.close().catch(() => undefined);
      p.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    });
    await this.context.route('**/*', async (route) => {
      // Закрыто при сбое (аудит P1-1): ошибка решения — обрыв, а не
      // «маршрут без решения» (его отпустило бы закрытие попапа). Контекст
      // могут закрыть посреди запроса (отмена задания) — тогда и обрыв
      // падает; это не должно ронять процесс.
      await this.decide(route).catch(() =>
        route.abort('blockedbyclient').catch(() => undefined),
      );
    });
  }

  private async decide(route: Route): Promise<void> {
    {
      const req = route.request();
      let u: URL;
      try {
        u = new URL(req.url());
      } catch {
        await route.abort('blockedbyclient');
        return;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        await route.abort('blockedbyclient');
        return;
      }
      // Попап (аудит P1-1): у навигации нового окна фрейма ещё нет
      // (`frame()` бросает), запрос из чужой страницы — тоже попап.
      // Попапы закрываются всё равно — их запросы не уходят никогда (ни
      // запись, ни переход на хост вне замка).
      let frame: Frame | null = null;
      let page: Page | null = null;
      try {
        frame = req.frame();
        page = frame.page();
      } catch {
        frame = null;
      }
      if (!frame || !page || !this.ownPages.has(page)) {
        if (this.readOnly) this.writeBlocks.popup += 1;
        await route.abort('blockedbyclient');
        return;
      }
      const main = req.isNavigationRequest() && frame === page.mainFrame();
      if (main && !this.allowedHosts.includes(lockHostOf(u))) {
        this.offhost = true;
        await route.abort('blockedbyclient');
        return;
      }
      if (main) this.requests = 0;
      const own = main && this.takeOwnNavigation(req, u);
      const inWindow = this.readOnly && this.writeWindow(u);
      // Документ входа уходит (отправка формы, переход после SPA-входа) —
      // окно закрыто сразу, в решении маршрута: загрузка дашборда — уже
      // только чтение (аудит P3-5; признак входа в `admin-crawl` приходит
      // позже, событием).
      if (inWindow && main) this.loginWindow = false;
      if (this.readOnly && !inWindow) {
        const why = writeRefusal({
          method: req.method(),
          url: req.url(),
          resourceType: req.resourceType(),
          ownNavigation: own,
          contentType: req.headers()['content-type'] ?? null,
          body: () => req.postData(),
          session: this.wsGuarded,
        });
        if (why) {
          this.writeBlocks[why] += 1;
          await route.abort('blockedbyclient');
          return;
        }
      }
      this.requests += 1;
      if (this.requests > WORKER_LIMITS.requestsPerPage) {
        await route.abort('blockedbyclient');
        return;
      }
      if (
        this.readOnly &&
        !this.loginWindow &&
        !own &&
        this.redirectChecked(req, u)
      ) {
        await this.fetchChecked(route, req, u, main);
        return;
      }
      await route.continue();
    }
  }

  /** Переход главного фрейма — тот, что начал `goto` (метка одноразовая). */
  private takeOwnNavigation(req: Request, u: URL): boolean {
    if (this.ownNavUrl === null || req.redirectedFrom()) return false;
    const k = new URL(u.toString());
    k.hash = '';
    if (k.toString() !== this.ownNavUrl) return false;
    this.ownNavUrl = null;
    return true;
  }

  /**
   * GET/HEAD fetch/XHR/ping, картинки или документа: под сессией учётки — на
   * ЛЮБОЙ хост (заход 13, аудит P2-1: цепочка «чужой хост → назад на хост
   * замка» тоже проверяется), у «Снимка» — на хосты замка.
   */
  private redirectChecked(req: Request, u: URL): boolean {
    const m = req.method().toUpperCase();
    return (
      (m === 'GET' || m === 'HEAD') &&
      REDIRECT_CHECK_TYPES.has(req.resourceType()) &&
      (this.wsGuarded || this.allowedHosts.includes(lockHostOf(u)))
    );
  }

  /**
   * Редирект — по `Location` (аудит P2-4): маршрут Playwright не видит
   * перенаправленных запросов, поэтому воркер проходит цепочку сам (тот же
   * прокси, `maxRedirects: 0`, ≤ 5 шагов — дальше обрыв); `Location`,
   * которому страж отказал бы как GET того же вида, — обрыв. Цепочка
   * проверяется целиком, в том числе шаги через хост вне замка и возврат с
   * него (заход 13, аудит P2-1).
   *
   * Заголовки шага — как у браузера (заход 13, аудит P1-1): `cookie` явно
   * не передаётся никогда — `route.fetch` берёт cookie из банки контекста
   * по адресу ШАГА (сессия хоста A не уходит ни на чужой хост, ни на хост
   * замка B); с первой смены origin снимаются `authorization`,
   * `proxy-authorization` и пользовательские `x-*` (CSRF-токены).
   * `identity` — без распаковки в процессе воркера (тело здесь целиком в
   * памяти).
   *
   * Итог: fetch/XHR/картинке — ответ конца цепочки. Документу (Р-З13-Г3) —
   * ОДИН редирект прямо на проверенный конечный адрес (адрес документа
   * должен остаться настоящим, а запрос по редиректу маршрут не видит —
   * промежуточные шаги браузеру не отдаются); цена — конечный адрес
   * запрашивается дважды, и второй запрос браузера уже не проверяется (см.
   * Р-З13-Г3, остаток). Конец цепочки главного фрейма вне замка — обрыв с
   * `offhost` (как прямой переход на чужой хост).
   */
  private async fetchChecked(
    route: Route,
    req: Request,
    u: URL,
    main: boolean,
  ): Promise<void> {
    const type = req.resourceType();
    const doc = type === 'document';
    let headers = hopHeaders(req.headers(), false);
    let crossed = false;
    let url = u.toString();
    let resp = await route.fetch({
      headers,
      maxRedirects: 0,
      timeout: REDIRECT_FETCH_MS,
    });
    for (let hop = 0; ; hop++) {
      const st = resp.status();
      const loc = resp.headers()['location'];
      if (st < 300 || st > 399 || !loc) break;
      let next: URL | null = null;
      try {
        next = new URL(loc, url);
      } catch {
        next = null;
      }
      const why =
        next && (next.protocol === 'http:' || next.protocol === 'https:')
          ? writeRefusal({
              method: 'GET',
              url: next.toString(),
              resourceType: type,
              ownNavigation: false,
              contentType: null,
              body: () => null,
              session: this.wsGuarded,
            })
          : 'danger';
      await resp.dispose().catch(() => undefined);
      if (why || !next) {
        this.writeBlocks[why ?? 'danger'] += 1;
        await route.abort('blockedbyclient');
        return;
      }
      if (hop + 1 >= REDIRECT_MAX_HOPS) {
        await route.abort('blockedbyclient');
        return;
      }
      url = next.toString();
      if (!crossed && next.origin !== u.origin) {
        crossed = true;
        headers = hopHeaders(req.headers(), true);
      }
      resp = await route.fetch({
        url,
        headers,
        maxRedirects: 0,
        timeout: REDIRECT_FETCH_MS,
      });
    }
    if (doc && url !== u.toString()) {
      await resp.dispose().catch(() => undefined);
      if (main && !this.allowedHosts.includes(lockHostOf(new URL(url)))) {
        this.offhost = true;
        await route.abort('blockedbyclient');
        return;
      }
      await this.redirectDocument(route, url);
      return;
    }
    await route.fulfill({ response: resp });
  }

  /** Документу — один редирект на проверенный адрес (браузер идёт сам). */
  private async redirectDocument(route: Route, to: string): Promise<void> {
    await route.fulfill({
      status: 302,
      headers: { location: to, 'cache-control': 'no-store' },
      body: '',
    });
  }

  /** Окно шага входа и адрес хоста замка — запись разрешена. */
  private writeWindow(u: URL): boolean {
    return this.loginWindow && this.allowedHosts.includes(lockHostOf(u));
  }

  /**
   * Под сессией учётки: только чтение до конца задания, WebSocket — через
   * шлюз. Вызывать ДО первой страницы (шлюз WebSocket — скрипт
   * инициализации: документы, открытые раньше, он не видит).
   */
  async sessionReadOnly(): Promise<void> {
    this.readOnly = true;
    if (this.wsGuarded) return;
    this.wsGuarded = true;
    await this.context.addInitScript({ content: DENY_WORKERS_SCRIPT });
    await this.context.routeWebSocket(
      () => true,
      (ws) => this.guardSocket(ws),
    );
  }

  /** «Снимок»: только чтение на время раскрытий (без cookie — без шлюза WS). */
  setReadOnly(on: boolean): void {
    this.readOnly = on;
  }

  /**
   * Шаг входа (Enter в поле пароля и ожидание признака входа): запись —
   * только хостам замка; закрывается вызывающим по признаку входа, а не
   * по затишью сети (запись дашборда после входа — уже вне окна).
   */
  async loginStep<T>(fn: () => Promise<T>): Promise<T> {
    this.loginWindow = true;
    try {
      return await fn();
    } finally {
      this.loginWindow = false;
    }
  }

  /** Оборванные записи по причинам и всего. */
  writesBlocked(): Record<WriteBlockReason, number> & { total: number } {
    const by = { ...this.writeBlocks };
    const total = WRITE_BLOCK_REASONS.reduce((a, k) => a + by[k], 0);
    return { ...by, total };
  }

  /**
   * WebSocket под сессией: вне окна входа не соединяется; соединение из
   * окна входа живёт, но сообщения страницы вне окна не уходят (по
   * сообщению не понять, чтение это или действие).
   */
  private guardSocket(ws: WebSocketRoute): void {
    let host: URL | null = null;
    try {
      host = new URL(ws.url());
    } catch {
      host = null;
    }
    const open = () =>
      !this.readOnly || (host !== null && this.writeWindow(host));
    if (!open()) {
      this.writeBlocks.websocket += 1;
      void ws.close({ code: 1008, reason: 'read-only' }).catch(() => undefined);
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (!open()) {
        this.writeBlocks.websocket += 1;
        return;
      }
      server.send(m);
    });
  }

  blocked(): number {
    const s = this.proxy.stats();
    return s['blocked-address'] + s['blocked-port'];
  }

  traffic(): TrafficStats {
    return this.meter.stats();
  }

  /** Потолок тела ответа: оборвать соединения хоста этого ответа. */
  private cut(f: InFlight): void {
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      return;
    }
    this.meter.cutAuthority(authorityOfUrl(u));
    if (f.doc) {
      u.hash = '';
      this.docCut.add(u.toString());
      this.onDocCut?.();
    }
  }

  /**
   * Размеры ответов страницы по CDP (своя сессия, отдельно от Playwright):
   * `Content-Length` сверх потолка — обрыв сразу, иначе — по мере прихода
   * данных (`dataReceived`: распакованные и сетевые байты).
   */
  async watchResponses(cdp: CdpLike): Promise<void> {
    const cap = this.limits.responseBytes;
    const live = new Map<string, InFlight>();
    // Главный фрейм — чтобы огромный документ iframe не ронял переход.
    let mainFrame: string | null = null;
    const over = (f: InFlight) => Math.max(f.decoded, f.encoded) > cap;
    cdp.on(
      'Network.responseReceived',
      (e: {
        requestId: string;
        type?: string;
        frameId?: string;
        response: { url: string; headers?: Record<string, string> };
      }) => {
        const f: InFlight = {
          url: e.response.url,
          doc:
            e.type === 'Document' &&
            (mainFrame === null || e.frameId === mainFrame),
          decoded: 0,
          encoded: 0,
        };
        live.set(e.requestId, f);
        const h = e.response.headers ?? {};
        const lenRaw = Object.entries(h).find(
          ([k]) => k.toLowerCase() === 'content-length',
        )?.[1];
        const len = Number(lenRaw);
        if (Number.isFinite(len) && len > cap) {
          live.delete(e.requestId);
          this.cut(f);
        }
      },
    );
    cdp.on(
      'Network.dataReceived',
      (e: {
        requestId: string;
        dataLength?: number;
        encodedDataLength?: number;
      }) => {
        const f = live.get(e.requestId);
        if (!f) return;
        f.decoded += e.dataLength ?? 0;
        f.encoded += e.encodedDataLength ?? 0;
        if (over(f)) {
          live.delete(e.requestId);
          this.cut(f);
        }
      },
    );
    const done = (e: { requestId: string }) => void live.delete(e.requestId);
    cdp.on('Network.loadingFinished', done);
    cdp.on('Network.loadingFailed', done);
    const tree = (await cdp.send('Page.getFrameTree').catch(() => null)) as {
      frameTree?: { frame?: { id?: string } };
    } | null;
    mainFrame = tree?.frameTree?.frame?.id ?? null;
    // Тела в буфер DevTools не копить: им пользуется только Playwright.
    await cdp
      .send('Network.enable', {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
      })
      .catch(() => cdp.send('Network.enable'));
  }

  async newPage(): Promise<Page> {
    const page = await this.context.newPage();
    this.ownPages.add(page);
    const cdp = await this.context.newCDPSession(page);
    await this.watchResponses(cdp as unknown as CdpLike);
    return page;
  }

  /**
   * Переход главной страницы с замком: заблокированный прокси адрес —
   * `egress_blocked`, увод на другой хост — `offhost_redirect`, таймаут —
   * `nav_timeout`, прочее — `nav_failed`. Ждёт `domcontentloaded` и затишье
   * сети (не дольше 5 с).
   */
  async goto(page: Page, url: string, timeoutMs = 25_000): Promise<void> {
    const before = this.blocked();
    // Переход, оборванный стражем записи (встроенный скрипт страницы
    // уводит на «выход» — аудит P2-3), оставляет страницу ошибки: это
    // «заблокировано», а не «сбой» — обход пропустит страницу, а не упадёт.
    const writesBefore = this.writesBlocked().total;
    const stopped = () =>
      this.blocked() > before || this.writesBlocked().total > writesBefore;
    this.offhost = false;
    this.docCut.clear();
    const cut = new Promise<never>((_r, reject) => {
      this.onDocCut = () => reject(new JobError('traffic_limit'));
    });
    cut.catch(() => undefined);
    try {
      const k = new URL(url);
      k.hash = '';
      this.ownNavUrl = k.toString();
    } catch {
      this.ownNavUrl = null;
    }
    try {
      const resp = await Promise.race([
        page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        }),
        cut,
      ]);
      if (!resp && this.blocked() > before)
        throw new JobError('egress_blocked');
    } catch (e) {
      if (e instanceof JobError) throw e;
      if (this.meter.exceeded || this.docCut.size)
        throw new JobError('traffic_limit');
      if (this.offhost) throw new JobError('offhost_redirect');
      if (stopped()) throw new JobError('egress_blocked');
      const msg = e instanceof Error ? e.message : '';
      if (/Timeout/i.test(msg)) throw new JobError('nav_timeout');
      throw new JobError('nav_failed');
    } finally {
      this.ownNavUrl = null;
      this.onDocCut = null;
    }
    await page
      .waitForLoadState('networkidle', { timeout: 5_000 })
      .catch(() => undefined);
    let final: URL;
    try {
      final = new URL(page.url());
    } catch {
      throw new JobError('nav_failed');
    }
    if (final.protocol !== 'http:' && final.protocol !== 'https:') {
      throw new JobError(stopped() ? 'egress_blocked' : 'nav_failed');
    }
    if (this.offhost || !this.allowedHosts.includes(lockHostOf(final))) {
      throw new JobError('offhost_redirect');
    }
    // Документ самой страницы недочитан (потолок ответа) — снимок был бы
    // по обрывку; потолок задания — тем более.
    final.hash = '';
    if (this.meter.exceeded || this.docCut.has(final.toString())) {
      throw new JobError('traffic_limit');
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.meter.close().catch(() => undefined);
    await this.proxy.close().catch(() => undefined);
  }
}
