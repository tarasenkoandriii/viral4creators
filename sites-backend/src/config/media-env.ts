/**
 * Переменные окружения Э6 «видео-ответы и показать на экране» — ОДНО место
 * чтения (ТЗ помощника §4.11, §4.12; doc/DEPLOYMENT.md §6.15).
 *
 *  - ASSIST_VIDEO_HOSTS — где лежат ролики обучалки (Blob генератора):
 *    суффиксы хостов через запятую. Умолчание — публичный Vercel Blob
 *    (`.public.blob.vercel-storage.com`). Ролик с адресом на другом хосте
 *    внутренний API не принимает (закрытый отказ), а CSP iframe чата
 *    разрешает `media-src` ровно этим хостам. Стенды: `localhost`.
 *  - GENERATOR_TMA_URL — ссылка на Mini App генератора (`https://t.me/<бот>/app`)
 *    для кнопки «Снять новое обучение» экрана «Видео» TMA помощника:
 *    deep-link `?startapp=cst_<siteId>` открывает визард обучалки с
 *    привязкой к этому сайту. Нет — кнопка не показывается.
 *  - Ключ подписи ссылки на ролик — производный от ASSIST_SECRETS_KEY (как
 *    visitor-token и билет голоса, без нового секрета).
 *
 * Модуль в `config/` (не в модуле продукта): его берут и публичный код
 * виджета, и лист графа `internal-sites` (правило `internal-sites-scope`).
 */
import { createHmac } from 'crypto';
import { WIDGET_VIDEO_LINK_HMAC_LABEL } from '../brand';

export const VIDEO_HOSTS_DEFAULT = ['.public.blob.vercel-storage.com'];

/** Префикс deep-link обучалки генератора: `startapp=cst_<siteId>`. */
export const GENERATOR_SITE_TUTORIAL_START = 'cst_';

/** Суффиксы хостов роликов (нижний регистр; `.x` — поддомены x, `x` — сам x). */
export function videoHostSuffixes(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.ASSIST_VIDEO_HOSTS?.trim();
  if (!raw) return VIDEO_HOSTS_DEFAULT;
  const out = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^\.?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(s));
  return out.length ? out : VIDEO_HOSTS_DEFAULT;
}

function hostAllowed(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) =>
    s.startsWith('.') ? h.endsWith(s) && h.length > s.length : h === s,
  );
}

/**
 * Адрес ролика годится: https (http — только localhost стенда), без логина
 * в адресе, хост из ASSIST_VIDEO_HOSTS, ≤ 1000 символов.
 */
export function isAllowedVideoUrl(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): raw is string {
  if (typeof raw !== 'string' || raw.length > 1000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    return false;
  return hostAllowed(u.hostname, videoHostSuffixes(env));
}

/**
 * Источники CSP `media-src` iframe чата для роликов: `https://*.<суффикс>`
 * или `https://<хост>` (localhost стенда — `http://localhost:*`).
 */
export function videoMediaSources(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return videoHostSuffixes(env).map((s) => {
    if (s === 'localhost' || s === '127.0.0.1') return `http://${s}:*`;
    return s.startsWith('.') ? `https://*${s}` : `https://${s}`;
  });
}

/** Ключ подписи ссылки на ролик; null — ключа нет (виджет и так закрыт). */
export function videoLinkKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const key = env.ASSIST_SECRETS_KEY?.trim();
  if (!key) return null;
  return createHmac('sha256', key)
    .update(WIDGET_VIDEO_LINK_HMAC_LABEL)
    .digest();
}

/** Deep-link «Снять новое обучение» для сайта; null — генератор не задан. */
export function generatorTutorialLink(
  siteId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.GENERATOR_TMA_URL?.trim();
  if (!raw || !/^[A-Za-z0-9_-]{1,59}$/.test(siteId)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    u.searchParams.set('startapp', `${GENERATOR_SITE_TUTORIAL_START}${siteId}`);
    return u.toString();
  } catch {
    return null;
  }
}
