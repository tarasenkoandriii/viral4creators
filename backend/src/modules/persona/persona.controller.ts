/**
 * Маршруты режима «Я в кадре» (этап E ТЗ Greeting 2.0 §6):
 *
 *   GET    /personas/consent-text?locale=   текст и версия согласия
 *   POST   /personas                        согласие → ссылки на селфи и ролик
 *   POST   /personas/me/verify              автопроверка → базовый образ
 *   POST   /personas/me/looks/:id/regenerate перегенерировать БАЗОВЫЙ образ
 *   GET    /personas/me                     персона, образы, голос, квота (без URL селфи)
 *   DELETE /personas/me                     отзыв согласия и удаление
 *
 * Образы (`/personas/me/looks…`) и фраза согласия голоса — контроллер F.
 * Идентичность — TelegramIdentityGuard, как у /voices: персона
 * принадлежит аккаунту. Рубильник `PERSONA_ENABLED` проверяет сервис
 * первым делом каждого метода — 404 `PERSONA_DISABLED`.
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
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { PersonaService } from './persona.service';
import { CreatePersonaDto } from './dto/persona.dto';
import type {
  CreatePersonaResult,
  DeletePersonaResult,
  PersonaLookView,
  PersonaMeView,
  VerifyPersonaResult,
} from './persona-view';
import type { PersonaConsentText } from './persona-consent';

@Controller('personas')
@UseGuards(TelegramIdentityGuard, RateLimitGuard)
export class PersonaController {
  constructor(private readonly personas: PersonaService) {}

  @Get('consent-text')
  consentText(@Query('locale') locale?: string): PersonaConsentText {
    return this.personas.consentText(locale);
  }

  @Post()
  @RateLimit({ name: 'persona-create', limit: 10, windowSec: 3600, by: 'user' })
  create(
    @Req() req: IdentifiedRequest,
    @Body() dto: CreatePersonaDto,
  ): Promise<CreatePersonaResult> {
    return this.personas.create(req.telegramUserId, dto);
  }

  /**
   * Платный мультимодальный вызов с видео — потолок попыток в час на
   * человека: пересъёмка за свет — нормально, перебор снимков ради
   * «удачной» оценки возраста — нет.
   */
  @Post('me/verify')
  @HttpCode(200)
  @RateLimit({ name: 'persona-verify', limit: 6, windowSec: 3600, by: 'user' })
  verify(@Req() req: IdentifiedRequest): Promise<VerifyPersonaResult> {
    return this.personas.verify(req.telegramUserId);
  }

  /**
   * «Перегенерировать» базовый образ (§4.1 п.4). Только базовый; суточный
   * потолок — в сервисе, здесь — частота (платная генерация картинки).
   */
  @Post('me/looks/:id/regenerate')
  @HttpCode(200)
  @RateLimit({
    name: 'persona-base-regenerate',
    limit: 3,
    windowSec: 600,
    by: 'user',
  })
  regenerateBase(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<PersonaLookView> {
    return this.personas.regenerateBase(req.telegramUserId, id);
  }

  @Get('me')
  me(@Req() req: IdentifiedRequest): Promise<PersonaMeView> {
    return this.personas.me(req.telegramUserId);
  }

  @Delete('me')
  remove(@Req() req: IdentifiedRequest): Promise<DeletePersonaResult> {
    return this.personas.remove(req.telegramUserId);
  }
}
