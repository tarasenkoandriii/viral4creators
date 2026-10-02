/**
 * Одна публичная страница «как есть» — K1. Общий вход для крона обхода
 * (purpose `assist-crawl`, только verified-хосты — проверяет вызывающий:
 * SiteCrawlService через evaluateHostAccess) и песочницы (purpose
 * `assist-sandbox`, L0 — подтверждение не нужно).
 *
 * Порядок: normalizeCrawlUrl → opt-out домена (site_opt_out_domains по
 * хосту и родительским именам) → robots (RobotsService) → пауза к хосту →
 * pinnedFetch (без cookie! свой UA CRAWLER_USER_AGENT; условные
 * If-None-Match/If-Modified-Since) → Content-Type text/html →
 * X-Robots-Tag → extractPage → noindex → пусто/SPA → результат.
 * Пауза между запросами к одному хосту — в памяти инстанса
 * (minDelayMsPerHost и Crawl-delay robots — большее из двух).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CRAWLER_ROBOTS_TOKEN, CRAWLER_USER_AGENT } from '../../brand';
import { CRAWL_DEFAULTS } from '../../config/assist-defaults';
import { BodyTooLargeError } from '../../shared/external-url-guard';
import { optOutCandidates } from '../site-core/hosts/host-normalize';
import { extractPage, looksLikeSpaShell } from './extract/extractor';
import { extractUiElements } from './extract/ui-map';
import {
  PINNED_HTTP_DEPS,
  PinnedHttpDeps,
  RedirectOffsiteError,
  SsrfBlockedError,
  assertCrawlableUrl,
  pinnedFetch,
} from './net/pinned-fetch';
import { RobotsService } from './robots';
import type {
  CrawlCacheDb,
  FetchPageOptions,
  FetchPageResult,
  PinnedResponse,
} from './types';
import { normalizeCrawlUrl } from './url';

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/** Домен (или родитель) в списке отказов. Только колонка domain — GRANT assist_public. */
export async function isOptedOut(
  db: CrawlCacheDb,
  host: string,
): Promise<boolean> {
  const row = await db.siteOptOutDomain.findFirst({
    where: { domain: { in: optOutCandidates(host) } },
    select: { domain: true },
  });
  return row !== null;
}

/** X-Robots-Tag: `noindex`/`none` без UA или для нашего UA. */
export function headerNoindex(value: string | undefined): boolean {
  if (!value) return false;
  const ours = CRAWLER_ROBOTS_TOKEN.toLowerCase();
  for (const part of value.toLowerCase().split(/,(?=\s*[a-z0-9_-]+\s*:)/)) {
    const m = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/.exec(part);
    const ua =
      m && !/^(noindex|none|nofollow|all|index)$/.test(m[1]) ? m[1] : null;
    const rules = ua ? m![2] : part;
    if (ua && ua !== ours) continue;
    if (/\b(noindex|none)\b/.test(rules)) return true;
  }
  return false;
}

