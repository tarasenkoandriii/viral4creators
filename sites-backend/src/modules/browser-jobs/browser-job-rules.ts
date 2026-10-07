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
  // Ш3-хвост (3): раунд исследователя обучалки. `tutorial-explore` — вход
  // учёткой реестра (режим A: хост кабинета подтверждён, секреты — арендой
  // воркера); `tutorial-explore-open` — всё остальное, в т.ч. режим B
  // (решение владельца «B ничего не блокирует»): без хоста кабинета, замок
  // — ТОЧНЫЕ хосты черновика, лимиты — на человека и на хост.
  'tutorial-explore',
  'tutorial-explore-open',
] as const;
export type BrowserJobOrigin = (typeof BROWSER_JOB_ORIGINS)[number];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface OriginRule {
  kind: BrowserJobKind;
  /**
   * Назначение проверки хоста (L1 без льготы) — при постановке и при выдаче.
   * `null` — задание без хоста кабинета (`tutorial-explore-open`, режим B):
   * ставится только `enqueueOpen`, хост не перепроверяется.
   */
  purpose: HostPurpose | null;
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
  // Раунд обучалки — человек ждёт ответа: высший приоритет, одна попытка
  // (повтор нажал бы кнопку на сайте второй раз), срок — сутки (кадр и
  // элементы генератор забирает сразу; остаток — для разбора отказов).
  'tutorial-explore': {
    kind: 'tutorial-explore',
    purpose: 'tutorial',
    maxAttempts: 1,
    ttlMs: DAY,
    activePerSite: 3,
    dailyPerSite: 300,
    priority: 20,
  },
  'tutorial-explore-open': {
    kind: 'tutorial-explore',
    purpose: null,
    maxAttempts: 1,
    ttlMs: DAY,
    // Для open «сайт» — человек (см. OPEN_LIMITS): ключ лимитов другой.
    activePerSite: 2,
    dailyPerSite: 300,
    priority: 20,
  },
};

/**
 * Лимиты заданий без хоста кабинета (`tutorial-explore-open`): на человека
 * (`subject` генератора) и на хост сайта — воркер не превращается в
 * бесплатный «браузер по запросу» против чужого сайта. Сверх суточного
 * лимита раундов генератора (его `usage`), а не вместо него.
 */
export const OPEN_LIMITS = {
  activePerSubject: 2,
  dailyPerSubject: 300,
  activePerHost: 6,
  dailyPerHost: 1500,
} as const;

/**
 * Ключ «кабинета» заданий без кабинета: `gen-<subject>` (у кабинетов —
 * cuid без дефиса). По нему считаются справедливость выдачи
 * (`RUNNING_PER_ACCOUNT`), лимиты человека и путь артефактов в Blob.
 * `subject` — непрозрачный ключ человека от генератора (`tg-<id>` или хеш).
 */
export const OPEN_ACCOUNT_PREFIX = 'gen-';
export const OPEN_SUBJECT_RE = /^[A-Za-z0-9_-]{1,56}$/;

export function openAccountId(subject: string): string {
  if (!OPEN_SUBJECT_RE.test(subject)) {
    throw new Error('browser-jobs: недопустимый subject задания без кабинета');
  }
  return `${OPEN_ACCOUNT_PREFIX}${subject}`;
}

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
