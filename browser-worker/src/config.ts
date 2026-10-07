/**
 * Конфигурация браузерного воркера (Э-С Ш3) — одно место чтения env
 * (doc/DEPLOYMENT.md §6.25, browser-worker/.env.example).
 *
 * Отказ стартовать (ConfigError) — лучше, чем молча работать небезопасно:
 *  - нет адреса sites-backend или секрета ≥ 32 символов;
 *  - в production: адрес не https, песочница Chromium выключена, не задан
 *    `BROWSER_WORKER_EGRESS_DENY` (публичные адреса САМОГО сервера —
 *    общий список служебных диапазонов их не ловит), включены тестовые
 *    подмены DNS/TLS;
 *  - песочница включена, а процесс — root (Chromium с песочницей под root
 *    не стартует, а без песочницы под root эксплойт рендерера = root).
 */
import { hostname } from 'os';
import { isUsableSitesSecret } from './shared/sites-internal-signature';
import {
  BROWSER_JOB_KINDS,
  WORKER_ID_RE,
  WORKER_LIMITS,
  type BrowserJobKind,
} from './shared/browser-job-protocol';
import { derivePublicFromPrivate, isUsableSealKey } from './shared/worker-seal';
import { parseCidr, type EgressUpstream } from './shared/egress-filter-proxy';
import { DEFAULT_DRAIN_MAX_MS } from './browser/pool';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface WorkerConfig {
  production: boolean;
  sitesUrl: string;
  secret: string;
  /** Закрытый ключ конверта учёток; нет — обход «Админки» не берётся. */
  sealPrivateKey: string | null;
  sealPublicKey: string | null;
  workerId: string;
  concurrency: number;
  kinds: BrowserJobKind[];
  pollMs: number;
  idlePollMaxMs: number;
  chromiumPath: string | null;
  sandbox: boolean;
  egressDeny: string[];
  egressPorts: number[];
  upstream: EgressUpstream | null;
  rotateJobs: number;
  rotateMs: number;
  /** Потолок дренажа перед ротацией Chromium, мс (Ш3-хвост (16)). */
  drainMaxMs: number;
  /** Потолки байтов (Ш3-хвост (9)): тело ответа и весь трафик задания. */
  traffic: { responseBytes: number; jobBytes: number };
  healthFile: string;
  shutdownGraceMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Только NODE_ENV=test: подмена DNS прокси (`имя=IP,…`). */
  testDns: Map<string, string[]> | null;
  /** Только NODE_ENV=test: самоподписанный TLS стенда. */
  testIgnoreTls: boolean;
}

