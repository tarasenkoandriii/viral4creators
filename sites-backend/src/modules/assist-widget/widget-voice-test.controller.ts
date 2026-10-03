/**
 * Публичные маршруты мастера проверки голосового управления Т-2 — Э6-бис
 * (г) (ТЗ помощника §5-бис.9 «маршруты», §5-бис.13):
 *   POST /widget/v1/voice-test/session        одноразовая ссылка кабинета →
 *                                             тестовая сессия (30 мин)
 *   POST /widget/v1/voice-test/:tid/analyze   снимок → команды мастера,
 *                                             «запреты без звука», список 1
 *   POST /widget/v1/voice-test/:tid/report    итог мастера (вердикт — сервер)
 * Зовёт iframe со своего origin; допуск — visitor-token и гвард origin, для
 * `analyze`/`report` — ещё и тестовая сессия (заголовок
 * WIDGET_VOICE_TEST_HEADER) именно этого теста. Страница заказчика токена
 * сессии не видит (хранилище iframe — другой origin). Лимиты — свои,
 * минутные (мастер — несколько запросов за 5 минут). В лог — id и коды.
 */
import {
  Body,
  Controller,
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
  VoiceTestAnalyzeRequest,
  VoiceTestAnalyzeView,
  VoiceTestReportRequest,
  VoiceTestReportView,
  VoiceTestSessionRequest,
  VoiceTestSessionView,
} from '../assist-site-voice-control/api-types';
import type { UiPlanCtx } from '../assist-site-voice-control/public/ui-plan.service';
import { VoiceTestService } from '../assist-site-voice-control/public/voice-test.service';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { WidgetRateLimit } from './rate-limit';
import { uiPlanContext, uiPlanFailure } from './widget-ui-plan.controller';
import { WidgetSessionService } from './widget-session.service';

const TOKEN_HEADER = WIDGET_VISITOR_TOKEN_HEADER.toLowerCase();
const MINUTE = 60_000;
/** Обменов ссылки с IP на сайт в минуту (перебор токенов). */
const EXCHANGE_PER_IP_MIN = 10;
/** Запросов тестовой сессии в минуту (анализ страниц, отчёт). */
const SESSION_PER_VISITOR_MIN = 30;

@Controller('widget/v1/voice-test')
@PublicRoute(
  'мастер проверки голосового управления на сайте заказчика: допуск — гвард origin, visitor-token, одноразовая ссылка кабинета / тестовая сессия',
)
export class WidgetVoiceTestController {
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly sessions: WidgetSessionService,
    private readonly rate: WidgetRateLimit,
    private readonly tests: VoiceTestService,
    private readonly db: AssistPublicDb,
  ) {}

  private ctx(
    token: string | undefined,
    req: Request,
    res: Response,
  ): Promise<UiPlanCtx> {
    return uiPlanContext(
      {
        sessions: this.sessions,
        db: this.db,
        tests: this.tests,
        now: this.now(),
        env: this.env,
      },
      token,
      req,
      res,
    );
  }

  @Post('session')
  @HttpCode(200)
  async session(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() body: VoiceTestSessionRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VoiceTestSessionView> {
    const ctx = await this.ctx(token, req, res);
    await this.rate.enforce(
      [
        {
          scope: 'widget-vtest-ip-site-min',
          key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
          limit: EXCHANGE_PER_IP_MIN,
          windowMs: MINUTE,
        },
      ],
      this.now(),
    );
    try {
      return await this.tests.exchange(ctx, body ?? null);
    } catch (e) {
      return uiPlanFailure(e, 'VOICE_TEST_INVALID');
    }
  }

  private async limit(ctx: UiPlanCtx): Promise<void> {
    await this.rate.enforce(
      [
        {
          scope: 'widget-vtest-visitor-min',
          key: `${ctx.site.siteId}:${ctx.visitor.visitorId}`,
          limit: SESSION_PER_VISITOR_MIN,
          windowMs: MINUTE,
        },
      ],
      this.now(),
    );
  }

  @Post(':tid/analyze')
  @HttpCode(200)
  async analyze(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Param('tid') tid: string,
    @Body() body: VoiceTestAnalyzeRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VoiceTestAnalyzeView> {
    const ctx = await this.ctx(token, req, res);
    await this.limit(ctx);
    try {
      return await this.tests.analyze(ctx, tid, body ?? null);
    } catch (e) {
      return uiPlanFailure(e, 'VOICE_TEST_INVALID');
    }
  }

  @Post(':tid/report')
  @HttpCode(200)
  async report(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Param('tid') tid: string,
    @Body() body: VoiceTestReportRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VoiceTestReportView> {
    const ctx = await this.ctx(token, req, res);
    await this.limit(ctx);
    try {
      return await this.tests.report(ctx, tid, body ?? null);
    } catch (e) {
      return uiPlanFailure(e, 'VOICE_TEST_INVALID');
    }
  }
}
