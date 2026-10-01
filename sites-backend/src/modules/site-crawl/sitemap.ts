/**
 * Sitemap — K1: из robots (`Sitemap:`) и `/sitemap.xml`, индекс sitemap
 * рекурсивно (≤ CRAWL_DEFAULTS.maxSitemaps файлов), gzip — да (распаковка
 * с потолком размера: sitemap.xml.gz-бомба не раздует память); XML
 * разбирается htmlparser2 в xmlMode (не регулярками); текстовый sitemap
 * (URL построчно) — тоже. Только URL того же хоста и разрешённые robots.
 * `lastmod` задаёт ПОРЯДОК обхода, а не пропуск (§4-тер.2: он часто врёт).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Element } from 'domhandler';
import { findAll, getChildren, isTag, textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';
import { gunzipSync } from 'zlib';
import { CRAWLER_USER_AGENT } from '../../brand';
import { CRAWL_DEFAULTS } from '../../config/assist-defaults';
import {
  PINNED_HTTP_DEPS,
  PinnedHttpDeps,
  pinnedFetch,
} from './net/pinned-fetch';
import type { RobotsRules, SitemapEntry } from './types';
import { normalizeCrawlUrl } from './url';

/** Сколько URL собираем до сортировки (sitemap бывают на 50 000 строк). */
const COLLECT_FACTOR = 4;

/** `ns:loc` → `loc` (sitemap с префиксом пространства имён). */
function local(name: string): string {
  const i = name.indexOf(':');
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

function childText(el: Element, name: string): string | null {
  const c = getChildren(el).find(
    (n): n is Element => isTag(n) && local(n.name) === name,
  );
  return c ? textContent(c).trim() : null;
}

function parseLastmod(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ParsedSitemap {
  /** Дочерние sitemap (индекс). */
  sitemaps: string[];
  urls: Array<{ loc: string; lastmod: Date | null }>;
}

/** Разбор одного файла sitemap (чистая функция). */
export function parseSitemap(text: string): ParsedSitemap {
  const out: ParsedSitemap = { sitemaps: [], urls: [] };
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed.startsWith('<')) {
    // Текстовый sitemap: по URL в строке.
    for (const line of trimmed.split(/\r?\n/)) {
      const loc = line.trim();
      if (loc) out.urls.push({ loc, lastmod: null });
    }
    return out;
  }
  const doc = parseDocument(trimmed, { xmlMode: true, decodeEntities: true });
  for (const el of findAll(() => true, doc.children)) {
    const n = local(el.name);
    if (n === 'sitemap') {
      const loc = childText(el, 'loc');
      if (loc) out.sitemaps.push(loc);
    } else if (n === 'url') {
      const loc = childText(el, 'loc');
      if (loc) {
        out.urls.push({ loc, lastmod: parseLastmod(childText(el, 'lastmod')) });
      }
    }
  }
  return out;
}

function maybeGunzip(body: Buffer, maxBytes: number): Buffer | null {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return gunzipSync(body, { maxOutputLength: maxBytes });
    } catch {
      return null;
    }
  }
  return body;
}

@Injectable()
export class SitemapService {
  private readonly logger = new Logger(SitemapService.name);

  constructor(
    @Optional()
    @Inject(PINNED_HTTP_DEPS)
    private readonly net: Partial<PinnedHttpDeps> = {},
  ) {}

  async discover(
    origin: string,
    robots: RobotsRules,
    limit: number,
  ): Promise<SitemapEntry[]> {
    const base = new URL(origin);
    const sameHost = (u: string) => {
      try {
        const x = new URL(u);
        return x.protocol === 'https:' && x.host === base.host;
      } catch {
        return false;
      }
    };
    const queue: string[] = [];
    const queued = new Set<string>();
    const enqueue = (u: string) => {
      const n = normalizeCrawlUrl(u);
      if (n && sameHost(n) && !queued.has(n)) {
        queued.add(n);
        queue.push(n);
      }
    };
    robots.sitemaps.forEach(enqueue);
    enqueue(`${base.origin}/sitemap.xml`);

    const entries = new Map<string, Date | null>();
    const cap = Math.max(limit, 1) * COLLECT_FACTOR;
    let files = 0;
    while (
      queue.length > 0 &&
      files < CRAWL_DEFAULTS.maxSitemaps &&
      entries.size < cap
    ) {
      const url = queue.shift()!;
      files++;
      const parsed = await this.fetchOne(url);
      if (!parsed) continue;
      parsed.sitemaps.forEach(enqueue);
      for (const { loc, lastmod } of parsed.urls) {
        const n = normalizeCrawlUrl(loc);
        if (!n || !sameHost(n) || entries.has(n)) continue;
        if (!robots.isAllowed(n)) continue;
        entries.set(n, lastmod);
        if (entries.size >= cap) break;
      }
    }
    return [...entries.entries()]
      .map(([url, lastmod]) => ({ url, lastmod }))
      .sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0))
      .slice(0, limit);
  }

  private async fetchOne(url: string): Promise<ParsedSitemap | null> {
    try {
      const res = await pinnedFetch(
        url,
        {
          headers: {
            'user-agent': CRAWLER_USER_AGENT,
            accept: 'application/xml, text/xml, text/plain, */*',
          },
          maxBytes: CRAWL_DEFAULTS.maxSitemapBytes,
          timeoutMs: CRAWL_DEFAULTS.requestTimeoutMs,
          maxRedirects: CRAWL_DEFAULTS.maxRedirects,
          sameOrigin: true,
        },
        this.net,
      );
      if (res.status < 200 || res.status >= 300) return null;
      const body = maybeGunzip(res.body, CRAWL_DEFAULTS.maxSitemapBytes);
      if (!body) return null;
      return parseSitemap(body.toString('utf8'));
    } catch (e) {
      this.logger.debug(`sitemap ${url}: ${String(e)}`);
      return null;
    }
  }
}
