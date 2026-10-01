/**
 * Маршруты лендинга — W2 (лендинг-ТЗ §17.3 п.1; контракт Э2 §6):
 *   POST /public/landing/event        204 (sendBeacon)
 *   GET  /public/assist/plans         снимок тарифов (кэш)
 *   POST /public/widget-drafts        «к Л3»
 *
 * События: sendBeacon шлёт тело и как `application/json`, и как
 * `text/plain` (Blob без типа) — второе общий JSON-парсер не трогает, его
 * дочитываем сами с тем же потолком 4 КБ.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LANDING_DEFAULTS } from '../../../config/assist-defaults';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { clientIp } from '../../telegram-auth/web/web-request';
import { widgetError } from '../widget-errors';
import type {
  AssistPlansSnapshot,
  LandingEventBatch,
  WidgetDraftCreated,
} from './landing-types';
import { LandingService } from './landing.service';

function originOf(req: Request): string | undefined {
  const o = req.headers.origin;
  return typeof o === 'string' ? o : undefined;
}

/** Тело, которое JSON-парсер не разобрал (text/plain), — с потолком. */
export async function readSmallBody(
  req: Request,
  maxBytes: number,
): Promise<unknown> {
  const parsed: unknown = req.body;
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length > 0
  ) {
    return parsed;
  }
  if (req.readableEnded || req.complete) return parsed;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > maxBytes) throw widgetError('BAD_REQUEST');
    chunks.push(b);
  }
  if (!size) return parsed;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw widgetError('BAD_REQUEST');
  }
}

@Controller('public')
@PublicRoute('лендинг: события и тарифы без входа; стена — лимиты, не origin')
export class LandingPublicController {
  constructor(readonly landing: LandingService) {}

  @Post('landing/event')
  @HttpCode(204)
  async event(@Req() req: Request): Promise<void> {
    const body = await readSmallBody(req, LANDING_DEFAULTS.eventBodyMaxBytes);
    await this.landing.recordEvents({
      body: body as LandingEventBatch,
      ip: clientIp(req),
      origin: originOf(req),
    });
  }

  @Get('assist/plans')
  plans(@Res({ passthrough: true }) res: Response): AssistPlansSnapshot {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return this.landing.plans();
  }

  @Post('widget-drafts')
  @HttpCode(200)
  async widgetDraft(
    @Body() body: { config?: unknown },
    @Req() req: Request,
  ): Promise<WidgetDraftCreated> {
    return this.landing.createWidgetDraft({
      config: body?.config,
      ip: clientIp(req),
      origin: originOf(req),
    });
  }
}
