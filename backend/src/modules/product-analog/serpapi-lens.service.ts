/**
 * SerpApiLensService — Google Lens "visual matches" via SerpApi.
 * doc/PRODUCT-PROJECT-SPEC.md §6.1 (decided); Stage 4 of the plan.
 *
 * PORTED from SilverFinance `src/lib/server/lens-search.ts`
 * (`lensVisualMatches`) — the reference implementation the spec points
 * at. Kept the same: endpoint/params (`engine=google_lens`,
 * `type=visual_matches`, `url=<public image URL>`), the never-throws
 * contract (`{ matches, reason }`), the `visual_matches[]` field mapping
 * incl. the two places a price can live (`price.extracted_value` vs the
 * older top-level `extracted_price`), and dropping rows without a link.
 *
 * Changed on purpose:
 *  - `hl`/`country` come from the PROJECT's country (spec §6.3 reference
 *    data, `CountryRef.language`) instead of the hard-coded `uk`/`ua` —
 *    a Polish seller should see Polish shops and prices.
 *  - No CLIP/Replicate similarity re-ranking (SilverFinance's
 *    lens-search route): the spec defines relevance as SerpApi's own
 *    order (`relevanceRank` = position), and it would be a new paid
 *    service — out of scope.
 *  - Axios instead of fetch, with an explicit timeout, matching the rest
 *    of this backend (PromptService).
 *
 * Google Lens fetches the image itself, so `imageUrl` MUST be public —
 * hence the photo goes to Vercel Blob first (Stage 4 flow), never sent
 * as bytes/base64 here (SilverFinance does the same: data-URL → Blob →
 * Lens).
 *
 * Env: SERPAPI_API_KEY — same name as SilverFinance (spec §6.1 asked for
 * the name to match the existing implementation).
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';

const SERPAPI_URL = 'https://serpapi.com/search.json';
const REQUEST_TIMEOUT_MS = 30_000;
/** SerpApi returns up to ~60 visual matches; same ceiling as SilverFinance. */
const DEFAULT_LIMIT = 60;

export interface LensMatch {
  /** 1-based position in SerpApi's ranking — stored as ProductAnalog.relevanceRank. */
  position: number;
  title: string;
  url: string;
  source: string | null;
  /** Human-readable price as shown on the source, e.g. "₴1 200". */
  priceValue: string | null;
  /** Numeric price for sorting/selection (extracted_value). */
  priceNumber: number | null;
  currency: string | null;
  image: string | null;
  thumbnail: string | null;
}

export interface LensResult {
  matches: LensMatch[];
  /**
   * Set when `matches` is empty because of a problem (no key, bad URL,
   * HTTP error, network) — as opposed to Lens legitimately finding
   * nothing. Lets the UI say "поиск недоступен" vs "аналогов не найдено"
   * (spec §4 Экран 3: an empty result must not block the flow).
   */
  reason?: string;
  /**
   * True only when SerpApi answered HTTP 200 — i.e. a search that
   * SerpApi bills. Drives the per-user daily counter (spec §7.5): a
   * request that never reached SerpApi or was rejected (401 bad key,
   * 429) must not eat the user's allowance.
   */
  billed: boolean;
}

export interface LensSearchOptions {
  /** ISO 3166-1 alpha-2, lower-cased for SerpApi's `country`. */
  countryCode?: string;
  /** ISO 639-1 for SerpApi's `hl`. */
  language?: string;
  limit?: number;
}

/**
 * Pure mapper from SerpApi's raw `visual_matches` array — exported for
 * tests (fixtures shaped like real SerpApi payloads). Mirrors
 * SilverFinance's inline map 1:1, including its defensive coercions.
 */
export function mapVisualMatches(
  raw: unknown,
  limit = DEFAULT_LIMIT,
): LensMatch[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, limit)
    .map((m: Record<string, unknown>, i: number): LensMatch => {
      const price = (m?.price ?? null) as Record<string, unknown> | null;
      const priceNumber =
        typeof price?.extracted_value === 'number'
          ? (price.extracted_value as number)
          : typeof m?.extracted_price === 'number'
            ? (m.extracted_price as number)
            : null;
      return {
        position:
          typeof m?.position === 'number' ? (m.position as number) : i + 1,
        title: String(m?.title ?? '').trim() || '—',
        url: String(m?.link ?? ''),
        source: m?.source ? String(m.source) : null,
        priceValue:
          price?.value != null
            ? String(price.value)
            : typeof m?.price === 'string'
              ? (m.price as string)
              : null,
        priceNumber,
        currency: price?.currency ? String(price.currency) : null,
        image: m?.image ? String(m.image) : null,
        thumbnail: m?.thumbnail ? String(m.thumbnail) : null,
      };
    })
    .filter((m) => m.url);
}

@Injectable()
export class SerpApiLensService {
  private readonly logger = new Logger(SerpApiLensService.name);
  private readonly apiKey: string;

  constructor() {
    this.apiKey = loadConfiguration().serpApi.apiKey;
  }

  /** True when a key is configured — lets callers fail fast with a clear message. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Fetch visual matches for a PUBLIC image URL. Never throws. */
  async visualMatches(
    imageUrl: string,
    opts: LensSearchOptions = {},
  ): Promise<LensResult> {
    if (!this.apiKey) {
      return { matches: [], reason: 'SERPAPI_API_KEY not set', billed: false };
    }
    if (!/^https?:\/\//.test(imageUrl)) {
      return {
        matches: [],
        reason: 'image must be a public URL',
        billed: false,
      };
    }

    const params: Record<string, string> = {
      engine: 'google_lens',
      type: 'visual_matches',
      url: imageUrl,
      api_key: this.apiKey,
    };
    if (opts.language) params.hl = opts.language;
    if (opts.countryCode) params.country = opts.countryCode.toLowerCase();

    try {
      const res = await axios.get(SERPAPI_URL, {
        params,
        timeout: REQUEST_TIMEOUT_MS,
        // Handle non-2xx ourselves so the error body's message survives.
        validateStatus: () => true,
      });
      const data = res.data as Record<string, unknown> | undefined;

      if (res.status < 200 || res.status >= 300) {
        const msg =
          (data && ((data.error as string) || (data.message as string))) ||
          `serpapi HTTP ${res.status}`;
        this.logger.error(`SerpApi error ${res.status}: ${msg}`);
        return { matches: [], reason: String(msg), billed: false };
      }
      // SerpApi can return 200 with an `error` field (e.g. "Google hasn't
      // returned any results for this query") — that IS a completed,
      // billed search that simply found nothing.
      if (data?.error) {
        return { matches: [], reason: String(data.error), billed: true };
      }

      const matches = mapVisualMatches(
        data?.visual_matches,
        opts.limit ?? DEFAULT_LIMIT,
      );
      return { matches, billed: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'serpapi error';
      this.logger.error(`SerpApi request failed: ${reason}`);
      return { matches: [], reason, billed: false };
    }
  }
}
