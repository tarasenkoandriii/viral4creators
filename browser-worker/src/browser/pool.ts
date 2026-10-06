/**
 * Браузер воркера (Э-С Ш3): один долгоживущий Chromium (Playwright) с
 * ротацией и НОВЫМ контекстом на каждое задание.
 *
 *  - песочница Chromium ВКЛЮЧЕНА (`chromiumSandbox`), процесс не root —
 *    закрывает К-2: эксплойт рендерера остаётся в песочнице, а не в
 *    процессе со всеми секретами (у воркера и секретов почти нет: HMAC и
 *    ключ конверта, DSN нет вовсе);
 *  - на уровне браузера прокси — «чёрная дыра» (`127.0.0.1:9`, без
 *    неявного обхода loopback): фоновый трафик Chromium вне контекстов
 *    наружу не выходит; у контекста задания — СВОЙ фильтрующий прокси
 *    (`context.ts`);
 *  - ротация: после `rotateJobs` заданий или `rotateMs` браузер
 *    перезапускается, когда на нём не осталось контекстов (утечки памяти
 *    долгоживущего Chromium и «отравленный» процесс не копятся);
 *  - падение браузера (`disconnected`) — следующий `acquire` поднимает
 *    новый, идущие задания получают `browser_crashed` (повторяемый код).
 */
import { chromium, type Browser } from 'playwright-core';
import type { Logger } from '../logger';

export interface PoolOptions {
  executablePath: string | null;
  sandbox: boolean;
  rotateJobs: number;
  rotateMs: number;
  logger: Logger;
  now?: () => number;
}

/** Флаги поверх умолчаний Playwright: без фоновых сетевых служб Chromium. */
export const HARDENING_ARGS = [
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-quic',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-pings',
  '--metrics-recording-only',
  '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,InterestFeedContentSuggestions',
];

/**
 * Окружение Chromium — только безопасные переменные (аудит Ш3). Playwright
 * по умолчанию отдаёт браузеру ВЕСЬ `process.env`: HMAC-секрет и закрытый
 * ключ конверта учёток оказывались в окружении процесса браузера и
 * crashpad (а с ним — в его памяти и в минидампах). Браузеру они не нужны.
 */
const BROWSER_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
] as const;

export function browserEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of BROWSER_ENV_KEYS) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private launchedAt = 0;
  private jobsOnBrowser = 0;
  private active = 0;
  private closed = false;
  readonly now: () => number;

  constructor(private readonly o: PoolOptions) {
    this.now = o.now ?? Date.now;
  }

  get isUp(): boolean {
    return !!this.browser?.isConnected();
  }

  private due(): boolean {
    return (
      this.jobsOnBrowser >= this.o.rotateJobs ||
      this.now() - this.launchedAt >= this.o.rotateMs
    );
  }

  private async launch(): Promise<Browser> {
    const b = await chromium.launch({
      headless: true,
      executablePath: this.o.executablePath ?? undefined,
      chromiumSandbox: this.o.sandbox,
      args: HARDENING_ARGS,
      env: browserEnv(),
      timeout: 30_000,
    });
    b.on('disconnected', () => {
      if (this.browser === b) this.browser = null;
    });
    this.browser = b;
    this.launchedAt = this.now();
    this.jobsOnBrowser = 0;
    this.o.logger.info('браузер запущен', {
      sandbox: this.o.sandbox,
      version: b.version(),
    });
    return b;
  }

  /** Браузер под задание (ротация — только когда на старом нет контекстов). */
  async acquire(): Promise<Browser> {
    if (this.closed) throw new Error('пул браузера закрыт');
    if (this.browser?.isConnected() && this.due() && this.active === 0) {
      const old = this.browser;
      this.browser = null;
      await old.close().catch(() => undefined);
      this.o.logger.info('ротация браузера', { count: this.jobsOnBrowser });
    }
    let b = this.browser?.isConnected() ? this.browser : null;
    if (!b) {
      this.launching ??= this.launch().finally(() => {
        this.launching = null;
      });
      b = await this.launching;
    }
    this.active += 1;
    this.jobsOnBrowser += 1;
    return b;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  async close(): Promise<void> {
    this.closed = true;
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
  }
}
