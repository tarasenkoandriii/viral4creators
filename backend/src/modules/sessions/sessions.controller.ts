/**
 * SessionsController
 *
 * REST endpoints for session management.
 */

import {
  Body,
  Controller,
  Post,
  Get,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import { CreateSessionRequestDto } from './dto/create-session.dto';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionService: SessionService) {}

  /**
   * Create a new session
   * POST /sessions
   *
   * `req.telegramUserId` is set by TelegramIdentityMiddleware only when
   * the request came from Telegram (initData or dev-bypass) — see
   * doc/TELEGRAM-ADMIN.md. Absent for the ordinary anonymous browser
   * flow, exactly as before Telegram login existed.
   */
  // Этап 54 (Б-3.7): каждая сессия — строка в базе и файлы в хранилище,
  // а создаётся она без входа. Тридцати в минуту с одного адреса хватает
  // и офису за NAT; перебору — нет.
  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'session-create', limit: 30, windowSec: 60 })
  async createSession(
    @Req() req: TelegramIdentifiedRequest,
    @Body() dto: CreateSessionRequestDto,
  ): Promise<{ sessionId: string; session: Session }> {
    const session = await this.sessionService.createSession(
      req.telegramUserId,
      undefined,
      dto?.locale,
    );
    return {
      sessionId: session.sessionId,
      session,
    };
  }

  /**
   * Get session by ID
   * GET /sessions/:sessionId
   */
  @Get(':sessionId')
  async getSession(
    @Param('sessionId') sessionId: string,
  ): Promise<Session | null> {
    const session = await this.sessionService.getSession(sessionId);
    return session || null;
  }
}
