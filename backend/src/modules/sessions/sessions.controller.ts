/**
 * SessionsController
 *
 * REST endpoints for session management.
 */

import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Post,
  Get,
  NotFoundException,
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

  /**
   * Удалить свою сессию (ролик) — мягко (этап 89).
   * DELETE /sessions/:sessionId
   *
   * Этап 88.2, прямой запрос владельца продукта после вкладки
   * «Постпрод»: штатного способа удалить свой готовый ролик не было
   * вообще (только оператор в админке, `AdminPanelController.
   * deleteSession`). Владение проверяет глобальный `SessionOwnerGuard`
   * (см. `app.module.ts`) до того, как запрос сюда дойдёт — тот же
   * приём, что у `POST /sessions/:id/postprod/revoice` и
   * `POST /sessions/:id/export`, отдельный гвард здесь не нужен.
   *
   * Этап 89: строка больше не исчезает синхронно с этим запросом — ставит
   * `deletedAt` (`SessionService.softDeleteSession`), физическую уборку
   * строки и файлов в Blob уносит `purgeSoftDeletedSessions()` из крона
   * спустя `SOFT_DELETE_GRACE_MS`. Фронт показывает «умный» алерт ДО
   * этого запроса — честную копию без обещания восстановить (см.
   * `doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`, этап 89): у Session
   * нет DB-каскада, который стоило бы посчитать (все связи `SetNull`).
   */
  @Delete(':sessionId')
  @HttpCode(204)
  async deleteSession(@Param('sessionId') sessionId: string): Promise<void> {
    const { deleted } = await this.sessionService.softDeleteSession(sessionId);
    if (!deleted) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
  }
}
