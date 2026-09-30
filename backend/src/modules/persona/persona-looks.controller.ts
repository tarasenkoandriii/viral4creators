/**
 * HTTP образов персоны и фразы согласия голоса (ТЗ TZ-Greeting-2.0 §6):
 *
 *   POST   /personas/me/looks             { preset?, description?, targetAge?, sourceLookId? } → Look (+ warning)
 *   PATCH  /personas/me/looks/:id         { label } → Look
 *   DELETE /personas/me/looks/:id         мягкое удаление
 *   GET    /personas/voice-consent-phrase ?locale=ru|uk|en|de|es → { locale, version, template, text }
 *
 * Отдельный контроллер с тем же префиксом, что у контроллера персоны:
 * образы — зона F, персона — E, и правки не пересекаются. Выключенный
 * `PERSONA_ENABLED` — 404 `PERSONA_DISABLED` из сервиса, как у E.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  CreatedPersonaLook,
  PersonaLooksService,
} from './persona-looks.service';
import {
  CreatePersonaLookDto,
  RenamePersonaLookDto,
} from './persona-looks.dto';
import { PersonaLookView } from './persona-view';
import { PersonaVoiceConsentPhrase } from '../user-voices/persona-voice-consent';

@Controller('personas')
@UseGuards(TelegramIdentityGuard)
export class PersonaLooksController {
  constructor(private readonly looks: PersonaLooksService) {}

  @Post('me/looks')
  create(
    @Req() req: IdentifiedRequest,
    @Body() dto: CreatePersonaLookDto,
  ): Promise<CreatedPersonaLook> {
    return this.looks.create(req.telegramUserId, dto);
  }

  @Patch('me/looks/:id')
  rename(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: RenamePersonaLookDto,
  ): Promise<PersonaLookView> {
    return this.looks.rename(req.telegramUserId, id, dto.label);
  }

  @Delete('me/looks/:id')
  remove(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.looks.remove(req.telegramUserId, id);
  }

  @Get('voice-consent-phrase')
  voiceConsentPhrase(
    @Req() req: IdentifiedRequest,
    @Query('locale') locale?: string,
  ): Promise<PersonaVoiceConsentPhrase> {
    return this.looks.voiceConsentPhrase(req.telegramUserId, locale);
  }
}