function int(
  env: NodeJS.ProcessEnv,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name}: целое от ${min} до ${max}`);
  }
  return n;
}

function parseUpstream(raw: string | undefined): EgressUpstream | null {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError('BROWSER_WORKER_UPSTREAM_PROXY_URL: не URL');
  }
  if (!['http:', 'https:', 'socks5:'].includes(u.protocol)) {
    throw new ConfigError(
      'BROWSER_WORKER_UPSTREAM_PROXY_URL: http(s) или socks5',
    );
  }
  return {
    protocol: u.protocol as EgressUpstream['protocol'],
    host: u.hostname,
    port:
      Number(u.port) ||
      (u.protocol === 'https:' ? 443 : u.protocol === 'socks5:' ? 1080 : 80),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

export function defaultWorkerId(): string {
  const h = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40);
  return `bw-${h || 'worker'}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const production = env.NODE_ENV === 'production';
  const test = env.NODE_ENV === 'test';
  const sitesUrlRaw = env.SITES_BACKEND_URL?.trim();
  if (!sitesUrlRaw) throw new ConfigError('SITES_BACKEND_URL не задан');
  let sitesUrl: URL;
  try {
    sitesUrl = new URL(sitesUrlRaw);
  } catch {
    throw new ConfigError('SITES_BACKEND_URL: не URL');
  }
  if (
    sitesUrl.protocol !== 'https:' &&
    (production || !['http:'].includes(sitesUrl.protocol))
  ) {
    throw new ConfigError('SITES_BACKEND_URL: в production — только https');
  }
  const secret = env.SITES_WORKER_HMAC_SECRET?.trim();
  if (!isUsableSitesSecret(secret)) {
    throw new ConfigError('SITES_WORKER_HMAC_SECRET не задан (≥ 32 символа)');
  }
  const sealRaw = env.BROWSER_WORKER_SEAL_PRIVATE_KEY?.trim();
  let sealPrivateKey: string | null = null;
  let sealPublicKey: string | null = null;
  if (sealRaw) {
    if (!isUsableSealKey(sealRaw)) {
      throw new ConfigError(
        'BROWSER_WORKER_SEAL_PRIVATE_KEY: base64url 32 байта (npm run seal-keygen)',
      );
    }
    sealPrivateKey = sealRaw;
    sealPublicKey = derivePublicFromPrivate(sealRaw);
  }
  const workerId = env.BROWSER_WORKER_ID?.trim() || defaultWorkerId();
  if (!WORKER_ID_RE.test(workerId)) {
    throw new ConfigError('BROWSER_WORKER_ID: [a-z0-9-], 3–63 символа');
  }
  let kinds = [...BROWSER_JOB_KINDS] as BrowserJobKind[];
  if (env.BROWSER_WORKER_KINDS?.trim()) {
    const want = env.BROWSER_WORKER_KINDS.split(',').map((s) => s.trim());
    const bad = want.filter(
      (k) => !(BROWSER_JOB_KINDS as readonly string[]).includes(k),
    );
    if (bad.length)
      throw new ConfigError(
        `BROWSER_WORKER_KINDS: неизвестно ${bad.join(', ')}`,
      );
    kinds = want as BrowserJobKind[];
  }
  // Без ключа конверта учётку не открыть — обход за логином не берём.
  if (!sealPrivateKey) kinds = kinds.filter((k) => k !== 'admin-crawl');
  const sandbox =
    (env.BROWSER_WORKER_SANDBOX ?? 'on').trim().toLowerCase() !== 'off';
  if (production && !sandbox) {
    throw new ConfigError(
      'BROWSER_WORKER_SANDBOX=off в production запрещён (К-2)',
    );
  }
  if (
    sandbox &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0
  ) {
    throw new ConfigError(
      'песочница Chromium требует не-root пользователя (USER в Dockerfile)',
    );
  }
  const egressDeny = (env.BROWSER_WORKER_EGRESS_DENY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of egressDeny) {
    try {
      parseCidr(c);
    } catch {
      throw new ConfigError(
        `BROWSER_WORKER_EGRESS_DENY: «${c}» — не адрес/подсеть`,
      );
    }
  }
  if (production && egressDeny.length === 0) {
    throw new ConfigError(
      'BROWSER_WORKER_EGRESS_DENY пуст: задайте публичные IPv4/IPv6 самого сервера (doc/DEPLOYMENT.md §6.25)',
    );
  }
  const egressPorts = (env.BROWSER_WORKER_EGRESS_ALLOWED_PORTS ?? '80,443')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);
  if (
    !egressPorts.length ||
    egressPorts.some((n) => !Number.isInteger(n) || n > 65535)
  ) {
    throw new ConfigError(
      'BROWSER_WORKER_EGRESS_ALLOWED_PORTS: порты через запятую',
    );
  }
  let testDns: Map<string, string[]> | null = null;
  if (env.BROWSER_WORKER_TEST_DNS?.trim()) {
    if (!test)
      throw new ConfigError('BROWSER_WORKER_TEST_DNS — только NODE_ENV=test');
    testDns = new Map();
    for (const pair of env.BROWSER_WORKER_TEST_DNS.split(',')) {
      const [name, ip] = pair.split('=').map((s) => s.trim());
      if (name && ip) testDns.set(name.toLowerCase(), [ip]);
    }
  }
  const testIgnoreTls = env.BROWSER_WORKER_TEST_IGNORE_TLS === '1';
  if (testIgnoreTls && !test) {
    throw new ConfigError(
      'BROWSER_WORKER_TEST_IGNORE_TLS — только NODE_ENV=test',
    );
  }
  const MB = 1024 * 1024;
  const responseMb = int(env, 'BROWSER_WORKER_MAX_RESPONSE_MB', 20, 1, 512);
  const jobMb = int(env, 'BROWSER_WORKER_MAX_JOB_TRAFFIC_MB', 150, 1, 4096);
  if (jobMb < responseMb) {
    throw new ConfigError(
      'BROWSER_WORKER_MAX_JOB_TRAFFIC_MB меньше BROWSER_WORKER_MAX_RESPONSE_MB',
    );
  }
  const level = (env.LOG_LEVEL ?? 'info').trim() as WorkerConfig['logLevel'];
  return {
    production,
    sitesUrl: sitesUrl.origin,
    secret: secret,
    sealPrivateKey,
    sealPublicKey,
    workerId,
    concurrency: int(
      env,
      'BROWSER_WORKER_CONCURRENCY',
      2,
      1,
      WORKER_LIMITS.claimMax,
    ),
    kinds,
    pollMs: int(env, 'BROWSER_WORKER_POLL_MS', 3000, 200, 60_000),
    idlePollMaxMs: int(
      env,
      'BROWSER_WORKER_IDLE_POLL_MAX_MS',
      30_000,
      200,
      300_000,
    ),
    chromiumPath: env.BROWSER_WORKER_CHROMIUM_PATH?.trim() || null,
    sandbox,
    egressDeny,
    egressPorts,
    upstream: parseUpstream(env.BROWSER_WORKER_UPSTREAM_PROXY_URL),
    rotateJobs: int(env, 'BROWSER_WORKER_ROTATE_JOBS', 50, 1, 10_000),
    rotateMs:
      int(env, 'BROWSER_WORKER_ROTATE_MINUTES', 30, 1, 24 * 60) * 60_000,
    drainMaxMs: int(
      env,
      'BROWSER_WORKER_DRAIN_MAX_MS',
      DEFAULT_DRAIN_MAX_MS,
      10_000,
      3_600_000,
    ),
    traffic: { responseBytes: responseMb * MB, jobBytes: jobMb * MB },
    healthFile:
      env.BROWSER_WORKER_HEALTH_FILE?.trim() || '/tmp/browser-worker.health',
    shutdownGraceMs: int(
      env,
      'BROWSER_WORKER_SHUTDOWN_GRACE_MS',
      25_000,
      1000,
      120_000,
    ),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level)
      ? level
      : 'info',
    testDns,
    testIgnoreTls,
  };
}
