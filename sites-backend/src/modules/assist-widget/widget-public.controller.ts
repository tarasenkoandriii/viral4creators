/**
 * Публичные маршруты виджета — W2 (ТЗ §4.16, §4-бис.9; контракт Э2 §6):
 *   GET  /widget/v1/config?pk=
 *   POST /widget/v1/session            (и /session/resume — тот же обработчик)
 *   GET  /widget/v1/state?since=
 *   POST /widget/v1/chat               SSE | JSON
 *   GET  /widget/v1/messages/:id/stream?from=
 *   POST /widget/v1/lead
 *   POST /widget/v1/handoff            Э3: HandoffIntake.request (H), 5/ч на посетителя
 *   POST /widget/v1/feedback
 *   POST /widget/v1/forget
 *   POST /widget/v1/preview/exchange
 *   GET  /widget/v1/ping?pk=&v=        картинкой (проверка установки)
 *   GET  /widget/v1/asset/:id          логотип/аватар (растр)
 * @PublicRoute; вся база — AssistPublicDb. Ответы чата/стрима и картинки —
 * через @Res() (мимо конверта ResponseInterceptor). В логах — только id и
 * коды, никогда текст сообщений и поля лида (§6.6, приёмка Э2 п.6).
 *
 * CHIPS-cookie указателя читает ТОЛЬКО `POST session` (§4-бис.10 п.9):
 * остальным маршрутам сессию даёт лишь visitor-token из заголовка.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { widgetOrigin } from '../../config/widget-env';
import { LEAD_FIELDS, type LeadField } from '../assist-site-setup/leads-config';
import {
  SiteLeadsService,
  type LeadSubmitInput,
} from '../assist-site-chat/leads.service';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { clientIp } from '../telegram-auth/web/web-request';
import type {
  WidgetForgetResponse,
  WidgetHandoffResponse,
  WidgetPreviewExchangeResponse,
  WidgetPublicConfig,
  WidgetSessionResponse,
  WidgetStateView,
  WidgetStreamChunk,
} from './api-types';
import { cleanPageUrl, WidgetChatService } from './widget-chat.service';
import { cleanIdentity } from './widget-engagement';
import { WidgetEngagementService } from './widget-engagement.service';
import { PIXEL_GIF, WidgetPublicConfigService } from './widget-config.service';
import { widgetError } from './widget-errors';
import { WidgetRateLimit } from './rate-limit';
import {
  resumeCookie,
  resumeKeyFromCookie,
  WidgetSessionService,
} from './widget-session.service';
import { WidgetStateService } from './widget-state.service';
import {
  WidgetChatDto,
  WidgetFeedbackDto,
  WidgetHandoffDto,
  WidgetLeadDto,
  WidgetPreviewExchangeDto,
  WidgetSessionDto,
} from './widget.dto';

const TOKEN_HEADER = WIDGET_VISITOR_TOKEN_HEADER.toLowerCase();

function originOf(req: Request): string | undefined {
  const o = req.headers.origin;
  return typeof o === 'string' ? o : undefined;
}

/**
 * Origin запроса по visitor-token (интеграция Э2). Браузер НЕ шлёт Origin
 * на same-origin GET (iframe читает `GET /widget/v1/state` и
 * `…/messages/:id/stream` со своего же origin) — без этой поправки каждый
 * GET iframe получал ORIGIN_DENIED. Для GET/HEAD без Origin источником
 * считаем origin виджета, если браузер не сказал обратного
 * (`Sec-Fetch-Site: same-origin` или заголовка нет — старые браузеры).
 * Защита от чужих страниц — не Origin, а токен в СВОЁМ заголовке: его не
 * приложить к межсайтовому запросу без preflight, а CORS чужому origin
 * отказывает. POST браузер шлёт с Origin всегда — там проверка прежняя.
 */
export function tokenRequestOrigin(req: Request): string | undefined {
  const o = originOf(req);
  if (o !== undefined) return o;
  const site = req.headers['sec-fetch-site'];
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    (site === undefined || site === 'same-origin')
  ) {
    return widgetOrigin();
  }
  return undefined;
}

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}

/** Поля лида: только известные, строки, не длиннее лимитов (§3.6 п.6). */
export function cleanLeadFields(
  raw: Record<string, unknown>,
): Partial<Record<LeadField, string>> | null {
  const out: Partial<Record<LeadField, string>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(LEAD_FIELDS as readonly string[]).includes(k)) return null;
    if (typeof v !== 'string') return null;
    const max =
      k === 'comment'
        ? WIDGET_DEFAULTS.leadCommentMaxChars
        : WIDGET_DEFAULTS.leadFieldMaxChars;
    if (v.length > max) return null;
    const t = v.trim();
    if (t) out[k as LeadField] = t;
  }
  return out;
}

@Controller('widget/v1')
@PublicRoute(
  'виджет на сайте заказчика: допуск — гвард origin, visitor-token и деньги, не initData',
)
export class WidgetPublicController {
  constructor(
    readonly config: WidgetPublicConfigService,
    readonly sessions: WidgetSessionService,
    readonly state: WidgetStateService,
    private readonly chat: WidgetChatService,
    private readonly leads: SiteLeadsService,
    private readonly rate: WidgetRateLimit,
    private readonly engagement: WidgetEngagementService,
  ) {}

