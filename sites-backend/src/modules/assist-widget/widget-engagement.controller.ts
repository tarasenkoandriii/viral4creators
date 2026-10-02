/**
 * Публичные маршруты виджета Э3 — W (ТЗ §3.7, §4.16, §5-тер.1, §5-тер.14;
 * формы — api-types.ts):
 *   POST /widget/v1/handoff/cancel      visitor-token        → { ok: true }
 *   POST /widget/v1/event               Origin страницы + pk → 204 (EventCounts, A)
 *   POST /widget/v1/goal                Origin страницы + pk | visitor-token → 204 | 422 (GoalIntake, A)
 *   POST /widget/v1/goal-picker/session Origin страницы + pk → WidgetGoalPickerSessionResponse
 *   POST /widget/v1/goal-picker/pick    Origin страницы      → { ok: true }
 * `POST /widget/v1/handoff` остаётся в widget-public.controller.ts (W
 * меняет его на HandoffIntake.request, H). @PublicRoute; база — только
 * AssistPublicDb; в лог — id и коды (§6.6). CORS для запросов СО СТРАНИЦЫ
 * (event, goal из загрузчика, picker) — `common/cors.ts` (координатор, по
 * запросу W): Origin = verified public-хост сайта проверяет гвард, а не CORS.
 *
 * `event` и `goal` принимают и text/plain (sendBeacon при скрытии вкладки —
 * простой запрос без preflight): тело приходит строкой ≤ 4 КБ (app.setup.ts),
 * поэтому тела здесь — `unknown` и строгий разбор widget-engagement.ts, а не
 * DTO class-validator.
 */
import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { clientIp } from '../telegram-auth/web/web-request';
import type { WidgetGoalPickerSessionResponse } from './api-types';
import { tokenRequestOrigin } from './widget-public.controller';
import {
  WidgetEngagementService,
  type PageRequest,
} from './widget-engagement.service';
import { WidgetSessionService } from './widget-session.service';
import {
  WidgetGoalPickerSessionDto,
  WidgetHandoffCancelDto,
} from './widget.dto';

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
  'виджет на сайте заказчика: допуск — гвард origin, visitor-token и деньги, не initData',
)
export class WidgetEngagementController {
  constructor(
    private readonly engagement: WidgetEngagementService,
    private readonly sessions: WidgetSessionService,
  ) {}

  @Post('handoff/cancel')
  @HttpCode(200)
  async cancelHandoff(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetHandoffCancelDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    return this.engagement.cancelHandoff(ctx, dto.conversationId);
  }

  @Post('event')
  @HttpCode(204)
  async event(@Body() body: unknown, @Req() req: Request): Promise<void> {
    await this.engagement.events(pageRequest(req, body));
  }

  @Post('goal')
  @HttpCode(204)
  async goal(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const p = pageRequest(req, body);
    // Вход iframe — по visitor-token (Origin виджета); без токена — вход
    // загрузчика (Origin страницы + pk). Токен есть, но негоден — отказ
    // сессии, а не «тихо как загрузчик».
    if (token !== undefined) {
      const ctx = await this.sessions.authenticate({
        token,
        requestOrigin: tokenRequestOrigin(req),
      });
      return this.engagement.goalFromIframe(ctx, p);
    }
    return this.engagement.goalFromPage(p);
  }

  @Post('goal-picker/session')
  @HttpCode(200)
  pickerSession(
    @Body() dto: WidgetGoalPickerSessionDto,
    @Req() req: Request,
  ): Promise<WidgetGoalPickerSessionResponse> {
    const p = pageRequest(req, null);
    return this.engagement.pickerSession(
      { pk: dto.pk, token: dto.token },
      { origin: p.origin, ip: p.ip },
    );
  }

  @Post('goal-picker/pick')
  @HttpCode(200)
  pick(@Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    const p = pageRequest(req, null);
    return this.engagement.pick(body, { origin: p.origin, ip: p.ip });
  }
}
