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
 *  - «дренаж» (Ш3-хвост (16)): при непрерывной нагрузке идущих заданий
 *    всегда > 0 и ротация не наступала бы никогда. Пора ротировать — пул
 *    говорит `holdClaims()`: цикл воркера перестаёт брать новые задания,
 *    идущие доживают, последний `release` — новый `acquire` перезапускает
 *    браузер. Потолок ожидания `drainMaxMs`: не опустел за него (зависшее
 *    задание) — старый браузер уходит «в отставку» (закрывается, когда его
 *    последнее задание вернёт его), новые задания идут на свежий;
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
  /** Потолок дренажа перед ротацией, мс (по умолчанию `DEFAULT_DRAIN_MAX_MS`). */
  drainMaxMs?: number;
  logger: Logger;
  now?: () => number;
}

/**
 * Самое долгое задание (стена `admin-crawl`, 300 с) + запас на `fail`/
 * `complete`: дольше честное задание не живёт, значит дольше — зависшее.
 */
export const DEFAULT_DRAIN_MAX_MS = 360_000;

/**
 * Флаги поверх умолчаний Playwright: без фоновых сетевых служб Chromium.
 *
 * DNS (Ш3-хвост (18)): при прокси Chromium имя хоста отдаёт прокси, но
 * предсказатель сети (DNS-prefetch по ссылкам и `<link rel=dns-prefetch>`,
 * предсоединение) мог резолвить имена САМ, системным резолвером мимо
 * фильтра — утечка «какие сайты открывает воркер» и канал наружу по DNS.
 * `--dns-prefetch-disable` выключает предсказатель, а
 * `--host-resolver-rules` делает любой локальный резолв неудачным
 * (кроме 127.0.0.1 — там прокси задания): соединения через прокси имя
 * локально не резолвят, так что работе это не мешает.
 */
export const DNS_ARGS = [
  '--dns-prefetch-disable',
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
];

export const HARDENING_ARGS = [
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  ...DNS_ARGS,
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
  /** Идущие задания по браузерам (текущий и «в отставке»). */
  private readonly users = new Map<Browser, number>();
  /** Браузеры «в отставке»: закроются, когда вернут последнее задание. */
  private readonly retired = new Set<Browser>();
  private drainSince: number | null = null;
  private closed = false;
  readonly now: () => number;
  /** Счётчики ротаций — в журнал и здоровье. */
  rotations = 0;
  forcedRotations = 0;

  constructor(private readonly o: PoolOptions) {
    this.now = o.now ?? Date.now;
  }

  get isUp(): boolean {
    return !!this.browser?.isConnected();
  }

  /** Заданий сейчас на текущем браузере. */
  private get active(): number {
    return this.browser ? (this.users.get(this.browser) ?? 0) : 0;
  }

  private due(): boolean {
    return (
      this.jobsOnBrowser >= this.o.rotateJobs ||
      this.now() - this.launchedAt >= this.o.rotateMs
    );
  }

  private drainExpired(): boolean {
    return (
      this.drainSince !== null &&
      this.now() - this.drainSince >=
        (this.o.drainMaxMs ?? DEFAULT_DRAIN_MAX_MS)
    );
  }

  /** Идёт дренаж: пора ротировать, а на браузере ещё есть задания. */
  get draining(): boolean {
    return this.drainSince !== null;
  }

  /**
   * Не брать новых заданий: пора ротировать, старый браузер ещё занят и
   * потолок дренажа не вышел. Вызывается циклом воркера перед `claim`.
   */
  holdClaims(): boolean {
    if (this.closed || !this.browser?.isConnected() || !this.due()) {
      this.drainSince = null;
      return false;
    }
    if (this.active === 0) return false;
    this.drainSince ??= this.now();
    if (this.drainExpired()) return false;
    return true;
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
      this.retired.delete(b);
    });
    this.browser = b;
    this.launchedAt = this.now();
    this.jobsOnBrowser = 0;
    this.drainSince = null;
    this.o.logger.info('браузер запущен', {
      sandbox: this.o.sandbox,
      version: b.version(),
    });
    return b;
  }

  /** Старый браузер: закрыть сейчас (пуст) или «в отставку» (занят). */
  private rotate(forced: boolean): void {
    const old = this.browser!;
    const busy = this.active;
    this.browser = null;
    this.rotations += 1;
    if (busy > 0) {
      this.forcedRotations += 1;
      this.retired.add(old);
      this.o.logger.warn('ротация браузера: дренаж не уложился в потолок', {
        count: this.jobsOnBrowser,
        running: busy,
        ms: this.drainSince === null ? 0 : this.now() - this.drainSince,
      });
    } else {
      void old.close().catch(() => undefined);
      this.o.logger.info('ротация браузера', {
        count: this.jobsOnBrowser,
        forced,
      });
    }
    this.drainSince = null;
  }

  /**
   * Браузер под задание. Ротация — когда на старом нет заданий, либо
   * (дренаж не уложился в потолок) старый уходит в отставку.
   */
  async acquire(): Promise<Browser> {
    if (this.closed) throw new Error('пул браузера закрыт');
    if (this.browser?.isConnected() && this.due()) {
      if (this.active === 0) this.rotate(false);
      else {
        this.drainSince ??= this.now();
        if (this.drainExpired()) this.rotate(true);
      }
    }
    let b = this.browser?.isConnected() ? this.browser : null;
    if (!b) {
      this.launching ??= this.launch().finally(() => {
        this.launching = null;
      });
      b = await this.launching;
    }
    this.users.set(b, (this.users.get(b) ?? 0) + 1);
    this.jobsOnBrowser += 1;
    return b;
  }

  /** Задание вернуло браузер (тот, что выдал `acquire`). */
  release(b?: Browser): void {
    const key = b ?? this.browser;
    if (!key) return;
    const left = Math.max(0, (this.users.get(key) ?? 0) - 1);
    if (left > 0) {
      this.users.set(key, left);
      return;
    }
    this.users.delete(key);
    if (this.retired.delete(key)) {
      void key.close().catch(() => undefined);
      this.o.logger.info('браузер в отставке закрыт');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = [this.browser, ...this.retired].filter(
      (x): x is Browser => !!x,
    );
    this.browser = null;
    this.retired.clear();
    await Promise.all(all.map((b) => b.close().catch(() => undefined)));
  }
}
