/**
 * AI Publisher — публичные маршруты приёма P-D (проектный документ §11.4):
 *
 *   GET  /public/publisher/v1/site-config?key=pp_…&host=   конфиг сайта
 *   POST /public/publisher/v1/leads                         заявка (JSON ≤ 8 КБ)
 *   POST /public/publisher/v1/events                        событие (text/plain ≤ 2 КБ)
 *
 * Без входа (`@PublicRoute`), клиент БД — `publisher_public`. CORS —
 * `common/cors.ts` (отражённый Origin без cookie); допуск по существу —
 * `public-guard.ts`. Ошибки — `PublicErrorFilter` (коды §11.2, `Retry-After`,
 * `no-store`). Чтение контента (`GET /contents*`) — контроллер P-B1.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { clientIp } from '../../../shared/client-ip';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import type {
  EventAccepted,
  LeadAccepted,
  SiteConfigView,
} from '../contracts/public-api';
import { EventIntakeService } from './event-intake';
import { LeadIntakeService } from './lead-intake';
import { PublicErrorFilter, originOf } from './public-guard';
import { SiteConfigService } from './site-config';

@Controller('public/publisher/v1')
@PublicRoute(
  'публичный сайт AI Publisher: конфиг, форма и события (свой гвард по ключу продукта, Origin и лимитам)',
)
@UseFilters(PublicErrorFilter)
export class PublisherIntakeController {
  constructor(
    private readonly config: SiteConfigService,
    private readonly leads: LeadIntakeService,
    private readonly events: EventIntakeService,
  ) {}

  @Get('site-config')
  async siteConfig(
    @Query() q: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteConfigView> {
    const view = await this.config.read(q, {
      origin: originOf(req),
      ip: clientIp(req),
    });
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=60, stale-while-revalidate=60',
    );
    res.setHeader('Vary', 'Origin');
    return view;
  }

  @Post('leads')
  async submitLead(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadAccepted> {
    const r = await this.leads.submit(body, {
      origin: originOf(req),
      ip: clientIp(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.status);
    return r.body;
  }

  @Post('events')
  @HttpCode(202)
  async trackEvent(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EventAccepted> {
    const r = await this.events.track(body, {
      origin: originOf(req),
      ip: clientIp(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    return r;
  }
}
