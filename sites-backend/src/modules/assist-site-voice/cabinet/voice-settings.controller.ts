/**
 * Кабинет голоса виджета — Э5 (ТЗ §3.5, §4.10):
 *   GET   /assist/sites/:id/voice-config
 *   PATCH /assist/sites/:id/voice-config          { config }
 *   POST  /assist/sites/:id/voice-config/sample   { voiceId?, lang? } → { mime, dataBase64 }
 * Права: @AllowApps('assist'), SiteAccountGuard, productRoles.assist =
 * manager (как персона и лиды Э2; оператор — 403).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AccountMembership,
  REQUIRE_ASSIST_MANAGER,
} from '../../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import type { VoiceSampleRequest, VoiceSampleResponse } from '../api-types';
import { VoiceSettingsService } from './voice-settings.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class VoiceSettingsController {
  constructor(private readonly voice: VoiceSettingsService) {}

  @Get(':id/voice-config')
  get(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.voice.get(m, id);
  }

  @Patch(':id/voice-config')
  save(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { config?: unknown },
  ) {
    return this.voice.save(m, id, body?.config);
  }

  /**
   * Пример голоса — base64 в обычном конверте: клиент кабинета TMA
   * разбирает только JSON, а фраза короткая (≈ 30–60 КБ mp3).
   */
  @Post(':id/voice-config/sample')
  @HttpCode(200)
  async sample(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: VoiceSampleRequest,
  ): Promise<VoiceSampleResponse> {
    const out = await this.voice.sample(m, id, body ?? {});
    return { mime: out.mime, dataBase64: out.audio.toString('base64') };
  }
}