/** Кодировка: Content-Type, иначе `<meta charset>` в начале документа. */
export function decodeHtml(body: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 4096).toString('latin1');
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset ?? 'utf-8').toLowerCase()).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class PublicPageFetcher {
  /** Хост → когда можно следующий запрос (вежливость, §3.4 / лендинг §6.3). */
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(
    private readonly robots: RobotsService,
    @Optional()
    @Inject(PINNED_HTTP_DEPS)
    private readonly net: Partial<PinnedHttpDeps> = {},
  ) {}

  async fetchPage(
    url: string,
    opts: FetchPageOptions,
  ): Promise<FetchPageResult> {
    const normalized = normalizeCrawlUrl(url);
    if (!normalized) return { ok: false, reason: 'not_https' };
    let parsed: URL;
    try {
      parsed = assertCrawlableUrl(normalized);
    } catch {
      return { ok: false, reason: 'ssrf' };
    }
    if (await isOptedOut(opts.db, parsed.hostname)) {
      return { ok: false, reason: 'opted_out' };
    }
    const rules = await this.robots.rulesFor(parsed.origin, opts.db);
    if (!rules.isAllowed(normalized)) return { ok: false, reason: 'robots' };

    await this.politeDelay(
      parsed.hostname,
      Math.max(opts.minDelayMsPerHost ?? 0, rules.crawlDelayMs ?? 0),
    );

    const headers: Record<string, string> = {
      'user-agent': CRAWLER_USER_AGENT,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    };
    if (opts.conditional?.etag) {
      headers['if-none-match'] = opts.conditional.etag;
    }
    if (opts.conditional?.lastModified) {
      headers['if-modified-since'] = opts.conditional.lastModified;
    }

    let res: PinnedResponse;
    try {
      res = await pinnedFetch(
        normalized,
        {
          headers,
          maxBytes: CRAWL_DEFAULTS.maxHtmlBytes,
          timeoutMs: CRAWL_DEFAULTS.requestTimeoutMs,
          maxRedirects: CRAWL_DEFAULTS.maxRedirects,
          sameOrigin: true,
        },
        this.net,
      );
    } catch (e) {
      if (e instanceof SsrfBlockedError) return { ok: false, reason: 'ssrf' };
      if (e instanceof RedirectOffsiteError) {
        return { ok: false, reason: 'redirect_offsite' };
      }
      if (e instanceof BodyTooLargeError) {
        return { ok: false, reason: 'too_large' };
      }
      // Таймаут, обрыв, TLS — для владельца это «сайт не ответил».
      return { ok: false, reason: 'timeout' };
    }

    const status = res.status;
    if (status === 304) {
      return { ok: false, notModified: true, httpStatus: 304 };
    }
    // 3xx здесь — цепочка длиннее maxRedirects или без Location.
    if (status >= 300 && status < 400) {
      return { ok: false, reason: 'redirect_offsite', httpStatus: status };
    }
    if (status >= 500)
      return { ok: false, reason: 'http_5xx', httpStatus: status };
    // 429 «слишком часто» — временно, как 5xx: страница не пропала.
    if (status === 429)
      return { ok: false, reason: 'http_5xx', httpStatus: status };
    if (status >= 400)
      return { ok: false, reason: 'http_4xx', httpStatus: status };
    if (status < 200 || status >= 300) {
      return { ok: false, reason: 'http_4xx', httpStatus: status };
    }

    const ct = (res.headers['content-type'] ?? '').toLowerCase();
    const mime = ct.split(';')[0].trim();
    const sniffHtml =
      !mime && /^\s*</.test(res.body.subarray(0, 512).toString('latin1'));
    if (!HTML_TYPES.includes(mime) && !sniffHtml) {
      return { ok: false, reason: 'not_html', httpStatus: status };
    }
    if (headerNoindex(res.headers['x-robots-tag'])) {
      return { ok: false, reason: 'noindex', httpStatus: status };
    }

    const html = decodeHtml(res.body, ct);
    const finalUrl = normalizeCrawlUrl(res.url) ?? normalized;
    const page = extractPage(html, finalUrl);
    if (page.noindex)
      return { ok: false, reason: 'noindex', httpStatus: status };
    if (looksLikeSpaShell(html, page)) {
      return { ok: false, reason: 'spa', httpStatus: status };
    }
    if (!page.text) return { ok: false, reason: 'empty', httpStatus: status };
    // Э6: карта интерфейса — из того же HTML (сети не ходит, как extractor).
    page.uiElements = extractUiElements(html, finalUrl);

    return {
      ok: true,
      page,
      httpStatus: status,
      etag: res.headers.etag ?? null,
      lastModified: res.headers['last-modified'] ?? null,
    };
  }

  private async politeDelay(host: string, delayMs: number): Promise<void> {
    const now = Date.now();
    const at = this.nextAllowedAt.get(host) ?? 0;
    const wait = Math.max(0, at - now);
    this.nextAllowedAt.set(host, Math.max(now, at) + delayMs);
    if (this.nextAllowedAt.size > 10_000) this.nextAllowedAt.clear();
    if (wait > 0) await sleep(wait);
  }
}
