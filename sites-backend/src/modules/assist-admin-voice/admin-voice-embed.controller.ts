/**
 * Голосовое управление «Админкой» — маршруты сотрудника (Э6-бис (б), ТЗ
 * §5-бис.9 «POST /assist-admin/v1/ui-plan … (JWT, origin wa., модуль
 * assist-admin-*)», §5-бис.13):
 *   GET  /assist-admin/v1/voice-control            конфиг для iframe `wa.`
 *   POST /assist-admin/v1/voice                    запись → текст + билет
 *   POST /assist-admin/v1/ui-plan                  команда + снимок → план
 *   GET  /assist-admin/v1/ui-plan/active           живой план / ждущее мемо
 *   POST /assist-admin/v1/ui-plan/:id/confirm|step|stop|resume|undo|undo-report
 *   POST /assist-admin/v1/voice-test/session       обмен ссылки мастера
 *   POST /assist-admin/v1/voice-test/:tid/analyze|attempt|report
 * Доступ — ТОЛЬКО сессия сотрудника `X-Assist-Admin-Session` (employee-JWT
 * заказчика, iframe на отдельном origin «Админки»; CORS — только этот
 * origin). Тестовая сессия мастера — заголовок `X-Assist-Admin-Voice-Test`
 * (id теста, привязан к ЭТОЙ сессии и `sub`).
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
import { ADMIN_SESSION_HEADER } from '../../brand';
import { AdminSessionService } from '../assist-admin-chat/admin-session.service';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { adminVoiceError, planHttpError } from './admin-voice-errors';
import { AdminVoiceInputService } from './admin-voice-input.service';
import { ADMIN_VC_LIMITS } from './admin-voice-rules';
import { AdminVoiceTestService } from './admin-voice-test.service';
import {
  AdminUiPlanService,
  type AdminPlanRequest,
  type AdminVcCtx,
} from './admin-ui-plan.service';

const HEADER = ADMIN_SESSION_HEADER.toLowerCase();
/** Заголовок тестовой сессии мастера «Админки» (id теста). */
export const ADMIN_VOICE_TEST_HEADER = 'x-assist-admin-voice-test';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

