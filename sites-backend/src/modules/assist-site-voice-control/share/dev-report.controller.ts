/**
 * Публичная страница «отчёт для разработчика» мастера Т-2 (заход 9, Р-З9-9;
 * ТЗ §5-бис.13 п.7) на origin виджета (rewrite Vercel `/w/v1/*`):
 *   GET  /w/v1/vc-report/:token  страница с кнопкой «Відкрити звіт» —
 *                                токен НЕ тратится (превью мессенджеров)
 *   POST /w/v1/vc-report/:token  отчёт (одноразово: первое открытие гасит)
 * Допуск — только одноразовый токен кабинета (24 байта, в базе — хеш,
 * срок 72 ч). HTML без скриптов, `Cache-Control: no-store`, `noindex`,
 * `Referrer-Policy: no-referrer`, CSP без скриптов и встраивания.
 * Недействителен/истёк/открыт — один ответ 404 (не оракул).
 */
import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  sendReportHtml,
  setReportPageHeaders,
} from '../../../common/report-page';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  DEV_REPORT_CSP,
  devReportGone,
  devReportHtml,
  devReportLanding,
} from './dev-report';
import { VoiceDevReportService } from './dev-report.service';

/** Ответ страницы: общие заголовки отчёта (`common/report-page`) + HTML. */
function send(res: Response, status: number, html: string): void {
  setReportPageHeaders(res, DEV_REPORT_CSP);
  sendReportHtml(res, status, html);
}

@Controller('w/v1/vc-report')
@PublicRoute(
  'отчёт мастера голосового управления для разработчика сайта: допуск — одноразовый токен кабинета',
)
export class VoiceDevReportController {
  constructor(private readonly reports: VoiceDevReportService) {}

  @Get(':token')
  async landing(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const lang = await this.reports.peekLang(token);
    if (lang === null) return send(res, 404, devReportGone());
    send(res, 200, devReportLanding(token, lang));
  }

  @Post(':token')
  @HttpCode(200)
  async open(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const r = await this.reports.consume(token);
    if (!r) return send(res, 404, devReportGone());
    send(res, 200, devReportHtml(r));
  }
}
