/**
 * Публичные маршруты голосового управления «Сайтом» — Э6-бис (а) (ТЗ
 * помощника §5-бис.9, §4-бис.5):
 *   POST /widget/v1/ui-plan               транскрипт + снимок → проверенный план
 *   GET  /widget/v1/ui-plan/active        живой план посетителя (продолжение
 *                                         после перехода страницы)
 *   POST /widget/v1/ui-plan/:id/confirm   «Да» (идемпотентно; повтор — тот же ответ)
 *   POST /widget/v1/ui-plan/:id/step      итог шага (dispatched|done|failed|…)
 *   POST /widget/v1/ui-plan/:id/stop      стоп (кнопка, Esc, клик человека, голос)
 *   POST /widget/v1/ui-plan/:id/resume    новый снимок → цели шагов после перехода
 * Зовёт iframe со своего origin (CORS — как у остальных `/widget/v1/*`);
 * допуск — visitor-token и гвард origin. Страница заказчика сюда не
 * дотягивается: токен посетителя живёт в хранилище iframe (другой origin),
 * поэтому `V4CAssist('ask')` и `postMessage` скриптов страницы план начать
 * не могут (§5-бис.6 п.1, приёмка §5-бис.10 п.8).
 *
 * Лимиты: планы посетителя (минута/сутки) и IP+сайт (втрое), потолок
 * планов сайта в сутки по тарифу; отчёты шагов — свой минутный лимит. В лог
 * — только id и коды (§6.6).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import type {
  UiPlanConfirmRequest,
  UiPlanRequest,
  UiPlanStepReport,
  UiPlanStopRequest,
  UiPlanView,
} from '../assist-site-voice-control/api-types';
import {
  SiteUiPlanService,
  UiPlanError,
  type UiPlanCtx,
  type UiPlanFailure,
} from '../assist-site-voice-control/public/ui-plan.service';
import { VOICE_CONTROL_DEFAULTS } from '../assist-site-voice-control/voice-control-config';
import { visitorViewport } from '../site-core/ui-map/ui-map-model';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import type { WidgetErrorCode } from './api-types';
import { WidgetRateLimit } from './rate-limit';
import { uiVoteIpHash } from './vote-ip-hash';
import { tokenRequestOrigin } from './widget-public.controller';
import { WidgetSessionService } from './widget-session.service';
import { widgetError } from './widget-errors';

const TOKEN_HEADER = WIDGET_VISITOR_TOKEN_HEADER.toLowerCase();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const FAILURE_CODE: Record<UiPlanFailure, WidgetErrorCode> = {
  bad_request: 'BAD_REQUEST',
  off: 'VOICE_CONTROL_OFF',
  not_found: 'NOT_FOUND',
  expired: 'PLAN_EXPIRED',
  conflict: 'PLAN_CONFLICT',
  changed: 'PLAN_CHANGED',
  quota: 'SITE_QUOTA',
  budget: 'PLATFORM_BUDGET',
  site_limit: 'VOICE_LIMIT',
  upstream: 'UPSTREAM',
  too_large: 'UI_PLAN_TOO_LARGE',
};

@Controller('widget/v1/ui-plan')
@PublicRoute(
  'голосовое управление виджета на сайте заказчика: допуск — гвард origin, visitor-token; план проверяет код',
)
export class WidgetUiPlanController {
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly sessions: WidgetSessionService,
    private readonly rate: WidgetRateLimit,
    private readonly plans: SiteUiPlanService,
    private readonly db: AssistPublicDb,
  ) {}

  private async ctx(
    token: string | undefined,
    req: Request,
    res: Response,
  ): Promise<UiPlanCtx> {
    res.setHeader('Cache-Control', 'no-store');
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const mobile = req.headers?.['sec-ch-ua-mobile'];
    return {
      site: ctx.site,
      visitor: ctx.visitor,
      viewport: visitorViewport({
        userAgent: req.headers?.['user-agent'] ?? null,
        chUaMobile: typeof mobile === 'string' ? mobile : null,
      }),
      // Ш4: голос «найден» снимком — от разных IP за окно (неделя).
      voteIpHash: await uiVoteIpHash(this.db, {
        siteId: ctx.site.siteId,
        req,
        fallback: ctx.visitor.ipHash,
        now: this.now(),
        env: this.env,
      }),
    };
  }

  private async run(fn: () => Promise<UiPlanView>): Promise<UiPlanView> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UiPlanError) throw widgetError(FAILURE_CODE[e.failure]);
      throw e;
    }
  }

  @Post()
  @HttpCode(200)
  async create(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() body: UiPlanRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UiPlanView> {
    const ctx = await this.ctx(token, req, res);
    const now = this.now();
    const key = `${ctx.site.siteId}:${ctx.visitor.visitorId}`;
    const ipKey = `${ctx.site.siteId}:${ctx.visitor.ipHash}`;
    await this.rate.enforce(
      [
        {
          scope: 'widget-uiplan-visitor-min',
          key,
          limit: VOICE_CONTROL_DEFAULTS.plansPerVisitorPerMinute,
          windowMs: MINUTE,
        },
        {
          scope: 'widget-uiplan-ip-site-min',
          key: ipKey,
          limit: VOICE_CONTROL_DEFAULTS.plansPerIpPerMinute,
          windowMs: MINUTE,
        },
      ],
      now,
    );
    for (const h of [
      {
        scope: 'widget-uiplan-visitor-day' as const,
        key,
        limit: VOICE_CONTROL_DEFAULTS.plansPerVisitorPerDay,
      },
      {
        scope: 'widget-uiplan-ip-site-day' as const,
        key: ipKey,
        limit: VOICE_CONTROL_DEFAULTS.plansPerIpPerDay,
      },
    ]) {
      if (!(await this.rate.hit({ ...h, windowMs: DAY, now })))
        throw widgetError('VOICE_LIMIT');
    }
    return this.run(() =>
      this.plans.create(ctx, body ?? ({} as UiPlanRequest), (limit) =>
        this.rate.hit({
          scope: 'widget-uiplan-site-day',
          key: ctx.site.siteId,
          limit,
          windowMs: DAY,
          now,
        }),
      ),
    );
  }

  @Get('active')
  async active(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ plan: UiPlanView | null }> {
    const ctx = await this.ctx(token, req, res);
    return { plan: await this.plans.active(ctx) };
  }

  /** Лимит отчётов шагов (подтверждение, шаг, стоп, продолжение). */
  private async reportLimit(ctx: UiPlanCtx): Promise<void> {
    await this.rate.enforce(
      [
        {
          scope: 'widget-uistep-visitor-min',
          key: `${ctx.site.siteId}:${ctx.visitor.visitorId}`,
          limit: VOICE_CONTROL_DEFAULTS.stepReportsPerVisitorPerMinute,
          windowMs: MINUTE,
        },
      ],
      this.now(),
    );
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Param('id') id: string,
    @Body() body: UiPlanConfirmRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UiPlanView> {
    const ctx = await this.ctx(token, req, res);
    await this.reportLimit(ctx);
    return this.run(() => this.plans.confirm(ctx, id, body));
  }

  @Post(':id/step')
  @HttpCode(200)
  async step(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Param('id') id: string,
    @Body() body: UiPlanStepReport,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UiPlanView> {
    const ctx = await this.ctx(token, req, res);
    await this.reportLimit(ctx);
    return this.run(() => this.plans.step(ctx, id, body));
  }

  @Post(':id/stop')
  @HttpCode(200)
  async stop(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Param('id') id: string,
    @Body() body: UiPlanStopRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UiPlanView> {
    const ctx = await this.ctx(token, req, res);
    await this.reportLimit(ctx);
    return this.run(() => this.plans.stop(ctx, id, body));
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Param('id') id: string,
    @Body() body: { snapshot: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UiPlanView> {
    const ctx = await this.ctx(token, req, res);
    await this.reportLimit(ctx);
    return this.run(() => this.plans.resume(ctx, id, body));
  }
}