@Controller('assist-admin/v1')
@PublicRoute(
  'голосовое управление админкой: доступ по employee-JWT заказчика и нашей сессии (origin wa.), план проверяет код',
)
export class AdminVoiceEmbedController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly plans: AdminUiPlanService,
    private readonly input: AdminVoiceInputService,
    private readonly tests: AdminVoiceTestService,
  ) {}

  private async ctx(
    token: string | undefined,
    testRaw: string | undefined,
    bodyTest?: unknown,
  ): Promise<AdminVcCtx> {
    const session = await this.sessions.resolve(token);
    const test = await this.tests.live(session, bodyTest ?? testRaw);
    return { session, test };
  }

  private async limit(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
  ) {
    if (
      !(await this.sessions.rateHit(scope, key.slice(0, 200), limit, windowMs))
    )
      throw adminVoiceError(
        429,
        'ADMIN_VC_LIMIT',
        'Слишком много команд — подождите',
      );
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      return planHttpError(e);
    }
  }

  @Get('voice-control')
  async config(
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    return this.plans.config(await this.ctx(token, test));
  }

  @Post('voice')
  @HttpCode(200)
  async voice(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const body: unknown = req.body;
    const audio = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    try {
      const ctx = await this.ctx(token, test);
      const key = `${ctx.session.siteId}:${ctx.session.employeeRef}`;
      await this.limit(
        'admin-stt-min',
        key,
        ADMIN_VC_LIMITS.sttPerEmployeeMin,
        MINUTE,
      );
      await this.limit(
        'admin-stt-day',
        key,
        ADMIN_VC_LIMITS.sttPerEmployeeDay,
        DAY,
      );
      return await this.input.transcribe(
        ctx,
        audio,
        req.headers['content-type'],
      );
    } finally {
      audio.fill(0);
    }
  }

  @Post('ui-plan')
  @HttpCode(200)
  async create(
    @Body() body: AdminPlanRequest,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    const ctx = await this.ctx(token, test, body?.testId);
    if (!ctx.test) {
      const key = `${ctx.session.siteId}:${ctx.session.employeeRef}`;
      await this.limit(
        'admin-uiplan-min',
        key,
        ADMIN_VC_LIMITS.plansPerEmployeeMin,
        MINUTE,
      );
      await this.limit(
        'admin-uiplan-day',
        key,
        ADMIN_VC_LIMITS.plansPerEmployeeDay,
        DAY,
      );
      await this.limit(
        'admin-uiplan-site-day',
        ctx.session.siteId,
        ADMIN_VC_LIMITS.plansPerSiteDay,
        DAY,
      );
    }
    return this.run(() => this.plans.create(ctx, body ?? {}));
  }

  @Get('ui-plan/active')
  async active(
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    return this.plans.active(await this.ctx(token, test));
  }

  private async stepLimit(ctx: AdminVcCtx) {
    await this.limit(
      'admin-uiplan-step-min',
      `${ctx.session.siteId}:${ctx.session.employeeRef}`,
      120,
      MINUTE,
    );
  }

  @Post('ui-plan/:id/confirm')
  @HttpCode(200)
  async confirm(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    const ctx = await this.ctx(token, test);
    await this.stepLimit(ctx);
    return this.run(() => this.plans.confirm(ctx, id, body ?? {}));
  }

  @Post('ui-plan/:id/step')
  @HttpCode(200)
  async step(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    const ctx = await this.ctx(token, test);
    await this.stepLimit(ctx);
    return this.run(() => this.plans.step(ctx, id, body ?? {}));
  }

  @Post('ui-plan/:id/stop')
  @HttpCode(200)
  async stop(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    const ctx = await this.ctx(token, test);
    return this.run(() => this.plans.stop(ctx, id, body ?? {}));
  }

  @Post('ui-plan/:id/resume')
  @HttpCode(200)
  async resume(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    const ctx = await this.ctx(token, test);
    await this.stepLimit(ctx);
    return this.run(() => this.plans.resume(ctx, id, body ?? {}));
  }

  @Post('ui-plan/:id/undo')
  @HttpCode(200)
  async undo(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    const ctx = await this.ctx(token, test);
    await this.stepLimit(ctx);
    return this.run(() => this.plans.undo(ctx, id, body ?? {}));
  }

  @Post('ui-plan/:id/undo-report')
  @HttpCode(200)
  async undoReport(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
    @Headers(ADMIN_VOICE_TEST_HEADER) test?: string,
  ) {
    const ctx = await this.ctx(token, test);
    return this.run(() => this.plans.undoReport(ctx, id, body ?? {}));
  }

  // ── мастер «Админки» ────────────────────────────────────────────────────

  @Post('voice-test/session')
  @HttpCode(200)
  async testSession(
    @Body() body: { token?: unknown },
    @Headers(HEADER) token?: string,
  ) {
    const session = await this.sessions.resolve(token);
    await this.limit('admin-vt-session-min', session.siteId, 20, MINUTE);
    return this.run(() => this.tests.exchange(session, body ?? null));
  }

  @Post('voice-test/:tid/analyze')
  @HttpCode(200)
  async analyze(
    @Param('tid') tid: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
  ) {
    const ctx = await this.ctx(token, tid);
    return this.run(() => this.tests.analyze(ctx, tid, body ?? null));
  }

  @Post('voice-test/:tid/attempt')
  @HttpCode(200)
  async attempt(
    @Param('tid') tid: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
  ) {
    const ctx = await this.ctx(token, tid);
    return this.run(() => this.tests.attempt(ctx, tid, body ?? null));
  }

  @Post('voice-test/:tid/report')
  @HttpCode(200)
  async report(
    @Param('tid') tid: string,
    @Body() body: Record<string, unknown>,
    @Headers(HEADER) token?: string,
  ) {
    const ctx = await this.ctx(token, tid);
    return this.run(() => this.tests.report(ctx, tid, body ?? null));
  }
}
