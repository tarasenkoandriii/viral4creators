/**
 * Маршруты советника («Тонкая красная линия» §3, §5.3).
 *
 *   GET   /projects/:projectId/wizard-guide
 *   PATCH /projects/:projectId/wizard-guide
 *   POST  /projects/:projectId/wizard-guide/hint
 *
 * Та же конвенция, что у `GreetingBriefController`: `projectId` в пути,
 * `TelegramIdentityGuard` опознаёт звонящего, владение проверяет сервис.
 * `SessionOwnerGuard` здесь не подошёл бы — он читает `sessionId` только
 * из пути и строки запроса, а при его отсутствии пропускает запрос
 * молча.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsString, MaxLength } from 'class-validator';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { SUPPORTED_LOCALES, SupportedLocale } from '../../common/locale';
import { HintResult, WizardHintService } from './wizard-hint.service';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { WizardGuideService, WizardGuideState } from './wizard-guide.service';

export class SetWizardGuideDto {
  @IsBoolean()
  enabled!: boolean;
}

export class WizardHintDto {
  /** Идентификатор шага, а не индекс: индексы поедут при первой вставке
   * шага, а ссылки на них останутся в корпусе и в статистике. */
  @IsString()
  @MaxLength(40)
  stepId!: string;

  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  locale!: string;
}

@Controller('projects/:projectId/wizard-guide')
@UseGuards(TelegramIdentityGuard)
export class WizardGuideController {
  constructor(
    private readonly guide: WizardGuideService,
    private readonly hints: WizardHintService,
  ) {}

  @Get()
  state(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<WizardGuideState> {
    return this.guide.stateOf(req.telegramUserId, projectId);
  }

  /**
   * Подсказка на шаге. `POST`, а не `GET`, потому что вызов платный и
   * не обязан кешироваться промежуточными узлами; ответ при этом
   * идемпотентен ровно настолько, насколько идемпотентен кеш §5.5.
   *
   * Лимиты частоты — два окна, как у ассистента: минутное спасает от
   * дребезга интерфейса, часовое — от открытого на весь день мастера.
   */
  @Post('hint')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit([
    { name: 'wizard-hint', limit: 20, windowSec: 60 },
    { name: 'wizard-hint-hour', limit: 120, windowSec: 3600 },
  ])
  hint(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: WizardHintDto,
  ): Promise<HintResult> {
    return this.hints.hint(
      req.telegramUserId,
      projectId,
      dto.stepId,
      dto.locale as SupportedLocale,
    );
  }

  @Patch()
  set(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: SetWizardGuideDto,
  ): Promise<WizardGuideState> {
    return this.guide.setEnabled(req.telegramUserId, projectId, dto.enabled);
  }
}
