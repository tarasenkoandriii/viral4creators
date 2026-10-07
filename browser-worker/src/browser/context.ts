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
 *  - отмена (heartbeat «отменить», стена времени, остановка воркера)
 *    закрывает контекст — висящие операции Playwright обрываются.
 */
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import {
  VIEWPORT_SIZE,
  WORKER_LIMITS,
  lockHostOf,
  type BrowserViewport,
} from '../shared/browser-job-protocol';
import {
  startEgressFilterProxy,
  type EgressFilterProxy,
  type EgressUpstream,
} from '../shared/egress-filter-proxy';
import { JobError } from '../errors';
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
      // Контекст могут закрыть посреди запроса (отмена задания) — ошибки
      // маршрута тогда не интересны и не должны ронять процесс.
      await this.decide(route).catch(() => undefined);
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
      const page = req.frame().page();
      const main =
        req.isNavigationRequest() && req.frame() === page.mainFrame();
      if (main && !this.allowedHosts.includes(lockHostOf(u))) {
        this.offhost = true;
        await route.abort('blockedbyclient');
        return;
      }
      if (main) this.requests = 0;
      this.requests += 1;
      if (this.requests > WORKER_LIMITS.requestsPerPage) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    }
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
    this.offhost = false;
    this.docCut.clear();
    const cut = new Promise<never>((_r, reject) => {
      this.onDocCut = () => reject(new JobError('traffic_limit'));
    });
    cut.catch(() => undefined);
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
      if (this.blocked() > before) throw new JobError('egress_blocked');
      const msg = e instanceof Error ? e.message : '';
      if (/Timeout/i.test(msg)) throw new JobError('nav_timeout');
      throw new JobError('nav_failed');
    } finally {
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
      throw new JobError(
        this.blocked() > before ? 'egress_blocked' : 'nav_failed',
      );
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
