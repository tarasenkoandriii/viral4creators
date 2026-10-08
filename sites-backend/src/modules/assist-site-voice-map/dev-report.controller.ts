/**
 * «Отчёт для разработчика» по ссылке — без входа в Telegram (Э6-тер (9),
 * заход 9; ТЗ §5-кватер.13):
 *   GET /assist/sites/:id/voice-map/site/dev-report/:token[?lang=uk|ru|en][&format=json]
 * Страница только для чтения: `text/html` без скриптов (CSP
 * `default-src 'none'`), `no-store`, `noindex`, без `Referer`; `format=json`
 * — тот же снимок машинно. Любой отказ — один ответ 404 (не оракул).
 * Выдача и отзыв ссылки — кабинет (`voice-map.controller.ts`).
 */
import {
  Controller,
  Get,
  HttpException,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  DEV_REPORT_CSP,
  devReportHtml,
  devReportInvalidHtml,
  devReportLang,
} from './dev-report';
import { DevReportService, PREVIEW_BOT_RE } from './dev-report.service';

@Controller('assist/sites')
@PublicRoute(
  'отчёт для разработчика голосовой карты: допуск — одноразово выданный токен ссылки (хеш в базе, 7 дней, отзыв)',
)
export class DevReportController {
  constructor(private readonly reports: DevReportService) {}

  @Get(':id/voice-map/site/dev-report/:token')
  async read(
    @Param('id') id: string,
    @Param('token') token: string,
    @Query('lang') langRaw: unknown,
    @Query('format') format: unknown,
    @Res() res: Response,
    @Req() req?: Request,
  ): Promise<void> {
    // HEAD и боты превью (мессенджер развернул ссылку) — не просмотр.
    const count =
      (req?.method ?? 'GET') === 'GET' &&
      !PREVIEW_BOT_RE.test(String(req?.headers?.['user-agent'] ?? ''));
    const lang = devReportLang(langRaw);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', DEV_REPORT_CSP);
    let content;
    try {
      content = await this.reports.read(id, token, { count });
    } catch (e) {
      // Только отказ ссылки — страница «недействительна»; сбой базы — 500.
      if (!(e instanceof HttpException)) throw e;
      if (format === 'json') {
        res.status(404).json({
          success: false,
          error: {
            code: 'VOICE_MAP_DEV_REPORT_NOT_FOUND',
            message: 'Ссылка недействительна, устарела или отозвана',
          },
        });
        return;
      }
      res.status(404);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(devReportInvalidHtml(lang));
      return;
    }
    if (format === 'json') {
      res.status(200).json({ success: true, data: content });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(devReportHtml(content, lang));
  }
}