  @Get('config')
  async getConfig(
    @Query('pk') pk: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetPublicConfig> {
    const s = WIDGET_DEFAULTS.configCacheSeconds;
    const body = await this.config.config(typeof pk === 'string' ? pk : '');
    res.setHeader('Cache-Control', `public, max-age=${s}, s-maxage=${s}`);
    res.setHeader('Vary', 'Origin');
    return body;
  }

  @Get('ping')
  async ping(
    @Query('pk') pk: string | undefined,
    @Query('v') v: string | undefined,
    @Query('c') c: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.config.ping({
        pk: typeof pk === 'string' ? pk : '',
        referer:
          typeof req.headers.referer === 'string'
            ? req.headers.referer
            : undefined,
        loaderVersion: typeof v === 'string' ? v : null,
        configFetchOk: c === '1' ? true : c === '0' ? false : null,
      });
    } catch {
      // Пинг — не оракул и не точка отказа: картинка уходит всегда.
    }
    res.status(200);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store');
    res.end(PIXEL_GIF);
  }

  @Get('asset/:id')
  async asset(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const a = await this.config.asset(id);
    if (!a) throw widgetError('NOT_FOUND');
    res.status(200);
    res.setHeader('Content-Type', a.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${a.sha256}"`);
    res.end(a.bytes);
  }

  @Post(['session', 'session/resume'])
  @HttpCode(200)
  async session(
    @Body() dto: WidgetSessionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetSessionResponse> {
    noStore(res);
    const r = await this.sessions.start({
      body: {
        pk: dto.pk,
        parentOrigin: dto.parentOrigin,
        resumeKey: dto.resumeKey ?? null,
        previewSession: dto.previewSession ?? null,
      },
      requestOrigin: originOf(req),
      ip: clientIp(req),
      cookieResumeKey: resumeKeyFromCookie(req.headers.cookie, dto.pk),
    });
    if (r.setResumeCookie) res.setHeader('Set-Cookie', r.setResumeCookie);
    return r.body;
  }

  @Get('state')
  async getState(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Query('since') since: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetStateView> {
    noStore(res);
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const n =
      since !== undefined && /^\d{1,9}$/.test(since) ? Number(since) : null;
    return this.state.state(ctx, n);
  }

  @Post('chat')
  async postChat(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetChatDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const input = await this.chat.prepare(ctx, dto);
    const accept = String(req.headers.accept ?? '');
    if (
      accept.includes('application/json') &&
      !accept.includes('text/event-stream')
    ) {
      const data = await this.chat.json(ctx, input);
      noStore(res);
      res.status(200).json({
        success: true,
        data,
        meta: { timestamp: new Date().toISOString(), requestId: randomUUID() },
      });
      return;
    }
    await this.chat.streamSse(ctx, input, res);
  }

  @Get('messages/:id/stream')
  async stream(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Param('id') id: string,
    @Query('from') from: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetStreamChunk> {
    noStore(res);
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const n = from !== undefined && /^\d{1,7}$/.test(from) ? Number(from) : 0;
    return this.state.streamChunk(ctx, id, n);
  }

  @Post('lead')
  @HttpCode(200)
  async lead(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetLeadDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    await this.rate.enforce([
      {
        scope: 'widget-lead-visitor-hour',
        key: `${ctx.site.siteId}:${ctx.visitor.visitorId}`,
        limit: WIDGET_DEFAULTS.leadsPerVisitorPerHour,
        windowMs: 60 * 60 * 1000,
      },
    ]);
    if (!dto.consent) throw widgetError('CONSENT_REQUIRED');
    const fields = cleanLeadFields(dto.fields);
    if (!fields || Object.keys(fields).length === 0) {
      throw widgetError('LEAD_INVALID');
    }
    // Диалог — только свой: чужой id не привязывает лид к чужому диалогу.
    let conversationId: string | null = null;
    if (typeof dto.conversationId === 'string' && dto.conversationId) {
      const own = await this.state.ownsConversation(ctx, dto.conversationId);
      conversationId = own ? dto.conversationId : null;
    }
    // Э3: identify — только вместе с лидом (К-3); шифрует и сверяет A.
    const input: LeadSubmitInput = {
      site: ctx.site,
      visitor: ctx.visitor,
      conversationId,
      fields,
      consent: dto.consent,
      uiLang: dto.uiLang,
      pageUrl: cleanPageUrl(dto.pageUrl),
      identity: cleanIdentity(dto.identity),
    };
    await this.leads.submit(input);
    return { ok: true };
  }

  @Post('handoff')
  @HttpCode(200)
  async handoff(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetHandoffDto,
    @Req() req: Request,
  ): Promise<WidgetHandoffResponse> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    return this.engagement.handoff(ctx, dto);
  }

  @Post('feedback')
  @HttpCode(200)
  async feedback(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetFeedbackDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    return this.state.feedback(ctx, dto.messageId, dto.rating);
  }

  @Post('forget')
  @HttpCode(200)
  async forget(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetForgetResponse> {
    noStore(res);
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const out = await this.state.forget(ctx);
    // Стереть и CHIPS-копию указателя (localStorage чистит сам iframe) —
    // cookie СВОЕГО pk (имя зависит от ключа сайта).
    const pk = await this.sessions.sessionPk(ctx);
    if (pk) res.setHeader('Set-Cookie', resumeCookie(pk, null));
    return out;
  }

  @Post('preview/exchange')
  @HttpCode(200)
  async previewExchange(
    @Body() dto: WidgetPreviewExchangeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetPreviewExchangeResponse> {
    noStore(res);
    return this.config.exchangePreview(
      { pk: dto.pk, token: dto.token, parentOrigin: dto.parentOrigin },
      originOf(req),
    );
  }
}
