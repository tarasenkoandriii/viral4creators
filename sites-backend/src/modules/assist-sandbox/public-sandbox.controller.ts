/**
 * Публичная песочница лендинга — K3 (лендинг-ТЗ §6, §17.3; ТЗ §4.16):
 *   POST /public/assist/sandbox            { url } → PublicSandboxCreated
 *   GET  /public/assist/sandbox/:id        (X-Sandbox-Key) → SandboxView
 *   POST /public/assist/sandbox/:id/chat   (X-Sandbox-Key) { question } → SandboxAnswer
 * @PublicRoute; origin — ASSIST_LANDING_ORIGINS (фильтр, не защита); стена —
 * деньги: суточный потолок песочниц (ВКЛЮЧЁН) + рубильник
 * ASSIST_SANDBOX_PUBLIC_ENABLED. Лимиты — SANDBOX_LIMITS.public, атомарно
 * через assist_daily_counters (IPv4 / IPv6 /64; eTLD+1 → дальше кэш).
 * Вся работа с базой — под ролью assist_public (AssistPublicDb).
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
} from '@nestjs/common';
import type { Request } from 'express';
import { SANDBOX_KEY_HEADER } from '../../brand';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { clientIp } from '../telegram-auth/web/web-request';
import { SandboxChatDto, SandboxUrlDto } from './sandbox.dto';
import { SandboxService } from './sandbox.service';

const KEY_HEADER = SANDBOX_KEY_HEADER.toLowerCase();

@Controller('public/assist/sandbox')
@PublicRoute(
  'публичная песочница лендинга: доступ по ключу браузера и лимитам, не по initData',
)
export class PublicSandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Post()
  create(@Req() req: Request, @Body() dto: SandboxUrlDto) {
    const origin = req.headers.origin;
    return this.sandbox.createPublic({
      url: dto.url,
      ip: clientIp(req),
      origin: typeof origin === 'string' ? origin : undefined,
    });
  }

  @Get(':id')
  get(@Param('id') id: string, @Headers(KEY_HEADER) key: string | undefined) {
    return this.sandbox.getPublic(id, key);
  }

  @Post(':id/chat')
  @HttpCode(200)
  chat(
    @Param('id') id: string,
    @Headers(KEY_HEADER) key: string | undefined,
    @Body() dto: SandboxChatDto,
  ) {
    return this.sandbox.chatPublic(id, key, dto.question);
  }
}
