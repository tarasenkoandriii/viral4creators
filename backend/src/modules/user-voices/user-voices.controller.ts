/**
 *   POST   /voices/upload-url         presigned PUT (mints voiceId)
 *   POST   /voices/clone              { pathname, label, consent } → запускает обучение
 *   GET    /voices                    список голосов пользователя (с poll-фоллбеком)
 *   DELETE /voices/:id
 *   POST   /voices/webhook/resemble   вебхук Resemble (?secret=..., НЕ под TelegramIdentityGuard)
 *
 * Этап 73, TODO п.32. Идентичность — TelegramIdentityGuard, как у
 * /brand-manifests: голос принадлежит подписчику, не сессии/бренду.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { UserVoicesService } from './user-voices.service';
import {
  VoiceCloneRequestDto,
  VoiceSampleUploadUrlRequestDto,
} from './dto/user-voices.dto';
import { UserVoiceView } from '../../common/types/user-voice.types';
import { assertResembleWebhookSecret } from './resemble-webhook-secret';

@Controller('voices')
@UseGuards(TelegramIdentityGuard)
export class UserVoicesController {
  constructor(private readonly service: UserVoicesService) {}

  @Post('upload-url')
  uploadUrl(
    @Req() req: IdentifiedRequest,
    @Body() dto: VoiceSampleUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; voiceId: string }> {
    return this.service.createUploadUrl(req.telegramUserId, dto);
  }

  @Post('clone')
  clone(
    @Req() req: IdentifiedRequest,
    @Body() dto: VoiceCloneRequestDto,
  ): Promise<UserVoiceView> {
    return this.service.confirmClone(req.telegramUserId, dto);
  }

  @Get()
  list(@Req() req: IdentifiedRequest): Promise<UserVoiceView[]> {
    return this.service.list(req.telegramUserId);
  }

  @Delete(':id')
  async remove(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.service.remove(req.telegramUserId, id);
    return { ok: true };
  }
}

/**
 * Отдельный контроллер БЕЗ TelegramIdentityGuard — вебхук приходит от
 * Resemble, не от нашего клиента (тот же приём, что у
 * billing.controller.ts для вебхука Telegram): свой механизм
 * аутентичности вместо guard'а (§resemble-webhook-secret.ts).
 */
@Controller('voices/webhook')
export class UserVoicesWebhookController {
  constructor(private readonly service: UserVoicesService) {}

  @Post('resemble')
  @HttpCode(200)
  async resembleWebhook(
    @Query('secret') secret: string | undefined,
    @Body() body: { ok?: boolean; id?: string; status?: string },
  ): Promise<{ ok: true }> {
    assertResembleWebhookSecret(secret);
    await this.service.handleWebhook(body);
    return { ok: true };
  }
}
