/**
 * Публичные маршруты Э3-бис (связанный режим, эксперименты, поведение) —
 * формы и правила: widget-analytics.service.ts. @PublicRoute; база — только
 * AssistPublicDb; CORS для запросов СО СТРАНИЦЫ (exp, pv, ref) —
 * `common/cors.ts` (WIDGET_PAGE_PATHS), допуск решает гвард по pk +
 * точному verified public-хосту.
 */
import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { clientIp } from '../telegram-auth/web/web-request';
import { WidgetAnalyticsService } from './widget-analytics.service';
import type { PageRequest } from './widget-engagement.service';
import { tokenRequestOrigin } from './widget-public.controller';
import { WidgetSessionService } from './widget-session.service';

const TOKEN_HEADER = WIDGET_VISITOR_TOKEN_HEADER.toLowerCase();

function pageRequest(req: Request, body: unknown): PageRequest {
  const o = req.headers.origin;
  const cl = req.headers['content-length'];
  return {
    body,
    origin: typeof o === 'string' ? o : undefined,
    ip: clientIp(req),
    contentLength: typeof cl === 'string' ? cl : undefined,
  };
}

@Controller('widget/v1')
@PublicRoute(
  'виджет на сайте заказчика (связанный режим Э3-бис): допуск — гвард origin и согласие посетителя, не initData',
)
export class WidgetAnalyticsController {
  constructor(
    private readonly analytics: WidgetAnalyticsService,
    private readonly sessions: WidgetSessionService,
  ) {}

  @Post('exp')
  @HttpCode(204)
  async exp(@Body() body: unknown, @Req() req: Request): Promise<void> {
    await this.analytics.experiment(pageRequest(req, body));
  }

  @Post('pv')
  @HttpCode(204)
  async pv(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const ua = req.headers['user-agent'];
    await this.analytics.pageView({
      ...pageRequest(req, body),
      userAgent: typeof ua === 'string' ? ua : undefined,
    });
  }

  @Post('ref')
  @HttpCode(200)
  ref(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ ref: string | null }> {
    return this.analytics.ref(pageRequest(req, body));
  }

  @Post('visit')
  @HttpCode(204)
  async visit(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    await this.analytics.visit(ctx, body, clientIp(req));
  }
}
