/**
 * Публичные маршруты голоса виджета — Э5 (ТЗ помощника §4.10, §4.13, §4.16):
 *   POST /widget/v1/voice   тело — запись `audio/*` (≤ 1 МБ, сырые байты;
 *                           парсер — app.setup.ts WIDGET_VOICE_PATH) → текст
 *                           и билет голоса для `POST /widget/v1/chat`
 *   POST /widget/v1/tts     { messageId } → `audio/mpeg` (мимо конверта)
 * Зовёт iframe со своего origin (CORS — как у остальных `/widget/v1/*`);
 * допуск — visitor-token из заголовка и гвард origin (sessions.authenticate).
 *
 * Лимиты посетителя (§4.10 «не больше N голосовых сообщений на посетителя в
 * сутки»): минутный — RATE_LIMITED (повторить позже), суточный — VOICE_LIMIT
 * (голос на сегодня всё, чат — текстом: одно уведомление в iframe). Те же
 * окна — и на ipHash+сайт (как у чата): новый visitor-token их не обходит.
 *
 * В лог — только id и коды (§6.6). Звук вопроса нигде не сохраняется и
 * затирается после распознавания (assist-site-voice/public/site-voice.service.ts).
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import type { Request, Response } from 'express';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import type { WidgetVoiceResponse } from '../assist-site-voice/api-types';
import {
  SiteVoiceService,
  STT_UI_LANG_HEADER,
  uiLangOf,
  type VoiceFailure,
} from '../assist-site-voice/public/site-voice.service';
import { VOICE_DEFAULTS } from '../assist-site-voice/voice-config';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import type { WidgetErrorCode } from './api-types';
import { WidgetRateLimit, type RateHit } from './rate-limit';
import { tokenRequestOrigin } from './widget-public.controller';
import { WidgetSessionService } from './widget-session.service';
import { widgetError } from './widget-errors';

const TOKEN_HEADER = WIDGET_VISITOR_TOKEN_HEADER.toLowerCase();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export class WidgetTtsDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  messageId!: string;
}

const FAILURE_CODE: Record<VoiceFailure, WidgetErrorCode> = {
  unavailable: 'VOICE_UNAVAILABLE',
  limit: 'VOICE_LIMIT',
  audio_invalid: 'AUDIO_INVALID',
  not_heard: 'VOICE_NOT_HEARD',
  upstream: 'UPSTREAM',
  not_found: 'NOT_FOUND',
};

@Controller('widget/v1')
@PublicRoute(
  'голос виджета на сайте заказчика: допуск — гвард origin, visitor-token и деньги, не initData',
)
export class WidgetVoiceController {
  constructor(
    private readonly sessions: WidgetSessionService,
    private readonly rate: WidgetRateLimit,
    private readonly voice: SiteVoiceService,
  ) {}

  @Post('voice')
  @HttpCode(200)
  async voiceIn(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetVoiceResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const key = `${ctx.site.siteId}:${ctx.visitor.visitorId}`;
    const ipKey = `${ctx.site.siteId}:${ctx.visitor.ipHash}`;
    await this.rate.enforce([
      {
        scope: 'widget-stt-visitor-min',
        key,
        limit: VOICE_DEFAULTS.sttPerVisitorPerMinute,
        windowMs: MINUTE,
      },
      {
        scope: 'widget-stt-ip-site-min',
        key: ipKey,
        limit: VOICE_DEFAULTS.sttPerIpPerMinute,
        windowMs: MINUTE,
      },
    ]);
    await this.dayLimits([
      {
        scope: 'widget-stt-visitor-day',
        key,
        limit: VOICE_DEFAULTS.sttPerVisitorPerDay,
        windowMs: DAY,
      },
      {
        scope: 'widget-stt-ip-site-day',
        key: ipKey,
        limit: VOICE_DEFAULTS.sttPerIpPerDay,
        windowMs: DAY,
      },
    ]);
    const body: unknown = req.body;
    const audio = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const r = await this.voice.transcribe(
      ctx,
      audio,
      req.headers['content-type'],
      // Заход 9: язык интерфейса виджета — счётчик «не расслышал» Т-4.
      uiLangOf(req.headers[STT_UI_LANG_HEADER.toLowerCase()]),
    );
    if (!r.ok) throw widgetError(FAILURE_CODE[r.failure]);
    return { text: r.text, lang: r.lang, voiceTicket: r.ticket };
  }

  @Post('tts')
  async speak(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetTtsDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const key = `${ctx.site.siteId}:${ctx.visitor.visitorId}`;
    const ipKey = `${ctx.site.siteId}:${ctx.visitor.ipHash}`;
    await this.rate.enforce([
      {
        scope: 'widget-tts-visitor-min',
        key,
        limit: VOICE_DEFAULTS.ttsPerVisitorPerMinute,
        windowMs: MINUTE,
      },
      {
        scope: 'widget-tts-ip-site-min',
        key: ipKey,
        limit: VOICE_DEFAULTS.ttsPerIpPerMinute,
        windowMs: MINUTE,
      },
    ]);
    await this.dayLimits([
      {
        scope: 'widget-tts-visitor-day',
        key,
        limit: VOICE_DEFAULTS.ttsPerVisitorPerDay,
        windowMs: DAY,
      },
      {
        scope: 'widget-tts-ip-site-day',
        key: ipKey,
        limit: VOICE_DEFAULTS.ttsPerIpPerDay,
        windowMs: DAY,
      },
    ]);
    const r = await this.voice.speak(ctx, dto.messageId);
    if (!r.ok) throw widgetError(FAILURE_CODE[r.failure]);
    res.status(200);
    res.setHeader('Content-Type', r.mime);
    res.setHeader('Content-Length', String(r.audio.length));
    // Ответ посетителю — личный: ни общий кэш, ни диск браузера.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(r.audio);
  }

  /** Суточные лимиты (посетитель, затем IP): первый выбранный — VOICE_LIMIT. */
  private async dayLimits(hits: RateHit[]): Promise<void> {
    for (const h of hits) {
      if (!(await this.rate.hit(h))) throw widgetError('VOICE_LIMIT');
    }
  }
}
