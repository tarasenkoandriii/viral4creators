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

export interface EgressOptions {
  denyCidrs: string[];
  allowedPorts: number[];
  upstream: EgressUpstream | null;
  /** Только тесты: подмена DNS прокси. */
  lookup?: (host: string) => Promise<string[]>;
  /** Только тесты: самоподписанный TLS стенда. */
  ignoreHttpsErrors?: boolean;
}

export class JobBrowser {
  offhost = false;
  private requests = 0;

  private constructor(
    readonly context: BrowserContext,
    readonly proxy: EgressFilterProxy,
    readonly allowedHosts: readonly string[],
  ) {}

  static async open(
    browser: Browser,
    allowedHosts: readonly string[],
    viewport: BrowserViewport,
    egress: EgressOptions,
  ): Promise<JobBrowser> {
    const proxy = await startEgressFilterProxy({
      denyCidrs: egress.denyCidrs,
      allowedPorts: egress.allowedPorts,
      upstream: egress.upstream,
      lookup: egress.lookup,
      maxConnections: 128,
    });
    let context: BrowserContext;
    try {
      context = await browser.newContext({
        proxy: { server: proxy.url, bypass: '<-loopback>' },
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
      await proxy.close();
      throw e;
    }
    const jb = new JobBrowser(context, proxy, allowedHosts);
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

  async newPage(): Promise<Page> {
    return this.context.newPage();
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
    try {
      const resp = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      if (!resp && this.blocked() > before)
        throw new JobError('egress_blocked');
    } catch (e) {
      if (e instanceof JobError) throw e;
      if (this.offhost) throw new JobError('offhost_redirect');
      if (this.blocked() > before) throw new JobError('egress_blocked');
      const msg = e instanceof Error ? e.message : '';
      if (/Timeout/i.test(msg)) throw new JobError('nav_timeout');
      throw new JobError('nav_failed');
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
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.proxy.close().catch(() => undefined);
  }
}
