/**
 * Правила источников заданий браузерного воркера (Э-С Ш3) — кто ставит,
 * какой вид, сколько попыток, сколько живут строка и артефакты, для какого
 * назначения перепроверяется хост перед выдачей воркеру. Чистый модуль.
 */
import type { HostPurpose } from '../site-core/ownership/host-access';
import type { BrowserJobKind } from './protocol';

export const BROWSER_JOB_ORIGINS = [
  'voice-map-snapshot',
  'voice-map-check',
  'assist-admin-crawl',
  'tutorial-frames',
] as const;
export type BrowserJobOrigin = (typeof BROWSER_JOB_ORIGINS)[number];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface OriginRule {
  kind: BrowserJobKind;
  /** Назначение проверки хоста (L1 без льготы) — при постановке и при выдаче. */
  purpose: HostPurpose;
  /**
   * Попыток всего. Обход за логином — ОДНА: вход не повторяется
   * автоматически (QA-ТЗ §3.6 «1–2 попытки входа, без перебора»; §4.3
   * «active и Flow-QA не ретраятся автоматически»).
   */
  maxAttempts: number;
  /** Срок жизни строки задания и его артефактов. */
  ttlMs: number;
  /** Ожидающих/идущих заданий этого источника на сайт одновременно. */
  activePerSite: number;
  /** Заданий этого источника на сайт за сутки. */
  dailyPerSite: number;
  priority: number;
}

export const ORIGIN_RULES: Readonly<Record<BrowserJobOrigin, OriginRule>> = {
  // ТЗ §5-кватер.2: «скриншот публичной страницы … хранится 24 ч».
  'voice-map-snapshot': {
    kind: 'ui-snapshot',
    purpose: 'assist-crawl',
    maxAttempts: 2,
    ttlMs: DAY,
    activePerSite: 3,
    dailyPerSite: 60,
    priority: 10,
  },
  'voice-map-check': {
    kind: 'descriptor-resolve',
    purpose: 'assist-crawl',
    maxAttempts: 2,
    ttlMs: 7 * DAY,
    activePerSite: 1,
    dailyPerSite: 20,
    priority: 5,
  },
  'assist-admin-crawl': {
    kind: 'admin-crawl',
    purpose: 'assist-admin',
    maxAttempts: 1,
    ttlMs: 7 * DAY,
    activePerSite: 1,
    dailyPerSite: 6,
    priority: 0,
  },
  // Кадры обучалки — генератор забирает их ссылками и кладёт к себе; у
  // воркера они живут 3 суток (короче срока черновика, SECURITY §2.3).
  'tutorial-frames': {
    kind: 'frames-capture',
    purpose: 'tutorial',
    maxAttempts: 2,
    ttlMs: 3 * DAY,
    activePerSite: 3,
    dailyPerSite: 100,
    priority: 5,
  },
};

export function isBrowserJobOrigin(v: unknown): v is BrowserJobOrigin {
  return (
    typeof v === 'string' &&
    (BROWSER_JOB_ORIGINS as readonly string[]).includes(v)
  );
}

/** Одновременно идущих заданий на кабинет (справедливость между тенантами). */
export const RUNNING_PER_ACCOUNT = 2;

/** Пауза перед повтором: 30 с, 60 с, 120 с… (не больше 10 мин). */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000);
}

/** Ссылка на артефакт — не дольше 15 минут (и не дольше жизни артефакта). */
export const ARTIFACT_LINK_TTL_MS = 15 * 60 * 1000;

/** Хост в форме замка задания (`host` или `host:port`) и его origin. */
export function lockHostName(h: {
  host: string;
  scheme: string;
  port: number;
}): string {
  const def = h.scheme === 'https' ? 443 : 80;
  return h.port === def ? h.host : `${h.host}:${h.port}`;
}

export function hostOrigin(h: {
  host: string;
  scheme: string;
  port: number;
}): string {
  return `${h.scheme === 'http' ? 'http' : 'https'}://${lockHostName(h)}`;
}
