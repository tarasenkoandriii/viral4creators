/**
 * demo-quality-queue.ts — правила очереди проверки качества демо
 * (doc/TUTORIAL-DEMO-QUALITY-SPEC.md, «Место в существующем кроне»).
 *
 * Чистые функции: ключ дедупликации, пауза повтора, классификация
 * ошибок, потолки бюджета и настройки из env. Сервис только применяет
 * их — правило проверяется тестами без базы и Gemini, а мутации в нём
 * ловятся этими тестами.
 */

import { createHash } from 'node:crypto';
import { GEMINI_MODEL } from '../../common/gemini-model';

/** Попыток на одну проверку: сеть, 429, 5xx, таймаут, упавший тик. */
export const MAX_ATTEMPTS = 3;
/** Первая пауза повтора; дальше вдвое (2 → 4 мин), не больше потолка. */
export const BACKOFF_BASE_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** Аренда захваченной проверки — дольше любого тика функции (300 с). */
export const LEASE_MS = 6 * 60_000;
/** Сколько ждать обработки файла Gemini (ACTIVE) с момента загрузки. */
export const WAIT_ACTIVE_TIMEOUT_MS = 10 * 60_000;
/** Ограниченный кусок работы за тик крона сборок. */
export const TICK_MAX_JOBS = 2;
export const TICK_BUDGET_MS = 60_000;
/** Анализ не начинается, если до конца бюджета меньше этого. */
export const MIN_ANALYZE_MS = 20_000;
/** Потолок одного вызова анализа. */
export const MAX_ANALYZE_MS = 55_000;
/** Запас до конца бюджета на запись результата и уборку. */
export const ANALYZE_MARGIN_MS = 5_000;
/** Файл Gemini живёт 48 ч; старше этого — загружаем заново. */
export const PROVIDER_FILE_TTL_MS = 40 * 60 * 60_000;

/** Ключ дедупликации: ролик + содержимое + рубрика + модель. */
export function demoQualityDedupeKey(
  assetId: string,
  contentSha: string,
  rubricVersion: string,
  modelId: string,
): string {
  return createHash('sha256')
    .update([assetId, contentSha, rubricVersion, modelId].join('|'))
    .digest('hex');
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Пауза перед попыткой номер `attempts + 1` (после `attempts` неудач). */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** Начало следующих суток UTC — окно, в котором бюджет открывается. */
export function nextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Временная ли ошибка: 408/429/5xx, обрыв сети, таймаут. Временную
 * повторяем с паузой (до `MAX_ATTEMPTS`), постоянную — сразу `error`.
 */
export function isTransientError(err: unknown): boolean {
  const e = err as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  } | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.status === 'number') {
    return e.status === 408 || e.status === 429 || e.status >= 500;
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const code = typeof e.code === 'string' ? e.code : '';
  if (
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
    ].includes(code)
  ) {
    return true;
  }
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return /fetch failed|network|socket hang up|timed? ?out|temporarily|unavailable|rate limit|resource_exhausted/.test(
    msg,
  );
}

export interface DemoQualityConfig {
  /** Флаг включения; по умолчанию ВЫКЛЮЧЕН (спецификация, «Приёмка» п.1). */
  enabled: boolean;
  model: string;
  /** Суточный денежный потолок, микродоллары. */
  dailyLimitMicroUsd: number;
  /** Суточный потолок минут проанализированного видео. */
  dailyVideoMs: number;
  /** Потолок «Проверить все одобренные» за одно нажатие. */
  backfillCap: number;
}

export const DEFAULT_DAILY_USD = 1;
export const DEFAULT_DAILY_VIDEO_MINUTES = 30;
export const DEFAULT_BACKFILL_CAP = 20;
export const MAX_BACKFILL_CAP = 100;

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readDemoQualityConfig(
  env: NodeJS.ProcessEnv = process.env,
): DemoQualityConfig {
  const flag = (env.TUTORIAL_DEMO_QUALITY_ENABLED ?? '').trim().toLowerCase();
  return {
    enabled: ['1', 'true', 'on', 'yes'].includes(flag),
    model: env.TUTORIAL_DEMO_QUALITY_MODEL?.trim() || GEMINI_MODEL,
    dailyLimitMicroUsd: Math.round(
      positiveNumber(env.TUTORIAL_DEMO_QUALITY_DAILY_USD, DEFAULT_DAILY_USD) *
        1_000_000,
    ),
    dailyVideoMs: Math.round(
      positiveNumber(
        env.TUTORIAL_DEMO_QUALITY_DAILY_VIDEO_MINUTES,
        DEFAULT_DAILY_VIDEO_MINUTES,
      ) * 60_000,
    ),
    backfillCap: Math.min(
      MAX_BACKFILL_CAP,
      Math.max(
        1,
        Math.floor(
          positiveNumber(
            env.TUTORIAL_DEMO_QUALITY_BACKFILL_CAP,
            DEFAULT_BACKFILL_CAP,
          ),
        ),
      ),
    ),
  };
}

export interface BudgetState {
  limitMicroUsd: number;
  spentMicroUsd: number;
  limitVideoMs: number;
  analyzedVideoMs: number;
}

/**
 * Можно ли начинать платную часть проверки ролика длиной `durationMs`.
 * Деньги — по журналу `AiUsage` за сутки; минуты — по уже
 * проанализированным за сутки проверкам (у модели без ставки деньги
 * не видны, минуты ограничивают её всё равно).
 */
export function budgetAllows(
  state: BudgetState,
  durationMs: number,
): { allowed: boolean; reason: string | null } {
  if (state.spentMicroUsd >= state.limitMicroUsd) {
    return {
      allowed: false,
      reason: `суточный потолок расходов $${(state.limitMicroUsd / 1e6).toFixed(2)} выбран`,
    };
  }
  if (state.analyzedVideoMs + Math.max(0, durationMs) > state.limitVideoMs) {
    return {
      allowed: false,
      reason: `суточный лимит ${Math.round(state.limitVideoMs / 60_000)} мин видео выбран`,
    };
  }
  return { allowed: true, reason: null };
}

/** Сколько дать одному вызову анализа из остатка бюджета тика;
 *  `null` — не начинать (не успеет). */
export function analyzeTimeoutMs(remainingMs: number): number | null {
  if (remainingMs < MIN_ANALYZE_MS) return null;
  return Math.min(MAX_ANALYZE_MS, remainingMs - ANALYZE_MARGIN_MS);
}
