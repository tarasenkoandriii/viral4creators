/**
 * Маршруты мастера и полноты — W5 (ТЗ §4-тер.14; контракт Э2 §6):
 *   GET   /assist/sites/:id/learning/site/onboarding
 *   POST  /assist/sites/:id/learning/site/onboarding/start     { businessType? }
 *   POST  /assist/sites/:id/learning/site/onboarding/drafts
 *   PATCH /assist/sites/:id/learning/site/onboarding/items/:topic  { status, answer? }
 *   POST  /assist/sites/:id/learning/site/onboarding/complete
 *   GET   /assist/sites/:id/learning/site/completeness
 * Права: @AllowApps('assist'), SiteAccountGuard, assist = manager.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { knowledgeError } from '../../assist-knowledge-core/versions';
import {
  REQUIRE_ASSIST_MANAGER,
  type AccountMembership,
} from '../../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import { SiteWizardService, WIZARD_ANSWER_MAX } from './site-wizard.service';
import { ALL_WIZARD_TOPICS } from './wizard-topics';
import {
  WIZARD_BUSINESS_TYPES,
  type CompletenessView,
  type WizardBusinessType,
  type WizardTopic,
  type WizardView,
} from './wizard-types';

export class WizardStartDto {
  @IsOptional()
  @IsIn(WIZARD_BUSINESS_TYPES)
  businessType?: WizardBusinessType;
}

export class WizardAnswerDto {
  @IsIn(['confirmed', 'edited', 'skipped'])
  status!: 'confirmed' | 'edited' | 'skipped';

  @IsOptional()
  @IsString()
  @MaxLength(WIZARD_ANSWER_MAX)
  answer?: string;
}

function topicOf(raw: string): WizardTopic {
  if (!(ALL_WIZARD_TOPICS as string[]).includes(raw)) {
    throw knowledgeError(
      'BAD_REQUEST',
      'Неизвестная тема мастера',
      HttpStatus.BAD_REQUEST,
    );
  }
  return raw as WizardTopic;
}

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class SiteWizardController {
  constructor(readonly wizard: SiteWizardService) {}

  @Get(':id/learning/site/onboarding')
  get(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
  ): Promise<WizardView> {
    return this.wizard.get(m, id);
  }

  @Post(':id/learning/site/onboarding/start')
  @HttpCode(200)
  start(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: WizardStartDto,
  ): Promise<WizardView> {
    return this.wizard.start(m, id, dto?.businessType ?? null);
  }

  @Post(':id/learning/site/onboarding/drafts')
  @HttpCode(200)
  drafts(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
  ): Promise<WizardView> {
    return this.wizard.runDrafts(m, id);
  }

  @Patch(':id/learning/site/onboarding/items/:topic')
  async answer(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('topic') topic: string,
    @Body() dto: WizardAnswerDto,
  ): Promise<WizardView> {
    return this.wizard.answer(m, id, topicOf(topic), {
      status: dto.status,
      answer: dto.answer,
    });
  }

  @Post(':id/learning/site/onboarding/complete')
  @HttpCode(200)
  complete(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
  ): Promise<WizardView> {
    return this.wizard.complete(m, id);
  }

  @Get(':id/learning/site/completeness')
  completeness(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
  ): Promise<CompletenessView> {
    return this.wizard.completeness(m, id);
  }
}
