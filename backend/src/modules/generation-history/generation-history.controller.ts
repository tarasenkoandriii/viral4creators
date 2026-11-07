import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { GenerationHistoryService } from './generation-history.service';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';

@Controller('generation-history')
@UseGuards(TelegramIdentityGuard, RateLimitGuard)
export class GenerationHistoryController {
  constructor(private readonly history: GenerationHistoryService) {}

  @Get()
  @RateLimit({
    name: 'generation-history-read',
    limit: 60,
    windowSec: 60,
    by: 'user',
  })
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: IdentifiedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.history.list(
      req.telegramUserId,
      limit === undefined ? 20 : Number(limit),
      before,
    );
  }
}
