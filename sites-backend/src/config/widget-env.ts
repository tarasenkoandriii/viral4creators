/**
 * Переменные окружения виджета Э2 — ОДНО место чтения (координатор Э2).
 * Агенты новых переменных не вводят: нужна — запрос координатору.
 *
 *  - ASSIST_WIDGET_ORIGIN — origin загрузчика/iframe/API виджета
 *    (`https://w.<домен>`, Vercel-проект `widget`); без неё — заглушка бренда
 *    (в проде это ошибка конфигурации — validateWidgetEnv).
 *  - ASSIST_WIDGET_ENABLED — аварийный рубильник платформы (§4.13 п.6):
 *    `false` — все виджеты отвечают формой заявки, модель не зовётся.
 *    Умолчание — включено (виджет и так требует ключ, публикацию и
 *    подтверждённый хост).
 *  - ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD — суточный потолок платформы на
 *    ответы всех сайтов (§4.5); мусор — умолчание, а не «без потолка».
 *  - ASSIST_PREVIEW_FRAME_ANCESTORS — кто может встроить iframe предпросмотра
 *    конфигуратора TMA (через запятую). Умолчание — origin ASSIST_TMA_URL,
 *    WEB_CABINET_ORIGINS и веб-клиенты Telegram (TMA в Telegram Web сама
 *    живёт во фрейме, а frame-ancestors проверяет ВСЮ цепочку предков).
 *  - Ключ HMAC visitor-token и соль ipHash виджета — производные от
 *    ASSIST_SECRETS_KEY (без нового секрета, как соль песочницы Э1).
 */
import { createHmac } from 'crypto';
import {
  WIDGET_IP_HASH_LABEL,
  WIDGET_ORIGIN_DEFAULT,
  WIDGET_TOKEN_HMAC_LABEL,
} from '../brand';
import { derivedKeys, secretsKeyringProblems } from '../common/secrets-keyring';
import { MICRO_USD, WIDGET_DEFAULTS } from './assist-defaults';

/** Веб-клиенты Telegram, внутри которых TMA открыта во фрейме. */
export const TELEGRAM_WEB_ORIGINS = ['https://web.telegram.org'] as const;

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => originOf(s))
    .filter((s): s is string => s !== null);
}

export function widgetOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return originOf(env.ASSIST_WIDGET_ORIGIN) ?? WIDGET_ORIGIN_DEFAULT;
}

export function widgetPlatformEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ASSIST_WIDGET_ENABLED?.trim().toLowerCase() !== 'false';
}

export function widgetPlatformDailyCapMicroUsd(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD;
  if (raw === undefined || raw.trim() === '') {
    return WIDGET_DEFAULTS.platformDailyCapMicroUsdDefault;
  }
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) {
    return WIDGET_DEFAULTS.platformDailyCapMicroUsdDefault;
  }
  return Math.round(usd * MICRO_USD);
}

export function previewFrameAncestors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = list(env.ASSIST_PREVIEW_FRAME_ANCESTORS);
  if (explicit.length) return explicit;
  const out = new Set<string>([
    ...list(env.ASSIST_TMA_URL),
    ...list(env.WEB_CABINET_ORIGINS),
    ...TELEGRAM_WEB_ORIGINS,
  ]);
  return [...out];
}

/** Производный ключ: HMAC(ASSIST_SECRETS_KEY, метка). null — ключа нет (виджет закрыт). */
function derived(env: NodeJS.ProcessEnv, label: string): Buffer | null {
  const key = env.ASSIST_SECRETS_KEY?.trim();
  if (!key) return null;
  return createHmac('sha256', key).update(label).digest();
}

/** Ключ подписи visitor-token (текущий ключ связки, №60). */
export function widgetTokenKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  return derivedKeys(env, WIDGET_TOKEN_HMAC_LABEL)?.currentKey ?? null;
}

/**
 * Ключи ПРОВЕРКИ visitor-token: текущий и прежние (`ASSIST_SECRETS_KEYS_OLD`,
 * №60) — токены, выданные до ротации, живут свои 24 ч.
 */
export function widgetTokenKeys(
  env: NodeJS.ProcessEnv = process.env,
): readonly Buffer[] | null {
  return derivedKeys(env, WIDGET_TOKEN_HMAC_LABEL)?.all ?? null;
}

/** Секрет суточной соли ipHash виджета (поверх — соль сайта, §6.4). */
export function widgetIpSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return derived(env, WIDGET_IP_HASH_LABEL)?.toString('hex') ?? null;
}

/** Прод без origin виджета или без ключа — ошибка конфигурации, а не тихая заглушка. */
export function widgetEnvProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (!originOf(env.ASSIST_WIDGET_ORIGIN)) {
    out.push('ASSIST_WIDGET_ORIGIN не задана или не https-origin');
  }
  if (!env.ASSIST_SECRETS_KEY?.trim()) {
    out.push('ASSIST_SECRETS_KEY не задана — visitor-token не подписать');
  }
  out.push(...secretsKeyringProblems(env));
  return out;
}
