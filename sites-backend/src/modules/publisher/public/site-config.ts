/**
 * AI Publisher — конфиг сайта продукта `GET /public/publisher/v1/site-config`
 * (P-D, проектный документ §3.3, §11.4, §13): режим, индексация хоста
 * сборки, форма открыта, альтернативный контакт, хранение сессии и
 * согласие, уведомление о данных, FAQ, активный оффер и правило срока
 * ответа `contact_sla` (Р-PUB-Z2-9) — всё из
 * представления `pub_public_products` (роль `publisher_public`).
 *
 * Без Origin (серверная сборка сайта, ISR) — допускается; с Origin —
 * только из `allowedOrigins`. Ответ кэшируется CDN 60 с (`s-maxage`), с
 * `Vary: Origin`. Лимит — 120 в минуту на IP (в памяти, база не пишется).
 */
import { Injectable } from '@nestjs/common';
import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';
import { PUBLIC_LIMITS, type SiteConfigView } from '../contracts/public-api';
import {
  PublicProductResolver,
  assertIntakeConfigured,
  assertOrigin,
  publicError,
  publicKeyOf,
  type PublicProduct,
} from './public-guard';
import { MemoryWindowLimiter } from './rate-limit';

const HOST_RE = /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/;

/** Хост сборки (`?host=`): нижний регистр, без схемы, пути и порта 443. */
export function buildHostOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let h = v.trim().toLowerCase();
  h = h
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:443$/, '');
  return HOST_RE.test(h) ? h : null;
}

export function siteConfigView(
  p: PublicProduct,
  host: string | null,
): SiteConfigView {
  return {
    mode: p.mode,
    indexable:
      host !== null &&
      p.indexableHosts.map((h) => h.toLowerCase()).includes(host),
    formOpen: p.formOpen,
    altContact: p.altContact ?? null,
    analyticsStorage: p.analyticsStorage,
    consentState: p.consentState,
    dataNotice: p.dataNotice ?? null,
    faq: p.faq,
    offer: p.offer ?? null,
    formLimit: { count: p.formLimitCount, windowSec: p.formLimitWindowSec },
    contactSla: p.contactSla ?? null,
  };
}

@Injectable()
export class SiteConfigService {
  readonly limiter = new MemoryWindowLimiter(
    PUBLIC_LIMITS.siteConfigPerMinute,
    60_000,
  );

  constructor(
    private readonly db: PublisherPublicDb,
    private readonly products: PublicProductResolver,
  ) {}

  async read(
    query: { key?: unknown; host?: unknown },
    client: { origin: string | undefined; ip: string },
  ): Promise<SiteConfigView> {
    const hit = this.limiter.hit(client.ip);
    if (!hit.ok) {
      throw publicError('PUB_RATE_LIMITED', {
        retryAfterSec: hit.retryAfterSec,
        altContact: null,
      });
    }
    assertIntakeConfigured(this.db);
    const product = await this.products.require(publicKeyOf(query.key));
    assertOrigin(product, client.origin, 'GET');
    return siteConfigView(product, buildHostOf(query.host));
  }
}
