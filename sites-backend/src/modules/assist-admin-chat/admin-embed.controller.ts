/**
 * Встраивание в админку заказчика — 7b (ТЗ §4.16, §5.1, §4-бис.8, §4-бис.9):
 *   POST /assist-admin/v1/session                    обмен employee-JWT на нашу сессию
 *   GET  /assist-admin/v1/state                      диалог сотрудника (по `sub`, ≤ 8 ч)
 *   POST /assist-admin/v1/chat                       вопрос → ответ (знания + read-операции)
 *   POST /assist-admin/v1/messages/:id/feedback      👍/👎 и «правильно так»
 *   POST /assist-admin/v1/logout                     конец сессии (сотрудник вышел)
 *
 * Без Telegram: доступ — по сессии `X-Assist-Admin-Session` (только память/
 * sessionStorage iframe `wa.`). Visitor-token и CHIPS-cookie `resumeKey`
 * «Сайта» здесь не читаются (§4-бис.8, У-18). Ответ — целиком JSON (стрим
 * SSE для «Админки» — хвост Э7).
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ADMIN_SESSION_HEADER } from '../../brand';
import { adminError } from '../assist-admin-mode/admin-errors';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  AdminAskDto,
  AdminFeedbackDto,
  AdminSessionDto,
} from './admin-chat.dto';
import {
  AdminChatService,
  type EmployeeCtx,
  langParam,
} from './admin-chat.service';
import {
  ADMIN_QUESTIONS_PER_HOUR,
  ADMIN_QUESTIONS_PER_MIN,
  AdminSessionService,
  sessionTokenHash,
} from './admin-session.service';
import { clientIp } from '../telegram-auth/web/web-request';

const HEADER = ADMIN_SESSION_HEADER.toLowerCase();

@Controller('assist-admin/v1')
@PublicRoute(
  'чат сотрудника «Админки»: доступ по employee-JWT заказчика и нашей сессии, не по initData',
)
export class AdminEmbedController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly chat: AdminChatService,
  ) {}

  private async ctx(token: string | undefined): Promise<EmployeeCtx> {
    const s = await this.sessions.resolve(token);
    return {
      accountId: s.accountId,
      siteId: s.siteId,
      channel: 'embed',
      employeeRef: s.employeeRef,
      actorExternal: s.sub,
      customerRole: s.customerRole,
      name: s.name,
      role: s.role,
    };
  }

  @Post('session')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  session(@Body() dto: AdminSessionDto, @Req() req: Request) {
    // Адрес — по общему правилу (`clientIp`: на Vercel — первый из
    // X-Forwarded-For, иначе — только от доверенного прокси). `req.ip` без
    // `trust proxy` — адрес прокси Vercel, и окно лимита `admin-session-ip-min`
    // было бы общим для всех (аудит пакета Б, заход 10).
    return this.sessions.exchange(dto.pk, dto.jwt, clientIp(req) || null);
  }

  @Get('state')
  async state(@Headers(HEADER) token?: string, @Query('lang') lang?: string) {
    return this.chat.state(await this.ctx(token), new Date(), langParam(lang));
  }

  @Post('chat')
  @HttpCode(200)
  async ask(@Body() dto: AdminAskDto, @Headers(HEADER) token?: string) {
    const ctx = await this.ctx(token);
    const key = `${ctx.siteId}:${ctx.employeeRef}`.slice(0, 200);
    if (
      !(await this.sessions.rateHit(
        'admin-msg-min',
        key,
        ADMIN_QUESTIONS_PER_MIN,
        60_000,
      )) ||
      !(await this.sessions.rateHit(
        'admin-msg-hour',
        key,
        ADMIN_QUESTIONS_PER_HOUR,
        3_600_000,
      ))
    ) {
      throw adminError(
        429,
        'ADMIN_RATE_LIMITED',
        'Слишком много вопросов подряд — подождите минуту',
      );
    }
    return this.chat.ask(ctx, dto.text, dto.clientRequestId ?? null);
  }

  @Post('messages/:id/feedback')
  @HttpCode(200)
  async feedback(
    @Param('id') id: string,
    @Body() dto: AdminFeedbackDto,
    @Headers(HEADER) token?: string,
  ) {
    return this.chat.feedback(
      await this.ctx(token),
      id,
      dto.rating,
      dto.correction ?? null,
    );
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Headers(HEADER) token?: string) {
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      await this.sessions.revoke(sessionTokenHash(token));
    }
    return { ok: true };
  }
}
