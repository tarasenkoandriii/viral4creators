/**
 * GET /w/v1/frame?pk=…[&pv=1] — HTML iframe-чата с динамическим
 * `frame-ancestors` (ТЗ §4.12) — W2. Через @Res(): text/html, без конверта.
 * Неизвестный pk — тот же HTML с `frame-ancestors 'none'` (не оракул).
 *
 * Helmet приложения ставит `X-Frame-Options: SAMEORIGIN` — у этого
 * документа его снимаем: встраивание решает frame-ancestors (браузеры с
 * CSP2 и так игнорируют XFO при frame-ancestors, но старые — нет, и тогда
 * чат не отрисовался бы нигде).
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { videoMediaSources } from '../../config/media-env';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { frameCsp, frameHtml } from './frame-html';
import { WidgetPublicConfigService } from './widget-config.service';

@Controller('w/v1')
@PublicRoute('HTML iframe-чата: встраивание решает браузер по frame-ancestors')
export class WidgetFrameController {
  constructor(readonly config: WidgetPublicConfigService) {}

  @Get('frame')
  async frame(
    @Query('pk') pk: string | undefined,
    @Query('pv') pv: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    let ancestors = "'none'";
    try {
      ancestors = await this.config.frameAncestorsFor(
        typeof pk === 'string' ? pk : '',
        pv === '1',
      );
    } catch {
      // Сбой базы — тот же HTML, но встроить нельзя нигде (безопасный отказ).
      ancestors = "'none'";
    }
    res.status(200);
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Security-Policy',
      frameCsp(ancestors, videoMediaSources()),
    );
    res.setHeader(
      'Cache-Control',
      `public, max-age=0, s-maxage=${WIDGET_DEFAULTS.frameCacheSeconds}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(frameHtml());
  }
}
