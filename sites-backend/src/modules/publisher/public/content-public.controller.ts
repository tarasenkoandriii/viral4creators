/**
 * AI Publisher, P-B1 — публичное чтение контента (проектный документ
 * §11.4; AT-CORE-01):
 *
 *   GET /public/publisher/v1/contents?key=pp_…         список материалов
 *   GET /public/publisher/v1/contents/:slug?key=pp_…   материал
 *
 * Без входа (`@PublicRoute`), клиент — `publisher_public`. Обвязка — общая
 * с приёмом P-D (интеграция Z-1, Р-PUB-Z1-7): ключ → продукт
 * `PublicProductResolver`, Origin `assertOrigin` (с ним — только из
 * `allowedOrigins` режима продукта, иначе 403 `PUB_ORIGIN_DENIED`; без него
 * — допускается, серверная сборка, только GET), ошибки `PublicError` +
 * `PublicErrorFilter`, лимит — 120 в минуту на IP `MemoryWindowLimiter`
 * (окно в памяти, база не пишется). Снятый материал — 410
 * `{withdrawn:true}`, неизвестный — 404. `X-Robots-Tag: noindex` — всегда,
 * кроме рабочего продукта не в `test`, когда хост сборки (`?host=`, иначе
 * хост Origin) входит в `indexableHosts` гейта (аудит P-B1 S3-2: пустой
 * список — закрытый `public_publish` или `closed` — тоже `noindex`); кэш
 * CDN — `s-maxage=60`.
 */
import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { clientIp } from '../../../shared/client-ip';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import type {
  PublicContent,
  PublicContentListItem,
} from '../contracts/content-api';
import {
  CONTENT_READS_PER_MIN,
  ContentPublicRepo,
  SLUG_RE,
  publicContentOf,
} from './content-public.repo';
import {
  PublicErrorFilter,
  PublicProductResolver,
  assertOrigin,
  originOf,
  publicError,
  publicKeyOf,
  type PublicProduct,
} from './public-guard';
import { MemoryWindowLimiter } from './rate-limit';
import { buildHostOf } from './site-config';

const CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

@Controller('public/publisher/v1')
@PublicRoute(
  'публичный сайт AI Publisher: чтение опубликованных материалов (ключ продукта, Origin, лимит на IP)',
)
@UseFilters(PublicErrorFilter)
export class PublisherContentPublicController {
  /** Общий на экземпляр (тесты сбрасывают `reset()`). */
  readonly limiter = new MemoryWindowLimiter(CONTENT_READS_PER_MIN, 60_000);

  constructor(
    private readonly repo: ContentPublicRepo,
    private readonly products: PublicProductResolver,
  ) {}

  private async admit(
    req: Request,
    q: Record<string, unknown>,
  ): Promise<PublicProduct> {
    const hit = this.limiter.hit(clientIp(req));
    if (!hit.ok) {
      throw publicError('PUB_RATE_LIMITED', {
        retryAfterSec: hit.retryAfterSec,
        altContact: null,
      });
    }
    const key = publicKeyOf(q.key);
    if (!this.repo.configured) {
      throw publicError('PUB_BUSY', { reason: 'public_db_unavailable' });
    }
    const p = await this.products.require(key);
    assertOrigin(p, originOf(req), 'GET');
    return p;
  }

  private headers(
    res: Response,
    p: PublicProduct,
    req: Request,
    q: Record<string, unknown>,
  ): void {
    res.setHeader('Cache-Control', CACHE);
    res.setHeader('Vary', 'Origin');
    const host = buildHostOf(q.host) ?? buildHostOf(originOf(req));
    const indexable =
      p.mode !== 'test' &&
      p.kind === 'working' &&
      host !== null &&
      p.indexableHosts.some((h) => h.toLowerCase() === host);
    if (!indexable) res.setHeader('X-Robots-Tag', 'noindex');
  }

  @Get('contents')
  async list(
    @Query() q: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicContentListItem[]> {
    const p = await this.admit(req, q);
    const items = await this.repo.list(p.id);
    this.headers(res, p, req, q);
    return items;
  }

  @Get('contents/:slug')
  async get(
    @Param('slug') slug: string,
    @Query() q: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicContent | { withdrawn: true }> {
    const p = await this.admit(req, q);
    if (!SLUG_RE.test(slug)) throw publicError('PUB_NOT_FOUND');
    const row = await this.repo.bySlug(p.id, slug);
    if (!row) throw publicError('PUB_NOT_FOUND');
    this.headers(res, p, req, q);
    if (row.withdrawn) {
      // Снятый материал: 410 и только признак (тела нет и в представлении).
      res.status(410);
      return { withdrawn: true };
    }
    return publicContentOf(row);
  }
}
