/**
 * AI Publisher, P-B1 — безопасный импорт URL источника (проектный документ
 * §0 п.5, §6.3, §11.3 `POST …/sources/import-url`; AT-CORE-22).
 *
 * Страница загружается ТОЛЬКО общим входом `site-crawl`
 * `PublicPageFetcher.fetchPage(url, {purpose:'publisher-import'})`:
 * нормализация (только https), SSRF-проверка адреса и IP-pin на каждом
 * хопе (`pinnedFetch`: внутренние/локальные адреса, DNS-rebinding,
 * редиректы на внутренний адрес или чужой origin), opt-out домена,
 * robots, лимит размера и времени, только HTML, noindex. Отказ —
 * 400 `PUB_IMPORT_BLOCKED {reason}` без записи. Сеть — ВНЕ транзакции
 * операции (§8.1); запись — потом, в `runOperation`.
 *
 * Сохранённый текст — `usage=restricted` до решения редактора (§11.3);
 * `detectInjection` помечает фрагмент (`injectionFlag`), но текст остаётся
 * недоверенными данными (§12.3).
 *
 * Причина отказа — честная (аудит P-B1 S3-1): не-https — `not_https`;
 * порт, логин/пароль, IP-литерал, одноуровневое имя — `ssrf` ДО сети;
 * `robots` из-за того, что сам robots.txt недоступен по SSRF (имя
 * резолвится во внутренний адрес), — `ssrf`; имя не резолвится — `timeout`.
 * Эти уточнения только меняют код причины: защита — в `pinnedFetch`.
 */
import {
  assertCrawlableUrl,
  DEFAULT_PINNED_HTTP_DEPS,
  resolveAndCheck,
  type PinnedHttpDeps,
} from '../../site-crawl/net/pinned-fetch';
import type { PublicPageFetcher } from '../../site-crawl/page-fetcher';
import type { CrawlCacheDb, SkipReason } from '../../site-crawl/types';
import { PubError } from '../core/errors';

export const IMPORT_FRAGMENT_MAX = 20_000;

/** Причины отказа импорта (§11.2 `PUB_IMPORT_BLOCKED`). */
export const IMPORT_BLOCK_REASONS = [
  'ssrf',
  'redirect_offsite',
  'not_https',
  'opted_out',
  'robots',
  'too_large',
  'not_html',
  'timeout',
  'http_4xx',
  'http_5xx',
  'empty',
  'spa',
  'noindex',
] as const;
export type ImportBlockReason = (typeof IMPORT_BLOCK_REASONS)[number];

export function importReasonOf(r: SkipReason | undefined): ImportBlockReason {
  return (IMPORT_BLOCK_REASONS as readonly string[]).includes(r ?? '')
    ? (r as ImportBlockReason)
    : 'empty';
}

export interface ImportedPage {
  url: string;
  title: string | null;
  language: string | null;
  fragment: string;
  truncated: boolean;
}

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/** Причина до сети: схема и форма адреса. `null` — проверка пройдена. */
export function preNetworkReason(url: string): ImportBlockReason | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'not_https';
  }
  if (u.protocol !== 'https:') return 'not_https';
  try {
    assertCrawlableUrl(u.toString());
  } catch {
    return 'ssrf';
  }
  return null;
}

/**
 * Уточнение `robots`/`ssrf` после отказа загрузчика: имя не резолвится →
 * `timeout`; `robots` из-за недоступного robots.txt при внутреннем адресе
 * → `ssrf`. Иначе причина загрузчика (rebinding/редирект — его `ssrf`).
 */
async function refineReason(
  reason: ImportBlockReason,
  url: string,
  lookupAll: PinnedHttpDeps['lookupAll'],
): Promise<ImportBlockReason> {
  const host = new URL(url.trim()).hostname;
  let list: Awaited<ReturnType<PinnedHttpDeps['lookupAll']>>;
  try {
    list = await lookupAll(host.replace(/\.$/, ''));
  } catch {
    return 'timeout';
  }
  if (!list || list.length === 0) return 'timeout';
  try {
    await resolveAndCheck(host, () => Promise.resolve(list));
  } catch {
    return 'ssrf';
  }
  return reason;
}

export async function fetchForImport(
  fetcher: Pick<PublicPageFetcher, 'fetchPage'>,
  db: CrawlCacheDb,
  url: string,
  net: Pick<PinnedHttpDeps, 'lookupAll'> = DEFAULT_PINNED_HTTP_DEPS,
): Promise<ImportedPage> {
  const pre = preNetworkReason(url);
  if (pre) throw new PubError('PUB_IMPORT_BLOCKED', { reason: pre });
  const r = await fetcher.fetchPage(url, { purpose: 'publisher-import', db });
  if (!r.ok) {
    let reason: ImportBlockReason = r.notModified
      ? 'empty'
      : importReasonOf(r.reason);
    if (reason === 'robots' || reason === 'ssrf') {
      reason = await refineReason(reason, url, net.lookupAll);
    }
    throw new PubError('PUB_IMPORT_BLOCKED', {
      reason,
      ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
    });
  }
  const text = r.page.text.trim();
  if (!text) throw new PubError('PUB_IMPORT_BLOCKED', { reason: 'empty' });
  const chars = [...text];
  const title = r.page.title
    ? [...r.page.title.trim()].slice(0, 300).join('')
    : null;
  return {
    url: r.page.url,
    title: title || null,
    language: r.page.lang && BCP47.test(r.page.lang) ? r.page.lang : null,
    fragment: chars.slice(0, IMPORT_FRAGMENT_MAX).join(''),
    truncated: chars.length > IMPORT_FRAGMENT_MAX,
  };
}
